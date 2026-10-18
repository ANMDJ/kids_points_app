# 阶段 W3-C 交接单 · 审批链路收尾（执行器 / `autoReason` / 后台过期 / 幂等键）

> ## ✅ 已收口（2026-10-18）
>
> 本单与 W3-C 的实现、测试、文档**同批提交**；下面每个数字都来自当轮真实命令输出。
>
> | 闸门 | 结果 |
> |---|---|
> | `cd backend && npm run ci` | ✅ **`CI_EXIT=0`（15 步）** |
> | `cd backend && npm test` | ✅ **14 个文件 / 261 条全部通过**（`PASS 14 个用例文件 / 261 个用例`） |
> | `cd backend && npm run ci:db` | ✅ **`CIDB_EXIT=0`**（`db:verify` → `ALL PASS`；`test:db` → **5 个文件 / 75 条**；`test:canfail:db` → **11/11**） |
> | `cd backend && npm run build` | ✅ **`BUILD_EXIT=0`** |
> | 真实启动探针（端口 3100） | ✅ `数据库已连接`；审批路由已映射；`审批过期扫描已启动`；`GET /` → `404`；无身份头 `POST /approvals` → `401`；探针进程已终止 |
> | 数据库 | **本阶段没有新增迁移**：`IdempotencyRecord`、`ApprovalRequest.executedRecordId` / `autoReason` 等字段在 W0 schema 中已存在 |
>
> **给**：接手 **W4（双端接 API）** 的下一个会话。
>
> **一句话状态**：审批状态机的 5 个终态全部可达，4 个动作有执行器，5 种 `autoReason` 都能在真库复现；
> **但审批之外**的规则 / 习惯 / 心愿 / 邀请端点仍未建，设备凭据仍不可验证。
> 不要把本单的绿灯读成“整个后端已可用”。

## 1. 这一步在修什么

W3-A 只让 `redeem` 真正执行，W3-B 补了 `withdrawn` 与租户隔离；W3-C 收掉 W3 剩下的四个口子：

| # | 原缺口 | 本阶段落点 |
|---|---|---|
| ① | 执行器只有 `redeem`，其它动作能落 `pending` 却永远批不动 | 扩到 4 个动作；不支持的动作在**建请求时**就 `400` |
| ② | `autoReason` 只有两种能复现 | 五种全部可复现，且都有真库用例 |
| ③ | `expired` 只有惰性判定，没人访问的 `pending` 永远不过期 | `ApprovalsExpiryService` 后台扫描 ＋ `expireDue()` |
| ④ | `idempotencyKey` 只在 schema 里，HTTP 没接线 | create / decide / withdraw 三个写端点接 `Idempotency-Key` |

## 2. 执行器：4 个动作，3 条执行体

| 动作 | 批准后的真实动作 | 账本 | `executedRecordId` |
|---|---|---|---|
| `redeem` | 按**申请时快照**的 `costSnapshot` 扣分，心愿置已兑换 | `exchange / -cost` | 新流水 id |
| `request_redeem` | 与 `redeem` **同一执行路径**（不是第二套逻辑） | 同上 | 新流水 id |
| `request_points_bonus` | 按 `amount` 加分，可带规则 / 习惯依据 | `adjust / +amount` | 新流水 id |
| `add_wish` | 创建一条 `Wish`（不是兑换） | **没有流水** | **`null`** |

不支持的动作（例如 `add_rule` / `check_in`）仍在 `assertExecutable()` 处 `400 APPROVAL_ACTION_NOT_EXECUTABLE` ——
**不落一条永远批不动的 `pending`**。

### 2.1 参数白名单，不静默忽略

`snapshotPayload()` 按动作收参数，`rejectParams()` 对多余字段直接 `400 APPROVAL_PARAM_NOT_APPLICABLE`：

| 动作 | 只允许 |
|---|---|
| `redeem` / `request_redeem` | `targetId` |
| `request_points_bonus` | `amount` / `reason` / `ruleId` / `habitId` |
| `add_wish` | `title` / `cost` / `emoji` |

静默忽略会让客户端以为“我传的金额生效了”，而审批里存的是另一个数 —— 这属于**假成功**，所以选择响亮拒绝。

### 2.2 目标动作是 `DENY` 时，连申请都不许提

`POST /approvals` 的屏障二只验 `request_approval`（两个角色都是 `ALLOW`），而 `dto.action` 可以是矩阵里任意动作。
因此 `ApprovalsService.createRequest()` 先查**目标动作**：

```
resolveVerdict(dto.action, actor.role) === 'DENY'  ⇒  403 ACTION_NOT_ALLOWED
```

否则孩子可以“为 `add_rule` 提一条审批”并让家长批准，从而绕过 `add_rule.child = DENY`。
判定仍然只来自 `permission-matrix.ts`，没有新增第二份名单。

## 3. `autoReason`：五种全部可复现

| `autoReason` | 触发条件（批准 / 执行那一刻复查） | 证据 |
|---|---|---|
| `WISH_DELETED` | 心愿不存在、不属于该孩子、`status != active` 或已兑换 | `approvals-execution-db.dbtest.ts` |
| `INSUFFICIENT_POINTS` | 当前余额 < 申请时的 `costSnapshot` | `approvals-execution-db.dbtest.ts` |
| `RULE_DELETED` | 加分申请带的 `ruleId` 在批准前被软删 / 不属于该孩子 | `approvals-closing-db.dbtest.ts` 组 B |
| `HABIT_GONE` | 加分申请带的 `habitId` 在批准前被软删 / 不属于该孩子 | `approvals-closing-db.dbtest.ts` 组 B |
| `MEMBER_REMOVED` | 申请人的 `ChildMember.status` 不是 `active`（或成员行已不存在） | `approvals-closing-db.dbtest.ts` 组 B |

`MEMBER_REMOVED` 是 `executeAction()` 的**通用前置检查**：任何动作执行前都先查申请人成员位。
顺序是故意的 —— 先确认“人还在”，再判断“心愿 / 规则 / 习惯还在”，避免给已离开的成员发分。

`invalidated` 是**要提交的历史**：执行结果用判别式联合返回，调用方在同一事务里把请求落成
`invalidated` 后提交；**不在事务里抛 409**（抛了会把刚写下的终态回滚，客户端重试永远看到 `pending`）。

## 4. `expired`：惰性判定 ＋ 后台扫描

### 4.1 惰性判定仍是兜底

`expireIfDue(id, childId, now)` 保留：读 / 决 / 撤回时顺手用条件 UPDATE 抢“过期权”。
条件里带 `childId`（W3-B），跨孩子请求不能把别家的 `pending` 提前置过期。

### 4.2 `expireDue()` 是后台入口

`ApprovalsPort.expireDue(now, limit)` 的 Prisma 实现：

1. `SELECT … WHERE status='pending' AND expiresAt <= now ORDER BY expiresAt LIMIT ? FOR UPDATE SKIP LOCKED`
2. 每行条件 UPDATE（`status='pending' AND expiresAt <= now`），只有 `count=1` 才计数
3. 同一事务写 `approval.expired` 审计
4. 默认 `limit=100`，上限 **500**；重复扫描不会重复计数
5. `SKIP LOCKED` 让多个实例各扫各的，不互相阻塞

### 4.3 扫描器只在 `main.ts` 启动

`ApprovalsExpiryService`：

- 默认 **60s**，环境变量 `APPROVAL_EXPIRY_SCAN_INTERVAL_MS`
- `start()` 先立即扫一次（停机期间到期的不用再等一个周期）
- `setInterval(...).unref()`，不阻止进程退出
- `tick()` 有防重入；失败只记录日志，下一轮继续
- **无 `DATABASE_URL` 时 `start()` 直接 no-op**（不启动一个必然 501 的计时器）
- 测试不启动计时器，直接调 `scanOnce()`；否则每个用例文件都会残留一个 `setInterval`

## 5. `Idempotency-Key`：HTTP 重放保护

### 5.1 接在哪

| 端点 | `actionType` | 请求指纹 |
|---|---|---|
| `POST /approvals` | `dto.action` | `POST /approvals` ＋ 规范化 DTO |
| `POST /approvals/:id/decide` | `review_approvals` | `POST /approvals/:id/decide` ＋ 规范化 DTO |
| `POST /approvals/:id/withdraw` | `withdraw_request` | `POST /approvals/:id/withdraw` ＋ `null` |

### 5.2 语义

| 情况 | 结果 |
|---|---|
| 不带 key | **完全跳过**幂等端口，直接执行业务（幂等是可选能力） |
| 同键 ＋ 同请求 | 返回首次的 `statusCode` / `body`，**不再调用业务** |
| 同键 ＋ 不同请求（hash 不同） | `409 IDEMPOTENCY_KEY_REUSED`，不得静默复用首次结果 |
| 同键但首次还没写完响应 | `409 IDEMPOTENCY_IN_PROGRESS`（fail-closed） |
| 空 key / > 200 字符 | `400 INVALID_IDEMPOTENCY_KEY` |
| 无库装配 ＋ 带 key | `501 IDEMPOTENCY_NOT_IMPLEMENTED`（不假装保护已生效） |

数据库唯一约束是 `IdempotencyRecord @@unique([childId, key])`；`begin()` 把 Prisma `P2002`
当作**正常并发分支**（读回已有记录），不是 500。记录 TTL 为 **24h**，过期行在 `begin()` 时删除。

### 5.3 ★ 响应缓存与业务事务不是同一个事务

业务本身已经幂等：`PointRecord.idempotencyKey = approval:<id>`，配合审批行锁、余额行锁与条件 UPDATE，
同一笔审批只可能写一笔流水。`Idempotency-Key` 缓存的是**HTTP 响应**。

如果进程恰好在「业务已提交、响应还没写回」之间崩溃：重放得到 `409 IDEMPOTENCY_IN_PROGRESS`，
直到 24h 记录过期；**不会重复扣分**。这是有意的 fail-closed，不是“重放保护失效”。
`complete()` 写不回响应时返回 500 `IDEMPOTENCY_RECORD_LOST`，同样不会把业务回滚。

## 6. 文件级落点

**新增**

| 文件 | 作用 |
|---|---|
| `backend/src/approvals/approvals-expiry.service.ts` | TTL 后台扫描器；`start()` / `scanOnce()` / 防重入 / `unref()` |
| `backend/src/idempotency/idempotency.repository.ts` | `IdempotencyPort`、无库 501 实现、Prisma 实现（`P2002` 分支、24h TTL） |
| `backend/src/idempotency/idempotency.service.ts` | `run()`：重放 / 冲突 / 执行 / `complete` / `abort`；规范化 JSON hash |
| `backend/test-db/approvals-closing-db.dbtest.ts` | W3-C 真库证据（组 A–F） |

**修改（按职责）**

| 文件 | 改了什么 |
|---|---|
| `backend/src/approvals/approvals.repository.ts` | 端口新增 `expireDue()` 与对应入参注释 |
| `backend/src/approvals/approvals.prisma.repository.ts` | 4 执行器、payload 快照 / 解析、参数白名单、`MEMBER_REMOVED`、`expireDue()` |
| `backend/src/approvals/approvals.service.ts` | 目标动作 `DENY` 守卫；create / decide / withdraw 路径不变 |
| `backend/src/approvals/approvals.controller.ts` | 三个写端点接 `Idempotency-Key` |
| `backend/src/approvals/approvals.module.ts` | 注册扫描器；按 `hasDatabase` 装配幂等模块 |
| `backend/src/approvals/dto/create-approval-request.dto.ts` | 加分 / 心愿动作的字段校验（金额 1..50、标题长度、成本 >0 等） |
| `backend/src/idempotency/idempotency.module.ts` | `register({ hasDatabase })`：无库显式 501，有库 Prisma |
| `backend/src/app.module.ts` | 接入 `IdempotencyModule` |
| `backend/src/main.ts` | 启动 `ApprovalsExpiryService` |
| `backend/src/contracts/approval-policy.ts` | 与执行器名单保持同源（不复制名单） |
| `backend/test/approvals-http.test.ts` | 组 H（5 条幂等用例）＋ `DENY` 目标动作 403 |
| `backend/test-db/approvals-db.dbtest.ts` | 旧用例改用 `add_rule` / 非适用参数，跟随参数白名单 |
| `backend/test/membership-http.test.ts` | 假端口补 `expireDue` |
| `backend/.env.example` | `APPROVAL_EXPIRY_SCAN_INTERVAL_MS=60000` |

文档同步：`docs/design/02-rbac-and-approval.md` §4.7 / §9.34–9.40、`docs/design/README.md` W3-C 段、
`docs/design/05-dev-plan.md` W3 exit、`docs/PRD.md` §9 / §15。

## 7. 真库用例分组

`backend/test-db/approvals-closing-db.dbtest.ts`：

| 组 | 钉住什么 |
|---|---|
| A | `request_points_bonus`：孩子申请 → 家长批准，payload 快照、`+10`、余额；0 / 51 金额边界；兑换带 `amount` → 400 |
| B | `RULE_DELETED` / `HABIT_GONE` / `MEMBER_REMOVED` 三种前提消失，且**零流水** |
| C | `add_wish` 真的创建 `Wish` 且 `executedRecordId=null`；`request_redeem` 与 `redeem` 同路径 |
| D | `expireDue()` 把到期 `pending` 置 `expired` ＋ 审计一条；再扫一次不重复计数 |
| E | 幂等键：create 重放只一条 `pending`；decide 重放仍 200 且流水只一笔；同键不同请求 409 |
| F | I2：`Σ流水 == Child.pointsBalance`，链无断裂（4 笔） |

离线 `backend/test/approvals-http.test.ts` 的组 H 用假端口钉 HTTP 语义：
create 重放、同键不同请求、decide 重放、不带 key 完全不碰幂等端口、非法 key 400。

## 8. 本轮真踩过的坑（防复发）

1. **`add_wish` 不要硬塞流水。** 它没有 `PointRecord`，所以 `executedRecordId` 必须是 `null`；
   把心愿 id 塞进这个 `@unique` 外键会破坏语义。`status=approved` 已经是成功信号。
2. **加分流水不要补 `ruleId`。** I3/I4 要求 `(ruleId, ruleVersion)` 成对且命中版本行；加分申请是“人对金额的批准”，
   不是规则版本执行。依据只存在 `ApprovalRequest.payload` 和标题里。
3. **`MEMBER_REMOVED` 必须在动作复查之前。** 先确认人还在，再判断心愿 / 规则 / 习惯；顺序改了会让已离开成员
   仍能拿到 `WISH_DELETED` 之类的“业务失败”，而不是“成员已移除”。
4. **`invalidated` / `expired` 不能在事务里抛 409。** 状态要先提交；HTTP 409 由 service 在读状态后翻。
5. **扫描器不要挂在模块构造 / `OnModuleInit`。** 测试会建很多次模块，每个计时器都会拖住进程；
   只有 `main.ts` 显式 `start()`，测试直接调 `scanOnce()`。
6. **幂等响应缓存不在业务事务里。** 崩溃窗口会得到 `IDEMPOTENCY_IN_PROGRESS`，这是 fail-closed；
   不要为了“重放更顺”把它改成可能重复执行的路径。
7. **真库夹具不清理账本。** `PointRecord` 的 DELETE 被 REVOKE（I5），本套件沿用随机前缀；
   不要断言“全库只有 N 条”这类会被历史残留影响的数字。
8. **`request_points_bonus` 的限额只做了一半。** 单笔 1..50 已在 DTO / 快照落实；
   “每天 3 条 / 同因去重”属于 `02` §6 的 dispatcher，**尚未实现**，不要把这个端点读成“加分配额已验收”。

## 9. 仍未落地（明确边界）

- **其它业务模块端点**：规则 / 习惯 / 心愿 / 邀请等模块仍只有 schema / 设计，没有完整 HTTP 端点；W3 只收审批链路。
- **加分配额**：每天 3 条、同因去重未做（dispatcher 层）。
- **设备凭据**：`x-kp-device-id` 仍可伪造；`NODE_ENV=production` 一律 `503`，等 L2 之后的会话 token。
- **会话 / PIN**：刷新、PIN 切换、锁 15 分钟、切换写审计仍未做。
- **前端**：`AppStore` 仍是内存态，双端还没接 API（W4）。
- **通知 / Agent**：未开始（W6）。

## 10. 下一会话（W4）的接手顺序

1. 先读 `02` §4（审批状态机 / 执行器）与 §4.7；审批判定**只消费** `approval-policy.ts` 和
   `permission-matrix.ts`，不要在 service / controller 里另写“谁能批”。
2. 双端 `AppStore` 的写方法逐个换成 HTTP；重试型请求由客户端生成 `Idempotency-Key`（UUID），
   **同一个逻辑请求重试必须复用同一个 key**；不要每次重试新生成。
3. 统一映射错误：`401 SESSION_*` / `403 MEMBER_*` / `403 ACTION_NOT_ALLOWED` / `409 ALREADY_DECIDED` /
   `409 APPROVAL_EXPIRED` / `409 IDEMPOTENCY_*` / `202 pending`，UI 必须有可读文案。
4. 需要新增动作执行器时，**同时**补：`assertExecutable` 名单、`snapshotPayload` 分支、
   `parseApprovalPayload` 分支、`executeAction` 分支、离线 HTTP 用例、真库用例；
   少任何一处都会在 `UNSUPPORTED_APPROVAL_ACTION` 或 `InternalServerError` 处响亮失败。
5. 规则 / 习惯 / 心愿 / 邀请端点属于 W4–W6，不要把“审批能批准 `add_wish`”误读成“心愿模块已完成”。

## 11. 复跑命令

```bash
cd backend

# 静态闸门（不需要数据库）
npm run ci                 # 期望 CI_EXIT=0（15 步）

# 离线用例
npm test                   # 期望 14 个文件 / 261 条

# 真库（需要 DATABASE_URL；会跑迁移后的真实 PostgreSQL）
npm run ci:db              # 期望 CIDB_EXIT=0；db:verify ALL PASS；test:db 5 / 75；canfail 11/11
npm run test:db            # 只跑真库用例

# 构建
npm run build              # 期望 BUILD_EXIT=0
```

> 真库基线数字会随用例增加而变化；**判断标准是“0 失败 ＋ 每条断言真的执行”**，
> 不是永远记住 75 这个数。若 `test:db` 因历史残留失败，先看随机前缀是否撞车，不要删账本表（I5）。
