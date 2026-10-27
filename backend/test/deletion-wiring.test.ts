/**
 * deletion-wiring.test.ts —— 删除端口的**装配口径** ＋ 路由元数据 ＋ 契约（W7-D）
 *
 * ── 三半证据，缺一不可 ──────────────────────────────────────────────────────
 *   `deletion-http.test.ts` 证明「HTTP 上三道屏障 / 二次确认 / 501」；
 *   `deletion-db.dbtest.ts` 证明「真库上到底改了哪些行」；
 *   本文件证明**结构**：
 *     ① 有库 ⇒ `PrismaDeletionRepository`；无库 ⇒ 501（不是假成功）；
 *        无库装配的图里**没有** `PrismaModule`（否则离线用例装配阶段就崩）；
 *     ② 控制器守卫列表**恰好**是 `DeviceSession → Membership → Permissions`，
 *        且**没有** `ConsentGuard` —— 撤回同意后仍必须能删（04 §5）；
 *     ③ 三条路由的路径 / 方法 / `RequireAction` 与矩阵键逐一对应；
 *     ④ worker 的环境解析有界（乱填不会变成热循环或一口吞）；
 *     ⑤ 矩阵与同意策略：两个新动作 guardian ALLOW / child DENY，且在豁免集合里。
 *
 * ★ ③ ⑤ 是「文档与代码同源」的一部分：PRD §7 的表格由 `honesty:probe` 逐行对账，
 *   这里再把「路由真的挂了那个 action」钉住 —— 两处都过，才算真的接上。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RequestMethod } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'

import {
  CONSENT_EXEMPT_ACTIONS,
  CONSENT_GATED_ACTIONS
} from '../src/contracts/consent-policy'
import { ALL_ACTIONS, PERMISSION_MATRIX } from '../src/contracts/permission-matrix'
import { ConsentGuard } from '../src/consent/consent.guard'
import { DeletionController } from '../src/deletion/deletion.controller'
import { DeletionModule, resolveDeletionRepositoryClass } from '../src/deletion/deletion.module'
import { PrismaDeletionRepository } from '../src/deletion/deletion.prisma.repository'
import {
  DELETION_REPOSITORY,
  FAMILY_DELETION_COOLING_DAYS,
  NotImplementedDeletionRepository
} from '../src/deletion/deletion.repository'
import {
  DELETION_WORKER_CONFIG,
  FamilyDeletionWorker,
  resolveDeletionWorkerConfig
} from '../src/deletion/deletion.worker'
import { DeviceSessionGuard } from '../src/device-session/device-session.guard'
import { MembershipGuard } from '../src/membership/membership.guard'
import { PermissionsGuard } from '../src/permissions/permissions.guard'
import { REQUIRED_ACTION_KEY } from '../src/permissions/require-action.decorator'
import { PrismaModule } from '../src/prisma/prisma.module'

describe('装配：有库走 Prisma、无库 501，且无库图里没有 PrismaModule', () => {
  it('两个分支都不是同一个类（否则「无库」就会变成一份假成功）', () => {
    assert.equal(resolveDeletionRepositoryClass(true), PrismaDeletionRepository)
    assert.equal(resolveDeletionRepositoryClass(false), NotImplementedDeletionRepository)
    assert.notEqual(PrismaDeletionRepository, NotImplementedDeletionRepository)
  })

  it('register({ hasDatabase: false })：端口 = 501 实现；不导入 PrismaModule', () => {
    const mod = DeletionModule.register({ hasDatabase: false })
    const provider = (mod.providers ?? []).find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'provide' in item &&
        item.provide === DELETION_REPOSITORY
    ) as { provide: unknown; useClass: unknown } | undefined
    assert.equal(provider?.useClass, NotImplementedDeletionRepository)

    const imports = mod.imports ?? []
    assert.equal(imports.includes(PrismaModule), false, '无库装配竟然导入了 PrismaModule')
  })

  it('register({ hasDatabase: true })：端口 = Prisma 实现；导入 PrismaModule；worker 在 providers', () => {
    const mod = DeletionModule.register({ hasDatabase: true })
    const provider = (mod.providers ?? []).find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'provide' in item &&
        item.provide === DELETION_REPOSITORY
    ) as { provide: unknown; useClass: unknown } | undefined
    assert.equal(provider?.useClass, PrismaDeletionRepository)
    assert.equal((mod.imports ?? []).includes(PrismaModule), true)
    assert.equal((mod.providers ?? []).includes(FamilyDeletionWorker), true)
    assert.equal(
      (mod.providers ?? []).some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'provide' in item &&
          item.provide === DELETION_WORKER_CONFIG
      ),
      true
    )
    assert.equal((mod.exports ?? []).includes(FamilyDeletionWorker), true)
  })
})

describe('守卫：三道路径屏障，**没有** ConsentGuard（撤回同意后仍可删）', () => {
  it('控制器级守卫顺序 = DeviceSession → Membership → Permissions', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, DeletionController) as unknown[]
    assert.deepEqual(guards, [DeviceSessionGuard, MembershipGuard, PermissionsGuard])
  })

  it('★ 守卫列表里没有 ConsentGuard —— 这条豁免是删除权的全部意义', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, DeletionController) as unknown[]
    assert.equal(guards.includes(ConsentGuard), false)
  })
})


describe('路由：「路径 / 方法 / 动作」三处必须同时对上', () => {
  const routes = {
    state: { path: '/', method: RequestMethod.GET, action: 'view_family_deletion' },
    request: { path: '/', method: RequestMethod.POST, action: 'manage_family_deletion' },
    cancel: { path: 'cancel', method: RequestMethod.POST, action: 'manage_family_deletion' }
  } as const

  for (const [handler, expected] of Object.entries(routes)) {
    it(`${handler}: ${expected.method === RequestMethod.GET ? 'GET' : 'POST'} ${expected.path} → ${expected.action}`, () => {
      const fn = (DeletionController.prototype as unknown as Record<string, unknown>)[handler] as object
      assert.equal(Reflect.getMetadata(PATH_METADATA, fn), expected.path)
      assert.equal(Reflect.getMetadata(METHOD_METADATA, fn), expected.method)
      assert.equal(Reflect.getMetadata(REQUIRED_ACTION_KEY, fn), expected.action)
    })
  }

  it('控制器根路径 = family-deletion', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, DeletionController), 'family-deletion')
  })
})

describe('契约：40 动作；两个删除动作 guardian ALLOW / child DENY，且都是同意豁免', () => {
  it('规模：40 个动作（数字变了必须同时改 PRD §7 与用例）', () => {
    assert.equal(ALL_ACTIONS.length, 40)
  })

  it('判定：查看 / 申请删除只给家长', () => {
    assert.deepEqual(PERMISSION_MATRIX.view_family_deletion, { guardian: 'ALLOW', child: 'DENY' })
    assert.deepEqual(PERMISSION_MATRIX.manage_family_deletion, { guardian: 'ALLOW', child: 'DENY' })
  })

  it('★ 两个动作都在**豁免**集合：撤回同意后仍必须能删除', () => {
    const actions = ['view_family_deletion', 'manage_family_deletion'] as const
    const exempt: readonly string[] = CONSENT_EXEMPT_ACTIONS
    const gated: readonly string[] = CONSENT_GATED_ACTIONS
    for (const action of actions) {
      assert.equal(exempt.includes(action), true, `${action} 不在豁免集合`)
      assert.equal(gated.includes(action), false, `${action} 被同意闸门拦住`)
    }
  })

  it('冷却期常数 = 7 天', () => {
    assert.equal(FAMILY_DELETION_COOLING_DAYS, 7)
  })
})

describe('worker 配置：环境变量解析有界（乱填不会热循环 / 吞全表）', () => {
  it('默认：开启、10 分钟、20 条', () => {
    assert.deepEqual(resolveDeletionWorkerConfig({}), {
      enabled: true,
      intervalMs: 10 * 60 * 1000,
      batchSize: 20
    })
  })

  it('FAMILY_DELETION_WORKER_ENABLED=false（大小写 / 空格）⇒ 关闭', () => {
    assert.equal(
      resolveDeletionWorkerConfig({ FAMILY_DELETION_WORKER_ENABLED: ' FALSE ' }).enabled,
      false
    )
    assert.equal(resolveDeletionWorkerConfig({ FAMILY_DELETION_WORKER_ENABLED: 'no' }).enabled, true)
  })

  it('间隔 < 1s / 非数字 ⇒ 回默认（不许变成热循环）', () => {
    assert.equal(resolveDeletionWorkerConfig({ FAMILY_DELETION_INTERVAL_MS: '10' }).intervalMs, 600_000)
    assert.equal(resolveDeletionWorkerConfig({ FAMILY_DELETION_INTERVAL_MS: 'abc' }).intervalMs, 600_000)
    assert.equal(resolveDeletionWorkerConfig({ FAMILY_DELETION_INTERVAL_MS: '5000' }).intervalMs, 5_000)
  })

  it('批量 0 / 501 / 小数 ⇒ 回默认（不许一次吞掉全表）', () => {
    for (const raw of ['0', '501', '1.5', 'abc']) {
      assert.equal(resolveDeletionWorkerConfig({ FAMILY_DELETION_BATCH: raw }).batchSize, 20, raw)
    }
    assert.equal(resolveDeletionWorkerConfig({ FAMILY_DELETION_BATCH: '7' }).batchSize, 7)
  })
})
