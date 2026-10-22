/**
 * 邀请码的**形状**、**规范化**与**撞码重试** —— 纯函数层（W5-G，2026-10-22）
 *
 * ── 为什么这些必须是纯函数 ──────────────────────────────────────────────────
 *   「几位、用哪些字符、大小写怎么处理」如果一半在 DTO、一半在 SQL、一半在
 *   客户端键盘上，三份手抄必然漂移（D9 的老病）。这里只有一份：
 *     · 生成（服务端唯一入口）→ `generateInviteCode()`
 *     · 用户输入（`ab-cd efgh` / 小写 / 带空格）→ `normalizeInviteCode()`
 *     · 合法形状 → `isWellFormedInviteCode()`
 *
 * ── 字母表为什么是 31 个字符 ────────────────────────────────────────────────
 *   去掉了 `0/O`、`1/I/L` —— 邀请码是**要人口头念、手动抄**的东西
 *   （爷爷奶奶在电话里读，家长在小程序里输）。`0` 与 `O`、`1` 与 `I/L`
 *   在等宽与非等宽字体里都会认错，而认错的代价是「码无效」，用户完全无法自查。
 *   31^8 ≈ 8.5×10^11，配合唯一约束 + 撞码重试（见 `withFreshInviteCode`），
 *   碰撞概率可以忽略。
 *
 * ── 邀请码是**凭据** ────────────────────────────────────────────────────────
 *   持有即可加入。因此：生成必须用**密码学随机**（`node:crypto.randomInt`，
 *   不能用 `Math.random` —— 它是可预测的 PRNG，被预测等于被抢注），
 *   且审计日志里**不写码本身**（`AuditLog` 的读取面比邀请码列表宽）。
 */
import { randomInt } from 'node:crypto'

/** 码长（不含展示用的连字符）。 */
export const INVITE_CODE_LENGTH = 8

/** 31 个易辨认字符：去掉 `0 O 1 I L`。与 `isWellFormedInviteCode()` 共用同一份。 */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** 一个邀请码最多能被用几次 —— 上限是产品口径（一次最多邀请 10 个人）。 */
export const MAX_INVITE_USES = 10

/** 邀请码有效期上限（天）。上限存在的理由：邀请码是凭据，不该无限期有效。 */
export const MAX_INVITE_TTL_DAYS = 30

/**
 * 加入成功后签发的**设备会话** TTL（毫秒）。
 *
 * ⚠️ **已知偏差，不许读成"已经按 02 §7 做了"**：§7 写的是 guardian 会话
 *   TTL **5 分钟**、每次 guardian 操作刷新、到期回落 `child`。那套口径的
 *   前提是 **PIN 校验切换角色**（§7 的写路径，至今**没有端点**）。
 *   若这里也发 5 分钟，一位刚用邀请码加入的共同监护人会在 5 分钟后
 *   悄悄掉回 `child` —— 而他没有任何办法（没有 PIN 端点）把角色提回去，
 *   表现为「家长按钮突然全变 403」。所以本轮按**设备登录**口径发 30 天，
 *   并在回包里如实返回 `sessionExpiresAt`（不隐瞒期限）。
 *   PIN 落地后这里**必须**改成 5 分钟 + 每次 guardian 操作刷新。
 */
export const INVITE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 撞码重试次数。5 次连续撞码的概率约 (1/31^8)^5 ≈ 0；用尽即响亮失败。 */
export const INVITE_CODE_ATTEMPTS = 5

/**
 * 生成一个邀请码。
 *
 * `pick` 可注入（默认 `randomInt`）—— 用例要能**确定性地**造出同一个码，
 * 才能证明「撞码会重试」而不是「碰巧没撞上」。
 */
export function generateInviteCode(
  pick: (max: number) => number = randomInt
): string {
  let code = ''
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += INVITE_CODE_ALPHABET[pick(INVITE_CODE_ALPHABET.length)]
  }
  return code
}

/**
 * 规范化用户输入：去空白与连字符、转大写。
 *
 * 只做**无歧义**的转换（大小写、分隔符）—— 不做「O→0」「l→1」这类猜测：
 * 字母表里本来就没有它们，猜错了只会把「输错了」变成「码无效但看起来对」。
 */
export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

/** 形状是否合法（已规范化）。非法形状 ⇒ 400（客户端 bug），不是 409（码不可用）。 */
export function isWellFormedInviteCode(code: string): boolean {
  if (code.length !== INVITE_CODE_LENGTH) return false
  for (const char of code) {
    if (!INVITE_CODE_ALPHABET.includes(char)) return false
  }
  return true
}

/** 展示用：`ABCD-EFGH`。只用于界面/文案，**绝不**用于判断（判断只认裸码）。 */
export function formatInviteCode(code: string): string {
  if (code.length !== INVITE_CODE_LENGTH) return code
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * 撞码重试：换一个新码再试，直到成功 / 非撞码错误 / 次数用尽。
 *
 * ── 为什么重试必须围着**唯一约束**转，而不是先查一次 ──────────────────────
 *   「先 `findUnique(code)` 确认没人用，再 `create`」仍是 TOCTOU：两个请求
 *   同时查都查不到，然后一个成功一个 500。唯一约束是**唯一**能回答
 *   「这个码归谁」的地方，所以正常路径直接写，撞了再换 —— 判据只有库一处。
 */
export async function withFreshInviteCode<T>(
  generate: () => string,
  attempt: (code: string) => Promise<T>,
  isCollision: (error: unknown) => boolean,
  attempts: number = INVITE_CODE_ATTEMPTS
): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    const code = generate()
    try {
      return await attempt(code)
    } catch (error) {
      if (!isCollision(error)) throw error
      lastError = error
    }
  }
  throw lastError
}
