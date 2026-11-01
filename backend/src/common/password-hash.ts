import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>

/**
 * App 账号密码的哈希格式（W9-D，2026-10-30 / `docs/design/42-account-login-design.md`）。
 *
 * ── 为什么它**不能**复用 `pin-hash.ts`（哪怕算法一样）────────────────────────
 *   两者都是 scrypt，但**前缀不同**是刻意的：`scrypt$…` 只用于 `ChildMember.pinHash`，
 *   `scrypt-pw$…` 只用于 `User.passwordHash`。共用前缀会带来一条很具体的越权路径 ——
 *   把某个 4 位家长 PIN 的哈希抄进 `User.passwordHash`，然后就能用「PIN」当账号密码登录。
 *   前缀不一致 ⇒ `verifyPassword()` 直接判 false，这条路径在结构上不存在。
 *
 * ── 参数（与 PIN 相同，理由不同）─────────────────────────────────────────────
 *   PIN 低熵（4–6 位数字）⇒ 慢哈希只是抬高单次成本，真正的防线是锁定计数；
 *   密码是**人类口令**（熵高但远不到 256 bit）⇒ 慢哈希 + 每行独立盐是主要防线，
 *   所以盐必须随机、必须落进哈希串本身（`User.passwordHash` 只有一列，没有 salt 列）。
 *   N=16384 / r=8 / p=1 / keylen=32 是 Node 默认强度，单次约 40–80ms：
 *   登录是低频动作，这个代价买的是「库被读走后仍不能批量离线破解」。
 *
 * ── 格式自描述（与 `pin-hash.ts` 同一条纪律）──────────────────────────────────
 *       scrypt-pw$<N>$<r>$<p>$<keylen>$<salt b64url>$<hash b64url>
 *   将来调参数时旧哈希仍可验证；不自描述的哈希会让「PIN/密码不对」成为唯一症状，
 *   而病其实是参数漂移。
 *
 * ── 明文的生命周期（`40` §11.2）──────────────────────────────────────────────
 *   明文只在本文件的调用栈里存在。**绝不**写日志、绝不进审计快照、绝不出现在
 *   任何响应里 —— 请求体里的密码连 `ValidationPipe` 的错误信息都不该泄漏。
 */
export const PASSWORD_HASH_PREFIX = 'scrypt-pw'
export const PASSWORD_SCRYPT_N = 16_384
export const PASSWORD_SCRYPT_R = 8
export const PASSWORD_SCRYPT_P = 1
export const PASSWORD_KEY_LENGTH = 32

/** 密码明文长度边界（码点数）—— 与 DTO 的 `@MinLength` / `@MaxLength` 同一口径。 */
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 64

/**
 * 把明文密码转成可落库的自描述哈希。
 *
 * ★ 调用方必须做到：明文不落库、不写日志、不进审计（`passwordAuditValue()` 是
 *   唯一允许用于审计的写法，它只回答"设置了没有"）。
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(plain, salt, PASSWORD_KEY_LENGTH)
  return [
    PASSWORD_HASH_PREFIX,
    PASSWORD_SCRYPT_N,
    PASSWORD_SCRYPT_R,
    PASSWORD_SCRYPT_P,
    PASSWORD_KEY_LENGTH,
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join('$')
}

/**
 * 校验明文密码与库里的哈希是否匹配。
 *
 * ── 解析失败一律 `false`（不是抛错）──────────────────────────────────────────
 *   调用方是「校验」，不是「读取格式」。把损坏的哈希当成匹配等于直接开锁；
 *   当成异常又会让「库里有脏数据」表现为 500 —— 那会让人去查代码而不是查数据。
 *
 * ── `stored === null` 直接 `false`（**不做**假哈希）───────────────────────────
 *   「这个账号还没设密码」与「密码不对」在响应上必须**同形**（都是 401，
 *   且不区分账号是否存在）。时序上的补齐由 service 显式调用
 *   `burnPasswordHashCost()` 完成 —— 让「要不要防时序探测」这个决定留在调用方，
 *   而不是藏在这个纯函数里。
 *
 * `timingSafeEqual` 只消除**等长**比较的时序泄漏；长度不同直接 false 是安全的
 * （长度本身不是秘密：keylen 写在哈希串里，且它恒为 32）。
 */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (stored === null) return false

  const parts = stored.split('$')
  if (parts.length !== 7 || parts[0] !== PASSWORD_HASH_PREFIX) return false

  const [, rawN, rawR, rawP, rawKeyLength, rawSalt, rawHash] = parts
  const n = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  const keyLength = Number(rawKeyLength)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (!Number.isInteger(keyLength) || keyLength <= 0) return false

  const salt = Buffer.from(rawSalt, 'base64url')
  const expected = Buffer.from(rawHash, 'base64url')
  if (salt.length === 0 || expected.length !== keyLength) return false

  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(plain, salt, keyLength, { N: n, r, p }, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  }).catch(() => null)

  if (actual === null) return false
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * 空跑一次同等成本的 scrypt —— **只为对齐时序**。
 *
 * 用例：账号不存在（或还没设密码）时，服务端若立刻回 401，攻击者可以用响应时间
 * 区分「这个手机号注册过」与「没注册过」（前者要多花 ~50ms 校验哈希）。
 * 账号枚举在登录端点上通常被低估：手机号是**可枚举**的（号段有限）。
 *
 * ★ 它不校验任何东西，也不返回任何东西 —— 调用方拿到 `false` 后的唯一动作
 *   就是回同一个 401 `ACCOUNT_INVALID_CREDENTIALS`。
 */
export async function burnPasswordHashCost(): Promise<void> {
  await scryptAsync('kp-timing-equalizer', Buffer.alloc(16), PASSWORD_KEY_LENGTH).catch(() => {
    // 空跑失败不影响判定（调用方本来就要拒绝）—— 吞掉，避免把计时器变成故障源。
  })
}

/**
 * 审计 / 日志里描述「有没有密码」时**唯一**允许的写法。
 * 不返回长度、不返回前缀：密码长度本身就是信息。
 */
export function passwordAuditValue(passwordHash: string | null): boolean {
  return passwordHash !== null
}
