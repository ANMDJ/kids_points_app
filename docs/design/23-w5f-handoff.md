# 阶段 W5-F 交接单 · 回收站（软删 90 天 · `/trash` 三条路由 ＋ 双端回收站）

> **状态（2026-10-21）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm run typecheck` / `typecheck:tests` | ✅ 退出码 **0** |
> | `cd backend && npm run build` | ✅ 退出码 **0** |
> | `cd backend && npm test` | ✅ **477/477**（27 个用例文件；本阶段新增 `trash-http.test.ts` 16 条 / 3 组） |
> | `cd backend && npm run contracts:emit` | ✅ 矩阵落盘 **29 个动作**（本阶段 +4：`delete_habit` / `view_trash` / `restore_trash_item` / `purge_trash_item`） |
> | `flutter analyze` | ✅ 0 issue |
> | `flutter test` | ✅ **149/149**（本阶段新增 17 条：模型 / DTO / 客户端 / store / 组件） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && npm run build:weapp` | ✅ 退出码 **0**（仅 Sass `@import` 弃用告警，仓库既有） |
> | `npx tsc -p .tmp_test/tsconfig.test.json` → `node .tmp_test/run.js` | ✅ **ALL PASS**（含 w4c / w4e / w5a / w5b / w5c 五个子 runner；老用例无回归） |
> | `node .tmp_test/run-w5f.mjs` | ✅ **19/19**（本阶段新增） |
> | 其它 runner（w4c / w4e / w5a / w5b / w5c / w5d / w5e） | ✅ 全绿（`ALL PASS`） |
> | 新增迁移 | ✅ **有**：`backend/prisma/migrations/20261021120000_trash_actions/` |
>
> **给**：接手「邀请 / 头像 / 成员管理 / 真机联调」的下一个会话。

## 1. 本阶段做了什么

修 C9 之前，删除是**物理删除**：误删不可恢复，而且被删主体从库里消失后，
历史流水的回指（`ruleId` / `wishId` / `habitId`）指向空 ——「这 +1 分按什么规则给的」
再也回答不了。本阶段把「删除」改成**软删 + 回收站**，双端各有一个回收站面板。

| 层 | 落点 | 行为 |
|---|---|---|
| 迁移 | `backend/prisma/migrations/20261021120000_trash_actions/` | 只做一件事：`ActionType` 增加 4 个值（`delete_habit` / `view_trash` / `restore_trash_item` / `purge_trash_item`）。三类表的 `status` / `deletedAt` 在 W0 建表时就有，本阶段**没有**改表结构 |
| 路由（习惯） | `backend/src/habits/habits.lifecycle.controller.ts` | `DELETE /habits/:id` → 200，`@RequireAction('delete_habit')`，支持 `Idempotency-Key` |
| 业务（习惯） | `backend/src/habits/habits.prisma.repository.ts` | 单事务：`UPDATE status='deleted', deletedAt=now()` → 同事务写 `habit.delete` 审计（before 有值 / after 有值） |
| 路由（回收站） | `backend/src/trash/trash.controller.ts` | `GET /trash`、`POST /trash/:kind/:id/restore`、`DELETE /trash/:kind/:id`；三条路由三个动作，各自独立 |
| 业务（回收站） | `backend/src/trash/trash.service.ts` | 只做入参形状（`kind` 白名单、`id` 1..64）与线格式（`deletedAt` → ISO 串）；**不**过滤 90 天 |
| 适配器 | `backend/src/trash/trash.prisma.repository.ts` | 恢复 / 彻底删除都在 `lockChildBalance()` 之后；恢复写 `*.restore` 审计，彻底删除写 `*.purge` 审计（`after = JsonNull`） |
| 契约 | `backend/src/contracts/permission-matrix.ts` ＋ `contracts/permission-matrix.json` | `delete_habit`、`view_trash`、`restore_trash_item`、`purge_trash_item` |
| Flutter 模型 | `lib/models/trash.dart` | `trashRetentionDays = 90`、`isTrashExpired()`、`trashRetentionText()`、`TrashPurgeOutcome`、`trashKindFromWire()` |
| Flutter DTO / 客户端 | `lib/data/read_dto.dart`、`lib/data/write_dto.dart`、`lib/data/read_api.dart`、`lib/data/write_api.dart` | `TrashListDto` / `TrashItemDto`、`TrashTargetDto`、`fetchTrash()`、`deleteHabit()` / `restoreTrashItem()` / `purgeTrashItem()` |
| Flutter store | `lib/data/app_store.dart` | `trashItems` / `trashStatus` / `trashError`、`refreshTrash()`、`submitRemoveHabit()`、`submitRestoreTrash()`、`submitPurgeTrash()`、`submitPurgeExpiredTrash()` |
| Flutter UI | `lib/screens/sheets/trash_sheet.dart`、`lib/screens/profile_screen.dart`、`lib/screens/sheets/add_rule_sheet.dart` | 「我的 · 回收站」入口；恢复 / 彻底删除 / 清理过期；规则菜单里多一条「把“X”移出首页习惯」 |
| 小程序类型 | `kids_points_mp/src/data/types.ts` | `trashKindFromWire()`、`TrashPurgeOutcome`、`trashPurgeOutcomeText()` |
| 小程序 DTO / 客户端 | `read_dto.ts`、`read_api.ts`、`read_mapper.ts`、`write_dto.ts`、`write_api.ts` | `TrashItemDto` / `TrashListDto`、`fetchTrash()`、`mapTrash()`、`TrashTargetDto`、`deleteHabit()` / `restoreTrashItem()` / `purgeTrashItem()` |
| 小程序 store | `kids_points_mp/src/data/store.ts` | 独立回收站切片：`trashItems()` / `trashStatus` / `trashError` / `isTrashWriteReadOnly` / `isHabitWriteReadOnly` ＋ 五个异步提交方法 |
| 小程序 UI | `kids_points_mp/src/sheets/TrashSheet.tsx`、`src/pages/profile/index.tsx`、`src/sheets/RuleActionsSheet.tsx` | 回收站弹层（异步三态）、我的页入口带条数、规则菜单里的「移出首页习惯」 |
| 用例 | `backend/test/trash-http.test.ts`、`kids_points_mp/.tmp_test/run-w5f.mjs`、`test/write_api_test.dart` | 见 §4 |

## 2. 关键实现决策

### 2.1 删除一律是软删：只改 `status` + `deletedAt`

`DELETE /habits/:id`（以及既有的 `DELETE /point-rules/:id` / `DELETE /wishes/:id`）
在事务里只做两件事：`UPDATE … SET status='deleted', deletedAt=now()` 与写一条
`habit.delete` 审计（before / after 都是完整快照，看得见「删的是什么」）。

为什么不做物理删除：流水通过 `ruleId` / `wishId` / `habitId` 回指主体，
其中 `ruleId` / `wishId` **没有外键**（历史设计），物理删不会报错，只会让
「这 +1 分按什么规则给的」永久断链。软删把解释权留在库里。

### 2.2 90 天只是**一个事实**：服务端下发 `deletedAt`，客户端自己算过期

`GET /trash` 的每一项只有 `{kind, id, title, deletedAt}`，**没有** `expiresAt`、
也没有 `expired`。原因：保留期是纯函数 `isTrashExpired(deletedAt, now)`，
双端各一份已测试实现（`lib/models/trash.dart` / `kids_points_mp/src/data/trash.ts`）。
服务端再算一遍就引入第二个 90 天常量 —— 两边改不同步时，界面与接口会互相矛盾。

两条配套口径：
- **过期条目仍然列出**（客户端标红、只允许「彻底删除」）。服务端静默隐藏，
  家长会以为「东西自己没了」，而事实是到期未清理。
- **服务端不自动清理**：到期 ≠ 必须删（`docs/design/08 §3.5`），
  物理删除永远是用户的显式动作（`DELETE /trash/:kind/:id`）。

### 2.3 恢复由构造幂等，彻底删除不是 —— 所以都不加 `Idempotency-Key`

- 恢复：本来就没删（`status='active'`）⇒ 直接回同一 `{kind,id}`，
  **不写第二条审计**。重试不会留下两条一模一样的 `habit.restore`。
- 彻底删除：重复调用得到 404 `TRASH_ITEM_NOT_FOUND` —— 这一项真的不在了，
  这正是**应当**给出的答案。加一层响应缓存只会多一个「缓存说成功、库里已没有」的中间态。

### 2.4 彻底删除的两道闸：只删「已软删」的，且不许删断账

- `status != 'deleted'` ⇒ 409 `TRASH_ITEM_NOT_DELETED`（一次误点不能从在用列表里抹掉配置）。
- 还有流水指着它 ⇒ 409 `TRASH_ITEM_REFERENCED`（附 `records` 条数）。
  这条判定必须显式 `count`：`ruleId` / `wishId` 没有外键，`habitId` 的 `SetNull`
  只会**静默置空**，库不会替你拒绝。

`point_rule` 还要先删版本行（`PointRuleVersion.ruleId` 是 `onDelete: Restrict`），
否则 `pointRule.delete()` 直接 P2014。审计 `*.purge` 的 `after` 写 `JsonNull`（确实没了）。

### 2.5 恢复习惯时，父规则还在回收站 ⇒ 409 `TRASH_PARENT_RULE_DELETED`

习惯带 `sourceRuleId`；若那条规则还躺在回收站里，把习惯恢复出来会立刻变成
「看着能打卡、一点就 `HABIT_RULE_GONE`」的假可用状态。所以先挡住并说清顺序：
**先恢复规则，再恢复习惯**。规则被彻底删除时 `sourceRuleId` 由 `onDelete: SetNull`
置空，这个分支自然走不到。

### 2.6 孩子**能看**回收站、**不能改**

| 动作 | guardian | child |
|---|---|---|
| `view_trash`（`GET /trash`） | ALLOW | **ALLOW** |
| `restore_trash_item` | ALLOW | DENY |
| `purge_trash_item` | ALLOW | DENY |
| `delete_habit` | ALLOW | DENY |

「我删掉的那张卡不见了」是 C9 的原始抱怨 —— 看见回收站能消除「东西凭空消失」的恐惧；
但恢复 / 彻底删除是不可逆的配置变更，仍然只属于监护人（与 `delete_rule` / `delete_wish` 同侧）。
孩子端因此**有**入口、能看见条目，只是按钮会得到「只读」文案（客户端先拦、服务端 403 兜底）。

### 2.7 双端只存 `deletedAt`，`expired` 每次读时重算

`TrashItem.expired` 是**派生字段**，不在 localStorage / SharedPreferences 里缓存：
缓存它等于把一个「随时间变化的判断」冻在写入那一刻，第 90 天不会自己变红。

边界口径（两端同款，用例钉死）：`now - deletedAt >= 90 天` 即过期 ——
第 89 天仍可恢复（`还能恢复 1 天`），第 90 天起 `已过保留期`。

### 2.8 回收站读失败**绝不清空列表**

空列表在这个界面上等于「已经全部彻底删除」。所以：读失败只置 `trashError`，
保留已有条目并显示失败横幅。

小程序这里有个容易写错的判据：分支必须看 `readApi !== null`，**不能**看 `usingPreview`。
`usingPreview` 会被「首页读失败」连带翻成 true —— 那会让回收站从服务端快照
悄悄退化成本地镜像，看起来一切正常、实际少了一半条目。用例 `run-w5f.mjs`
的「首页失败但回收站仍走服务端」就是钉这个。

### 2.9 未知 `kind` 一律**响亮失败**，绝不静默跳过

- 服务端：`:kind` 只接受 `point_rule` / `wish` / `habit`，其它值 ⇒ **400**
  `TRASH_KIND_INVALID`（不是 404：说明客户端把地址拼错了，不能回答「这条已经没了」）。
- 小程序读：`mapTrash()` 遇到未知 `kind` 抛 `malformed`。**跳过一行是更坏的选择** ——
  少一行在这个界面上意味着「它被彻底删除了」。
- 客户端写：`restoreTrashItem()` / `purgeTrashItem()` 先过白名单，未知名**不发请求**。

### 2.10 回包必须验明正身：`{kind,id}` 要与请求一致

恢复 / 彻底删除的回包只有 `{kind, id}`。客户端拿它比对请求的 `{kind,id}`，
不一致就按 `malformed` 处理（`TrashTargetDto`）—— 否则一次错位的回包会让界面
把「另一个条目」标成已恢复。请求侧也没有 body、不带 `Content-Type`（同 W5-A 的 DELETE）。

### 2.11 批量「清理过期」逐条调，结果说真话

`TrashPurgeOutcome { purged, failed, error }`：第 3 条失败时前 2 条已经真的删了。
只说「失败」会让家长以为一条都没清，只说「成功」是撒谎 —— 所以分别报数，
`error` 取第一条可读原因，界面文案由 `trashPurgeOutcomeText()`（小程序）/
`TrashPurgeOutcome` 的展示串统一生成。

### 2.12 删除成功后先改本地镜像，再刷新

`submitRemoveHabit()`：`DELETE` 200 → 本地把那条置 `deleted` + 本地时间 `deletedAt`
→ 才 `refreshFromServer()`。这样即使随后的刷新失败，首页也不会留一条
「已删却还在」的习惯；刷新成功则以服务端 `deletedAt` 为准。

## 3. 本轮真踩过的坑

1. **小程序的回收站判据写成 `usingPreview` 就错了**。那个标志的含义是
   「首页还没成功拉过一次」—— 首页读失败会把它留成 `true`。若回收站据此退回本地镜像，
   界面看起来一切正常，实际少了服务端已删的条目。判据只认 `readApi !== null`；
   用例 `run-w5f.mjs`「首页读失败不影响回收站」钉死这一点。
2. **旧用例先失败，是它在提醒我们改了语义**。`run-w5a.mjs` 原来断言
   「live 模式回收站来自本地列表」，这是 W5-F 之前的事实。现在服务端 `/trash` 才是权威，
   断言改成「本地镜像里有 deleted 行，但回收站仍是 0 条」—— 删掉断言或放宽它，
   就等于把这条语义悄悄丢了。
3. **`mapTrash` 遇到未知 `kind` 不能 `continue`**。跳过一行在这个界面上等于
   「它已经被彻底删除了」——比报错更误导。抛 `malformed`，让整次读取失败。
4. **彻底删除的审计必须写在 `delete()` 之前**：删完再写就拿不到 `before` 快照
   （`targetId` 也还在，但「删的是什么」只剩 id）。`after` 必须是 `Prisma.JsonNull`，
   写成 `null` 会被 Prisma 当成「这个字段不写」，审计里就缺了「删掉」这个事实。
5. **`PointRuleVersion.ruleId` 是 `onDelete: Restrict`**：不先 `deleteMany` 版本行，
   `pointRule.delete()` 直接 P2014（变成 500）—— 顺序是「审计 → 版本行 → 主体」。
6. **跨孩子一律按 404**：恢复 / 彻底删除都用 `findFirst { id, childId }`。
   只按 id 查会把别人家的东西恢复进自己家（且「不是我的」与「不存在」对外应该是同一个答案）。
7. **恢复与彻底删除都要先 `lockChildBalance()`**：`count(流水)` 与 `delete` 之间
   若插进一笔新打卡，就会出现「数的时候 0 条、删的瞬间来了一条」的孤儿引用。
8. **小程序弹层是同步单例 store**：`TrashSheet` 改成异步后如果还 `import { store }`，
   请求回来界面不会重渲染。必须 `useStore()` + 打开时 `useEffect` 刷新
   （与审批收件箱同写法）。
9. **一次大段替换把 `mapTrash` 写重复了**（还把相邻的 `mapWish` 注释切坏）。
   `tsc` 报重复声明才停下来 —— 教训：大文件不要整段替换，改完 `git diff` 复查。

## 4. 证据（本阶段新增用例）

### 4.1 后端 `test/trash-http.test.ts`（3 组 / 16 条）

| 组 | 钉住的事 |
|---|---|
| A：默认装配（端口未注入） | 三条路由全 **501** —— 空列表会被误读成「删掉的东西已经不在了」，宁可明确失败 |
| B：看得到 ≠ 改得动 | 缺身份 401、无成员位 403（屏障一）、孩子 `GET /trash` **200**、孩子恢复 / 彻底删除 **403** 且端口零调用 |
| C：家长路径与响应形状 | `{items:[{kind,id,title,deletedAt}]}` 且 `deletedAt` 是 ISO 串；`childId` 只来自会话（带 `?childId=` 也不影响）；恢复 / 彻底删除 200 `{kind,id}` 且端口收到家长身份；未知 `kind` ⇒ **400** `TRASH_KIND_INVALID`；端口 404 / 409（`TRASH_ITEM_REFERENCED` / `TRASH_PARENT_RULE_DELETED`）原样映射（不翻成 500） |

### 4.2 Flutter（本阶段新增 17 条，`flutter test` 合计 149）

- `test/write_api_test.dart`
  - 组「习惯删除 + 回收站写端点（W5-F）」：`DELETE /habits/:id` 无请求体、回包 `habitId` 必须一致
    （不一致 ⇒ `malformed`）；恢复路径 `POST /trash/:kind/:id/restore`、彻底删除 `DELETE /trash/:kind/:id`；
    未知 `kind` 在发请求前就失败。
  - 组「回收站 store（W5-F）」：恢复 / 彻底删除 / 清理过期；**清理过期逐条调，部分失败如实报**
    `purged` / `failed`；没有写客户端时只读且一条请求都不发；live 我的页显示服务端条目、点「恢复」真的发 POST；
    **拉取失败：显示失败横幅且不清空已有列表**。
- `test/app_test.dart`（预览模式）：`trashItems()` 汇总三类、标题不做二次加工、`isTrashExpired` 的 null / 89 / 90 / 91 边界。
- `test/read_api_test.dart`：`fetchTrash()` 的线格式与 `mapTrash`（未知 `kind` ⇒ `malformed`）。

### 4.3 小程序 `.tmp_test/run-w5f.mjs`（19 条）

类型 / 映射 / DTO / 客户端 8 条：

- `trashKindFromWire` 只认三个线值；`isTrashExpired` 的「满 90 天」边界；`trashPurgeOutcomeText` 区分「清掉几条 / 没清掉几条」；
- `mapTrash` 未知 kind ⇒ `malformed`（不跳过）；`expired` 由 `deletedAt` 现算（不信服务端字段）；
- `TrashTargetDto` 回包 `kind` / `id` 与请求不一致 ⇒ `malformed`；
- `deleteHabit` 带幂等键、回包 `habitId` 不符 ⇒ `malformed`；
- 恢复 / 彻底删除路径正确，未知 kind 本地就拒（零请求）。

store 11 条：

- `refreshTrash` 拉服务端条目 ⇒ `ready`，且**不顺带重拉首页**；
- 首页读失败（`usingPreview === true`）时回收站仍用服务端结果；
- 读失败**保留**上一次列表（清空 = 假装已彻底删掉）；
- 删除习惯：`DELETE /habits/:id`＋幂等键，软删后首页不再列出，**刷新失败也如此**；
- live 但没写客户端 ⇒ 只读文案，习惯不动；
- 恢复成功 ⇒ 首页与回收站都刷新；恢复被拒 ⇒ 原样返回服务端原因、列表不动；
- 彻底删除成功 ⇒ 本地立刻少一条；
- 清理过期逐条调、部分失败如实报；没有过期条目 ⇒ 零请求；
- 预览模式仍来自本地列表，恢复 / 彻底删除照旧可用。

## 5. 仍未落地（不粉饰）

- **90 天到期不会自动清理**：只是「判定 + 家长点一下」。「到期自动清」需要后台任务
  （`expireDue()` 那种）＋ 明确的保留策略，本轮**没有**做，也不打算偷偷做。
- **没有真库并发对照**：`lockChildBalance()` 之后的 `count` → `delete` 只有端口替身用例，
  真库并发（恢复与打卡同时发生）未验证。
- **回收站不分页**：三类各一查、合并排序后全量下发。单孩子条目量小，
  但没有上限保护；条目数上百时需要加 `limit`（会牵动客户端「清理过期」的遍历）。
- **孩子端只读是「客户端先拦 + 服务端 403」**：孩子界面能看到恢复 / 彻底删除按钮，
  点了得到只读文案。没有按角色隐藏按钮（矩阵本来就是运行时可变的，写死隐藏更危险）。
- **撤销删除（undo）没有**：只有「去回收站恢复」这一条路。
- **入口条数要打开过一次才准**：live 模式下「回收站（N）」的 N 来自 `GET /trash`，
  而回收站只在**打开弹层时**才拉（与 Flutter 同构）—— 没打开过时显示「回收站」不带数字。
  刻意不为一个低频入口给首页多加一次往返；若以后要实时角标，需要一个「变更即推送」的机制，
  不是在这里偷偷预拉。
- **跨设备不同步**：删除 / 恢复只影响当前设备的快照，另一台要等下次拉取。
- **小程序 `confirm()` 依赖基础库**：批量「清理已过期」的二次确认用 `showModal`，
  老基础库无降级 UI（与 W5-E 的改名弹窗同一个已知限制）。

## 6. 复跑基线

```bash
# 后端
cd backend
npm run typecheck && npm run typecheck:tests && npm run build
npm test                                   # → 477/477（27 文件）
npm run contracts:emit                     # → 29 个动作（会重写 contracts/permission-matrix.json）

# Flutter
cd ..
flutter analyze                            # → 0 issue
flutter test                               # → 149/149

# 小程序（先现编 dist，再跑用例）
cd kids_points_mp
npx tsc -p tsconfig.json --noEmit           # → 0
npx tsc -p .tmp_test/tsconfig.test.json     # → 0
node .tmp_test/run.js                       # → ALL PASS（含 5 个子 runner）
node .tmp_test/run-w5f.mjs                  # → 19 条 ALL PASS
npm run build:weapp                         # → 0（仅 Sass @import 弃用告警）
```

（与 W4-E / W5-B 的「先落地再刷新」同一手法；W5-E 的「改名后不重拉」不冲突 ——
那里回包就是权威值，这里回包里没有余额和流水。）

