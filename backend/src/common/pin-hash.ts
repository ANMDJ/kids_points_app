import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>

/**
 * 家长 PIN 的哈希格式（W8-A，2026-10-27 / `02` §7）。
 *
 * ── 为什么不是「存哈希就完了」────────────────────────────────────────────────
 *   `ChildMember` 只有一列 `pinHash`（没有独立的 salt 列）。若哈希格式不自描述，
 *   将来实现「切家长模式」的校验端点时，代码必须**假定**当初用的参数
 *   （N / r / p / keylen）与盐长度 —— 参数一旦调整，所有旧 PIN 会静默失效，
 *   而用户只会看到「PIN 不对」。
 *   因此写进库里的字符串自带全部参数：
 *
 *       scrypt$<N>$<r>$<p>$<keylen>$<salt b64url>$<hash b64url>
 *
 *   与 `consent/hash-pii.ts` 的 HMAC 不同：PIN 是**低熵口令**（4–6 位数字，
 *   至多 111 万种），必须加盐且慢哈希；HMAC 只用于 IP / UA 这类高熵输入的
 *   假名化，两者不能互换。
 *
 * ── 本轮的范围（W8-A → W8-C）────────────────────────────────────────────────
 *   ★ **校验端点已落地（W8-C，2026-10-27）**：`POST /auth/parent-mode` 用
 *   `verifyPin()` 校验 `ChildMember.pinHash`，连错计数与锁定在
 *   `auth/parent-mode.policy.ts`（5 次 ⇒ 锁 15 分钟）。
 *   于是本文件的 `verifyPin()` 不再"只有测试在用" —— 它是权限提升的唯一判据。
 *
 *   ⚠️ 仍然成立的边界：`pinFailedCount` / `pinLockedUntil` 落在**成员位**上
 *   （`06` §3 D3），所以"换台设备继续猜"也绕不过锁定；但这不是速率限制的完整解，
 *   真正的防线仍是 L2 之后的会话 token 与网关限流。
 *
 * ── 参数取值 ──────────────────────────────────────────────────────────────
 *   N=16384 / r=8 / p=1 / keylen=32 是 Node 默认强度（`scrypt` 默认 N=16384）。
 *   4–6 位数字的搜索空间很小，慢哈希只能提高单次尝试成本；真正的暴力破解防线
 *   是 `pinFailedCount` / `pinLockedUntil`（连错 5 次锁 15 分钟），
 *   那一半属于校验端点，本轮**未实现**（见上）。
 */
export const PIN_HASH_PREFIX = 'scrypt'
export const PIN_SCRYPT_N = 16_384
export const PIN_SCRYPT_R = 8
export const PIN_SCRYPT_P = 1
export const PIN_KEY_LENGTH = 32

/**
 * 把明文 PIN 转成可落库的自描述哈希。
 *
 * ★ 明文只在本函数的调用栈里存在；**绝不**写日志、绝不进审计快照。
 *   `onboarding.prisma.repository.ts` 的审计 after 只有 `pinSet: true`。
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(pin, salt, PIN_KEY_LENGTH)
  return [
    PIN_HASH_PREFIX,
    PIN_SCRYPT_N,
    PIN_SCRYPT_R,
    PIN_SCRYPT_P,
    PIN_KEY_LENGTH,
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join('$')
}

/**
 * 校验 PIN 与库里的哈希是否匹配（**当前只有测试调用**）。
 *
 * 解析失败一律返回 `false` —— 调用方是「校验」，不是「读取格式」；
 * 把损坏的哈希当成匹配会直接绕开 PIN。`timingSafeEqual` 避免长度以外的时序泄漏。
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 7 || parts[0] !== PIN_HASH_PREFIX) return false

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

  // 只接受本仓库当前写出的参数：将来换参数时，旧哈希仍能被 `verifyPin` 验证，
  // 但**新写入**统一走 `hashPin()`。这里不做参数上限校验（存的是自己写的数据）。
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(pin, salt, keyLength, { N: n, r, p }, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  }).catch(() => null)

  if (actual === null) return false
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * 审计 / 日志里描述 PIN 状态时**唯一**允许的写法。
 * 不返回长度、不返回前缀 —— 4 位 PIN 的长度本身就是信息。
 */
export function pinAuditValue(pinHash: string | null): boolean {
  return pinHash !== null
}
