/*
  W9-A（2026-10-29）：登录 / 认证会话 —— 新增 `AuthSession` 表。

  docs/design/40-login-and-session-design.md §5 / §12.1（M1）。

  ── 为什么是**新表**而不是给 `DeviceSession` 加列 ────────────────────────────
    `DeviceSession` 的唯一键是 `(deviceId, childId)`，而登录发生在"选哪个孩子"
    **之前** ⇒ 硬塞就得把 childId 变可空、拆唯一约束，并让 membership / auth /
    session.gate 全线处理"没有孩子的行"。而且它的 `expiresAt` 已经承载了
    "家长模式 5 分钟窗口"（02 §7）—— 再加一个"身份到期"就是回到补丁状态。
    新表 `@@index([userId, revokedAt])` 与 `@@index([expiresAt])` 覆盖两条读路径：
      · 守卫：`tokenHash`（唯一键）→ 一次索引等值查询；
      · 将来"列出我的登录设备 / 清理到期行"：按 userId / expiresAt 扫。

  ── ★ 只加表，不动任何既有表 ⇒ 回滚 = `DROP TABLE "AuthSession"`，零数据风险 ──
    这也是本迁移敢直接上手写 SQL 的原因（没有"改既有列"那种必须 `ON_ERROR_STOP=1`
    自检的场景）。

  ── 凭据形态（不落明文）─────────────────────────────────────────────────────
    `tokenHash` 存 `sha256(token)` 的 64 位十六进制；明文形如
    `kps_<base64url(32B)>`，只在登录响应里出现一次。**没有** `token` 列 ——
    这不是遗漏：可反查的凭据列会让"库被读走"直接等于"所有会话被接管"。
*/

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "deviceId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
