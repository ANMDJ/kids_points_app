# 01 · 系统概览与架构

## 1. 技术栈（已确认）

| 层 | 技术 | 版本 | 状态 |
|---|---|---|---|
| 小程序端 | Taro 4.3.0 + React 18 + TypeScript 5.4 + Sass | 已就绪 | ✅ 双端 UI 完成 |
| 移动端 | Flutter 3.47.5 / Dart 3.13.4 | 已就绪 | ✅ 双端 UI 完成 |
| API | NestJS | 框架 **12.1.2** / CLI **12.0.8** / schematics **12.0.6** | 🔶 W0 骨架已建 |
| 语言（后端） | TypeScript | **6.0.3** | ✅ 已就位 |
| ORM | Prisma | **7.10.0** | 🔶 W0 schema 已校验通过 |
| 数据库 | PostgreSQL | — | ❌ 待建（**本机未安装**，见 `06` §6 L1） |
| Agent | Python **3.12** + FastAPI + LangGraph | — | ❌ 待建 |

> **⚠ 版本勘误（由 W0 实测得出，详见 `06` §2）**：
> 1. **NestJS 的框架包与工具链版本号不同步** —— `@nestjs/cli` 最新为 **12.0.8**、`@nestjs/schematics` 为 **12.0.6**，
>    **不存在 12.1.2**。原表把 CLI 也当成 12.1.2，会导致 `npm install` 直接失败。
> 2. **后端需要 TypeScript ≥ 6** —— `@nestjs/schematics@12` 的 peer 要求是 `>=6.0.0`。
>    原表「TypeScript 5.4」对**小程序端（Taro）成立**，对后端不成立。
> 3. **Prisma 7 是破坏性变更** —— `datasource.url` **不再允许**写在 schema 里，
>    连接串必须移到 `prisma.config.ts`，客户端必须用 driver adapter（`@prisma/adapter-pg`）。
| 测试（小程序） | Node `assert` 冒烟套件（`kids_points_mp/.tmp_test/run.js`） | — | ✅ 已修可信 |
| 测试（Flutter） | `flutter_test`（`test/app_test.dart`） | — | ✅ 21/21 绿 |

---

## 2. 架构与信任边界

```
┌──────────────────┐   ┌──────────────────┐
│ Taro 小程序       │   │ Flutter App       │
│ （孩子手机/家长）  │   │ （家长手机）       │
│  AppStore(内存)   │   │  AppStore(内存)    │
└────────┬─────────┘   └────────┬──────────┘
         │  同一套 REST 契约      │
         └───────────┬───────────┘
                     ▼
        ┌────────────────────────────────┐
        │  kids_points_api (NestJS 12)   │
        │                                │
        │  ① 成员资格门                    │
        │  ② PERMISSION_MATRIX ★唯一事实源 │──┐
        │  ③ 成员级收紧                    │  │ 同一张表
        │  action-dispatcher             │  │ 被两处消费
        │  账本内核（不可变 PointRecord）    │  │
        └───────────┬────────────────────┘  │
                    │                       ▼
                    │          ┌────────────────────────┐
                    │          │ backend_agent (Py3.12) │
                    │          │ LangGraph 规划 →        │
                    │          │ 复用同一权限矩阵校验      │
                    │          └────────────────────────┘
                    ▼
        ┌────────────────────────────────┐
        │ PostgreSQL (Prisma 7.10)       │
        │  账本表：REVOKE UPDATE/DELETE    │
        └────────────────────────────────┘
```

**信任边界（核心原则）**：

| 原则 | 含义 | 违反后果 |
|---|---|---|
| **客户端不可信** | `activeRole` 由服务端 `DeviceSession` 持有（`02` §7） | 改小程序 storage 即可提权 |
| **权限单点定义** | HTTP Guard 与 Agent dispatcher 消费**同一张** `PERMISSION_MATRIX` | 两条入口必然漂移（Agent 成为提权通道） |
| **账本只增不改** | DB 层 `REVOKE UPDATE, DELETE`（`02` §5.7 I5） | 历史可被悄改，对账失效 |
| **前提在批准时重校验** | 审批跨时间，批准前重验全部前提（`02` §4.2） | 批出一个无法执行的动作 |

---

## 3. 与现有代码的接缝（为什么迁移成本可控）

现有双端 `AppStore` 的方法名**一一对应**，且都是同步内存操作。接 API 时**不改 UI**，只改方法体：

| `AppStore` 方法 | 现在的实现 | 接入后 |
|---|---|---|
| `checkIn(habit, actor)` | 内存 `unshift` 一条记录 | `POST /records/check-in` → 用响应替换本地记录 |
| `undoCheckIn(habit, actor)` | 写入**冲正**记录（B7 已修） | `POST /records/{id}/reverse` |
| `addQuickNote(delta, reason, note, actor)` | 内存校验 + 返回错误文案（B6 已修） | `POST /records/adjust`（超扣返回 400） |
| `redeem(wish, actor)` | 内存扣分 + 完整标题快照（B8 已修） | `POST /wishes/{id}/redeem`（可能返回 **202**） |
| `addHabitFromRule(rule)` | 拒绝负分规则（A1 已修） | 同语义，服务端亦拒绝 |
| `recordsOf(category)` | 内存 `filter` | `GET /records?category=` → 本地分页缓存 |

**关键收益**：本批已修的 8 类缺陷，把"错误语义"提前消灭在数据层。
若这些缺陷留到接 API 时才处理，会对**已写入的真实数据**做订正，成本高一个量级。

---

## 4. 事务边界（最容易做错的地方）

```
必须同一事务（$transaction）：
  ├─ 写 PointRecord（含 balanceAfter）
  ├─ 更新 Child.pointsBalance
  ├─ 写 PointRuleVersion（若本次涉及规则）
  ├─ 写 AuditLog（before/after 快照）
  └─ 更新 ApprovalRequest.status + executedRecordId（若由审批触发）

必须**排除**在事务外（失败不得回滚账本）：
  ├─ 发送推送通知（Notification / DeviceToken）
  ├─ 写分析/统计（埋点）
  └─ 生成报表 / 缓存失效
```

**理由**：推送服务不可靠。若把推送放进事务，一次 APNs/微信模板消息失败会**回滚一笔已经成立的加分** ——
孩子明明完成了、账却没了。这是不可接受的。反之，推送失败只意味着"晚一点知道"。

对应验收用例：`02` §9.23（通知发送失败 → 账本已提交不受影响）。

---

## 5. 数据模型总览

### 5.1 新增表（11 张）

> **⚠ 表述勘误（见 `06` §2 缺陷 4）**：本节「11 新增 + 5 改造」是
> **相对于双端内置模型**的差额，**不是**对某个既有数据库做的迁移。
> 仓库内**从不存在后端与数据库**（无 `kids_points_api/`、无迁移、无 `.env`）——
> 那 5 张「既有表」只存在于客户端内存模型里。
> 因此 W0 实际**一次创建全部 18 张表**，不存在「ALTER 既有表」这一步。
> 另：本节两处计数**都没有** `User` 与 `UserChildRelation`，但 `02` §1 引用了它们 ——
> 二者为必需（见 `06` §3 D1）。

| 表 | 作用 | 详见 |
|---|---|---|
| `ChildMember` | 成员位（权限判定唯一入口），含 `pinHash` | `02` §1、§7 |
| `ApprovalRequest` | 审批请求，5 终态 + `autoReason` | `02` §4 |
| `InviteCode` | 邀请码，条件 UPDATE 原子占位 | `02` §8 |
| `GuardianConsent` | 监护人同意记录 | `04` §5 |
| `Notification` | 站内通知 | `01` §4 |
| `DeviceSession` | 服务端持有的 `activeRole`（5 min TTL） | `02` §7 |
| `DeviceToken` | 推送 token | — |
| `IdempotencyRecord` | 幂等键（防重放重复扣分） | `02` §4.4 |
| `AuditLog` | 追加式审计，DB 层禁改 | `02` §5.3 |
| `RuleTemplate` | 平台级规则模板库 | `04` §3 |
| `PointRuleVersion` | **规则版本（只增不删）** | `02` §5.3 |

### 5.2 既有表改造

| 表 | 新增 | 修掉的缺陷 |
|---|---|---|
| `PointRule` | `condition` / `dailyLimit` / `direction` / `currentVersion` / `status` / `deletedAt` | A2、A3、C9、C10、E15、E17 |
| `PointRecord` | `ruleId`+`ruleVersion` / `titleSnapshot` / `conditionSnapshot` / `dailyLimitSnapshot` / `costSnapshot` / `wishId` / `habitId` / `source` / `operatorUserId` / `operatorRole` / `balanceAfter` / `idempotencyKey` / `reversesRecordId` | A4、B6、B7、B8、E19 |
| `Habit` | `dailyLimit`、`status`、`deletedAt` | A2、A3、C9 |
| `Wish` | `status`、`deletedAt`、`coverStyle`（替换 `backgroundIndex`） | C9、E16 |
| `Child` | `ageBand` / `focusAreas` / `onboardedAt` | `04` §3 |

> **两处与本表原文的差异（见 `06` §3）**：
> - `PointRecord.approvalRequestId` **未落库**（D4）—— 改由 `ApprovalRequest.executedRecordId`（唯一）
>   **单向**表达。双向存同一个关系会漂移，而"冗余的两份真相"正是本项目在修的那类缺陷。
> - `Child.goodHabitCount` / `rewardCount` **未落库**（D2）—— 它们是聚合结果；
>   落库正是 **A5（奖励次数虚高）** 的成因，改为按需 `COUNT`。

### 5.3 统一洞察（决定了实施顺序）

> **`PointRuleVersion` + 不可变 `PointRecord` + 软删除 + `AuditLog` 是同一次 schema 变更。**

四者互相引用（`PointRecord.ruleVersion` → `PointRuleVersion`；`AuditLog` 记录两者 before/after；
软删除的全局过滤器必须与 `status` 字段同时上线）。分批实施会产生**无法迁移的中间态**：
先上 `PointRecord` 而无 `PointRuleVersion`，则这段时间的历史永久缺 `ruleVersion`，
`02` §5.7 的 **I3 不变量永久破缺**。

因此：**W0 一次性产出完整 schema，W2 一次性实现**，不可拆。

---

## 6. 缺陷修复与架构的关系

`03` 的 18 条缺陷不是"顺手清理"，而是**架构的前置条件**：

```
D12（假绿 CI）      → 没有它，后面所有修复都无信号        ✅ 已修
A4（流水无操作人）   → 不修，审批流/Agent 无法追责          ✅ 已修
B6（账本不平）      → 不修，balanceAfter 上线即带病数据     ✅ 已修
B7（删流水）        → 不修，不可变账本的承诺直接自相矛盾     ✅ 已修
A1（负分变加分）    → 不修，模板库的扣分模板会产出错误行为   ✅ 已修
B8（标题截断）      → 不修，"完整快照"承诺不成立            ✅ 已修
A5（奖励次数虚高）   → 不修，统计口径污染                  ✅ 已修
E18（生产可重置数据） → 不修，上线即有数据丢失风险          ✅ 已修
E19（文案拼接）     → 不修，无法结构化渲染/多语言           ✅ 已修
```

**已完成 9 条（D12、D13、A1、A4、A5、B6、B7、B8、E18、E19 中前端可控部分）**，
剩余 9 条（A2、A3、C9、C10、C11、E15、E16、E17）依赖 W0 schema 变更。

---

## 7. 文档导航

- 权限矩阵、审批流、**记录不可变性与规则版本化** → [`02-rbac-and-approval.md`](./02-rbac-and-approval.md)
- 既有缺陷清单与修复顺序 → [`03-existing-defects.md`](./03-existing-defects.md)
- 首次引导与模板库 → [`04-onboarding-and-templates.md`](./04-onboarding-and-templates.md)
- 开发计划、压缩选项、风险 → [`05-dev-plan.md`](./05-dev-plan.md)
