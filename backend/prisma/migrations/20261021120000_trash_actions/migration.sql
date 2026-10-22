/*
  W5-F（2026-10-21）：权限矩阵新增 4 个动作。

  · `delete_habit`        —— `DELETE /habits/:id`（软删，进回收站）
  · `view_trash`          —— `GET /trash`
  · `restore_trash_item`  —— `POST /trash/:kind/:id/restore`
  · `purge_trash_item`    —— `DELETE /trash/:kind/:id`

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且**不能**与"使用该新值"的 DML 放在同一事务里。
  本迁移只做添加；真正写入这些值的代码在应用层（迁移事务提交后才可能执行）。
  IF NOT EXISTS 让本迁移可以安全地重复应用（例如手工补跑）。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'delete_habit';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'view_trash';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'restore_trash_item';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'purge_trash_item';
