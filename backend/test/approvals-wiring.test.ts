/**
 * approvals-wiring.test.ts —— `ApprovalsModule` 的**世界转发**用例（W2-D，2026-10-16）
 *
 * ── 这个文件只回答一个问题：「在哪个世界」有没有**第二个来源**──────────────────
 *   `ApprovalsModule` 现在**自己选实现**（W3-A：有库 ⇒ `PrismaApprovalsRepository`），
 *   同时把 `hasDatabase` **向下传**给 `DeviceSessionModule` / `MembershipModule`。
 *   两件事都必须只有一个来源，否则\"审批连真库、身份连假库\"这种半真半假最难发现。
 *   这件事为什么值得单独一个文件（不是整齐）：
 *     · 那两个子模块**按环境推断**，而用例挂在 `ApprovalsModule` 这张图上时**够不着**
 *       它们的 `register()` 参数 ⇒ `ApprovalsModule.register({ hasDatabase })` 是**唯一**
 *       能把世界钉死的口子（`test/approvals-http.test.ts` 等正式这么用）；
 *     · 一旦转发断了（子模块各按环境推断），本机有 `.env` 的人与 CI 跑的就不是同一件事，
 *       而**两边都会绿**（各自绿在自己的那个世界上）—— 这是最难发现的一类假绿。
 *
 * ── 两半证据 ─────────────────────────────────────────────────────────────
 *   离线（本文件）：转发后的**装配声明** —— 谁被绑上、两个子模块是不是同一个世界、
 *                   审批端口在**无库**时仍诚实地说 501、有库时**确实是真适配器**
 *                   （不是「声明了 hasDatabase 却仍然 501」）；
 *   真库（`test-db/approvals-db.dbtest.ts` 组 E/F）：同一张图里端口真的**写进库**。
 *
 * 证伪脚本：`tools/_scratch/w2d-canfail.mjs`（其中一条就是"让转发失效"）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { DynamicModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { ApprovalsModule } from '../src/approvals/approvals.module'
import { PrismaApprovalsRepository } from '../src/approvals/approvals.prisma.repository'
import {
  APPROVALS_REPOSITORY,
  NotImplementedApprovalsRepository,
  type ApprovalsPort
} from '../src/approvals/approvals.repository'
import { DeviceSessionGuard } from '../src/device-session/device-session.guard'
import { DeviceSessionModule } from '../src/device-session/device-session.module'
import { PrismaDeviceSessionRepository } from '../src/device-session/device-session.prisma.repository'
import {
  DEVICE_SESSION_REPOSITORY,
  NotImplementedDeviceSessionRepository,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import { MembershipModule } from '../src/membership/membership.module'
import { PrismaMembershipRepository } from '../src/membership/membership.prisma.repository'
import {
  MEMBERSHIP_REPOSITORY,
  NotImplementedMembershipRepository,
  type MembershipPort
} from '../src/membership/membership.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/**
 * 从 `register()` 返回的**装配声明**里取出实际绑到某个令牌的类。
 * （与 `device-session-wiring.test.ts` / `membership-wiring.test.ts` 的 `boundClassOf` 同一手法：
 * 动态模块返回的就是 Nest 真正拿去建图的配置 —— 它不是"实现细节"，而是本文件要验的那件事本身。）
 */
function boundClassOf(dynamic: DynamicModule, token: unknown): unknown {
  const providers = (dynamic.providers ?? []) as { provide: unknown; useClass?: unknown }[]
  const hit = providers.find((p) => p.provide === token)
  assert.ok(
    hit !== undefined,
    `动态模块的 providers 里没有 ${String(token)} —— 端口没被提供（宿主模块会注入失败）`
  )
  return hit.useClass
}

/** 取 `ApprovalsModule.register()` 的 imports 里那个**子模块**的装配声明。 */
function childOf(imports: readonly unknown[], module: unknown): DynamicModule {
  const hit = imports.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as DynamicModule).module === module
  ) as DynamicModule | undefined
  assert.ok(
    hit !== undefined,
    'ApprovalsModule.register() 的 imports 里没有 ' +
      `${String(module)} —— 子模块没被导入：` +
      "控制器上的守卫会在启动时解析失败（Nest can't resolve dependencies）"
  )
  return hit
}

/** 一次取齐两个子模块在这个世界里绑的实现（转发是否生效就看这两行）。 */
function childrenWorld(dynamic: DynamicModule): { identity: unknown; membership: unknown } {
  const imports = dynamic.imports ?? []
  return {
    identity: boundClassOf(childOf(imports, DeviceSessionModule), DEVICE_SESSION_REPOSITORY),
    membership: boundClassOf(childOf(imports, MembershipModule), MEMBERSHIP_REPOSITORY)
  }
}

// ── 组 A：转发（纯结构，不建图、不连库）──────────────────────────────────────
describe('组 A：世界转发 —— 两个子模块必须是同一个世界，且只有一个来源', () => {
  it('★ 显式传 `hasDatabase` ⇒ **两个**子模块按同一个值分叉', () => {
    const off = childrenWorld(ApprovalsModule.register({ hasDatabase: false }))
    assert.equal(off.identity, NotImplementedDeviceSessionRepository, '无库：身份端口不是 501')
    assert.equal(off.membership, NotImplementedMembershipRepository, '无库：屏障一端口不是 501')

    const on = childrenWorld(ApprovalsModule.register({ hasDatabase: true }))
    assert.equal(
      on.identity,
      PrismaDeviceSessionRepository,
      '有库：身份端口不是 Prisma 适配器 —— 转发没生效（子模块各自按环境推了）'
    )
    assert.equal(
      on.membership,
      PrismaMembershipRepository,
      '有库：屏障一端口不是 Prisma 适配器 —— 转发没生效（子模块各自按环境推了）'
    )
  })

  it('★ 不带参 ⇒ 按**环境**推断，且两个子模块**一起**变（不许一个真库、一个 501）', () => {
    const saved = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      const off = childrenWorld(ApprovalsModule.register())
      assert.equal(
        off.identity,
        NotImplementedDeviceSessionRepository,
        '没有 DATABASE_URL 时身份端口绑了真实现 —— 无库的 `npm test` 会在装配阶段崩'
      )
      assert.equal(
        off.membership,
        NotImplementedMembershipRepository,
        '没有 DATABASE_URL 时屏障一端口绑了真实现 —— 同上'
      )

      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/db'
      const on = childrenWorld(ApprovalsModule.register())
      assert.equal(on.identity, PrismaDeviceSessionRepository, '有 DATABASE_URL 时身份端口仍绑 501')
      assert.equal(on.membership, PrismaMembershipRepository, '有 DATABASE_URL 时屏障一端口仍绑 501')
      assert.notEqual(off.identity, on.identity, '环境变了但子模块没跟着变 —— 那条"按环境推断"是空话')
      assert.notEqual(off.membership, on.membership, '环境变了但子模块没跟着变 —— 同上')

      // 显式传参 ≥ 环境（用例靠它把世界钉死）
      const pinned = childrenWorld(ApprovalsModule.register({ hasDatabase: false }))
      assert.equal(pinned.identity, NotImplementedDeviceSessionRepository, '显式 options 被环境覆盖了')
      assert.equal(pinned.membership, NotImplementedMembershipRepository, '显式 options 被环境覆盖了')
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })

  it('★ 审批端口：无库 ⇒ 显式 501；有库 ⇒ 真适配器', () => {
    const off = ApprovalsModule.register({ hasDatabase: false })
    assert.equal(
      boundClassOf(off, APPROVALS_REPOSITORY),
      NotImplementedApprovalsRepository,
      '无库时审批端口不是显式 501 —— 离线用例会以为批准成功了，而库里什么都没有'
    )
    const on = ApprovalsModule.register({ hasDatabase: true })
    assert.equal(
      boundClassOf(on, APPROVALS_REPOSITORY),
      PrismaApprovalsRepository,
      '有库时审批端口仍是 501 —— W3-A 的同事务写入根本没接上（看起来装好了、其实没人写）'
    )
    assert.notEqual(off.providers, on.providers, '世界变了但审批端口没跟着变 —— 分叉没有生效')
  })
})

// ── 组 B：真建图（无库那张图建得起来，且世界被钉死）──────────────────────────
describe('组 B：真建图 —— 守卫解得出依赖，且"有库"不会静默退回 501', () => {
  it('无库：三个端口都是 501；守卫的依赖解得开；图里没有 PrismaService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ApprovalsModule.register({ hasDatabase: false })]
    }).compile()
    try {
      assert.ok(
        moduleRef.get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY) instanceof
          NotImplementedDeviceSessionRepository
      )
      assert.ok(
        moduleRef.get<MembershipPort>(MEMBERSHIP_REPOSITORY) instanceof
          NotImplementedMembershipRepository
      )
      assert.ok(
        moduleRef.get<ApprovalsPort>(APPROVALS_REPOSITORY) instanceof NotImplementedApprovalsRepository
      )
      // 宿主模块实例化的守卫必须解得开：端口若没被**导出**，这一行会崩在依赖解析上（W1-B 实测踩过）。
      assert.ok(moduleRef.get(DeviceSessionGuard) instanceof DeviceSessionGuard)
      assert.throws(
        () => moduleRef.get(PrismaService, { strict: false }),
        '无库的图里竟然有 PrismaService —— 那说明子模块把 PrismaModule 静态导入了：' +
          '`npm test` 会在装配阶段就炸（而不是安静地用 501 跑完）'
      )
    } finally {
      await moduleRef.close()
    }
  })

  it('★ 显式 `hasDatabase: true` 但**没有** DATABASE_URL ⇒ 建图**响亮失败**（不是悄悄退回 501）', async () => {
    const saved = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      await assert.rejects(
        async () =>
          Test.createTestingModule({
            imports: [ApprovalsModule.register({ hasDatabase: true })]
          }).compile(),
        (err: unknown) => {
          assert.ok(
            String((err as Error).message).includes('DATABASE_URL'),
            `失败的理由不是"缺 DATABASE_URL"：${String(err)}`
          )
          return true
        },
        '"有库"的世界里没有库却建图成功了 —— 那是静默退回 501：生产会"看起来装好了、其实没人查库"'
      )
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })
})
