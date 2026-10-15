# 设计文档索引 · Kids Points

> 本目录是**可评审的设计事实源**，所有条目均以现有代码中的真实方法/调用点为依据，非推测。

> **需求侧文档**（面向「做什么、为什么做、做到什么程度算完成」）见 [`../PRD.md`](../PRD.md) ——
> 它整合本目录 `01`–`11` 的事实，不重复承载实现细节；两者冲突时**以本目录的设计文档为准**。

| 文档 | 内容 | 状态 |
|---|---|---|
| [`01-overview.md`](./01-overview.md) | 系统概览、架构与信任边界、**事务边界**、模块边界、数据模型总览 | ✅ 完成 |
| [`02-rbac-and-approval.md`](./02-rbac-and-approval.md) | 双角色权限矩阵、三道屏障、审批状态机、**积分记录不可变性与规则版本化** | ✅ 完成 |
| [`03-existing-defects.md`](./03-existing-defects.md) | 既有缺陷清单（A/B/C/D/E 五类共 **19 条**：原 18 条 ＋ C5 补入的 `D9`）+ 修复顺序 | ✅ 完成 |
| [`04-onboarding-and-templates.md`](./04-onboarding-and-templates.md) | 首次引导流程、规则模板库、同意与合规 | ✅ 完成 |
| [`05-dev-plan.md`](./05-dev-plan.md) | 开发计划（**AI 辅助重估 ≈6.1 周**）、压缩选项（已否决）、风险登记、**阻塞项 L1–L6**、**决策登记 P1–P3** | ✅ 完成 |
| [`06-w0-report.md`](./06-w0-report.md) | **W0 实施报告**：**6 处文档缺陷 + 9 处落地缺陷（编号 7–15）**、D1–D10 **决策已全部裁定（12 条，见 §3.1）**、产物清单、**真实命令与退出码**、**§10 数据库打通与三项验收门关闭**、**两个"假绿"陷阱与反向对照** | ✅ W0 已执行 |
| [`07-c3-handoff.md`](./07-c3-handoff.md) | **阶段 C3 交接单**（E16 心愿配色 → 稳定枚举 `WishCoverStyle`）：已落地清单＋行号、**七道闸门实测与退出码**、**证伪 6 例（含 ③ 的实测勘误）**、**本轮真踩过的 9 条陷阱** | ✅ C3 已收口 |
| [`08-c4-handoff.md`](./08-c4-handoff.md) | **阶段 C4 交接单**（C9 软删除/回收站 ＋ C10 规则可编辑 ＋ C11 `AuditLog`）：**后端 schema/索引/`REVOKE` 就绪清单**、双端**空白落点与调用方行号**、守门人三块 `unfixed→fixed` 的改法与反回退断言、**七道闸门基线**、**5 件待决策** | ✅ C4 已收口 |
| [`09-c5-handoff.md`](./09-c5-handoff.md) | **阶段 C5 交接单**（`D9` 图标名 ↔ `IconData`）：**三端类型表与「为什么光有映射表不够」**、落地清单（文件级）、**新增闸门 `icons:check` 的 7 项检查**、**闸门 12/12 ＋ 用例 3/3 ＋ 3/3 证伪**、**两次「反例假绿」的自我纠正**、遗留（编辑不可改图标 / 名单仍手抄） | ✅ C5 已收口 |
| [`10-d1b-handoff.md`](./10-d1b-handoff.md) | **阶段 D-a 交接单**（`D1b` `relation` 升枚举 `RelationKind`）：**三处手抄契约 ＋ Prisma 默认 `DROP+ADD` 会静默清列这个坑**、落地清单、**新增闸门 `relation:check` 的 5 项检查**、**证伪 15 例（含 3 控制例）**、**三条自我纠正**、遗留（`D3b` / 首启引导 / 闸门 ④ 目前"无字面量可查"） | ✅ D-a 已收口 |
| [`11-d3b-handoff.md`](./11-d3b-handoff.md) | **阶段 D-b 交接单**（`D3b` `ChildMember.restrictions` 裸 `Json` 定形）：**为什么定形只能落在应用层（Prisma 表达不了 `Json` 内部形状）**、权威源 ↔ 两处手抄的三处对账、落地清单、**新增闸门 `restrictions:check` 的 6 项检查**、**证伪 17 例（14 反例：每例"红且只点名自己" ＋ 3 控制例）**、**`02` §3 去掉开放标记 `...` 的口径修正**、遗留（写入路径未开工 / 闸门此刻"无字面量可查"） | ✅ D-b 已收口 |
| [`../PRD.md`](../PRD.md) | **产品需求文档**（需求侧：目标与指标 / FR-01–FR-12 / 权限矩阵 **25 动作** / 数据模型摘要 / 里程碑 W0–W9 与验收门 / 阻塞项 / 决策登记 / **§15 诚实落地状态**） | ✅ 2026-10-14 入库 |
| [`../../prototype/README.md`](../../prototype/README.md) | **微信小程序高保真原型**（双击 `prototype/index.html` 即开；自检 `node prototype/verify.mjs` → 11/11）。⚠️ 它自述的「与 `kids_points_mp` 同源」**当前无闸门**，见待办 13 | ⚠️ 已入库，**同源闸门待补** |

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
| E18 | `resetToSeed` 生产可达 **＋ 首启即假数据**（C1 补第二半） | ✅ | ✅ |
| E19 | 小标题串接方式不统一 | ✅ | ✅ |
| D13 | 测试断言把缺陷固化为"正确行为"（C1 补齐 10/10 条） | ✅ | ✅ |
| C9 | 全部物理删除 → **软删除 ＋ 回收站（90 天）**（C4） | ✅ | ✅ |
| C10 | 规则**无法编辑** → `updateRule` ＋ 版本表（C4） | ✅ | ✅ |
| C11 | 无 `AuditLog` → **追加式审计**（C4） | ✅ | ✅ |

验证结果：
- `node kids_points_mp/.tmp_test/run.js` → **19/19 PASS，`EXIT_CODE=0`**（产物由下方流水线第 1 步现编，见「陈旧产物」说明）
- `npx tsc --noEmit -p tsconfig.json` → **`EXIT=0`**
- `flutter test` → **29/29 PASS**（`TEST_EXIT=0`；`app_test.dart` **28** ＋ `widget_test.dart` **1**）
  —— 修前 **21/21**，C1 新增 3 条（首启空态 ×2 ＋ 空态渲染冒烟 ×1），**C2 再新增 5 条**（演示数据只带结构字段 ×1、
  「每天最多 2 次」真能打 2 次 ×1、冲正排除 ×1、展示串由结构字段派生 ×1、频次越界被拒 ×1）。
  **别只数 `app_test.dart`**：`flutter test` 会跑 `test/` 下全部文件。
- `flutter analyze` → **0 issue，`EXIT=0`**（C1 顺手清零了 6 条既有 `prefer_const_constructors` info：
  **info 也会让 `flutter analyze` 退出码为 1** —— 于是它与 `analysis_options.yaml` 里"不阻断构建"的注释互相矛盾，
  流水线的 `flutter analyze && flutter test` 更是根本串不起来。已实测：清零后 exit 0、测试仍 29/29）
- **C2 追加**：`backend npm run ci` **ALL PASS**（含 `defects:check` **18/18**）；另跑 **6 例代码级证伪**全部变红、还原回绿。
- **C3（✅ 已收口 2026-10-12，提交 `90e9ce7`；交接单 [`07-c3-handoff.md`](./07-c3-handoff.md)）**：**E16** 心愿配色由 `wishes.length % 4` 升为稳定枚举 `WishCoverStyle`（补空档 + id 哈希，双端同源，下标归零）。
  已实测：`run.js` **20/20**、`flutter test` **32/32**、`flutter analyze` **0 issue**、Taro `tsc --noEmit` **EXIT=0**；
  收口闸门：`node tools/defect-status.mjs` **`ALL PASS`（18 条）**、`backend npm run ci` **8 步全绿**；**证伪 6 例**（造假必红、还原必绿）。
  一条**实测勘误**（写进 `07` §4.3 ③ / §5 第 9 条）：Flutter 取色回退成数组下标时，`flutter analyze` 与整包 `flutter test` **全绿**（
  配色表凑巧与枚举同序 → 行为等价），真正拦住它的是守门人一条 `A.lack` —— **断言名 ≠ 断言力**。
- **C4（✅ 已收口 2026-10-13，提交 `f3f4e21`；交接单 [`08-c4-handoff.md`](./08-c4-handoff.md)）**：**C9**（软删除 ＋ 回收站）＋ **C10**（`updateRule` 规则可编辑 ＋ 版本表）＋ **C11**（追加式审计），双端同步，守门人三块 `unfixed → fixed`。
  已实测：Taro `tsc --noEmit` **EXIT=0**、`npm run build:weapp` **EXIT=0**、`run.js` **25/25 ALL PASS**（新增 C9 ×3 / C10 / C11）；
  `flutter analyze` **0 issue**、`flutter test` **38/38**（`app_test.dart` 37 ＋ `widget_test.dart` 1；本轮新增 6 条）；`node tools/defect-status.mjs` **18/18 ALL PASS**。
  - **本轮最重要的语义**：删除＝**改状态位**（原对象仍在、可恢复），90 天保留期是**纯函数**（89/90/91 天可测），
    但**判定与动作分离** —— 过期不等于自动删，真删必须 UI 显式调 `purgeExpiredTrash()`。
  - **`updateRule` 是"四步一笔"**（归档版本 → 改本体 → 同步派生习惯 → 写审计，只 `persist()` 一次）：
    分两次调用会留下"改了但没记"的窗口。因此 Flutter 侧 `Habit.title/points/condition/dailyLimit` 不再 `final`
    —— 守门人 A2 那条 `final int dailyLimit;` 断言**被新语义作废**，与台账同批改掉（`03` §0 开头的 C4 说明）。
  - **审计的抓法**：只断言 `auditLog.length == 1` 会**全绿放行**「存引用」的假审计；真断言是"写完审计再改原对象，再读审计，内容必须不变"（两端都有）。
  - **诚实边界**：`AuditAction` 只列**前端真能触达**的 5 类动作，成员增删 / 角色切换 / 同意（consent）**本轮未实现**、也没有伪造取值 —— 不假装覆盖（`03` §C11 现状）。
  - **证伪自测 6/6**（`03` 验收门有逐例清单）：台账改回「未修」、物理删回退、审计改成 `push`、少一处 `activeOnly`、`updateRule` 偷换 id —— 每例都**点名对应条目**变红，还原（sha256 比对）后回绿。
- **C5（✅ 已收口 2026-10-13；交接单 [`09-c5-handoff.md`](./09-c5-handoff.md)）**：**`D9`** 图标字段跨端类型不一致 ——
  双端数据层只存**名字**（Flutter `icon: IconData` → `iconName: String`），名字的唯一事实收进
  `lib/theme/app_icons.dart`（常量表 ＋ 映射表 ＋ `iconDataFor()` ＋ 兜底 `fallbackIcon` ＋ 白名单 `isKnownIconName()`）；
  两端 `addRule` 越界**拒绝**，未登记的名字画 `unknown` 占位（**不是空白**）；
  **新增闸门** `tools/icon-names-check.mjs`（`npm run icons:check`，接进 `npm run ci` 第 7 步）比对
  Taro / Flutter / 后端**三份手抄名单**（各 **29** 个名字）。
  已实测：`run.js` **27/27**、`flutter test` **41/41**、`flutter analyze` **0 issue**、`npm run build:weapp` **EXIT=0**、
  闸门 **7/7**、台账 **19/19**、`backend npm run ci` **9 步 `CI_EXIT=0`**；**证伪 12 ＋ 3 ＋ 3 例全部变红且点名**。
  - **为什么不止加一张映射表**：名字在三端各有一份手抄清单（后端那份没法 import 小程序的 TS），
    漂移的表现是「某个图标在某一端悄悄变成占位」—— **三端的编译器都不会说一句话**。闸门才是这条缺陷的解药。
  - **台账补录**：`D9` 此前**从未进过 `03` §0 表**（只活在决策登记里），补进去的那一刻闸门立刻
    `FAIL D9 台账=（无此行）` / `FAILED 1 项（共对账 19 条）` —— **fail-closed 按设计工作**；补上验证器后转绿。
  - **两处诚实记录**：① **编辑规则不再允许改图标**（`RuleVersion` 快照无 icon 字段，允许改会让版本回放对不上）；
    ② 三份名单**仍是手抄**，现在只是「漂移会被抓住」。
  - **两次「反例假绿」的自我纠正**（写进 `03` 验收门）：闸门脚本曾因"改了 A、检查读 B"而假绿；
    `fallbackIcon` 的第一版注入与映射表值**行为等价**故不红 —— **红不了的不是用例，是反例**。



**阶段 C1（2026-10-12）新增的回归用例 —— 全部先验证过"能失败"再让它们变绿**：
- `E18 首启必须为空态：不预置任何演示数据`（Taro）／`首启空态（修 E18）`（Flutter）
  —— 修前分别报 `首启不得预置 124 分假数据` 与符号缺失；**种子数据降级为显式夹具** `seededStore()`
  （靠构造函数偷偷种数据，正是 E18 本身）。
- `E18 生产构建不可达：判据语义 + 真实生产模块双证` —— ①纯函数 `demoResetAllowed('production') === false`；
  ②以 `NODE_ENV=production` **重新加载真实模块**，断言 `ALLOW_DEMO_RESET === false`、
  且 `resetToSeed()` 返回 `false` **且不清空真实数据**。守卫因此**可被测试**，不再依赖"恰好跑在开发机上"。

### ✅ W0 已执行（`06` §5 附真实命令与退出码）

| 产物 | 验证 | 结果 |
|---|---|---|
| `backend/prisma/schema.prisma`（**18 表 / 14 枚举**） | `prisma validate` | ✅ `is valid 🚀` |
| Prisma Client | `prisma generate` | ✅ v7.10.0 |
| 13 个域模块签名 + Prisma 7 adapter 接入 | `tsc --noEmit` | ✅ `EXIT=0` |
| 构建 | `nest build` | ✅ `EXIT=0` |
| **CI 诚实性探针**（含 D12 回归守卫） | `npm run honesty:probe` | ✅ 4/4，**且经夹具证明能失败** |
| **缺陷台账对账守卫（2026-10-12 新增）** | `npm run defects:check` | ✅ 18 条声明与代码逐条一致（**C5 起为 19 条** —— 补入 `D9`）；**7 类篡改台账全部变红**；**C2 起补反回退断言**（`*.checked =` 写入数 = 0 / seed 不得再写展示串 / `rule.detail.split` 归零），并再加 **6 例代码级证伪全部变红**；**C5 起含跨端图标名闸门** `npm run icons:check`（`03` 里 D9 那条有反向断言：数据层 `IconData` 命中数必须 0、渲染点各恰好 1 次等） |
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
4. **W2**：`03` 剩余缺陷原为 3 条（`C9` / `C10` / `C11`，＝阶段 **C4**）—— ✅ **已于 2026-10-13 收口**（后端 W0 就绪的 schema 直接复用）。
   W2 的前端收尾 **`D9`**（图标名字 → `IconData` 映射，＝阶段 **C5**）—— ✅ **已于 2026-10-13 收口**：
   双端数据层只存**名字**、渲染时才查表，并新增跨端闸门 `npm run icons:check`
   （`tools/icon-names-check.mjs`，7 项）守住「Taro / Flutter / 后端三份手抄名单」不漂移。
   `03` 台账因此由 **18 条变 19 条**（D9 此前**从未进过台账**，C5 补录 —— 见 `03` §0 与 §D9）。
   （原列 8 条里的 `E15` / `E17` / `A2` / `A3` **已于阶段 C2 收口** —— 见第 9 条。）
5. ~~**请你逐条确认 `06` §3 的 D1–D10**~~ → ✅ **已全部裁定（2026-10-12）**：**12 条锁定**
   （含本轮新立的 **D1b** `relation` 升枚举 / **D3b** `restrictions` 定形校验），结果见 `06` §3.1。
   **已落地**：D1b → 阶段 D-a（✅ **2026-10-13，见 `10-d1b-handoff.md`**）、D3b → 阶段 D-b（✅ **2026-10-13，见 `11-d3b-handoff.md`**）—— 加上 **D9 已于阶段 C5 落地**，**12 条决策全部落地**。
6. 已决策：**P1** 不压缩工期；**P2** L6 不到位（模板定稿 **18 条**）；
   **P3** `02` §5 不可变性与规则版本确认定稿。
7. **W1 开工前要先补的两件事**（`06` §10.6）：
   ① ~~**引入测试框架**~~ → ✅ **已完成（2026-10-14，阶段 B1）** —— 现在只有手写断言的 `npm run db:verify`，"回归"不能只靠人肉重跑脚本，故补上**常设测试套件**：
   `node:test`（Node 内置 runner）＋ 既有 `tsx` 作加载器，**零新增依赖**（选型是实测的：Node 26 原生类型剥离
   连模块都解析不了，jest/vitest 需新增依赖且 TS 6.0.3 有兼容风险）；新增 `npm run test` /
   `typecheck:tests` / `test:canfail` 三步进 CI（**11 → 14 步**），首批用例覆盖矩阵性质与
   `restrictions` 守卫行为。**两个 fail-closed 守卫**：① 「**0 用例不算通过**」——
   实测空目录时 runner 是 `ℹ tests 0` 且**退出码 0**，故入口自己遍历文件并强制用例数 ≥ 文件数；
   ② `test:canfail` 用必红夹具证明「测试真的会红」且**点名失败用例**。详见「CI 步骤」节的「测试框架」小节。
   > **实测基线（2026-10-14 收口时跑的，非推断）**：`npm run ci` → **`CI_EXIT=0`（14 步）**；
   > `npm run test` → **3 个用例文件 / 26 个用例全部通过**（`TEST_EXIT=0`；B3 加自批策略后由 16 → 26）；`npm run test:canfail` →
   > **4/4 ALL PASS**（`CANFAIL_EXIT=0`）。其中 canfail 的附注行**当场复现**了第 ① 条守卫的依据：
   > runner 自己对空目录是「退出码=0，用例数=0」—— 即那条守卫拦的是**真实存在**的假绿，不是假想需求。
   ② ~~**`kids_points_app` 口令改为部署注入**~~ → ✅ **已完成（2026-10-14，阶段 B2）** —— 口令已从仓库里**彻底移出**：
   `900_ledger_revoke.sql` 只建角色（`CREATE ROLE … LOGIN`，**不设口令**），口令改由新增的
   `prisma/sql/901_set_app_password.sql` 在部署时从环境变量注入（`-v app_password=…`），
   脚本开头是 fail-closed 守卫（变量缺失即 `RAISE EXCEPTION`，**不是**靠 `\quit` —— 实测 `\quit 1` 不支持退出码）；
   `.env.example` 占位符换成 `REPLACE_ME_BY_DEPLOY`；`npm run db:verify` 增补
   **P1a/P1b/P1c/P2/P3** 五条口令判据（非空 · 非占位值 · 长度下限 · 不与所有者口令复用 · 用户名必须分离）。
   > **实测基线（2026-10-14 收口时跑的，非推断）**：① 不带 `-v app_password` 跑 901 → **退出码 3**（守卫真的会失败，不是空承诺）；
   > ② 注入后**旧口令**（`change-me-before-production`）连接 → **`SQLSTATE 28P01` 认证失败**（口令确实换了）；
   > ③ 新口令跑 `db:verify` → **12/12 ALL PASS**（`DB_VERIFY_EXIT=0`，含 P1–P3）；
   > ④ 反向对照：把 `DATABASE_URL` 换回占位口令 → **P1b 变红并点名命中项**（`DB_VERIFY_EXIT=1`）；
   > ⑤ `npm run ci` → **`CI_EXIT=0`（14 步）**。
   > 顺带修掉一个**假绿**：实测脚本内 `RAISE EXCEPTION` 在**不带** `-v ON_ERROR_STOP=1` 时 psql 退出码**仍是 0** ——
   > 故 900 / 901 与全部文档命令一律补上 `ON_ERROR_STOP=1`（此前 900 第 ④ 段那句"让脚本失败"是空话）。
8. ~~**C1 · E18 ＋ D13 收口**~~ → ✅ **已完成（2026-10-12，提交 `24c5c73` → `4699518`）**：
   首启改为**空态**、生产闸门拆成**可测判据**（`demoResetAllowed()` ＋ 派生常量）、种子降级为**显式夹具**、
   D13 第 10 条断言改写；`run.js` **16/16**、`flutter test` **24/24**、`flutter analyze` **0 issue**、
   `defects:check` **18/18**，守门人 7 个篡改反例全部变红。
   **下一步**：**首启引导流程**（`04`）—— 空态目前**只渲染空列表，没有引导**，别把「空态」当成「引导已完成」；
   引导落地前，`04` 的能力清单仍是"未实现"状态。
9. ~~**C2 · `E15` ＋ `E17` ＋ `A2` ＋ `A3` 收口**~~ → ✅ **已完成（2026-10-12）**：
   双端同步把 `condition` / `dailyLimit` 升为**结构字段**，`detail` / `checked` / `limitText` / `doneText`
   全部降级为**派生值**；`run.js` **19/19**、`flutter test` **29/29**、`flutter analyze` **0 issue**、
   `defects:check` **18/18**、`backend npm run ci` ALL PASS；**证伪 6/6**（造假必红、还原必绿）。
   **两条诚实说明**（写进 `03` §0.2）：① 演示规则 `rule-3` 的「每周 1 次」在权威 schema 里**没有周期字段可表达**，
   结构字段化后落成 `dailyLimit: 1`，派生串变「每天 1 次」—— **真实语义变更**，不是漏改；
   ② `03` §A3 原公式只排除 `correction`，**漏了「已被冲正的原记录」**（撤销后界面仍显示已打卡），已修正。
   **遗留**：`rule-3` 的周频次要真支持，得先给后端 schema 加周期字段；`E16` **已收口（C3）**，`C9` / `C10` / `C11` **已收口（C4，2026-10-13）**，`D9` **已收口（C5，2026-10-13）** —— **`03` 队列清空**。
10. ~~**C5 · `D9` 收口**~~ → ✅ **已完成（2026-10-13）**：Flutter 数据层 `icon: IconData` → `iconName: String`
   （`Habit` / `PointRule` / `PointRecord`），名字的唯一事实收进 `lib/theme/app_icons.dart`
   （常量表 ＋ 映射表 ＋ `iconDataFor()` ＋ 兜底 `fallbackIcon` ＋ 白名单 `isKnownIconName()`）；
   两端 `addRule` 越界**拒绝**、渲染口对未登记的名字给 `unknown` 占位而不是空白；
   **新增闸门** `tools/icon-names-check.mjs`（`npm run icons:check`，接进 `npm run ci`）比对三份手抄名单。
   实测：`run.js` **27/27**、`flutter test` **41/41**、`flutter analyze` 0 issue、闸门 **7/7**、
   台账 **19/19**、`backend npm run ci` **`CI_EXIT=0`（9 步）**；证伪 **12 ＋ 3 ＋ 3** 例全红且点名。
   **两处诚实记录**：① **编辑规则不再允许改图标**（`RuleVersion` 快照无 icon 字段，允许改会让版本回放对不上）；
   ② D9 此前**从未进过台账**（只在 `06` §3.1 决策登记里），C5 补录时闸门立刻 fail-closed 报红 —— 见 `03` §0 说明。
   **下一步**：`D3b` → 阶段 D-b（`06` §3.1），以及 `04` 的**首启引导**仍未实现。
11. ~~**D-a · `D1b` 收口**~~ → ✅ **已完成（2026-10-13，见 `10-d1b-handoff.md`）**：
   `UserChildRelation.relation` 由自由字符串升为枚举 **`RelationKind`**（**father / mother / grandparent / other**，
   取值口径取自原 schema 注释）；迁移动了**手工一处** —— Prisma 默认生成的 `DROP COLUMN + ADD COLUMN`
   会**静默清空该列**（自带警告，有数据也不报错），改成 `ALTER COLUMN … TYPE … USING` 保数据转型
   （库里若有枚举外的值则**迁移当场失败**，而不是把列抹掉）；
   **新增闸门** `tools/relation-kind-check.mjs`（`npm run relation:check`，5 项，接进 `npm run ci` **第 8 步**）。
   实测：闸门 **5/5**、证伪 **15 例**（9 个反例各只点名自己 ＋ 3 个控制例 ＋ 真文件 sha256 未变 ＋ 清理后回绿）、
   `backend npm run ci` **`CI_EXIT=0`（10 步）**、真实库反向探针 `relation='sister'` **被枚举拒绝**
   （正向对照 `'father'` 只因**外键**失败）、迁移链 `seed → 900 → db:verify` **ALL PASS**（I5 仍生效）；
   前端未改动，复跑 `run.js` **27/27**、`flutter analyze` **0 issue**、`flutter test` **41/41**。
   **三条诚实记录**：① 闸门**首跑红在错的理由上**（它把迁移文件里"Prisma 原文是 DROP COLUMN…"的
   解释性注释当成了证据，补了只取可执行语句的 `stripSqlComments()`）；
   ② 证伪脚本首版**副本残留**，让"红"出现在别的检查上（"逐条点名"整个失效，加 `reset()` 才复现）；
   ③ 闸门 ④ 目前是**防将来**的 —— 仓库里 `relation` 字面量 0 处（后端 API 未开工）。
   **下一步**：`D3b`（`restrictions` 定形校验）→ 阶段 D-b。
12. ~~**D-b · `D3b` 收口**~~ → ✅ **已完成（2026-10-13，见 `11-d3b-handoff.md`）**：`ChildMember.restrictions`（裸 `Json`）**定形** ——
   权威形状收进 `backend/src/contracts/member-restrictions.ts`（**类型** `ChildMemberRestrictions`：三键全可选
   ＋ **运行时守卫** `validateRestrictions()`：`plainToInstance` ＋ `whitelist` ＋ `forbidNonWhitelisted`，
   未知键 / 错类型 / 越界**一律拒**），配 `backend/scripts/check-restrictions.ts` 的 **A/B 两段式离线自检**
   （`npm run restrictions:check`，接进 `npm run ci` **第 9 步** ⇒ **11 步**）与闸门 `tools/restrictions-check.mjs`（**6 项**）。
   实测：自检 **5/5**、闸门 **6/6**、`backend npm run ci` **`CI_EXIT=0`（11 步）**；
   证伪 **14 反例（每个只点名自己那一项）＋ 3 控制例 ＋ 3 收尾（真文件 sha256 未变 / 清理副本后回绿 / 副本已删）= 20 行 PASS**。
   **三条诚实记录**：① 自检首跑**红在 B2 断言过严**（一个坏值可同时违反 `@IsInt` 与 `@Min`，
   改成"错误只点名那个键"而非"恰好 1 条"，并顺手修掉一处 TS 收窄错误 —— 都在**自检脚本**里，不在产品代码里）；
   ② `02` §3 代码块原有 `...`（"可能还有别的键"）与"形状封闭"**语义冲突**，本轮**去掉**并写明三处手抄的对账口径
   —— 这是**口径修正**，不是漏改；③ 守卫此刻**还没有被任何写入路径调用**（`backend/src` / `lib` / `test` /
   `kids_points_mp/src` 里 `restrictions` 命中**各 0 处**；另 32 处命中在 `kids_points_mp/node_modules/**` 第三方类型里），
   闸门是**防将来**的：别把绿灯读成"屏障三已验收"。
   **下一步**：`04` 的**首启引导**（仍是空白）／ `tools/**` 工具职责地图。
13. **原型的「同源契约」尚未被闸门守着**（2026-10-14 与 PRD / 原型同批入库时**如实记录**）：
   `prototype/README.md` §3 声称配色 / 字号 / 图标 / 派生文案 / 初始数据「**全部照抄仓库**」，
   但 `prototype/verify.mjs` **只读 `prototype/` 自身**（`index.html` ＋ `app.js`），断言的是**写死的期望值**；
   而 `tools/icon-names-check.mjs` 只对账 **Taro / Flutter / 后端三份**手抄名单 —— **原型是第四份，不在覆盖内**。
   实测四组未对账面（只读探针 `tools/_scratch/e1-probe.mjs` 可复跑）：① 图标 `ICONS` 键集合
   （原型 29 项 = `kids_points_mp/src/components/Icon/icons.ts` 29 项，**当前相等但无人守**）；
   ② 6 个派生文案函数（原型 ↔ `kids_points_mp/src/data/types.ts`，行号 L508/541/546/627/658/671）；
   ③ 色板 `vars.scss` ↔ `prototype/styles.css`（24 vs 23，同名值全等，差 4 条待逐条判定）；
   ④ PRD §7 的 **25 动作** ↔ `contracts/permission-matrix.json`（PRD 自称"唯一事实源"，实为第二份手抄）。
   **下一步**：新增 `tools/prototype-check.mjs`（fail-closed ＋ 可逐条证伪）并接进 `npm run ci`（**11 → 12 步**），
   同时把 `prototype/verify.mjs` 纳管。本轮的下手包：`tools/_scratch/next-session-e1.md`（**临时物，不入库**）。
   另注：`prototype/app.js` 是**严格模式 IIFE、零对外出口**，派生函数外部调不到 —— 做行为对账前需先加只读出口。
   **⏸ 优先级：用户已明确「暂缓执行」（2026-10-14）** —— 理由：它**不是产品功能**、**不阻塞任何开发**
   （已实测：`backend/package.json` / `tools/**` / `backend/scripts/**` 对 `prototype/` 的引用**为 0**，`npm run ci` 仍 11 步）。
   **触发条件（满足任一条就应当捡起）**：① 有人**照着 `prototype/` 去实现小程序 UI**（W4/W5 前后）；
   ② 改动 `kids_points_mp/src/components/Icon/icons.ts`、`src/styles/vars.scss`、`src/data/types.ts` 的
   图标 / 色板 / 派生文案；③ 改动 `contracts/permission-matrix.json`。**在那之前不必做**。
14. **「谁可以批准」（自批）—— 用户已裁定，契约已定形（2026-10-14，阶段 B3）**：
   原状是**功能死锁**、不是安全漏洞：`redeem` 对两端都是 `REQUIRE_APPROVAL`，
   但"批准人资格"全仓**无定义**（矩阵只回答"哪个角色能**发起**"，`02` §4.1–§4.4 只回答"状态怎么走"）——
   **单家长家庭**（只有一位 `guardian`）提交兑换后**没有任何人能批准** → 永远 `pending` → 到期被 `expired` 扫掉。
   用户裁定：**允许申请人自批，但自批必须是一次「显式动作」** —— ① 两步式（提交后**本人**二次确认）
   或 ② 一步式（申请时勾选"自动审批"，`autoApprove: true`）；界面"弹窗"与"勾选"都只是这两种形态的皮。
   **未勾选 / 缺字段一律 `pending`** —— 不存在"只有一位家长就自动批准"的特例（那会让同一 API
   随家庭人数改变安全语义，且审计里出现没有人点过同意的批准）。
   判据收进 `backend/src/contracts/approval-policy.ts`（`canReview` / `canSelfApprove` /
   `decideRequestOutcome` / `canDecide` / `isSelfApproved`）—— **完全由矩阵导出**，不新增第三处名单；
   孩子与 `viewer` 不能自批（`review_approvals` 为 `DENY`）；没资格却传 `autoApprove` →
   `400 SELF_APPROVAL_NOT_ALLOWED`（**不静默忽略**，同 `restrictions` 的多余键拒绝口径）。
   **不新增字段 / 枚举 / 迁移**：自批由 `decidedByUserId == requesterUserId` 判定（同 D4 口径），
   审计动作名 `approval.self_approved`（`AuditLog.action` 本就是自由字符串）。
   文档同步：PRD §14.1 **P4** ／ FR-04 ／ FR-08（验收 9.25–9.27）／ §7 注 ／ §15.1–§15.3；
   `02` **§4.5** ／ §9（9.25–9.27）。用例：`backend/test/approval-policy.test.ts`（10 条，全套 26/26）。
   > **实测基线（2026-10-14 收口时跑的，非推断）**：`npm run test` → **3 个用例文件 / 26 个用例全通过**；
   > **两条反向对照**（改完即还原，`sha256` 复原：`927dcc84…`）：
   > ① 把「不勾选就不批」改成真值判断 → 第 1 条用例**变红并点名**（`autoApprove=1` 被误判成显式勾选）；
   > ② 拿掉 `canReview()` 资格检查（孩子也能自批）→ **2 条变红**（"孩子永远不能自批" ＋ "资格完全由矩阵导出"）。
   > `npm run ci` → **`CI_EXIT=0`（14 步）**。
   **遗留（W1 必做）**：审批写入路径（含自批）落地时**必须消费** `approval-policy.ts`，
   不得在 controller / service 里另写一份判定；`02` §4.5 的六条硬约束要逐条落成 HTTP 用例。
   **✅ 已推进（阶段 B4，2026-10-14）**：HTTP 路径建成并**真实消费** `approval-policy.ts` —— 见下面第 15 条。

15. ~~**「谁可以批准」的 HTTP 路径**~~ → ✅ **已完成（2026-10-14，阶段 B4）**：审批从「契约」走到「线上路径」——
   `POST /approvals`（**202** pending ／ **201** 自批 ／ **400** 没资格却要自批）与
   `POST /approvals/:id/decide`（200 ／ 403 无批准资格 ／ 409 已决 ／ 404 没有这条），
   判定**完全消费** `backend/src/contracts/approval-policy.ts`（`approvals.service.ts` 内**零角色判断**），
   用例 `backend/test/approvals-http.test.ts`（**真起 Nest 服务 + 真发 HTTP 请求**，26 条）。
   全局管道经 `backend/src/app.setup.ts` 的 `applyGlobalPipes()` 装配（`main.ts` 与测试**同一函数**）。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **4 个用例文件 / 52 个用例全通过**；
   > **四条证伪**（改完即还原，`sha256` 复原：`b9ca4232…` / `7d3eea13…` / `e266d449…` / `d02c9be9…`）：
   > ① 关掉 `ValidationPipe` 的白名单 → 「未知键 → 400」**变红并点名**；② 在 service 里硬编码
   > 「child 一律不能自批」→ 「唯一事实源：改矩阵行为必须跟着变」**变红并点名**；
   > ③ 让默认仓储「假装成功」→ 「501 fail-closed」**变红并点名**；④ 让 `tsc` 少产出一个测试文件 → 新守卫**变红并点名**。
   > `npm run ci` → **`CI_EXIT=0`（14 步）**。
   > **真实应用探针（同日，`node dist/main.js` —— 真实 AppModule ＋ 真实 Prisma ＋ 真实全局管道，非测试替身）**：
   > 合法请求（guardian / redeem 未勾选）→ **501 `APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`**；孩子要自批 → **400 `SELF_APPROVAL_NOT_ALLOWED`**；
   > 带多余键 `foo` → **400**；缺身份头 → **401 `UNAUTHENTICATED`**；启动日志含
   > `Mapped {/approvals/:id/decide, POST}` 与 `数据库已连接`。脚本 `tools/_scratch/b4-live-probe.sh`（可复跑）。
   **两条硬事实（本轮实测得到，都会咬人）**：① **测试入口从 `tsx` 换成「先 `tsc` 真编译再跑」**——
   esbuild/tsx 对**不在 tsconfig `include` 内**的文件连装饰器都不转译
   （`Parameter decorators only work when experimental decorators are enabled`）；挪进 `include` 后**更糟**：
   `ValidationPipe` 因缺 `emitDecoratorMetadata` 而**静默整体失效**（实测 `{action:'redeem', foo:1}` 返回 **201**）。
   现在 `tsc -p tsconfig.test.build.json` → `.tmp_test_build/` → 再跑（metadata 与生产同一套）；
   ② 新增守卫：**源码测试文件数 == 编译产物文件数**（少一个即红并点名），
   防「文件静默没编译出来 ⇒ 静默没跑」（与 D12 同类）；`--test-concurrency=1` 同时定死「共享状态不许并发」。
   **两条诚实记录**：① **落库 / 账本流水 / 审计写入仍未落地** —— `ApprovalsPort` 的默认实现是
   **显式 501**（`APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`），组 A 的 4 条用例专门钉住「不许假装成功」；
   ② ~~身份是**临时口径**（`x-kp-role` / `x-kp-user-id` 头）~~ ✅ **已由 W1-C 删除**
   （`src/device-session/temporary-role.guard.ts` **本仓库已无此文件**，见第 18 条）。
   **下一步**：~~W1 剩余两段（身份 ＝ `DeviceSession`；屏障一／三）~~ → 两段均已完成（第 17／18 条）→
   **W2**（账本内核 ＋ `ApprovalsPort` ／ `MembershipPort` ／ `DeviceSessionPort` 的 Prisma 实现）。
   > ★ 后续：其中「**屏障一／三**」已由 **W1-B（2026-10-15）** 完成（第 17 条）、
   > 「**身份**」已由 **W1-C（2026-10-15）** 完成（第 18 条）。

16. ~~**权限矩阵没有调用者（屏障二只是注释）**~~ → ✅ **已落地（2026-10-14，阶段 W1-A）**：
   `PERMISSION_MATRIX` 此前**没有任何请求路径会查它**（`resolveVerdict` 只被单测调用）——
   一张没人查的权限表等于注释，它不会拦住任何人。现在接上**唯一一个**消费点：
   `backend/src/permissions/permissions.guard.ts`（`PermissionsGuard` ＋ `@RequireAction('动作名')`），
   判定**全部**来自矩阵（guard 内**零**角色名单）。三值语义按 `02` §3：
   `ALLOW` → 放行；`DENY` → **403 `FORBIDDEN`**；`REQUIRE_APPROVAL` → **403 `APPROVAL_REQUIRED`**；
   **端点漏标** → **403 `NO_ACTION_DECLARED`**；`viewer` ／未知动作 → `DENY`（继承 D6）。
   挂载点是**控制器级** `@UseGuards(TemporaryRoleHeaderGuard, PermissionsGuard)` ——
   （★ W1-C 之后写成 `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`，
   第 1 位换成了**服务端会话解析**，见第 18 条。）
   **不是** `APP_GUARD`：Nest 的 Guard 顺序是「全局 → 控制器 → 方法」，全局注册会让屏障二
   **先于**身份解析执行（拿到空 `actor`）；数组顺序（身份在前）同理，写反即**响亮失败**。
   `Actor` / `RequestWithActor` 随之从临时头文件迁到 `src/permissions/actor.ts`
   （类型搬家与行为变更分成两次 diff：W1-C 删临时 Guard 时不会牵动审批模块）。
   用例 `backend/test/permissions-guard.test.ts`（**真起 Nest ＋ 真发 HTTP**，16 条）＋
   **改掉一条旧断言**：`approvals-http.test.ts` 里「viewer 传 `autoApprove` → 400」现在由屏障二在
   **更外层**拦成 **403**（拦得更早，**不是覆盖丢失**：policy 层的 viewer fail-closed
   仍由 `approval-policy.test.ts` 的纯函数用例钉着）。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **5 个用例文件 / 68 个用例全通过**；
   > `npm run ci` → **`CI_EXIT=0`（14 步）**。**六条证伪**（`tools/_scratch/w1a-canfail.mjs`，
   > 改完即还原、逐条 `sha256` 复原）：① 让矩阵的 `DENY` 对 `review_approvals` 失效 →
   > 「child DENY ⇒ 403」**变红并点名**；② 让 `viewer` 从 `DENY` 变回 `ALLOW` → 「viewer 一律 403」**红**；
   > ③ 让 `REQUIRE_APPROVAL` 对 `add_wish` 失效 → 「403 `APPROVAL_REQUIRED`」**红**；
   > ④ 在 guard 里硬编码一份名单 → 组 D「改矩阵 ⇒ 行为必须跟着变」**红**；
   > ⑤ 删掉 controller 上的 `@RequireAction` → 「child 批准 ⇒ 403」**红**；
   > ⑥ 让 `@RequireAction` 写入 `undefined` → 「双角色 `ALLOW` 都放行」**红**。
   > **证伪的两个前提（本轮实测得到，会咬人）**：① **变异必须编译得过** —— `false && …` 会让整块
   > 不可达、`actor` 的类型收窄随之丢失，`tsc` 报 **`TS18048`** 而**测试根本没跑**
   > （于是"点名"断言失败；那也是 `run-tests.mjs`「编译不过就拒绝跑测试」那道守卫真生效的证据）；
   > ② 组 D 的手法是**运行期改矩阵对象**（`as const` 只管类型层）—— 这是「矩阵之外不得有第二份判定」
   > 唯一能被证伪的方式。
   **仍未落地（不粉饰，与"已完成"分开记）**：① ~~**屏障一**（成员资格门 `MembershipModule`）无调用者~~
   ／ ② ~~**屏障三**（`member-restrictions.ts` 的 `stricter()`）**未接入任何请求路径**~~
   → 两条均由 **W1-B 接线**（见下面第 17 条）；③ ~~actor 仍是**临时头**（`x-kp-role`）——
   **屏障二是真的，「我是谁」目前还是假的**~~ ✅ **已由 W1-C（2026-10-15）修掉**（第 18 条）：
   actor 现在来自**服务端会话行**，`x-kp-role` / `x-kp-user-id` 已废弃且不再被读取。
   **下一步**：~~W1-B（屏障三接线 ＋ 成员资格门）~~ → ✅ 见第 17 条；~~下一段是 **W1-C**（`DeviceSession`，随后删临时 Guard）~~ → ✅ 见第 18 条。

17. ~~**屏障一（成员资格门）无调用者 ＋ `stricter()` 未接进请求路径**~~ → ✅ **已落地（2026-10-15，阶段 W1-B）**：
   三道屏障**都接在同一条请求路径上**了。此前 `MembershipModule` 是**空壳**（全仓零调用者）、
   `stricter()` **没有任何调用者** —— 也就是："这个人跟这个孩子有没有关系"从来没人问过
   （只要角色头合法，就能对**任意** childId 走矩阵），而家长为单个孩子配的限制**配了等于没配**
   且**没人看得见**。
   **落地物**：`backend/src/membership/` 三件套（`membership.gate.ts` 纯函数判定内核 ＋
   `membership.repository.ts` 端口/令牌/默认 501 ＋ `membership.guard.ts` 守卫）
   ＋ `contracts/member-restrictions.ts` 新增 `tightenVerdict()`（消费 `stricter()`，
   即**屏障三的判定核**，且**只能更严**在代码形状上就成立）
   ＋ `permissions.guard.ts` 换成 `tightenVerdict(矩阵判定, member.restrictions, …)`。
   **守卫链（数组顺序即语义）**：`@UseGuards(TemporaryRoleHeaderGuard, MembershipGuard, PermissionsGuard)`
   （★ 第 1 位已由 **W1-C** 换成 `DeviceSessionGuard`，见第 18 条。）
   —— 身份 → **资格** → **矩阵＋成员级收紧**；`ApprovalsModule` 随之接入 `MembershipModule`。
   ★ 实测坑：`@UseGuards(类)` 时 Nest 在**宿主模块**上下文里实例化守卫，
   所以 `MembershipModule` 必须**导出端口令牌**（只导出 Guard 会直接
   `Nest can't resolve dependencies of the MembershipGuard (?) … Symbol(MEMBERSHIP_REPOSITORY)`）。
   **两条新的 fail-closed（都可执行断言）**：① `kpMember` 缺失 ⇒ `PermissionsGuard` **抛错（500）**
   ——"没查" ≠ "查了没有限制"；② 成员位 `restrictions` 形状坏了 ⇒ **500 `INVALID_MEMBER_RESTRICTIONS`**
   （**数据坏了 ≠ 没权限**）—— D3b 的 `validateRestrictions()` 至此才有了**请求路径上的**调用方。
   **身份从两个头变三个头**：新增 **`x-kp-child-id`**（屏障一的必要输入；它是 `DeviceSession.childId`
   的临时替身），缺任一个头 → **401**（缺孩子上下文**绝不**退化成"跳过检查"）。
   **两条旧断言的行为变更（都改在明处，不是漂移）**：`approvals-http.test.ts` 与
   `permissions-guard.test.ts` 里 viewer 的 403 码由 `FORBIDDEN` 变为 **`MEMBER_NOT_FOUND`** ——
   `viewer` 不是任何孩子的成员位，所以他在**屏障一**就被拦下（屏障一先于屏障二，02 §3）；
   "viewer 在矩阵里无列 ⇒ DENY" 仍由 `permission-matrix.test.ts` 的纯函数穷举钉着。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **7 个用例文件 / 98 个用例全通过**
   > （W1-A 之后是 5 / 68；新增 `membership-gate.test.ts` 8 条、`membership-http.test.ts` 16 条、
   > `member-restrictions.test.ts` +6 条屏障三内核用例，含 §9.22 的**穷举** 25 动作 × 2 角色 × 6 限制 × 5 金额）；
   > `npm run ci` → **`CI_EXIT=0`（14 步）**；**六条证伪**（`tools/_scratch/w1b-canfail.mjs`，
   > 改完即还原、逐条 `sha256` 复原，`ALL PASS`）：① 让"查不到成员位"变成编造一个成员 →
   > 「非成员 ⇒ 403」**红**；② 让"已移除"不再被拒 → 「removed ⇒ 403」**红**；
   > ③ 让 `childCannotAddWish` 失效 → 「add_wish 被收紧」**红**；④ `stricter()` 写丢 →
   > 「§9.22 方向性（穷举）」**红**；⑤ 让裸 `Json` 形状校验失效 → 「形状坏了 ⇒ 500」**红**；
   > ⑥ 把 childId 写死 → 「childId 真的参与判定」**红**。
   > **真装配复验（`tools/_scratch/w1b-live-probe.sh`，真 AppModule ＋ 真 Prisma ＋ 真全局管道）**：
   > 三个头齐全 → **501 `MEMBERSHIP_QUERY_NOT_IMPLEMENTED`**；缺 `x-kp-child-id` → **401**；
   > 无身份头 → **401**；多余键 → **501**（Guard 在管道之前，屏障一的 501 盖住管道的 400 ——
   > 成员查询落地后回到 400）；启动日志含 `Mapped {/approvals/:id/decide, POST}` 与 `数据库已连接`。
   > **证伪的坑又踩了一次（值得记住）**：① 号变异原本写成在 guard 里加 `&& verdict.code !== 'MEMBER_NOT_FOUND'`
   > —— **编译不过**（它破坏 `verdict` 的类型收窄，DENY 分支没有 `.row`，`tsc` 报 TS2339），
   > runner 直接拒绝跑测试 ⇒ 表现为"没点名"。**W1-A 已记录过同一条教训**，本轮复现一次，
   > 于是把该条改成动**判定内核**（能编译、且正是要防的"查不到就跳过"）。
   **仍未落地（不粉饰，与"已完成"分开记）**：① **成员位仍是端口 + 内存替身**
   —— 默认实现是 **501**（真装配下**没有人**被放过去，但它也**还没真的查过库**；真 Prisma 适配器属 W2，
   理由：`MembershipModule` 一注入 `PrismaService`，**无库 CI 会在启动阶段就崩**）；
   ② **`requireApprovalForBonusOver`（金额阈值）在 HTTP 路径上不生效** —— 金额属 dispatcher 的 payload
   （02 §6 未落地），有一条用例**把这个现状钉住**；三条限制键**都不**作用于 `request_approval`
   ⇒ **屏障三在 `/approvals` 上结构性不生效**（HTTP 层用同一套守卫链的探针端点验证）；
   ③ `POST /approvals/:id/decide` 用的是**请求头里的** childId，**尚未**与审批行自己的 childId
   做同源校验（要等 `ApprovalRow` 带上它）—— 即跨家庭推进审批这条路径**还没堵**；
   ④ ~~actor 仍是**临时头**（三个）—— **三道屏障都是真的，「我是谁」目前还是假的**~~ →
   ✅ **已由 W1-C 修掉**（第 18 条）：actor 改由**服务端会话行**给出。
   **下一步**：~~W1-C（`DeviceSession`：把"我是谁 / 对哪个孩子"由服务端确立，随后删临时 Guard）~~ → ✅ 见第 18 条 →
   W2（账本内核 ＋ `ApprovalsPort` / `MembershipPort` / `DeviceSessionPort` 的 Prisma 实现）。

18. ~~**角色 / 身份由客户端自报（临时头）**~~ → ✅ **已落地（2026-10-15，阶段 W1-C）**：
   W1-A / W1-B 之后三道屏障**都是真的**，但它们的共同输入 `actor` 来自**客户端自己发的头**：
   发 `x-kp-role: guardian` 就是家长、发谁的 `x-kp-user-id` 就是谁（`02` §7 早就写明"不存客户端"的理由：
   小程序 storage 可直接改）。于是"屏障拦得对不对"**没有人验证过** —— 拦住一个**自称**是家长的人，
   与拦住一个**真的**是家长的人，是两件事：**屏障是真的，「我是谁」是假的**。
   **落地物**：`backend/src/device-session/` 三件套 —— `session.gate.ts`（**纯函数**判定内核：
   `resolveSession()` / `effectiveRole()` / `toSessionActor()`）＋ `device-session.repository.ts`
   （端口 `DeviceSessionPort` ＋ 令牌 ＋ 默认 **501**）＋ `device-session.guard.ts`（`DeviceSessionGuard`）。
   **守卫链第 1 位换人**：`@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`
   —— 顺序仍**载荷**（写成 `APP_GUARD` 会让屏障先于身份跑、拿到空 actor，理由同 W1-A）。
   **身份从"三个自报头"变成"两个头 ＋ 一次服务端查询"**：客户端只被允许回答
   `x-kp-device-id`（哪台设备）＋ `x-kp-child-id`（哪个孩子的档案）；**角色与 userId 由会话行给出**；
   `temporary-role.guard.ts` **已删除**（`src/device-session/` 下已无此文件）。
   **口径（对齐 `02` §7 / §9.19）**：缺任一个头 ⇒ **401 `UNAUTHENTICATED`**（含重复头 / 空串）；
   会话**查不到** ⇒ **401 `SESSION_NOT_FOUND`**（★ 不默认成匿名 child —— 那会让整条权限链变成可选）；
   `guardian` 会话**过期 ⇒ 角色回落 `child`**（**降级不是拒绝**：过期判 401 会把 TTL 变成故障，
   孩子连"看自己积分"都做不了）；**形状坏 ⇒ 500**（`INVALID_SESSION_ROLE` / `INVALID_SESSION_EXPIRY` /
   `SESSION_CHILD_MISMATCH`），与 401/403 严格分开 —— **数据问题不该被当成权限问题排查**。
   ★ TTL 边界（`expiresAt === now` 即过期）在 `session.gate.ts` **一处**定死。
   ★ `SESSION_CHILD_MISMATCH` 是**留给适配器的守卫**：`(deviceId, childId)` 是查询键，
   适配器若忽略 `childId`（只按 deviceId 查），返回的行就会与请求对不上、当场 500（④ 证伪专盯它）。
   **两条 fail-closed（都可执行断言）**：① 端口默认实现**显式 501**
   （`SESSION_LOOKUP_NOT_IMPLEMENTED`）⇒ 默认装配下**每个请求都拒绝**；② `NODE_ENV=production` ⇒
   **503 `IDENTITY_NOT_IMPLEMENTED`**（★ 故意保留：角色/身份的**来源**可信了，
   但**设备凭据仍不可验证** —— `x-kp-device-id` 谁都能报 ⇒ 可冒充别人的会话；解药是 L2 之后的会话 token）。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **9 个用例文件 / 144 个用例全部通过**
   > （W1-B 之后是 7 / 98；新增 `session-gate.test.ts` **22 条**、
   > `device-session-http.test.ts` **22 条**，迁移后的 `approvals-http.test.ts` 27 条 /
   > `permissions-guard.test.ts` 17 条 / `membership-http.test.ts` 16 条；
   > 逐文件数字取自 `node --test <单个产物文件>` 的汇总行，九个文件相加 **= 144**，与 runner 汇总一致）；
   > `npm run ci` → **`CI_EXIT=0`（14 步）**；**六条证伪**（`tools/_scratch/w1c-canfail.mjs`，
   > 改完即还原、逐条 `sha256` 复原，`ALL PASS`）：
   > ① 让"查不到会话"变成放行（编造一份会话）→ 「`SESSION_NOT_FOUND`」**红**；
   > ② 让客户端自报的 `x-kp-role` **重新生效** → 「自报角色无效」**红**（本阶段的核心回归）；
   > ③ 让 TTL 到期**不**降级 → 「§9.19 过期 ⇒ 回落 child」**红**；
   > ④ 关掉 `childId` 同源校验 → 「`SESSION_CHILD_MISMATCH`」**红**；
   > ⑤ 让端口默认实现返回**假会话**而不是 501 → 「默认装配 fail-closed」**红**；
   > ⑥ 拆掉生产闸门 → 「生产 ⇒ 503」**红**。
   > **真装配复验（`tools/_scratch/w1c-live-probe.sh`，真 AppModule ＋ 真 Prisma ＋ 真全局管道，6 条全中）**：
   > 设备＋孩子上下文齐全 → **501 `SESSION_LOOKUP_NOT_IMPLEMENTED`**；**只发 W1-A/W1-B 的三个自报头
   > （不发设备头）→ 401**（自报角色**不再是身份**）；自报 `guardian` ＋ 设备头齐全 → 仍是 501；
   > 缺 `x-kp-child-id` → 401；无头 → 401；`NODE_ENV=production` → **503**。
   > ★ 与 W1-B 的探针**对照着看**：同一条请求的 501 **换了名字**（`MEMBERSHIP_*` → `SESSION_*`）——
   > 这是"身份层现在排在屏障一**之前**"的**可观测**证据（而不是注释里的一句声明）。
   > **证伪的坑第三次出现（三条记录已一致）**：④ 号变异原本写成 `if (false && row.childId !== requestedChildId)`，
   > `tsc` 报 **TS18047**（`row` 的**非空收窄**被字面量 `false` 短路掉，`row.deviceId` 变成 possibly null）
   > ⇒ 编译不过 ⇒ runner 拒绝跑测试 ⇒ 表现为"没点名"。W1-A 是 `TS18048` / W1-B 是 `TS2339`，
   > 三次都栽在**同一条**纪律上：**变异必须先确认能编译**（改用"永假比较"`row.childId.length < 0` 后立刻变红）。
   **仍未落地（不粉饰，与"已完成"分开记）**：① **会话查询的实现** ——
   `DEVICE_SESSION_REPOSITORY` 默认实现是 **501**，真 Prisma 适配器属 **W2**
   （同一取舍：一注入 `PrismaService`，**无库 CI 会在启动阶段就崩**）；
   ⇒ **"身份由服务端确立"说的是机制，不是"已经能登录了"**；
   ② **凭据未认证** —— `deviceId` 不可验证 ⇒ 生产 503（**"身份层已完成"这句话现在还不能说**，
   能说的是"**角色不再由客户端自选**"）；
   ③ **PIN 切换 / 锁 15 分钟 / 审计 / 会话刷新（`02` §7 那四行）全都未实现** ——
   没有"切家长模式"端点，`pinHash` / `pinLockedUntil` 至今无人使用；
   ④ `POST /approvals/:id/decide` 的**跨家庭推进仍未堵**（用的是请求里的 childId，
   与审批行自己的 childId 尚未同源校验）—— 会话层只解决了**一半**。
   **下一步**：W2（账本内核 ＋ 三个端口的 Prisma 实现：`Approvals` / `Membership` / `DeviceSession`）。

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

**本轮 B4（2026-10-14，实测暴露 1 处 —— 这一处是**文档自己写反了**）**

| # | 缺陷 | 若不修正的后果 |
|---|---|---|
| 18 | 本文「测试框架」节（B1 写下）断言 **「`tsx`：带装饰器的契约能加载、且元数据真的生效」** | 成立的部分**只有**「离线自检能跑」（`validateRestrictions()` 直接调 `plainToInstance` ＋ `validate`，约束由装饰器自身注册，**不需要** `emitDecoratorMetadata`）。一旦外推到 **Nest 的 HTTP 路径**，`ValidationPipe` 会**静默整体失效**（实测多余键返回 **201**），而测试照样全绿。已改为「先 `tsc` 真编译再跑产物」 |

> 它与 3–17 的性质不同：**不是「没验证」，而是「验证了一半就外推」**。
> 两个都叫「装饰器元数据」，但一个是 class-validator 自己的约束注册，另一个是 TypeScript 的
> `design:paramtypes` —— **同名不同物**，恰好是最难自查的一类。

### CI 步骤

**后端 —— 已落地为一条命令**（`backend/`）：
```
npm run ci
= prisma:validate → typecheck → typecheck:tests → typecheck:tools → honesty:probe
  → defects:check → templates:check → icons:check → relation:check → restrictions:check
  → test → test:canfail → build → contracts:emit          （共 14 步）
```
> **勘误（2026-10-14 补齐）**：上面这一行原写于 W0（9 步），此后 D-a 加 `relation:check`、D-b 加 `restrictions:check`、
> 阶段 B1 加 `typecheck:tests` / `test` / `test:canfail` —— 只有待办条目被更新，**这行代码块没跟上**。
> 现已按 `backend/package.json` 的 `ci` 脚本**逐字重抄**。凡是"链式命令写在文档里"的地方，都会这样漂移 ——
> 所以真实基线**以 `npm run ci` 的输出为准**，不以本行为准。

其中 `honesty:probe` 自带 4 项检查（A/B 是**注入式诚实性对照**，C/D 是结构性守卫）：

- **D12 回归守卫**：扫描测试运行器的花括号嵌套深度，确认汇总与 `process.exitCode`
  **不在任何回调内部**（该探针已用夹具 `__fixtures__/d12-misnested-runner.js`
  证明**能失败** —— 否则它自己就会变成下一处假绿）
- **ActionType 契约漂移守卫**：`permission-matrix.ts` 与 Prisma `enum ActionType` 必须逐一对应
- **图标名跨端契约守卫**（`npm run icons:check` → `tools/icon-names-check.mjs`，**阶段 C5 新增，修 D9**）：
  Taro `ICONS` ／ Flutter `appIcons` ／ 后端 `ICON_NAMES` 三份**手抄**名单必须**逐字相等**
  （Flutter 与后端都无法 import 小程序的 TS），另查「数据层不得存字形、调用处不得写死名字、
  渲染点各只一处、兜底与写入口白名单都被接上」共 7 项。已用 **12 例注入式证伪**（含 2 例 fail-closed）证明每项都能单独变红。
  手抄名单会漂移，而漂移的表现是「某个图标在某一端悄悄变成占位」—— 三端的编译器都不会说一句话。

另有 **缺陷台账对账守卫**（`npm run defects:check` → `tools/defect-status.mjs`，**2026-10-12 新增**）：
`03` §0 的 19 条状态声明逐条拿到代码里验证 —— 「已修」却找不到修复痕迹、或「未修」其实早已修好，都判红
（**后者正是那 8 条失实的病**）。**证据只取代码、注释不算**：否则注释里那句「原先 `xxx` 如何错」
会让两侧同时被骗（本工具首跑就因此误报 2 条：A1 / A5）。已用 **7 份被篡改的台账副本**证明能变红
（谎称已修 / 谎称未修 / 删行 / 伪造新增行 / 改表头列名），并以「调换列顺序仍正确」证明它**按表头定位列**、不写死列号。
**C1 又加了 7 个反例重验一遍**（谎称未修 / 谎称半修 / 删行 / 伪造新增行 / 改表头列名 ＋ **2 处代码回退**：
把首启改回注入 seed、把守卫常量改回字面恒真）—— 7/7 全部变红，还原后重回全绿（`tools/_scratch/c1-tamper.mjs`，可复跑）。
> 反例本身也要证伪：第一版「伪造新增行」反例隔了空行，被解析器按"表格已结束"正确忽略 —— **绿的是我的反例，不是守卫**；
> 改成紧贴末行后才复现。写反例时踩的坑，恰好说明"绿"必须能被解释。

**测试框架（阶段 B1 新增，2026-10-14）—— 用 Node 内置 runner，**零新增依赖**：

```
npm run test             # = node scripts/run-tests.mjs（遍历 test/**/*.test.ts → tsc 真编译 → 跑**产物**）
npm run typecheck:tests  # = tsc --noEmit -p tsconfig.test.json（转译器**不做类型检查**，必须单独 typecheck）
npm run test:canfail     # = node scripts/test-can-fail.mjs（证明「测试真的会红」）
```

选型依据是**实测**（Node v26.10.0，2026-10-14），不是偏好：

| 方案 | 实测结果 |
|---|---|
| 原生 `node --test`（Node 26 类型剥离） | ❌ 连模块都解析不了（`ERR_MODULE_NOT_FOUND`：本仓库是 CJS ＋ 无扩展名导入） |
| jest / vitest | 需新增依赖；且 TS **6.0.3** 很新，`ts-jest` 一类存在版本兼容风险 |
| **`node:test` ＋ 既有 `tsx`** | ⚠️ **只对「不碰 Nest 容器」的代码成立** —— 本行原写「元数据真的生效」，**已被 B4 实测证伪**（见下） |
| **`node:test` ＋ 先 `tsc` 真编译、再跑产物**（**B4 起采用**） | ✅ 装饰器与 `emitDecoratorMetadata` 与生产**同一套**；仍是零新增依赖（用仓库自带 `typescript`） |

**★ B4 更新（2026-10-14）：为什么入口必须「先真编译」** —— 三件事都是实测（Node v26.10.0）：

1. **tsx 对不在 `tsconfig.include` 内的文件，连装饰器都不转译**：同一份带 `@Controller()` / `@Body()`
   的文件放 `backend/` 根 → `Parameter decorators only work when experimental decorators are enabled`；
   放进 `src/`（include 内）→ 能跑。**同一文件、两种命运。**
2. **挪进 include 之后更危险**：`ValidationPipe` **静默整体失效** —— `{action:'redeem', foo:1}`（多余键）
   与 `{action:'nope'}`（非法枚举）**都返回 201**。根因：esbuild **不产出 `emitDecoratorMetadata`**，
   Nest 拿不到 `design:paramtypes` ⇒ 判不出「这个参数要不要校验」⇒ 整体跳过且**不报错**。
   注意它的失败形态：**不会红，只会什么都不做。**
3. 故 `run-tests.mjs` 现在是 `tsc -p tsconfig.test.build.json`（`src` ＋ `test` → `.tmp_test_build/`，
   **每次先 rm 重建**，绝不复用旧产物 —— 同本文件「完整流水线」里 `run.js` 那条的理由），再在**产物**上跑；
   并新增守卫：**源码 `*.test.ts` 数 == 编译产物 `*.test.js` 数**（少一个即红并点名），
   防「文件静默没编译出来 ⇒ 静默没跑」（与 D12 同类）。
   > 代价：`npm test` 每次多一次全量 `tsc`（本机约 2 秒量级）—— 换来「测的就是要上线的东西」。

**两个 fail-closed 守卫**（都是因为实测发现「绿得不诚实」才加的）：

1. **0 用例不算通过**：实测 `node --import tsx --test <空目录>`（以及只含 `*.spec.ts` 的目录）
   输出 `ℹ tests 0` 而**退出码 0** —— 「一个用例都没跑」看起来是绿的。故 `run-tests.mjs` **自己遍历文件**
   （不依赖 Node 的发现规则，这也正是测试文件必须命名 `*.test.ts` 的原因），并强制
   `用例数 ≥ 1` **且** `用例数 ≥ 文件数`（有文件一个用例都没贡献 ⇒ 红）；解析不出汇总行也判红。
2. **证明「测试会红」**：`test:canfail` 用夹具 `scripts/__fixtures__/always-red-runner.fixture.ts`
   要求 runner 退出码非 0 **且点名夹具里的两条失败用例**（防「红在别的理由上」—— D-a 阶段踩过）；
   再把入口指向空目录 `scripts/__fixtures__/empty-test-dir/`，要求它**退出码非 0**。
   `--test-concurrency=1` 是**刻意**的：共享状态（数据库 / 构建产物）不许并发 —— W2 的库不变量用例必须串行。

> **实测基线（2026-10-15，W1-C 收口时复跑；不是推断）**：`npm run ci` → `CI_EXIT=0`（**14 步**全绿，末尾
> `contracts:emit` 输出「已生成 contracts/permission-matrix.json（25 个动作）」且生成物 **`git status` 无 diff** ⇒ 幂等）；
> `npm run test` → **9 个用例文件 / 144 个用例全部通过**（W1-C 之后；跑的是 `.tmp_test_build/` 里的产物。
> W1-B 之后是 **7 / 98**、W1-A 时是 **5 / 68**）；`npm run test:canfail` → **4/4 ALL PASS**（`CANFAIL_EXIT=0`），
> 其附注行**当场复现**了第 ① 条守卫的依据：runner 自己对空目录是「退出码=0，用例数=0」。
> 各阶段自己的**证伪**另跑三处：`tools/_scratch/w1a-canfail.mjs` → **6 条 ALL PASS**、
> `tools/_scratch/w1b-canfail.mjs` → **6 条 ALL PASS**、`tools/_scratch/w1c-canfail.mjs` → **6 条 ALL PASS**
> （每条都「退出码≠0 ＋ 点名预期用例 ＋ `sha256` 复原」，见上面第 16／17／18 条）。
> 另：**编译不过就不许跑测试**这条守卫**在三轮里各被真实触发过一次** —— W1-A 是一个"看起来无害"的变异
> （`if (false && …)`）因破坏类型收窄报 `TS18048`；W1-B 是在 guard 的判定分支上加 `&& verdict.code !== …`
> 破坏了 `verdict` 的类型收窄（`DENY` 分支没有 `.row`）报 `TS2339`；W1-C 又踩了同一条：
> `if (false && row.childId !== requestedChildId)` 把 `row` 的非空收窄短路掉，报 **`TS18047`**。
> 三次 runner 都直接拒绝执行（这正是我们要的行为：宁可红在编译，也不要红在"跑了一个不是要上线的产物"）。
> ★ 三次的**教训一致**：写证伪变异时**先确认它能编译**，否则"没点名"会被误读成脚本坏了（见第 17／18 条）。

**完整流水线**（命令已就绪；**尚未接入 CI 平台** —— 选定平台后写成 workflow 文件即可）：

```
1. 前端 Taro:    npx tsc --noEmit -p tsconfig.json          # 类型检查（不产出）
                  npx tsc src/data/{store,seed,types}.ts src/utils/color.ts \
                      --outDir .tmp_test/dist --module commonjs --target es2017 \
                      --strictNullChecks --esModuleInterop --skipLibCheck   # run.js 要 require 的产物
                  node .tmp_test/run.js
2. 前端 Flutter: flutter analyze && flutter test
3. 后端:         cd backend && npm run ci
```

⚠️ **两处诚实标注（都不掩盖）**：
1. **第 1–2 步尚未接进 `npm run ci`** —— CI 平台未定（见待办 3），且前端产物不入库。
   补偿：`defects:check` 已把 C1 的**代码形态**与**回归用例是否还在**一并纳入对账 ——
   Taro 侧守卫必须由 `demoResetAllowed()` 派生；Flutter 侧 `allowDemoReset` 必须是可常量折叠的 `!_isReleaseBuild`，
   并由测试钉住「与判据 `demoResetAllowed()` 等价」；两侧构造函数都必须走空态初始化。
   于是「修复被回退」或「用例被删」，后端 CI 都会红（已用 2 个代码回退反例验证）。
2. **`run.js` 跑的是 `dist/` 产物，不是 `.ts` 源码** —— 产物陈旧就会"用旧代码考满分"。
   所以第 1 步的编译**必须现跑**（本条流水线如此写）；C1 收尾时删掉 `.tmp_test/dist` 全量重编复跑，
   16/16 与源码一致后才敢签字。

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
| 仓库级守卫脚本（`tools/defect-status.mjs`） | 一次性脚手架（补丁脚本 / 闸门日志 / 守门人证伪自测副本）放 **`tools/_scratch/`**：在仓库树内、可检索可复查，由根锚定规则 `/tools/_scratch/` 关在版本库外（工作区保持干净）。**不要**再放 `.git/` 里 —— 那是 git 内部目录，越界使用且重建即丢失 |

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
