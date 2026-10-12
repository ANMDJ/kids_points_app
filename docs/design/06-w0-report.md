# 06 · W0 实施报告

> 本文记录 W0（环境 + 完整 schema + 模块签名 + CI 诚实性）的**实际**产出、
> 编写过程中暴露的**文档缺陷**、以及**尚待你确认的决策**。
> 与 `05` 的关系：`05` 是计划，本文是「计划被现实修正后的结果」。

---

## 1. 本轮结论（TL;DR）

**你的两项裁定**

| 项 | 裁定 | 影响 |
|---|---|---|
| **P2** | L6 内容角色**不到位**；以当前设计内容为模板开发，不追求完善 | 模板库 **90 条 → 18 条**；`04` §4 的 O1「2.0 人日」相应降级 |
| **启动范围** | 当前能启动的**全部启动** | `05` §6 的 L1/L2/L4/L5/L6 中，仅 **L1 与本机环境**相关；其余是**人/日历**动作，我无法代做（见 §6） |

**已交付并已通过真实工具验证**（不是"应该能用"）：

| 产物 | 验证方式 | 结果 |
|---|---|---|
| `backend/prisma/schema.prisma`（18 表 / 14 枚举） | `prisma validate` | ✅ `The schema at prisma\schema.prisma is valid 🚀` |
| Prisma Client 生成 | `prisma generate` | ✅ Client v7.10.0 已生成 |
| 后端全量类型检查 | `tsc --noEmit` | ✅ EXIT=0 |
| 构建 | `nest build` | ✅ EXIT=0 |
| CI 诚实性探针 | `node scripts/honesty-probe.mjs` | ✅ 4/4，且**反向自测可失败** |
| 模板库数据 | `tsx scripts/check-templates.ts` | ✅ 18 条，7 类坏数据全部拦下 |
| 跨语言契约 | `scripts/emit-matrix.mjs` | ✅ 25 个动作已导出 JSON |
| 端到端 | `npm run ci` | ✅ EXIT=0 |

**唯一硬阻塞**：本机**没有 PostgreSQL**（也没有 Docker）。因此
**`prisma migrate` 类验收门今天无法关闭** —— 但 schema 的编写与语法校验**不需要活库**，
而这正是 W0 最容易出错、最该现在定稿的部分。

---

## 2. ★ 编写过程中发现的 6 处文档缺陷

这些不是"疏忽"，而是**照着文档做会直接失败**的问题。
它们的共同点：**文档写的是"应该是什么"，没有验证"实际能不能成立"** —— 与 D12 同类。

### 缺陷 1 · `@nestjs/cli@12.1.2` **不存在**

| | |
|---|---|
| `01` §1 原文 | API 层：`NestJS 12.1.2` |
| 实测 | `npm view @nestjs/core@12.1.2` → 存在（且为最新）<br>`npm view @nestjs/cli version` → **12.0.8**<br>`npm view @nestjs/schematics version` → **12.0.6** |
| 后果 | 若把 CLI 也写死 12.1.2，`npm install` **直接失败** |
| 修正 | 框架包固定 `12.1.2`；CLI 固定 `12.0.8`、schematics `12.0.6`（见 `backend/package.json`） |

> 根因：NestJS 的**框架包**与**工具链**版本号不同步，文档把两者当成了同一个版本号。

### 缺陷 2 · NestJS 12 要求 **TypeScript ≥ 6**，而 `01` §1 写的是 5.4

| | |
|---|---|
| 实测报错 | `peer typescript@">=6.0.0" from @nestjs/schematics@12.0.6` |
| `01` §1 | 小程序端 `TypeScript 5.4`（**这一项对 Taro 端成立**） |
| 后果 | 后端沿用 5.4 → `npm install` 因 ERESOLVE **失败** |
| 修正 | 后端固定 `typescript: 6.0.3`；Taro 端维持 5.4.5 不变（两个独立 `package.json`，互不影响） |

### 缺陷 3 · Prisma 7 **破坏性变更**：`datasource.url` 已不支持

| | |
|---|---|
| 实测报错 | `P1012: The datasource property url is no longer supported in schema files` |
| 官方迁移路径 | 连接串移至 `prisma.config.ts` 的 `datasource.url`；客户端改用 **driver adapter** |
| 后果 | 若照文档写 `url = env("DATABASE_URL")`，`prisma validate` **直接报错** —— schema 一步都走不下去 |
| 修正 | 新增 `backend/prisma.config.ts`；`PrismaService` 改为 `new PrismaClient({ adapter: new PrismaPg(...) })`；新增依赖 `@prisma/adapter-pg`、`dotenv`、`tsx` |

> `01` §1 只写了版本号「Prisma **7.10.0**」。**选了一个大版本，就必须承担该大版本的变更** ——
> 这正是"照文档实现"会在 W0 才暴露、而不是在写文档时暴露的问题。

### 缺陷 4 · `01` §5「新增 11 张 + 改造 5 张」与事实不符

| | |
|---|---|
| `01` §5 表述 | 「新增表（11 张）」+「既有表改造（5 张）」 |
| 事实 | 仓库内**从不存在后端与数据库**（无 `kids_points_api/`、无 `backend/`、无迁移、无 `.env`）。<br>那 5 张"既有表"（`PointRule`/`PointRecord`/`Habit`/`Wish`/`Child`）**只存在于双端的内存模型里** |
| 后果 | 会让人误以为 W0 需要写 `ALTER TABLE` 迁移；实际上**根本没有库可 ALTER** |
| 修正 | W0 一次创建 **全部 18 张表**，不存在"改造既有表"这一步 |

> 「11 + 5 = 16」也无法解释 `02` §1 引用的 `User` 与 `UserChildRelation` ——
> 这两张表**在两处计数里都不存在**，却必须存在（见决策 D1）。

### 缺陷 5 · `REVOKE UPDATE, DELETE` 对**表所有者无效** → I5 会变成空承诺

| | |
|---|---|
| `02` §5.7 I5 / §9.14 | 「DB 层 `REVOKE`；直连 UPDATE 必须报错」 |
| 事实 | PostgreSQL 中**表所有者永远拥有全部权限，`REVOKE` 对所有者无效**。<br>应用若用建表用户连接，`REVOKE` 是**空操作** |
| 后果 | 用例 9.14 永远无法通过，而 I5 会在文档里长期"看起来成立" —— **又一次假绿** |
| 修正 | `prisma/sql/900_ledger_revoke.sql` 创建**非所有者角色** `kids_points_app`，<br>且脚本末尾用 `has_table_privilege()` **自检并在失败时 `RAISE EXCEPTION`** |

> 这一条的严重性不低于 D12：**一个永远不会失败的检查，等于没有检查**。
> `REVOKE` 语句本身不会报错，它只是**什么也没做**。

### 缺陷 6 · `01` §3「接 API 时不改 UI」对图标字段不成立

| | |
|---|---|
| `01` §3 承诺 | 现有 `AppStore` 方法名一一对应，接 API 时**不改 UI**，只改方法体 |
| 事实 | Taro 侧 `icon: IconName`（字符串名，如 `'book'`）；<br>Flutter 侧 `icon: IconData`（Material 常量，如 `Icons.menu_book_rounded`） |
| 后果 | 服务端只能存字符串。Flutter 端必须新增 **名字 → `IconData` 映射**，这是**新增代码**，不是"只改方法体" |
| 修正 | W0 不做映射（无测试保护时容易写错）；列为 W2 工作项，见决策 D9 |

---

## 3. 决策登记 D1–D10（**2026-10-12 已全部裁定**）

文档未定义、我按「最不容易出错」的原则做了选择的地方。
原为「每一条都请确认或推翻」，**2026-10-12 已逐条裁定完毕**：

- **§3.1** 裁定结果（**生效版本**）—— 12 条，含本轮新立的 `D1b` / `D3b`
- **§3.2** 裁定过程中的一个错误（记录在案，防止同类复发）
- **§3.3** 历史：W0 当时的选择与理由（保留以备追溯）

裁定即锁定：后续若需改动，必须有新证据，在提交信息里写明理由，并同步 `01` / `02`。

### 3.1 裁定结果（生效版本）

| # | 决策点 | **你的裁定（2026-10-12）** | 落地状态 |
|---|---|---|---|
| **D1** | `User` / `UserChildRelation` 字段最小集 | ✅ **确认** | 已落地 |
| **D1b** | `UserChildRelation.relation`：自由字符串 → 枚举 | ✅ **升级为 `RelationKind`**（本轮新立） | ⏳ 阶段 D-a：1 enum + 1 字段 + 迁移 |
| **D2** | `goodHabitCount` / `rewardCount` 不落库 | ✅ **确认**（改按需 `COUNT`） | 已落地（`Child` 无此二列，L227 注释） |
| **D3** | PIN 失败计数落在 `ChildMember`（人）而非设备 | ✅ **确认** | 已落地（`pinFailedCount` L265 / `pinLockedUntil` L266） |
| **D3b** | `ChildMember.restrictions`：裸 `Json` → 定形校验 | ✅ **定形**（本轮新立） | ⏳ 阶段 D-b：类型 + 类型守卫 + 单测 |
| **D4** | `PointRecord.approvalRequestId` 不落库 | ✅ **确认（只存一边）** | 已落地（`executedRecordId` `@unique`）；`02` §5.2 待补勘误 |
| **D5** | 不用 `@map`；`02` §8 示例 SQL 改带引号 camelCase | ✅ **确认** | 全 schema `@map` / `@@map` 出现 **0** 次；`02` §8 待补勘误 |
| **D6** | `viewer` 角色 → `DENY`（fail-closed） | ✅ **确认（维持 DENY）**；暂不做只读分享 | 已落地（`permission-matrix.ts` L94）；`02` §2 待补说明 |
| **D7** | 应用角色与表所有者分离（I5 成立的前提） | ✅ **确认** | 已落地（双连接串 + `900_ledger_revoke.sql` + `verify-db.mjs`） |
| **D8** | 唯一事实源位置 | ✅ **确认** | 已落地（`backend/src/contracts/` + 导出 `contracts/permission-matrix.json`） |
| **D9** | 图标字段跨端类型不一致 → 新增 `iconName → IconData` 映射 | ✅ **确认** | ⏳ 阶段 C5：Taro 侧 28 个图标名全覆盖（18 条模板实际用到 15 个） |
| **D10** | 扣分模板的 `points` 符号 | ✅ **确认**（正值 + `direction='penalty'`，展示取负） | 已落地（`RuleTemplate` / `PointRule` 的 `direction` 字段） |

### 3.2 裁定过程中的一个错误（记录在案，防止同类复发）

> 上一轮我报告「**D3 未落地**：`ChildMember` 缺 `failedAttempts` / `lockedUntil`，阶段 D-a 要补一次迁移」。
> **这是错的。**字段实际叫 `pinFailedCount`（L265）/ `pinLockedUntil`（L266），**D3 早已落地**。
>
> **出错机制**：我**用自己猜的字段名去 `grep`**，而不是打开模型读 —— 得到假阴性，
> 再基于假阴性排了一条**根本不存在的「补迁移」计划**（还写进了待办）。
>
> **教训**：核实「某个字段 / 能力是否存在」**必须读模型或文件，不许只靠字段名搜索**。
> 这与 §10.7 的「并发执行导致共享状态误报」同类：**命令执行了、写得很像样，但结论是错的** ——
> 属于过程缺陷，比单纯写错代码更危险，因为它不报错。
>
> **处置**：从阶段 D 中**删除**该「补迁移」项；D-a 改为 `D1b` 的 `RelationKind` 迁移。

### 3.3 历史：W0 当时的选择与理由（保留以备追溯）

| # | 决策点 | 文档状况 | 我的选择与理由 |
|---|---|---|---|
| **D1** | `User` / `UserChildRelation` 字段 | `02` §1 只画了关系图，**从未给字段** | 补齐最小集：`User(id, openId?, displayName?, status)`、`UserChildRelation(userId, childId, relation, @@unique)` |
| **D2** | `Child.goodHabitCount` / `rewardCount` 是否落库 | 客户端模型有这两字段 | **不落库**。它们是聚合结果，落库正是 **A5（奖励次数虚高）** 的成因；改为按需 `COUNT` |
| **D3** | PIN 失败计数落在哪 | `02` §7 只说"连错 5 次锁定 15 分钟" | 落在 **`ChildMember`**（人）而非设备。同一人换设备不该绕过锁定 |
| **D4** | `PointRecord.approvalRequestId` 是否落库 | `02` §5.2 字段表**列了**它 | **不落库**。`ApprovalRequest.executedRecordId`（唯一）已单向表达，双向冗余必然漂移 —— 正是本项目在修的那类缺陷 |
| **D5** | `02` §8 示例 SQL 用 snake_case 列名 | 示例写 `used_count` / `max_uses` | schema **未用 `@map`**，故列名为 camelCase 且需带引号。**SQL 语义不变**，仅标识符需改写 |
| **D6** | `viewer` 角色在矩阵中没有列 | `02` §1 提到 `role=viewer` 为将来扩展；§2 矩阵只有 `guardian`/`child` 两列 | **fail-closed**：`viewer` → `DENY`。若将来要支持，必须**显式扩列**，不允许在调用处打补丁 |
| **D7** | 应用角色与表所有者分离 | 文档未涉及 | 必须分离，否则 I5 无效（缺陷 5）。应用用 `kids_points_app`，迁移用所有者 |
| **D8** | 唯一事实源路径 | `02` §2 示意 `contracts/permission-matrix.ts`；§3 又说属 `backend_agent` 与后端共享 | 源码放 `backend/src/contracts/`（放仓库根会跨出 `rootDir`，污染 `dist` 布局）；<br>由脚本导出 `contracts/permission-matrix.json` 供 Python 读。**本质是"只有一份"，不是"放哪个目录"** |
| **D9** | 图标字段跨端类型不一致 | `01` §3 声称"不改 UI" | W2 新增 `iconName → IconData` 映射表。W0 只保证**存的名字是真实存在的**（`templates.data.ts` 已校验） |
| **D10** | 扣分模板的 `points` 符号 | `04` §4 分值规范写「−1 ~ −3」；schema 规定 `points` **恒为正** | 存 **正值 + `direction='penalty'`**，展示时取负。<br>理由：`Math.abs()` 抹平负分正是 **A1** 的根源，**绝不能给 A1 留第二条复发路径** |

---

## 4. 已交付产物清单

### 4.1 环境与配置

| 文件 | 说明 |
|---|---|
| `backend/package.json` | NestJS 框架 12.1.2 / CLI 12.0.8 / Prisma 7.10.0 / TS 6.0.3 + 8 条脚本 |
| `backend/tsconfig.json` | `strict` 全家桶 + `rootDir: src`；**已移除 TS 6 弃用的 `baseUrl`** |
| `backend/nest-cli.json` | Nest 构建配置 |
| `backend/.env.example` | 全部环境变量的**键 + 说明**，标注每个键对应哪个阻塞项 |
| `backend/.gitignore` | `node_modules/` `dist/` **`.env`**（真实值绝不入库） |
| `backend/prisma.config.ts` | Prisma 7 必需的 CLI 配置（承接原 `datasource.url`） |

### 4.2 数据模型（W0 核心）

`backend/prisma/schema.prisma` —— **18 张表 / 14 个枚举**，按 `01` §5.3 的"不可拆分"要求一次性包含：

| 分组 | 表 |
|---|---|
| 身份与成员 | `User` `UserChildRelation` `Child` `ChildMember` `DeviceSession` `DeviceToken` |
| 规则与账本 | `PointRule` `PointRuleVersion` **`PointRecord`** `Habit` `Wish` |
| 审批/邀请/合规/审计/模板 | `ApprovalRequest` `InviteCode` `GuardianConsent` `AuditLog` `Notification` `IdempotencyRecord` `RuleTemplate` |

**在数据库层强制的两个不变量**（不是靠应用自觉）：

1. **I3**：`PointRecord(ruleId, ruleVersion)` → `PointRuleVersion(ruleId, version)` 是**复合外键**。
   「每条记录必能命中版本行」由数据库保证，历史不可能指向空版本。
2. **I5**：`prisma/sql/900_ledger_revoke.sql` 收回账本表的 `UPDATE`/`DELETE`，
   **并自检**权限是否真的生效（否则 `RAISE EXCEPTION` 让迁移失败）。

### 4.3 契约与骨架

| 文件 | 说明 |
|---|---|
| `backend/src/contracts/permission-matrix.ts` | `PERMISSION_MATRIX` 唯一事实源（25 动作）+ `stricter()`（屏障三方向性）+ fail-closed `resolveVerdict()` |
| `backend/src/prisma/prisma.service.ts` | Prisma 7 driver adapter 接入；`DATABASE_URL` 缺失时**抛错而非静默降级** |
| `backend/src/{membership,permissions,ledger,rules,habits,wishes,approvals,onboarding,invites,device-session,audit,notifications,idempotency}/*.module.ts` | 13 个**空模块签名**，每个文件头部写明职责、禁止事项、对应验收用例编号 |
| `contracts/permission-matrix.json` | 生成产物，供 Python Agent 消费 |
| `contracts/README.md` | 为什么 Agent 不能自己抄一份矩阵 + 正确变更顺序 |

### 4.4 CI 诚实性（对 D12 的结构性回答）

| 文件 | 说明 |
|---|---|
| `backend/scripts/honesty-probe.mjs` | 4 项检查：A 注入必失败→非 0 ／ B 注入必成功→0 ／ C **D12 回归守卫**（扫描运行器的花括号嵌套深度）／ D ActionType 契约漂移 |
| `backend/scripts/__fixtures__/d12-misnested-runner.js` | **D12 复现夹具** —— 用于证明 C 项**能失败** |
| `backend/scripts/check-templates.ts` | 模板数据离线自检 + **反向自测**（7 类坏数据必须被拦下） |

### 4.5 模板库（按 P2 决策缩减）

| 文件 | 说明 |
|---|---|
| `backend/prisma/seed/templates.data.ts` | **18 条**模板（6 个关注点全覆盖，含 2 条扣分）+ 离线校验器 |
| `backend/prisma/seed/rule-templates.ts` | （W2）按 `slug` upsert 入库 |

> 图标名与配色**逐一核对**过双端真实取值：
> 图标名来自 `kids_points_mp/src/components/Icon/icons.ts` 的 28 个键，
> 颜色来自 `lib/theme/app_colors.dart` + 现有 `seed.ts` 的 6 个实际取值。
> 写错名字**编译期不报错**，只会在渲染时静默缺失 —— 所以放进校验器。

---

## 5. 验证证据（真实命令与输出）

| # | 命令 | 输出 | 退出码 |
|---|---|---|---|
| 1 | `npx prisma validate` | `The schema at prisma\schema.prisma is valid 🚀` | **0** |
| 2 | `npx prisma generate` | `✔ Generated Prisma Client (v7.10.0)` | **0** |
| 3 | `npx tsc --noEmit -p tsconfig.json` | （无输出） | **0** |
| 4 | `npx nest build` | （无输出），`dist/main.js` 存在 | **0** |
| 5 | `node scripts/honesty-probe.mjs` | `ALL PASS （共 4 项检查）` | **0** |
| 6 | `HONESTY_RUNNER_PATH=.../d12-misnested-runner.js node scripts/honesty-probe.mjs` | `FAIL C. …第 37 行（嵌套深度 2）` `FAILED 1 项` | **1** ← 证明 5 不是假绿 |
| 7 | `npx tsx scripts/check-templates.ts` | `ALL PASS`（18 条 / 7 类坏数据全拦 / 空分组被拦） | **0** |
| 8 | `node scripts/emit-matrix.mjs` | `✔ 已生成 contracts/permission-matrix.json（25 个动作）` | **0** |
| 9 | **`npm run ci`**（串起 1→8） | 全部通过 | **0** |
| 10 | `createdb -E UTF8 -T template0 kids_points` | 建库成功（`pg_encoding_to_char` = **UTF8**） | **0** |
| 11 | **`npx prisma migrate dev --name w0_init`** | `Applying migration 20261012022042_w0_init`；库内 **18 表 + `_prisma_migrations`** | **0** |
| 12 | `npx prisma db seed` | `The seed command has been executed.`；`RuleTemplate` 行数 = **18** | **0** |
| 13 | `psql "$MIGRATION_DATABASE_URL" -f prisma/sql/900_ledger_revoke.sql` | `DO / GRANT / GRANT / ALTER DEFAULT PRIVILEGES / REVOKE×3 / DO` 全部执行，**末尾自检未抛异常** | **0** |
| 14 | **`npm run db:verify`**（I5 实证，P0+A–D+F+G 共 7 项） | `ALL PASS —— I5 在真实库上生效` | **0** |
| 15 | 反向对照①：临时 `GRANT UPDATE ON "PointRecord"` 后重跑 14 | `FAIL A. …竟然成功了！不变量未生效` → `FAILED 1 项` | **1** ← 证明 14 **不是假绿** |
| 16 | 反向对照②：撤掉 `USAGE ON SCHEMA public` 后重跑 14 | `FAIL P0…`，且 A–D 全部判为**不可判定** → `FAILED 6 项` | **1** ← 抓住"用错误理由拿绿灯" |
| 17 | `node dist/main.js`（**真实连库启动**） | `[PrismaService] 数据库已连接` + `[Bootstrap] kids_points_api 已启动：http://localhost:3000`；`ERROR` 出现 **0** 次 | 正常运行满 18 秒后被超时终止（137） |
| 18 | 反向：清空 `DATABASE_URL` 后启动 17 | `ERROR [ExceptionHandler] Error: DATABASE_URL 未设置…` | **1** ← **无静默降级** |
| 19 | `npx prisma migrate reset --force` | `Database reset successful` + 重新应用迁移 | **0** |

`npm run ci` 的定义（**顺序即依赖**，`build` 必须先于 `contracts:emit`）：

```
prisma:validate → typecheck → typecheck:tools → honesty:probe → templates:check → build → contracts:emit
```

> **一个必须记录的过程缺陷**：我第一次把 `nest build` 与 `contracts:emit`
> 放在**同一批次并发**执行，`emit` 在 `build` 完成前就跑了，报出"找不到编译产物"。
> 产物其实存在 —— **是我把有依赖的命令并发执行了**。
> 这与上一轮会话里"shell `&` 优先级导致目录竞争"是**同一类错误**：
> **AI 的产出顺序错误不会被编译器发现，只会表现为"看起来失败了"或"看起来成功了"。**

---

## 6. L1–L6 阻塞项现状

| ID | 阻塞项 | 现状 | 是否卡住我 | 需要谁做 |
|---|---|---|---|---|
| **L1** | 数据库环境 | ✅ **已解除（2026-10-12）** —— PostgreSQL **18.6**（`D:\Program Files\PostgreSQL\18`，服务 `postgresql-x64-18`，端口 5432，`pg_hba.conf` 全部 `scram-sha-256`）；库 `kids_points`（UTF8）+ 角色 `kids_points_app` 已建 | ✅ **已解除** —— 三项验收门全部关闭（见 §10） | 你已提供 superuser 口令，按**方案 B** 落地 |
| **L2** | 微信小程序 AppID | `kids_points_mp/project.config.json` → `"appid": "touristappid"`（游客态） | ❌ 不卡 W0 | **需要你**：主体认证（1–7 工作日，**纯等待**） |
| **L3** | 推送凭据 | 双端**零推送依赖**（`pubspec.yaml`/`package.json` 无任何推送包） | ❌ 不卡 | W6 才需要 |
| **L4** | 域名 + HTTPS + 备案 | 无域名、无 `.env` 中的 `PUBLIC_BASE_URL` | ❌ 不卡 W0 | **需要你**：备案 7–20 工作日（**纯等待**） |
| **L5** | CI / 仓库 | **本目录不是 git 仓库**（`git rev-parse` 失败）；无 `.github/workflows` | ⚠️ 半卡 | 我已把检查做成 `npm run ci`；**接 CI 只差 `git init` + 平台选择** |
| **L6** | 内容角色（模板撰稿人） | **已按你的 P2 裁定解除** —— 以当前设计内容为模板，不追求 90 条 | ❌ 已解除 | —— |

### L1 的处置（**已按方案 B 关闭**，2026-10-12）

| 方案 | 说明 | 结论 |
|---|---|---|
| A · Docker | `docker run … postgres:18` | 未采用（本机无 Docker） |
| **B · 原生 PostgreSQL** | Windows 安装包 + 建库 + `.env` | ✅ **采用** —— 18.6 已就绪 |
| C · 托管库 | 云 PostgreSQL / Neon / Supabase | 未采用 —— 托管服务常禁止自建角色，会让 **I5 无法验证**（那种情况下只能在测试库验证，并须在文档里标注差异，不能假装通过） |

实际执行链（每步退出码见 §5 第 10–19 行）：

```bash
export PATH="/d/Program Files/PostgreSQL/18/bin:$PATH"   # psql 不在 PATH，必须补
createdb -E UTF8 -T template0 kids_points                # 方案 B 第 1 步
cd backend
npx prisma migrate dev --name w0_init                    # 第一份真实迁移
npx prisma db seed                                       # 18 条模板入库
psql "$MIGRATION_DATABASE_URL" -f prisma/sql/900_ledger_revoke.sql
npm run db:verify                                        # I5 实证（可失败）
npm run ci
```

★ **与当初设想的一处重要差异**：`prisma migrate dev` **并不会自动执行 seed**
（Prisma 7 实测，见 §10 缺陷 11）。因此 `npx prisma db seed` 必须**显式**执行，
否则引导第⑤步会拿到**空模板库** —— 而"空模板库"不会报错，只会让功能悄悄变差。


---

## 7. W0 验收门对照

| 验收门 | 状态 | 证据 |
|---|---|---|
| 完整 schema 一次产出（11 新增 + 5 改造四者同批） | ✅ **通过** | `prisma validate` → valid 🚀；实际 **18 表**（因缺陷 4） |
| Prisma Client 可生成 | ✅ **通过** | `prisma generate` → v7.10.0 |
| 后端可编译 / 可构建 | ✅ **通过** | `tsc --noEmit` / `nest build` 均 EXIT=0 |
| 空模块签名（域边界清晰） | ✅ **通过** | 13 个模块，每个注明职责与验收用例编号 |
| CI 诚实性（注入必失败项 → 非 0） | ✅ **通过** | 探针 A/B/C/D 全通过，**且 C 项经夹具证明可失败** |
| 单一声明式权限事实源 + 跨语言导出 | ✅ **通过** | 25 动作；TS ↔ Prisma enum 一致性由探针 D 项守住 |
| 模板库（按 P2 缩减） | ✅ **通过** | 18 条 / 6 关注点全覆盖 / 图标与配色均为真实值 |
| **迁移可执行（连真实库）** | ✅ **通过** | `20261012022042_w0_init` 已生成并应用；库内 **18 表 + `_prisma_migrations`**（§5 第 11 行） |
| **I5 实际生效（直连 UPDATE 报错）** | ✅ **通过** | `npm run db:verify` → 7 项全 PASS；**两次反向对照均成功变红**（退出码 1）证明它不是假绿（§5 第 14–16 行） |
| 应用可真实启动（`npm start`） | ✅ **通过** | `数据库已连接` + `kids_points_api 已启动：http://localhost:3000`，ERROR 计数 0；清空 `DATABASE_URL` 后以**退出码 1** 响亮失败（§5 第 17–18 行） |

> 后三项曾**全部**只依赖 L1 一个东西；L1 关闭后它们随即全绿，
> 印证了「当前瓶颈不是代码，是环境」这一判断（与 `05` §2 一致）。
> ⚠ 但**"全绿"本身不构成证据**：过程中又暴露出 **9 处新缺陷（编号 7–15）**，
> 其中 2 处是"文档说通过、实际跑不起来"。详见 §10 —— **绿灯只有配得上证据时才算绿灯。**

---

## 8. 下一步

**顺序明确、无歧义：**

1. ✅ **L1 已关闭（方案 B）** —— 迁移 / I5 / 应用启动三项验收门均通过，见 §10。
2. **你并行启动 L2（主体认证）与 L4（备案）** —— 这两项是**纯等待**，
   1–7 工作日 / 7–20 工作日，**现在就启动**才不会在 W5 变成新的关键路径。
3. **L5**：你说一声我就 `git init` + 首次提交 + 生成 CI workflow（需指定平台）。
4. **W0 收尾后进入 W2**：`03` 剩余 8 条缺陷（**A2/A3/C9/C10/C11/E15/E16/E17**）
   必须与后端 schema **同批落地**（`03` §修复顺序：它们全部依赖 schema 变更）。
   同时新增 `iconName → IconData` 映射（决策 D9）。
5. **请你逐条确认 §3 的 D1–D10** —— 这 10 条是我在文档空白处做的选择。
   其中 **D2/D4/D6/D7/D10** 会直接影响数据正确性与安全性，
   越早推翻越便宜（schema 一旦有真实数据，改动成本立刻上一个量级 —— 这正是 `01` §3 的论点）。

---

## 9. 本轮我要明确承认的局限

1. ~~迁移未在真实库上跑过~~ → **已在真实库跑过**（§5 第 11/19 行）。
   但**仍未在"有数据量"的库上跑过**：锁表 / 迁移耗时 / 索引膨胀只在真实数据规模下才显现，
   当前库是**空的**。这条局限只缩小了，**没有消失**。
2. ~~`900_ledger_revoke.sql` 未执行过~~ → **已执行且自检通过**（§5 第 13 行）。
   但它证明的是**数据库权限**，**不证明应用代码不会绕过权限** ——
   只要有一处用了所有者连接串，I5 就形同虚设。这条只能靠"每条连接串都用对"来保证（D7），
   而且**没有任何自动化检查能兜住它**。
3. **13 个模块是空签名**，不含任何业务逻辑 —— 它们的作用是**锁定边界**，
   不是"已经实现了"。任何"W2 应该能直接用"的预期都不成立。
4. ~~`rule-templates.ts`（写库 seed）尚未编写~~ → **已编写并实测入库 18 条**
   （按 `slug` 幂等 upsert，写库**前**先跑离线自检，自检失败即拒绝写库）。
   同时补上了它此前缺失的类型检查覆盖（§10 缺陷 10）。
5. **模板只有 18 条**，是 P2 裁定的直接结果。它的代价是：
   引导第⑤步的**可选丰富度**明显低于原设计（原设想 90 条 / 4 学段 × 6 关注点）。
   这**不影响功能正确性**，但会影响新用户第一眼的观感。

---

## 10. W0 收尾：数据库打通与三项验收门关闭（2026-10-12）

L1 关闭后我按既定顺序执行，**结果与文档承诺有 9 处不一致**。这一节把它们全部记下来 ——
「文档说能跑」与「实际能跑」之间的差距，正是本项目 D12/D13 反复踩的坑。

### 10.1 三项验收门 → 关闭证据

| 验收门 | 可复现证据 | 退出码 |
|---|---|---|
| 迁移可执行 | `npx prisma migrate dev --name w0_init` → `Applying migration 20261012022042_w0_init`；库内 **18 表** | **0** |
| I5 账本不可改 | `npm run db:verify` → `ALL PASS —— I5 在真实库上生效`（7 项） | **0** |
| 应用真实启动 | `node dist/main.js` → `数据库已连接` + `kids_points_api 已启动：http://localhost:3000`；ERROR 出现 **0** 次 | 正常运行满 18 秒后被超时终止 |

### 10.2 本轮新发现的 9 处缺陷（本节编号 7–15，承接 §2 的 1–6）

| # | 缺陷 | 症状（实测，非推测） | 处置 |
|---|---|---|---|
| 7 | `prisma.config.ts` 的 `seed` 指向 `prisma/seed/rule-templates.ts`，**该文件不存在**（`src/onboarding/onboarding.module.ts:22` 同款悬空引用） | `prisma db seed` → esbuild `Transform failed` | ✅ 新建该文件（幂等 upsert + 写库前自检） |
| 8 | 迁移用 `env('DATABASE_URL')`，与 D7「迁移走所有者」冲突 | 应用角色无 DDL，迁移会在 `CREATE TABLE` 处被拒 | ✅ 改为 `process.env.MIGRATION_DATABASE_URL ?? env('DATABASE_URL')` |
| 9 | `.env` 两条连接串**同值**（都是 `postgres`）→ D7 原来只是**文档承诺**，没落地 | I5 无法成立：应用就是以所有者身份连库的 | ✅ 拆成两个角色：迁移 = `postgres`，应用 = `kids_points_app` |
| 10 | `scripts/**`、`prisma/**`、`prisma.config.ts` **不在任何 tsconfig 的 include 中** → 工具代码从未被类型检查 | 启用后立刻抓出 `scripts/check-templates.ts:54` 的真实类型错误（`as RuleTemplateSeed['focusAreas']` 少一层 `unknown`） | ✅ 新增 `tsconfig.tools.json` + `npm run typecheck:tools`，接入 `npm run ci` |
| 11 | **Prisma 7 的 `migrate dev` 不会自动执行 seed** | 迁移后 `RuleTemplate` = **0 行**，且**不报错**（静默） | ✅ 显式 `npm run seed`，并在 §6 写清顺序 |
| 12 | tsx 按 CJS 编译，**顶层 await 直接报错** | `Top-level await is currently not supported with the "cjs" output format` | ✅ 改为 `main().catch(...)` |
| 13 | `main.ts` **从未加载 `.env`**（无 `dotenv/config`、无 `@nestjs/config`） | `npm start` 即使 `.env` 就在旁边也抛「DATABASE_URL 未设置」 | ✅ `import 'dotenv/config'` 置于最前 |
| 14 | **`class-validator` / `class-transformer` 不在依赖里** | `new ValidationPipe()` → `The "class-validator" package is missing`，**应用根本起不来** | ✅ 补依赖并重建 |
| 15 | `@prisma/client@7` 无 postinstall 钩子 | 全新克隆未 `generate` 时 `tsc` 找不到类型 | ✅ `"postinstall": "prisma generate"` |

> **缺陷 13 与 14 最值得记**：§7 原先把「应用可启动」记为"被 L1 阻塞"，
> 暗示"库一好就能启动"。实际上它是**两个独立代码缺陷**叠加的结果 ——
> **把一个问题的原因归给单一外部依赖，会让真正的代码缺陷藏在"环境问题"背后。**

### 10.3 两个新的「假绿」陷阱（已用反向对照证明**能被抓住**）

1. **`prisma migrate reset` 会 `DROP SCHEMA public CASCADE`** —— 角色级 `GRANT USAGE` 随之消失。
   此时应用角色"连表都看不见"，A–D 仍会以 `permission denied` 报错**并显示为 PASS**，
   但理由是"没有 schema USAGE"，**不是**"表级 REVOKE 生效"。绿灯，但灯是错的。
   → 已在 `verify-db.mjs` 加 **P0 前置门**：应用角色必须**本来就能读**，否则 A–D 判为**不可判定（FAIL）**。
   实测：撤掉 `USAGE` → `FAILED 6 项`（退出码 1）；恢复 → `ALL PASS`。
2. **"检查器自己不会失败"** —— 反向对照：临时 `GRANT UPDATE ON "PointRecord"`
   → `FAIL A. …竟然成功了！不变量未生效` → `FAILED 1 项`（退出码 1）。

★ 由此得到一条**运维规则**：**`migrate reset` 之后必须重跑 `900_ledger_revoke.sql`**
（`GRANT USAGE ON SCHEMA public` 实测确证会随 schema 一起消失；`ALTER DEFAULT PRIVILEGES`
的条目同样依附于 schema —— 与其论证"它应该还在"，不如整段重跑一次，成本是 0.1 秒）。
同理，**`migrate reset` 之后 seed 也不会自动补**（缺陷 11），必须 `npm run seed`。

### 10.4 本轮新增的「会失败」资产

| 资产 | 作用 |
|---|---|
| `backend/scripts/verify-db.mjs` + `npm run db:verify` | I5 实证（P0 + A–D + F + G）；**有反向对照证明它能变红** |
| `backend/prisma/seed/rule-templates.ts` | 幂等 upsert（按 `slug`）；**写库前先跑离线自检，不过即拒绝写库** |
| `backend/tsconfig.tools.json` + `npm run typecheck:tools` | 覆盖 `scripts/**`、`prisma/**`、`prisma.config.ts`（此前**零覆盖**） |
| `npm run seed` / `npm run ci:db` | 把"容易漏的手工步骤"变成**有名字的命令**，漏了就是漏了一个可被 review 的命令 |

### 10.5 关键配置现状（W1 开始前的基线）

- `.env`：`DATABASE_URL` = `kids_points_app`（**应用，仅 CRUD**）；`MIGRATION_DATABASE_URL` = `postgres`（**所有者**）
- 迁移：`backend/prisma/migrations/20261012022042_w0_init/migration.sql`（18 表 / 14 枚举）
- 角色：`kids_points_app`；`PointRecord` / `PointRuleVersion` / `AuditLog` 已 `REVOKE UPDATE, DELETE`
- `RuleTemplate` 实测 **18 行**（6 关注点全覆盖）
- ⚠ `.env` 内含**明文口令** —— `git init`（L5）之前必须再核一遍 `backend/.gitignore` 确实忽略了它

### 10.6 仍未解决 / 需要你决定

1. **D1–D10 仍需你逐条确认**（尤其 D2/D4/D7/D10）。注意 **D7 现在已经是代码事实**：
   连接串分工、`prisma.config.ts`、seed、`900_ledger_revoke.sql` 都按它落地了 —— 推翻成本正在上升。
2. **应用角色的口令策略**：`900_ledger_revoke.sql` 里的 `kids_points_app` 口令是**硬编码占位**
   （`change-me-before-production`）。生产必须由部署注入（`ALTER ROLE … PASSWORD`）。
   现在改还是 W1 一起改？**我建议 W1 一起改**（那本来就属于"身份与权限"范畴）。
3. **L5 未做**：`git init` + 首次提交 + CI 平台选择（等你定平台）。
4. **没有自动化测试框架**：`verify-db.mjs` 是我手写的断言，不是 jest/vitest。
   **W2 开始写业务逻辑之前必须引入测试框架** —— 否则"回归"只能靠人肉重跑脚本，
   而人肉重跑一定会漏。
5. **迁移只在空库上跑过**（见 §9.1）。

### 10.7 我自己的过程错误（必须记，因为它会重犯）

本轮我**又**把两个**有依赖**的命令放进了**同一批次并发**执行：
"正常验证"与"撤掉 schema USAGE 的反向对照"同时跑，导致前者读到被后者改动过的状态，
误报 `FAILED 6 项`。

这与 §5 末尾记录的 `build` / `contracts:emit` 竞态**是同一类错误**。
结论：**AI 不会因为"每条命令都写对了"就自动把顺序写对。**
→ 处置：凡涉及**共享状态**（数据库、文件、构建产物）的命令，
一律**顺序执行、单独读结果**，不图快。


