import { createHmac } from 'node:crypto'

/**
 * 同意留痕里的**个人信息最小化**（W7-A，2026-10-26）。
 *
 * ── 为什么留 IP / UA 的哈希，而不是原文 ─────────────────────────────────────
 *   `GuardianConsent`（`03` C10）要求「能证明是谁在什么时候同意的」，
 *   但 IP 与 User-Agent 都属于个人信息 —— 存原文等于为了自证合规又采集一份
 *   不必要的个人信息。HMAC-SHA256 只保留**可比对性**（同一来源两次操作可对照），
 *   不可反查具体地址。
 *
 * ── 为什么没有盐就**不存**（而不是退回明文 / 无盐哈希）────────────────────────
 *   IP 的取值空间很小（尤其 IPv4 前缀），无盐 SHA-256 用一张彩虹表就能反推 ——
 *   「哈希过了」会成为一句自我安慰。这里的选择是：
 *     · `CONSENT_PII_SALT` 已配置 ⇒ 存 HMAC 十六进制摘要；
 *     · 未配置 ⇒ 返回 null（这一列留空），**绝不**降级成裸哈希或原文。
 *   代价是「没配盐的环境里没有这层证据」，但那是**可见的缺失**（列为空），
 *   而不是一份看起来更完整、实际可反推的假证据。
 *
 * ⚠ 生产环境必须配置 `CONSENT_PII_SALT`（见 `docs/design/04` §5 的部署清单）。
 */
export const CONSENT_PII_SALT_ENV = 'CONSENT_PII_SALT'

/** 输入为空 / 无盐 ⇒ null；否则返回 64 位十六进制 HMAC 摘要。 */
export function hashPii(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const salt = env[CONSENT_PII_SALT_ENV]
  if (typeof salt !== 'string' || salt.trim() === '') return null

  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return null

  return createHmac('sha256', salt).update(trimmed).digest('hex')
}

/**
 * 取客户端 IP：优先 `x-forwarded-for` 的**第一跳**（最靠近客户端的那个）。
 *
 * ★ 这是**代理链**语义，不是"最可信"语义：只有在我们自己部署的入口
 *   （反代 / 网关）会覆写该头时它才有意义。直接暴露 Node 时该头可被伪造 ——
 *   所以它只用于「同来源可对照」，不做任何鉴权判断。
 */
export function clientIpOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const forwarded = headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof raw === 'string' && raw.trim() !== '') {
    const first = raw.split(',')[0]
    if (first !== undefined && first.trim() !== '') return first.trim()
  }
  return undefined
}
