/*
  W6-B（2026-10-24）：推送失败重试队列 `PushRetryJob`。

  ── 为什么需要这张表 ──────────────────────────────────────────────────────
  W6-A 的 `POST /device-tokens` 解决了「token 从哪来」，但一次推送失败之后
  **什么都没留下**：网关抖一下、用户刚换手机还没登录，那一条「审批通过了」
  就永久消失了。本表把「试过了、没送达」变成一行可重试的事实。

  ── 三个结构性约定（不是实现细节，是这张表的意义）────────────────────────
  ① `dedupeKey` 唯一：同一事实（同一审批的同一次状态变化 / 同一位家长）
     只会入队一次。重放、并发、worker 重试都不会产生第二条；
  ② 没有 User / Child 外键：投递事实必须在用户被移出、孩子被删之后仍然存在
     —— `onDelete: Cascade` 会在删除孩子时顺手抹掉故障记录；
  ③ `expiresAt` 必填：没有它，一条「一直没有设备」的推送会永久占着队列，
     把「未送达」变成一个永不结束的中间态。

  ⚠ 权限：应用角色 `kids_points_app` 的 CRUD 由 `prisma/sql/900_ledger_revoke.sql`
  的 `ALTER DEFAULT PRIVILEGES` 自动覆盖本表（与 `Notification` / `DeviceToken` 同一手法）；
  本表**不**属于账本表，故不需要额外的 REVOKE。
*/

-- CreateEnum
CREATE TYPE "PushRetryStatus" AS ENUM ('pending', 'sending', 'sent', 'dead', 'expired');

-- CreateTable
CREATE TABLE "PushRetryJob" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "status" "PushRetryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushRetryJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushRetryJob_dedupeKey_key" ON "PushRetryJob"("dedupeKey");

-- CreateIndex
CREATE INDEX "PushRetryJob_status_nextAttemptAt_idx" ON "PushRetryJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PushRetryJob_recipientUserId_createdAt_idx" ON "PushRetryJob"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "PushRetryJob_expiresAt_idx" ON "PushRetryJob"("expiresAt");
