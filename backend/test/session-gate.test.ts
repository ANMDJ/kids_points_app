/**
 * session-gate.test.ts —— 身份解析**内核**（`session.gate.ts`）的纯函数穷举（W1-C，2026-10-15）
 *
 * ── 为什么内核单独测（与 membership-gate.test.ts 同一理由）──────────────────
 *   HTTP 用例能证明"这条路径拦得住"，但拦不住**边界**：
 *   `expiresAt` 恰好等于 `now` 那一毫秒算不算过期？`expiresAt` 解析不出时会怎样？
 *   角色是枚举外的值时谁负责响亮？—— 这些在真 HTTP 用例里要么测不到，
 *   要么得等 5 分钟才碰得到一次。所以把判定抽成纯函数在这里穷举。
 *
 * ── 判据来源 ───────────────────────────────────────────────────────────────
 *   `02` §7（角色由服务端 `DeviceSession` 持有；默认 `child`）
 *   ＋ §9.19（TTL 到期 ⇒ **回落 child**，降级而非拒绝）。
 *
 * ── ★ 两条口径在这里定死（两端不许各理解一种）──────────────────────────────
 *   ① 边界：`expiresAt === now` 即视为**已过期**（`isSessionActive` 用严格 `>`）。
 *   ② 形状问题（角色非法 / 时间解析不出 / childId 不同源）**抛错**，
 *      不是"当作 DENY"也不是"当作没过期" —— 它们是**数据/实现**问题，
 *      HTTP 层会翻成 500（见 `device-session.guard.ts` 的 ③）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  effectiveRole,
  isSessionActive,
  resolveSession,
  SessionRowShapeError,
  toSessionActor,
  type SessionLookupRow
} from '../src/device-session/session.gate'

const CHILD_ID = 'child-1'
const NOW = new Date('2026-10-15T13:00:00.000Z')

/** 会话行构造器：默认"有效 guardian"，各用例只覆写关心的字段。 */
function row(overrides: Partial<SessionLookupRow> = {}): SessionLookupRow {
  return {
    deviceId: 'dev-dad',
    childId: CHILD_ID,
    userId: 'u-dad',
    activeRole: 'guardian',
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides
  }
}

/** 捕获形状错误并返回它的 code（不是形状错误则让用例红 —— 那说明错误分类错了）。 */
function shapeErrorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof SessionRowShapeError) return err.code
    throw err
  }
  throw new Error('本该抛 SessionRowShapeError，却什么都没抛')
}

// ── 组 A：没有会话 ⇒ 401 的判据（绝不"匿名放行"）───────────────────────────────
describe('组 A：会话不存在（02 §3 身份那一格）', () => {
  it('查询返回 null ⇒ DENY SESSION_NOT_FOUND（不是"当作匿名 child 放行"）', () => {
    const verdict = resolveSession(null, CHILD_ID, NOW)
    assert.equal(verdict.kind, 'DENY')
    assert.equal(verdict.kind === 'DENY' ? verdict.code : '', 'SESSION_NOT_FOUND')
  })

  it('空字符串 deviceId 查不到会话时同样是 DENY（空值不享受任何特权）', () => {
    assert.equal(resolveSession(null, '', NOW).kind, 'DENY')
  })
})

// ── 组 B：角色白名单（形状问题 ⇒ 抛错，不是 DENY）───────────────────────────────
describe('组 B：activeRole 取值（MemberRole 白名单）', () => {
  it('guardian / child / viewer 都通过（viewer 合法但无权限，交由矩阵 DENY）', () => {
    assert.equal(effectiveRole(row({ activeRole: 'guardian' }), NOW), 'guardian')
    assert.equal(effectiveRole(row({ activeRole: 'child' }), NOW), 'child')
    assert.equal(effectiveRole(row({ activeRole: 'viewer' }), NOW), 'viewer')
  })

  for (const bad of ['admin', 'GUARDIAN', 'guardian ', '', 'owner']) {
    it(`★ 非法角色 ${JSON.stringify(bad)} ⇒ INVALID_SESSION_ROLE（500 = 数据问题，不是 403）`, () => {
      assert.equal(shapeErrorCode(() => effectiveRole(row({ activeRole: bad }), NOW)), 'INVALID_SESSION_ROLE')
      // 判定阶段就该响亮 —— 不许等业务层拿到一个可疑的 actor
      assert.equal(shapeErrorCode(() => resolveSession(row({ activeRole: bad }), CHILD_ID, NOW)), 'INVALID_SESSION_ROLE')
    })
  }
})

// ── 组 C：TTL（§9.19）—— 过期 = **降级**，不是拒绝 ────────────────────────────
describe('组 C：TTL 到期 ⇒ guardian 回落 child（02 §9.19）', () => {
  it('未过期（还有 1ms）⇒ guardian', () => {
    assert.equal(effectiveRole(row({ expiresAt: new Date(NOW.getTime() + 1) }), NOW), 'guardian')
    assert.equal(isSessionActive(row({ expiresAt: new Date(NOW.getTime() + 1) }), NOW), true)
  })

  it('★ 边界：`expiresAt === now` ⇒ **已过期** ⇒ 回落 child（口径在这一处定死）', () => {
    const r = row({ expiresAt: new Date(NOW.getTime()) })
    assert.equal(isSessionActive(r, NOW), false, '到期那一毫秒必须算过期')
    assert.equal(effectiveRole(r, NOW), 'child')
  })

  it('已过期 1ms ⇒ child（是降级：设备与身份仍有效，故判定仍是 ALLOW）', () => {
    const r = row({ expiresAt: new Date(NOW.getTime() - 1) })
    assert.equal(effectiveRole(r, NOW), 'child')
    const verdict = resolveSession(r, CHILD_ID, NOW)
    assert.equal(verdict.kind, 'ALLOW', '过期若判 401，孩子连"看自己的积分"都做不了 —— TTL 变成了故障')
  })

  it('过期很久（1 天前）⇒ child（没有"过期越久越宽松"这种分支）', () => {
    assert.equal(effectiveRole(row({ expiresAt: new Date(NOW.getTime() - 86_400_000) }), NOW), 'child')
  })

  it('child 会话过期 ⇒ 仍是 child（它本来就没有更高权限可收，也不是 401）', () => {
    const r = row({ activeRole: 'child', expiresAt: new Date(NOW.getTime() - 1) })
    assert.equal(effectiveRole(r, NOW), 'child')
  })

  it('viewer 会话过期 ⇒ 仍是 viewer（由矩阵一律 DENY，不靠时间收权）', () => {
    const r = row({ activeRole: 'viewer', expiresAt: new Date(NOW.getTime() - 1) })
    assert.equal(effectiveRole(r, NOW), 'viewer')
  })

  it('ISO 字符串形式的 expiresAt 同样支持（Prisma 给 Date、线上可能是字符串）', () => {
    const iso = new Date(NOW.getTime() + 60_000).toISOString()
    assert.equal(effectiveRole(row({ expiresAt: iso }), NOW), 'guardian')
    assert.equal(effectiveRole(row({ expiresAt: iso }), new Date(NOW.getTime() + 120_000)), 'child')
  })

  it('★ expiresAt 解析不出 ⇒ INVALID_SESSION_EXPIRY（**绝不**当成"没过期"，那会让 TTL 静默失效）', () => {
    for (const bad of ['', 'not-a-date', '2026-13-45', new Date('invalid')]) {
      assert.equal(shapeErrorCode(() => isSessionActive(row({ expiresAt: bad }), NOW)), 'INVALID_SESSION_EXPIRY')
      assert.equal(shapeErrorCode(() => resolveSession(row({ expiresAt: bad }), CHILD_ID, NOW)), 'INVALID_SESSION_EXPIRY')
    }
  })
})

// ── 组 D：childId 同源（会话行必须属于**本次请求的这个孩子**）───────────────────
describe('组 D：childId 同源校验（会话键参与了判定）', () => {
  it('一致 ⇒ ALLOW', () => {
    assert.equal(resolveSession(row(), CHILD_ID, NOW).kind, 'ALLOW')
  })

  it('★ 不一致 ⇒ SESSION_CHILD_MISMATCH（500）：对不上意味着适配器**没按 childId 查**', () => {
    assert.equal(
      shapeErrorCode(() => resolveSession(row({ childId: 'child-2' }), CHILD_ID, NOW)),
      'SESSION_CHILD_MISMATCH',
      '放行的话，"在哪个孩子的档案上"这一半身份就是客户端说了算'
    )
  })

  it('大小写/空白差异**不**算同源（不做任何"宽松匹配"）', () => {
    assert.equal(
      shapeErrorCode(() => resolveSession(row({ childId: ` ${CHILD_ID}` }), CHILD_ID, NOW)),
      'SESSION_CHILD_MISMATCH'
    )
  })
})

// ── 组 E：toSessionActor —— 产物里不含任何客户端提供的东西 ─────────────────────
describe('组 E：toSessionActor（身份产物）', () => {
  it('userId 与角色都来自会话行；childId 是**被校验过**的请求值', () => {
    const out = toSessionActor(row(), CHILD_ID, NOW)
    assert.deepEqual(out, { actor: { userId: 'u-dad', role: 'guardian' }, childId: CHILD_ID })
  })

  it('★ 过期 guardian ⇒ 产物里的角色是 **child**（降级发生在身份层，不靠调用方记得）', () => {
    const out = toSessionActor(row({ expiresAt: new Date(NOW.getTime() - 1) }), CHILD_ID, NOW)
    assert.equal(out.actor.role, 'child')
  })

  it('形状坏的行**抛错**而不是产出 actor（不许把一个可疑身份交给下游）', () => {
    assert.throws(() => toSessionActor(row({ activeRole: 'admin' }), CHILD_ID, NOW), SessionRowShapeError)
    assert.throws(() => toSessionActor(row({ childId: 'child-2' }), CHILD_ID, NOW), SessionRowShapeError)
  })
})

// ── 组 F：孩子模式（W14，2026-11-03）─────────────────────────────────────────
/**
 * 这一组钉住 `effectiveRole()` 的**优先级**与方向：
 *   `kidModeUntil`（有值） > `expiresAt/activeRole`。
 * 关键不是"窗口内降级"（那显然），而是：
 *   · 已经到点的 `kidModeUntil` **仍然**降级（A 方案：等半小时不能自动回家长）；
 *   · `viewer` 不被改成 `child`（那是提权，不是降级）；
 *   · 坏时间戳 ⇒ 500 而不是"当成没开孩子模式"（后者会静默给家长权限）。
 */
describe('组 F：孩子模式的降级优先级', () => {
  it('窗口内 ⇒ child（即使会话是 guardian、且远未到期）', () => {
    const r = row({ kidModeUntil: new Date(NOW.getTime() + 10 * 60_000) })
    assert.equal(effectiveRole(r, NOW), 'child')
    assert.equal(toSessionActor(r, CHILD_ID, NOW).actor.role, 'child')
  })

  it('★ 已经到点 ⇒ 仍然是 child（到期不自动回家长模式）', () => {
    assert.equal(effectiveRole(row({ kidModeUntil: new Date(NOW.getTime() - 1) }), NOW), 'child')
  })

  it('★ 边界：kidModeUntil === now ⇒ child（与 expiresAt 同一个边界口径）', () => {
    assert.equal(effectiveRole(row({ kidModeUntil: new Date(NOW.getTime()) }), NOW), 'child')
  })

  it('接受 ISO 字符串（线上传输形态）', () => {
    const r = row({ kidModeUntil: '2026-10-15T13:05:00.000Z' })
    assert.equal(effectiveRole(r, NOW), 'child')
  })

  it('★ viewer 不被降级成 child（那是提权：只读成员会突然能打卡）', () => {
    const r = row({
      activeRole: 'viewer',
      kidModeUntil: new Date(NOW.getTime() + 10 * 60_000),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000)
    })
    assert.equal(effectiveRole(r, NOW), 'viewer')
  })

  it('child 本来就是 child（降级是幂等的）', () => {
    const r = row({ activeRole: 'child', kidModeUntil: new Date(NOW.getTime() + 60_000) })
    assert.equal(effectiveRole(r, NOW), 'child')
  })

  it('kidModeUntil 缺省/null ⇒ 走原来的 TTL 逻辑（旧会话行行为不变）', () => {
    assert.equal(effectiveRole(row({ kidModeUntil: null }), NOW), 'guardian')
    assert.equal(effectiveRole(row(), NOW), 'guardian')
    assert.equal(
      effectiveRole(row({ kidModeUntil: null, expiresAt: new Date(NOW.getTime() - 1) }), NOW),
      'child'
    )
  })

  it('★ 坏时间戳 ⇒ INVALID_KID_MODE_EXPIRY（绝不"当成没开孩子模式"）', () => {
    const bad = row({ kidModeUntil: 'not-a-date' })
    assert.equal(shapeErrorCode(() => effectiveRole(bad, NOW)), 'INVALID_KID_MODE_EXPIRY')
    assert.equal(
      shapeErrorCode(() => resolveSession(bad, CHILD_ID, NOW)),
      'INVALID_KID_MODE_EXPIRY'
    )
  })
})

