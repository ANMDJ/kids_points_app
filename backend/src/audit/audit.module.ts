import { Module } from '@nestjs/common'

/**
 * 变更审计（docs/design/03 C11）
 *
 * 缺陷背景：全部代码库中**没有任何变更审计机制** ——
 * 谁在什么时候把「每天最多 2 次」改成「每天最多 1 次」完全无法追溯。
 *
 * 设计：
 * - `AuditLog` 是**追加式**表，`before`/`after` 存 JSON 快照
 * - 白名单模型：规则 / 心愿 / 习惯 / 成员 / 同意
 * - 与业务写入**同一事务**（否则会出现「改了但没记」或「记了但没改」）
 * - DB 层 `REVOKE UPDATE, DELETE` —— 见 prisma/sql/900_ledger_revoke.sql
 *
 * ⚠ W0 状态：**签名占位**。
 */
@Module({})
export class AuditModule {}
