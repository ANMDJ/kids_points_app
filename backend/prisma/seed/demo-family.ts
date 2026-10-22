/**
 * demo-family.ts —— 开发用「一家人」演示数据（W5-G，2026-10-22）
 *
 * ── 为什么**不**挂在 `npm run seed` 上 ──────────────────────────────────────
 *   `npm run seed`（`prisma db seed` → `rule-templates.ts`）是**迁移引导链**的一环：
 *   它只写平台级 `RuleTemplate`，内容对任何环境都成立。本脚本写的是**假人**
 *   （`demo-child` / `demo-guardian` / `demo-relative`），只能在开发库上手动跑。
 *   两者混在一起，某天有人对着一个"干净"的库跑 `db seed`，就会多出三个假账号。
 *
 * ── 它解决什么问题 ──────────────────────────────────────────────────────────
 *   `POST /invites/accept` 有一个**看起来反常但必须如此**的前提：调用方已经有会话
 *   （见 `invites.controller.ts` 头部）。全新库上「第一次加入」既没有 `User`，也没有
 *   `DeviceSession`，于是这条路由根本没法手工试。本脚本把这套前提一次造齐：
 *
 *     Child(demo-child) ──▶ ChildMember(guardian: demo-guardian, active)
 *            │
 *            ├─ DeviceSession(demo-device-guardian)  → 用来发码 / 列表 / 吊销
 *            ├─ DeviceSession(demo-device-relative)  → 用来 accept（被邀请人）
 *            └─ InviteCode('MAMA2345', guardian, maxUses=3, 7 天)
 *
 * ── 幂等且**可重复演示** ───────────────────────────────────────────────────
 *   ① `InviteCode` 每次跑都**重置**成可用（`usedCount=0`、未吊销、7 天后过期）
 *      —— 否则第二次演示拿到的是一张已经用光的码，而脚本"看起来成功了"；
 *   ② `demo-relative` 的成员位若还在（上一轮 accept 过），改成 `removed`
 *      —— 这是领域里的"移出"，accept 会让它回来（复用同一行）；
 *   ③ 会话的 `expiresAt` 每次刷新：过期的会话查不到，等于"这个人不存在"。
 *
 * ── 硬约束 ─────────────────────────────────────────────────────────────────
 *   · `NODE_ENV=production` **直接拒绝**（它会写真实的行；账本表 DELETE 已被 REVOKE，
 *     写进去就删不掉 —— 与 `scripts/run-db-tests.mjs` 同一条纪律）；
 *   · 码 `DEMO2345` 只用 `INVITE_CODE_ALPHABET` 内的字符（没有 `0` / `1` / `O` / `I` / `L`），
 *     与真实码同形 —— 否则演示会"教会"用户抄一个合法形状下不存在的码。
 *
 * 用法：npm run seed:demo         （或 npx tsx prisma/seed/demo-family.ts）
 */
import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import {
  INVITE_CODE_ALPHABET,
  INVITE_SESSION_TTL_MS,
  isWellFormedInviteCode
} from '../../src/invites/invite-code'

const DEMO_CHILD_ID = 'demo-child'
const DEMO_GUARDIAN_ID = 'demo-guardian'
const DEMO_RELATIVE_ID = 'demo-relative'
const DEMO_GUARDIAN_DEVICE = 'demo-device-guardian'
const DEMO_RELATIVE_DEVICE = 'demo-device-relative'
/**
 * 演示码。**必须**由 `isWellFormedInviteCode()` 校验通过（下面有断言）：
 * 字母表里没有 `0` / `O` / `1` / `I` / `L`，所以"DEMO2345"这种看上去很像码的
 * 字符串其实是**非法形状** —— 第一次写本脚本时就踩了这个坑（accept 直接 400
 * `INVITE_CODE_MALFORMED`）。断言让这类错误在写库前就炸掉，而不是等人手工点到。
 */
const DEMO_CODE = 'MAMA2345'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * 会话 TTL 直接取服务端口径（`INVITE_SESSION_TTL_MS`），**不是**在这里再写一个 30 天：
 * 两处各写一份，等 PIN 落地把它改回 5 分钟时，必然有一处被忘掉。
 */
const SESSION_TTL_MS = INVITE_SESSION_TTL_MS

function fail(reason: string): never {
  console.error(`✖ ${reason}`)
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') {
  fail('NODE_ENV=production —— 拒绝写演示数据（本脚本会写真实的 User / Child 行）')
}

const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
if (connectionString === undefined || connectionString === '') {
  fail('MIGRATION_DATABASE_URL / DATABASE_URL 均未设置，无法写库（见 backend/.env.example）')
}

// ★ 演示码必须能过真实校验器 —— 否则演示会以 400 INVITE_CODE_MALFORMED 收场，
//   而这看起来像"后端坏了"，实际是脚本写错了形状。
if (!isWellFormedInviteCode(DEMO_CODE)) {
  fail(`演示码「${DEMO_CODE}」不符合邀请码形状（字母表：${INVITE_CODE_ALPHABET}）`)
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

async function seedDemoFamily(): Promise<void> {
  const now = Date.now()

  // ① 孩子档案（软删状态一并复位：否则发码会以"孩子已删除"返回 404）
  await prisma.child.upsert({
    where: { id: DEMO_CHILD_ID },
    update: { status: 'active', deletedAt: null },
    create: { id: DEMO_CHILD_ID, name: '小明（演示）', pointsBalance: 12 }
  })

  // ② 两个人：一位家长（成员）、一位亲戚（**还不是**成员 —— 他要靠邀请码加入）
  await prisma.user.upsert({
    where: { id: DEMO_GUARDIAN_ID },
    update: {},
    create: { id: DEMO_GUARDIAN_ID, displayName: '妈妈（演示）' }
  })
  await prisma.user.upsert({
    where: { id: DEMO_RELATIVE_ID },
    update: {},
    create: { id: DEMO_RELATIVE_ID, displayName: '奶奶（演示）' }
  })

  // ③ 家长是 guardian 成员位
  await prisma.childMember.upsert({
    where: { childId_userId: { childId: DEMO_CHILD_ID, userId: DEMO_GUARDIAN_ID } },
    update: { role: 'guardian', status: 'active', removedAt: null },
    create: {
      childId: DEMO_CHILD_ID,
      userId: DEMO_GUARDIAN_ID,
      role: 'guardian',
      status: 'active'
    }
  })

  // ④ 亲戚若已加入（上一轮演示过），先"移出" —— accept 会把他重新拉回来（同一行）
  const relativeMember = await prisma.childMember.findUnique({
    where: { childId_userId: { childId: DEMO_CHILD_ID, userId: DEMO_RELATIVE_ID } },
    select: { id: true, status: true }
  })
  if (relativeMember !== null && relativeMember.status === 'active') {
    await prisma.childMember.update({
      where: { id: relativeMember.id },
      data: { status: 'removed', removedAt: new Date() }
    })
  }

  // ⑤ 两台设备的会话（accept 的身份屏障要求被邀请人**已有**会话）
  const sessions: Array<[string, string, 'guardian' | 'child']> = [
    [DEMO_GUARDIAN_DEVICE, DEMO_GUARDIAN_ID, 'guardian'],
    [DEMO_RELATIVE_DEVICE, DEMO_RELATIVE_ID, 'child']
  ]
  for (const [deviceId, userId, activeRole] of sessions) {
    await prisma.deviceSession.upsert({
      where: { deviceId_childId: { deviceId, childId: DEMO_CHILD_ID } },
      update: { userId, activeRole, expiresAt: new Date(now + SESSION_TTL_MS) },
      create: {
        deviceId,
        childId: DEMO_CHILD_ID,
        userId,
        activeRole,
        expiresAt: new Date(now + SESSION_TTL_MS)
      }
    })
  }

  // ⑥ 一张**每次都可演示**的邀请码
  const invite = await prisma.inviteCode.upsert({
    where: { code: DEMO_CODE },
    update: {
      childId: DEMO_CHILD_ID,
      role: 'guardian',
      maxUses: 3,
      usedCount: 0,
      usedByUserId: null,
      usedAt: null,
      revoked: false,
      expiresAt: new Date(now + INVITE_TTL_MS),
      createdByUserId: DEMO_GUARDIAN_ID
    },
    create: {
      childId: DEMO_CHILD_ID,
      code: DEMO_CODE,
      role: 'guardian',
      maxUses: 3,
      expiresAt: new Date(now + INVITE_TTL_MS),
      createdByUserId: DEMO_GUARDIAN_ID
    },
    select: { code: true, maxUses: true, expiresAt: true }
  })

  console.log('✔ 演示数据已就绪（可重复执行）：')
  console.log(`    childId       ${DEMO_CHILD_ID}（小明 · 12 分）`)
  console.log(`    家长成员位    ${DEMO_GUARDIAN_ID}（guardian · active）`)
  console.log(`    待加入的人    ${DEMO_RELATIVE_ID}（**没有**成员位）`)
  console.log(
    `    邀请码        ${invite.code}（guardian · 最多 ${invite.maxUses} 次 · 至 ` +
      `${invite.expiresAt.toISOString()}）`
  )
  console.log('')
  console.log('   手工试四条路由（家长设备 = demo-device-guardian）：')
  console.log(
    `     curl -s -X POST http://localhost:3000/invites \\\n` +
      `       -H 'content-type: application/json' \\\n` +
      `       -H 'x-kp-device-id: ${DEMO_GUARDIAN_DEVICE}' ` +
      `-H 'x-kp-child-id: ${DEMO_CHILD_ID}' \\\n` +
      `       -d '{"role":"child","maxUses":1,"expiresInDays":7}'`
  )
  console.log(
    `     curl -s http://localhost:3000/invites \\\n` +
      `       -H 'x-kp-device-id: ${DEMO_GUARDIAN_DEVICE}' -H 'x-kp-child-id: ${DEMO_CHILD_ID}'`
  )
  console.log(
    `     curl -s -X POST http://localhost:3000/invites/accept \\\n` +
      `       -H 'content-type: application/json' \\\n` +
      `       -H 'x-kp-device-id: ${DEMO_RELATIVE_DEVICE}' ` +
      `-H 'x-kp-child-id: ${DEMO_CHILD_ID}' \\\n` +
      `       -d '{"code":"${invite.code}"}'`
  )
}

// ★ 不能用顶层 await：tsx 按 `module: commonjs` 编译（06 §10 缺陷 12）。
seedDemoFamily()
  .catch((error: unknown) => {
    console.error('✖ 演示数据写入失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

