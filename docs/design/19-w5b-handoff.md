# 阶段 W5-B 交接单 · 记一笔写端点（`POST /records/adjust`）＋双端接线

> **⚠️ 已被 [`20-w5c-handoff.md`](./20-w5c-handoff.md) 接续**（2026-10-20）：本单的「记一笔」结论仍然有效，
> 但其中的**基线数字已过期**（后端 404 → 434、`test:db` 136 → 137、Flutter 83 → 102、小程序 72 → 90），
> 心愿兑换也已在 W5-C 接通（`POST /approvals`）。复跑请看 20 号单的 §6。

> **状态（2026-10-20）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm test` | ✅ **404/404**（23 个用例文件；`test/records-http.test.ts` 22 条） |
> | `cd backend && npm run test:db` | ✅ **136/136**（9 个用例文件；`test-db/records-db.dbtest.ts` 9 条） |
> | `cd backend && npm run ci` | ✅ **CI_EXIT=0**（含闸门 / 证伪 / build / 契约导出） |
> | `flutter analyze` | ✅ 0 issue |
> | `flutter test` | ✅ **83/83**（W5-B 新增 6 条 store 用例） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && node .tmp_test/run.js` | ✅ **72/72**（W5-B 新增 12 条，ESM 子进程） |
> | 新增迁移 | ✅ **无**（`adjust` 复用 `PointRecord` + `IdempotencyKey` 既有表） |
>
> **给**：接手下一步（心愿兑换 / 习惯 CRUD / 档案 / 邀请 / 加分申请）的下一个会话。

## 1. 本阶段做了什么

「记一笔」从**只读拦截**变成真写，双端同构：

| 动作 | 入口 | live 模式 | 预览模式 |
|---|---|---|---|
| 记一笔（加分 / 扣分） | 首页「记一笔」弹层 | `POST /records/adjust` | 原本地 `addQuickNote()` |
| 打卡 / 撤销 | 首页习惯卡片 | 已由 W4-E 接通 | 原本地行为 |
| 规则四条写入口 | 规则页 | 已由 W5-A 接通 | 原本地行为 |
| 心愿兑换 / 档案 / 邀请 | 其余页面 | **仍拦截** | 原本地行为 |

后端：

- `backend/src/records/dto/adjust-record.dto.ts` —— 请求体**集合封闭**：
  `title`（1–120，纯空白拒）+ `points`（`-999..-1` / `1..999`，`@NotEquals(0)`）+ 可选 `note`（≤200）。
  多传 `childId` / `source` / `operatorRole` / `balanceAfter` 一律 400。
- `backend/src/records/records.controller.ts` —— `POST /records/adjust`，`201`，三道屏障
  （设备会话 → 成员 → 权限矩阵 `adjust_points`：guardian ALLOW / child DENY），
  接 `Idempotency-Key`；回包 `{ record, executedRecordId }`，`record` 与 `GET /records` 的行同构。
- `backend/src/records/records.service.ts` / `records.repository.ts` / `records.prisma.repository.ts`
  —— 走与打卡同一个账本内核（锁内余额、库钟、余额 CAS、审计），落一条 `category='adjust'` 的流水。
- `backend/src/app.module.ts` / `src/ledger/ledger.append.ts` / `src/read/read.mapper.ts`
  —— DI 装配、`adjust` 的草稿来源、`WrittenRecordResponse` 映射。
- 用例：`backend/test/records-http.test.ts`（离线 HTTP，端口替身）、
  `backend/test-db/records-db.dbtest.ts`（真库 × 真 HTTP，分组 A–E）。

客户端：

- Flutter：`lib/data/write_api.dart`（`WriteApi.adjust()` + `WriteApiClient.adjust()`）、
  `lib/data/write_api_errors.dart`、`lib/data/app_store.dart`（`submitQuickNote()`）、
  `lib/screens/sheets/quick_note_sheet.dart`（异步 + `saving`）。
- 小程序：`kids_points_mp/src/data/write_api.ts`、`write_api_errors.ts`、
  `src/data/store.ts`（`submitQuickNote()`）、`src/sheets/QuickNoteSheet.tsx`（异步 + `saving`）。

## 2. 关键实现决策

### 2.1 余额由服务端在锁内决定，客户端不再「先看一眼 points」

「够不够扣」只有服务端知道（另一位家长可能刚扣过）。客户端**不做** `points + delta < 0` 的预判，
直接把带符号分值发出去，由服务端在行锁内算 `balanceAfter`；不足则 409 `INSUFFICIENT_POINTS`，
两端把它翻成「积分不足：这次操作会把余额扣成负数，没有保存。」—— 用本地缓存判断会同时漏掉
「其实够」和「其实不够」两种误判。

### 2.2 live 模式不预置本地流水，`id` / `balanceAfter` 只认回包

写成功后 `applyWrittenRecord(result.record)` 落地回包，再 `refreshFromServer()` 校正；
**不**先在本地造一条再等服务端返回 id —— 否则刷新一拉就会出现两条同内容的流水（一条本地 id、
一条服务端 id）。预览模式仍走本地 `addQuickNote()`，返回值语义一致（成功 `null`，失败文案）。

### 2.3 0 分是无效动作，三层都拒

流水无法解释「+0」：表单 `PointsStepper(min: 1)` 不允许出现 0；`WriteApiClient.adjust()` 与
两端的 `submitQuickNote()` 在本地直接返回/抛出；服务端 DTO `@NotEquals(0)` 兜底 400。
三层的**理由不同**（交互 / 省一次往返 / 契约），所以三层都要有。

### 2.4 空事由有默认文案，但默认文案属于 store 不属于弹层

`submitQuickNote()` 在 `reason.trim() === ''` 时取 `额外奖励` / `扣除积分`（与本地
`addQuickNote()` 同一口径）；弹层的默认是 `额外调整`（两处都空时）。标题是**流水唯一解释**，
所以默认值必须落在数据层，不能靠某个页面的局部变量。

### 2.5 孩子不能记账：403 是产品语义，不是缺陷

权限矩阵里 `adjust_points` 对 child 是 DENY。孩子想加分必须走 `request_points_bonus`
审批（`02` §6 的归一化），否则「孩子给自己加分」就是一个后门。客户端**没有**儿童端入口。

### 2.6 幂等键前缀 `adjust-`，双击靠 `writeInFlight` 串行

每次用户动作生成 `adjust-<ts>-<seq>`；`writeInFlight` 为真时第二次直接返回
「上一次操作正在保存中，请稍候…」，不发第二个请求。弹层按钮同时进入 `saving`（`保存中…`）
且失败**不关**弹层 —— 家长要能改数字重试，而不是重填一遍。

## 3. 本阶段踩到的坑

| # | 坑 | 处理 |
|---|---|---|
| 1 | 小程序运行时用例跑的是 `.tmp_test/dist` 里的**旧编译产物**，新方法根本不存在 | 必须现编：`npx tsc src/data/store.ts --outDir .tmp_test/dist --module commonjs --target es2017 --strictNullChecks --esModuleInterop --skipLibCheck --jsx react-jsx --resolveJsonModule`（`src/data/store.ts` 会带出全部依赖）；用 `-p tsconfig.json` 会把 `config/` 一起编且落错目录（`TS6059`） |
| 2 | 测试替身的「服务端快照」写成常量，`before` 直接拿到写入后的余额（11 ≠ 16），用例误红 | 快照必须**可变**：`adjust` 里改 `serverPoints`，`fetchHome` / `fetchRecords` 读它；否则「刷新」这一步根本没被验证 |
| 3 | 两处默认文案混淆：弹层空输入是「额外调整」，store 空 `reason` 是「额外奖励 / 扣除积分」 | 分别写明职责：弹层负责交互默认值，数据层负责「流水标题必须能解释这一笔」 |
| 4 | `INSUFFICIENT_POINTS` 原本文案绑死在打卡语义上，记一笔复用后读起来像在说打卡 | 两端 `write_api_errors` 改成通用句「这次操作会把余额扣成负数」，三个入口共用同一句 |

## 4. 证据（本阶段新增用例）

**后端真库 `test-db/records-db.dbtest.ts`（9 条）**

| 组 | 用例 | 钉住的行为 |
|---|---|---|
| A | DI 装配 | `RecordsService` / 仓库 provider 真的进容器（不是测试里手搓的） |
| B | 加分 / 扣分 201 | 流水 `category='adjust'`、`points` 带符号、`balanceAfter` = 锁内余额、审计一条、余额同步 |
| C | 余额不足 409 | `INSUFFICIENT_POINTS`，**零副作用**（无流水、无审计、余额不动） |
| D | 幂等键 | 重放返回首次响应、只有一条流水；换 key 同内容 ⇒ 两笔（产品语义） |
| E | 403 / 404 | 孩子记账 403；已删孩子 404 `CHILD_NOT_FOUND` |

**离线 HTTP `test/records-http.test.ts`（22 条）**：三道屏障顺序、请求体封闭（多传字段 400）、
`points=0` / 纯空白标题 400、超界 400、幂等头与响应状态码。

**Flutter `test/write_api_test.dart`（新增 6 条）**

| 用例 | 钉住的行为 |
|---|---|
| live 走 `POST /records/adjust` | 标题去空白、分值带符号、幂等键以 `adjust-` 开头、余额与流水来自服务端快照 |
| 空事由默认文案 | 扣分发 `-3`（客户端不取反），标题 `扣除积分` |
| 409 积分不足 | 返回可读原因，本地余额与流水都不动 |
| live 无写客户端 | 返回「只读模式…」，不改内存 |
| 0 分 | 本地就拒，一次请求都不发 |
| 预览模式 | 仍走本地 `addQuickNote()`，返回值语义不变 |

**小程序 `run-w5b.mjs`（12 条）**：客户端的路径 / 方法 / body 形状（空 `note` 不发字段）/
本地拒绝 / 缺 `balanceAfter` ⇒ `malformed` / 409 文案，以及 store 的「余额取服务端快照」
「空事由默认文案」「409 无副作用」「保存中串行」「无写客户端只提示」「0 分不发请求」
「预览模式不变」。

## 5. 仍未落地（不粉饰）

- 心愿兑换（`exchange`）、`request_points_bonus` 审批入口、习惯 CRUD、孩子档案、邀请 —— 写端点未建，双端仍只读拦截。
- 孩子端没有「申请加分」的 UI，403 只在后端用例里被验证。
- 未做真机联调，未做并发压测；幂等并发重放只由后端真库用例覆盖。
- `adjust` 不写 `ruleId` / `habitId`（它本来就不属于任何规则），历史口径与 PRD 数据模型一致，但 UI 上**没有**区分展示。
- **文档待同步**：`docs/PRD.md` FR-03 的验收标准写的是 `400 INSUFFICIENT_POINTS`，
  实现是 **409**（与打卡每日上限、规则版本冲突同族：业务拒绝归 409，形状错误才 400）。
  客户端按 `statusCode=409 + code=INSUFFICIENT_POINTS` 分流，代码不改；PRD 那句话应改。

## 6. 复跑基线

```bash
# 后端
cd backend
npm run typecheck && npm run typecheck:tests
npm test                 # 404/404
npm run test:db          # 136/136（需要真库）
npm run ci               # CI_EXIT=0（闸门 + 证伪 + build + 契约导出）

# Flutter
flutter analyze          # 0 issue
flutter test             # 83/83

# 小程序（先现编 dist，再跑用例）
cd kids_points_mp
npx tsc --noEmit         # 0
npx tsc src/data/store.ts --outDir .tmp_test/dist --module commonjs \
  --target es2017 --strictNullChecks --esModuleInterop --skipLibCheck \
  --jsx react-jsx --resolveJsonModule
node .tmp_test/run.js    # 72/72（run-w5b.mjs 12 条）
```
