# 03 · 既有缺陷清单（W0 必修范围）

> 本文档针对**现有双端代码**（Taro 小程序 `kids_points_mp/` + Flutter `lib/`）逐条列出已确认缺陷。
> 每条均标注**双端位置**、**实测证据**、**修复方向**。所有条目经代码核对，非推测。

## 0. 摘要与真实状态（2026-10-12 逐条实测对账）

> **本表状态列已按代码实测重写。** 原文的状态列长期失实 —— 18 条里有 **8 条其实早已修好**，
> 却仍标着"待修"；后续每一轮计划都会据此建立错误前提。
> 这与 **D12** 属同一类失败：*文档说"没修"，代码说"修了"，没有人对账。*
>
> **对账方法**：逐条读代码 / `grep` 取证据锚点，**每条状态都附 `文件:行号`**，不凭记忆、不靠推测。
> **可执行**：本表的 18 条状态由 `tools/defect-status.mjs` 逐条对代码复核（`npm run ci` 的一环
> `npm run defects:check`），**声明与代码不符即红** —— 含「未修」其实已修（正是本表曾经失实的病）
> 与「已修」被回退。证据**只取代码、注释不算**：否则注释里那句「原先 `xxx` 如何错」会让两侧同时被骗。
> 该守卫已用 **7 份被篡改的台账副本**证明能变红（见 `docs/design/README.md`「CI 步骤」）。
> **行号口径**：本表「证据锚点」列的 27 条 `文件:行号` 已于 2026-10-12 逐条复核（**全部命中，且指向代码而非注释**）；
> 但下方 A–E 各节正文里的 `文件:行号` 是**当时快照、随后已漂移** —— 例：§E18 正文写 `store.ts:67-70` 的
> `resetToSeed()`，**C1 落地后已在 119 行**。**引用代码请 `grep` 符号名，不要依赖行号。**
> **教训**：核实"某字段 / 某能力是否存在"**必须读模型或文件，不许只靠字段名搜索**
> —— 该错误已记录在 `06` §3.2（曾据此误判 D3"未落地"）。
>
> ⚠️ 下方 A/B/C/D/E 各节里的"**修复**："段落是**当时的设计意图**，
> 其"已落地 / 未落地"一律**以本表为准**。

| 编号 | 缺陷 | 严重度 | **真实状态（2026-10-12）** | 证据锚点 |
|---|---|---|---|---|
| A1 | 负分规则被 `Math.abs()` 抹平 | 🔴 高 | ✅ **已修** | `store.ts:369` / `app_store.dart:345`：`rule.points < 0` → 拒绝并返回文案 |
| A2 | `Habit` 无每日上限字段，频次是自由文本 | 🔴 高 | ✅ **已修** | 结构字段 `types.ts:46 dailyLimit: number` / `habit.dart:60`；展示串降级为派生 `types.ts:207 limitTextOf()` / `habit.dart:14`；seed 不再写 `limitText`（`seed.ts:36`、`seed_data.dart:47`）；`addRule` 越界即拒 `store.ts:419` / `app_store.dart:380` |
| A3 | `checked: boolean` 与「每天最多 N 次」矛盾 | 🔴 高 | ✅ **已修** | 派生化：`types.ts:239 checkedCountToday()` / `habit.dart:76`，Dart 侧为 getter `habit.dart:125`；打卡上限判定改走当天流水 `store.ts:187` / `app_store.dart:149`；两端 `*.checked =` 写入数 = 0（守门人钉住）→ 公式勘误见 §0.2 ② |
| A4 | 流水硬编码"家长记录"，无操作人 | 🔴 高 | ✅ **已修** | `store.ts:131/138`：`recordSubtitle({time, source})` + `operatorRole: actor.role` |
| A5 | `addQuickNote` 错误递增 `rewardCount` | 🟠 中 | ✅ **已修** | `store.ts:289` / `app_store.dart:258`：仅 `redeem` 递增；断言 `rewardCount === 4` |
| B6 | 扣分静默截断，**账本不平** | 🔴 高 | ✅ **已修** | `store.ts:244` / `app_store.dart:213`：返回"积分不足…最多可扣 N 分"，不再 `clamp` |
| B7 | `undoCheckIn` 物理删除流水 | 🔴 高 | ✅ **已修** | `store.ts:213`：`reversesRecordId: target.id`（写冲正记录，原记录保留） |
| B8 | 兑换标题被 `shortTitle` 永久截断 | 🟠 中 | ✅ **已修** | `store.ts:294` / `app_store.dart:265`：完整标题快照 |
| C9 | 全部删除为物理删除，无软删除/回收站 | 🟠 中 | ❌ **未修** | 前端无 `deletedAt` / `softDelete`（后端 `Habit`/`Wish`/`PointRule` 已备字段） |
| C10 | 规则无法编辑（无 `updateRule`） | 🔴 高 | ❌ **未修** | 前端无 `updateRule`（后端 `PointRule.currentVersion` 已备） |
| C11 | 无 `AuditLog`，变更不可追溯 | 🟠 中 | ❌ **未修** | 前端无任何 audit 引用（后端 `AuditLog` 表已建） |
| D12 | 测试器花括号嵌套错位 → **CI 假通过** | 🔴 高 | ✅ **已修** | `honesty:probe` 4/4；夹具 `__fixtures__/d12-misnested-runner.js` 证明**能失败** |
| D13 | 测试断言把缺陷固化为"正确行为" | 🔴 高 | ✅ **已修（10/10）** | 1–9 条已改写；**第 10 条已随 C1 改写**：`run.js:409` / `test/app_test.dart:290` 断言「首启为空态」，演示数据降级为**显式夹具**（`run.js:58`、`test/app_test.dart:19`）→ 见 §E18 现状 |
| E15 | `detail` 自由字符串，靠 `split(' · ')` 反解析 | 🟠 中 | ✅ **已修** | `PointRule` 只留 `condition` + `dailyLimit`（`types.ts:121`）；展示串派生 `types.ts:293 ruleDetail()` / `point_rule.dart:45`；规则→习惯直取结构字段 `store.ts:461` / `app_store.dart:424`；两端 `rule.detail.split` 归零 → 语义变更见 §0.2 ① |
| E16 | `backgroundIndex` 用数组下标，删项后配色漂移 | 🟡 低 | ✅ **已修** | 配色升为稳定枚举 `WishCoverStyle`（与后端 `enum WishCoverStyle` 一一对应）：枚举 `types.ts:59` / `wish.dart:7`；取色编译期穷尽 `WishCard/index.tsx:13` / `wish_card.dart:11`；补空档＋满档 `id` 哈希 `store.ts:394` / `app_store.dart:356`；两端 `wishes.length % 4` 归零 |
| E17 | `doneText` / `limitText` 是被外部写入的展示文案 | 🟠 中 | ✅ **已修** | 派生 `types.ts:212 doneTextOf()` / `habit.dart:18`；唯一产出点 `types.ts:277 habitView()` / `habit.dart:134`；页面只消费 `store.habitViews`（`home/index.tsx:25`、`home_screen.dart:25`）；seed 不再写 `doneText` |
| E18 | `resetToSeed` 生产可达 + 首启即假数据 | 🔴 高 | ✅ **已修** | 闸门＝**可测判据 + 编译期常量**：`store.ts:27 demoResetAllowed()` / `store.ts:38 ALLOW_DEMO_RESET`、`app_store.dart:22` / `app_store.dart:29`；首启空态：`store.ts:71 constructor(){ this.resetToEmpty() }`、`app_store.dart:41`；seed 只剩 `resetToSeed()` 一个显式入口（`store.ts:119`、`app_store.dart:96`） |
| E19 | 小标题串接方式不统一 | 🟡 低 | ✅ **已修** | `types.ts:155` / `point_record.dart:52`：`recordSubtitle()` 派生 |

**合计：✅ 已修 15 · ❌ 未修 3（C9 / C10 / C11）**

> 已无「半修」与「已改 9/10」两档：**C1 把 E18 与 D13 一起收口**（台账那两行改口的**那一刻就被守门人拦下过** ——
> 见 §0.1 第 2 条；这正是阶段 A5 建这个守卫的目的）。

> **2026-10-12 阶段 C2**：把 E15 / E17 / A2 / A3 收口 —— 台账这 4 行改口的**同一刻**同样被守门人拦下过
> （`backend` 的 `npm run ci` → `npm run defects:check` 报 `FAILED 4 项`：`台账=❌ 未修，代码只符合「✅ 已修」`）。
> 它不只抓「**修了不改口**」，也抓「声明修了其实没修」——两种都必须红，否则守卫自己就是下一处假绿。
> 两条诚实说明（真实语义变更 ＋ 公式勘误）见 §0.2。
>
> 🚧 **阶段 C3 进行中（E16 代码与测试已落地，本表这一行尚未改口）** —— 接手步骤、闸门实测与陷阱清单见
> [`07-c3-handoff.md`](./07-c3-handoff.md)。此刻运行 `node tools/defect-status.mjs` **预期报 `FAILED 1 项`**
> （`E16 台账=❌ 未修，代码只符合「✅ 已修」`）：这是**闸门在正常工作**（抓「改了代码没改台账」），不是修复被回退。
> **2026-10-12 阶段 C3**：E16 改口的同一刻又被同一条闸门拦下 —— backend 的 `defects:check` 报 `FAILED 1 项`（台账「未修」vs 代码「已修」）。

### 0.1 本次对账暴露的 6 处问题（本条目的由来）

| # | 问题 | 处置 |
|---|---|---|
| 1 | **本表状态列长期失实**：8 条早已修好却标"待修" | ✅ 已重写（本表） |
| 2 | **E18 是真实生产缺陷**；且第 10 条测试断言**把它固化成了"正确行为"** | ✅ 已修（阶段 C1：E18 第二半 + 该断言同批改） |
| 3 | `01` §3 承诺"接 API 不改 UI"**过宽**（图标字段不成立，见 D9） | → 阶段 A4 收敛 |
| 4 | 本文档验收门写的 `node .tmp_test/run.js` **缺工作目录前提** | ✅ 已修（见文末"验收门"） |
| 5 | `kids_points_mp/.gitignore` 的 `.tmp_test/` 整目录忽略会**吞掉 4 个手写脚本** | ✅ 已修（建仓时拆弹，见设计文档索引「Git 记录规范」） |
| 6 | **本表状态列没有守门人** —— 失实了也没有任何东西会喊出来（与 D12 同源） | ✅ 已加 `node tools/defect-status.mjs`（阶段 A5，接入 `npm run ci`） |

**修复顺序（按真实状态重排）**：

```
D12 ✅ → A1 ✅ → A5 ✅ → A4 ✅ → B6 ✅ → B7 ✅ → B8 ✅ → E19 ✅ → D13 (10/10) ✅
   ↓ 剩余（阶段 C，每步先落"能失败"的用例）
C1 ✅ E18 第二半（构造函数不再无条件 reset ＋ 第 10 条断言改写）—— 已落地
C2 ✅ E15 ＋ E17 ＋ A2 ＋ A3    （双端同步：结构字段化，展示串降级为派生）—— 已落地
C3 ✅ E16                        （已落地：WishCoverStyle 稳定枚举替换数组下标）
C4  C9 / C10 / C11             （软删除 ＋ 规则编辑 ＋ AuditLog）
C5  D9                         （新增 iconName → IconData 映射）
```

---

### 0.2 阶段 C2 的两条诚实说明（一处真实语义变更 ＋ 一处公式勘误）

**①「每周 1 次」表达不了 —— 演示数据里 `rule-3` 的语义被真实地改了，不是随手改的文案。**

`rule-3`（围棋课后作业）原展示串是 `'完成并检查 · 每周 1 次'`。但权威模型里**没有周期字段**：
`backend/prisma/schema.prisma` 的 `PointRule` / `RuleTemplate` 只有 `condition: String` ＋ `dailyLimit: Int`
（后端模板库同样把周意涵写在标题 / 条件里，例如「周末大扫除」也是 `dailyLimit = 1`）。
结构字段化之后，「每周 1 次」只能落成 `dailyLimit: 1`，派生串随之变成「完成并检查 · 每天 1 次」——
**「每周」不再被表达**。这不是漏改，是当前模型表达不了；要真正支持周频次，得先加周期字段（后端 schema 变更），
**本阶段不做**。留此记录，避免下一个人把「演示数据文案变了」误当成随手改的。

**② `03` §A3 的公式漏了一类记录 —— 只排除 `correction` 不够。**

§A3 原写 `checkedCountToday = records.filter(同 habitId && 同一天 && source≠correction).length`。
按此实现，**撤销打卡之后界面仍显示「已打卡」**：B7 的修法是「写一条冲正记录、原记录保留」（账本不可变），
原记录仍满足「同 habitId ＋ 同一天 ＋ source≠correction」，于是被继续计入 —— 撤销看起来像没生效。
实测修法是在公式里再排除**已被冲正的原记录**：

```ts
const reversedIds = new Set(records.filter((r) => r.reversesRecordId !== null).map((r) => r.reversesRecordId))
checkedCountToday = records.filter((r) => r.habitId === habitId && r.category === 'praise'
  && r.source !== 'correction' && !reversedIds.has(r.id) && isSameDay(r.time)).length
```

两端实现同源（`types.ts:254`、`habit.dart:92`），并各有回归用例（`run.js:498`、`app_test.dart:378`，
断言理由写明「被冲正的原记录不得再计入 —— 否则撤销后仍显示已打卡」）。

---
## A 类 · 模型与数据语义错误

### A1 负分规则被 `Math.abs()` 抹平 —— 扣分规则变成加分

| 端 | 位置 |
|---|---|
| Taro | `kids_points_mp/src/data/store.ts:229` → `points: Math.abs(rule.points)` |
| Flutter | `lib/data/app_store.dart:224` → `points: rule.points.abs()` |

模型明确允许负值 —— `types.ts:60` 注释：`/** 分值，可为负数（扣分规则） */`，
`point_rule.dart:20` 同。但 `addHabitFromRule` 在**规则 → 习惯**转换时取绝对值：

```
PointRule { title:'打人', points: -3 }   ← 家长定的扣分规则
        ↓ addHabitFromRule  Math.abs(-3) = 3
Habit     { title:'打人', points:  +3 }   ← 变成"打人 +3 分"！
```

**后果**：家长设定"打人 −3 分"，孩子打人后点一下，**加 3 分**。这是产品性质级错误。

**修复（✅ 已落地 2026-10-12）**：`addHabitFromRule` 对 `points < 0` **拒绝**并返回文案
（`“打人”是扣分规则，不能加入今天的习惯`）—— 扣分规则不生成可打卡习惯。
于是 `Habit.points` **由构造方式恒为正**，**不需要 `Habit.direction` 字段**：
负分规则根本进不了 `Habit`。

> **勘误（2026-10-12）**：本节原写「`Habit.points` 恒为正，由 `Habit.direction` 表达奖惩」，
> 与已落地实现不符 —— `Habit` **没有** `direction` 字段（后端 schema 与双端模型都没有）。
> 真实方案是**拒绝**，它比「再加一个 `direction` 字段」更简单，也更不容易被写错。

---

### A2 `Habit` 无每日上限字段，频次只是给人看的字符串

| 端 | 位置 |
|---|---|
| Taro | `kids_points_mp/src/data/types.ts:16` → `limitText: string` |
| Flutter | `lib/models/habit.dart:29` → `final String limitText;` |

`limitText = '每天最多 2 次'` 是**自由文本**，系统无法据此判断"今天还能打卡几次"。
需要的是 `dailyLimit: number`（可参与运算、可校验），`limitText` 应降级为**由 `dailyLimit` 派生的展示串**（见 E17）。

**修复**：新增 `Habit.dailyLimit: Int`；`limitText` 改为 getter（`dailyLimit === 1 ? '每天 1 次' : \`每天最多 ${dailyLimit} 次\``）。

**现状（2026-10-12 阶段 C2 已落地）**：

- **结构字段**：`types.ts:46 dailyLimit: number`、`habit.dart:60 final int dailyLimit;`，与权威 schema 的 `Habit.dailyLimit: Int` 同构；`PointRule` 侧同名字段（`types.ts:127`）。
- **展示串降级为派生**：全仓库只有 `limitTextOf()` 一处写「每天 1 次 / 每天最多 N 次」（`types.ts:207`、`habit.dart:14`），两端同源。
- **seed 不再提供展示串**：演示数据只写结构字段（`seed.ts:36`、`seed_data.dart:47`）；守门人以 `lack(seed, /limitText:/)` 钉死 —— 谁再往 seed 塞展示文案就变红。
- **边界可校验**：`isDailyLimitValid()` 限 1–5 整数（`types.ts:198`、`habit.dart:10`），`addRule` 越界**拒绝并说明原因**（`store.ts:419`、`app_store.dart:380`）—— 不夹到边界：静默改写会让家长以为约定已按他的意思生效。
- **回归用例**：`run.js:466`、`app_test.dart:349` / `app_test.dart:417`。

---

### A3 `checked: boolean` 与"每天最多 N 次"根本矛盾

| 端 | 位置 |
|---|---|
| Taro | `store.ts:93-95`（只判断 `habit.checked`）；`types.ts:22` `checked: boolean` |
| Flutter | `app_store.dart:74-77`；`habit.dart:38` `bool checked;` |

单个布尔量**无法表达"每天最多 2 次"**。实测矛盾：

```
seed.ts:32-36   habit-pomodoro: limitText='每天最多 2 次', doneText='今日已完成 1 次', checked=true
                                  ↑ 承诺每天 2 次            ↑ 已完成 1 次
       ↓  checkIn 只判断 checked
       → 打卡 1 次后 checked=true → 第 2 次被永久拦截
       → 规则承诺的"2 次"永远无法达成
```

且"已完成 1 次"这个数字**不是算出来的**，是 seed 里写死的字符串（`doneText`）。

**修复**：`checked` 改为**派生值** —— 由"当天同源流水数"与 `dailyLimit` 计算：
```
checkedCountToday = records.filter(同 habitId && 同一天 && source≠correction).length
checked           = checkedCountToday >= dailyLimit
doneText          = `今日已完成 ${checkedCountToday} 次`
```

**现状（2026-10-12 阶段 C2 已落地）**：

- `checked` 在两端都**不再是字段**：Taro 侧只存在于派生接口 `HabitView`（`types.ts:265` 起），Dart 侧是 getter `bool get checked =>`（`habit.dart:125`）。
- `checkedCountToday()`（`types.ts:239`、`habit.dart:76`）由**当天流水**统计；打卡上限判定改走它（`store.ts:187`、`app_store.dart:149`）—— 「每天最多 2 次」因此真的能打 2 次。
- ⚠️ **本条上面的公式有漏洞**：只排除 `source≠correction` 不够，还必须排除**已被冲正的原记录**，否则撤销后界面仍显示已打卡 —— 详见 §0.2 ②；两端实现已含 `reversedIds` 排除（`types.ts:254`、`habit.dart:92`）。
- **页面不再读状态字段**：首页消费 `store.habitViews`（`home/index.tsx:25`、`home_screen.dart:25`），视图是快照对象、不回写 store。
- **反回退**：守门人断言两端 `*.checked =` 写入数为 **0**、Dart 侧无 `bool checked;` 字段。
- **回归用例**：`run.js:466` / `run.js:498`、`app_test.dart:349` / `app_test.dart:378`。

---

## A 类（续）

### A4 流水硬编码"家长记录"，且无操作人字段 —— 流水在撒谎

| 端 | 位置 |
|---|---|
| Taro | `store.ts:102` `` subtitle: `${clockText(Date.now())} · 家长记录` ``；`store.ts:169` `subtitle: '已兑换 · 家长确认'` |
| Flutter | `app_store.dart:85`；`app_store.dart:156` |
| 模型 | `types.ts:40-52` `PointRecord` **没有** `operatorUserId` / `operatorRole` / `source`；`point_record.dart:32-44` 同 |

无论谁操作，流水都写成"家长记录"。**孩子自己打卡**也记成"家长记录"。

这是双角色架构（见 `02`）的前置阻塞：审批流、Agent 代操作、孩子自助加分，**都必须能区分操作人**，
否则"谁给的分"无法追责，也无法做统计（如"孩子自主完成率"）。

**修复**：`PointRecord` 增加 `source`（`child_self|guardian|agent|approval|system|correction`）
+ `operatorUserId` + `operatorRole`；`subtitle` 由这些字段**派生**而非拼接（见 E19）。

---

### A5 `addQuickNote` 加分会错误增加 `rewardCount`

| 端 | 位置 |
|---|---|
| Taro | `store.ts:139` → `if (gain) this.profile.rewardCount += 1` |
| Flutter | `app_store.dart:122` → `if (isGain) profile.rewardCount += 1` |

`rewardCount` 的语义是**"累计奖励（兑换）次数"**（`types.ts:72`）。
但 `addQuickNote(+5, '主动帮忙做家务')` —— 一次**手动加分**，与"兑换奖励"毫无关系 —— 却 `rewardCount += 1`。

**后果**：战绩"4 次奖励"虚高。孩子做了 10 次家务，战绩显示"14 次奖励"。

**修复**：`rewardCount` **只由 `redeem()` 递增**（这是唯一语义正确的位置，`store.ts:165` 已正确）。
`addQuickNote` 删除该行。

---

## B 类 · 账本完整性

### B6 扣分静默截断 —— **账本不平**（最严重）

| 端 | 位置 |
|---|---|
| Taro | `store.ts:137-138` → `this.points += delta; if (this.points < 0) this.points = 0` |
| Flutter | `app_store.dart:120-121` → `_points += delta; if (_points < 0) _points = 0;` |

```
初始余额 124，delta = -9999
  balance : 124 + (-9999) = -9875  →  截断为 0      （实际变动 = 0 - 124 = -124）
  record  : points: -9999                          （记录声称变动 -9999）
  Σ流水 = ... - 9999     vs     余额 = 0            →  相差 9875
```

余额被静默改写，而流水照原样记 `-9999`。**`Σ(points) ≠ 余额`，账本无法对账。**

**修复**（推荐 ①）：
1. **拒绝**：扣分不得超过当前余额，返回可读错误文案（`'积分不足，最多可扣 124 分'`）—— 与 `redeem` 语义一致
2. **生成冲正**：全额扣到 0，并额外写一条 `source='system'` 的冲正流水，使账平
3. 允许负余额（需产品确认，会引出"负债"概念，不适合儿童场景）

W0 采用方案 ①，并在 W2 引入 `balanceAfter` 后由不变量 I2 永久守护（见 `02` §记录不可变性）。

---

### B7 `undoCheckIn` 物理删除流水，且同名习惯互相误删

| 端 | 位置 |
|---|---|
| Taro | `store.ts:120-127` → `this.records = this.records.filter(...)` |
| Flutter | `app_store.dart:104-109` → `records.removeWhere(...)` |

过滤条件（`store.ts:121-126`）：
```ts
!(record.category === 'praise' && record.title === habit.title && this.isToday(record.time))
```

两个问题：
1. **历史被抹掉而非冲正**。撤销打卡后，那一笔"曾经发生过的事"永久消失 —— 账本不可变原则被破坏。
2. **按 `title` 匹配 → 同名习惯互相误删**。若存在两条同名习惯（或一条习惯改名后与新习惯同名），
   撤销其一会误删另一方的流水。

**修复**：撤销改为**写入冲正记录** —— 新增一条 `source='correction'`、`pointsDelta = -原值`、
`reversesRecordId = 原记录id` 的流水；原记录**保留不动**。匹配改用 `habitId`（唯一）而非 `title`。
由此，撤销后**记录数 +1 而非 −1**（这也修正了 D13 中固化的断言）。

---

### B8 兑换标题被 `shortTitle` 永久截断

| 端 | 位置 |
|---|---|
| Taro | `store.ts:168` + `shortTitle()` `store.ts:266-270`（`maxLength = 10`） |
| Flutter | `app_store.dart:155` + `_shortTitle()` `app_store.dart:260-264` |

```ts
title: `兑换：${this.shortTitle(wish.title)}`      // 超 10 字符 → slice(0,10) + '…'
```

```
心愿标题： '周末去游乐园玩一整天（亲子票）'
流水标题： '兑换：周末去游乐园玩一…'          ← 完整标题永久丢失
```

`PointRecord` **没有 `wishId`** 回指（同 A4），所以心愿被删除后，这笔扣 445 分的流水
**再也无法解释是为什么扣的** —— 对账到此断裂。

**修复**：标题**完整快照不截断**；截断只发生在**渲染层**（CSS `text-overflow: ellipsis` / Flutter `TextOverflow.ellipsis`）。
同时增加 `wishId` 回指。

---

## C 类 · 软删除与审计

### C9 全部删除为物理删除，无回收站

| 端 | 位置 |
|---|---|
| Taro | `removeRule` `store.ts:217-220`；`removeWish` `store.ts:192-195` |
| Flutter | `app_store.dart:211-214`；`app_store.dart:183-186` |

误删不可恢复；且删除后历史流水失去回指（本身也无 `ruleId`）。
`Habit` 甚至没有删除方法（只能通过 `resetToSeed` 清空）。

**修复**：统一 `status`（`active|deleted`）+ `deletedAt` 软删除；列表查询经全局过滤器排除 `deleted`；
回收站保留 **90 天**（Q12 结论）。**流水永不删除**（见 `02`）。

---

### C10 规则无法编辑

`store.ts` / `app_store.dart` 只有 `addRule` / `removeRule`，**没有 `updateRule`**。

家长想改分值（"1 分太少了，改成 3 分"）只能**删除重建** → `id` 变化 → 历史断裂
（且因无 `ruleId`，连断裂都看不出来）。

这也是"修改规则后历史记录是否变化"这一语义**至今无法定义**的原因 —— 功能不存在，语义就无从谈起。
`02` 文档给出了完整语义（**历史不可回溯、未来从新规、今日剩余额度按新规重算**）。

**修复**：新增 `updateRule` + `PointRuleVersion` 版本表（见 `02` §规则版本化）。

---

### C11 无 `AuditLog`

全部代码库中**没有任何变更审计机制**。谁在什么时候把"每天最多 2 次"改成"每天最多 1 次"
完全无法追溯。

**修复**：`AuditLog` 追加式表（`before`/`after` JSON 快照），白名单模型（规则/心愿/习惯/成员/同意），
与业务写入**同一事务**；DB 层对该表 `REVOKE UPDATE, DELETE`。

---

## D 类 · 测试基础设施失效

### D12 测试器花括号嵌套错位 → **CI 假通过** ✅ 已修

**位置**：`kids_points_mp/.tmp_test/run.js`（原 279 行）

**根因**（不是"最后两个测试没跑"，而是更严重）：
`check('seed: …')`（第 77 行）与 `check('addQuickNote：…')`（第 130 行）的**回调都没有在自己的位置闭合**，
导致 `console.log(...)` 与 `process.exitCode = …`（原第 255–256 行）被**嵌进了 `addQuickNote` 的回调内部**。

**实测证据（修复前）**：
```
PASS  dayLabel … PASS  subscribe        ← 11 项
ALL PASS                                ← 结算在第 255 行发生（此时 addQuickNote/seed 尚未执行完）
PASS  addQuickNote                      ← 结算之后才打印
PASS  seed                              ← 结算之后才打印
EXIT_CODE=0
```

**后果**：
1. 汇总行 `ALL PASS` 在 **2 个检查执行完之前**就打印 —— 日志自相矛盾
2. `process.exitCode` 在结算那一刻被**锁死为 0**；此后 `redeem`/`addWish`/`addRule`/
   `addHabitFromRule`/`renameChild`/`subscribe` **6 个检查**以及尾部两个断言块
   **即使全部 FAIL，进程仍退出 0** → **CI 永远绿**
3. `seed` 检查的 12 条断言被挤到文件末尾，跨越了整个文件的执行期

**修复**（3 处外科手术式改动，**保留全部原有断言**，只修正结构）：
- 将 `seed` 检查尾部 12 条断言归位至其自身回调内，并补 `})`
- 将 `addQuickNote` 检查尾部断言归位，并补 `})`
- 删除文件末尾残留的孤儿断言块；汇总行自然落回文件末尾

**验证**：

| 验证项 | 结果 |
|---|---|
| `node --check` | `SYNTAX OK` |
| 花括号配平 | `brace_depth_at_eof = 0` |
| 检查执行顺序 | 回到源码顺序（`seed` 第 4 位，非最后） |
| 汇总行位置 | 全部 13 项之后 |
| **诚实性探针**：在最后一个检查前注入必然失败项 | 打印 `FAIL` → `1 FAILED` → **`EXIT_CODE=1`** ✅ |

> 诚实性探针是验证测试器本身可信的关键手段：**一个不会失败的测试器等于没有测试器**。
> 建议将探针固化为 CI 步骤（每次先注入必失败项、确认退出码为 1，再跑真实套件）。

---

### D13 测试断言把缺陷固化为"正确行为"

修复 B/A 类缺陷时，这些断言**必须先改**，否则会"正确地失败"。

| # | 断言位置 | 固化的缺陷 | 修复后应断言 |
|---|---|---|---|
| 1 | `run.js` 原第 220 行 `'习惯积分取绝对值'` | A1 | `addHabitFromRule(负分规则)` 被**拒绝**，习惯数不变 |
| 2 | `run.js` `records[0].title.endsWith('…')` `'超长心愿标题应截断'` | B8 | 标题**完整保留**（`=== '兑换：周末去游乐园玩一整天（亲子票）'`） |
| 3 | `run.js` `subtitle.endsWith('· 家长记录')` | A4 | `subtitle` 含**真实操作人**；孩子自助打卡不含"家长" |
| 4 | `run.js` `'撤销打卡应删掉今天的记录'`（`length === 4`） | B7 | 记录数 **+1**（冲正），原记录保留 |
| 5 | `run.js` `addQuickNote(-9999)` → `points === 0` | B6 | **被拒绝**，余额不变（124），`points` 与余额一致 |
| 6 | `run.js` `rewardCount === 5`（`addQuickNote(5)` 后） | A5 | `rewardCount === 4`（仅 `redeem` 递增） |
| 7 | `test/app_test.dart:75` `expect(rewardCount, 5)` | A5 | `expect(rewardCount, 4)` |
| 8 | `test/app_test.dart:80-87` `'扣分不会把余额扣成负数'` | B6 | 扣分被拒绝；`amountText` 与余额变动一致 |
| 9 | `test/app_test.dart:55-65` `'撤销打卡会扣回积分并移除今天的表扬记录'` | B7 | 改为断言**冲正记录**存在 |
| 10 | `run.js` / `app_test.dart` 首启 124 分 / 324 好习惯 | E18 | ✅ 已改写：生产路径首启为 **0 分 0 记录**；seed 降级为**显式**测试夹具（`seededStore()`）—— 见 §E18「现状」 |

---

## E 类 · 结构硬编码与文案

### E15 `PointRule.detail` 是自由字符串，靠 `split(' · ')` 反解析

| 端 | 位置 |
|---|---|
| Taro | `types.ts:59` `detail: string`；**解析处** `store.ts:225-231` `rule.detail.split(' · ')` |
| Flutter | `point_rule.dart:18`；**解析处** `app_store.dart:219-226` `rule.detail.split(' · ')` |

```ts
const parts = rule.detail.split(' · ')
condition : parts.length > 0 ? parts[0] : rule.detail          // 第一个片段 = 条件
limitText : parts.length > 1 ? parts[1] : '每天 1 次'           // 第二个片段 = 频次
```

结构信息藏在**面向人的展示字符串**里。任何不符合 `'A · B'` 约定的输入都会解析错，
例如 `'连续 3 天 · 每天 1 次 · 需要家长确认'` → `limitText` 会得到 `'每天 1 次'` 而丢掉第三段；
`'专注25分钟'`（无分隔符）→ `limitText` 落到默认值 `'每天 1 次'`，**与家长意图无关**。

**修复**：`condition` / `dailyLimit` 升为**结构字段**；`detail` 降级为**只读展示串**（由结构字段派生）。

**现状（2026-10-12 阶段 C2 已落地）**：

- `PointRule` 只留 `condition` ＋ `dailyLimit`（`types.ts:121`、`lib/models/point_rule.dart`），`detail` **字段已删除**；展示串改为 `ruleDetail(rule)`（`types.ts:293`、`point_rule.dart:45`）。
- 规则 → 习惯**直取结构字段**（`store.ts:461`、`app_store.dart:424`）：原先的 `rule.detail.split(' · ')` 已归零，「多一段就丢一段」「没分隔符就静默落到默认值」这两种解析病随之消失。
- 新增规则表单收的是**结构字段**：条件输入框 ＋ 频次 stepper（1–5 越界即拒），不再让家长手打「每天 1 次」这种展示串（`AddRuleSheet.tsx:40` / `:42`、`add_rule_sheet.dart:76` / `:78`）。
- ⚠️ **语义变更（诚实说明）**：演示规则 `rule-3` 原为「完成并检查 · 每周 1 次」，结构字段化后落成 `dailyLimit: 1` → 派生串变成「每天 1 次」，**「每周」不再被表达**；原因与处置见 §0.2 ①。
- **回归用例**：`run.js:521`、`app_test.dart:398`。

---

### E16 `Wish.backgroundIndex` 用数组下标表达配色，删除后漂移

| 端 | 位置 |
|---|---|
| Taro | `types.ts:34` `backgroundIndex: number`；`store.ts:186` `backgroundIndex: this.wishes.length % 4` |
| Flutter | `wish.dart` `backgroundIndex`；`app_store.dart:177` `backgroundIndex: wishes.length % 4` |

配色由**插入时的列表长度**决定。删除中间某个心愿后，后续新增心愿的配色会与既有心愿**撞色**或跳变。

**现状（2026-10-12 阶段 C3 已落地）**：

- `Wish` 不再有 `backgroundIndex`，配色升为**结构枚举** `WishCoverStyle`，与后端 `enum WishCoverStyle { A B C D }`（`backend/prisma/schema.prisma`，`Wish.coverStyle @default(A)`）**一一对应**：Taro 类型 `types.ts:59` ＋ 取值表 `types.ts:62`；Flutter 枚举 `wish.dart:7` ＋ 取值表 `wish.dart:10`。
- 取值来源二选一，唯一入口 `pickCoverStyle()`（`store.ts:394`、`app_store.dart:356`）：**有空档先补空档**；四色占满时 **id → 哈希**稳定映射（同一个 id 永远同一个色）。哈希跨端同源 `(hash * 31 + charCode) % 1000003`（JS `charCodeAt` ≡ Dart `codeUnitAt`），实现于 `types.ts:68` / `wish.dart:19`。
- 两端取色**编译期穷尽**：Taro `WISH_GRADIENTS: Record<WishCoverStyle, [string, string]>`（`WishCard/index.tsx:13`，取色 `:37`）／Flutter `wishGradientOf()` 的 `switch (style)` 表达式（`wish_card.dart:11`，取色 `:37`）—— 将来给枚举加取值，漏掉分支会编译不过。
- **回归用例**：`run.js:319`（删项不漂移 ＋ 有空档先补空档）、`app_test.dart:439`（跨端同源 ＋ 卡片按枚举取色）；两端均钉死 `wishCoverHash('wish-9') === 355514`。
- **反回退**：两端 `wishes.length % 4` 归零、`backgroundIndex` 写入点归零（守门人 E16 的 `lack` / `countIs(..., 0)` 钉住）。

---

### E17 `doneText` / `limitText` 是被外部写入的展示文案

`doneText`（`types.ts:18`）是**可被任意赋值**的普通字段，seed 里手工写成 `'今日已完成 1 次'`（`seed.ts:33`）。
它不是由 `checkedCount` / `dailyLimit` 计算的，因此**必然会与真实状态脱节**（见 A3）。

**修复**：二者改为**派生 getter**：
```ts
limitText = dailyLimit === 1 ? '每天 1 次' : `每天最多 ${dailyLimit} 次`
doneText  = `今日已完成 ${checkedCountToday} 次`
```

**现状（2026-10-12 阶段 C2 已落地）**：

- 两端都**没有**可写的 `doneText` / `limitText`：它们只出现在派生视图里（Taro `HabitView`：`types.ts:265` 起；Dart `HabitView`：`habit.dart:102` 起），由 `doneTextOf()` / `limitTextOf()`（`types.ts:207` / `types.ts:212`、`habit.dart:14` / `habit.dart:18`）算出。
- 视图工厂 `habitView()`（`types.ts:277`、`habit.dart:134`）是**唯一**产出点：输入「习惯结构字段 ＋ 当天流水」，页面拿不到可写展示串 —— 想改文案只能改派生函数（一处改、两端同步）。
- seed 不再写 `doneText`（守门人 `lack(seed, /doneText:/)` 钉住）；页面只消费 `store.habitViews`（`home/index.tsx:25`、`home_screen.dart:25`）。
- **回归用例**：`run.js:521`、`app_test.dart:333` / `app_test.dart:398`。

---

### E18 `resetToSeed` 生产可达 + 首启即假数据

| 端 | 位置 |
|---|---|
| Taro | （W0 快照）`store.ts:67-70` `resetToSeed()` 为公开方法；`store.ts:56-64` `reset()` 被构造函数调用 |
| Flutter | （W0 快照）`app_store.dart:50-53`；`app_store.dart:31-47` |

两个问题：
1. **`reset()` 在构造函数中调用** → 应用**首启即为假数据**（124 分 / 324 好习惯 / 4 次奖励 / "萌新铲屎官的小可爱"）。
   新用户打开就看到"我完成了 324 个好习惯"，这是荒谬的，也是必须下架 seed 的核心理由。
2. **`resetToSeed()` 是公开方法**，"我的"页按钮可直接触发 → 生产环境用户**可一键清空真实数据**并恢复假数据。

**修复**：
- `resetToSeed` 移出生产构建（`process.env.NODE_ENV !== 'production'` 守卫 / Flutter `kDebugMode` 守卫）
- 首启改为**空态 + 引导流程**（见 `04`）；seed 保留为**测试夹具**（`buildSeedData()` 仍供测试调用）

**现状（2026-10-12 阶段 C1 已修）**：

- **闸门拆成两件东西**：可测判据 `demoResetAllowed()`（`store.ts:27`、`app_store.dart:22`）
  ＋ 由它派生的编译期常量 `ALLOW_DEMO_RESET` / `allowDemoReset`（`store.ts:38`、`app_store.dart:29`）。
  理由：判据若只活在常量里，测试就只能靠"碰巧跑在开发环境"才验证得到它 ——
  现在两套测试都能**确定性地**断言 release 必须被拒，而生产构建仍整段可 DCE。
- **生产不可达有两层证明**：① 判据断言 `demoResetAllowed('production') === false`；
  ② 以 `NODE_ENV=production` **重新加载真实模块**，断言 `ALLOW_DEMO_RESET === false`、
  `resetToSeed()` 返回 false 且真实数据没被清空（`run.js:433` 起）。
- **首启＝空态**：构造函数只调 `resetToEmpty()`（`store.ts:71/89`、`app_store.dart:41/57`），
  seed 降级为**显式夹具**、唯一入口是 `resetToSeed()`（`store.ts:119`、`app_store.dart:96`）。
- **回归用例（先验证过"能失败"）**：`run.js:409`「E18 首启必须为空态」、
  `test/app_test.dart:290`「首启为空态：不预置任何演示数据」，
  外加界面层 `test/app_test.dart:331`「首启空态不崩」；修前分别报
  `首启不得预置 124 分假数据` 与编译期缺符号 `demoResetAllowed`。
- ⚠️ **仍待补**：首启的**引导流程**（`04`）尚未开发 —— 当前空态直接渲染空列表
  （已有界面冒烟用例保证不崩），引导流程属后续阶段。

---

### E19 小标题串接方式不统一

三种不一致的写法：

| 来源 | 写法 |
|---|---|
| 打卡 | `` `${clockText(Date.now())} · 家长记录` `` |
| 兑换 | `'已兑换 · 家长确认'`（**无时间**） |
| 记一笔 | `` `${clockText(Date.now())} · ${note}` ``（备注**替换**了操作人） |

后果：无法结构化渲染；时间丢失（兑换）；操作人被备注挤掉（记一笔）；无法做 i18n / 无障碍朗读。

**修复**：`subtitle` 改为**派生值**，由 `time + source + operatorRole + note` 组合：
```
19:30 · 家长记录           ← source=guardian
19:30 · 自己完成           ← source=child_self
19:30 · 兑换奖励           ← source=guardian, category=exchange（含时间）
19:30 · 家长记录 · 因为马虎  ← note 作为**附加段**，不替换来源
```

---

## 修复顺序与依赖

> **生效版本在 §0**（已按 2026-10-12 的实测状态重排）。此处保留 W0 原计划，
> 并逐行标注它**后来被现实修正成了什么** —— 计划与结果不一致，本身就是要留档的信息。

| W0 原计划 | 现实（2026-10-12） |
|---|---|
| D12 ✅ 已修，安全网就绪 | ✅ 一致。且 `honesty:probe` 已用夹具 `d12-misnested-runner.js` 证明它**能失败** |
| D13 断言改写 ← 必须与缺陷修复同批，否则测试会「正确地失败」 | ✅ **10/10 已收口**（C1）：第 10 条（首启 124 分 / 324 好习惯）与 **E18** 同批改写为「首启空态 ＋ seed 显式夹具」 |
| A1 → A5 → A4 → B6 → B7 → B8 → **E18** → E19 → E16（双端同步，纯前端可控） | ✅ A1 / A5 / A4 / B6 / B7 / B8 / E19 已落地；✅ **E18 已收口**（C1：守卫 ＋ 首启空态，构造函数不再无条件 `reset()`）；✅ **E16 已收口**（C3：稳定枚举 ＋ 补空档/哈希；两端 `wishes.length % 4` 归零） |
| E15/E17 → A2/A3 → C9/C10/C11（依赖 W0 schema 变更，与后端一并落地） | ✅ **E15 / E17 / A2 / A3 已收口**（C2，双端同步：`condition` / `dailyLimit` 升为结构字段，`checked` / `limitText` / `doneText` / `detail` 全部降级为派生）；❌ **C9 / C10 / C11 仍未动**（下一阶段 C4）。但 **W0 schema 已就绪**（`deletedAt` / `status` / `PointRule.currentVersion` / `AuditLog` 表）→ **已不构成阻塞**，只剩前端改造 |

**验收门（W0 exit）**：
- **从仓库根**执行 `node kids_points_mp/.tmp_test/run.js` 与 `flutter test`，**均能真实失败**（诚实性探针通过）
  （`run.js` 内部按自身 `__dirname` 定位 `dist/`，与工作目录无关；但写全路径更不易误用）
- **本表可被机器复核**：`node tools/defect-status.mjs`（`npm run ci` 的一环 `npm run defects:check`）必须 `ALL PASS`；
  且**篡改任意一条状态后必须变红**（7 份副本已验证）—— 否则它自己就是下一处假绿
- 上述 18 条缺陷全部有对应的**新回归用例**（每轮修复后能复现修复前失败）
- 双端行为一致（同一用例在 Taro / Flutter 两侧结论相同）
- **反回退粒度（C2 起）**：结构字段化的四条不只是「新符号在不在」，还含**反回退断言** —— `*.checked =` 写入数必须为 0、seed 不得再出现 `limitText:` / `doneText:`、`rule.detail.split` 归零、两端必须排除 `reversedIds`、首页必须消费 `habitViews`。只断言「新符号存在」是不够的：旧写法完全可以与它并存 —— 那正是 A2 / A3 / E15 / E17 当初「看着像修了」却还活着的原因。
- **C2 闸门实测（2026-10-12）**：Taro `tsc --noEmit` 0 错、现编 `run.js` 19/19 ALL PASS、`flutter analyze` 0 issue、`flutter test` 29/29、`backend npm run ci` ALL PASS（18 条对账）。
- **C2 证伪自测（2026-10-12，6/6）**：注入反例必须**变红并点名对应条目**，还原后必须回绿 ——
  ① Taro seed 塞回 `limitText:` → **A2 红**；② Flutter seed 塞回 `doneText:` → **E17 红**；
  ③ Taro store 塞回 `rule.detail.split(' · ')` → **E15 红**；④ Flutter store 塞回 `habit.checked = true` → **A3 红**；
  ⑤ 台账副本把 E15 改回「❌ 未修」→ **E15 红**；⑥ 删掉守门人里的 E17 验证器 → **E17 红**（「台账有、验证器没有」fail-closed）。
  还原全部走**内存快照 ＋ sha256 比对**（不用 `git checkout`：工作区有未提交改动，`git checkout` 会连真改动一起丢掉）。


