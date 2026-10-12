-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('guardian', 'child', 'viewer');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('active', 'removed');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'withdrawn', 'invalidated', 'expired');

-- CreateEnum
CREATE TYPE "AutoReason" AS ENUM ('WISH_DELETED', 'RULE_DELETED', 'HABIT_GONE', 'INSUFFICIENT_POINTS', 'MEMBER_REMOVED');

-- CreateEnum
CREATE TYPE "RuleDirection" AS ENUM ('reward', 'penalty');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('active', 'deleted');

-- CreateEnum
CREATE TYPE "RecordCategory" AS ENUM ('praise', 'exchange', 'adjust');

-- CreateEnum
CREATE TYPE "RecordSource" AS ENUM ('child_self', 'guardian', 'agent', 'approval', 'system', 'correction');

-- CreateEnum
CREATE TYPE "AgeBand" AS ENUM ('preschool', 'primary_low', 'primary_high', 'junior_high');

-- CreateEnum
CREATE TYPE "WishCoverStyle" AS ENUM ('A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('granted', 'withdrawn');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('weapp', 'ios', 'android');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('view_child_points', 'view_records', 'view_rules', 'view_wishes', 'check_in_habit', 'undo_check_in', 'add_rule', 'update_rule', 'delete_rule', 'add_habit_from_rule', 'add_wish', 'request_redeem', 'delete_wish', 'adjust_points', 'request_points_bonus', 'redeem', 'request_approval', 'review_approvals', 'withdraw_request', 'invite_member', 'remove_member', 'switch_role_mode', 'edit_child_profile', 'apply_onboarding', 'reset_demo_data');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "openId" TEXT,
    "displayName" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserChildRelation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserChildRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Child" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "ageBand" "AgeBand",
    "focusAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "onboardedAt" TIMESTAMP(3),
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Child_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChildMember" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'active',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT,
    "pinHash" TEXT,
    "pinSetAt" TIMESTAMP(3),
    "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMP(3),
    "restrictions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChildMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeRole" "MemberRole" NOT NULL DEFAULT 'child',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "childId" TEXT,
    "platform" "DevicePlatform" NOT NULL,
    "token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointRule" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "dailyLimit" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "direction" "RuleDirection" NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointRuleVersion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "dailyLimit" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "direction" "RuleDirection" NOT NULL,
    "changedByUserId" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeNote" TEXT,

    CONSTRAINT "PointRuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointRecord" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleVersion" INTEGER,
    "habitId" TEXT,
    "wishId" TEXT,
    "titleSnapshot" TEXT NOT NULL,
    "conditionSnapshot" TEXT,
    "dailyLimitSnapshot" INTEGER,
    "costSnapshot" INTEGER,
    "pointsDelta" INTEGER NOT NULL,
    "category" "RecordCategory" NOT NULL,
    "source" "RecordSource" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "operatorUserId" TEXT,
    "operatorRole" "MemberRole",
    "balanceAfter" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "reversesRecordId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Habit" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "sourceRuleId" TEXT,
    "title" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "condition" TEXT NOT NULL,
    "dailyLimit" INTEGER NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Habit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wish" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "emoji" TEXT NOT NULL,
    "coverStyle" "WishCoverStyle" NOT NULL DEFAULT 'A',
    "redeemed" BOOLEAN NOT NULL DEFAULT false,
    "redeemedAt" TIMESTAMP(3),
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wish_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "requesterRole" "MemberRole" NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "autoReason" "AutoReason",
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "maxUses" INTEGER NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "usedByUserId" TEXT,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuardianConsent" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'granted',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardianConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "childId" TEXT,
    "actorUserId" TEXT,
    "actorRole" "MemberRole",
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "deviceId" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "recipientRole" "MemberRole",
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "userId" TEXT,
    "actionType" "ActionType" NOT NULL,
    "requestHash" TEXT,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "recordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleTemplate" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "dailyLimit" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "direction" "RuleDirection" NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "ageBand" "AgeBand" NOT NULL,
    "focusAreas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "sortWeight" INTEGER NOT NULL DEFAULT 0,
    "status" "RecordStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_openId_key" ON "User"("openId");

-- CreateIndex
CREATE INDEX "UserChildRelation_childId_idx" ON "UserChildRelation"("childId");

-- CreateIndex
CREATE UNIQUE INDEX "UserChildRelation_userId_childId_key" ON "UserChildRelation"("userId", "childId");

-- CreateIndex
CREATE INDEX "Child_status_idx" ON "Child"("status");

-- CreateIndex
CREATE INDEX "ChildMember_userId_status_idx" ON "ChildMember"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChildMember_childId_userId_key" ON "ChildMember"("childId", "userId");

-- CreateIndex
CREATE INDEX "DeviceSession_expiresAt_idx" ON "DeviceSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_deviceId_childId_key" ON "DeviceSession"("deviceId", "childId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");

-- CreateIndex
CREATE INDEX "DeviceToken_userId_active_idx" ON "DeviceToken"("userId", "active");

-- CreateIndex
CREATE INDEX "PointRule_childId_status_idx" ON "PointRule"("childId", "status");

-- CreateIndex
CREATE INDEX "PointRule_childId_deletedAt_idx" ON "PointRule"("childId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointRuleVersion_ruleId_version_key" ON "PointRuleVersion"("ruleId", "version");

-- CreateIndex
CREATE INDEX "PointRecord_childId_createdAt_idx" ON "PointRecord"("childId", "createdAt");

-- CreateIndex
CREATE INDEX "PointRecord_childId_source_createdAt_idx" ON "PointRecord"("childId", "source", "createdAt");

-- CreateIndex
CREATE INDEX "PointRecord_ruleId_ruleVersion_idx" ON "PointRecord"("ruleId", "ruleVersion");

-- CreateIndex
CREATE UNIQUE INDEX "PointRecord_childId_idempotencyKey_key" ON "PointRecord"("childId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Habit_childId_status_idx" ON "Habit"("childId", "status");

-- CreateIndex
CREATE INDEX "Wish_childId_status_idx" ON "Wish"("childId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_executedRecordId_key" ON "ApprovalRequest"("executedRecordId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_childId_status_createdAt_idx" ON "ApprovalRequest"("childId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_expiresAt_idx" ON "ApprovalRequest"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");

-- CreateIndex
CREATE INDEX "InviteCode_childId_revoked_idx" ON "InviteCode"("childId", "revoked");

-- CreateIndex
CREATE INDEX "InviteCode_code_revoked_expiresAt_idx" ON "InviteCode"("code", "revoked", "expiresAt");

-- CreateIndex
CREATE INDEX "GuardianConsent_childId_status_idx" ON "GuardianConsent"("childId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_childId_createdAt_idx" ON "AuditLog"("childId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_readAt_idx" ON "Notification"("recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_childId_createdAt_idx" ON "Notification"("childId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_childId_key_key" ON "IdempotencyRecord"("childId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "RuleTemplate_slug_key" ON "RuleTemplate"("slug");

-- CreateIndex
CREATE INDEX "RuleTemplate_status_ageBand_sortWeight_idx" ON "RuleTemplate"("status", "ageBand", "sortWeight");

-- AddForeignKey
ALTER TABLE "UserChildRelation" ADD CONSTRAINT "UserChildRelation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserChildRelation" ADD CONSTRAINT "UserChildRelation_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildMember" ADD CONSTRAINT "ChildMember_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChildMember" ADD CONSTRAINT "ChildMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSession" ADD CONSTRAINT "DeviceSession_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSession" ADD CONSTRAINT "DeviceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceToken" ADD CONSTRAINT "DeviceToken_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRule" ADD CONSTRAINT "PointRule_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRuleVersion" ADD CONSTRAINT "PointRuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "PointRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRuleVersion" ADD CONSTRAINT "PointRuleVersion_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRecord" ADD CONSTRAINT "PointRecord_ruleId_ruleVersion_fkey" FOREIGN KEY ("ruleId", "ruleVersion") REFERENCES "PointRuleVersion"("ruleId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRecord" ADD CONSTRAINT "PointRecord_reversesRecordId_fkey" FOREIGN KEY ("reversesRecordId") REFERENCES "PointRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRecord" ADD CONSTRAINT "PointRecord_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRecord" ADD CONSTRAINT "PointRecord_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "Habit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRecord" ADD CONSTRAINT "PointRecord_wishId_fkey" FOREIGN KEY ("wishId") REFERENCES "Wish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointRecord" ADD CONSTRAINT "PointRecord_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Habit" ADD CONSTRAINT "Habit_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Habit" ADD CONSTRAINT "Habit_sourceRuleId_fkey" FOREIGN KEY ("sourceRuleId") REFERENCES "PointRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wish" ADD CONSTRAINT "Wish_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requesterUserId_fkey" FOREIGN KEY ("requesterUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_executedRecordId_fkey" FOREIGN KEY ("executedRecordId") REFERENCES "PointRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianConsent" ADD CONSTRAINT "GuardianConsent_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuardianConsent" ADD CONSTRAINT "GuardianConsent_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Child"("id") ON DELETE CASCADE ON UPDATE CASCADE;
