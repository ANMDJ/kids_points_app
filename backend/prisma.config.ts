/**
 * prisma.config.ts —— Prisma CLI 配置（**Prisma 7 起必需**）
 *
 * 为什么需要这个文件：Prisma 7 起，`url` **不再允许**写在 schema.prisma 的
 * datasource 块里（P1012）。连接串必须移到这里，客户端侧则改用 driver adapter
 * （见 src/prisma/prisma.service.ts）。
 *
 * 来源：https://pris.ly/d/config-datasource
 *
 * ⚠ 与 01 §1「Prisma 7.10.0」的差异：文档只写了版本号，未预见该破坏性变更。
 *   这是 W0 才开始暴露的问题 —— 见 docs/design/06-w0-report.md §2。
 */

import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // 模板种子：以当前设计内容为模板开发（P2 决策：不追求 90 条）
    seed: 'tsx prisma/seed/rule-templates.ts'
  },
  datasource: {
    // ★ 两条连接串的分工（决策 D7；06-w0-report.md §3、§6）：
    //   MIGRATION_DATABASE_URL —— 表**所有者**：CLI 迁移 / 建表 / REVOKE 都要 DDL 权限
    //   DATABASE_URL           —— **应用角色** kids_points_app：仅 CRUD，账本表禁改（I5）
    // 迁移必须走所有者，否则 `migrate dev` 会在 CREATE TABLE / REVOKE 处被拒；
    // 若 MIGRATION_DATABASE_URL 未设置则回退到 DATABASE_URL（单串环境仍可跑）。
    url: process.env.MIGRATION_DATABASE_URL ?? env('DATABASE_URL')
  }
})
