# 积分小管家（Kids Points）· 产品需求文档（PRD）

## 0. 文档信息

| 项 | 内容 |
|---|---|
| 产品名称 | 积分小管家（Kids Points） |
| 文档版本 | **v1.0** |
| 编写日期 | 2026-10-14 |
| 文档状态 | 初版定稿（随 W0–W9 阶段推进增量修订） |
| 适用阶段 | W0 已完成 → **W1 已落地（W1-A 矩阵 / W1-B 屏障一・三 / W1-C 身份，2026-10-14 ~ 15）** → W2–W9 待执行（见 §11） |
| 读者 | 产品负责人、双端前端（Flutter / Taro）、后端（NestJS）、测试、法务与合规、运维 |

### 0.1 本文与设计文档的关系（**权威性声明**）

本 PRD 是**面向"要做什么、为什么做、做到什么程度算完成"的需求侧文档**，
不重复承载实现细节。以下内容以**既有设计文档为唯一事实源**，本文只做引用与摘要：

| 主题 | 事实源 |
|---|---|
| 系统概览、技术栈、架构与信任边界、事务边界、数据模型总览 | [`design/01-overview.md`](./design/01-overview.md) |
| 双角色权限矩阵、三道屏障、审批状态机、不可变账本与规则版本化 | [`design/02-rbac-and-approval.md`](./design/02-rbac-and-approval.md) |
| 既有缺陷清单（19 条）与修复顺序 | [`design/03-existing-defects.md`](./design/03-existing-defects.md) |
| 首次引导流程、规则模板库、同意与合规 | [`design/04-onboarding-and-templates.md`](./design/04-onboarding-and-templates.md) |
| 开发计划、压缩选项（已否决）、风险登记、阻塞项 L1–L6、决策 P1–P3 | [`design/05-dev-plan.md`](./design/05-dev-plan.md) |
| W0 实施报告与真实命令/退出码 | [`design/06-w0-report.md`](./design/06-w0-report.md) |
| 各阶段交接单（C3–C5、D-a、D-b、W3-C） | [`design/07`](./design/07-c3-handoff.md) ～ [`design/12`](./design/12-w3c-handoff.md) |

> **诚实标注（本项目头号原则）**：本文所有"当前状态"均以**代码与可执行命令的实测结果**为依据；
> 凡未落地或存在代价之处，一律**显式写明**，不做"看起来在做需求"的表述（见 §15）。

---

## 1. 产品概述

### 1.1 背景与问题

在家庭场景中，"孩子要养成好习惯"与"家长要给出即时、可累积的正面反馈"之间存在天然断层：

| 现状痛点 | 具体表现 |
|---|---|
| **约定不可见** | 规矩停留在口头（"写完作业再说"），孩子无法感知"现在做了什么、值多少分" |
| **反馈不及时** | 奖励要等到周末/月底，正反馈与行为之间的时间差过长，激励失效 |
| **记录易失真** | 用纸笔或聊天记录记账，扣分随意、加减不一致，月底对不上账 |
| **改规则就翻旧账** | 家长临时改分值，"以前得的还算不算"没有答案，孩子失去信任 |
| **单方权威** | 只有家长能记分，孩子无法自证、无法申请，参与感低 |

### 1.2 产品定位与价值主张

> **一句话定位**：把家庭里"看不见的约定"变成**看得见、记得住、改得了但不翻旧账**的积分账本。

三条价值主张：

1. **看得见** —— 积分罐 + 数字滚动动画，打卡即时加分；心愿差多少分实时可见。
2. **记得住** —— 每一次加减分都落成**不可变流水**，可回看、可对账、可追溯到"谁在什么时候做的"。
3. **信得过** —— 改规则**不改历史**（规则版本化 + 流水快照），删除是**软删除**可恢复，所有变更留**追加式审计**。

### 1.3 目标用户与场景

| 角色 | 是谁 | 典型设备 | 核心诉求 |
|---|---|---|---|
| **家长（guardian）** | 孩子的主要照料者（父母之一），家庭账本的建立者 | Flutter App / 小程序 | 3 分钟建好账本、随时加减分、能审孩子的申请、能纠错（撤回/回收站） |
| **孩子（child）** | 使用者本人（可用自己的设备登录） | 小程序（手机/平板） | 一键打卡、看积分涨、提心愿、申请奖励 |

**核心场景（用户故事）**：

- 作为家长，我想**在 90 秒内**从空账本走到"孩子能开始打卡"，否则我会放弃（→ §5 FR-01）。
- 作为孩子，我想点一下卡片就加分，并且**看得到分数在涨**（→ FR-02）。
- 作为孩子，我想自己提一个心愿，**由家长批准**后兑换（→ FR-04 / FR-08）。
- 作为家长，我想在**改了规则之后**，孩子**今天依然能按新规则打卡**，但**已经得的分不追回**（→ §6 I1、R3）。
- 作为家长，我想在**误删规则/心愿后**能恢复（回收站 90 天），并能查"这条规则上周被谁改过"（→ FR-06 / FR-07）。

### 1.4 平台与形态

| 端 | 技术栈 | 形态 | 现状 |
|---|---|---|---|
| 小程序端 | Taro 4.3.0 + React 18 + TypeScript 5.4 | 微信小程序（也可编译 H5） | UI 完成 |
| 移动端 | Flutter 3.47.5 / Dart 3.13.4 | Android / iOS / 桌面 / Web | UI 完成 |
| 服务端 API | NestJS 12 + TypeScript 6 + Prisma 7.10 + PostgreSQL 18.6 | REST | W0 骨架已建 |
| Agent（自然语言操作） | Python 3.12 + FastAPI + LangGraph | 复用同一权限矩阵 | **待建（W6）** |

---

## 2. 目标与成功指标

### 2.1 产品目标（按阶段）

| 优先级 | 目标 | 判定方式 |
|---|---|---|
| P0 | **账本正确**：加分、扣分、兑换、撤销后，流水与余额永远自洽 | §6 不变量 I1–I6 全部有自动化测试且全绿 |
| P0 | **权限正确**：孩子无法执行家长动作；家长模式是服务端持有的真实权限提升 | §7 矩阵 + 验收用例 9.1–9.27 |
| P0 | **数据可信**：流水不可改、删除可恢复、变更可追溯 | DB 层 `REVOKE UPDATE/DELETE` + 审计表 |
| P1 | **上手可用**：新用户 ≤ 90 秒完成首次打卡 | 可用性测试（5 名家长） |
| P1 | **双端一致**：同一用例在 Taro 与 Flutter 上结论相同 | 双端各跑一遍同一用例集 |
| P2 | **省心**：通知触达、自然语言操作（Agent） | W6 验收 |

### 2.2 关键指标

> 数值目标为**首版建议值**，上线后按真实数据校准；当前无线上数据，故只给口径与目标，不给"已达成"结论。

| 层级 | 指标 | 口径 | 首版目标 |
|---|---|---|---|
| 北极星 | **周活跃账本周打卡次数** | 一周内有 ≥1 次 `check_in` 的 Child 的打卡总次数 | 持续上升 |
| 激活 | 引导完成率 | 完成 `onboarding/complete` 的新 Child / 进入引导的新 Child | ≥ 70% |
| 激活 | 引导耗时 | 从进入引导到落库完成的中位耗时 | ≤ 90 秒 |
| 留存 | 次周留存 | 第 1 周有打卡的账本，第 2 周仍有打卡的比例 | ≥ 40% |
| 参与 | 孩子自助打卡占比 | `source=child_self` 的打卡 / 全部打卡 | ≥ 30% |
| 健康 | 对账偏差率 | `∑balanceAfter` 与余额不一致的记录数 | **恒为 0** |
| 健康 | 审批闭环率 | 已决策（approved/rejected/invalidated）的申请 / 全部申请 | ≥ 90% |

### 2.3 明确的非目标（**Out of Scope，首版不做**）

- ❌ **多孩子聚合看板**（一个家长管多个孩子的总览）—— 首版一账本一孩子。
- ❌ **只读分享（爷爷奶奶看战绩）** —— `viewer` 角色在枚举中**已预留**，但权限矩阵**故意只有两列**，一律 `DENY`（见 §3.1）。
- ❌ **实物商品兑换 / 电商对接** —— 心愿只是"记一笔并扣分"，不含履约。
- ❌ **社交排行榜 / 家庭间对比** —— 与"不制造攀比"的产品原则冲突。
- ❌ **多语言** —— 首版仅简体中文；但文案已做结构化（`recordSubtitle()` 等派生函数），为将来预留。

---

## 3. 用户与角色

### 3.1 角色定义

| 角色 | 定义 | 权限基调 |
|---|---|---|
| **guardian（家长）** | 为孩子建立账本的监护人；可审批、可改规则、可调整积分 | 默认放行管理类动作 |
| **child（孩子）** | 使用账本的人本人账号 | 只能打卡、查询、**申请**；不可直接改分/改规则 |
| **viewer（只读）** | **预留位，首版不启用** | 一律 `DENY`（`permission-matrix.ts` 中 `if (role === 'viewer') return 'DENY'`） |

> ⚠️ **`viewer` 的口径**：枚举里已有该值，但权限矩阵**故意只有 `guardian` / `child` 两列**。
> 将来要支持"只读分享"，**必须显式扩展矩阵列**，不允许在各调用处各自打补丁（否则"只读"会退化为"没有统一约束"）。

### 3.2 成员模型（权限判定的唯一入口）

```
User（自然人）
  ├─ UserChildRelation（监护关系，RelationKind 枚举）
  │     └─ Child（孩子档案：昵称、学段、关注点、积分余额）
  │           └─ ChildMember（成员位）★ 权限判定唯一入口
  │                 role ∈ { guardian, child, viewer }
  └─ 通过邀请码加入其他 Child
```

| 规则 | 说明 |
|---|---|
| 唯一成员位 | `ChildMember @@unique([childId, userId])` —— 同一人对同一孩子只有一个成员位 |
| 家庭成员可多个 | 爸爸、妈妈可同时是 guardian，均可审批 |
| 孩子用自己的设备登录 | 需要 `ChildMember(role=child)` |

### 3.3 家长模式（服务端持有的权限提升）

**问题**：手机常在孩子手里。若"家长模式"只是客户端上的一个开关，改一下本地存储即可提权。

| 规则 | 说明 |
|---|---|
| 默认角色 | `child`（**最小权限默认**） |
| 切到 guardian | 需输入 **PIN**（scrypt 哈希，存于 `ChildMember.pinHash`） |
| TTL | 5 分钟无操作**自动回落 `child`**；每次 guardian 操作刷新 |
| 暴力防护 | PIN 连错 **5 次锁定 15 分钟** |
| 审计 | 每次切换写 `AuditLog`（含设备标识） |
| **存储位置** | `activeRole` 由**服务端 `DeviceSession`** 持有，**不存客户端** |

---

## 4. 需求范围

### 4.1 In Scope（首版纳入）

| 域 | 内容 | 需求编号 |
|---|---|---|
| 上手 | 首次引导（7 步）+ 规则模板库（18 条） | FR-01 |
| 核心 | 习惯打卡（含每日频次上限）、撤销（冲正） | FR-02 |
| 核心 | 记一笔（家长手动加减分，含余额不足拒绝） | FR-03 |
| 核心 | 心愿单与兑换（差多少分实时可见） | FR-04 |
| 核心 | 积分记录（分类筛选 + 按天分组） | FR-05 |
| 管理 | 积分规则新增 / **编辑（版本化）** / 删除与恢复 | FR-06 |
| 管理 | 我的（档案、战绩、家长 PIN、回收站 90 天、审计、数据导出） | FR-07 |
| 安全 | 双角色权限 + 审批工作流（5 终态） | FR-08 |
| 触达 | 站内通知 + 推送（W6） | FR-09 |
| 智能化 | Agent 自然语言操作（复用同一权限矩阵，W6） | FR-10 |
| 家庭 | 邀请码加入成员（并发安全） | FR-11 |
| 合规 | 监护人同意、撤回、数据导出/删除 | FR-12 |

### 4.2 Out of Scope（明确不做，见 §2.3）

多孩子聚合、viewer 只读分享、实物履约、社交排行、多语言、跨家庭账本合并。

### 4.3 依赖与前提

本 PRD 的功能交付**强依赖**以下外部前置（详见 §12）：微信小程序正式 AppID（L2）、
域名 + HTTPS + 备案（L4）、推送通道凭据（L3）、法务文本（L5）。
**这些是"纯等待"的日历门，必须在第 1 天并行启动**，否则工期会被拉长到 8–10 周。

---

## 5. 功能需求（FR）

> 每条需求给出：**目标 / 主要流程 / 验收标准 / 异常分支**。
> "验收标准"编号沿用设计文档编号（如 4.3 指 `design/04` §6 用例 4.3），便于追溯。

### FR-01 首次引导与规则模板库

**目标**：新用户从"空账本"走到"孩子能开始打卡"，**≤ 90 秒**。

**流程（7 步）**：

```
① 欢迎页         "把约定变成看得见的成长"  [创建孩子的积分账本] [我有邀请码]
                 底部：监护人同意勾选（必须）
② 建立家庭       输入孩子昵称 → 生成 childId
③ 选择学段       幼儿园 / 小学低年级 / 小学高年级 / 初中（决定模板过滤）
④ 选关注点(多选)  作业专注 / 生活习惯 / 阅读 / 运动 / 情绪管理 / 家务（决定模板排序）
⑤ 选约定(★核心)   展示 6–12 条模板卡片（标题/条件/频次/分值），可采纳/跳过，至少 1 条
⑥ 设家长 PIN      4–6 位（可跳过；跳过则每次切家长模式都要输）
⑦ 完成 → 首页     空账本 + 已采纳的习惯
```

| 需求点 | 规则 |
|---|---|
| 可跳过性 | ③④ 可跳过（默认"小学低年级"、无关注点）；**⑤ 不可跳过**（至少 1 条）；⑥ 可跳过 |
| 采纳语义 | **复制而非引用** —— `RuleTemplate` → `PointRule` + `PointRuleVersion v1`；采纳后与模板**脱钩**，平台改模板**不影响**已采纳规则 |
| 扣分模板 | `direction=penalty`；**不能**加入"今天的习惯"（与 A1 一致） |
| 引导状态权威源 | `Child.onboardedAt`（**服务端持有**，前端不缓存）；非空后重登直接进首页 |
| 断点续做 | 引导中途退出再进入，从上次步骤继续（已落库的 `ageBand` / `focusAreas` 不回滚） |
| 模板库规模 | 首版 **18 条**（6 关注点覆盖，含 2 条扣分）；**已知代价**：`preschool` 仅 1 条、`junior_high` 0 条，这两类学段的第⑤步会明显单薄（计入 R4） |

**验收标准**：4.1 新用户进引导而非首页（账本 0 分 0 记录）；4.2 零采纳无法继续；
4.3 采纳 3 条 → 生成 3 条规则各带 v1 且首页出现 3 个习惯；4.4 平台改模板后该家庭规则不变；
4.5 扣分模板不能加入今日习惯；4.6 未勾选同意 → `403 CONSENT_REQUIRED`；4.8 `onboardedAt` 非空不重复引导；
4.9 全流程 ≤ 90 秒；4.11 采纳产生的规则其版本可被流水引用（I3 成立）；4.12 中途退出可续做。

**异常分支**：未勾选同意（拒绝并提示）；一条都不采纳（按钮禁用 + 文案"至少选一条约定"）；
网络失败（保留已选，可重试，不产生半成品规则）。

---

### FR-02 习惯打卡（首页）

**目标**：孩子点一下卡片就能加分，且**系统真的知道今天还能打几次**。

| 需求点 | 规则 |
|---|---|
| 打卡入账 | 生成一条 `PointRecord`（`source=child_self` 或家长代记），余额即时更新 |
| 频次上限 | `Habit.dailyLimit`（**结构字段**，1–5）"+ 当天流水派生已完成次数"共同判定；上限按**当天**计算 |
| 展示文案 | `limitText` / `doneText` / `checked` 一律**派生**，禁止任何地方手写死（原 E17/A2/A3 的成因） |
| 撤销 | 长按卡片可撤销：**不物理删除**原流水，而是写一条**冲正记录**（`reversesRecordId` 指向原记录） |
| 反馈 | 打卡成功弹提示 + 积分数字滚动动画（`TweenAnimationBuilder`） |
| 操作人 | 每条流水记录 `operatorRole` / `operatorUserId`，孩子自助打卡的副标题**不含"家长"**（A4） |

**验收标准**：`dailyLimit=2` 时**真能打 2 次**、第 3 次被拒；撤销后记录数 **+1**（冲正），原记录保留；
`∑balanceAfter` == 余额。

**异常分支**：超频次 → 拒绝并提示"今天已完成 N 次"；撤销不存在/已撤销的记录 → 拒绝；
扣分方向规则不可加入今日习惯。

---

### FR-03 记一笔（家长手动加减分）

**目标**：家长可对"规则之外"的好/坏表现即时记账。

| 需求点 | 规则 |
|---|---|
| 方向 | 加分（表扬）或扣分（惩罚），分值由家长输入 |
| 余额不足 | **拒绝而非静默截断**：返回"积分不足，最多可扣 N 分"（原 B6 会 `clamp` 造成账本不平） |
| 负分规则归一 | 规则分值恒为正，方向由 `direction` 表达；**禁止**用 `Math.abs()` 抹平负值（原 A1） |
| 分类 | 流水分类 `RecordCategory`（表扬/兑换/调整 等）用于筛选与统计 |
| 幂等 | 携带幂等键（`IdempotencyRecord`），防重放重复扣分 |

**验收标准**：家长 `adjust_points(-9999)` → `400 INSUFFICIENT_POINTS`，**不产生**被截断的记录；
连点两次同一请求 → 只入账一次。

---

### FR-04 心愿单与兑换

**目标**：把"想要的东西"变成看得见的积分目标。

| 需求点 | 规则 |
|---|---|
| 心愿卡片 | 显示所需积分；**积分够** → 可"兑换"；**不够** → 按钮变灰显示"还差 N"，随积分实时变化 |
| 兑换 | 扣分 + 生成兑换流水（**完整标题快照**，不做 `shortTitle` 截断，原 B8）+ `rewardCount +1` |
| 谁批准 | 家长可直接兑换；孩子的兑换需家长批准。**家长可以自批自己提的兑换**（申请时勾选"自动审批"，或提交后**本人**二次确认）—— 否则**单家长家庭永远换不出去**；**孩子不能自批**（见 FR-08） |
| 谁在递增 | 仅"兑换"递增 `rewardCount`；"记一笔"**不得**递增（原 A5） |
| 新增/删除 | 家长可直接新增/删除；孩子新增与兑换走**审批**（见 FR-08） |
| 封面配色 | `WishCoverStyle`**稳定枚举**，新增不足时补空档 + 按 `id` 哈希，**不使用数组下标**（原 E16 删项后配色漂移） |
| 软删除 | 删除为软删除，可在回收站恢复（90 天） |

**验收标准**：积分不足时按钮文案与差值实时正确；兑换后余额与流水一致且标题完整；
`rewardCount` 仅在兑换时 +1；删除心愿可在回收站恢复；**单家长家庭可独立完成兑换**（9.27）。

---

### FR-05 积分记录（流水）

**目标**：家长与孩子能回看"每一分是怎么来的"。

| 需求点 | 规则 |
|---|---|
| 筛选 | 全部 / 表扬 / 兑换 / 调整 |
| 分组 | 按 **今天 / 昨天 / 更早** 分组 |
| 展示 | 小标题由 `recordSubtitle()` **派生**（时间 + 来源 + 操作人），不手写拼接（原 E19） |
| 不可变 | 流水**只增不删**；撤销以冲正记录表达 |
| 来源可见 | 展示 `operatorRole`，孩子自助与家长代记可区分 |

**验收标准**：改规则后回看历史记录，**逐字段 diff 为空**（I1）；按天分组与筛选结果正确；
冲正记录与原始记录都可见且互相可追溯。

---

### FR-06 积分规则（新增 / 编辑 / 版本化 / 删除恢复）

**目标**：家长能改规则，但**历史不因此改变**。

| 需求点 | 规则 |
|---|---|
| 结构字段 | 规则只含 `condition`（条件）+ `dailyLimit`（频次 1–5）+ `points` + `direction` + `iconName`；**禁止**用 `detail` 字符串靠 `' · '` 反解析（原 E15） |
| 新增 | 家长可新增规则；可选"加入今天的习惯" |
| 编辑 | **`updateRule` 四步一笔**：归档旧版本 → 改本体 → 同步派生习惯（`id` 不变）→ 写审计，**只持久化一次** |
| 版本表 | `PointRuleVersion`**只增不删、永不 UPDATE**；新建即 v1；流水钉住"当时版本" |
| 影响提示 | 改规则前必须提示"**已得的分不追回**、今天起按新规则"（R3 的缓解，**不是可选项**） |
| 删除/恢复 | 软删除 + 回收站恢复；回收站保留 **90 天** |
| 审计 | 规则的 create / update / delete / restore / purge 均写 `AuditLog`（含 before/after **深拷贝**快照） |

**验收标准**：I1 改规则后历史逐字段不变；I3 每条流水都能引用到当时版本；
`updateRule` 后派生习惯同步且 `id` 不变；台账中 `PointRule.detail.split` 出现次数为 **0**（守门人钉住）。

**异常分支**：`dailyLimit` 越界（拒绝）；负分规则加入今日习惯（拒绝）；编辑时同步派生习惯失败（整笔回滚，不留半成品）。

---

### FR-07 我的（档案 / 战绩 / 家长模式 / 回收站 / 审计 / 数据导出）

| 需求点 | 规则 |
|---|---|
| 档案 | 孩子昵称（可改，改名写审计）、childId（可复制） |
| 战绩 | 累计好习惯次数、累计奖励次数；`goodHabitCount` / `rewardCount` 是**聚合结果**，**按需 COUNT**，不落库为可写字段（原 A5 的成因） |
| 家长模式 | 输入 PIN 切到 guardian；5 分钟无操作回落；连错 5 次锁 15 分钟 |
| 回收站 | 心愿 / 规则 / 习惯的已删除项；**恢复**、**彻底删除**、**90 天到期自动清理**（纯函数 `isTrashExpired()`） |
| 审计 | 追加式只读列表（`AuditAction` 枚举白名单内可达动作；`before`/`after` 为**深拷贝快照**） |
| 数据导出 | 家庭可用数据导出（合规要求，见 FR-12） |
| **演示数据入口** | **仅开发/调试构建可见**；release / profile 构建**编译期整段树摇掉**（原 E18：生产一键清空真实数据并注入假数据） |
| 首启状态 | **空态**（0 分 0 记录）；seed 数据降级为**测试夹具**，只由显式 `resetToSeed()` 载入 |

**验收标准**：release 构建中"恢复演示数据"入口不存在且守卫常量恒为假；
`demoResetAllowed(isRelease: true) == false`；回收站恢复/彻底删除/到期清理行为正确；
审计快照写入后再改原对象，审计内容**不变**（防"活快照"）。

> ⚠️ **未实现项（诚实标注）**：前端**没有**成员增删 / 角色切换 / 家长同意（consent）的入口，
> 故 `AuditAction` 枚举**不包含**这些动作 —— **不假装覆盖**（见 `design/03` §C11）。

---

### FR-08 权限与审批工作流

**目标**：孩子的"想要"走申请，家长的"决定"有据可查；两条入口（HTTP 与 Agent）**权限永不漂移**。

**三道屏障**（缺一不可）：① 成员资格门（非成员 `403 MEMBER_NOT_FOUND`）→ ② `PERMISSION_MATRIX` 唯一事实源 →
③ 成员级收紧（`restrictions` 只能**收紧**不能放宽，试图放宽被忽略）。

**审批状态机（5 终态）**：

| 终态 | 触发 |
|---|---|
| `approved` | 家长批准，且执行成功（生成对应流水） |
| `rejected` | 家长拒绝 |
| `withdrawn` | 申请人主动撤回 |
| `expired` | 超过有效期自动失效 |
| `invalidated` | 批准时前提已变（如心愿已被删 → `autoReason=WISH_DELETED`） |

| 需求点 | 规则 |
|---|---|
| 需审批的动作 | 孩子 `add_wish` / `request_redeem`；`redeem` 对两端均 `REQUIRE_APPROVAL` |
| **谁可以批准** | 家庭内 `guardian`（判据＝矩阵 `review_approvals` 行，**不另立名单**）；**申请人本人可以自批**（P4），`child` / `viewer` 一律不能 |
| **自批必须显式** | 两种形态：① 提交后**本人**二次确认；② 申请时勾选"自动审批"（`autoApprove: true`）。**未勾选 / 缺字段一律 `pending`** —— **不存在**"只有一位家长就自动批准"的特例 |
| 参数与动作不匹配 | 没批准资格却传 `autoApprove`、或对不需要审批的动作传 → `400 SELF_APPROVAL_NOT_ALLOWED`（**不静默忽略**：静默忽略会让客户端以为已批） |
| 自批留痕 | 由 `decidedByUserId == requesterUserId` 判定（**不新增字段**），审计动作名 `approval.self_approved` |
| 幂等 | 双击"同意" → 第二次 `409`（乐观锁），账本**只扣一次**；带 `Idempotency-Key` 的网络重试 → 第二次返回**首次响应**（不再执行），同键不同请求 → `409 IDEMPOTENCY_KEY_REUSED`（W3-C） |
| 重校验 | 批准执行前**重新校验全部前提**（防跨时间 `invalidated`，R2） |
| 撤回同意 | `GuardianConsent` 撤回后**全链路写入停止**，导出仍可下载 |
| 孩子限制 | 孩子不可扣分（`403 CHILD_CANNOT_DEDUCT`）；每日申请加分有配额；单次金额 ±50 上限 |

| 撤回 | 申请人本人可撤回 `pending`（`POST /approvals/:id/withdraw`）：`withdrawn`；**不写流水、不动余额**；另一位家长撤回 → `403 NOT_REQUESTER`；已终态 → `409`；跨孩子 → `404`（W3-B） |
| 租户隔离 | 审批的读 / 批 / 撤回都以 `childId` 为查询键：另一家的审批 id 与「不存在」同样 `404`（W3-B） |

**验收标准**：9.1–**9.40** 全部通过（含 9.9 Agent 伪造角色 → `401` 整份 plan 作废；
9.22 成员级 `restrictions` 试图放宽 `DENY` 被忽略；**9.25–9.27 自批三条** —— 家长显式自批 → 直接 `approved`；
孩子传 `autoApprove` → `400 SELF_APPROVAL_NOT_ALLOWED`；单家长家庭**不勾选** → `pending`（**不自动批准**）、
本人二次确认 → `approved`；**9.31–9.33 撤回与跨孩子隔离**）。

---

### FR-09 通知（W6）

| 需求点 | 规则 |
|---|---|
| 站内通知 | `Notification` 表；审批结果、被表扬等 |
| 推送 | 微信订阅消息 / APNs / FCM（依赖 L3 凭据） |
| **投递可观测（W6-D）** | 通知与推送任务**定时对账**：单边缺失 / 重复通知只**告警**，**不自动补发**（处置见 `design/32-w6d-handoff.md` §4）；队列状态分布随日志输出 |
| **投递事实保留（W6-D）** | 终态才可删：`sent` / `expired` 7 天、`dead` 30 天（证据）；`pending` / `sending` **永不删** |
| **事务边界（关键）** | 推送**不在**账本事务内：推送失败**不得回滚**已成立的加分（只"晚一点知道"） |

**验收标准**：9.23 通知发送失败 → 账本已提交不受影响。

---

### FR-10 Agent（自然语言操作，W6）

**目标**：家长可用自然语言发起操作（如"给小宝加 2 分，因为他主动收书包"）。

| 需求点 | 规则 |
|---|---|
| 权限 | Agent `action-dispatcher` **消费同一张** `PERMISSION_MATRIX`（`contracts/permission-matrix.json`，40 动作，由 TS 生成） |
| 防提权 | Agent 伪造 `plan.role=guardian` 而实际为 child → **`401`，整份 plan 作废** |
| 落账 | 与 HTTP 路径共用同一账本内核与不变量校验 |
| 技术 | Python 3.12 + FastAPI + LangGraph |

---

### FR-11 邀请成员（并发安全）

| 需求点 | 规则 |
|---|---|
| 邀请码 | `InviteCode`（角色、最大次数、有效期、可吊销） |
| **并发原子占用** | 单条条件 UPDATE：`UPDATE ... SET usedCount = usedCount + 1 WHERE usedCount < maxUses AND expiresAt > now() AND revoked = false RETURNING id`；未抢到名额 → `409 INVITE_CODE_UNAVAILABLE` |
| 禁止写法 | **不得**"先查后改"或"分布式锁"式分步实现（并发下会超发） |

**验收标准**：9.6 并发 10 请求、`maxUses=3` → **恰好 3 成功、7 个 409**。

---

### FR-12 合规与监护人同意

| 需求点 | 规则 |
|---|---|
| 同意时机 | **采集之前**取得：引导第①步底部勾选，勾选前 ①–⑦ 不可进行（放到设置页＝"先采集后征求"，合规不成立） |
| 记录 | `GuardianConsent`（`grantedAt` / `version` / `ipHash`） |
| 未勾选 | `onboarding/complete` → `403 CONSENT_REQUIRED` |
| 撤回 | 撤回同意后写入停止、引导入口重新出现、导出可下载（9.20） |
| 文本依赖 | 《用户协议》《儿童个人信息保护规则》由法务定稿（**L5**） |

---

## 6. 业务规则与不变量（**验收硬门槛**）

> 以下 I1–I6 是"账本正确性"的定义。**任何一条破缺即视为不可上线**。

| 编号 | 不变量 | 含义 | 验收 |
|---|---|---|---|
| **I1** | 规则变更不改变历史 | 改规则后，历史流水的**逐字段 diff 为空** | 9.11 |
| **I2** | 余额自洽 | `∑balanceAfter`（滚动求和）== 当前余额 | 9.12 |
| **I3** | 版本可追溯 | 每条 `PointRecord` 都能引用到当时的 `PointRuleVersion` | 4.11 / 9.11 |
| **I4** | 追加写 | 流水/审计/版本表**只增不删、永不 UPDATE** | 代码与 DB 权限双重保证 |
| **I5** | 数据库层不可改 | 应用角色执行 `UPDATE "PointRecord"` → **权限错误**（`SQLSTATE 42501`） | 9.14（`npm run db:verify` 实测 PASS） |
| **I6** | 撤销是冲正 | 撤销打卡使记录数 **+1**，原记录保留 | 9.13 |

**其它硬性业务规则**：

- 单条规则/模板 `points ≤ 10`（超出丧失"积累感"）；扣分模板分值 −1 ~ −3。
- `dailyLimit ∈ [1, 5]`，两端同口径（`isDailyLimitValid()`）。
- 金额单次上限：孩子申请加分 **±50**；每日申请加分有**配额**（第 4 次 → `CHILD_REQUEST_QUOTA_EXCEEDED`）。
- "已删除"的全局过滤**只有一处实现**（`activeOnly()` / `trash.dart`）；页面必须走只读 getter，
  **不得**自行写 `status == active`（否则迟早漂移 —— E15/E17 的教训）。

---

## 7. 权限矩阵（42 个动作 · 唯一事实源）

> **权威定义**：`backend/src/contracts/permission-matrix.ts`；生成产物 `contracts/permission-matrix.json`
> 供 Python Agent 消费。**HTTP Guard 与 Agent 只能读这一份，不得各写一版。**
> 判定严重度：`ALLOW(0) < REQUIRE_APPROVAL(1) < DENY(2)`。

| 动作 | guardian | child | 归类 |
|---|---|---|---|
| `view_child_points` | ALLOW | ALLOW | 查询 |
| `view_records` | ALLOW | ALLOW | 查询 |
| `view_rules` | ALLOW | ALLOW | 查询 |
| `view_wishes` | ALLOW | ALLOW | 查询 |
| `check_in_habit` | ALLOW | ALLOW | 打卡 |
| `undo_check_in` | ALLOW | **DENY** | 打卡 |
| `add_rule` | ALLOW | **DENY** | 规则 |
| `update_rule` | ALLOW | **DENY** | 规则 |
| `delete_rule` | ALLOW | **DENY** | 规则 |
| `delete_habit` | ALLOW | **DENY** | 习惯（软删，进回收站） |
| `view_trash` | ALLOW | ALLOW | 回收站 |
| `restore_trash_item` | ALLOW | **DENY** | 回收站 |
| `purge_trash_item` | ALLOW | **DENY** | 回收站 |
| `add_habit_from_rule` | ALLOW | **DENY** | 规则 |
| `add_wish` | ALLOW | **REQUIRE_APPROVAL** | 心愿 |
| `request_redeem` | ALLOW | **REQUIRE_APPROVAL** | 心愿 |
| `delete_wish` | ALLOW | **DENY** | 心愿 |
| `adjust_points` | ALLOW | **DENY** | 积分 |
| `request_points_bonus` | ALLOW | ALLOW | 积分 |
| `redeem` | REQUIRE_APPROVAL | REQUIRE_APPROVAL | 积分 |
| `request_approval` | ALLOW | ALLOW | 审批 |
| `review_approvals` | ALLOW | **DENY** | 审批 |
| `withdraw_request` | ALLOW | ALLOW | 审批 |
| `view_own_approvals` | ALLOW | ALLOW | 审批（W5-J：申请人读自己的申请，**不复用** `review_approvals`） |
| `view_notifications` | ALLOW | ALLOW | 通知（W5-L：站内通知中心） |
| `read_notifications` | ALLOW | ALLOW | 通知（W5-L：标记已读） |
| `manage_device_tokens` | ALLOW | ALLOW | 推送（W6-A：上报 / 注销本机设备 token；孩子设备收不到推送才是缺陷） |
| `view_members` | ALLOW | ALLOW | 成员（W5-H） |
| `change_member_role` | ALLOW | **DENY** | 成员（W5-H） |
| `invite_member` | ALLOW | **DENY** | 成员 |
| `remove_member` | ALLOW | **DENY** | 成员 |
| `switch_role_mode` | ALLOW | ALLOW | 成员（W8-C：用 PIN 换 5 分钟家长模式 / 读当前模式 / 主动退出。**对孩子也是 ALLOW** —— PIN 就是那道门，孩子负责把手机递给家长按，不是把按钮藏起来） |
| `manage_parent_pin` | ALLOW | **DENY** | 成员（W8-C：首次设置 / 修改家长 PIN，改 PIN 需 `currentPin`。PIN 落在 `ChildMember.pinHash`，孩子拿到它就等于拿到提权钥匙；**不受 `ConsentGuard` 管辖** —— 撤回同意后家长仍必须能改 PIN 才能进家长模式重新同意） |
| `edit_child_profile` | ALLOW | **DENY** | 档案 |
| `apply_onboarding` | ALLOW | **DENY** | 引导 |
| `view_onboarding` | ALLOW | **DENY** | 引导（W8-A：读引导状态 / 模板库；**不受 `ConsentGuard` 管辖** —— 未同意时引导页必须能打开，第①步的同意按钮才有地方渲染。读豁免不等于写豁免：`apply_onboarding` 仍受管） |
| `view_consent` | ALLOW | **DENY** | 合规（W7-A：看同意状态 / 版本号；孩子没有合规控制面） |
| `manage_consent` | ALLOW | **DENY** | 合规（W7-A：授予 / 撤回同意；**撤回后仍放行**，否则「可撤回」会变成死状态） |
| `export_family_data` | ALLOW | **DENY** | 合规（W7-C：导出家庭数据；**不受 `ConsentGuard` 管辖** —— 撤回同意后仍必须可用，04 §5 可携带权） |
| `view_family_deletion` | ALLOW | **DENY** | 合规（W7-D：查看删除状态 / 剩余冷却天数 / 执行摘要；**不受 `ConsentGuard` 管辖**） |
| `manage_family_deletion` | ALLOW | **DENY** | 合规（W7-D：申请 / 撤销家庭数据删除；7 天冷却 ＋ `confirmed: true` 二次确认；**不受 `ConsentGuard` 管辖** —— 撤回同意后仍必须能删） |
| `reset_demo_data` | **DENY** | **DENY** | 运维 |

**归一化规则**：孩子的 `adjust_points(delta=+10)` **不报错**，而是归一化为 `request_points_bonus` → `202` 生成待审申请；
孩子的 `adjust_points(delta=-5)` → `403 CHILD_CANNOT_DEDUCT`。

> **本矩阵只回答"哪个角色能发起该动作"** —— "**谁可以批准**"是另一条线（FR-08 ／ `design/02` §4.5 决策 P4）：
> 批准资格同样从这张表导出（`review_approvals` 行），**不为"自批"新开一列**，也不新增角色列。

---

## 8. 数据模型摘要

> **权威定义**：`backend/prisma/schema.prisma`（**18 张表 / 14 个枚举**，W0 已迁移落地）。

### 8.1 枚举（17）

`MemberRole`（guardian/child/viewer）、`MemberStatus`、`UserStatus`、`RelationKind`、
`ApprovalStatus`（5 终态）、`AutoReason`、`RuleDirection`（reward/penalty）、`RecordStatus`、
`RecordCategory`、`RecordSource`（含 `child_self`）、`AgeBand`（4 学段）、`WishCoverStyle`、
`ConsentStatus`、`FamilyDeletionStatus`（pending/cancelled/executed，W7-D）、`DevicePlatform`、
`ActionType`（40 动作）、`PushRetryStatus`。

### 8.2 表（20）

| 表 | 作用 | 关键点 |
|---|---|---|
| `User` | 自然人（一个家长一个 User） | —— |
| `UserChildRelation` | 监护关系 | `relation` 用 `RelationKind` **枚举**（非裸字符串） |
| `Child` | 孩子档案 | `ageBand` / `focusAreas` / `onboardedAt`（引导权威状态）；**无** `goodHabitCount` / `rewardCount`（改为 COUNT） |
| `ChildMember` | 成员位（**权限判定唯一入口**） | `@@unique([childId,userId])`；`pinHash`（scrypt）；`restrictions`（**成员级收紧**，只能收紧） |
| `DeviceSession` | 服务端持有 `activeRole` | 5 min TTL |
| `DeviceToken` | 推送 token | —— |
| `PointRule` | 规则本体 | `condition` / `dailyLimit` / `direction` / `currentVersion` / `status` / `deletedAt` |
| `PointRuleVersion` | 规则版本 | **只增不删**，供流水钉住 |
| `PointRecord` | 积分流水 | **不可变**；`ruleId`+`ruleVersion` / 各类快照 / `balanceAfter` / `idempotencyKey` / `reversesRecordId` / `operatorUserId` / `operatorRole` / `source` |
| `Habit` | 今日习惯 | `condition` / `dailyLimit` / `status` / `deletedAt` / `ruleId` / `iconName` |
| `Wish` | 心愿 | `status` / `deletedAt` / `coverStyle` |
| `ApprovalRequest` | 审批请求 | 5 终态 + `autoReason` + `executedRecordId`（唯一，**单向**表达与流水的关系） |
| `InviteCode` | 邀请码 | 条件 UPDATE 原子占位 |
| `GuardianConsent` | 监护人同意 | `grantedAt` / `version` / `ipHash` |
| `FamilyDeletionRequest` | 家庭数据删除请求（W7-D） | `scheduledFor`（冷却期截止，7 天）/ `status` / `executedAt` / `summary`；**一个孩子最多一条 pending**（部分唯一索引）；执行 = 就地匿名化 |
| `PushRetryJob` | 推送失败重试队列（W6-B） | `attempts` / `nextAttemptAt` / `expiresAt` / `claimTimeout` 回收；`pending`、`sending` 永不自动删 |
| `AuditLog` | 追加式审计 | DB 层禁改；`before` / `after` JSON 快照 |
| `Notification` | 站内通知 | 不在账本事务内 |
| `IdempotencyRecord` | 幂等键 | 防重放重复扣分 |
| `RuleTemplate` | 平台级模板库 | `ageBand` / `focusAreas` / `sortWeight`；18 条种子 + 离线自检 |

**两条关键设计取舍（勿"改回去"）**：

1. `PointRecord.approvalRequestId` **未落库** —— 改由 `ApprovalRequest.executedRecordId` **单向**表达。
   **双向存同一个关系必然漂移**（"冗余的两份真相"正是本项目在修的那类缺陷）。
2. `Child.goodHabitCount` / `rewardCount` **未落库** —— 它们是聚合结果，**按需 COUNT**；
   落库正是 **A5（奖励次数虚高）** 的成因。

---

## 9. 非功能需求（NFR）

### 9.1 安全与隐私（**最高优先级**）

| 编号 | 需求 | 判定 |
|---|---|---|
| NFR-S1 | **客户端不可信**：`activeRole` 由服务端 `DeviceSession` 持有 | 改客户端存储无法提权 |
| NFR-S2 | **权限单点定义**：HTTP Guard 与 Agent 消费同一张矩阵 | 代码审查 + 契约生成闸门 |
| NFR-S3 | **账本 DB 层不可改**：应用角色 `REVOKE UPDATE, DELETE` | `npm run db:verify` 实测 `SQLSTATE 42501` |
| NFR-S4 | **审计不可改**：`AuditLog` 追加式 | DB 权限 + 无 UPDATE 路径 |
| NFR-S5 | **真实口令绝不入库**：`.env` 进 `.gitignore`，配 fail-closed 守卫（命中即 `exit 1`） | 命令级守卫 |
| NFR-S6 | **最小权限默认**：设备默认 `child` | —— |
| NFR-S7 | 儿童个人信息合规：采集前取得同意、可撤回、可导出/删除 | FR-12 全链路 |

### 9.2 数据正确性

| 编号 | 需求 |
|---|---|
| NFR-D1 | I1–I6 不变量全部有**自动化**测试且全绿 |
| NFR-D2 | 幂等：重复请求（双击/重放）账本只生效一次 |
| NFR-D3 | 事务边界：通知/推送**不**在账本事务内；失败不得回滚已成立的分 |
| NFR-D4 | **一次 schema 到位**：`PointRuleVersion` + 不可变 `PointRecord` + 软删除 + `AuditLog` **同批**落地（分批会产生**无法迁移的中间态**） |

### 9.3 性能与容量（首版基线）

| 项 | 目标 |
|---|---|
| 首页打卡响应 | 本地 UI 即时反馈（乐观更新）；服务端返回 < 500 ms（同城） |
| 列表渲染 | 流水/回收站列表分页或懒加载；单页 20 条 |
| 断网体验 | 断网/超时/401/403/202 均有**可读** UI 提示（W4 exit 验收项） |

### 9.4 可用性与兼容性

| 项 | 要求 |
|---|---|
| 双端一致 | 同一用例 Taro 与 Flutter **结论一致**（R1）；`AppStore` 方法名一一对应 |
| 屏幕适配 | 布局基准 390–430 逻辑像素（iPhone 尺寸） |
| 零第三方依赖（前端） | Flutter 侧仅用 SDK（无 provider / intl / shared_preferences），离线可 `pub get` |
| 无需图片资源 | 插画全部 `CustomPainter` 手绘 + emoji，避免资源路径报错 |
| 可视化 | 积分数字变化有滚动动画；颜色/文案均由派生函数产出 |

### 9.5 工程质量（"一个永远不会失败的检查等于没有检查"）

| 编号 | 需求 |
|---|---|
| NFR-Q1 | 每个缺陷修复必须附**能失败的反向对照**（改前红、改后绿） |
| NFR-Q2 | 测试器退出码必须真实传导失败（原 D12 CI 假绿） |
| NFR-Q3 | 断言必须断言**正确的事**（原 D13：断言把缺陷固化为"正确行为"） |
| NFR-Q4 | 文档与代码**对账**：台账声明与代码不符即红（`npm run defects:check`，19 条逐条核） |
| NFR-Q5 | 跨端契约由**闸门**守：`icons:check` / `relation:check` / `restrictions:check` |
| NFR-Q6 | 提交规范：`<type>(<scope>)` + 背景 + **验证证据**；共享状态操作**顺序执行** |

---

## 10. 技术架构与信任边界

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
        │  ① 成员资格门                    │
        │  ② PERMISSION_MATRIX ★唯一事实源 │──┐
        │  ③ 成员级收紧                    │  │ 同一张表
        │  action-dispatcher             │  │ 被两处消费
        │  账本内核（不可变 PointRecord）    │  │
        └───────────┬────────────────────┘  │
                    │                       ▼
                    │          ┌────────────────────────┐
                    │          │ backend_agent (Py3.12) │
                    │          │ LangGraph → 复用同一矩阵 │
                    │          └────────────────────────┘
                    ▼
        ┌────────────────────────────────┐
        │ PostgreSQL (Prisma 7.10)       │
        │  账本表：REVOKE UPDATE/DELETE    │
        └────────────────────────────────┘
```

**三条信任边界原则**：客户端不可信 / 权限单点定义 / 账本只增不改。
**关键接缝**：双端 `AppStore` 是接 API 的**天然接缝** —— 方法名一一对应，
接后端时只需把方法体换成 HTTP 调用，**UI 层无需改动**。

---

## 11. 里程碑与验收门（每个门都必须能"真实失败"）

| 阶段 | 内容 | AI 辅助工期 | 验收门 |
|---|---|---|---|
| **W0** | 环境与骨架 | 0.5 w | 环境一键起；schema 迁移成功且可回滚；**CI 诚实性探针通过**（注入必失败项 → 退出码 1） |
| **W1** | 身份与权限 | 0.5 w | 权限矩阵落地；Guard 单点消费 **✅ 四件都已接线：身份 `DeviceSessionGuard`（角色由服务端给出，W1-C）＋ 屏障一／二／三（W1-A/B）；**但三个端口（`Approvals` / `Membership` / `DeviceSession`）的持久化实现属 W2**
| **W2** | 账本内核 | 0.8 w | **I1–I6 全部有自动化测试且全绿**；`REVOKE UPDATE/DELETE` 生效 |
| **W3** | 审批流 | 0.5 w | 5 个终态全部可达；`autoReason` 5 种均可复现；双击"同意"账本只扣一次 |
| **W4** | 双端接入 | 0.8 w | 双端同一用例结论一致；断网/超时/401/403/202 均有可读 UI |
| **W5** | 引导与模板 | 1.0 w | 新用户从空态到完成首次打卡 **≤ 90 秒** |
| **W6** | 通知与 Agent | 0.4 w | 通知失败不影响账本；Agent 伪造角色被拒 |
| **W7** | 合规与加固 | 0.6 w | 同意/撤回/导出全链路 |
| **W8** | 联调与验收 | 0.5 w | `design/02` §9 的 **24 条**验收用例全绿；`design/03` **19 条**缺陷全部有回归用例 |
| **W9** | 缓冲 | 0.5 w | 保留（不做削减） |
| | **合计** | **≈ 6.1 w**（人工当量 10.5 w） | —— |

> **P1 决策：不压缩工期。** 压缩对象（编码）已被 AI 压缩，剩下的 **V（验证）与 N（内容/等待）压缩即降质**。
> 明确**不可压缩**：`PointRecord` 不可变 / `PointRuleVersion` / `balanceAfter`、三道屏障与权限矩阵、邀请码并发原子性。

---

## 12. 依赖与阻塞项（L1–L6）

| 编号 | 缺口 | 影响 | 负责/需求 | 必须启动 | 状态 |
|---|---|---|---|---|---|
| **L1** | 数据库与应用运行环境 | —— | —— | —— | ✅ **已解除**（PostgreSQL 18.6，库 `kids_points` + 角色 `kids_points_app`；`migrate`/`seed`/I5 实证/启动全通过） |
| **L2** | 微信小程序**正式 AppID（主体认证）** | 游客态**无法上传、无法真机预览、无法使用订阅消息** | 企业/个体主体认证；产品负责人 | **第 1 天**（1–7 工作日） | ✅ **已解除（2026-10-29）**：AppID `wx40666b1cbd5907c0` 已写入 `kids_points_mp/project.config.json`，AppSecret 注入 `backend/.env`（**不入库**）。★ 实证方式不靠"填好了"：拿**假** `js_code` 打 `sns/jscode2session` —— 有效凭据返回 `40029 invalid code`（说明 appid+secret 已通过校验），而 `.env` 里原来那份返回 `40125 invalid appsecret`（**早已失效**，本轮已替换）。⚠️ 但**登录链路仍未实现**（`WECHAT_MP_*` 在 `backend/src` 里零引用），订阅消息模板 ID 属 **L3** |
| **L3** | 推送通道凭据（订阅消息模板 / APNs / FCM） | W6 完成也无法触达用户 | 运维 | **W4 前** | ❌ 未启动 |
| **L4** | 域名 + HTTPS + **备案** | 小程序**无法请求**（微信强制 HTTPS 且域名备案）；L2 的服务器域名白名单也依赖它 | 域名注册 + 证书 + 备案；运维 | **第 1 天**（7–20 工作日） | ❌ 未启动 |
| **L5** | 监护人同意**法务文本** | 合规前置无法交付；W7 被阻塞；引导第①步就要展示 | 法务 | **W5 前** | ❌ 未启动 |
| **L6** | 内容角色（模板撰稿人） | 降级为"模板丰富度单薄" | —— | —— | ✅ **已按 P2 解除**（工程侧 18 条已交付 + 离线自检） |

> **关键排序**：**L4 是仅存的日历门**（L2 已于 2026-10-29 解除）—— 纯等待，不占工时却卡死关键路径。L2 解除**不等于**"能登录了"：AppID/Secret 只是**外部前置**，`code2session → 会话 token` 的端点一行都还没写。
> **必须与 W0 编码并行、第 1 天启动**，否则"≈6 周"会退化为 8–10 周。

---

## 13. 风险登记

| # | 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|---|
| **R1** | 双端 `AppStore` 方法语义漂移（Taro 与 Flutter 行为不一致） | 高 | 中 | 保留"同一用例双端各跑一遍"机制（`run.js` 与 `app_test.dart` 用例一一对应） |
| **R2** | 审批流跨时间导致 `invalidated` 场景覆盖不全 | 高（账本不平） | 中 | `autoReason` 枚举穷举 + 9.8 类用例；批准执行前**重新校验全部前提** |
| **R3** | 家长改规则后"今天不能打卡"引发投诉 | 中 | **高** | 改动前提示（**不是可选项**）：明确"已得的分不追回、今天起按新规则" |
| **R4** | 模板内容质量不足导致引导转化低 | 中 | 中 | L6 已解除，代价**如实计入**（`preschool` 1 条 / `junior_high` 0 条） |
| **R5** | 文档与代码不一致（"文档说没修、代码已修"） | 高 | 中 | 台账对账闸门 `defects:check`（19 条逐条核，**声明与代码不符即红**） |
| **R6** | CI 假绿（"一个永远不会失败的测试器"） | 高 | 低（已修） | 诚实性探针 + 反向对照；D12 已收口并留回归守卫 |

> **头号教训（贯穿全程）**：一个永远不会失败的检查项、一句永远不报错的 `REVOKE`、
> 一个从不生效的权限收回，**都只是"看起来在做安全"**。

---

## 14. 决策登记

### 14.1 已裁定（产品侧 P1–P4）

| 编号 | 决策点 | 结论 | 影响 |
|---|---|---|---|
| **P1** | 总工期 | ✅ **不压缩工期** | 基线按 **AI 辅助 ≈6.1 周**（人工当量 10.5 周）执行；W8/W9 的验证与缓冲**不做削减** |
| **P2** | L6（内容角色） | ✅ **不到位** | 模板库由 90 条 → **18 条**；O1 由 2.0 → 0.5 人日；代价计入 R4 |
| **P3** | 不可变性与规则版本 | ✅ **确认定稿** | `PointRecord` 追加写、`PointRuleVersion` 版本化、软删除、`AuditLog` **四项同批落地** |
| **P4** | 申请人能否自批 | ✅ **允许，但必须显式**（申请时勾选"自动审批" 或 提交后本人二次确认） | 解**单家长家庭兑换死锁**；`redeem` 的矩阵**不变**；判据＝`canSelfApprove()`（由矩阵导出），**不新增字段 / 枚举 / 迁移** |

### 14.2 实现层决策（D1–D10，源自 W0）

> 属实现层，其中 **D2 / D4 / D6 / D7 / D10 直接影响数据正确性与安全性**。完整清单见 `design/06` §3.1。

| 编号 | 决策（摘要） |
|---|---|
| D1 | 需新增 `User` 与 `UserChildRelation`（原设计缺失） |
| D2 | `goodHabitCount` / `rewardCount` **不落库**，按需 COUNT |
| D3 | 软删除过滤只在唯一一处实现 |
| D4 | `PointRecord.approvalRequestId` **不落库**，改由 `ApprovalRequest.executedRecordId` 单向表达 |
| D5 | 库内列名为 camelCase（无 `@map`） |
| D6 | 权限矩阵**只有两列**，`viewer` 一律 `DENY` |
| D7 | `activeRole` 由服务端 `DeviceSession` 持有 |
| D8 | 事务边界：通知/推送不在账本事务内 |
| D9 | 图标字段跨端只存**名字**（`iconName`），数据层不认字形（阶段 C5 已落地） |
| D10 | 邀请码用**单条条件 UPDATE** 原子占位 |

### 14.3 待决策

**产品侧：无。** P1 / P2 / P3 均已裁定。

---

## 15. 当前落地状态（**诚实标注，2026-10-14**）

> 本节回答"现在到底有什么"。所有数字均来自**可执行命令的实测**，与 `design/README.md` 的进度节一致。

### 15.1 已完成并有实测证据

| 项 | 状态 | 证据（最新基线） |
|---|---|---|
| Flutter 端 UI | ✅ 6 屏 + 弹窗 + 组件，与小程序行为一致 | `flutter analyze` → **0 issue**；`flutter test` → **296/296** |
| Taro 小程序端 UI | ✅ 6 页 + 11 个 sheet（`sheets/` 下 12 个 `.tsx`，其中 `ActionRow` 是行组件），与 Flutter 像素级对齐 | `npx tsc --noEmit` → `EXIT=0`；`npm run build:weapp` → `EXIT=0`；`node .tmp_test/run.js` → **91 PASS / ALL PASS** |
| 既有缺陷台账（19 条） | ✅ **19/19 已修**（A1/A2/A3/A4/A5、B6/B7/B8、C9/C10/C11、D9/D12/D13、E15/E16/E17/E18/E19） | `npm run defects:check` → `ALL PASS` |
| 后端 schema | ✅ **18 表 / 14 枚举**，含 `PointRuleVersion` + 不可变账本 + 软删除 + `AuditLog`（**同批**） | `prisma validate` + `generate` 通过；迁移 `20261012022042_w0_init` 已应用 |
| 后端骨架 | ✅ 13 个模块（`approvals` / `device-session` / `membership` / `ledger` / `permissions` / `idempotency` 已有实体实现；其余仍为占位）＋ Prisma 7 adapter | `tsc --noEmit` / `nest build` EXIT=0 |
| **I5 账本不可改（真实库实证）** | ✅ | `npm run db:verify` → 7 项全 PASS；**两次反向对照均能变红** |
| 应用真实启动 | ✅ | `数据库已连接` + `已启动：http://localhost:3000`；无 `DATABASE_URL` 时**退出码 1 响亮失败** |
| 跨语言契约 | ✅ `contracts/permission-matrix.json`（**42 动作**，含 W7-A 的 `view_consent` / `manage_consent`、W7-C 的 `export_family_data`、W7-D 的 `view_family_deletion` / `manage_family_deletion`、W8-A 的 `view_onboarding` / `apply_onboarding` 与 W8-C 的 `manage_parent_pin`（`switch_role_mode` 自 W0 就在表里，W8-C 才第一次有端点），由 TS 生成） | `contracts:emit` |
| **自批策略（"谁可以批准"的定义）** | ✅ **契约 + HTTP 路径 + 真库执行**：`approval-policy.ts`（含 W3-B 的 `withdrawDenial()`）＋ 真 HTTP `test/approvals-http.test.ts` ＋ 真库同事务 `test-db/approvals-execution-db.dbtest.ts`；W3-A / W3-B / W3-C 见 `design/README` | `npm test` → **14 个文件 / 261 条**；`npm run test:db` → **5 个文件 / 75 条**（均全绿） |
| **家庭数据导出（W7-C，2026-10-27）** | ✅ **后端 + 双端客户端**：`GET /export`（guardian ALLOW / child DENY，矩阵 `export_family_data`）把孩子的档案、家庭成员、规则与版本、习惯、心愿、积分流水、审批、同意记录、审计日志打成**一份 JSON**，`summary.counts` / `totals` / `truncatedSections` 如实标注被单次上限截断的段；**不受 `ConsentGuard` 管辖**（撤回同意后仍可用，04 §5 可携带权）；客户端只解析文件头与摘要、**从不重排九段正文**，复制的是服务端原文；刷新失败时同时报错并标明「下面是上一次生成的文件」。证据：`npm test` **43 文件 / 780 条全绿**、`npm run ci` **CI_EXIT=0**；`flutter analyze` 0 issue、`flutter test` **296/296**（新增 `export_test.dart` 22 条）；小程序 `npx tsc --noEmit` / `build:weapp` EXIT=0、`node .tmp_test/run.js` **91 PASS**、`node .tmp_test/run-w7c.mjs` **12/12**（导出数据层：截断自洽 / `rawJson` 逐字 / 错误归一 / 单飞 / 失败保留旧文件）；**真库 `npm run test:db` 19 文件 / 265 用例全绿（`export-db.dbtest.ts` 19/19）、`npm run ci:db` EXIT=0** | 真库侧只覆盖「未截断」的形状（真截断未触发过）；小程序 `ExportSheet` 的渲染分支仍只有编译证据 |
| **家庭数据删除（W7-D，2026-10-27）** | ✅ **后端 + 双端客户端**：`GET /family-deletion` / `POST /family-deletion`（`{confirmed:true}`）/ `POST /family-deletion/cancel`（矩阵 `view_family_deletion` / `manage_family_deletion`，guardian ALLOW / child DENY，**均不受 `ConsentGuard` 管辖** —— 撤回同意后仍必须能删，04 §5）。申请进入 **7 天冷却期**（`scheduledFor` 落库，跨重启成立），期间可撤销；到期由 `FamilyDeletionWorker` 在**同一事务**内就地匿名化：孩子昵称 / 年龄段 / 兴趣、成员 PIN 与限制、规则与版本文字、习惯 / 心愿标题、流水文本、审批 payload 里的字符串、通知正文、同意 IP / UA 抹掉；**流水数值、`balanceAfter`、余额、审计追加行保留**（02 §5.7 I5）。摘要（十类行数 + 保留条数 / 余额）落库并原样回放；`{confirmed:false}` / 缺字段 / 字符串一律 400；部分唯一索引保证「一个孩子最多一条 pending」；900 脚本新增**列级** UPDATE 例外（文本列可抹、`pointsDelta` / `balanceAfter` / `points` 仍 42501）并自检。双端面板：先判角色、显示剩余天数 / 撤销 / 执行摘要、读失败不清空旧状态。证据：`npm test` **47 文件 / 830 条全绿**、`npm run ci` **CI_EXIT=0**、`db:verify` **ALL PASS**、`test:db` **20 文件 / 287 条全绿**（`deletion-db.dbtest.ts` 22/22，21 秒）、`flutter analyze` 0 issue、`flutter test` **315/315**（新增 19 条）、小程序 `tsc` / `build:weapp` EXIT=0、`run.js` 91 PASS、`run-w7d.mjs` **17/17** | 审计日志里的历史文本**不抹**（追加式，02 §5.7）；多 worker 并发抢同一行只靠 `SKIP LOCKED` 设计、**未压测**；「自然人注销 / 跨孩子删除」不在本轮范围；法务文本仍是占位版本 |
| **首启引导后端（W8-A，2026-10-27）** | ✅ **后端已落地**（双端 UI 见下一行 W8-B）：`GET /onboarding`（矩阵 `view_onboarding`，**不受 `ConsentGuard` 管辖** —— 未同意时引导页必须能打开，第①步的同意按钮才有地方渲染）＋ `PATCH /onboarding/profile`（③④步草稿：`undefined` 沿用 / `null` 清空学段 / `[]` 一个都不选；值未变**不写库不写审计**）＋ `POST /onboarding/complete`（矩阵 `apply_onboarding`，**受管** —— 第②步起就采集昵称，同意必须先于采集）。`complete` **非幂等**（重复 ⇒ `409 ONBOARDING_ALREADY_COMPLETED`，绝不悄悄再建一套规则）；**事务内**用 `WHERE slug IN (…) AND status='active'` 重新校验模板，缺一条即 `404 ONBOARDING_TEMPLATE_NOT_AVAILABLE` 且**一条规则都不建**（防「加载时还在、提交时已下架」的 TOCTOU 孤儿规则）；规则按**提交顺序**复制模板字段（不是只存标题），每条附 `version=1` 版本行（`changeNote` 记 slug，来源可追）；`onboardedAt` / `ageBand` / `focusAreas` 同事务落库；可选第⑥步 PIN 写成自描述 `scrypt$N$r$p$keylen$salt$hash`（`ChildMember` 无独立 salt 列），审计只记 `pinSet`、**不记哈希与明文**；模板排序 = 学段 → 关注点命中数 → `sortWeight` → slug（**排序而非过滤**）；无库装配三路由 **全 501**，绝不返回假 `{ onboarded: false }`。证据：`npm test` **50 文件 / 910 条全绿**（新增 `onboarding-http` / `onboarding-policy` / `onboarding-wiring`）、`honesty:probe` 5 项全 PASS（§7 表格 41 行 == 矩阵 41 个动作）、`test:db` **21 文件 / 315 条全绿**（`onboarding-db.dbtest.ts` 7 组，含「模板下架 404 零副作用」「版本行 42501 不可删」两条真库独有断言） | **「切家长模式」（PIN 校验）端点未实现** —— 本轮只写入哈希，`pinSetAt` 只是事实记录、不代表 PIN 保护已生效（02 §7 仍未收口）；双端引导 UI 已由 W8-B 落地；排序的「命中数」只按字符串相等计数、未做模糊匹配；真库侧未覆盖「并发两次 `complete`」（靠 `SELECT … FOR UPDATE` 设计，未压测） |
| **首启引导双端 UI（W8-B，2026-10-27）** | ✅ **后端不变，补上双端七步流程**：Flutter `OnboardingScreen`（①欢迎 + 监护人同意 → ②昵称 → ③学段 → ④关注点 → ⑤选约定 → ⑥PIN → ⑦完成）＋ `OnboardingGate`（启动闸门）；小程序 `pages/onboarding/**` ＋ 首页 `redirectTo`。**闸门只在服务端明确 `onboarded:false` 时拦** —— 403（孩子身份 / 只读成员）与网络错误**一律放行到首页**（「不知道」≠「未引导」；一次超时不该变成一场发不出请求的强制引导），「我的」页留「继续首次引导 / 重试读取引导状态」。第①步**未勾选同意不发请求**（`04` §5：同意先于采集；后端 `ConsentGuard` 只是兜底，不该等到第⑥步才 403）；第③④步三种意图分别发 `{ageBand}` / `{ageBand:null}` / `{focusAreas:[]}`，且值与服务端相同时**不发请求**。`complete` 成功后用**既有**端点 `POST /point-rules/:id/habits` **逐条**补习惯（`04` §6 4.3 要求首页真有习惯；扣分约定不加 —— A1；409 `HABIT_ALREADY_EXISTS` 视为已在；单条失败不回滚引导，只进第⑦步「需手动」清单），随后 `refreshFromServer()`。`complete` 409 双端都**重拉状态**而非原地重试。新增闸门 `npm run onboarding:check`（`tools/onboarding-options-check.mjs`）：4 学段 / 6 关注点在后端契约、Flutter、小程序三处**逐字同序**（文件缺失 / 解析为空 fail-closed；3 例证伪全红）。证据：`flutter analyze` 0 issue、`flutter test` **338/338**（新增 `onboarding_test.dart` **23**）、小程序 `tsc` / `build:weapp` EXIT=0、`run-w8b.mjs` **14/14**（常量 / DTO 六种坏形状 / 请求形状 / 409·501 / store 五种状态转换）、`onboarding:check` PASS、`npm run ci` **CI_EXIT=0** | **「切家长模式」PIN 校验端点仍未实现** —— PIN 只是写入哈希，`02` §7 未收口；双端证据是编译 + 单测 + 假传输层，**无真机 / 真库的 UI 级 E2E**；小程序闸门只在首页生效（将来从分享卡片直达二级页会绕过）；`junior_high` 模板为 0 条、第⑤步列表会偏薄（`04` §4 R4）；法务文本仍占位 |
| **切家长模式 + 家长 PIN（W8-C，2026-10-27）** | ✅ **后端已落地**（双端入口见下一行）：`GET/POST/DELETE /auth/parent-mode`（矩阵 `switch_role_mode`，guardian / child **都是 ALLOW** —— PIN 就是那道门，孩子可以负责把手机递给家长）＋ `POST /auth/parent-pin`（矩阵 `manage_parent_pin`，**child DENY**）。`POST` 用 `verifyPin()` 换 **5 分钟**家长模式，回包给**绝对时刻** `parentModeExpiresAt` ＋ `remainingSeconds`（客户端不许自己从 5:00 数：手机时间不准、后台挂起都会让它说谎）；`DELETE` **不验 PIN、不要求当前是家长**，幂等 200，锁定期间也可用（降级永不设门槛）；`GET` 让 App 重启后知道"我还在不在家长模式"。失败计数落在**成员位**（`ChildMember.pinFailedCount` / `pinLockedUntil`）⇒ 换台设备也绕不过；连错 **5 次锁 15 分钟**，锁定期内**连 scrypt 都不跑**；**格式错不计次**（`400 PARENT_PIN_FORMAT_INVALID` 而不是 403 —— 手滑不是猜）；触发锁定的那一次直接 **429** ＋ `retryAfterSeconds`（与"已锁定"同一 code，客户端一个分支）。`setParentPin` 已有 PIN 时**必须带 `currentPin`**（缺 ⇒ 400 且不写库、错 ⇒ 403 并计次、锁定 ⇒ 429），成功后写自描述 `scrypt$…` 哈希、`pinSetAt`、清零计数，同事务写审计；明文只在 service 内出现，端口签名只有 `pinHash`，审计只记 `pinConfigured` / `changed` 布尔。两个动作**都豁免 `ConsentGuard`** —— 撤回同意后必须仍能进家长模式重新同意，否则死锁。矩阵 **41 → 42 动作**（迁移 `20261027160000_parent_pin_action`），`contracts:emit` 重新生成（42），`honesty:probe` 5 项 ALL PASS（§7 表格 42 行 == 矩阵 42 动作）。证据：`npm test` **52 文件 / 970 条全绿**（新增 `auth-http` 组 A–F ＋ `parent-mode-policy` 穷举 ＋ `test/support/auth-fake.ts` 镜像策略算术） | **没有"忘记 PIN"的重置通道** —— `02` §7 未定义，本轮**故意**留白（任何无凭据重置都会把 PIN 变成装饰品；真要补应走 L2 监护人身份再验证）；`manage_parent_pin` 要求会话 `activeRole=guardian`，所以**孩子模式会话里改 PIN 是 403**（首次设置在家长登录 / 引导时完成，之后想改得先用 PIN 进家长模式）；`02` §7 的「**每次 guardian 操作刷新 TTL**」本轮只做了"进入时刷新"，其它 guardian 写操作尚未续期；真机 / 真库 UI 级 E2E 未做 |
| **切家长模式的双端入口（W8-C 客户端，2026-10-27）** | ✅ **Flutter ＋ 小程序**：「我的」页的家长模式面板（进入 / 退出 / 设改 PIN、还剩 N 次、锁定到几点、读失败不清空旧快照）。★ **契约补了 `modeSource`** —— `parentMode:true` 有两种来路：`pin`（PIN 换的 5 分钟）与 `session`（邀请码加入的家长设备，30 天登录会话自带 `guardian`）。原先两端 DTO 只按「剩余 ≤300 秒」硬校验，家长本机拿到的 **2 592 000 秒**会被判成「数据格式不符合预期」，即便放过也会把 30 天画成 `43200:00 后自动收回`；现在按来源分别校验（`pin ⇒ 1..300` / `session ⇒ 301..一年` / 不在家长模式 ⇒ `null` + `0`），`session` 的文案改为「已以家长身份登录 / 登录期间一直是家长权限」并提示共用手机用完退出。证据：`flutter analyze` 0 issue、`flutter test` **372/372**（其中 `parent_mode_test.dart` 34 条，含 session 回归 3 条）、小程序 `tsc --noEmit` EXIT=0、`node .tmp_test/run-w8c.mjs` **38/38 ALL PASS**、后端 `npm test` **52 文件 / 974 条**、`npm run test:db` **22 文件 / 345 条**全绿 | 「忘记 PIN」仍无找回通道；`02` §7「每次 guardian 操作刷新 TTL」只做了进入时；真机 / 真库 UI 级 E2E 未做 |
| 跨端契约闸门 | ✅ `icons:check` / `onboarding:check` / `relation:check` / `restrictions:check` | `npm run ci` → **16 步全绿，`CI_EXIT=0`** |
| 首启空态 + 演示数据守卫 | ✅（E18 收口） | release/profile 构建入口被树摇 |

### 15.2 **尚未落地**（不粉饰）

| 项 | 状态 | 影响 |
|---|---|---|
| **后端业务实现** | ⚠️ **不再是空签名**（`permissions` 的屏障二 Guard、`approvals` 的 controller / 端口已有实体代码），**W4 起有只读 `GET /home` / `GET /records`**，**W4-D 起有打卡 / 撤销**，**W5-A 起有规则四条写端点**（`/point-rules` 建 / 改 / 软删 / 加习惯）；**W5-G（2026-10-22）起有邀请码四条端点**（`/invites` 建 / 列 / 吊销 + `/invites/accept` 原子占位）；**习惯 CRUD / 成员管理等端点仍不存在** | 剩余主体工作量（习惯 CRUD / 成员管理 / 双端邀请码界面）；`accept` 仍需调用方已有会话（登录链路 L2 未落地） |
| **RBAC 三道屏障 ＋ 身份** | ✅ **身份与三道屏障都在请求路径上**（2026-10-15）：身份 `DeviceSessionGuard`（**角色 / userId 由服务端会话行给出**，客户端只发 `x-kp-device-id` ＋ `x-kp-child-id`；`x-kp-role` / `x-kp-user-id` 已废弃且不再被读取，W1-C）、屏障一 `MembershipGuard`、屏障二 `PermissionsGuard`（矩阵）、屏障三 `tightenVerdict()`（成员级收紧，W1-B）。⚠️ 但~~**成员位与会话查询都来自端口，默认实现是 501**（真库查询属 W2）~~ → **W2-D（2026-10-16）已结清：有库真查库、无库才是 501**、**金额阈值键此刻不生效**（属 dispatcher）、**设备凭据不可验证**（`deviceId` 可伪造 ⇒ 生产 503）、**PIN 切换 / 会话刷新未实现** | 三个端口的 Prisma 实现**均已交付**（`Membership` / `DeviceSession` = W2-D；`Approvals` = **W3-A**）；**别把"角色不再由客户端自选"读成"身份已完成"**（真正可验证的凭据要等 L2 之后的会话 token） |
| **审批写入路径（落库 / 撤回）** | ✅ **W3-A**：批准 / 自批在**同一事务**写 `ApprovalRequest` 终态 ＋ `PointRecord` ＋ `Child.pointsBalance` ＋ `AuditLog`（有库）；✅ **W3-B**：`withdrawn` 可达（只有申请人本人、零账本变化）＋ 审批读写按 `childId` 收口（跨孩子 `404`）。✅ **W3-C（2026-10-18）收尾**：执行器覆盖 `redeem` / `request_redeem` / `request_points_bonus` / `add_wish`；`autoReason` **五种全部可复现**；`expired` 有后台扫描（`ApprovalsExpiryService`）；`Idempotency-Key` 已接到 create / decide / withdraw（无库 501）。真库证据：`test-db/approvals-closing-db.dbtest.ts`（5 文件 / 75 条） | 审批状态机本身已收尾；W4 起是**其它业务模块**（规则 / 习惯 / 心愿 / 邀请等端点） |
| **双端接 API** | ✅ **W4-C** 起双端只读接入；**W4-E** 起首页打卡 / 撤销真写；**W5-A** 起规则四条写入口真写（未配 env 仍为本地预览）；其余写入口仍本地 | 见 `design/` 的 W4 / W5-A 段；**"接了 API"≠"全部写入口都通了"** |
| **首次引导与模板（后端 / UI）** | ✅ **后端 W8-A（2026-10-27）已落地**：`GET /onboarding` / `PATCH /onboarding/profile` / `POST /onboarding/complete`（读豁免同意、写受管；完成时事务内把模板复制成规则 + v1 版本行 + 可选 PIN 哈希，详见上表）＋ 无库装配三路由 **501**；❌ **双端 UI 仍未开发**（空态目前只渲染空列表，仅界面冒烟用例保证不崩） | W5；**「空态」≠「引导已完成」**；引导端点目前**没有前端调用点** |
| **监护人同意链路（W7-A，2026-10-26）** | ✅ **后端已落地，前端未接**：`GuardianConsent`（表自 W0 就在 schema 里，本轮才第一次被读写）＋ `GET /consent` / `POST /consent`（显式 `accepted: true`，协议版本由服务端 `CONSENT_TEXT_VERSION` 决定）/ `POST /consent/withdraw`（从未授予 ⇒ `409 CONSENT_NOT_GRANTED`；重复撤回幂等；同版本重复授予不写审计）＋ **第四道屏障 `ConsentGuard`**：按 `contracts/consent-policy.ts` 的**显式清单**（24 写 / 16 豁免，两个集合恰好划分 40 个动作；多出的 `export_family_data` 由 W7-C、`view_family_deletion` / `manage_family_deletion` 由 W7-D 归入豁免侧）拦撤回后的写入，`403 CONSENT_REQUIRED` 带 `details.status`；`none`（从未同意）**同样拦**（不自动补一条假同意）；IP / UA 只存 HMAC（`CONSENT_PII_SALT` 未配 ⇒ 该列为空，绝不退回无盐哈希或明文）。证据：`npm test` **41 文件 / 746 条全绿**（新增 `consent-policy` / `consent-guard` / `consent-http` / `consent-pii` 四份） | **L5 法务文本未定稿**（版本号仍是占位 `2026-10-draft`）；**引导第①步的勾选与前端入口未开发**（前端仍无 consent 界面）；数据删除已由 **W7-D（2026-10-27）** 落地（申请 / 冷却 / 撤销 / 就地匿名化，`02` §9.20 的 ❌ 已收回）；真库侧的并发幂等（`SELECT … FOR UPDATE`）**尚无用例覆盖**（无库 CI 验不了） |
| **通知 / 推送** | ⚠️ **服务端链路已建，触达仍为 0**：W5-K 推送端口 ＋ W5-L 站内通知中心 ＋ W6-A 设备 token 上报 / 真 Webhook 适配器 ＋ W6-B 失败重试队列（`PushRetryJob`：指数退避 ＋ TTL ＋ `claimTimeout` 回收）＋ **W6-C 审批提醒真 outbox**（`Notification` + `PushRetryJob` 与审批**同事务**，请求路径零推送）＋ **W6-D 对账与保留清理**（对账**只读、只告警、绝不自动补发**：单边缺失 ＋ 重复通知；`sent`/`expired` 7 天、`dead` 30 天后分批删除，`pending`/`sending` 永不删）；**W6-E Flutter 客户端上报已接**（启动 fire-and-forget；独立 `DeviceTokenApi`、单飞 / 去重 / 409 不重试、日志不含 token；**当前 token 来源仅调试构建**）＋ **W6-F 生命周期重报**（`PushTokenRuntime` 进程级持有；只在 `resumed` 按 5 分钟冷却重报，失败也消耗窗口；`revoke()` 先停用再注销，退出登录后 resume 不会重新登记；`dispose()` 等在途请求结束才关 HttpClient）；**W6-G 推送链路端到端冒烟**（真 `AppModule` ＋ 真 Prisma ＋ 真 `PushRetryWorker.tick()` ＋ 真 `WebhookPushAdapter` → 本地 `node:http` 网关；200 / 500 / 410 / 无 token 四类分支；500 后业务不回滚、无 token 不烧次数；证据 `test:db` **246/246**）；**仍无 L3 凭据 / 生产网关 / 真实厂商 SDK**，故**未配 `KP_PUSH_TOKEN` 时**线上 `DeviceToken` 与 `PushRetryJob` 仍然为空，**真机推送一次都没发生过** | W6 剩余：厂商凭据 · 生产网关 · 真实 SDK / 真机验证（明细见 `design/29-w6a-handoff.md` §5、`design/30-w6b-handoff.md` §6、`design/31-w6c-handoff.md` §8、`design/32-w6d-handoff.md` §5、`design/33-w6e-handoff.md` §5、`design/34-w6f-handoff.md` §5、`design/35-w6g-handoff.md` §5） |
| **Agent** | ❌ 待建 | W6 |
| **前端两条流水线进 CI** | ⚠️ 未接入 CI 平台（第 1–2 步尚未进 `npm run ci`）；`run.js` 跑 `dist/` 产物，**必须现编**否则会用旧代码考满分 | 见 §16.3 |
| **`persistence`** | ⚠️ 内存态；接持久化只需在 `AppStore._persist()` 写入 shared_preferences / sqflite，UI 无需改动 | 见 `lib/data/app_store.dart` 注释 |

### 15.3 计划的下一步

按 §11 顺序推进：**W1（身份 ＋ 三道屏障）／ W2（账本内核 ＋ 三个端口真库实现）／
W3-A / W3-B / W3-C（审批执行路径 ＋ 撤回 ＋ 租户隔离 ＋ 执行器/扫描/幂等键）均已落地**
（见 `design/README` 的 W2-D / W3-A / W3-B / W3-C 段）。

**下一步（W4）**：
1. **W4 双端接 API**：`AppStore` 目前仍是内存态；W4 exit = 双端同一用例结论一致，
   断网 / 超时 / 401 / 403 / 202 都有可读 UI。
2. **并行启动 L2 / L4**（微信 AppID / 域名备案）；W5 引导与模板需 L5 法务文本；
   L3 推送凭据须在 W4 前到位。
3. 后端其它业务模块（规则 / 习惯 / 心愿 / 邀请）按需在 W4–W6 补齐 —— 它们的端点
   **不在 W3 的验收范围**，不要因为审批已收尾就以为它们已经能用。
   （**W5-G 已补上邀请码的服务端四条端点**，但双端没有界面、`accept` 仍需已登录会话；
   **W5-H 已补上成员管理的服务端三条端点** —— `GET /members` / `PATCH /members/:id` /
   `DELETE /members/:id`，含「最后一位家长」并发保护与降级即收回会话，双端同样**没有界面**；
   习惯 CRUD 仍不存在 —— 详见 `design/24-w5g-handoff.md` 与 `design/25-w5h-handoff.md`。）

审批的任何新写入路径**必须继续消费** `backend/src/contracts/approval-policy.ts`（P4 ＋ W3-B 的
`withdrawDenial()`），不得在 controller / service 里另写一份「谁可以批准 / 谁能撤回」。


> **W1-C 的两句真话（别读错）**：① **"角色不再由客户端自选"≠"身份已完成"** ——
> 会话来源已可信，但**设备凭据（`deviceId`）仍可伪造**，故 `NODE_ENV=production` 一律 503
> （真正可验证的凭据要等 L2 之后的会话 token）；② **"身份判定已接线"≠"能登录了"** ——
> 会话查询端口**在无库装配下**仍是 **501**（有库时 W2-D 起真查库，查不到即 401 `SESSION_NOT_FOUND`），
> **每个请求都会被拒**（fail-closed，而不是放行）。

---

## 16. 附录

### 16.1 术语表

| 术语 | 含义 |
|---|---|
| 账本 / Ledger | 由不可变流水（`PointRecord`）构成的分账本，余额为其滚动和 |
| 冲正（reverse） | 不改原记录，而是写一条反向记录抵消，保证账本可追溯（I6） |
| 软删除（soft delete） | 置 `status=deleted` + `deletedAt`，可恢复；回收站保留 90 天 |
| 规则版本（`PointRuleVersion`） | 规则每次变更归档旧版本、只增不删，供历史流水钉住（I3） |
| 快照（snapshot） | 流水/审计里保存的**当时**标题、条件、频次、分值等，深拷贝 | 
| 三道屏障 | 成员资格门 → 权限矩阵 → 成员级收紧（只能收紧） |
| 身份（`DeviceSession`） | 服务端持有的"**这台设备在这份档案上是谁**"：`(deviceId, childId)` → `userId` ＋ `activeRole`；TTL 到期 `guardian` **回落 `child`**（降级而非 401）；角色**不存客户端**（W1-C） |
| 归一化 | 孩子的 `adjust_points(+N)` 转成 `request_points_bonus` 申请 |
| 日历门 | 纯等待型依赖（认证、备案），不占工时但卡关键路径 |
| 假绿 | 检查/CI 实际失败却报成功（D12）；本项目头号反面教材 |
| 守门人 | 对账闸门脚本（`defects:check` 等），声明与代码不符即红 |

### 16.2 文档导航

- 系统概览与架构 → [`design/01-overview.md`](./design/01-overview.md)
- 权限矩阵、审批流、账本不可变性 → [`design/02-rbac-and-approval.md`](./design/02-rbac-and-approval.md)
- 缺陷清单（19 条）→ [`design/03-existing-defects.md`](./design/03-existing-defects.md)
- 引导与模板库 → [`design/04-onboarding-and-templates.md`](./design/04-onboarding-and-templates.md)
- 开发计划、风险、阻塞项、决策 → [`design/05-dev-plan.md`](./design/05-dev-plan.md)
- W0 实施报告（真实命令与退出码）→ [`design/06-w0-report.md`](./design/06-w0-report.md)
- 各阶段交接单 → [`design/07`](./design/07-c3-handoff.md) · [`08`](./design/08-c4-handoff.md) · [`09`](./design/09-c5-handoff.md) · [`10`](./design/10-d1b-handoff.md) · [`11`](./design/11-d3b-handoff.md) · [`12`](./design/12-w3c-handoff.md)
- 设计文档索引 → [`design/README.md`](./design/README.md)
- 工程入门（运行/测试/目录）→ [`../README.md`](../README.md)

### 16.3 运行与验证命令（复现基线）

```bash
# 1) 前端 Taro（kids_points_mp/）—— 必须先现编产物，否则用旧代码考满分
npx tsc --noEmit -p tsconfig.json
npx tsc src/data/{store,seed,types}.ts src/utils/color.ts \
    --outDir .tmp_test/dist --module commonjs --target es2017 \
    --strictNullChecks --esModuleInterop --skipLibCheck
node .tmp_test/run.js                      # 期望 91 PASS / ALL PASS

# 2) 前端 Flutter
flutter analyze                            # 期望 No issues found!
flutter test                               # 期望 315/315

# 3) 后端（backend/）
npm run ci                                 # 期望 CI_EXIT=0（15 步）
npm run ci:db                              # 期望 db:verify ALL PASS ＋ 20 文件 / 287 条全绿
```

### 16.4 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-14 | 初版：整合 `design/01`–`11` 的事实，形成需求侧 PRD；含目标与指标、FR-01–FR-12、不变量 I1–I6、25 动作权限矩阵、18 表/14 枚举摘要、NFR、里程碑 W0–W9、阻塞项与风险、当前落地状态 |
| v1.1 | 2026-10-24 | §7 权限矩阵同步至 **35 动作**：补上 W5-H / W5-J / W5-L / W6-A 期间新增却被漏记的 6 条（`view_members`、`change_member_role`、`view_own_approvals`、`view_notifications`、`read_notifications`、`manage_device_tokens`）。**并补上守卫 ⑤**（`honesty:probe` 检查 E ＋ `test:canfail` 检查 D）：文档表格与 `permission-matrix.ts` 逐行对账，故意漂移的夹具必须让闸门变红 —— 此前十几轮 CI 全绿，只因没有一条检查读过文档 |
| v1.2 | 2026-10-24 | **FR-09 补上 W6-D 的两条需求**：投递可观测（对账只告警、不自动补发）与投递事实保留（只删终态、三档保留期）；§15 通知 / 推送行同步。**仍无厂商凭据 / 网关 / 客户端上报，真机推送一次都没发生过** —— 本轮补的是「出了问题能看见、表不会无限长」，不是触达 |
| v1.3 | 2026-10-25 | **§15 通知 / 推送行同步 W6-E**：Flutter 启动时已能上报设备 token（独立 `DeviceTokenApi`、单飞 / 去重 / 409 不重试、日志不含 token；编译期 token 仅调试构建）。§15 的“没有客户端上报”改为“未配 `KP_PUSH_TOKEN` 时仍为空”；W6 剩余收敛为「厂商凭据 · 网关 · 真实 SDK / 生命周期重报」。**仍无 L3 凭据 / 网关 / 真机推送证据**，小程序因缺微信登录刻意未接 |
| v1.4 | 2026-10-25 | **§15 通知 / 推送行同步 W6-F**：新增 `PushTokenRuntime` 进程级运行时 —— App 回到前台（只认 `resumed`）按 **5 分钟冷却**重读 token 并补报；失败也消耗冷却窗口；`revoke()` **先停用再注销**，退出登录后 resume 不会重新登记；`dispose()` 等在途请求结束才关 HttpClient。`PushTokenLifecycle` 是唯一 Flutter 绑定胶水。证据：新增 16 条，`flutter analyze` 无问题、`flutter test` **256/256**。W6 剩余收敛为「厂商凭据 · 网关 · 真实 SDK / 真机验证」；**仍无真实厂商 SDK / token refresh 流 / 登录流程调用点 / 真机证据** |
| v1.5 | 2026-10-25 | **§15 通知 / 推送行同步 W6-G**：新增 `test-db/push-delivery-e2e-db.dbtest.ts`，用真 `AppModule` ＋ 真 Prisma ＋ 真 `PushRetryWorker.tick()` ＋ 真 `WebhookPushAdapter` 打到本地 `node:http` 网关，第一次把「审批 HTTP → 同事务 outbox → 领件 → 查 token → POST → 结算」跑通。网关 200 / 500 / 410 / 无 token 四类分支分别钉死 `sent`、渠道故障重试、token 下线、结构性失败不烧次数；★ 500 后审批仍 `approved`、心愿仍落库（推送失败不回滚业务）。只覆盖 `PUSH_DELIVERY_PORT` 与 `batchSize=1`，**不需要 L2/L3 凭据**。证据：`test:db` **246/246**（本套件 6 条）、`npm test` **693/693**。W6 剩余收敛为「厂商凭据 · 生产网关 · 真实 SDK / 真机验证」；**本地网关不是 APNs/FCM，无客户端参与，`tick()` 手动调用未验调度 / 重启，真机推送一次都没发生过** |
| v1.6 | 2026-10-26 | **§7 / §15 同步 W7-A**：权限矩阵 **35 → 37 动作**（新增 `view_consent` / `manage_consent`，对孩子均 DENY；两者在 `contracts/consent-policy.ts` 里是**撤回闸门的豁免口** —— 否则「可撤回」会变成「可永久锁死」）；§15 新增「监护人同意链路」一行，明确「**后端已落地、前端未接、导出仍未实现**」。本轮补的是**撤回后写入停止**这条可执行事实（24 个写动作 403 `CONSENT_REQUIRED`），不是合规闭环。证据：`npm test` **41 文件 / 746 条全绿**；`honesty:probe` 5 项全 PASS（含 §7 表格与矩阵**逐行**对账“表格 37 行 == 矩阵 37 个动作”） |
| v1.7 | 2026-10-27 | **§7 / §15 同步 W7-C（家庭数据导出）**：权限矩阵 **37 → 38 动作**（新增 `export_family_data`，guardian ALLOW / **child DENY**；★ **不挂 `ConsentGuard`** —— 撤回同意后仍必须可用，属 04 §5 可携带权，因此写 / 豁免划分变为 **24 / 14**）。`GET /export` 把档案 / 成员 / 规则与版本 / 习惯 / 心愿 / 流水 / 审批 / 同意记录 / 审计九段打成一份 JSON，`summary` 如实给出 `counts` / `totals` / `truncated` / `truncatedSections`（无库 **501**，绝不返回空文件）；双端只解析文件头与摘要、**复制服务端原文**，孩子视角不发请求。§15 顺带修正两条陈旧基线（Flutter **41 → 295**、小程序 **27 → 91**）。证据：`npm test` **43 文件 / 780 条全绿**、`flutter analyze` 0 issue、`flutter test` **296/296**、小程序 `tsc` / `build:weapp` EXIT=0、`node .tmp_test/run-w7c.mjs` **12/12**（导出 DTO / 真客户端 / `loadExport` 的运行时用例；`ExportSheet` 渲染分支仍只有编译证据）；**真库 `test-db/export-db.dbtest.ts` 19/19 通过（`test:db` 19 文件 / 265 用例全绿、`ci:db` EXIT=0）—— 首跑时顺带暴露并修掉了 W7-A 的遗留回归：9 个真库套件的 `seed()` 从未造 `GuardianConsent`，`ConsentGuard` 就按设计把它们的写用例全拦成 403（现由 `test-db/support/consent-fixture.ts` 显式授权，`export-db` 不用该夹具、自己写撤回行）**；数据删除仍未实现 |
| v1.8 | 2026-10-27 | **§7 / §15 同步 W7-D（家庭数据删除）**：权限矩阵 **38 → 40 动作**（新增 `view_family_deletion` / `manage_family_deletion`，guardian ALLOW / **child DENY**；★ 两者都在 `consent-policy` 的**豁免**集合里 —— 撤回同意后仍必须能删，04 §5，因此写 / 豁免划分变为 **24 / 16**）。`POST /family-deletion`（`{confirmed:true}`）进入 **7 天冷却期**（`scheduledFor` 落库，跨重启成立），`POST /family-deletion/cancel` 可撤销；到期由 `FamilyDeletionWorker` 在**同一事务**内就地匿名化（孩子昵称 / 成员 PIN / 规则与版本文字 / 流水文本 / 审批 payload / 通知 / 同意 IP·UA），**流水数值与余额保留**（02 §5.7 I5）；`GET /family-deletion` 回 `none / pending / cancelled / executed` + 摘要。§8.1 枚举 **14 → 17**、§8.2 表 **18 → 20**。900 脚本新增**列级** UPDATE 例外（文本列可抹、`pointsDelta` / `balanceAfter` / `points` 仍 42501）与自检；`ledger-db` 的 I5 断言改用语义列，并新增「文本列可写」对照。证据：`npm test` **47 文件 / 830 条全绿**、`npm run ci` **CI_EXIT=0**（honesty-probe 表格 40 行 == 矩阵 40 动作）、`db:verify` **ALL PASS**、`test:db` **20 文件 / 287 条全绿（`deletion-db` 22/22）**、`flutter analyze` 0 issue、`flutter test` **315/315**、小程序 `tsc` / `build:weapp` EXIT=0、`run.js` 91 PASS、`run-w7d.mjs` **17/17**。仍**未抹审计历史**（追加式）、多 worker 竞争未压测、自然人注销不在范围 |
| v1.9 | 2026-10-27 | **§7 / §15 同步 W8-A（首启引导后端）**：权限矩阵 **40 → 41 动作**，且**拆成读 / 写两个动作** —— 新增 `view_onboarding`（guardian ALLOW / child DENY，★ 归入 `consent-policy` 的**豁免**集合：未同意时引导页必须能打开，否则第①步的同意按钮无处渲染）、沿用受管的 `apply_onboarding`（第②步起采集昵称，04 §5 要求同意先于采集），写 / 豁免划分变为 **24 / 17**。三个端点：`GET /onboarding`（状态 + 模板库，按「学段 → 关注点命中数 → sortWeight → slug」**排序而非过滤**）、`PATCH /onboarding/profile`（③④步草稿；`undefined` 沿用 / `null` 清空 / `[]` 全不选；值未变不写库不写审计）、`POST /onboarding/complete`（`templateSlugs` 必填且至少 1 条 ⇒ 否则 `400 ONBOARDING_NO_TEMPLATE`；**非幂等**，重复 `409`；事务内 `WHERE slug IN (…) AND status='active'` 重校验，缺一条 `404 ONBOARDING_TEMPLATE_NOT_AVAILABLE` 且零副作用；规则按提交顺序复制、每条 `version=1` 版本行 `changeNote` 记 slug；`onboardedAt` 落库；可选 PIN 存 `scrypt$…` 自描述哈希、审计只记 `pinSet`）；无库装配三路由全 **501**，绝不返回假 `{ onboarded: false }`。`prisma/seed/templates.data.ts` 改为**复用** `src/contracts/onboarding.ts`（删除手抄的 AGE_BANDS / FOCUS_AREAS，两处定义不许再漂移）。证据：`npm test` **50 文件 / 910 条全绿**（新增 `onboarding-http` / `onboarding-policy` / `onboarding-wiring`）、`honesty:probe` **5 项全 PASS**（§7 表格 41 行 == 矩阵 41 动作）、`templates:check` PASS、`test:db` **21 文件 / 315 条全绿**（新增 `onboarding-db.dbtest.ts` 7 组：真 HTTP × 真库的草稿落库 / 规则副本 / v1 版本行 / PIN 哈希验回 / 审计 `pinSet` / 重复 409 / **模板下架 404 零副作用**；`after` 里那条「版本行 DELETE ⇒ 42501」证明「数据不清理」是被库强制的，不是我们忘了删）。仍**未做**：双端引导 UI、「切家长模式」（PIN 校验）端点、并发两次 `complete` 的压测 |
| v2.0 | 2026-10-27 | **§7 / §15 同步 W8-B（首启引导双端 UI）** —— 矩阵**不变**（仍是 41 动作：W8-A 的 `view_onboarding` / `apply_onboarding` 已覆盖读写两侧），本轮只在客户端消费。Flutter `OnboardingScreen`（七步：同意 → 昵称 → 学段 → 关注点 → 约定 → PIN → 完成）＋ `OnboardingGate`；小程序 `pages/onboarding/**` ＋ 首页 `redirectTo`。三条关键判据：① 闸门**只在服务端明确 `onboarded:false` 时拦**，403（孩子 / 只读成员）与网络错误**一律放行**（「不知道」≠「未引导」；一次超时不该把应用锁死），「我的」页留「继续 / 重试」入口；② 第①步**未勾选不发请求**，同意先于采集（`04` §5），后端 `ConsentGuard` 只是兜底；③ `complete` 完成后用**既有**端点 `POST /point-rules/:id/habits` **逐条**补习惯（扣分约定不加 —— A1；409 视为已在；单条失败不回滚、只进第⑦步「需手动」清单），否则家长走完七步会看到**空首页** —— 那正是引导要解决的问题。`complete` 409 双端都**重拉状态**而非重试。新增闸门 `npm run onboarding:check`（4 学段 / 6 关注点在后端契约、Flutter、小程序三处**逐字同序**，文件缺失 / 解析为空 fail-closed，3 例证伪全红），`npm run ci` 变 **16 步**。证据：`flutter analyze` 0 issue、`flutter test` **338/338**（新增 23 条）、小程序 `tsc` / `build:weapp` EXIT=0、`run-w8b.mjs` **14/14**、`npm run ci` **CI_EXIT=0**（`npm test` 50 文件 / 910 条）。仍**未做**：切家长模式 PIN 校验端点、真机 / 真库 UI 级 E2E、小程序非首页入口闸门 |

| v2.1 | 2026-10-27 | **§7 / §15 同步 W8-C（切家长模式 ＋ 家长 PIN 后端）** —— 矩阵 **41 → 42 动作**：新增 `manage_parent_pin`（guardian ALLOW / **child DENY**，迁移 `20261027160000_parent_pin_action`），沿用自 W0 就存在的 `switch_role_mode`（两侧 ALLOW，PIN 才是门）；`consent-policy` 里**两个动作都归豁免侧**（撤回同意后仍须能进家长模式重新同意，否则死锁），划分变为 **24 写 / 18 豁免**。四条路由：`GET /auth/parent-mode`（回 `activeRole` / `parentModeExpiresAt` / `remainingSeconds` / `pinConfigured` / `remainingAttempts` / `lockedUntil`）、`POST /auth/parent-mode`（PIN 换 5 分钟；成员位必须是家长且有 PIN，否则 403 `PARENT_MODE_REQUIRES_GUARDIAN` / 409 `PARENT_PIN_NOT_SET`）、`DELETE /auth/parent-mode`（不验 PIN、幂等、锁定期间也可用）、`POST /auth/parent-pin`（首次 / 修改，改需 `currentPin`）。失败计数落在**成员位** ⇒ 跨设备成立；格式错不计次（400 而非 403）；锁定期内不跑 scrypt；触发锁定的一次直接 429 ＋ `retryAfterSeconds`。证据：`npm test` **52 文件 / 970 条全绿**、`honesty:probe` **5 项 ALL PASS**（表格 42 行 == 矩阵 42）。仍**未做**：忘记 PIN 的重置通道、「每次 guardian 操作刷新 TTL」只做了进入时刷新、双端 UI、真机 / 真库 E2E |
| v2.2 | 2026-10-29 | **§15 同步 W8-C 客户端（双端家长模式面板）＋ 契约补 `modeSource`** —— 矩阵**不变**（仍 42 动作），变的是 `GET/POST/DELETE /auth/parent-mode` 的回包多一个字段：`modeSource: 'pin' | 'session' | null`。原因是两种 `parentMode:true` 的来路完全不同：`pin` 是 PIN 换的 5 分钟，`session` 是邀请码加入的家长设备（登录会话 30 天自带 `guardian`）。只给 `remainingSeconds` 而不说来源时，两端 DTO 的「≤300 秒」硬校验会把 **2 592 000 秒**判成坏数据（家长本机第一屏就是「数据格式不符合预期」），放过之后面板还会把 30 天渲染成 `43200:00`。现在客户端按来源分别校验（`pin ⇒ 1..300` / `session ⇒ 301..一年`），`session` 的文案是「已以家长身份登录 / 登录期间一直是家长权限」并提示共用手机用完退出；服务端由 `parent-mode.policy.ts#parentModeSourceOf()` 按「到期时刻 − now > TTL」派生，**不落库**。证据：`flutter analyze` 0 issue、`flutter test` **372/372**（`parent_mode_test.dart` 34 条）、小程序 `tsc --noEmit` EXIT=0 ＋ `run-w8c.mjs` **38/38 ALL PASS**、后端 `npm test` **52 文件 / 974 条** ＋ `npm run test:db` **22 文件 / 345 条**全绿。仍**未做**：忘记 PIN 的找回通道、「每次 guardian 操作刷新 TTL」只做了进入时、真机 E2E |

> **本文档的立场**：需求文档的价值不在于把话说满，而在于**每一条都能被验证或被证伪**。
> 凡本文写"已完成"的，都能在 §16.3 的命令里复现；凡本文写"未落地"的，都不在代码里假装存在。

