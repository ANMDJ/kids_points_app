/*
  W5-H（2026-10-22）：权限矩阵新增 2 个动作。

  · `view_members`        —— `GET /members`（家长 / 孩子都能看"家里有谁"）
  · `change_member_role`  —— `PATCH /members/:id`（仅家长）

  `remove_member` 早在 W0 就已登记（`DELETE /members/:id` 用它），这里不重复添加。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且**不能**与"使用该新值"的 DML 放在同一事务里。
  本迁移只做添加；真正写入这些值的代码在应用层（迁移事务提交后才可能执行）。
  IF NOT EXISTS 让本迁移可以安全地重复应用（例如手工补跑）。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'view_members';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'change_member_role';
