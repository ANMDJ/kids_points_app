# 阶段 W5-A 交接单 · 规则写端点（新建 / 编辑 / 软删 / 加入习惯）＋双端接线

> **状态（2026-10-20）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm test` | ✅ **382/382**（22 个用例文件） |
> | `cd backend && npm run test:db` | ✅ **127/127**（8 个用例文件，真库） |
> | `cd backend && npm run ci` | ✅ **CI_EXIT=0**（含闸门 / 证伪 / build / 契约导出） |
> | `flutter analyze` | ✅ 0 issue |
> | `flutter test` | ✅ **75/75**（W5-A 新增规则写端点用例） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && node .tmp_test/run.js` | ✅ **60/60**（W5-A 新增 12 条，ESM 子进程） |
> | 新增迁移 | ✅ **无** |
>
> **给**：接手下一步（记一笔 / 心愿 / 习惯 CRUD / 档案 / 邀请）的下一个会话。

## 1. 本阶段做了什么

后端 W5-A 补齐四条规则写端点，双端把「规则」从**只读拦截**改成真写：

| 动作 | 入口 | live 模式 | 预览模式 |
|---|---|---|---|
| 新建规则 | 规则页「新增规则」 | `POST /point-rules` | 原本地 `addRule()` |
| 编辑规则 | 规则页编辑 | `PATCH /point-rules/:id` + `expectedVersion` | 原本地 `updateRule()` |
| 删除规则 | 规则页删除 | `DELETE /point-rules/:id`（软删进回收站） | 原本地 `removeRule()` |
| 加入习惯 | 规则页「加入今天」 | `POST /point-rules/:id/habits` | 原本地 `addHabitFromRule()` |
| 记一笔 / 心愿 / 档案 / 邀请 | 其余页面 | **仍拦截** | 原本地行为 |

后端：

- `backend/src/rules/rules.controller.ts` —— 四条路由，三道屏障（设备会话 → 成员 → 权限），
  孩子 `403`；四个入口都支持 `Idempotency-Key`，双击「保存 / 删除」不会产生两个版本或两条审计。
- `backend/src/rules/rules.service.ts` / `rules.repository.ts` / `rules.prisma.repository.ts`
  —— 建规则在**一个事务**里写规则 + 第 1 版版本行 + 审计；编辑校验 `expectedVersion`、
  写新版本行与审计；删除只改状态位（版本行 / 历史流水保留）；按规则加习惯按 `sourceRuleId` 判重。
- `backend/test/rules-http.test.ts`（离线 HTTP）与 `backend/test-db/rules-db.dbtest.ts`（真库）。

客户端：

- Flutter：`lib/data/write_api.dart`（`createRule` / `updateRule` / `deleteRule` / `addHabitFromRule`）、
  `write_api_errors.dart`、`lib/data/read_mapper.dart`（`mapRule` / `mapHabit` 公开给写回包复用）。
- 小程序：`kids_points_mp/src/data/write_api.ts`、`write_api_errors.ts`、`read_mapper.ts`。
- Store：`AppStore.submitAddRule()` / `submitUpdateRule()` / `submitRemoveRule()` /
  `submitAddHabitFromRule()`（双端同构）。
- UI：双端「新增 / 编辑规则」「加入今天」「删除」都改成 `await` 写入口并按返回文案提示；
  只读判定改用 `isRuleWriteReadOnly`（不再复用打卡的 `isCheckInReadOnly`）。

## 2. 关键实现决策

### 2.1 写传输层加 `method`，DELETE 不带请求体

`WriteTransport.send(uri, headers, body, timeoutMs, method)`：`body` 允许 `null`，
`Content-Type` **只在有请求体时**声明 —— DELETE 带一个空 JSON 会被严格后端拒掉。
`Taro.request` 的方法联合类型没有导出，用
`method as Parameters<typeof request>[0]['method']` 收窄，而不是 `as any` 把整条请求的类型安全丢掉。

### 2.2 乐观锁：`expectedVersion` 取「界面上看到的版本」

`submitUpdateRule()` 传 `expectedVersion: rule.currentVersion`。版本不一致 ⇒ 服务端 409
`RULE_VERSION_CONFLICT` ⇒ 客户端**保留原版本、保留原内容、显示「刚被其他人改动过，请刷新」**，
绝不静默覆盖另一位家长刚做的修改。写成功后以**服务端回包的 `currentVersion`** 为准，
不自己 `+1` 算版本（客户端算出来的版本号不是事实）。

### 2.3 分值带符号：客户端原样发，不在两端各取反一次

`points` 负 = 扣分。客户端把带符号分值**原样**放进 body；服务端落库时拆成
「正数分值 + `direction`」，回包仍是带符号分值。任一端多做一次取反，扣分就会静默变加分。

### 2.4 DELETE 的回包必须验明正身

`DELETE` 回 `{ ruleId }`。客户端拿到后**校验等于自己删的那条**；不一致按
`WriteApiException.malformed` 显式失败 —— 否则「删了别人/没删掉」都会显示成功。

### 2.5 写回包与 `GET /home` 共用同一套映射

`mapRule()` / `mapHabit()` 从 `mapHome()` 里抽出来，`GET` 与写回包走**同一个** DTO → UI 模型路径；
映射异常统一归一成 `WriteApiException.malformed`（读取层的 `ReadApiException` 也在此转一次），
页面只需要处理一种错误类型。

### 2.6 先落地、再刷新；删除先改本地镜像

写成功后先把回包落进列表，再 `refreshFromServer()` 校正；读失败不会被误报成写失败。
删除额外**先**把本地镜像标记 `deleted` 再刷新：即使刷新失败，也不会留一条
「已删却还在列表里」的规则（回收站条目按 90 天保留）。

### 2.7 live 但缺写客户端 ⇒ 拒绝，不本地假写

`isRuleWriteReadOnly = isLiveMode && writeApi == null`：live 模式没配齐写客户端时，
四个入口只返回提示文案，**不改内存**（不许出现「界面删掉了、服务端还在」）。

## 3. 本阶段踩到的坑

| # | 坑 | 处理 |
|---|---|---|
| 1 | `DELETE` 声明了 `Content-Type` 却无 body，被严格后端拒 | `body === null` 时不发 Content-Type；用例直接断言表头 |
| 2 | 编辑成功后本地 `currentVersion + 1`，与服务端实际版本分叉 | 版本只认回包；用例断言「回包 v5 就存 v5」 |
| 3 | 「加入习惯」后本地列表被刷新覆盖，用例误判为没加上 | 测试替身要模拟**服务端快照变化**（GET 也要返回新习惯），否则只考了本地缓存 |
| 4 | 缺陷闸门 E15 把证据钉在 `store.addRule(` 上，表单改走 `submitAddRule(` 后误红 | 闸门改为钉**参数形状** `store.(?:submit)?[aA]ddRule(trimmed, condition, dailyLimit,`，注释写明原因 |
## 4. 证据（本阶段新增用例）

**小程序 `run-w5a.mjs`（12 条，ESM 子进程）**

| 用例 | 钉住的行为 |
|---|---|
| 新建 POST | 方法 / 路径 / `points=-3` 原样 / 首尾去空白 / 身份头 / 幂等头 / timeout |
| 编辑 PATCH | 路径带 id、`expectedVersion` 原样、回包版本不回填 |
| 删除 DELETE | 无 body、无 `Content-Type`、`ruleId` 不一致 ⇒ malformed |
| 加入习惯 | POST `.../habits`、无 body、`ruleId` 落到模型 |
| 坏回包 | 缺 `currentVersion` ⇒ `malformed`（不把 `undefined` 塞进 UI） |
| 错误映射 | `RULE_VERSION_CONFLICT` / `RULE_NOT_FOUND` / `RULE_IS_PENALTY` / `HABIT_ALREADY_EXISTS` |
| store 新建 | 真发 POST + 回包与刷新后的服务端快照都进列表 |
| store 编辑 | `expectedVersion` 取界面版本；版本以回包为准 |
| store 冲突 | 409 后版本与标题都不变 |
| store 删除 | 真发 DELETE；刷新失败也先本地软删（回收站找得到） |
| store 加习惯 | 带 `ruleId`；扣分规则本地先拒、不发请求 |
| store 只读 | live 无写客户端时四个入口都只提示、不改内存 |

**Flutter `test/write_api_test.dart`**：同样覆盖四条端点的方法 / 路径 / 签名保留 /
乐观锁 / 删除回包校验 / 加入习惯，以及 store 层的「先落地再刷新」与 409 语义。

## 5. 仍未落地（不粉饰）

- 「记一笔」（`POST /records/adjust`）已于 **W5-B** 落地（见 [`19-w5b-handoff.md`](./19-w5b-handoff.md)）；
  心愿兑换、习惯 CRUD、孩子档案、邀请 —— 写端点未建，双端仍只读拦截。

- 规则写入口的**权限分支**（孩子 403 / viewer 403）只在后端用例里验证；客户端没有对应 UI 分支。
- 未做真机联调、未做高并发压测；`Idempotency-Key` 的并发重放只由后端真库用例覆盖。
- 规则编辑暂不允许改图标（沿用 C5 的遗留），编辑表单不收集 `icon`。

## 6. 复跑基线

```bash
# 后端
cd backend
npm run typecheck && npm run typecheck:tests
npm test                 # 382/382
npm run test:db          # 127/127（需要真库）
npm run ci               # 闸门 + 证伪 + build + 契约导出

# Flutter
flutter analyze          # 0 issue
flutter test             # 75/75

# 小程序
cd kids_points_mp
npx tsc --noEmit         # 0
node .tmp_test/run.js    # 60/60（run-w5a.mjs 12 条）
```
