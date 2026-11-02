/*
  W12（2026-11-02）：网站发放的注册邀请码 —— 新增两张表。

  docs/design/48-public-invite-acquisition.md §2。

  ── 为什么不是复用 `InviteCode` ─────────────────────────────────────────────
    `InviteCode."childId"` 是 NOT NULL 外键，语义是「加入某个已存在的家庭」。
    网站发码的申请人还没有家庭、也没有孩子档案；复用只能先造一个假孩子，
    而那正是 `42` §5.1 拒绝开放注册时点名的孤儿数据。
    本表只授权「创建一个账号」：注册成功后该账号零个孩子，走 `POST /children`
    的既有引导。两种凭据因此**互不通用**：拿本表的码去 `/invites/accept`
    查不到（那张表里没有），拿 `InviteCode` 的码去本表也查不到。

  ── 只加表，不动既有表 ⇒ 回滚 = DROP TABLE，零数据风险 ─────────────────────
    两张表都是新增；`User` 一行都没改（只加了 Prisma 关系，不产生列）。

  ── 额度表为什么主键是「业务日」字符串 ──────────────────────────────────────
    `YYYY-MM-DD` 由 `KP_TIMEZONE` 决定（默认 Asia/Shanghai），与「每日打卡上限」
    同一套口径。用 UTC 日会让北京时间 00:00–08:00 的请求算进昨天。
    计数靠**原子条件 UPDATE**（`issued < limit` 与自增同一条语句），
    不是「先 count 再 insert」—— 后者在并发下会多发。
*/

-- CreateTable
CREATE TABLE "RegistrationInvite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "issuedIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationInviteQuota" (
    "day" TEXT NOT NULL,
    "issued" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationInviteQuota_pkey" PRIMARY KEY ("day")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_code_key" ON "RegistrationInvite"("code");

-- CreateIndex
CREATE INDEX "RegistrationInvite_phone_createdAt_idx" ON "RegistrationInvite"("phone", "createdAt");

-- CreateIndex
CREATE INDEX "RegistrationInvite_email_createdAt_idx" ON "RegistrationInvite"("email", "createdAt");

-- CreateIndex
CREATE INDEX "RegistrationInvite_createdAt_idx" ON "RegistrationInvite"("createdAt");

-- AddForeignKey
ALTER TABLE "RegistrationInvite" ADD CONSTRAINT "RegistrationInvite_usedByUserId_fkey"
    FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
