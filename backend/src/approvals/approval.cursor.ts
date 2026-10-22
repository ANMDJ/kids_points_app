import { BadRequestException } from '@nestjs/common'

import { decodeKeysetCursor, encodeKeysetCursor } from '../common/keyset-cursor'

/**
 * `/approvals` 的键集游标（W5-D）。
 *
 * 格式与 `/records` **完全相同**（`base64url("<ISO>|<id>")`），编解码共用
 * `common/keyset-cursor.ts`；只有错误码不同 —— 客户端拿到 400 时要能分辨
 * 「记录页的游标坏了」还是「收件箱的游标坏了」（两条路径的「重新加载」范围不同）。
 *
 * ★ 同样不做签名：游标不是权限凭据，`childId` 始终来自会话。
 */
export interface ApprovalCursor {
  createdAt: Date
  id: string
}

export function encodeApprovalCursor(input: ApprovalCursor): string {
  return encodeKeysetCursor(input)
}

/** 非法游标 ⇒ 400 `INVALID_APPROVAL_CURSOR`（**绝不**静默退回第一页）。 */
export function decodeApprovalCursor(raw: string): ApprovalCursor {
  const position = decodeKeysetCursor(raw)
  if (position === null) {
    throw new BadRequestException({
      code: 'INVALID_APPROVAL_CURSOR',
      message:
        'cursor 不是本端点签发的游标。请把上一页响应里的 nextCursor 原样回传；' +
        '★ 不要自己拼日期 —— 精度或时区写法不同都会让游标失效。'
    })
  }
  return position
}
