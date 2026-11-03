/*
  W14（2026-11-03）：`DeviceSession` 增加「孩子模式」的到期绝对时刻。

  · `kidModeUntil` —— 家长把手机交给孩子时开出的降级窗口（1–30 分钟）。
    有值即把 `effectiveRole()` 钉在 `child`，**包括已经到点的情况**：到期不
    自动回家长模式，要家长输 PIN 收回（否则孩子等到点就能批自己的心愿）。

  为什么**不复用** `expiresAt`：
    那一列已经背了两个语义（邀请/登录 30 天、PIN 换来的 5 分钟），
    `parentModeSourceOf()` 只能靠"剩余时间有多远"猜来源。再加第三种，
    客户端就分不清"家长权限到期"与"孩子时间用完"——而两者的下一步动作相反。

  存量行：全部为 NULL = 没开孩子模式（行为与迁移前完全一致）。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

ALTER TABLE "DeviceSession" ADD COLUMN IF NOT EXISTS "kidModeUntil" TIMESTAMP(3);
