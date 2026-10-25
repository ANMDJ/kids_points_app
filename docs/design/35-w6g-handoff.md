# 阶段 W6-G 交接单 · 推送链路端到端冒烟（真 Nest ＋ 真库 ＋ 真网关）

> **日期**：2026-10-25　**阶段**：W6-G（W6-F 遗留的「没有一条真 HTTP ＋ 真 Nest 的 e2e」收口）
> **给**：接真实 APNs / FCM / 微信订阅消息、或要把本地网关换成厂商网关的下一个会话。

**一句话**：审批 HTTP → 同事务 outbox → `PushRetryWorker.tick()` →
`WebhookPushAdapter` 读真 `DeviceToken` → **本地 `node:http` 网关** → 回写任务状态，
这条链第一次被**一条用例从头到尾跑通**；除网关外没有任何替身，也**不需要 L2 / L3 推送凭据**。

---

## 1. 本阶段做了什么

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 端到端真库套件（5 组 / 6 条） | `backend/test-db/push-delivery-e2e-db.dbtest.ts` |
| 2 | 本地推送网关（`ok` / `fail500` / `gone410` 三种回应，记录 event / 授权头 / 消息体） | 同上（`startGateway()`） |
| 3 | 真库夹具（3 个家庭 / 7 个用户 / 7 条会话，全部 `dbtest-<run>-e2e-…` 前缀） | 同上（`seed()`） |

**没有改**：`src/` 下任何一行、Prisma schema、迁移、Flutter / 小程序、权限矩阵（仍 **35** 动作）。
本阶段只加了一条测试，以及这份交接单和文档状态。

---

## 2. 这条链到底接通了什么

```text
POST /approvals                 (真路由 + 三道屏障 + 真 Prisma)
  └─ 同一事务：ApprovalRequest + Notification + PushRetryJob(dedupeKey)
        ↓  （测试把 nextAttemptAt 拨到 2000-01-01，确保本轮第一条就是它）
PushRetryWorker.tick(now)       (真 worker：claimDue → deliver → markSent/Retry)
  └─ WebhookPushAdapter         (真适配器：按 recipientUserId 查 active DeviceToken)
        └─ POST http://127.0.0.1:<随机端口>/push
              { version, event, message, tokens } + x-kp-event + Authorization
                 ↓
           本地网关（本进程 node:http）
                 ↓ 200 { messageId } / 500 / 410 { invalidTokens }
        回写 PushRetryJob：sent / pending(attempts+1) / pending(结构性失败)
```

**关键点**：worker 不是被绕过的 —— 用例没有直接调 `adapter.send()`，而是走
`worker.tick()` 的领取 / 结算路径。因此 `attempts`、`claimedAt`、`nextAttemptAt`、
`providerMessageId` 这些**队列事实**也是被真实验证过的，而不是测试自己写进去的。

---

## 3. 关键实现决策

### 3.1 只覆盖两个 provider，别的都是生产件

```ts
Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(PUSH_DELIVERY_PORT).useValue(new WebhookPushAdapter(...))
  .overrideProvider(PUSH_RETRY_CONFIG).useValue({ ...defaults, batchSize: 1 })
```

- `PUSH_DELIVERY_PORT` 换成的是**真的 `WebhookPushAdapter`**，只是把 `url` 指向本地网关；
- `PUSH_RETRY_CONFIG.batchSize = 1` 是共享实验库的隔离手段（见 §3.3），不是替身；
- 路由、`applyGlobalPipes`、Prisma 适配器、outbox、worker 全部按 `AppModule` 原样装配。

**为什么不覆盖 `PUSH_PORT`**：W6-C 之后请求路径**一次推送都不发**，`PUSH_PORT`
只是 `useExisting: PUSH_DELIVERY_PORT` 的别名。覆盖 `PUSH_DELIVERY_PORT` 就同时决定了
worker 与（已不用的）业务发送端口，少一个可漂移的接线点。

### 3.2 本地网关是「契约另一端」，不是 mock

网关是一个真的 `node:http` server，监听 `127.0.0.1:0`（随机端口），因此：

- 适配器**真的建连接、真的发 JSON、真的读状态码**（超时 / 连接错误路径也仍然存在）；
- 用例能逐字检查线上契约：`x-kp-event`、`Authorization: Bearer …`、
  `version = 1`、`message.*`、`tokens[]` 的 `{token, platform}` 形状；
- 三种回应覆盖三条结算分支：
  | 网关 | 适配器结果 | 队列结算 |
  |---|---|---|
  | `200 { messageId }` | `{ ok: true, messageId }` | `sent` + `sentAt` + `providerMessageId` |
  | `500` | 渠道故障 | `pending`、`attempts + 1`、30s 退避 |
  | `410 { invalidTokens }` | 渠道故障（同时下线 token） | 同上 |

`410` 只把**本次请求里发出去的** token 列回来，适配器再与发送集合求交 ——
网关不能借一次 410 下线库里任意 token。

### 3.3 共享库不做 DELETE：靠「最早时间」而不是「清场」

本仓库的真库套件共用同一个实验库，且**不做 DELETE 清理**（历史行本身就是证据）。
让 `batchSize = 1` 之后仍有一个问题：`claimDue` 按 `ORDER BY nextAttemptAt ASC`
领「最久没发」的那条，历史 pending 可能比本用例更早。

因此 `makeDue(dedupeKey)` 只改一件事：

```ts
nextAttemptAt = new Date('2000-01-01T00:00:00.000Z')
```

`status` 仍是 `pending`、`attempts` 仍是 0、payload 一字不动 —— 它仍是
「一条到期的 pending 任务」，只是保证排在共享库所有历史行之前。
`makeDue()` 断言 `updateMany.count === 1`，避免「以为在测新任务，其实没找到」。

### 3.4 超时必须短于 worker 的兜底

适配器 `timeoutMs = 800`，worker 对单条发送有 **1000ms** 兜底。
若把适配器超时调到 1000ms 以上，「适配器还没超时就被 worker 判死」，
会得到一条看起来是重试、实际是竞态的用例。本套件显式写 800 并在注释里钉死这层关系。

### 3.5 断言「业务不回滚」才是这套件的核心

组 C 的 500 不只断言任务重试，还断言：

```ts
approval.status === 'approved'      // 没有被推送失败改回去
wish !== null                       // 心愿真的落地
```

这是 W6-C「outbox 与业务同事务、投递失败只影响投递」在**真库 + 真 HTTP** 下的证据。
离线用例可以断言返回码，但只有真库能证明「事务确实提交了，后续失败没有把它掀翻」。

---

## 4. 证据（2026-10-25 实测）

```bash
cd kids_points_app
npm --prefix backend run test:db   # 18 个文件 / 246 条全过（本套件 +6）
npm --prefix backend test          # 37 个文件 / 693 条全过（未受影响）
```

本套件 5 组 / 6 条：

| 组 | 覆盖 | 关键断言 |
|---|---|---|
| A | token 登记走真路由 | 200、`active=true`、归属是会话 actor；**响应体没有 `token` 字段**；重复注销仍 200 且 `revokedAt` 不变 |
| B | 成功链 | 网关恰好 1 次调用；event / Bearer / `version` / `message.*` / `tokens[]` 与库一致；任务 `sent`、`attempts=0`、`claimedAt=null`、`providerMessageId` 非空；审批 `approved`、心愿落库 |
| C | 500 ⇒ 重试、业务不回滚 | 任务 `pending`、`attempts=1`、`lastError` 含 `HTTP 500`、`nextAttemptAt ≥ now+30s`；审批仍 `approved`、`Wish` 仍存在 |
| D | 410 ⇒ token 下线 | 库里 `active=false`、`revokedAt` 非空；任务 `pending`、`attempts=1`、`lastError` 含 410；审批仍 `pending` |
| E | 无 token ⇒ 结构性失败 | 网关 **0** 次调用；`lastError='no_device_token'`、`attempts` **仍 0**、`nextAttemptAt ≥ now+4min`；审批不受影响 |

---

## 5. 边界：这条 e2e 仍然证明不了什么

1. **没有真实厂商 SDK / 凭据**：本地网关扮演的是「我们自己的推送网关」，不是 APNs / FCM /
   微信订阅消息。适配器之后的投递、APNs 的 410、FCM 的 `UNREGISTERED` 都**没有被验证**。
2. **没有客户端参与**：token 由测试直接 `POST /device-tokens` 登记，不是 Flutter 端
   `PushTokenRuntime` 真发出来的。W6-E / W6-F 的客户端链路仍是替身证据。
3. **没有调度器计时验证**：用例手动调 `worker.tick()`，不验证 15s 间隔、进程重启、
   多实例并发（并发领取本身由 `push-retry-db.dbtest.ts` 的 `SKIP LOCKED` 用例覆盖）。
4. **没有超时 / 连接拒绝 / 非 JSON 回包的 e2e**：适配器单测覆盖，本套件只覆盖 200 / 500 / 410。
5. **共享库、非隔离**：不做 DELETE，靠 `batchSize=1` ＋ `nextAttemptAt=2000-01-01` 选行；
   如果同库有另一套件**同时**把任务拨到更早时间，仍可能互相干扰（当前套件串行执行，未发生）。
6. **`410` 的语义仍由本仓库定义**：真实厂商的失效信号形状不同（FCM 是 404 +
   `UNREGISTERED`，APNs 是 410 + timestamp），接厂商时要改的是适配器而不是本套件。

---

## 6. 下一步（建议顺序）

1. **把本地网关换成真实网关**：配置 `PUSH_WEBHOOK_URL` / `PUSH_WEBHOOK_TOKEN`，
   在测试环境手工跑一次 `worker.tick()`，确认 `providerMessageId` 来自真实网关。
2. **接厂商适配器**：新增 `ApnsPushAdapter` / `FcmPushAdapter` 实现 `PushDeliveryPort`，
   用同样的 5 组断言跑一遍（尤其 410 / `UNREGISTERED` 的 token 下线）。
3. **接客户端**：Flutter 用真实 SDK 产出 token，替换 `KP_PUSH_TOKEN`；
   跑一次「真机登记 → 真审批 → 真推送到达」的手工验收。
4. **补调度 / 进程级证据**：验证 15s 调度、优雅停机、重启后 `sending` 回收。
5. **小程序**：仍等微信登录 / `openid`，不要先造假 `weapp` token。

---

## 7. 复跑命令

```bash
cd kids_points_app

# 需要 DATABASE_URL；缺库直接红，NODE_ENV=production 硬拒绝
npm --prefix backend run test:db

# 离线套件仍应全绿
npm --prefix backend test
```

> 本套件不产生 Flutter 改动，因此不需要 `flutter test`；若同时改了 Dart，再按
> `34-w6f-handoff.md` §7 的清单复跑。
