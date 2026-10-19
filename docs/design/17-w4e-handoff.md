# 阶段 W4-E 交接单 · 双端 live 打卡 / 撤销写入口

> **状态（2026-10-19）**
>
> | 验证 | 结果 |
> |---|---|
> | `flutter analyze` | ✅ 0 issue |
> | `flutter test` | ✅ **65/65**（W4-E 新增 14 条） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && node .tmp_test/run.js` | ✅ **48/48**（W4-E 新增 11 条，ESM 子进程） |
> | `cd backend && npm test` | ✅ **353/353**（本阶段未改后端） |
> | `cd backend && npm run ci` | ✅ **CI_EXIT=0**（含诚实性探针 / 闸门 / 证伪套件 / build） |
> | 新增迁移 | ✅ **无** |
>
> **给**：接手下一步（习惯 CRUD / 心愿兑换 / 规则编辑 / 邀请）的下一个会话。

## 1. 本阶段做了什么

W4-D 已经有了两条真写入口，但双端仍在 UI 层把所有写操作拦成「只读」。
W4-E 只放开**这两条**：

| 动作 | 入口 | live 模式 | 预览模式 |
|---|---|---|---|
| 打卡 | 首页点习惯 | `POST /records/check-in` | 原本地 `checkIn()` |
| 撤销 | 首页长按习惯 | `POST /records/:id/reverse` | 原本地 `undoCheckIn()` |
| 记一笔 / 心愿 / 规则 / 档案 | 其余页面 | **仍拦截** | 原本地行为 |

对应客户端：

- Flutter：`lib/data/write_api.dart`、`write_api_errors.dart`、`write_dto.dart`
- 小程序：`kids_points_mp/src/data/write_api.ts`、`write_api_errors.ts`、`write_dto.ts`
- Store：`AppStore.submitCheckIn()` / `submitUndoCheckIn()`（双端同构）
- UI：首页不再在 live 模式直接 toast 只读；改为 `await` 写入口并按结果提示

## 2. 关键实现决策

### 2.1 写传输层独立，不改只读的 `ReadTransport`

只读传输层只有 `send(uri, headers)`，写请求需要 body / Content-Type，
且**不应该**被读路径的自动行为影响。新增 `WriteTransport`：

```text
send(uri, headers, body) -> { statusCode, body }
```

Flutter 默认 `IoWriteTransport`（`HttpClient.postUrl`），
小程序默认 `TaroWriteTransport`（`Taro.request({ method: 'POST' })`）。
因此只读路径一行未改，W4-B / W4-C 的回归不受影响。

### 2.2 live 但没写客户端 ⇒ **拒绝写**，不是退回本地写

`isCheckInReadOnly = isLiveMode && writeApi == null`。

live 模式只注入了只读客户端时，`submitCheckIn()` 返回
「只读模式：打卡写入还没有接上后端」，**不改内存**。
否则会出现「界面上加了 1 分、服务器没有任何流水」的假成功。

### 2.3 写成功后先落地返回流水，再刷新快照

顺序是：

1. 解析 201 `{ record, executedRecordId }`；
2. `applyWrittenRecord()` 把该行映射进当前列表，余额取 `record.balanceAfter`；
3. `refreshFromServer()` 用服务端快照校正余额 / 好习惯次数 / 流水页。

这样即使第 3 步读失败，**写入已经成功**的事实仍显示在界面上，
不会被误报成「打卡失败」。读失败由全局横条单独说明。

### 2.4 `executedRecordId` 必须等于 `record.id`

撤销时 `record` 是**冲正记录**，`executedRecordId` 也必须是这条冲正记录。
二者不一致说明服务端契约漂移；DTO 直接抛 `malformed`，
不允许拿一个无法对账的 id 去更新界面。

### 2.5 双击串行 + 每次动作一个幂等键

- `_writeInFlight` / `writeInFlight`：第一次请求结束前，第二次直接返回
  「上一次操作正在保存中」；
- 每次用户点击生成一个 `Idempotency-Key`（`checkin-*` / `reverse-*`），
  自动重试不会变成两笔；
- 后端语义保持不变：**无 key 的两次点击就是两笔**，客户端不替产品做决定。

### 2.6 撤销目标可能不在当前记录页

记录页可能被分类过滤（例如停在「调整」）或只加载了 50 条。
`submitUndoCheckIn()` 先在已加载列表里找「今天、未冲正」的记录；
找不到时再单独请求一页**不分类**的流水（200 条）定位 —— 冲正记录是 `adjust`，
只看 `praise` 会把已撤销的原记录误判为可撤销。该请求**不修改**当前记录页。

### 2.7 错误映射按**业务码**优先

409 不是「HTTP 409」四个字：

| 业务码 | 文案 |
|---|---|
| `HABIT_DAILY_LIMIT_REACHED` | 这个习惯今天的次数已经用完啦 |
| `INSUFFICIENT_POINTS` | 积分不足，无法撤销这笔打卡 |
| `ALREADY_REVERSED` | 这笔打卡已经撤销过了 |
| `NOT_A_HABIT_CHECK_IN` / `CANNOT_REVERSE_REVERSAL` | 这笔记录不是可撤销的打卡记录 |
| `HABIT_NOT_FOUND` / `RECORD_NOT_FOUND` | 分别提示习惯 / 打卡记录不存在 |

404 不再复用只读的「孩子档案不存在」文案。
`isRetryable` 只对网络 / 超时 / 5xx 为 true；409 原样重试只会再被拒一次。

### 2.8 `isReadOnly` 仍然为 true

它现在表示「**其它**写入口仍只读」，不是「所有写都不可用」。
首页不再看它；记一笔 / 心愿 / 规则 / 档案继续用它拦截。
新增 `usesServerWrites` 给横条判断文案。

## 3. 文件清单

| 层 | Flutter | 小程序 |
|---|---|---|
| 写客户端 | `lib/data/write_api.dart` | `src/data/write_api.ts` |
| 错误 | `lib/data/write_api_errors.dart` | `src/data/write_api_errors.ts` |
| 响应 DTO | `lib/data/write_dto.dart` | `src/data/write_dto.ts` |
| Store | `lib/data/app_store.dart` | `src/data/store.ts` |
| 首页 | `lib/screens/home_screen.dart` | `src/pages/home/index.tsx` |
| 状态横条 | `lib/widgets/read_status_banner.dart` | `src/components/ReadStatusBanner/index.tsx` |
| 注入 | `lib/main.dart` | `store` 构造函数默认按环境构造 |
| 映射复用 | `read_mapper.dart` 公开 `mapRecord` | `read_mapper.ts` 公开 `mapRecord` |

## 4. 新增测试

- `test/write_api_test.dart`（14 条）：请求形状、409 / 404 文案、
  201 DTO 一致性、store 成功 / 失败 / 双击 / 撤销 / 无写客户端、live 首页真实调用。
- `kids_points_mp/.tmp_test/run-w4e.mjs`（11 条）：与 Flutter 同口径的 ESM 用例。
- `run.js` 在 W4-C 子进程之后再 `spawnSync` W4-E 子进程；
  汇总与退出码仍在顶层，D12 守卫可静态检查。

## 5. 复跑

```bash
# Flutter
flutter analyze
flutter test

# 小程序
cd kids_points_mp
npx tsc --noEmit -p tsconfig.json
npx tsc src/data/store.ts src/data/seed.ts src/data/types.ts src/utils/color.ts \
  --outDir .tmp_test/dist --module commonjs --target es2017 \
  --strictNullChecks --esModuleInterop --skipLibCheck
node .tmp_test/run.js          # 48/48

# 后端（本阶段未改，仍应保持绿）
cd ../backend
npm test                       # 353/353
```

## 6. 仍未落地

| 项 | 状态 |
|---|---|
| 习惯 CRUD / `addHabitFromRule` | ❌ 未建 |
| 心愿兑换 / 规则编辑 / 邀请 | ❌ 未建 |
| 记一笔 / 档案编辑 | ❌ 仍只读拦截 |
| 批量撤销 / 撤销审批 | ❌ 不做 |
| 真机联调 / 高并发压测 | ❌ 未做 |
| 新增迁移 | ✅ 无 |

## 7. 签字

- 双端写客户端、DTO、错误映射、Store 异步写入口、首页 UI 与横条文案
- 测试：`test/write_api_test.dart`、`kids_points_mp/.tmp_test/run-w4e.mjs`、
  `run.js` 子进程接线
- 本阶段未改后端、未新增迁移、未放宽任何闸门
