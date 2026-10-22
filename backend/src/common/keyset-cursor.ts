/**
 * 键集（keyset）游标的**纯编解码**（W5-D 从 `read/read.cursor.ts` 抽出）。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────────────
 *   `/records` 与 `/approvals` 都用「上一页最后一行的 `(createdAt, id)`」翻页，
 *   但两者需要**不同的错误码**（`INVALID_RECORD_CURSOR` / `INVALID_APPROVAL_CURSOR`）。
 *   如果各自复制一份编解码，两条路径的严格性迟早漂移 —— 一条宽松解析就会让
 *   翻页**静默**错位（重复或漏行），而 HTTP 用例看到 200 仍然全绿。
 *   故把「格式」收在这里，「错误码 / 文案」留给调用方。
 *
 * 格式：`base64url("<ISO-8601>|<id>")`。客户端**原样回传**，不要自己拼。
 */
export interface KeysetPosition {
  createdAt: Date
  id: string
}

/** 游标长度上界：正常约 60 字符；给未来的 id 形态留余量，同时挡住超长垃圾串。 */
const MAX_CURSOR_LENGTH = 256

/** 由一行的 `(createdAt, id)` 生成游标。 */
export function encodeKeysetCursor(input: KeysetPosition): string {
  return Buffer.from(`${input.createdAt.toISOString()}|${input.id}`, 'utf8').toString(
    'base64url'
  )
}

/**
 * 解析客户端回传的游标；**非法返回 `null`**（不抛异常）。
 *
 * ★ 校验是**严格**的：base64 必须能往返、ISO 串必须与 `Date` 完全一致、
 *   id 不能为空。宽松解析（例如只 `new Date(iso)`）会把
 *   `2026-13-40` 这类串悄悄滚成别的日期，翻页于是从错误的位置开始。
 *   返回 `null` 而不是抛异常，是为了让调用方决定自己的错误码 —— 但**不许**
 *   在拿到 `null` 时静默退回第一页（那会让「加载更多」无限重复同一页）。
 */
export function decodeKeysetCursor(raw: string): KeysetPosition | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null

  const text = Buffer.from(raw, 'base64url').toString('utf8')
  // 往返比对：拒绝非规范 base64（Node 的 base64url 解码对多余字符很宽容）。
  if (Buffer.from(text, 'utf8').toString('base64url') !== raw) return null

  const separator = text.indexOf('|')
  if (separator <= 0) return null

  const iso = text.slice(0, separator)
  const id = text.slice(separator + 1)
  if (id.length === 0 || id.length > 128 || id.includes('|')) return null

  const createdAt = new Date(iso)
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null

  return { createdAt, id }
}
