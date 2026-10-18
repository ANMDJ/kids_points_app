/**
 * device-session-http.test.ts —— **身份由服务端确立**的集成测试（W1-C，2026-10-15）
 *                                （真起 Nest ＋ 真发 HTTP 请求）
 *
 * ── 这一步在修什么 ─────────────────────────────────────────────────────────
 *   W1-A / W1-B 让三道屏障**都是真的**，但它们的共同输入 `actor` 来自**客户端自己发的头**：
 *     · `x-kp-role: guardian` ⇒ 你就是家长（改一下小程序 storage 或直接发包即可）；
 *     · `x-kp-user-id: u-mom` ⇒ 你就是妈妈。
 *   于是「屏障拦得对不对」这件事**从来没有被验证过** —— 拦一个**自称**是家长的人，
 *   与拦一个**真的**是家长的人，是两件不同的事。
 *
 *   本文件测的就是**分界线**：角色与 userId 由服务端会话行给出，
 *   客户端只被允许回答「我是哪台设备、在哪个孩子的档案上」，且**必须**有会话。
 *
 * ── 为什么必须走 HTTP ──────────────────────────────────────────────────────
 *   判据本身是纯函数（见 `session-gate.test.ts` 的穷举），但**接线**不是：
 *   Guard 有没有挂上、顺序对不对、`kpActor` 有没有被填、放错模块导致依赖解析失败 ——
 *   这些只有真装配 + 真请求才看得见。故本文件**不重复**穷举边界，只钉接线与端到端后果。
 *
 * ── 判据来源 ───────────────────────────────────────────────────────────────
 *   `02` §3（三道屏障的顺序：身份 → 资格 → 矩阵）／§7（会话表 + 默认角色 child）
 *   ／§9.19（TTL 到期 ⇒ 回落 child）。
 *
 * ── ⚠️ 诚实标注（不粉饰）──────────────────────────────────────────────────
 *   ① 本文件的会话**来自内存替身**（验的是接线 / 顺序 / 403 / 500）；**真 Prisma 查询**的两半
 *      证据在别处：`test/device-session-wiring.test.ts`（装配分叉 ＋ 适配器读路径，离线）
 *      与 `test-db/identity-db.dbtest.ts`（真库）。组 D 钉的是**无库装配**下必须 501；
 *   ② **设备凭据仍可伪造**：`x-kp-device-id` 谁都能报 ⇒ **角色的来源可信了，但"这台设备是你"还不可信**。
 *      生产因此仍 503（组 E 钉住）；真正的解药是 L2 之后的会话 token；
 *   ③ **会话刷新**（§7「每次 guardian 操作刷新 TTL」）与 **PIN 切换 / 锁 15 分钟**（§9.18）
 *      **都未实现**（属 W2 的**写路径**；W2-D 只交付了读路径）—— 本文件测的是**读侧**的 TTL 口径，不是写侧的续期。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { Controller, Get, Module, Req, UseGuards, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { DeviceSessionGuard } from '../src/device-session/device-session.guard'
import { DeviceSessionModule } from '../src/device-session/device-session.module'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MembershipGuard } from '../src/membership/membership.guard'
import { MembershipModule } from '../src/membership/membership.module'
import {
  MEMBERSHIP_REPOSITORY,
  type MembershipPort
} from '../src/membership/membership.repository'
import type { RequestWithActor } from '../src/permissions/actor'
import { PermissionsGuard } from '../src/permissions/permissions.guard'
import { PermissionsModule } from '../src/permissions/permissions.module'
import { RequireAction } from '../src/permissions/require-action.decorator'

const CHILD_ID = 'child-1'
const OTHER_CHILD_ID = 'child-2'

const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_UNKNOWN = 'dev-never-seen'

function headers(deviceId: string, childId: string = CHILD_ID): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': childId }
}

const GUARDIAN = headers(DEV_DAD)
const CHILD = headers(DEV_KID)

// ── 内存替身：设备会话（DeviceSessionPort）────────────────────────────────────
interface SessionFake extends DeviceSessionPort {
  rows: Map<string, SessionLookupRow>
  reset(): void
  put(row: SessionLookupRow): void
  /** 把某台设备的会话改成**已过期**（验 §9.19 的回落）。 */
  expire(deviceId: string, childId?: string): void
  /**
   * ★ 模拟**适配器写坏**：只按 deviceId 查、忽略 childId。
   *   内核的 `SESSION_CHILD_MISMATCH` 就是为这一族病留的 —— 组 C 用它证明那条守卫不是装饰。
   */
  ignoreChildId(on: boolean): void
}

function sessionKey(deviceId: string, childId: string): string {
  return `${deviceId}::${childId}`
}

function makeSessionFake(): SessionFake {
  const rows = new Map<string, SessionLookupRow>()
  const future = (): Date => new Date(Date.now() + 5 * 60 * 1000)
  let ignoreChildIdFlag = false

  const baseline: SessionLookupRow[] = [
    { deviceId: DEV_DAD, childId: CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt: future() },
    { deviceId: DEV_DAD, childId: OTHER_CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt: future() },
    { deviceId: DEV_KID, childId: CHILD_ID, userId: 'u-kid', activeRole: 'child', expiresAt: future() }
    // ★ 刻意**没有** DEV_UNKNOWN → 组 A 用它验 SESSION_NOT_FOUND；
    //   也**没有** (DEV_KID, child-2) → 组 A 用它验"会话键包含 childId"。
  ]

  const fake: SessionFake = {
    rows,
    reset() {
      rows.clear()
      ignoreChildIdFlag = false
      for (const row of baseline) rows.set(sessionKey(row.deviceId, row.childId), row)
    },
    put(row) {
      rows.set(sessionKey(row.deviceId, row.childId), row)
    },
    expire(deviceId, childId = CHILD_ID) {
      const row = rows.get(sessionKey(deviceId, childId))
      assert.ok(row !== undefined, `前提变了：${deviceId} 本该有会话`)
      rows.set(sessionKey(deviceId, childId), { ...row, expiresAt: new Date(Date.now() - 1) })
    },
    ignoreChildId(on) {
      ignoreChildIdFlag = on
    },
    async findSession(deviceId, childId) {
      if (ignoreChildIdFlag) {
        // 坏实现：把 (deviceId, childId) 当成 (deviceId, *) —— 可能返回**别人档案**的行
        return [...rows.values()].find((r) => r.deviceId === deviceId) ?? null
      }
      return rows.get(sessionKey(deviceId, childId)) ?? null
    }
  }
  fake.reset()
  return fake
}


// ── 内存替身：成员位（MembershipPort）—— 只为证明"身份之后那两道门也吃到了同一份身份"──
/**
 * ★ u-dad / u-kid 是 child-1 的成员；**刻意没有** u-stranger / u-mom。
 *   于是「客户端冒用 userId」这条用例有了判别力：
 *   若伪造的 `x-kp-user-id: u-stranger` 被采信，屏障一会给 403 `MEMBER_NOT_FOUND`；
 *   而由会话给出 `u-dad` 时才会 200。两个结果**不可能同时**出现 —— 这就是可证伪。
 * ★ 另加 (child-2, u-dad)：**同一个家长本来就是两个孩子的成员**（现实中很常见）。
 *   于是「换个孩子」那条对照用例才能把身份层与屏障一分离开 ——
 *   若少了这一行，200 会退化成 403 MEMBER_NOT_FOUND，测到的就不是身份层了。
 */
function makeMembershipFake(): MembershipPort {
  const members: MembershipLookupRow[] = [
    { childId: CHILD_ID, userId: 'u-dad', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-kid', role: 'child', status: 'active', restrictions: {} },
    { childId: OTHER_CHILD_ID, userId: 'u-dad', role: 'guardian', status: 'active', restrictions: {} }
  ]
  return {
    async findMembership(childId, userId) {
      return members.find((m) => m.childId === childId && m.userId === userId) ?? null
    }
  }
}

// ── 探针控制器：证明"接线"而不是重测判据 ──────────────────────────────────────
/**
 * 守卫链与业务端点**一模一样**（身份 → 资格 → 矩阵＋收紧）。
 * 两个端点刚好构成一对**对照**：
 *   · `whoami` 用的是**双方都 ALLOW** 的动作（`view_child_points`）⇒ 能走到业务层，
 *     于是可以把"服务端认定我是谁"**直接读出来**（而不是靠 403/200 反推）；
 *   · `guardian-only` 用 `review_approvals`（child DENY）⇒ 用同一份身份走矩阵，
 *     于是"降级"与"拒绝"这两件事在同一台设备上能**同时**观察到。
 */
@Controller('probe')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
class ProbeController {
  @Get('whoami')
  @RequireAction('view_child_points')
  whoami(@Req() req: RequestWithActor): { actor: unknown; childId: unknown; member: unknown } {
    return { actor: req.kpActor, childId: req.kpChildId, member: req.kpMember?.userId }
  }

  @Get('guardian-only')
  @RequireAction('review_approvals')
  guardianOnly(): { reached: string } {
    return { reached: 'guardian-only' }
  }
}

@Module({
  // ★ 显式 `hasDatabase: false`（W2-D 起子模块是动态的）：本文件是**离线**用例，
  //   要把"无库世界"钉死 —— 不传参就会按环境推断（开发机上若导出过 DATABASE_URL，
  //   装配阶段就会导入 PrismaModule 并连上真库），那时组 D 期望的 501 会变成
  //   "真查询后的 401"，同一份用例在两台机器上验的是两件事。
  imports: [
    DeviceSessionModule.register({ hasDatabase: false }),
    MembershipModule.register({ hasDatabase: false }),
    PermissionsModule
  ],
  controllers: [ProbeController],
  providers: [DeviceSessionGuard]
})
class IdentityProbeModule {}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function send(
  baseUrl: string,
  path: string,
  headers_: Record<string, string> = {}
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, { headers: headers_ })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

/**
 * 起一个只装探针模块的真服务。
 * ★ `injectSession: false` ⇒ 走**无库装配**（`NotImplementedDeviceSessionRepository` = 501）——
 *   组 D 靠这个钉住"没有实现时必须响亮"。本文件的探针模块已显式
 *   `DeviceSessionModule.register({ hasDatabase: false })`，所以组 D 不依赖本机环境。
 * ★ 会话替身**恒**注入（除非显式关掉）：不喂它，任何用例都会停在身份层，
 *   那时测到的就不是"接线对不对"了。
 */
async function startApp(
  options: { injectSession?: boolean; session?: SessionFake } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({ imports: [IdentityProbeModule] })
  if (options.injectSession !== false) {
    builder
      .overrideProvider(DEVICE_SESSION_REPOSITORY)
      .useValue(options.session ?? makeSessionFake())
      .overrideProvider(MEMBERSHIP_REPOSITORY)
      .useValue(makeMembershipFake())
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // ★ 与 main.ts 同一函数：测的是**真装配**
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ── 组 A：身份来自**会话**，客户端说的不算 ────────────────────────────────────
describe('组 A：客户端自报的角色 / userId 一律无效（02 §7）', () => {
  let app!: INestApplication
  let url = ''
  let session!: SessionFake

  before(async () => {
    session = makeSessionFake()
    ;({ app, url } = await startApp({ session }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => session.reset())

  it('对照：家长设备 ⇒ whoami 的 actor 就是会话里的 (u-dad, guardian)', async () => {
    const r = await send(url, '/probe/whoami', GUARDIAN)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.actor, { userId: 'u-dad', role: 'guardian' })
    assert.equal(r.body.childId, CHILD_ID)
  })

  it('★ 自报 `x-kp-role: guardian` **不生效** —— 会话是 child ⇒ actor.role 仍是 child', async () => {
    const r = await send(url, '/probe/whoami', { ...CHILD, 'x-kp-role': 'guardian' })
    assert.equal(r.status, 200)
    assert.deepEqual(
      r.body.actor,
      { userId: 'u-kid', role: 'child' },
      '角色被请求头改写了 —— 身份又回到"客户端说了算"（W1-C 的核心回归）'
    )
  })

  it('★ 自报 `x-kp-role: guardian` **不生效** —— 同一个孩子在家长专用动作上仍 403', async () => {
    const r = await send(url, '/probe/guardian-only', { ...CHILD, 'x-kp-role': 'guardian' })
    assert.equal(r.status, 403, '自报的 guardian 拿到了 `review_approvals` —— 这就是提权')
    assert.equal(r.body.code, 'FORBIDDEN')
  })

  it('★ 冒用 `x-kp-user-id` **不生效** —— 伪造的 u-stranger 不是成员，但判定用的是会话里的 u-dad', async () => {
    const spoofed = { ...GUARDIAN, 'x-kp-user-id': 'u-stranger' }
    const r = await send(url, '/probe/whoami', spoofed)
    assert.equal(
      r.status,
      200,
      '若这里 403 MEMBER_NOT_FOUND，说明屏障一采信了伪造的 userId（本用例失败）'
    )
    assert.deepEqual(r.body.actor, { userId: 'u-dad', role: 'guardian' })
    assert.equal(r.body.member, 'u-dad', '屏障一拿到的是会话里的 userId，不是请求头里的')
  })

  it('★ 冒用别人的设备：会话缺失 ⇒ 401 SESSION_NOT_FOUND（不是"当作匿名 child 放行"）', async () => {
    const r = await send(url, '/probe/whoami', headers(DEV_UNKNOWN))
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'SESSION_NOT_FOUND')
  })

  it('缺少 `x-kp-device-id` ⇒ 401 UNAUTHENTICATED（身份不完整，不是"跳过身份层"）', async () => {
    const r = await send(url, '/probe/whoami', { 'x-kp-child-id': CHILD_ID })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'UNAUTHENTICATED')
  })

  it('缺少 `x-kp-child-id` ⇒ 401 UNAUTHENTICATED（缺孩子上下文绝不退化成"跳过检查"）', async () => {
    const r = await send(url, '/probe/whoami', { 'x-kp-device-id': DEV_DAD })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'UNAUTHENTICATED')
  })

  it('★ 换个孩子 = 换一份会话：dev-kid 在 child-2 上没有会话 ⇒ 401（childId 是查询键，不是"随便看看"）', async () => {
    const r = await send(url, '/probe/whoami', headers(DEV_KID, OTHER_CHILD_ID))
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'SESSION_NOT_FOUND')
  })

  it('对照：同一台 dev-dad 在 child-2 上**有**会话 ⇒ 200（上面那条 401 是"有没有会话"造成的，不是 childId 本身被拒）', async () => {
    const r = await send(url, '/probe/whoami', headers(DEV_DAD, OTHER_CHILD_ID))
    assert.equal(r.status, 200)
    assert.equal(r.body.childId, OTHER_CHILD_ID)
  })

  it('设备头里塞两个值（合并成 "a, b"）⇒ 401，**不挑一个**（歧义输入不产生身份）', async () => {
    const r = await send(url, '/probe/whoami', {
      'x-kp-device-id': `${DEV_DAD}, ${DEV_KID}`,
      'x-kp-child-id': CHILD_ID
    })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'SESSION_NOT_FOUND')
  })
})



// ── 组 B：TTL 到期 = **降级**，不是拒绝（02 §9.19）────────────────────────────
describe('组 B：guardian 会话过期 ⇒ 回落 child（§9.19）', () => {
  let app!: INestApplication
  let url = ''
  let session!: SessionFake

  before(async () => {
    session = makeSessionFake()
    ;({ app, url } = await startApp({ session }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => session.reset())

  it('对照：未过期 ⇒ whoami 是 guardian 且家长专用动作 200', async () => {
    assert.deepEqual((await send(url, '/probe/whoami', GUARDIAN)).body.actor, {
      userId: 'u-dad',
      role: 'guardian'
    })
    assert.equal((await send(url, '/probe/guardian-only', GUARDIAN)).status, 200)
  })

  it('★ 过期 ⇒ whoami 的 role 变成 **child**（降级生效，且发生在身份层）', async () => {
    session.expire(DEV_DAD)
    const r = await send(url, '/probe/whoami', GUARDIAN)
    assert.equal(r.status, 200, 'TTL 到期不该变成 401 —— 那会把"该降级"变成"该故障"')
    assert.deepEqual(r.body.actor, { userId: 'u-dad', role: 'child' }, '过期后仍自称 guardian')
  })

  it('★ 过期 ⇒ 家长专用动作 403 FORBIDDEN（是"降级后被矩阵拒绝"，**不是** 401）', async () => {
    session.expire(DEV_DAD)
    const r = await send(url, '/probe/guardian-only', GUARDIAN)
    assert.equal(r.status, 403, '若这里 401，说明过期被当成了"身份不存在"（把降级实现成了拒绝）')
    assert.equal(r.body.code, 'FORBIDDEN')
  })

  it('★ 过期后**仍能**做孩子能做的事（同一个过期会话上 whoami 200）—— TTL 不该让孩子失能', async () => {
    session.expire(DEV_DAD)
    assert.equal((await send(url, '/probe/whoami', GUARDIAN)).status, 200)
  })

  it('★ 过期只作用于**这台设备**：另一台家长设备不受影响（TTL 是按会话行算的）', async () => {
    session.expire(DEV_DAD)
    assert.equal((await send(url, '/probe/guardian-only', GUARDIAN)).status, 403)
    // 另起一台家长设备（同一个人、另一台机器）
    session.put({
      deviceId: 'dev-dad-tablet',
      childId: CHILD_ID,
      userId: 'u-dad',
      activeRole: 'guardian',
      expiresAt: new Date(Date.now() + 60_000)
    })
    assert.equal((await send(url, '/probe/guardian-only', headers('dev-dad-tablet'))).status, 200)
  })

  it('child 会话过期 ⇒ 仍是 child（没有更高权限可收，也不是 401）', async () => {
    session.expire(DEV_KID)
    const r = await send(url, '/probe/whoami', CHILD)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.actor, { userId: 'u-kid', role: 'child' })
  })
})

// ── 组 C：形状坏 ⇒ **500**（数据问题不许伪装成权限问题）───────────────────────
describe('组 C：会话行形状坏 ⇒ 500（不是 401/403）', () => {
  let app!: INestApplication
  let url = ''
  let session!: SessionFake

  before(async () => {
    session = makeSessionFake()
    ;({ app, url } = await startApp({ session }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => session.reset())

  it('角色不在枚举内 ⇒ 500 INVALID_SESSION_ROLE（若报 403，一个数据病会被当成"没权限"排查很久）', async () => {
    session.put({
      deviceId: DEV_DAD,
      childId: CHILD_ID,
      userId: 'u-dad',
      activeRole: 'admin',
      expiresAt: new Date(Date.now() + 60_000)
    })
    const r = await send(url, '/probe/whoami', GUARDIAN)
    assert.equal(r.status, 500)
    assert.equal(r.body.code, 'INVALID_SESSION_ROLE')
  })

  it('expiresAt 解析不出 ⇒ 500 INVALID_SESSION_EXPIRY（绝不当作"没过期"，那会让 TTL 静默失效）', async () => {
    session.put({
      deviceId: DEV_DAD,
      childId: CHILD_ID,
      userId: 'u-dad',
      activeRole: 'guardian',
      expiresAt: 'not-a-date'
    })
    const r = await send(url, '/probe/whoami', GUARDIAN)
    assert.equal(r.status, 500)
    assert.equal(r.body.code, 'INVALID_SESSION_EXPIRY')
  })

  it('★ 适配器忽略 childId（返回别人档案的行）⇒ 500 SESSION_CHILD_MISMATCH，**不放行**', async () => {
    session.ignoreChildId(true)
    const r = await send(url, '/probe/whoami', headers(DEV_KID, OTHER_CHILD_ID))
    assert.equal(
      r.status,
      500,
      '若这里 200，则"在哪个孩子的档案上"这一半身份就是客户端说了算（把 childId 写死的同族病）'
    )
    assert.equal(r.body.code, 'SESSION_CHILD_MISMATCH')
  })
})

// ── 组 D：无库装配（不注入替身）⇒ 501，且**不是**"没查就过" ────────────────────
describe('组 D：无库装配下身份层 fail-closed（NotImplementedDeviceSessionRepository = 501）', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp({ injectSession: false }))
  })
  after(async () => {
    await app.close()
  })

  it('★ 没有会话查询实现 ⇒ 501 SESSION_LOOKUP_NOT_IMPLEMENTED（不是 200，也不是 403）', async () => {
    const r = await send(url, '/probe/whoami', GUARDIAN)
    assert.equal(r.status, 501, '无库装配放行了 —— 那意味着"身份层没落地"这件事在运行时是不可见的')
    assert.equal(
      r.body.code,
      'SESSION_LOOKUP_NOT_IMPLEMENTED',
      '无库装配下身份层没拦住：请求越到了下一道屏障的 501（`MEMBERSHIP_QUERY_NOT_IMPLEMENTED`）—— ' +
        '未落地的身份层必须**在最前面**响亮，否则"谁是谁"就没被查过'
    )
  })
})

// ── 组 E：生产闸门 ⇒ 503（凭据仍可伪造，不许上线）────────────────────────────
describe('组 E：NODE_ENV=production ⇒ 503 IDENTITY_NOT_IMPLEMENTED', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp({ session: makeSessionFake() }))
  })
  after(async () => {
    await app.close()
  })

  it('★ 生产环境直接 503：角色已由服务端确立，但 `x-kp-device-id` 可被伪造 ⇒ 这套口径禁止上线', async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const r = await send(url, '/probe/whoami', GUARDIAN)
      assert.equal(r.status, 503)
      assert.equal(r.body.code, 'IDENTITY_NOT_IMPLEMENTED')
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
    }
  })

  it('对照：非生产环境同一请求 200（证明上面那条 503 真的来自环境闸门）', async () => {
    assert.equal((await send(url, '/probe/whoami', GUARDIAN)).status, 200)
  })
})
