/*
  W5-J（2026-10-23）：权限矩阵新增 1 个动作。

  · `view_own_approvals` —— `GET /approvals/mine`（申请人查看**自己提交的**申请）

  为什么不能复用 `review_approvals`：那个端点是家长收件箱（“待我批准”），
  矩阵里 child = DENY；孩子查自己的申请是另一个语义，收口条件也不同
  （`requesterUserId = 本人`，而不是 `childId` 全量）。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且不能与“使用该新值”的 DML 放在同一事务里。
  本迁移只做添加；真正写入该值的代码在应用层。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'view_own_approvals';
