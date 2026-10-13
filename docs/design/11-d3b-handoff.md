# 阶段 D-b 交接单 · `D3b` `ChildMember.restrictions` 裸 `Json` 定形

> ## ✅ 已收口（2026-10-13）
>
> 本单与 D-b 的实现**同批完成**；第一节起是**当时的前提与判断**，收口证据全部可复跑。
>
> | 闸门 | 结果 |
> |---|---|
> | `cd backend && npm run ci` | ✅ **`CI_EXIT=0`（11 步）** —— 新增第 9 步 `restrictions:check`（原 10 步 → 11 步） |
> | `cd backend && npm run restrictions:check` | ✅ **`ALL PASS` 5 行**（A1 空形状 / A2 合法全形状 / A3 每键都有约束 / B 10 类坏形状必拒 / B2 差分可定位） |
> | `node tools/restrictions-check.mjs` | ✅ **`ALL PASS` 6/6**（三处键名逐字逐序相等、列仍 `Json`＋默认、装饰器与类型一致、守卫封闭、自检已进 ci、文档已改口） |
> | **证伪** `node tools/_scratch/d3b-falsify.mjs` | ✅ **20 行全 PASS** —— 14 反例（每例"红且**只**点名自己"）＋ 3 控制例 ＋「6 个真文件 sha256 逐字节未变」＋「清理副本后回绿」＋「副本已清理」 |
> | 数据库 | **未动**：无迁移、无 `migrate`（列仍是 `Json`；`Json` 的内部形状 Prisma 表达不了 —— 这正是本步存在的理由） |
> | 前端 | **未动**：`lib/**`、`kids_points_mp/**`、`test/**` 全 0 改动 |
>
> **三条自我纠正**都发生在**自检 / 闸门 / 证伪脚本**里，不在产品代码里（与 C5 §4、D-a §4 同源）。
> **一处口径修正**：`02` §3 原来那份清单末尾有个 `...`，与"形状封闭"直接冲突 —— 本轮去掉，见 §2。

> **给**：接手 `04` 首启引导、或 `tools/**` 职责地图的下一个会话。
> **一句话状态**：`restrictions` 的**形状**已被钉住，但**还没有任何地方调用这个守卫**（全仓 `restrictions` 引用 0 处）
> —— 闸门此刻是"防将来"的，别把绿灯读成"屏障三已验收"。

## 1. 这一步在修什么

| | |
|---|---|
| 决策号 | **`D3b`**（`06` §3.1，W0 逐条裁定时**本轮新立**，不是原 D1–D10 里的一条） |
| 原文 | `ChildMember.restrictions`：裸 `Json` → **定形校验** |
| 当时状态 | `restrictions Json @default("{}")`（`schema.prisma` L284–L286）；上面那行 `/// 形状：{ ... }` 只是**注释**，Prisma 不解析、数据库不拦 |
| 落地阶段 | **D-b**：类型 ＋ 运行时守卫 ＋ 离线自检 ＋ 闸门 |

裸 `Json` 的病灶**不是"不够类型化"**，而是它放行了两类**静默失效**：

1. **写错键名 = 限制没生效，而且没人报错**：`{ childCannotUndisCheckIn: true }`、`{ childCannotUndoCheckin: true }`
   都会安安静静写进库。家长以为"禁止撤销打卡"已经生效 —— **安全设置静默不生效，比设置失败更危险**。
2. **同一个键可以存任意类型**：`{ childCannotUndoCheckIn: "yes" }`、`{ requireApprovalForBonusOver: "50" }`。
   取值到底算不算"开着"，只能由**每个读它的人**各自解释。

它与 **`D1b`**（`relation` 升枚举）**同构但更弱**：枚举能把真相**兜在数据库**里，
而 `Json` 的内部形状 **Prisma 表达不了** —— 所以本次定形**只能落在应用层**（类型 ＋ 运行时守卫），
再配一个闸门钉住那几处手抄。另外，`02` §3 的**方向性约束**（`restrictions` 只能收紧、不能放宽）
在裸 `Json` 下**根本无法被检验**：连"有哪些键"都不确定时，谈不上"这一笔是不是更严"。

## 2. 三处手抄，与一处口径修正

**键名：`childCannotUndoCheckIn` / `childCannotAddWish` / `requireApprovalForBonusOver`**（**封闭**：三个，多一个即拒）。

| # | 位置 | 谁在读它 |
|---|---|---|
| ① **权威** | `backend/src/contracts/member-restrictions.ts` 的 `RESTRICTION_KEYS` | 守卫 `validateRestrictions()`、离线自检、闸门 —— **可执行** |
| ② | `schema.prisma` 里 `restrictions` 上方那行 `/// 形状：{ … }` 注释 | 人（下一个写 API / 迁移的人）；Prisma 只是照抄进注释 |
| ③ | `docs/design/02-rbac-and-approval.md` §3 的代码块 | 人（读设计的家长/开发者） |

权威从**注释**搬到了**代码**：① 是唯一真相，②③ 是**手抄**，由 `npm run restrictions:check`
（闸门 ①）**逐字逐序**比对 —— 改键名必须**三处同改**，否则闸门红。

**口径修正（本轮，不是漏改）**：③ 那份清单原文末尾有个 `...`（"可能还有别的键"）。
它与"形状封闭"**语义直接冲突**：读者会以为多写几个键没关系，而守卫会**拒**。
本轮把 `...` 换成"键名就是上面这三个（多一个即拒）"，并补一段写明"三处手抄 + 由谁比对"。
**闸门 ① 也因此更硬**：它比的是**逐字逐序相等**，`...` 那种"开放结尾"再也写不回去。

## 3. 落地清单（文件级）

| 文件 | 改了什么 |
|---|---|
| `backend/src/contracts/member-restrictions.ts` | **新（权威）**：`RESTRICTION_KEYS`（3 键，`as const`）＋ `RestrictionKey`／`DEFAULT_REQUIRE_APPROVAL_FOR_BONUS_OVER = 50`（Q15；注释里**诚实标注**"这只是默认值本身，何时套用属写入路径"）／`class ChildMemberRestrictions`（`@IsOptional` ＋ `@IsBoolean` ／ `@IsInt` ＋ `@Min(0)`）／`validateRestrictions()`（先挡 `null`/数组/非对象，再 `plainToInstance` ＋ `whitelist` ＋ `forbidNonWhitelisted`） |
| `backend/scripts/check-restrictions.ts` | **新**：A/B 两段式离线自检（**不需要数据库**）—— A1 空形状 `{}` 必须过／A2 三键齐全的合法形状必须过／A3 每键都**真的**有运行时约束（`Record<RestrictionKey, unknown>` 是**穷尽性检查**：加键忘了补这行，`typecheck:tools` 就红）／B **10 类**坏形状必须被拒且点名／B2 差分对照：从合法形状出发只改坏一个键 → 错误**只能**点名那个键 |
| `backend/package.json` | 新增 `restrictions:check`；接进 `ci` 成**第 9 步**（`relation:check` 之后、`build` 之前）⇒ **10 步变 11 步** |
| `tools/restrictions-check.mjs` | **新守门人**（6 项，`fail-closed`）：支持 6 个 `KP_RESTRICTIONS_*` 环境变量覆盖路径 —— 这正是证伪能"只改副本"的前提 |
| `docs/design/06-w0-report.md` | §3.1 的 `D3b` 行由「⏳ 阶段 D-b：类型 + 类型守卫 + 单测」改口为「✅ 已落地（阶段 D-b，2026-10-13）」，并点名 `validateRestrictions` / `restrictions:check` |
| `docs/design/02-rbac-and-approval.md` | §3 代码块去掉 `...`（口径修正）；补一段"形状已定形 / 三处手抄 / 由谁比对" |
| `docs/design/10-d1b-handoff.md` | §5 的"**`D3b` 仍未落地**"划线并指向本单 —— 免得留着"文档说没做、代码说做了"的陈旧陈述 |
| `docs/design/README.md` | 索引加本单；待办第 5 条改为"**12 条决策全部落地**"；进度加第 12 条 |

**未改**（都是**故意**的，不是漏）：

- `backend/prisma/schema.prisma`：列仍 `restrictions Json @default("{}")`，**没加迁移** ——
  形状定在应用层就是本决策的内容；把"内部形状"拆成多列/子表会动 DB，是**另一个决策**。
- **没有任何写入路径调用守卫**（`backend/src/**` 除新契约外 0 改动）：此刻还没有可接的路径。
- `lib/**`、`test/**`、`kids_points_mp/src/**`：`restrictions` 引用 **0 处** —— 前端不必动。
  （口径：`grep -rn restrictions lib test kids_points_mp/src` 各 **0** 命中；唯一命中在
  `kids_points_mp/node_modules/**` 的**第三方**类型里（32 处，与本项目无关），别把它当成"前端在用"。）

## 4. 证伪（14 反例 ＋ 3 控制例 ＋ 3 收尾 = 20 行全 PASS）

闸门 6 项，**每一项都有"必须变红、且只红它自己"的反例**（每例前都 `reset()` 重建一份**合法副本**）：

| 检查 | 反例 | 结果 |
|---|---|---|
| ① 三处键名逐字逐序相等 | A `schema` 注释把 `childCannotAddWish?` 拼成 `childCannotAddwis?`；B `02` §3 多一个 `n` | ✅ 各红且**只**点名 ① |
| ② 列必须仍是 `Json` ＋ `@default("{}")` | A 退回 `String`；B 丢掉 `@default("{}")` | ✅ 各只点名 ② |
| ③ 装饰器与 TS 类型一致 | A 布尔键丢 `@IsBoolean()`；B 类型写成 `string` 却仍 `@IsBoolean()`；C 丢 `@IsOptional()` | ✅ 各只点名 ③ |
| ④ 守卫必须封闭形状 | A `forbidNonWhitelisted: false`；B 丢掉 `plainToInstance`（裸对象进校验 = 装饰器全失效） | ✅ 各只点名 ④ |
| ⑤ 自检必须真接进 `ci` | A `ci` 链里摘掉 `restrictions:check`；B 删掉 `process.exitCode` 赋值；C 自检不再调用守卫（空壳） | ✅ 各只点名 ⑤ |
| ⑥ 文档必须已改口 | A 行退回「⏳ 阶段 D-b」；B 行仍说"已落地"但**不点名**守卫/闸门 | ✅ 各只点名 ⑥ |

**3 个控制例**（没有它们，"变红"无法排除"路径指错了 / 解析器坏了"）：
0 真文件全绿 ／ 1 覆盖路径指向**合法副本**全绿 ／ 2 权威类型指到不存在的文件 → **取源阶段红**（fail-closed）。
**3 个收尾**：6 个真文件 `sha256` 前后一致（篡改只发生在副本上）／清理副本后重跑回绿／副本目录确实已删。

### 三条自我纠正（都在自测 / 闸门 / 证伪脚本里，不在产品代码里）

1. **断言"精确条数"= 在断言库的实现细节。** 自检首版要求"改坏一个键 → **恰好 1 条**错误"，
   于是 **B2 红在了正确行为上**：`requireApprovalForBonusOver: '50'` 同时违反 `@IsInt()` 与 `@Min(0)`，
   class-validator 老老实实产了 2 条。改为"错误**都**点名那个键（≥1 条）" —— 差分对照要钉的是
   **可定位性**（谁的错标谁），不是错误条数。同一轮还修掉一处 TS 收窄错误（`unknown` 取值），也在自检脚本里。
2. **证伪脚本首跑是"崩"而不是"假绿"。** `patch()` 的多行 needle 写的是 `\n`，而副本是 **CRLF**，
   于是匹配不上 → 脚本直接抛错中止（`FALSIFY_EXIT=1`）。**这是好的一面**：用例失效时它**当场中止**
   而不是静默跳过。修法：匹配前把换行归一化为 `\n`、写回时按原风格还原。
   —— 与 D-a §4 第 2 条同源：**测试脚手架自己的状态最容易制造假象**。
3. **副本必须与被测对象同名。** 闸门 ⑤ 是按**文件名**核对 `package.json` 里 `restrictions:check` 的指向，
   所以副本里的自检保持 `scripts/check-restrictions.ts` **同名** —— 副本一改名，**每一例**都会多一个 ⑤，
   "逐条点名"立刻失去分辨力。

> 三条与本仓库头号教训同源（README：「绿的是我的反例，不是守卫」）：
> **测试基础设施自己的 bug，最会伪装成"通过"。**


## 5. 遗留（别把已修当已够）

- **写入路径未开工 → 守卫还没被任何地方调用。** `backend/src`（除本步新增的契约外）、`lib`、`test`、
  `kids_points_mp/src` 里 `restrictions` 命中**各 0 处**。闸门此刻是**防将来**的：等申请 / 审批 / 成员管理落地，
  它才会真正开始工作 —— 别把它的绿灯读成"屏障三已验收"。
- **"只能收紧、不能放宽"尚无强制点。** 本步只定**形状**（有哪些键、什么类型），**没有**校验
  "新限制相对基准是收紧还是放宽"（`02` §3 的方向性约束）。那需要写入路径 ＋ 一份基准判定，属另一个决策。
- **`DEFAULT_REQUIRE_APPROVAL_FOR_BONUS_OVER = 50` 只是个常量。** `restrictions` 里没给这个键时阈值取多少、
  正负号怎么判（Q15 的"±50"）—— **落点未定**，等写入路径。
- **`04` 首启引导仍是空白** —— 别把"首启空态"当成"引导已完成"（C1 只做了空态）。
- **工具/文件职责地图**（用户指示，尚未做）：`tools/**` 每个脚本做什么、在哪跑、产物在哪。
- **本步之后出现的新材料（2026-10-14 与 `docs/PRD.md` 同批入库，非本步产出）**：`prototype/**`（微信小程序高保真原型）
  自述「与 `kids_points_mp` 同源」，但 `prototype/verify.mjs` **只读原型自身**、`tools/icon-names-check.mjs`
  只覆盖 Taro / Flutter / 后端**三份**手抄名单 —— 原型是**第四份**。四组未对账面与建议方案见
  `docs/design/README.md` 待办 13；本轮的只读探针与下手包在 `tools/_scratch/`（**临时物，不入库**）。
- **本步没动数据库**：无迁移，因此**没有**跑 `seed → 900_ledger_revoke.sql → db:verify`
  （那三步只在 `migrate reset` 之后**必须**重跑，见 `06` §10.3；D-a 单 §6 ④ 有完整命令）。若下一轮动 schema，照那条链复跑。

## 6. 下一会话怎么复跑

```bash
# ① 静态闸门（不需要库、不需要前端）
cd backend && npm run ci               # 期望 CI_EXIT=0（11 步；第 9 步 = restrictions:check）

# ② 单跑本阶段的守门人与自检
cd backend && npm run restrictions:check   # 期望 ALL PASS（A1 / A2 / A3 / B / B2 共 5 行）
node tools/restrictions-check.mjs          # 期望 ALL PASS 6/6

# ③ 证伪（一次性的，放 _scratch，不入库）
node tools/_scratch/d3b-falsify.mjs        # 期望 20 行全 PASS
#   它自己的收尾会删掉 tools/_scratch/restrictions-falsify/ 并重跑闸门回绿

# ④ 数据库 / 前端：本步未改，不必复跑
#   （真要跑：数据库链见 10-d1b-handoff.md §6 ④；前端见同单 §6 ⑤）
```

**若闸门 ① 或 ⑥ 红**：多半是**有人改了键名只改了一处**。权威在
`backend/src/contracts/member-restrictions.ts` 的 `RESTRICTION_KEYS`，另两处是
`schema.prisma` 的 `/// 形状：{ … }` 注释与 `docs/design/02` §3 的代码块 —— **三处同改**。

