/*
  W5-L（2026-10-23）：权限矩阵新增 2 个动作（站内通知中心）。

  · `view_notifications` —— `GET /notifications`（读**发给我的**通知）
  · `read_notifications` —— `PATCH /notifications/:id/read`（标记一条已读）

  为什么不能复用 `view_own_approvals`：那个的收口键是 `requesterUserId`
  （我提过什么），通知的收口键是 `recipientUserId`（发给我的），并且包含
  非审批类消息。合成一个动作会让「能看自己的申请」隐含「能看通知表」，
  而两者的 where 完全不同 —— 漏写一次就变成读全家的通知。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且不能与“使用该新值”的 DML 放在同一事务里。
  本迁移只做添加；真正写入该值的代码在应用层。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'view_notifications';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'read_notifications';
