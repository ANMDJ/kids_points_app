/*
  W9-D（2026-10-30）：App 账号登录 —— `User` 增加手机号 / 邮箱 / 密码。

  docs/design/42-account-login-design.md §4。

  ── 为什么加在 `User` 上，而不是新建一张 `Account` 表 ────────────────────────
    本仓库的「家庭」= 一个 `Child`，权限入口是 `ChildMember`，两者都挂在
    `User.id` 上。把登录标识拆到独立表会引入第三个"我到底是谁"的答案，
    并让 `POST /children` / 成员位 / 审计全部要处理"一个 User 多个 Account"。
    而首版每个自然人只需要**一组**登录标识 ⇒ 并列三列足够。

  ── ★ 只加**可空**列 + 唯一索引 ⇒ 回滚 = DROP COLUMN，零数据风险 ──────────────
    `openId` 已经是可空的，说明「只用微信、从不绑手机」是本就支持的状态；
    新增列沿用同一条口径，既有行不受影响（迁移不写任何 UPDATE）。

  ── 唯一索引与 NULL ──────────────────────────────────────────────────────────
    PostgreSQL 的唯一索引不约束 NULL（多个 NULL 互不冲突），所以
    「一万个只用微信的 User，phone 全为 NULL」不会撞键。
    ★ 但这也意味着唯一性是**应用层+索引**共同保证的：先规范化再写入
      （`identity/account-identifier.ts`），否则 `138 0013 8000` 与
      `13800138000` 会成为两行 —— 索引拦不住"写法不同"。

  ── 为什么没有 `passwordSalt` 列 ─────────────────────────────────────────────
    盐写在 `passwordHash` 字符串本身（`scrypt-pw$N$r$p$keylen$salt$hash`）。
    独立 salt 列会在"旋转参数 / 迁移算法"时多一份必须同步的状态。
*/

-- AlterTable
ALTER TABLE "User"
    ADD COLUMN "phone" TEXT,
    ADD COLUMN "email" TEXT,
    ADD COLUMN "passwordHash" TEXT,
    ADD COLUMN "passwordSetAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
