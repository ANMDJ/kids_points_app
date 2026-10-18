import { BadRequestException } from '@nestjs/common'

/**
 * `/records` 的**键集游标**（W4-B，2026-10-19）。
 *
 * ── 为什么 W4-A 的 `hasMore` 一个人不够 ─────────────────────────────────────
 *   W4-A 的响应里有 `hasMore`，查询参数里却只有 `limit` —— 客户端知道“还有
 *   下一页”，却没有任何办法把下一页取回来。要么永远只显示最近 50 条，要么把
 *   `limit` 拉到 200 封顶后假装读完了。两种都是本仓库反复禁止的“把失败装成正常”。
 *
 * ── 为什么是键集（keyset）而不是 offset ─────────────────────────────────────
 *   账本是**只增**的：翻页期间新记一笔，`OFFSET 50` 会把上一页的最后一条再发一次
 *   （或漏掉一条）。游标钉在「上一页最后一行的 `(createdAt, id)`」上，
 *   新行只会出现在第一页之前，不影响后续页。
 *   排序在适配器里固定为 `(createdAt desc, id desc)`；`id` 是同一毫秒内的稳定次序。
 *
 * ── 为什么游标不落库、不做签名 ───────────────────────────────────────────────
 *   它**不是权限凭据**：能改游标的人最多把读取窗口挪到别的时间点，而 `childId`
 *   始终来自会话（三道屏障之后），跨孩子读取不可能靠改游标实现。
 *   不做签名 → 无状态、可离线单测；格式错 ⇒ 400，绝不静默退回第一页
 *   （那会让“加载更多”无限重复同一页）。
 *
 * 格式：`base64url("<ISO-8601>|<recordId>")`。客户端**原样回传** `nextCursor`，
 * 不要自己拼 —— 日期精度 / 时区写法一旦不同，游标就失效。
 */
export interface RecordCursor {
  createdAt: Date
  id: string
}

/** 游标长度上界：正常约 60 字符；给未来的 id 形态留余量，同时挡住超长垃圾串。 */
const MAX_CURSOR_LENGTH = 256

/** 由一行的 `(createdAt, id)` 生成游标。 */
export function encodeRecordCursor(input: RecordCursor): string {
  return Buffer.from(`${input.createdAt.toISOString()}|${input.id}`, 'utf8').toString(
    'base64url'
  )
}

/**
 * 解析客户端回传的游标。
 *
 * ★ 校验是**严格**的：base64 必须能往返、ISO 串必须与 `Date` 完全一致、
 *   id 不能为空。宽松解析（例如只 `new Date(iso)`）会把
 *   `2026-13-40` 这类串悄悄滚成别的日期，翻页于是从错误的位置开始。
 */
export function decodeRecordCursor(raw: string): RecordCursor {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor()
  }

  const text = Buffer.from(raw, 'base64url').toString('utf8')
  // 往返比对：拒绝非规范 base64（Node 的 base64url 解码对多余字符很宽容）。
  if (Buffer.from(text, 'utf8').toString('base64url') !== raw) {
    throw invalidCursor()
  }

  const separator = text.indexOf('|')
  if (separator <= 0) throw invalidCursor()

  const iso = text.slice(0, separator)
  const id = text.slice(separator + 1)
  if (id.length === 0 || id.length > 128 || id.includes('|')) {
    throw invalidCursor()
  }

  const createdAt = new Date(iso)
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) {
    throw invalidCursor()
  }

  return { createdAt, id }
}

/** 400 `INVALID_RECORD_CURSOR` —— 与 `limit` 越界同一层（入参形状问题，不是权限问题）。 */
function invalidCursor(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_RECORD_CURSOR',
    message:
      'cursor 不是本端点签发的游标。请把上一页响应里的 nextCursor 原样回传；' +
      '★ 不要自己拼日期 —— 精度或时区写法不同都会让游标失效。'
  })
}
