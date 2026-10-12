# 设计文档索引 · Kids Points

> 本目录是**可评审的设计事实源**，所有条目均以现有代码中的真实方法/调用点为依据，非推测。

| 文档 | 内容 | 状态 |
|---|---|---|
| [`01-overview.md`](./01-overview.md) | 系统概览、架构与信任边界、**事务边界**、模块边界、数据模型总览 | ✅ 完成 |
| [`02-rbac-and-approval.md`](./02-rbac-and-approval.md) | 双角色权限矩阵、三道屏障、审批状态机、**积分记录不可变性与规则版本化** | ✅ 完成 |
| [`03-existing-defects.md`](./03-existing-defects.md) | 既有缺陷清单（A/B/C/D/E 五类共 18 条）+ 修复顺序 | ✅ 完成 |
| [`04-onboarding-and-templates.md`](./04-onboarding-and-templates.md) | 首次引导流程、规则模板库、同意与合规 | ✅ 完成 |
| [`05-dev-plan.md`](./05-dev-plan.md) | 开发计划（**AI 辅助重估 ≈6.1 周**）、压缩选项（已否决）、风险登记、**阻塞项 L1–L6**、**决策登记 P1–P3** | ✅ 完成 |
| [`06-w0-report.md`](./06-w0-report.md) | **W0 实施报告**：**6 处文档缺陷 + 9 处落地缺陷（编号 7–15）**、D1–D10 **决策已全部裁定（12 条，见 §3.1）**、产物清单、**真实命令与退出码**、**§10 数据库打通与三项验收门关闭**、**两个"假绿"陷阱与反向对照** | ✅ W0 已执行 |

## 当前落地进度

### ✅ 已完成并验证

**D12 —— 测试器花括号嵌套错位 → CI 假通过**

根因不是"最后两个测试没跑"，而是 `check('seed')` 与 `check('addQuickNote')` 的回调未在自身位置闭合，
把 `console.log(summary)` / `process.exitCode` 挤进了 `addQuickNote` 回调内部：

| 验证项 | 修复前 | 修复后 |
|---|---|---|
| 汇总行位置 | 第 11 项后（**早于 2 个检查完成**） | 全部 13 项之后 |
| 末尾检查失败时的退出码 | `0`（**CI 假绿**） | `1` |
| 诚实性探针（注入必失败项） | 不传导 | **`EXIT_CODE=1`** ✅ |

**前端可控制缺陷（双端同步修复，含回归用例）**

| 编号 | 缺陷 | Taro (`kids_points_mp/`) | Flutter (`lib/`) |
|---|---|---|---|
| A1 | 负分规则被 `Math.abs()` 抹平 → 扣分变加分 | ✅ | ✅ |
| A4 | 流水硬编码"家长记录"、无操作人 | ✅ | ✅ |
| A5 | `addQuickNote` 加分错误递增 `rewardCount` | ✅ | ✅ |
| B6 | 扣分静默截断 → **账本不平** | ✅ | ✅ |
| B7 | `undoCheckIn` 物理删除流水 → 改为**冲正** | ✅ | ✅ |
| B8 | 兑换标题被 `shortTitle` **永久截断** | ✅ | ✅ |
| E18 | `resetToSeed` 生产可达 | ✅ | ✅ |
| E19 | 小标题串接方式不统一 | ✅ | ✅ |
| D13 | 测试断言把缺陷固化为"正确行为" | ✅ | ✅ |

验证结果：
- `node kids_points_mp/.tmp_test/run.js` → **14/14 PASS，`EXIT_CODE=0`**
- `npx tsc --noEmit -p tsconfig.json` → **`EXIT=0`**
- `flutter test` → **21/21 PASS**（`TEST_EXIT=0`）
- `flutter analyze` → 0 error / 0 warning（6 条 info 为既有基线）

### ✅ W0 已执行（`06` §5 附真实命令与退出码）

| 产物 | 验证 | 结果 |
|---|---|---|
| `backend/prisma/schema.prisma`（**18 表 / 14 枚举**） | `prisma validate` | ✅ `is valid 🚀` |
| Prisma Client | `prisma generate` | ✅ v7.10.0 |
| 13 个域模块签名 + Prisma 7 adapter 接入 | `tsc --noEmit` | ✅ `EXIT=0` |
| 构建 | `nest build` | ✅ `EXIT=0` |
| **CI 诚实性探针**（含 D12 回归守卫） | `npm run honesty:probe` | ✅ 4/4，**且经夹具证明能失败** |
| 模板库（18 条，按 P2 缩减） | `npm run templates:check` | ✅ 7 类坏数据全拦 |
| 跨语言契约 | `npm run contracts:emit` | ✅ 25 动作 → JSON |
| 工具代码类型检查（**新增**） | `npm run typecheck:tools` | ✅ 覆盖 `scripts/**`、`prisma/**`、`prisma.config.ts` |
| **端到端** | **`npm run ci`** | ✅ `EXIT=0` |
| **数据库层不变量 I5（新增）** | `npm run db:verify` | ✅ 7 项全 PASS；**反向对照证明它能变红** |

✅ **L1 已解除（2026-10-12）**：迁移可执行 / I5 实际生效 / 应用真实启动 —— 三项验收门全部通过。证据见 `06` §10。

### ⏳ 待办（按依赖顺序）

1. ~~**L1 · 数据库环境**~~ → ✅ **已关闭（方案 B：原生 PostgreSQL 18.6）**。
   当前基线：`.env` 中 `DATABASE_URL` = 应用角色 `kids_points_app`（**仅 CRUD**）；
   `MIGRATION_DATABASE_URL` = 所有者（跑迁移与授权）。
   ⚠ **`prisma migrate reset` 之后必须重跑** `prisma/sql/900_ledger_revoke.sql` **+** `npm run seed`
   —— 两者都**不会**自动补（原因见 `06` §10.3 与缺陷 11）。
2. **第 1 天必须并行启动的日历门**（`05` §6）：**L2** 小程序主体认证 + 正式 AppID
   （现为 `touristappid`，1–7 工作日）、**L4** 域名 + HTTPS + 备案（7–20 工作日）——
   **纯等待，AI 无法加速**，越晚启动越会顶穿整个计划。
3. ~~**L5 · git 仓库**~~ → ✅ **已完成（2026-10-12）**：`git init -b main` + 首次提交
   **`35c0d62`**（234 个文件入库、工作区 0 差异），建仓卫生一并修正（见下方「Git 记录规范」）。
   **仍待你定**：**CI 平台**（GitHub Actions / Gitee Go / 自建）—— 流水线命令本身已就绪（`npm run ci`）。
4. **W2**：`03` 剩余 8 条缺陷（`E15` / `E16` / `E17` / `A2` / `A3` / `C9` / `C10` / `C11`）
   必须与后端 schema **同批落地**；同时新增 `iconName → IconData` 映射（决策 **D9**）。
5. ~~**请你逐条确认 `06` §3 的 D1–D10**~~ → ✅ **已全部裁定（2026-10-12）**：**12 条锁定**
   （含本轮新立的 **D1b** `relation` 升枚举 / **D3b** `restrictions` 定形校验），结果见 `06` §3.1。
   **待落地**：D1b → 阶段 D-a ／ D3b → 阶段 D-b ／ D9 → 阶段 C5。
6. 已决策：**P1** 不压缩工期；**P2** L6 不到位（模板定稿 **18 条**）；
   **P3** `02` §5 不可变性与规则版本确认定稿。
7. **W1 开工前要先补的两件事**（`06` §10.6）：
   ① **引入测试框架** —— 现在只有手写断言的 `npm run db:verify`，"回归"不能只靠人肉重跑脚本；
   ② **`kids_points_app` 口令改为部署注入** —— 现在 `900_ledger_revoke.sql` 里是硬编码占位
   （`change-me-before-production`），生产必须换掉。

### 文档缺陷修正记录

**上一轮（自查发现）**

| # | 缺陷 | 说明 |
|---|---|---|
| 1 | **`05` §2 基线算术错误** | 原写「基线 9.5 周」，但表格逐项相加 = **10.5 周**。P1「不压缩」决策曾基于该错误数字 |
| 2 | **`05` §6 悬空编号 `L6`** | 表格只有一行 `L6`，**L1–L5 从未定义**；`04` 与 `05` 的 R4 都引用了一个不存在的登记表 → 已补全为 **L1–L6** 六项真实阻塞项（每项附仓库内证据） |

**本轮 W0（**照着文档实现时才会暴露**的 6 处，详见 `06` §2）**

| # | 缺陷 | 若不修正的后果 |
|---|---|---|
| 3 | `@nestjs/cli` **不存在 12.1.2**（最新 **12.0.8**） | `npm install` **直接失败** |
| 4 | NestJS 12 要求 **TypeScript ≥ 6**（`01` §1 写 5.4） | `npm install` 因 ERESOLVE **失败** |
| 5 | **Prisma 7 破坏性变更**：`datasource.url` 不再支持 | `prisma validate` **直接报错**，schema 无法开始 |
| 6 | `01` §5「新增 11 + 改造 5」**与事实不符** | 误以为要写 `ALTER TABLE`；实际**根本没有库可 ALTER**，应一次建 **18 表** |
| 7 | **`REVOKE` 对表所有者无效** → I5 变空承诺 | 用例 9.14 永远无法通过，而 I5 在文档里**长期"看起来成立"**（又一处假绿） |
| 8 | `01` §3「接 API 不改 UI」对**图标字段**不成立 | Taro 用名字、Flutter 用 `IconData`，必须新增映射（决策 D9） |

> 这 6 处的共同点：**文档写的是"应该是什么"，没有验证"实际能不能成立"** —— 与 D12 同类。
> 它们全部由 W0 的实际执行（`npm install` / `prisma validate` / `tsc`）暴露出来，
> 而不是由评审发现的。

**本轮 W0 收尾：连上真实数据库后才暴露的 9 处（详见 `06` §10）**

> 编号说明：`06` §10.2 内编号为 **7–15**（承接其 §2 的 1–6）；下表为本文档的**全局编号 9–17**。

| # | 缺陷 | 若不修正的后果 |
|---|---|---|
| 9 | `prisma.config.ts` 的 seed 指向**不存在的** `prisma/seed/rule-templates.ts` | `prisma db seed` **直接失败**，引导第⑤步拿不到模板 |
| 10 | 迁移使用 `DATABASE_URL`，与 D7「迁移走所有者」冲突 | 应用角色无 DDL，迁移**建不了表** |
| 11 | `.env` 两条连接串**同值** → D7 只是文档承诺 | **I5 形同虚设**（应用以所有者身份连库） |
| 12 | `scripts/**`、`prisma/**` **不在任何 tsconfig 的 include 中** | 工具代码**零类型检查**；启用后立刻抓出真实类型错误 |
| 13 | **Prisma 7 的 `migrate dev` 不会自动跑 seed** | 模板库**静默为空**（不报错 —— 最难发现的一种） |
| 14 | tsx 按 CJS 编译 → **顶层 await 报错** | seed 脚本**一行都跑不了** |
| 15 | `main.ts` **从未加载 `.env`** | `npm start` 抛「DATABASE_URL 未设置」，即使 `.env` 就在旁边 |
| 16 | **`class-validator` / `class-transformer` 不在依赖里** | `ValidationPipe` 抛错，**应用根本起不来** |
| 17 | `@prisma/client@7` 无 postinstall 钩子 | 全新克隆未 `generate` 时 `tsc` 找不到类型 |

> 这一批与 3–8 的共同点**更值得警惕**：它们不是"文档写错了"，
> 而是 **"文档写的都对，但没有任何东西会把错误喊出来"**。
> `migrate dev` 不跑 seed 不报错；`npm start` 起不来却被归因为"环境没装库" ——
> **沉默的失败比失败的报错危险得多。**

### CI 步骤

**后端 —— 已落地为一条命令**（`backend/`）：

```
npm run ci
= prisma:validate → typecheck → typecheck:tools → honesty:probe → templates:check → build → contracts:emit
```

其中 `honesty:probe` 包含两项**结构性守卫**：
- **D12 回归守卫**：扫描测试运行器的花括号嵌套深度，确认汇总与 `process.exitCode`
  **不在任何回调内部**（该探针已用夹具 `__fixtures__/d12-misnested-runner.js`
  证明**能失败** —— 否则它自己就会变成下一处假绿）
- **ActionType 契约漂移守卫**：`permission-matrix.ts` 与 Prisma `enum ActionType` 必须逐一对应

**完整流水线**（命令已就绪；**尚未接入 CI 平台** —— 选定平台后写成 workflow 文件即可）：

```
1. 前端 Taro:    npx tsc --noEmit -p tsconfig.json && node .tmp_test/run.js
2. 前端 Flutter: flutter analyze && flutter test
3. 后端:         cd backend && npm run ci
```

**一条不会失败的测试器等于没有测试器** —— D12 正是如此被瞒过很久的。
同理：**一个永远不会失败的检查项、一句永远不报错的 `REVOKE`、一个从不生效的权限收回，
都只是"看起来在做安全"**。这是本项目的头号教训。
## Git 记录规范（2026-10-12 建仓起生效）

仓库：`main` 单主线。**每个小步一个提交**，禁止把互不相干的改动混成一坨。

### 提交信息格式

```
<type>(<scope>): <一句话说清「改了什么」>

背景/为什么：
- …（缺陷编号 / 决策编号 / 文档章节）
验证证据：
- <命令> → <结果与退出码>
```

| type | 用途 |
|---|---|
| `fix` | 修缺陷（**必须附「能失败」的反向对照**） |
| `feat` | 新功能 |
| `docs` | 只改文档 |
| `test` | 只加/改测试 |
| `refactor` | 行为不变的重构（证据＝改前改后测试结果一致） |
| `chore` | 依赖、脚本、构建、仓库卫生 |
| `build` | CI / 构建配置 |

### 四条硬约束

1. **没有证据不算完成**：`fix` 类提交必须能贴出「改之前红、改之后绿」的两次真实输出；
   只写「已修复」的提交一律退回。
2. **共享状态操作顺序执行**：涉及数据库迁移、`git` 索引、构建产物的命令**不许并发**
   （曾因并发执行导致误报）。
3. **数据库链固定顺序**：`migrate dev → seed → 900_ledger_revoke.sql → db:verify`；
   `reset` 之后必须重跑后三步（`seed` 与 `REVOKE` **都不会自动补** —— 缺陷 13）。
4. **fail-closed 守卫优先**：凡有「必须满足否则不许继续」的前置条件
   （如真实 `.env` 不得进索引），写成命令里的守卫并 `exit 1`，而不是靠人记得。

### 入库 / 不入库

| 入库 | 不入库（`.gitignore` 已覆盖） |
|---|---|
| `docs/`、`contracts/`、双端源码、迁移 SQL、`package-lock.json`、`pubspec.lock` | `node_modules/`、`dist/`、`build/`、`.dart_tool/`、`.swc/`、`*.log`、`*.iml`、`.idea/` |
| `.env.example`（模板） | **`.env`（含真实口令，绝不入库）** |
| 手写验证脚本（`run.js` / `h5_*.js`） | 它们的产物：截图 `*.png`、`chrome-profile/`、探针日志 |

### 行尾策略（`.gitattributes`）

仓库内文本一律 **LF** 存储与检出；`*.bat` / `*.cmd` 保留 CRLF；二进制显式标记防止转换。
目的：Windows / Linux 混用时不再出现「整文件级 diff」的假变更。

### ⚠️ 建仓时拆掉的第一颗炸弹（记录在案，防止复发）

`kids_points_mp/.gitignore` 原第 9 行是 `.tmp_test/`（**整目录**忽略）。
但该目录里混着两类东西：产物（`dist/`、`chrome-profile/`、截图、日志）与
**手写验证脚本**（`run.js`、`h5_probe.js`、`h5_serve.js`、`h5_compat_check.js`）。
照原样建仓，这 **4 个脚本会静默消失** —— 不报错、不提示，正是本项目最忌讳的失败形态。

已改为只忽略产物（4 条精确规则），4 个脚本随首次提交 `35c0d62` 全部入库。
根 `.gitignore` 亦加了防复发注释：**gitignore 模式不区分层级**，
在根目录写 `.tmp_test/` 会再次命中该子目录。
