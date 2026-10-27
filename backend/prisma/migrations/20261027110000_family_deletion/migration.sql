/*
  W7-D（2026-10-27）：家庭数据删除 —— 2 个动作 + 1 张请求表。

  · `view_family_deletion` / `manage_family_deletion`：guardian ALLOW / child DENY。
    两者都在 `contracts/consent-policy.ts` 的**豁免**集合里 —— 撤回同意后
    仍必须能行使删除权（否则「撤回」就等于「数据被扣住」）。
  · `FamilyDeletionRequest`：记录「一次决定」。冷却期内可撤销；到期由 worker
    执行就地匿名化（不是物理删除 —— 账本 append-only，02 §5.7 I5）。

  ★ 冷却期是**落库的 `scheduledFor`**，不是进程内定时器：7 天的承诺必须跨重启成立。

  ⚠ `ALTER TYPE … ADD VALUE` 不能与“使用该新值”的 DML 放在同一事务里。
    本迁移只做添加；真正写入该值的代码在应用层（与 W7-A / W7-C 同一处理）。
    IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'view_family_deletion';
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'manage_family_deletion';

-- CreateEnum
CREATE TYPE "FamilyDeletionStatus" AS ENUM ('pending', 'cancelled', 'executed');

-- CreateTable
CREATE TABLE "FamilyDeletionRequest" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "FamilyDeletionStatus" NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FamilyDeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FamilyDeletionRequest_childId_status_idx" ON "FamilyDeletionRequest"("childId", "status");

-- CreateIndex
CREATE INDEX "FamilyDeletionRequest_status_scheduledFor_idx" ON "FamilyDeletionRequest"("status", "scheduledFor");

-- 一个孩子同时只能有一个待执行的删除请求。
-- ★ 这条唯一性**必须由数据库**兜住：两位家长同时点「申请删除」时，
--   应用层的「先查再插」会双双查不到 pending，然后插出两条 —— 两条冷却期
--   意味着两次执行，第二次是在已经匿名化的数据上再跑一遍。
CREATE UNIQUE INDEX "FamilyDeletionRequest_one_pending_per_child"
  ON "FamilyDeletionRequest"("childId")
  WHERE "status" = 'pending';

-- AddForeignKey
ALTER TABLE "FamilyDeletionRequest"
  ADD CONSTRAINT "FamilyDeletionRequest_childId_fkey"
  FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FamilyDeletionRequest"
  ADD CONSTRAINT "FamilyDeletionRequest_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
