# 阶段 W4-D 交接单 · 打卡与撤销写入（`POST /records/check-in` / `POST /records/:id/reverse`）

> ## ✅ 已收口（2026-10-19）
>
> | 闸门 | 结果 |
> |---|---|
> | `cd backend && npm run ci` | ✅ 退出码 **0**（`prisma:validate` → … → `contracts:emit`） |
> | `cd backend && npm test` | ✅ **21 文件 / 353 条全部通过**（含 W4-D 新增 4 个文件） |
> | `cd backend && npm run test:db` | ✅ **7 文件 / 109 条全部通过**（含 `habits-db.dbtest.ts` 16 条） |
> | `cd backend && npm run typecheck` / `typecheck:tests` / `typecheck:tools` | ✅ 退出码 **0** |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && node .tmp_test/run.js` | ✅ **37/37 ALL PASS**（W4-C 只读用例已拆到 `run-w4c.mjs`，见 §7.6） |
> | `flutter analyze` | ✅ **No issues found** |
> | `flutter test` | ✅ **51/51** |
>
> **给**：接手 W5（前端写入口 / 习惯 CRUD / 心愿 / 邀请）的下一个会话。
>
> **一句话状态**：有库时，`POST /records/check-in` 与 `POST /records/:id/reverse`
> 已真写库：同一事务内锁孩子余额 → 算业务日 → 验习惯/规则/上限 → 追加流水 →
> 改余额 → 写审计。撤销是 append-only 冲正，不 UPDATE 原行；无库仍是 **501**。
> 小程序 / Flutter 的 live 模式**仍拦写入口**（W4-C 口径），尚未接这两条写端点。

## 1. 这一步在补什么

W4-C 结束时，三端都能**读**服务端数据，但所有写操作仍只改本地内存：

```
读到的是真数据 ──> 打卡 / 撤销仍只在内存里"成功"
                └─> 刷新后消失（用户以为分已经加上了）
```

W4-D 把后端两条写入口补成真事务；**没有**顺手放开前端写入口 ——
把「后端能写」与「客户端该在什么时候写」分开验收，避免一半成功一半失败。

| 变化 | W4-C 后 | W4-D 后 |
|---|---|---|
| `POST /records/check-in` | 有库也 501（`HABITS_PERSISTENCE_NOT_IMPLEMENTED`） | 201，真写流水 / 余额 / 审计 |
| `POST /records/:id/reverse` | 有库也 501 | 201，追加负数冲正记录，原行不变 |
| 每日上限 | 只在派生展示里 | 写侧强制：按 `[业务日 start, end)` 数仍有效打卡 |
| 幂等 | 无 | `Idempotency-Key` 重放返回首次响应；无 key 双击 = 两笔 |
| 业务时区 | 无 | `KP_TIMEZONE`，默认 `Asia/Shanghai`；库钟 + 自算偏移 |
| 小程序 / Flutter 写入口 | live 只读拦截 | **仍只读拦截**（W5 才接） |

## 2. 路由与请求契约

| 方法 | 路径 | 动作（矩阵） | 成功 |
|---|---|---|---|
| `POST` | `/records/check-in` | `check_in_habit`（guardian / child ALLOW） | 201 `{ record, executedRecordId }` |
| `POST` | `/records/:id/reverse` | `undo_check_in`（guardian ALLOW / child DENY） | 201 `{ record, executedRecordId }` |

- 身份头：`X-KP-Device-Id` / `X-KP-Child-Id`。**`childId` 只来自会话**，
  DTO 里没有第二个孩子入口；多传 `childId` / `points` 等未知键 ⇒ 400。
- 打卡体：`{ "habitId": "..." }`（`1..64` 字符）。
- 撤销体：`{ "note"?: "..." }`（`≤200`；空串按「不写备注」处理）。
- 撤销的 `record` 是**新冲正行**：`pointsDelta = -原值`、`category = adjust`、
  `source = correction`、`reversesRecordId = 原记录 id`；原记录一字未改。
- `executedRecordId` 是本次真正写下的行（撤销时是冲正行），幂等层用它记录归属。

### 2.1 失败码（不会变形为 500）

| 状态 | `code` | 场景 |
|---|---|---|
| 400 | 全局校验 | 缺 / 空 `habitId`、超长 note、未知键 |
| 401 / 403 | 身份 / 成员 / 矩阵 | 三道屏障，端口零调用 |
| 404 | `HABIT_NOT_FOUND` | 习惯不存在、已删除、**跨孩子**（不泄露存在性） |
| 404 | `RECORD_NOT_FOUND` | 流水不存在 / 跨孩子 |
| 409 | `HABIT_DAILY_LIMIT_REACHED` | 本业务日仍有效打卡数 ≥ `dailyLimit`（附计数） |
| 409 | `HABIT_POINTS_INVALID` / `HABIT_RULE_*` | 分值为非正、规则消失、版本缺失、方向非 reward、分值与规则不一致 |
| 409 | `NOT_A_HABIT_CHECK_IN` | 撤销目标不是习惯打卡（兑换 / 调整 / 冲正行） |
| 409 | `ALREADY_REVERSED` / `RECORD_ALREADY_REVERSED` | 同一原记录第二次撤销（内核 / 库层唯一约束兜底） |
| 409 | `CANNOT_REVERSE_REVERSAL` / `INSUFFICIENT_POINTS` | 冲正的冲正；冲正后余额会为负 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一 key + **不同**请求体 |
| 500 | `HABIT_DAILY_LIMIT_INVALID` / `LEDGER_SHAPE_ERROR` | 数据/装配损坏，拒绝按猜测继续 |

## 3. 事务里发生什么（顺序有理由，不要重排）

`PrismaHabitsRepository.checkIn()` 的单个 `$transaction`：

1. `SELECT … FOR UPDATE` 锁住 `Child` 余额行 ⇒ 同一孩子的写入排队；
2. 读**库钟** `clock_timestamp()` ⇒ 求业务日；
3. 读 habit：`id + childId + status='active'` ⇒ 跨孩子/已删除一律 404；
4. 若 habit 来自规则：规则必须仍 `active`，版本行必须是 `currentVersion`，
   `direction='reward'` 且 `version.points === habit.points`；
5. 数「本业务日**仍有效**的打卡」：`category='praise'` + 特定 habit +
   排除冲正记录 + 排除「已被冲正」的原记录；
6. 内核 `buildRecordDraft()` 构造草稿（符号 / 快照 / `balanceAfter` 只在这里算）；
7. `appendDraftInTx()`：锁 + 库钟 + 余额 CAS + 严格递增 `createdAt`；
8. 同事务写 `AuditLog`（`point_record.check_in` / `point_record.undo_check_in`）。

任一步失败 ⇒ 全部回滚，不会留下「分加了但审计没有」或「上限过了但分没加」。

### 3.1 共用写入内核

`backend/src/ledger/ledger.append.ts` 的 `appendDraftInTx()` 是**唯一**写入通道：

- `SELECT … FOR UPDATE` 锁孩子行（审批执行器 / 手动调整也走同一段）；
- 读库钟并保证新 `createdAt` **严格晚于**该孩子已有的 `MAX(createdAt)`；
- 余额 CAS（`where pointsBalance = expectedBefore`），不匹配 ⇒ `LEDGER_BALANCE_CHANGED`；
- 写 `PointRecord` 的所有快照字段（调用方不直接拼 `data`）。

`PrismaLedgerRepository.append()` 也改为调用它，避免出现第二份「顺序 + CAS」实现。

## 4. 业务日与每日上限

- 时区：`KP_TIMEZONE`，默认 `Asia/Shanghai`；非法 IANA 名在**装配时**抛错
  （不是第一笔打卡时静默按 UTC）。
- 业务日由**数据库时钟**决定，不用进程 `new Date()`：窗口与 `createdAt` 必须同源。
- 返回 `[start, end)`，查询写成 `createdAt: { gte: start, lt: end }`：
  - `start - 1ms` 属昨天，不占今天名额；
  - `start` 属今天，占名额；
  - `end` 属明天，不占今天名额。
- 「撤销释放名额」是显式口径：被冲正的原记录不再计数（真库用例钉住
  「上限 2 的孩子撤掉一笔后可以再打一次」）。

## 5. 幂等与撤销（最容易踩的语义）

1. **无 `Idempotency-Key` ⇒ 双击就是两笔。** 这是产品语义，不是漏洞；
   不要在前端或服务层偷偷去重。
2. **同 key + 同请求体 ⇒ 返回首次响应**，不再次调用业务。
3. **同 key + 不同请求体 ⇒ 409 `IDEMPOTENCY_KEY_REUSED`**，不执行第二次。
4. **业务 409 不缓存**：修好上限/余额后用同一 key 重试是允许的。
5. **撤销的业务幂等键是 `undo:<原记录id>`**，由适配器补上；库层
   `(childId, idempotencyKey)` 唯一约束是并发双冲的最后一道闸。
6. 撤销**不删除、不 UPDATE 原行**（I5）：原记录仍在 `/records` 里，
   统计口径排除它，账本保留完整历史。

## 6. 代码落点

| 文件 | 职责 |
|---|---|
| `backend/src/habits/habits.controller.ts` | 两条路由；三道 Guard；用 `IdempotencyService.run()` 包住整个业务调用 |
| `backend/src/habits/habits.service.ts` | 会话 actor → `source`；DTO → 端口入参；`toRecordDto` 与 `GET /records` 同构 |
| `backend/src/habits/habits.repository.ts` | `HabitsPort` + 无库 `NotImplementedHabitsRepository`（两个方法都 501） |
| `backend/src/habits/habits.prisma.repository.ts` | 真事务：锁 / 业务日 / 习惯与规则 / 上限 / 草稿 / 追加 / 审计 |
| `backend/src/habits/habits.module.ts` | `register({ hasDatabase })` 按环境选实现；把同一 `hasDatabase` 传给身份/成员/幂等 |
| `backend/src/habits/business-day.ts` | `Intl` 自算时区偏移；`[start, end)`；DST 两次迭代 + 自检 |
| `backend/src/habits/dto/*.ts` | 封闭请求体（`habitId` / 可选 `note`） |
| `backend/src/ledger/ledger.append.ts` | 共用写入内核（锁 + 库钟 + 严格递增 + 余额 CAS） |
| `backend/src/ledger/ledger.prisma.repository.ts` | `append()` 改为复用同一内核 |
| `backend/src/app.module.ts` | `HabitsModule.register()` 接线 |

## 7. 真库 / 闸门抓到的坑（防复发）

### 7.1 `timestamptz` 直接写进 naive 列会整体 +8h

`PointRecord.createdAt` 是 `timestamp without time zone`，Prisma 的约定是
「列里的墙钟 = UTC」。`clock_timestamp()` 是 `timestamptz`，直接落库会被 PG
按会话时区转换（本机 `Asia/Shanghai`）⇒ 读回来是「8 小时后的未来流水」。
写入与夹具都必须 `AT TIME ZONE 'UTC'`。离线用例只看语义，抓不到这个；
真库用例组 A 钉着「偏离真实时间」。

### 7.2 夹具里的「明天 00:00」会把后续打卡全部推到明天

`appendDraftInTx()` 让新流水**严格晚于** `MAX(createdAt)`。若在 seed 阶段就插入
`end`（明天 00:00）的边界行，之后每一笔打卡都会落在 `end + 1ms`，
今天的上限永远数不到 —— 这是本套件第一版假红的真实原因。
现在只提前种 `start - 1ms` 与 `start`，`end` 留到组 D 最后
（`insertTomorrowBoundary()`）再插。

### 7.3 规则习惯的快照来自**版本行**，不是 habit 标题

habit 可以叫「番茄钟写作业」，但它由「完成作业」v1 产生；流水必须写
`titleSnapshot='完成作业'`、`conditionSnapshot='当天作业全部完成'`、`ruleVersion=1`，
否则 I4 的版本行核对会失败。分值也必须与版本行一致（不一致直接 409）。

### 7.4 撤销释放名额，不是「再打一次仍 409」

计数条件是「仍有效」：被冲正的原记录排除，冲正记录本身也排除。
真库用例同时钉住「撤销后可以再打一次」与「撤掉两笔后仍被上限拦住」。

### 7.5 业务 409 不能被幂等层缓存

`IdempotencyService.run()` 只缓存成功响应；业务失败必须让用户修正后重试。
真库 / HTTP 用例都用同一 key 验证了这一点。

### 7.6 W4-C 的异步运行器触发了 D12 守卫（本轮一并修复）

W4-C 把只读用例塞进 `run.js` 的 `async main()`，汇总与 `process.exitCode`
落在花括号内，`honesty:probe` 的 D12 守卫会报红（这是守卫的正确行为）。
现在：
- `run.js` 只跑同步用例，汇总/退出码保持在**顶层**；
- 只读异步用例拆到 `.tmp_test/run-w4c.mjs`（ESM 顶层 `await`），
  由 `run.js` 用 `spawnSync` 同步等待；子进程非 0 ⇒ 父进程计一次失败。
同时 E18 守卫的构造函数正则从「空参」放宽为「任意参数」，
因为 W4-C 起 `AppStore(readApi?)` 与 Flutter 的 `AppStore({readApi})` 同构；
守的仍是「构造即空态」。

## 8. 复跑

```bash
cd backend
npm run typecheck && npm run typecheck:tests && npm run typecheck:tools
npm test                 # 21 文件 / 353 条
npm run test:db          # 7 文件 / 109 条（需要 DATABASE_URL）
npm run ci               # 全闸门，退出码 0

cd ../kids_points_mp
npx tsc --noEmit
node .tmp_test/run.js    # 37/37

cd ..
flutter analyze
flutter test             # 51/51
```

- **`test:db` 缺 `DATABASE_URL`**：直接红，且明确说「一条都没验证」，不是跳过。
- **`NODE_ENV=production`**：真库套件硬拒绝（流水删不掉，不能拿生产库试）。
- **时区**：`KP_TIMEZONE` 非法会在启动时抛 `RangeError`；不要改成静默 UTC。

## 9. 仍未落地 / 已知边界

| 项 | 状态 |
|---|---|
| 小程序 / Flutter live 写入口 | ❌ 仍拦（W5 接这两条端点后才放开） |
| 习惯 CRUD / `addHabitFromRule` | ❌ 未建（本阶段只做打卡与撤销） |
| 心愿兑换 / 规则编辑 / 邀请 | ❌ 未建（兑换仍走既有审批链路，不走本模块） |
| 批量撤销 / 撤销审批 | ❌ 不做 |
| 冲刺上限的并发压测 | ❌ 只验证行锁 + 唯一约束语义；未做高并发基准 |
| 真机 / 真后端联调 | ❌ 本阶段只验后端 HTTP + 真库 |
| 新增迁移 | ✅ **无**（沿用现有 `Habit` / `PointRecord` / `AuditLog` / `IdempotencyRecord`） |

## 10. 签字

- 后端实现：`src/habits/{habits.controller,habits.service,habits.repository,habits.prisma.repository,habits.module,business-day}.ts`、
  `src/habits/dto/*`、`src/ledger/{ledger.append,ledger.prisma.repository}.ts`、`src/app.module.ts`
- 离线用例：`test/habits-{business-day,service,http,wiring}.test.ts`
- 真库用例：`test-db/habits-db.dbtest.ts`（组 A 装配 / 组 B 打卡 / 组 C 撤销 / 组 D 边界与 404）
- 运行器修复：`kids_points_mp/.tmp_test/{run.js,run-w4c.mjs}`、`tools/defect-status.mjs`（E18 正则）
- 证据：`npm run ci` → 0；`npm test` → 353/353；`npm run test:db` → 109/109；
  `npx tsc --noEmit`（小程序）→ 0；`run.js` → 37/37；`flutter analyze` → 0 issue；
  `flutter test` → 51/51
- 未新增迁移；未放宽任何既有闸门；前端写入口未放开。
