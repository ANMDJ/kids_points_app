/*
  W7-A（2026-10-26）：权限矩阵新增 2 个动作。

  · `view_consent`   —— `GET /consent`（家长看这个孩子当前的同意状态/版本）
  · `manage_consent` —— `POST /consent`（授予）与 `POST /consent/withdraw`（撤回）

  为什么不能复用 `apply_onboarding`：那个动作保护的是「写好引导结果」
  （ageBand / focusAreas / onboardedAt + 采纳的规则），而同意是一条**独立的事实**
  （谁、在什么版本、什么时候授予/撤回）。合并会让「允许完成引导」顺带等于
  「允许代表监护人作出同意」—— 合规事实不能挂在业务动作上。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且不能与“使用该新值”的 DML 放在同一事务里。
  本迁移只做添加；真正写入该值的代码在应用层。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'view_consent';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'manage_consent';
