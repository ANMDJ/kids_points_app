/*
  W6-A（2026-10-24）：权限矩阵新增 1 个动作。

  · `manage_device_tokens` —— `POST /device-tokens`（上报自己的推送 token）
    与 `POST /device-tokens/revoke`（注销）。

  为什么不能复用 `read_notifications`：那个动作只改 `Notification.readAt` 一列，
  而这里是往 `DeviceToken` 写一行（另一张表、另一类事实）。合并会让「允许标已读」
  顺带等于「允许把你的设备绑到我的账号上」——权限只能按**它真正保护的那件事**命名。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且不能与“使用该新值”的 DML 放在同一事务里。
  本迁移只做添加；真正写入该值的代码在应用层。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'manage_device_tokens';
