/**
 * set-demo-account.ts —— 给**演示家长**设置 App 登录用的手机号 + 密码（W10-A，2026-10-30）
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────────
 *   `prisma/seed/demo-family.ts` 只写"家庭"结构（Child / User / 成员位 / 设备会话），
 *   登录标识（`User.phone` / `email` / `passwordHash`）是 W9-D 才加的列，seed 不管它。
 *   于是「在 App 里点一次登录」这条最普通的验证路径，缺一个能用的账号 ——
 *   而手工算 scrypt 哈希再 UPDATE 一遍，正是最容易抄错格式的地方
 *   （`scrypt-pw$…` 前缀与 `scrypt$…` 的 PIN 哈希不通用，见 password-hash.ts 文件头）。
 *   ⇒ 用后端**自己的** `hashPassword()` 写，格式永远与校验端一致。
 *
 * ── ★ 它不是"改密码的后门"（三条硬约束）──────────────────────────────────────
 *   ① 只认 `ids` 里写死的那个**演示**用户（`demo-guardian`），不接受任何 userId 参数；
 *   ② 手机号/密码是常量，不接受 `process.argv`（想改就改源码，这个动作该是显式的）；
 *   ③ `NODE_ENV=production` ⇒ 直接拒绝退出（与 `seed/demo-family.ts` 同一道闸）。
 *   另外**不**在输出里打印哈希，只打印 `hasPassword=true` —— 日志会被复制粘贴。
 *
 * 用法：
 *   npm run seed:demo      # 先有 demo-child / demo-guardian / demo-device-guardian
 *   npm run seed:account   # 再给演示家长设手机号 + 密码
 */
import 'dotenv/config'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { hashPassword } from '../src/common/password-hash'

/** 与 `prisma/seed/demo-family.ts` **必须**一致（那里是同一批演示数据的来源）。 */
const DEMO_GUARDIAN_ID = 'demo-guardian'
const DEMO_PHONE = '13800138000'
const DEMO_PASSWORD = 'demo12345'

function fail(reason: string): never {
  console.error(`✖ ${reason}`)
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') {
  fail('NODE_ENV=production —— 拒绝写入演示账号（这会改真实用户的登录标识）')
}

const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
if (connectionString === undefined || connectionString === '') {
  fail('MIGRATION_DATABASE_URL / DATABASE_URL 均未设置，无法写库（见 backend/.env.example）')
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

async function setDemoAccount(): Promise<void> {
  const guardian = await prisma.user.findUnique({
    where: { id: DEMO_GUARDIAN_ID },
    select: { id: true, displayName: true }
  })
  if (guardian === null) {
    // 不自动建 User：那样会得到一个"没有成员位、登进去什么都看不到"的账号，
    // 而症状看起来像"后端没数据"。
    fail(`找不到演示家长 ${DEMO_GUARDIAN_ID} —— 请先跑 npm run seed:demo`)
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD)
  const user = await prisma.user.update({
    where: { id: DEMO_GUARDIAN_ID },
    data: { phone: DEMO_PHONE, passwordHash, passwordSetAt: new Date() },
    select: { id: true, displayName: true, phone: true, passwordSetAt: true }
  })

  const members = await prisma.childMember.findMany({
    where: { userId: user.id, status: 'active' },
    select: { childId: true, role: true }
  })

  console.log('✔ 演示账号已就绪（幂等：每次都会重设密码）')
  console.log(`    登录标识   ${user.phone}（手机号）`)
  console.log(`    密码       ${DEMO_PASSWORD}`)
  console.log(`    密码已设置 ${user.passwordSetAt === null ? '否' : '是'}`)
  console.log(`    成员位     ${JSON.stringify(members)}`)
  console.log('')
  console.log('  App（Web）启动参数：')
  console.log(`    --dart-define=KP_DEVICE_ID=demo-device-guardian`)
  console.log(`    --dart-define=KP_CHILD_ID=demo-child`)
}

setDemoAccount()
  .catch((error: unknown) => {
    console.error('✖ 写演示账号失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
