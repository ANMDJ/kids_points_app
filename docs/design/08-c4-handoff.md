# 阶段 C4 交接单 · C9（软删除/回收站）＋ C10（规则可编辑）＋ C11（`AuditLog` 变更可追溯）

> ## ✅ 已收口（2026-10-13）
>
> 本单的提案**已全部落地**（双端同步）。收口实测（完整记录见 `03` 文末「验收门」）：
>
> | 闸门 | 结果 |
> |---|---|
> | `node tools/defect-status.mjs` | ✅ `ALL PASS`（**18/18**，C9 / C10 / C11 三块已 `unfixed → fixed`） |
> | Taro `npx tsc --noEmit -p tsconfig.json` / `npm run build:weapp` | ✅ `EXIT=0` / `EXIT=0` |
> | 现编产物 ＋ `node .tmp_test/run.js` | ✅ **25/25 `ALL PASS`**（新增 C9 ×3 ＋ C10 ＋ C11 五条） |
> | `flutter analyze` / `flutter test` | ✅ `No issues found!` / **38/38**（`app_test.dart` 37 ＋ `widget_test.dart` 1；本轮新增 6 条） |
> | `cd backend && npm run ci` | ✅ `CI_EXIT=0`（8 步全绿，含 `defects:check` 18/18） |
>
> **§6 的 7 例证伪做了 6 例**（① 物理删回退 ／ ② 少一处过滤 ／ ③ 偷换 id ／ ⑤ 审计挪出同一笔 → 本轮以「审计改成 `push`」等价覆盖 ／ ⑥⑦ 台账改口）——
> 全部**点名对应条目**变红，还原后回绿（sha256 逐字节比对）。未做的是 ④「顺手改历史流水的 `points`」：
> 该断言由 `C10` 测试而非守门人承载，本轮**没有**注入实测，别把它当成已验证。
>
> 三处**与提案不同**的地方（提案是建议，实现才是事实，按 §4 的"行号会漂移"精神据实记录）：
> ① 三块验证器的**具体断言正则**按真实代码定形（§4.3 的正则只是草案）；
> ② `A2` 原断言 `final int dailyLimit;` **被 C10 的新语义作废** —— 改规则要**原地同步**派生习惯，
>    于是 `Habit.title/points/condition/dailyLimit` 不再是 `final`，断言改为「结构字段存在且可写」；
> ③ §8 第 4 条（成员/同意留**显式占位**）落实为：`AuditAction` **只列前端真能触达的 5 类动作**，
>    不写没人能触发的取值，并在 `03` §C11 现状里**写明未实现** —— 不假装覆盖。
>
> 下面保留**动手前**的原文（含"C4 还没动过一行代码"那句），以便对照"当时的前提"与"实际的做法"。

> **写于** 2026-10-12（本机）；**给**：接手 C4 的下一个会话。
> **一句话状态**：**C3 已收口**（提交 `90e9ce7`）：守门人 `ALL PASS`（18 条）、`backend npm run ci` 8 步全绿、
> `run.js` 20/20、`flutter test` 32/32。**C4 还没动过一行代码** —— 台账 `03:36/37/38` 三行仍是 `❌ 未修`，
> 守门人也**故意**用 `A.lack(...)`（"找不到软删除痕迹才 PASS"）钉着这个事实。
> 换句话说：**今天这片绿，是"缺陷确实还在"换来的**。一开始改代码，守门人立刻会红 —— 那是它正常工作，不是事故。

## 0. 接手第一步（3 分钟自检：世界没变再往下做）

```bash
cd C:/Users/a9653/.cline/data/workspaces/chat/kids_points_app
git log --oneline -1            # 期望：90e9ce7 feat(c3)+docs: E16 心愿配色升为稳定枚举 …
git status --short              # 期望：只有 kids_points_mp/package.json、package-lock.json（与本轮无关，提交时别带）
node tools/defect-status.mjs    # 期望：ALL PASS（18 条）、EXIT=0；其中 C9/C10/C11 显示「台账=❌ 未修」
cd kids_points_mp && npx tsc --noEmit -p tsconfig.json; echo TSC_EXIT=$?   # 期望 TSC_EXIT=0
```

若上面任一期望**不成立**（例如守门人已经红、或某条 C9/C10/C11 变成 PASS），先弄清差异再动手 ——
本仓库最忌讳的失败形态就是"照旧前提干活"。§5 有全套闸门与基线数字。

## 1. 这一步在修什么（三条为什么要一起做）

| 缺陷 | 一句话本质 | 台账行 |
|---|---|---|
| **C9** | 删除是**物理删除**（`filter((item) => item !== x)`）：误删不可恢复；`Habit` 连删除方法都没有 | `03:36` |
| **C10** | **没有 `updateRule`**：家长想改分值只能"删了重建" → `id` 变 → 历史断裂（且因无 `ruleId`，连断裂都看不出来） | `03:37` |
| **C11** | **没有任何审计**：谁在什么时候把「每天最多 2 次」改成「每天最多 1 次」，查不到 | `03:38` |

**必须一起做**，因为它们是同一笔写入的三个视角：

```
改规则（C10）＝ 写一条版本(PointRuleVersion) ＋ 写一条审计(AuditLog) ＋ 不动历史流水   ← 02 §5.3 四步事务
删规则（C9） ＝ 规则主体软删，但**版本表与审计必须还在** —— 否则 (ruleId, ruleVersion) 指向空，
              "这 +1 分是按什么规则给的"永远无法回答（02 §5.6）
```

三条合起来才有意义的判据是：**任何一条历史流水都能回答"谁、何时、按哪版规则、为什么"**。
只做软删不做审计（或只做审计不做版本化），都只是"看起来在做安全"。

## 2. 现状事实（全部可 grep 复核；"已就绪"与"空白"分得很清）

### 2.1 已就绪：后端 schema（W0 建好了 —— **本阶段不必写迁移**）

| 东西 | 位置 | 关键约束 |
|---|---|---|
| `enum RecordStatus { active, deleted }` | `backend/prisma/schema.prisma:76` | 全库统一软删状态位 |
| `PointRule` 的 `currentVersion` / `status` / `deletedAt` | schema `PointRule` 模型；迁移 `backend/prisma/migrations/20261012022042_w0_init/migration.sql:143-145`；索引 `PointRule_childId_deletedAt_idx`（`:396`） | `currentVersion` 默认 1 |
| `Habit.status` / `deletedAt`、`Wish.status` / `deletedAt` | 迁移 `:75`（Child）、`:208`（Habit）、`:226`（Wish） | C9 的三个作用对象都有字段 |
| `WishCoverStyle` 枚举 | schema `:107-112`（W0 建，C3 前端已对齐） | 与 `types.ts:59` / `lib/models/wish.dart:7` 一一对应 |
| `PointRuleVersion` | schema `:371-391` | `@@unique([ruleId, version])`；**只增不删**；`onDelete: Restrict`（不得因删用户丢作者） |
| `AuditLog` | schema `:636-663` | `action` / `targetType` / `targetId` / `before` / `after`(JSON) / `actorUserId` / `actorRole` / `deviceId` / `ipHash` / `createdAt`；三个索引（`childId+createdAt`、`targetType+targetId`、`action+createdAt`） |
| DB 层"不可改删" | `backend/prisma/sql/900_ledger_revoke.sql:39-41` | 对 `PointRecord` / `PointRuleVersion` / `AuditLog` **REVOKE UPDATE, DELETE**，且带**自检**（权限不符就让迁移失败，不留空承诺） |
| 权限矩阵已含 `update_rule` | `contracts/permission-matrix.json`、`backend/src/contracts/permission-matrix.ts:46` | `guardian: ALLOW` / `child: DENY` |

> ⚠️ **后端 API 仍是占位**：`backend/src/rules/rules.module.ts` 与 `backend/src/audit/audit.module.ts` 都只有 `@Module({})`
> ＋文件头注释（注释里写着四步事务与白名单）。**没有 service / controller / repository / DTO**。
> 所以 C4 的**事实范围＝前端等价实现 ＋ 台账/守门人改口**，后端 API 不在本轮（与 C1–C3 一致）。
> **但必须在文档里明说**（照 README 那两处"诚实标注"的写法），否则就成了"看起来在做安全"（本项目头号教训）。

### 2.2 空白：双端一处都没有（守门人正是靠"找不到"才 PASS）

`tools/defect-status.mjs` 三条验证器，全是 `A.lack`：

| 条目 | 行 | 断言 |
|---|---|---|
| `C9` | `:222-225` | `A.lack(T_STORE, /deletedAt\|softDelete/)`、`A.lack(F_STORE, /deletedAt\|softDelete/)` |
| `C10` | `:226-229` | `A.lack(T_STORE, /updateRule/)`、`A.lack(F_STORE, /updateRule/)` |
| `C11` | `:230-234` | `A.lack(T_STORE, /auditLog\|AuditLog/)`、`A.lack(T_TYPES, …)`、`A.lack(F_STORE, …)` |

**C9 要动的删除点（含调用方，改完 UI 也要跟着改）**

| 端 | 方法（物理删） | 调用方 |
|---|---|---|
| Taro | `kids_points_mp/src/data/store.ts:403 removeWish()`、`:441 removeRule()` | `src/pages/wishlist/index.tsx:111`、`src/sheets/RuleActionsSheet.tsx:38` |
| Flutter | `lib/data/app_store.dart:365 removeWish()`、`:404 removeRule()` | `lib/screens/wishlist_screen.dart:227`、`lib/screens/sheets/add_rule_sheet.dart:191` |
| 双端 | **`Habit` 没有删除方法**（只靠 `resetToSeed` 清空） | — |

**C10 可复用的表单**（建议"新增/编辑"共用一张）：`kids_points_mp/src/sheets/AddRuleSheet.tsx`、`lib/screens/sheets/add_rule_sheet.dart`。

**C11 要挂审计的写入点**（双端一一对应）：`checkIn` / `undoCheckIn` / `addQuickNote` / `redeem` / `addWish` / `removeWish` /
`addRule` / `removeRule` / `addHabitFromRule` / `renameChild`（`store.ts:177/231/305/355/386/403/417/441/454/478`）。

**结构字段落点**：`kids_points_mp/src/data/types.ts` 的 `Habit:37` / `Wish:93` / `PointRecord:112` / `PointRule:162`
（Flutter 对应 `lib/models/*.dart`）。**新增字段一律走"结构字段 + 派生"，别再加可写展示串** —— 那正是 A2/A3/E15/E17 的病。

## 3. 设计硬约束（`02` 定稿，**是验收标准，不是可选项**）

1. **`update_rule` 是四步原子操作**（`02` §5.3）：读 `currentVersion = v` → 写 `PointRuleVersion{version: v+1, ...新值}` →
   更新 `PointRule`（含 `currentVersion = v+1`）→ 写 `AuditLog{action:'point_rule.update', before, after}`。
   前端等价实现＝**一次方法调用里做完四件事、一次 `persist()`**；分两次就会产生"改了但没记"的窗口。
2. **改规则的时间线语义**（`02` §5.4）：**历史不可回溯、未来从新规**。已发生流水的 `points` / `ruleVersion` **完全不动**；
   今日已用额度**按新规重算**。前端已由 A3 的派生设计天然满足（`checkedCountToday >= dailyLimit` → 不能再打卡）。
3. **必须提示家长**（`02` §5.5，原文在 `02:377-384`）：改动后若今日已打卡数 ≥ 新上限，界面**必须**给出可读提示：
   `改动后，小满今天已完成 1 次，按新规则「每天最多 1 次」，今天不能再打卡了。`
   → **建议做成纯函数**（如 `ruleChangeNotice(rule, newDailyLimit, checkedCountToday)`) 并**钉死断言**，
   别写在 JSX / Widget 里 —— 写在界面里的文案**无法被测试**，那就是 E17 的老病。
4. **版本与审计只增不删**（`02` §5.6、`01` §5）：`PointRuleVersion`、`AuditLog` **永不删除、永不 UPDATE**（与 `PointRecord` 同等待遇）；
   C9 的回收站**只作用于"配置"**（规则/心愿/习惯），**流水与审计永不删除**。
5. **回收站保留 90 天**（Q12 结论，`03:328-329`）；到期后是否真清理由产品决定，但**判定必须是纯函数**（可测边界）。
6. **收敛到一处过滤器**：列表查询排除 `deleted` 的写法**只能有一处**（如 `activeOnly(items)`），
   两端各写一遍 `status === 'active'` 迟早漂移 —— 这正是 E15/E17 教过的。

## 4. 建议的实施顺序（**照 C1–C3 的节奏**：先写"能失败"的用例 → 双端同步 → 守门人钉死 → 台账改口 → 证伪 → 提交）

### 4.1 第一步永远是"先写会失败的用例"

在 `kids_points_mp/.tmp_test/run.js` 与 `test/app_test.dart` 各加一组，**先跑一次、确认它是红的**
（红的形态（报错原文）建议抄进 `tools/_scratch/`，那是"这条用例真看得见缺陷"的证据）：

| 条目 | 用例要点 |
|---|---|
| **C9** | 软删后：① 列表里消失；② 回收站里**找得到**；③ 原对象**仍在**（不是被 `filter` 掉）；④ 90 天边界（89 天可恢复、91 天判定为可清理）；⑤ **流水与审计条数不变** |
| **C10** | `updateRule` 后：① **`id` 不变**（改价不等于换对象）；② `currentVersion` **+1**；③ 版本记录多一条且 `version` 连续；④ **历史流水的 `points` / `ruleVersion` 一字不改**；⑤ 今日剩余额度**按新规**；⑥ §3.3 的提示文案在"已打卡数 ≥ 新上限"时**必须**出现 |
| **C11** | 每次变更**在同一笔操作里**追加一条审计（`action` / `targetType` / `targetId` / `before` / `after` / 时间 / 角色）；**审计只增**；`before` / `after` 是**真快照**（写完再改原对象，审计内容不得跟着变） |

### 4.2 双端同步改造（Taro ＋ Flutter 一起改，两端行为必须一致）

| 落点 | 建议内容 |
|---|---|
| `types.ts` / `lib/models/*.dart` | `Habit` / `Wish` / `PointRule` 加 `status: 'active' \| 'deleted'` ＋ `deletedAt: number \| null`；`PointRule.currentVersion`；新增 `AuditEntry` / `RuleVersion` 类型；派生函数：`activeOnly()` / `isTrashExpired()` / `ruleChangeNotice()` / `auditEntryOf()` |
| `store.ts` / `app_store.dart` | `removeWish` / `removeRule` → **软删**（写 `status` + `deletedAt`）；新增 `restoreWish` / `restoreRule`、`purgeTrash(now)`；给 `Habit` 补删除/恢复；新增 `updateRule(...)`（四步一笔）；**每个写入点追加审计** |
| 列表 / 回收站 UI | 列表一律走 `activeOnly()`；回收站入口（"我的"页或规则页，**两端口径一致**）；恢复/彻底删除各一条路径 |
| 表单 | 复用 `AddRuleSheet` / `add_rule_sheet.dart` 做**编辑态**（同一张表单），并在保存前按 §3.3 给提示 |

> ⚠️ **C9/C10/C11 不是"顺手做完"的量**：三条都要双端同步 ＋ 两套测试 ＋ 守门人 3 块改写 ＋ 台账 4 处改口。
> 若一轮做不完，**按 C9 → C10 → C11 拆成三个小步分别收口**（每步都能独立"红→绿→提交"），
> 千万别做成"三条半成品一起提交" —— 半成品在台账里只能写 `⚠️ 半修`，而守门人对"半修"要求**守卫与残留同时存在**，更难写清。

### 4.3 守门人改口：`tools/defect-status.mjs` 三块 `unfixed → fixed`

三块在 `:222`（C9）、`:226`（C10）、`:230`（C11），每块现在只有 2–3 行 `A.lack`。
**照 E16 的模板改**（`:268-292`，四类断言）：① **结构存在** → ② **反回退** → ③ **编译期保障** → ④ **回归用例 ＋ 钉死断言**。
建议写成（**开工时按实际实现调整，下面只是"该钉住什么"的清单**）：

| 条目 | 应断言（正向） | **反回退断言（最值钱的一类）** |
|---|---|---|
| **C9** | 两端模型有 `status` / `deletedAt`；两端 `removeX` 写入 `status = 'deleted'` ＋ `deletedAt`；存在 `restoreX` / `purgeTrash`；列表走**唯一**过滤器 | 两端 `filter((item) => item !==` **归零**（物理删的指纹）；`activeOnly` 之外的 `status === 'active'` 判定归零；`reversesRecordId`（流水冲正机制）**不得被回收站牵连** |
| **C10** | 两端存在 `updateRule(`；`currentVersion` +1 的写入点唯一；版本表追加一条 | `updateRule` 里**不得出现 `newId('rule')`**（换 id ＝ 假版本化）；`records` 数组**不得**被 `updateRule` 改写（`A.lack` 指向 `points` 赋值块） |
| **C11** | 两端存在 `auditLog` / `AuditEntry`；写入点覆盖 §2.2 的清单 | `A.lack(T_STORE, /auditLog\s*=\s*this\.auditLog\.filter/)`（审计**只增不删**）；`A.lack(F_STORE, /_auditLog\s*=\s*_auditLog\.where/)`；审计条目**不得**只有 `action` 而无 `before` / `after` |

> ⚠️ **改口是同一次提交里改 4 个地方**：① 守门人三块 ＋ ② `03:36/37/38` 状态列 ＋ ③ `03` §C9/C10/C11 的"**修复**"段（改成"现状（…已落地）"段，
> 照 §E15/§E16/§E17 的写法）＋ ④ `03:47` 合计行与 `03:81` 阶段清单行、`03:560` 修复顺序行。
> 少改一处，`defects:check` 就会红 —— 这是设计如此（C1/C2/C3 三次都这么被拦下）。
> 行号会因编辑漂移：**每次改前先 `grep -n` 复核**，别照本单的行号硬改。

## 5. 闸门与基线（**C3 收口时实测**；C4 动手前先复现一遍）

| # | 命令（工作目录） | C3 收口时的结果 |
|---|---|---|
| 1 | `node tools/defect-status.mjs`（仓库根） | ✅ `ALL PASS`（18 条）、`EXIT=0` |
| 2 | `npx tsc --noEmit -p tsconfig.json`（`kids_points_mp/`） | ✅ `TSC_EXIT=0` |
| 3 | 现编产物：`npx tsc src/data/store.ts src/data/seed.ts src/data/types.ts src/utils/color.ts --outDir .tmp_test/dist --module commonjs --target es2017 --strictNullChecks --esModuleInterop --skipLibCheck` ＋ `node .tmp_test/run.js`（`kids_points_mp/`） | ✅ **20/20 `ALL PASS`** |
| 4 | `flutter analyze`（仓库根） | ✅ `No issues found!` |
| 5 | `flutter test`（仓库根） | ✅ **`+32: All tests passed!`** |
| 6 | `cd backend && npm run ci`（8 步：`prisma:validate` / `typecheck` / `typecheck:tools` / `honesty:probe` / `defects:check` / `templates:check` / `build` / `contracts:emit`） | ✅ `CI_EXIT=0`，8 步全绿 |

基线数字：`run.js` **20** 项、`flutter test` **32** 条（`test/` 下**全部**文件 —— 别只数 `app_test.dart`）。
C4 收口后期望值要按新增用例数**据实更新**，并把新数字写回 README 与 `03` 的相应段落。

## 6. 证伪自测（**不做这一步等于没有回归**）

每例：注入反例 → 必须红（**点名对应条目**）→ **字节级还原** → 必须绿。建议至少 7 例：

| # | 注入什么 | 期望变红的那条闸门 |
|---|---|---|
| ① | 双端 `removeWish` / `removeRule` 回退成 `filter` 物理删 | C9（两套测试 ＋ 守门人 C9） |
| ② | 软删了但列表**忘记过滤**（`activeOnly` 少一处） | 测试"列表里消失"那条 —— 若它没红，说明这条用例**形同虚设**，必须补 |
| ③ | `updateRule` 里偷偷 `newId('rule')`（假装版本化） | C10 的"`id` 不变"断言 |
| ④ | `updateRule` 顺手把历史流水的 `points` 一并改掉 | C10 的"历史一字不改"断言 |
| ⑤ | 把审计从"同一笔"挪成事后单独补（或删掉一条审计） | C11 的"每次变更都留痕"断言 |
| ⑥ | 守门人三块 `status: 'fixed'` 改回 `'unfixed'` | 守门人（台账说已修、代码找不到证据） |
| ⑦ | 台账改口后再改回 `❌ 未修` | 守门人（"声明与代码不符即红"的正向验证） |

**⚠️ C3 学到的（`07` §5 第 9 条）：断言名 ≠ 断言力。** 注入前先问"**这条闸门真的看得见这一改动吗**"。
C3 实测：把 Flutter 取色换回数组下标，`flutter analyze` 与整包 `flutter test` **32/32 全绿**（表凑巧同序 → 行为等价），
真正拦住它的是守门人一条 `A.lack`。**C4 的同类风险**（这两种能"测试全绿"地活下来）：

- **"软删了但界面照旧显示已删项"** → 单元测试全绿（对象确实还在），只有**列表级断言**能抓住；
- **"审计写了，但 `before` / `after` 是同一个对象引用"** → 断言 `auditCount === 1` 全绿，快照其实是活的。
  抓法：**写完审计后修改原对象，再读审计，内容必须不变**（真快照）。

## 7. 陷阱（**每条都是前几轮真踩过的**，别重复付费）

1. ⚠️ **`editor` 工具对本仓库 CRLF 文件的"多行整块匹配"不可靠** → 一律用 `tools/_scratch/*.mjs` 脚手架：
   **行尾归一（CRLF↔LF 按原样回写）＋"命中数必须 = 1"闸门 ＋ 写盘后回读校验**。
   本轮现成模板：`tools/_scratch/c4-doc-handoff.mjs`（本次文档改动就是它做的，可直接抄结构）。
   （`docs/design/` 现状：`03` / `README` 在工作区是 CRLF，`07` 是 LF；`.gitattributes` 已统一按 LF **存储**。）
2. **在 `defect-status.mjs` 里做"整块字符串替换"会神秘失配**（引号/反斜杠/不可见字符，实测命中 0 次）→
   改用**按行定位**：起点＝含 `id: 'C9'` 的行，终点＝其后第一个 `  ] },`。模板：`tools/_scratch/c3-guard2.mjs`。
3. ⚠️ **`tools/_scratch/**/*.dart` 会被 `flutter analyze` 当库代码扫**（`analysis_options.yaml` 的 `exclude` 只有 `build/ android/ ios/`）
   → Dart 片段**一律用 `.dart.txt`** 后缀，否则 `analyze` 会报一堆不属于仓库的 issue（C3 白跑过一次）。
4. **后台命令必须 `nohup … &` ＋ 重定向 ＋ `< /dev/null`**：只写 `(cmd &)` 时，工具 **30s 超时会连坐杀掉子进程**
   （C3 的 `flutter analyze` 因此"跑了 12 分钟没结果"）。判据：`ls -l` 看日志大小有没有在长。
5. **⚠️ 别用 `git checkout` 还原**：工作区常带未提交改动，`git checkout` 会连真改动一起丢。
   用**内存快照 ＋ sha256 比对**（模板 `tools/_scratch/c3-restore-card.mjs`）。
6. **`flutter test --plain-name` 带空格会被 `shell:true` 拆开 → 假红**：匹配 0 条时退出码是 **79**（不是 1）。
   要么把整个参数引号包住，要么用**不带空格的用例名标签**。
7. **"归零"不靠肉眼 `grep | wc -l` 下结论**：合法残留（注释里讲"原先怎么写的"、守门人**自己的反回退正则**）
   会让人误判。判据用守门人的 `A.lack` / `A.countIs(..., 0)`。
8. **提交一律显式文件清单**，别 `git add -A`：工作区目前有 `kids_points_mp/package.json` 与 `package-lock.json`
   两个**与本轮无关**的既存改动（`react-refresh`，mtime 早于 C3 编辑）→ 不并入任何阶段提交。
9. 本机 `grep.exe` 偶尔留下 `grep.exe.stackdump`（未跟踪垃圾）→ 删掉，**不要 `git add`**。
10. **文档里的行号是"写作时的快照"**：本单所有 `:行号` 都在 2026-10-12 实测，编辑后必然漂移 ——
    **改前先 `grep -n` 复核**，别硬改（C3 就因此在 §4.1 记过一次"行号已下移 4 行"）。

## 8. 需要用户/台账先决策的 5 件事（**开工前先问，别替用户决定**）

| # | 问题 | 建议（供参考，**不是已定**） |
|---|---|---|
| 1 | **C9 的回收站做前端本地形态，还是等后端 API？** | 前端本地实现 ＋ 在 `03` / README **明说"后端 API 未实现"**（照 README 两处诚实标注的写法） |
| 2 | **90 天到期**：只判定/展示，还是自动清理？ | 判定做成**纯函数** ＋ 边界测试（89/90/91 天）；是否真删由 UI 决定 |
| 3 | **C10 是否要在前端暴露"规则版本历史"列表**（读 `PointRuleVersion`）？ | 至少落 `currentVersion` ＋ 版本记录；列表可后置 |
| 4 | **C11 审计白名单范围**：`02` 写的是"规则/心愿/习惯/成员/同意"，而前端只有规则/心愿/习惯可写 | 成员/同意**留显式占位**（写清"未实现"），别假装覆盖 |
| 5 | **审计动作是联合类型还是自由字符串？** | 联合类型（编译期穷尽，与 E16 的枚举同理）；避免 `action: string` 里的拼写漂移 |

## 9. 收尾（**一处** C4 提交）

```bash
# 提交前必须五跑：守门人 / tsc / run.js / flutter analyze+test / backend ci
git add kids_points_mp/src/data/types.ts kids_points_mp/src/data/store.ts \
        kids_points_mp/src/pages/wishlist/index.tsx kids_points_mp/src/pages/rule/index.tsx \
        kids_points_mp/src/sheets/AddRuleSheet.tsx kids_points_mp/src/sheets/RuleActionsSheet.tsx \
        kids_points_mp/.tmp_test/run.js \
        lib/models/*.dart lib/data/app_store.dart lib/screens/*.dart lib/screens/sheets/*.dart \
        test/app_test.dart tools/defect-status.mjs \
        docs/design/03-existing-defects.md docs/design/README.md
# 不要 git add -A：package.json / package-lock.json 与本轮无关（§7 第 8 条）
git commit -m "feat(c4)+docs: 软删除/回收站(C9) + 规则可编辑(C10) + AuditLog(C11) —— 双端同步、守门人改口"
```

提交信息按 README「Git 记录规范」写全 **背景/为什么 ＋ 验证证据（命令 → 结果与退出码）**；
`fix` / `feat` 类**必须附"改之前红、改之后绿"两次真实输出**（本单 §6 的 7 例就是那份证据）。
若一轮拆成三步提交，**每步都各自满足上述要求**。

## 10. C4 之后（别丢）

- **C5** = `D9`（`iconName` → `IconData` 映射；见 `03`、README 待办 4）。
- **W1 开工前两件事**（README 待办 7）：① 引入测试框架（现在只有手写断言的 `npm run db:verify`）；
  ② `kids_points_app` 口令改为部署注入（`900_ledger_revoke.sql` 里现在是硬编码占位）。
- **首启引导流程**（`04`）仍是空白 —— 别把"首启空态"当成"引导已完成"（README 待办 8 的遗留）。
- **待办（用户指示，尚未做）**：「工具/文件职责地图」—— `tools/**` 每个脚本负责什么、什么命令在哪个目录跑、产物在哪；
  **暂不**接 VS Code task / pre-commit 钩子（见 `07` §6）。

---

## 附录 · 本单的"已核实 / 未核实"（诚实标注）

**已核实（本轮实测，可复核）**

- 守门人 `node tools/defect-status.mjs` → `ALL PASS`（18 条）、`EXIT=0`；其中 `C9/C10/C11` 显示「台账=❌ 未修」。
  （**C4 收口后这三行已变为「台账=✅ 已修」** —— 上句是**本单写作当时**的事实，保留以对照前提。）
- `git log -1` = `90e9ce7`；`git status --short` 只有 `kids_points_mp/package.json`、`package-lock.json`。
- 后端 schema 字段/索引/`REVOKE`/模块占位状态：逐文件读取确认（§2.1 每行都有 `文件:行号`）。
- 双端物理删除点与调用方、结构字段定义位置、`AuditLog`/`PointRuleVersion` 模型形状：grep ＋ 读文件确认（§2.2）。
- 三个文档的行尾风格（`03`/`README` = CRLF，`07` = LF；索引均按 LF 存储）。

**未核实（本单只是建议，别当结论）**

- §4.3 的**具体断言正则**与 §4.2 的**函数命名**（`activeOnly` / `purgeTrash` / `ruleChangeNotice` …）—— 未写一行实现，属提案。
- §5 表里的基线数字来自 **C3 收口时**的实测记录；本轮**没有重跑** `flutter analyze/test` 与 `backend npm run ci`
  （只重跑了守门人）。动手前请按 §0 复现一遍，对不上就先查差异。
- 「C4 一轮做得完 / 该拆三步」是**估算**，不是实测；以实际改动量为准。



