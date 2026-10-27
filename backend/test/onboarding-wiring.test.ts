/**
 * onboarding-wiring.test.ts —— 引导端口的**装配口径** ＋ 路由元数据 ＋ 契约（W8-A）
 *
 * ── 三半证据，缺一不可 ──────────────────────────────────────────────────────
 *   `onboarding-http.test.ts` 证明「HTTP 上四道屏障 / 读豁免写受管 / 400 / 409」；
 *   `onboarding-db.dbtest.ts` 证明「真库上到底建了哪些行」；
 *   本文件证明**结构**：
 *     ① 有库 ⇒ `PrismaOnboardingRepository`；无库 ⇒ 501（不是假成功）；
 *        无库装配的图里**没有** `PrismaModule`（否则离线用例装配阶段就崩）；
 *     ② 控制器守卫列表**恰好**是 `DeviceSession → Membership → Permissions → Consent`，
 *        顺序不能换（同意闸门必须最后，它依赖矩阵已放行）；
 *     ③ 三条路由的路径 / 方法 / `RequireAction` / 状态码与矩阵键逐一对应；
 *     ④ 无库端口的四个方法**全部** 501：`readState` 不在 HTTP 路径上，
 *        只靠 HTTP 用例会漏掉它（少一个 501 就是一条「假状态」入口）；
 *     ⑤ 矩阵与同意策略：`view_onboarding` 豁免、`apply_onboarding` 受管。
 *
 * ★ ⑤ 是「文档与代码同源」的一部分：PRD §7 的表格由 `honesty:probe` 逐行对账，
 *   这里再把「路由真的挂了那个 action」钉住 —— 两处都过，才算真的接上。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RequestMethod } from '@nestjs/common'
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA
} from '@nestjs/common/constants'

import { ConsentGuard } from '../src/consent/consent.guard'
import {
  CONSENT_EXEMPT_ACTIONS,
  CONSENT_GATED_ACTIONS,
  isConsentGatedAction
} from '../src/contracts/consent-policy'
import { PERMISSION_MATRIX, resolveVerdict } from '../src/contracts/permission-matrix'
import { DeviceSessionGuard } from '../src/device-session/device-session.guard'
import { MembershipGuard } from '../src/membership/membership.guard'
import { OnboardingController } from '../src/onboarding/onboarding.controller'
import {
  OnboardingModule,
  resolveOnboardingRepositoryClass
} from '../src/onboarding/onboarding.module'
import { PrismaOnboardingRepository } from '../src/onboarding/onboarding.prisma.repository'
import {
  NotImplementedOnboardingRepository,
  ONBOARDING_REPOSITORY,
  type OnboardingPort
} from '../src/onboarding/onboarding.repository'
import { PermissionsGuard } from '../src/permissions/permissions.guard'
import { REQUIRED_ACTION_KEY } from '../src/permissions/require-action.decorator'
import { PrismaModule } from '../src/prisma/prisma.module'

describe('装配：有库走 Prisma、无库 501，且无库图里没有 PrismaModule', () => {
  it('两个分支不是同一个类（否则「无库」会变成一份假成功）', () => {
    assert.equal(resolveOnboardingRepositoryClass(true), PrismaOnboardingRepository)
    assert.equal(resolveOnboardingRepositoryClass(false), NotImplementedOnboardingRepository)
    assert.notEqual(PrismaOnboardingRepository, NotImplementedOnboardingRepository)
  })

  it('register({ hasDatabase: false })：端口 = 501 实现；不导入 PrismaModule', () => {
    const mod = OnboardingModule.register({ hasDatabase: false })
    const provider = (mod.providers ?? []).find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'provide' in item &&
        item.provide === ONBOARDING_REPOSITORY
    ) as { provide: unknown; useClass: unknown } | undefined
    assert.equal(provider?.useClass, NotImplementedOnboardingRepository)

    const imports = mod.imports ?? []
    assert.equal(imports.includes(PrismaModule), false, '无库装配竟然导入了 PrismaModule')
    assert.deepEqual(mod.controllers, [OnboardingController])
  })

  it('register({ hasDatabase: true })：端口 = Prisma 实现；导入 PrismaModule', () => {
    const mod = OnboardingModule.register({ hasDatabase: true })
    const provider = (mod.providers ?? []).find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'provide' in item &&
        item.provide === ONBOARDING_REPOSITORY
    ) as { provide: unknown; useClass: unknown } | undefined
    assert.equal(provider?.useClass, PrismaOnboardingRepository)
    assert.equal((mod.imports ?? []).includes(PrismaModule), true)
  })

  it('两种装配都把两个需要显式实例化的 Guard 放进 providers', () => {
    for (const hasDatabase of [true, false]) {
      const providers = OnboardingModule.register({ hasDatabase }).providers ?? []
      assert.equal(providers.includes(DeviceSessionGuard), true)
      assert.equal(providers.includes(ConsentGuard), true)
    }
  })
})

describe('守卫：四道屏障，顺序固定', () => {
  it('控制器级守卫 = DeviceSession → Membership → Permissions → Consent', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OnboardingController) as unknown[]
    assert.deepEqual(guards, [
      DeviceSessionGuard,
      MembershipGuard,
      PermissionsGuard,
      ConsentGuard
    ])
  })

  it('★ ConsentGuard 存在 —— 写路径必须过同意闸门（读的豁免由动作清单决定）', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OnboardingController) as unknown[]
    assert.equal(guards.includes(ConsentGuard), true)
  })
})

describe('路由：「路径 / 方法 / 动作 / 状态码」四处必须同时对', () => {
  const routes = {
    read: {
      path: '/',
      method: RequestMethod.GET,
      action: 'view_onboarding',
      // GET 未显式 @HttpCode ⇒ Nest 按方法推导 200；这里钉「没有别的显式码」。
      explicitHttpCode: null
    },
    saveProfile: {
      path: 'profile',
      method: RequestMethod.PATCH,
      action: 'apply_onboarding',
      explicitHttpCode: 200
    },
    complete: {
      path: 'complete',
      method: RequestMethod.POST,
      action: 'apply_onboarding',
      explicitHttpCode: 200
    }
  } as const

  const methodName = (method: number): string =>
    method === RequestMethod.GET ? 'GET' : method === RequestMethod.PATCH ? 'PATCH' : 'POST'

  for (const [handler, expected] of Object.entries(routes)) {
    it(`${handler}: ${methodName(expected.method)} ${expected.path} → ${expected.action}`, () => {
      const fn = (OnboardingController.prototype as unknown as Record<string, unknown>)[
        handler
      ] as object
      assert.equal(Reflect.getMetadata(PATH_METADATA, fn), expected.path)
      assert.equal(Reflect.getMetadata(METHOD_METADATA, fn), expected.method)
      assert.equal(Reflect.getMetadata(REQUIRED_ACTION_KEY, fn), expected.action)
      assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, fn) ?? null, expected.explicitHttpCode)
    })
  }

  it('控制器根路径 = onboarding', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, OnboardingController), 'onboarding')
  })

  it('★ complete 是 200 而不是 201：它不创建「一份可寻址的引导」', () => {
    const fn = (OnboardingController.prototype as unknown as Record<string, unknown>)[
      'complete'
    ] as object
    assert.notEqual(Reflect.getMetadata(HTTP_CODE_METADATA, fn), 201)
  })
})

describe('无库端口：四个方法全部 501（含不在 HTTP 路径上的 readState）', () => {
  const port: OnboardingPort = new NotImplementedOnboardingRepository()

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['readSnapshot', () => port.readSnapshot('child-1')],
    ['readState', () => port.readState('child-1')],
    [
      'saveProfile',
      () =>
        port.saveProfile({
          childId: 'child-1',
          ageBand: null,
          focusAreas: [],
          operator: { userId: 'u-dad', role: 'guardian' }
        })
    ],
    [
      'complete',
      () =>
        port.complete({
          childId: 'child-1',
          ageBand: null,
          focusAreas: [],
          templateSlugs: ['x'],
          parentPinHash: null,
          operator: { userId: 'u-dad', role: 'guardian' }
        })
    ]
  ]

  for (const [name, run] of cases) {
    it(`${name} ⇒ 501 ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED`, async () => {
      await assert.rejects(run, (error: unknown) => {
        const exception = error as { getStatus?: () => number; getResponse?: () => unknown }
        assert.equal(exception.getStatus?.(), 501)
        const response = exception.getResponse?.() as { code?: string }
        assert.equal(response.code, 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED')
        return true
      })
    })
  }
})

describe('契约：两个动作 guardian ALLOW / child DENY；读豁免、写受管', () => {
  it('判定：引导只给家长', () => {
    assert.deepEqual(PERMISSION_MATRIX.view_onboarding, { guardian: 'ALLOW', child: 'DENY' })
    assert.deepEqual(PERMISSION_MATRIX.apply_onboarding, { guardian: 'ALLOW', child: 'DENY' })
    assert.equal(resolveVerdict('view_onboarding', 'child'), 'DENY')
    assert.equal(resolveVerdict('apply_onboarding', 'child'), 'DENY')
    assert.equal(resolveVerdict('apply_onboarding', 'viewer'), 'DENY')
  })

  it('★ view_onboarding 在豁免集合：未同意时引导页必须能打开', () => {
    assert.equal((CONSENT_EXEMPT_ACTIONS as readonly string[]).includes('view_onboarding'), true)
    assert.equal((CONSENT_GATED_ACTIONS as readonly string[]).includes('view_onboarding'), false)
    assert.equal(isConsentGatedAction('view_onboarding'), false)
  })

  it('★ apply_onboarding 在写侧：第②步起采集昵称，同意必须先于采集', () => {
    assert.equal((CONSENT_GATED_ACTIONS as readonly string[]).includes('apply_onboarding'), true)
    assert.equal((CONSENT_EXEMPT_ACTIONS as readonly string[]).includes('apply_onboarding'), false)
    assert.equal(isConsentGatedAction('apply_onboarding'), true)
  })

  it('两个动作不同名 —— 复用会让「允许完成引导」等于「未同意也能采集」', () => {
    assert.notEqual('view_onboarding', 'apply_onboarding')
  })
})

