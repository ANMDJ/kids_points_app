# 阶段 W6-B 交接单 · 推送失败重试队列（`PushRetryJob`）

> **日期**：2026-10-24　**阶段**：W6-B（WF-6「真实推送」的第二步）
> **给**：接手「把重试换成真 outbox」「接 APNs / FCM / 微信」「推送可观测与告警」的下一个会话。

**一句话**：`29-w6a-handoff.md` §5 的第 4 条（outbox）这次**做了一半** ——
推送失败不再「发一次就没了」，而是留下一行 `PushRetryJob`，由后台 worker 按指数退避重发，
超过 TTL 标 `expired`、渠道故障用满次数标 `dead`；**但**请求路径仍然先同步发一次
（这不是真 outbox，见 §5.1），而且**依然没有任何厂商凭据 / 网关 / 客户端上报** ——
所以线上这张表**永远是空的**，「孩子手机弹出通知」仍然一次都没发生过。

---

## 1. 本阶段做了什么

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 新枚举 + 新表 `PushRetryJob`（`dedupeKey` 唯一、**无**外键、`expiresAt` 必填） | `prisma/schema.prisma`、迁移 `20261024150000_push_retry_job/migration.sql` |
| 2 | 队列数据结构 / 去重键 / payload 校验（纯函数） | `src/notifications/push-retry.types.ts` |
| 3 | 失败分类、退避序列、`lastError` 文案（纯函数，不看时钟） | `src/notifications/push-retry.policy.ts` |
| 4 | 六个环境旋钮的解析与夹取（纯函数，不读 `process.env`） | `src/notifications/push-retry.config.ts` |
| 5 | 进程内计数 + 连续失败告警闸门 | `src/notifications/push-retry.metrics.ts` |
| 6 | 持久化端口（7 个方法）＋ 无库 501 实现 | `src/notifications/push-retry.repository.ts` |
| 7 | Prisma 适配器（唯一一条「难」的 SQL：`claimDue`） | `src/notifications/push-retry.prisma.repository.ts` |
| 8 | 「失败即入队」装饰器 ＋ 第二个端口令牌 | `src/notifications/push-retry.adapter.ts`、`src/notifications/push.port.ts` |
| 9 | 后台 worker（清扫 → 领取 → 单条结算） | `src/notifications/push-retry.worker.ts`、`src/main.ts`（`start()`） |
| 10 | 装配：端口/配置/指标/worker，无库不套装饰器 | `src/notifications/notifications.module.ts` |
| 11 | `.env.example` 六个 `PUSH_RETRY_*` 键 | `backend/.env.example` |
| 12 | 用例：离线 **36** 条 ＋ 真库 **14** 条 | `test/push-retry.test.ts`、`test-db/push-retry-db.dbtest.ts` |

**没有改**：`PushResult` / `PushMessage` 的形状、`NotificationsService` 的「永不抛错 + 1s 兜底」、
`NotificationsService` 的调用位置（仍在 `decide()` 事务之外）、`WebhookPushAdapter` 的任何行为、
`Notification` 站内通知、任何业务表 / 账本表。

唯一「顺手改到别处」的是 `push.port.ts`：把原来写死在 `notifications.service.ts` 里的
`PUSH_TIMEOUT_MS = 1000` 提成导出的 `PUSH_SEND_TIMEOUT_MS`，**worker 与 service 共用同一个数字**。
两处各写一个，「业务路径 1s、重试路径 10s」这种漂移会让同一条推送在两条路径上表现不同，
而排查时只会看到「有时很快失败、有时很慢」。

---

## 2. 关键实现决策

### 2.1 为什么是「队列表 + worker」，而不是在请求里重试

推送是**不可撤回的外部副作用**：用户手机上会响。在 `POST /approvals/:id/decide` 里
`for` 三次重试，等于把家长点「同意」的响应时间绑在第三方的抖动上 —— 而审批已经落库了，
慢的只有那条通知。所以：请求路径**只发一次**（1s 兜底），发不出去就把「这次没发成」
写成一行，由**别的时间线**（worker）去处理。

### 2.2 两个令牌：`PUSH_PORT` 与 `PUSH_DELIVERY_PORT`

| 令牌 | 谁用 | 语义 |
|---|---|---|
| `PUSH_PORT` | `NotificationsService`（业务） | 发一次；**失败 ⇒ 入队** |
| `PUSH_DELIVERY_PORT` | `PushRetryWorker`（重试） | 只发一次；失败由 worker 自己结算 |

★ 为什么不让 worker 也用 `PUSH_PORT`：那会在**每次重试失败时再入一次队**。
唯一约束（`dedupeKey`）会挡住第二条，但它同时会把「谁负责重试」变成两个地方，
且 `duplicates` 计数会被重试路径污染 —— 运维从此看不出「业务路径撞了多少次重复」。

装配上它们是同一条链：`PUSH_DELIVERY_PORT` = `createPushAdapter(...)`（W6-A 的原始适配器），
`PUSH_PORT` = `new PushRetryAdapter(delivery, ...)`。**无库时 `PUSH_PORT` 直接等于 `delivery`**
（不套装饰器）：没有队列可写，套上只会让每次推送失败都多一条「入队失败」的 warn。

### 2.3 为什么是装饰器，而不是改 `NotificationsService`

① `NotificationsService` 只该做一件事：**站内先写、再尽力推送**。让它同时操心
入队 / 去重 / TTL，那条「通知永不抛错」的口径会立刻长出分支；
② 装饰器让「原始渠道」与「带重试的渠道」是**同一个接口的两个实例**，
「推送是否入队」因此在端口那一层被证明，而不是在 service 里；
③ `new NotificationsService(fakePush, fakeRepo)` 这类既有用例**一行都没改**。

装饰器的三条不可违背约束（`test/push-retry.test.ts` 组 D 逐条证伪）：

| # | 约束 | 违背后的现象 |
|---|---|---|
| ① | 入队失败**绝不**抛给调用方 | 一次数据库抖动会把**已提交**的批准变成 500 |
| ② | 适配器抛错时**先入队、再把原错误抛出去** | 吞掉它 ⇒ 失败变成功（`NotificationsService` 的 `provider_error` 分支再也走不到） |
| ③ | 返回值**原样透传** | `delivered: true` 被子类改写成 false，「顺手记了一笔」变成改语义 |

### 2.4 去重键的形状（这张表最要紧的一列）

```
approval.status_changed:<approvalId>:<recipientUserId>:<status>
approval.submitted:<approvalId>:<recipientUserId>
```

- **收件人在键里**：`approval.submitted` 是一次提交 → 多位家长各一条；
  键里没有收件人，第二位家长的消息会被唯一约束当成「重复」**直接丢掉**；
- **审批 id 在键里**：同一件事只提醒一次，重放 / 双击 / worker 重启都不会变成两条
  （`Idempotency-Key` 管的是业务写入，管不到通知 —— 通知需要自己的键）；
- **`status` 在键里**（只对 `status_changed`）：`approved` 与 `rejected`
  是两次不同的事实，不能互相去重；
- ★ **不要把时间放进键里**。放进去就等于没有去重：每次重算 `occurredAt`
  都是一条新行，唯一约束永远不生效。

`buildPushRetryDedupeKey` 用 `never` 穷尽性检查收尾：新增消息类型时 **TS 编译期** 报错，
逼你写出去重规则 —— 而不是在运行时静默生成一个 `undefined:undefined` 的键。

### 2.5 `claimDue`：一条 SQL，且**应用侧再排一次序**

```sql
UPDATE "PushRetryJob" AS job
SET status = 'sending', "claimedAt" = now
WHERE job.id IN (
  SELECT id FROM "PushRetryJob"
  WHERE "expiresAt" > now
    AND ((status = 'pending' AND "nextAttemptAt" <= now)
      OR (status = 'sending' AND "claimedAt" IS NOT NULL AND "claimedAt" <= staleBefore))
  ORDER BY "nextAttemptAt" ASC
  LIMIT n
  FOR UPDATE SKIP LOCKED
)
RETURNING ...
```

- `FOR UPDATE SKIP LOCKED` ⇒ 多实例部署各领各的，**同一条只会被一个 worker 领到**
  （重复发送等于让用户手机响两次）；真库组 B4 用两条并发 `claimDue` 证明结果不重叠；
- `LIMIT` 在**子查询里** ⇒ 锁的只有这 n 条，不会把整张表锁住；
- **一条语句**完成「选 + 标记」⇒ 分两条就会出现「A 选完、B 也选到、两人都发」；
- ★ **`RETURNING` 的行序在 Postgres 里是未定义的**。本次实测：返回的是**更新的物理顺序**，
  不是子查询里的 `ORDER BY`。worker 是按数组顺序发送的，于是「拖得最久的最先发」
  只在某些执行计划下成立 —— 重启一次就换一个顺序。修法是在应用侧按
  `nextAttemptAt` 再排一次（同刻用 `createdAt` 兜底），并在文件头把这件事写下来。
  **这个 bug 是真库组 B2 抓到的**，离线用例（仓储是替身）永远抓不到它。

`expireOverdue` 每轮**先跑**：否则一批已过期的行会被领进发送路径，
再被 `settle()` 一条条 `markExpired` —— 同样是正确的状态，但白发了 n 次。

### 2.6 两类失败，两种命运（§2 里最要紧的一张表）

| 失败原因 | 分类 | 是否消耗 `attempts` | 下次间隔 | 终点 |
|---|---|---|---|---|
| `provider_error`（网关 500 / 证书过期 / 超时 / 抛错） | **transient** | **是**（+1） | 指数退避 30s→1m→2m→4m→8m→16m，封顶 30m | 用满 `maxAttempts`（默认 6）⇒ `dead` |
| `no_device_token`（这个人还没登录设备） | **structural** | **否** | 固定 5m | 到 `expiresAt` ⇒ `expired` |
| `provider_not_configured`（没配网关 / 配错） | **structural** | **否** | 固定 5m | 到 `expiresAt` ⇒ `expired` |

★ 为什么结构性失败**不消耗**次数：这两件事不是「渠道坏了」，是「还没就位」——
前者装好 App 就有了，后者配上网关就有了。若也按指数退避算 6 次，
**30 分钟就会把队列里的通知全部判死**，而「配上网关」往往要等到第二天。
但也不能无限等：`expiresAt` 之后如实标 `expired`，不假装它还活着。

★ 反过来的错误更隐蔽：**把所有失败都当成永久失败直接丢弃**。
那会得到一条 100% 绿的重试队列 —— 因为里面什么都没有。

退避序列**不加抖动（jitter）**：本仓库的用例要能逐字复现时间；而「同时重试」在这里
不会形成尖峰（领件由单个 worker 顺序处理，一批上限 `PUSH_RETRY_BATCH`）。
`backoffDelayMs` 对非法输入（`0` / 负数 / `NaN`）一律按第 1 次处理 —— 宁可早一点重试，
也不要让 `nextAttemptAt` 变成 `Invalid Date`（那会**永不领取**）。

### 2.7 TTL 与 `claimTimeout`：两个「否则永不」的旋钮

| 旋钮 | 不设它会怎样 | 默认 |
|---|---|---|
| `expiresAt`（TTL） | 一条「一直没有设备」的推送永久占着队列，「未送达」变成永不结束的中间态 | 24h |
| `claimTimeoutMs` | 进程在「领走之后、标记之前」崩溃 ⇒ 该行停在 `sending`，**永不重试** | 60s |

`claimDue` 的第二条筛选分支就是回收：`sending` 且 `claimedAt <= now - claimTimeoutMs` ⇒ 可以重领。
代价是极端情况下**可能重复发送一次**（崩在「已发出去、没标记」之间）——
这比「永远不发」好，也不撒谎。真库组 B5 证明「超时的能重领、刚领走的不能」。

`settle()` 里还有一条：结构性失败排出的下一次若已越过 `expiresAt`，**直接 `expired`**，
不排一个永远到不了的期。

### 2.8 payload 是 JSON 列 ⇒ 必须校验，不能 `as`

`parsePushMessage()` 逐字段校验（`approvalId` / `childId` / `recipientUserId` / `action` /
`occurredAt` 非空；`status_changed` 的 `status` 只能是 `approved` / `rejected`），不合法 ⇒ `null`。

★ 用 `as PushMessage` 断言的后果：坏数据一路走到适配器，`isApprovalStatusChangedPush`
读到 `message.type === undefined` 为假 ⇒ **当成另一种消息发出去** ⇒
结果是「发送成功、内容全空」，一条谁都看不出来的假记录。
在入口挡下来，它只会是一条 `dead` + `lastError = invalid_payload`。

同一原则用在 `status` 上，方向相反：`toRow()` 对未知枚举值**抛错**（响亮失败），
而不是静默断言 —— 未知状态既不领也不报，是最难查的一种。

### 2.9 告警看「连续」失败，不看总数

`consecutiveFailures` 在 `recordSent()` 时归零；跨过 3 次时打**一条 warn**，然后
`alarmConsumed = true`，直到一次成功把它重新武装。

- 为什么不是「总数」：总数大只说明用得久；**连续**失败才说明渠道此刻是坏的。
  混在一起，告警会在正常运行一个月后开始天天响；
- 为什么 `consumeAlarm()` 用「`>=` 阈值 + 已消费标记」而不是 `=== 阈值`：
  后者只在「每次失败都立刻调用一次」时成立；若一轮里结算了三条，
  阈值会被**跨过去**而永远不响。宁可晚一条，也不要漏。

### 2.10 开关的方向：不认识的值 ⇒ **保持开启**

`PUSH_RETRY_ENABLED` 只有明确写成 `0` / `false` / `off` / `no` / `disabled` 才关。
这条 worker 是**兜底**，关掉它不会有任何可见报错（只是推送不再重试），
所以「拼错一个值就静默关闭」不可接受；反过来「拼错一个值仍然尝试重试」最多多几次领件。

`enabled=false` 与「有开关但没库」都用 **warn**（不是 info）：
它们是「队列存在但不工作」，失败推送会一直停在 `pending` 直到有人翻 `.env`。
悄悄不启动是最糟的默认值。非法数字（`PUSH_RETRY_BATCH=abc` / `-5` / `9e9`）
不抛错，**夹到边界**，并把最终生效的数字打进启动日志 —— 服务不该因为一个次要路径的
配置写错就起不来，但也不能静默按默认值跑。

### 2.11 计时器不在构造函数里启动

与 `ApprovalsExpiryService` 同一纪律：`npm test` 会实例化模块，构造函数里 `setInterval`
会留下一个永不结束的计时器（Node 进程不退出 = 看着像卡死）。只有 `main.ts` 调 `start()`，
且 `timer.unref()`；`onApplicationShutdown` 里 `stop()`。
单进程重入由 `running` 保证（上一轮没跑完就跳过本轮并记 debug），
**`tick()` 的异常向上抛**（`safeTick` 把它变成一条 error 日志），
避免计时器回调把异常甩到 `unhandledRejection`。

`start()` 启动即跑一轮：部署后积压的失败推送不必等第一个间隔。

`main.ts` **不**再复写一遍 `enabled` 判断 —— `start()` 内部自己判断。
否则「模块装配说的」与「main 说的」会成为两处真相。

### 2.12 真库套件的纪律：不 `DELETE`，于是断言必须自己造起点

`test-db/push-retry-db.dbtest.ts` 与其它真库套件一样**从不清理**（删除会掩盖
约束 / 级联的真实行为，也让「上一轮留下的坏行」永远不可见），用 `RUN` 前缀区分每轮的行。
这带来一个真问题：`claimDue({ limit: 1 })` 会连**历史轮次**的行一起竞争，
「谁排第一」于是变成「今天先跑过谁」的抽奖。

第一版的做法是把本轮的行钉到 7 天前（`pin()`）—— **不够**：
上一轮也钉过 7 天前，比本轮的 7 天前更早，于是 B2 仍然红。

最终做法是 `drain()`：在造行**之前**把「此刻所有可领的行」一次性领走
（`claimDue({ limit: 100_000, claimTimeoutMs: 60_000 })`），`claimedAt` 被刷成现在 ⇒
60s 内它们不可再领 ⇒ **本轮新造的行是唯一可领的行**。
★ 这不是「清理数据」，是把不可控的历史状态压成可控的起始条件 ——
`ORDER BY` 的真实性仍由 B2 用 `ageOut()`（把某行 `nextAttemptAt` 往过去挪）单独证明。

---

## 3. 落地清单（文件级）

### 3.1 新增

| 文件 | 作用 |
|---|---|
| `prisma/migrations/20261024150000_push_retry_job/migration.sql` | `PushRetryStatus` 枚举 ＋ `PushRetryJob` 表 ＋ 4 个索引（`dedupeKey` 唯一 / `(status, nextAttemptAt)` / `(recipientUserId, createdAt)` / `expiresAt`） |
| `src/notifications/push-retry.types.ts` | 状态常量与守卫 / 行与入参类型 / `buildPushRetryDedupeKey` / `parsePushMessage` / `emptyTickResult` |
| `src/notifications/push-retry.policy.ts` | `classifyPushFailure` / `backoffDelayMs` / `structuralDelayMs` / `isRetryExhausted` / `describePushFailure` / `describePushThrow` ＋ 四个常量 |
| `src/notifications/push-retry.config.ts` | `PUSH_RETRY_CONFIG` 令牌、六个环境键名、上下界、`readPushRetryConfig` |
| `src/notifications/push-retry.metrics.ts` | 进程内计数 + `consumeAlarm()` + `snapshot()` + `toLogLine()` |
| `src/notifications/push-retry.repository.ts` | `PUSH_RETRY_REPOSITORY` 端口（7 方法）＋ `NotImplementedPushRetryRepository`（全 501） |
| `src/notifications/push-retry.prisma.repository.ts` | `enqueue`（P2002 ⇒ `duplicate`）/ `claimDue`（单条 UPDATE … SKIP LOCKED … RETURNING + 应用侧排序）/ 四个 `mark*` / `expireOverdue` |
| `src/notifications/push-retry.adapter.ts` | `PushRetryAdapter`：失败即入队 + 三条约束 |
| `src/notifications/push-retry.worker.ts` | `PushRetryWorker`（`start/stop/tick/settle/settleFailure/alarmIfNeeded`）＋ `withTimeout` ＋ `describeTick` |
| `test/push-retry.test.ts` | 组 A–G，**36** 条 |
| `test-db/push-retry-db.dbtest.ts` | 组 A–C，**14** 条（真库） |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | `enum PushRetryStatus` ＋ `model PushRetryJob`（带注释说明「attempts 只对渠道故障 +1」） |
| `src/notifications/push.port.ts` | 新增 `PUSH_DELIVERY_PORT` 令牌与 `PUSH_SEND_TIMEOUT_MS`；`send()` 的约束注释改为「重试由 W6-B 承担，`send` 自己仍不许重试」 |
| `src/notifications/notifications.service.ts` | 删掉本地 `PUSH_TIMEOUT_MS`，改用导出的 `PUSH_SEND_TIMEOUT_MS`（行为不变） |
| `src/notifications/notifications.module.ts` | `resolvePushRetryRepositoryClass` / 三个 provider / `PUSH_PORT` 条件套装饰器 / `logPushRetrySelection` / 导出 `PUSH_DELIVERY_PORT`·`PUSH_RETRY_CONFIG`·`PushRetryWorker` |
| `src/main.ts` | `app.get(PushRetryWorker).start()` |
| `backend/.env.example` | 六个 `PUSH_RETRY_*` 键，逐个写明默认值与夹取区间 |



---

## 4. 证据

### 4.1 `test/push-retry.test.ts` —— 36 条（离线，端口全为替身）

| 组 | 证明了什么 |
|---|---|
| A | 退避序列逐项（30s / 1m / 2m / 4m / 8m / 16m，封顶 30m）、`attempts=0`·负数·`NaN` 按第 1 次、`classifyPushFailure` 三原因、`describePushFailure` 不带正文 |
| B | 六个旋钮：空串 / 非数字 ⇒ 默认、越界 ⇒ 夹取、小数 ⇒ 向下取整、`PUSH_RETRY_ENABLED` 只认 `0`/`false`/`off`/`no`/`disabled`（`"false "` 也关、`nope` 仍开） |
| C | 去重键的三种形状 + **不含时间**；`parsePushMessage` 对 9 种坏 payload 全返回 `null`（缺字段 / 类型不对 / `status` 非法 / 数组 / `null`） |
| D | 装饰器的三条约束：入队抛错不外抛、适配器抛错时**先入队再原样抛出**、成功时零入队、`duplicate` 计数不记为故障 |
| E | `tick()` 的结算：先 `expireOverdue` 再领取、`invalid_payload` ⇒ `dead`、transient 用满 ⇒ `dead`、structural 不涨 `attempts`、下一次越过 TTL ⇒ 直接 `expired`、单条结算抛错**不影响同批其余行**、`now` 可注入 |
| F | 指标：连续失败在成功时归零、告警只响一次且成功后重新武装、`toLogLine` 字段齐全 |
| G | `withTimeout`：超时 reject、正常 resolve、定时器被清掉（不留悬挂 timer） |

### 4.2 `test-db/push-retry-db.dbtest.ts` —— 14 条（真库，替身证明不了的）

| 组 | 用例 |
|---|---|
| A（入队） | A1 首次入队字段；★A2 同 `dedupeKey` 再入队 ⇒ `duplicate` 且**原行一个字节没变**（退避进度不重置）；★A3 **没有 User / Child 外键** —— 收件人 / 孩子不存在也能写入；A4 坏 payload ⇒ 领取时 `message === null` |
| B（领取） | B1 只领「到点且未过期」；B2 `nextAttemptAt` 升序 + `limit` 生效；B3 领取即 `sending` 且写 `claimedAt`；★B4 两条并发 `claimDue` 结果**不重叠**（`SKIP LOCKED`）；★B5 `sending` 回收：超 `claimTimeout` 能重领、刚领走的不能 |
| C（结算） | C1 `markRetry` 回 `pending` / 顺延 / 清 `claimedAt`，且**到点前不会重领**；C2 `markSent` 写 `sentAt` + `providerMessageId` 且不再被领；C3 `markDead` 终态不被后续领取；C4 `markExpired` 是**条件更新**（`sent` / `dead` 不被改写）；C5 `expireOverdue` 批量清扫 `pending` + `sending`，`sent` / `dead` 不受影响 |

★ 本套件的 `drain()` 会把**全表**可领的行都领走（见 §2.12）。它只跑在测试库里，
且不删除任何行 —— 历史行只是被推成 `sending`，60s 后又会被下一轮 `drain()` 重新领走。

---

## 5. 运维手册

### 5.1 环境变量

| 键 | 默认 | 区间 | 说明 |
|---|---|---|---|
| `PUSH_RETRY_ENABLED` | `1` | — | 只有 `0`/`false`/`off`/`no`/`disabled` 才关（拼错 ⇒ 保持开启） |
| `PUSH_RETRY_INTERVAL_MS` | `15000` | `[1000, 300000]` | 扫得太快 ⇒ 空转；太慢 ⇒ 重试窗口被错过 |
| `PUSH_RETRY_BATCH` | `20` | `[1, 100]` | 一次领太多 ⇒ 网关抖动时一次性打出去一大把 |
| `PUSH_RETRY_TTL_MS` | `86400000`（24h） | `[60000, 604800000]` | 超过它仍未送达 ⇒ `expired` |
| `PUSH_RETRY_MAX_ATTEMPTS` | `6` | `[1, 20]` | **只对渠道故障**生效 |
| `PUSH_RETRY_CLAIM_TIMEOUT_MS` | `60000` | `[10000, 600000]` | `sending` 的回收时间 |

启动日志会打出**最终生效**的四元组（间隔 / 批量 / TTL / 上限），
`enabled=false` 或「有库缺失」时是 **warn**：`推送重试队列已装配（每 15000ms，批量 20，TTL 86400000ms，渠道故障上限 6 次）`。

### 5.2 三条排查 SQL

```sql
-- ① 队列此刻的健康度（status 分布 + 最老的一条）
SELECT status, count(*), min("createdAt") AS oldest
FROM "PushRetryJob" GROUP BY status ORDER BY status;

-- ② 为什么没送出去（lastError 前缀就是原因）
SELECT "lastError", count(*) FROM "PushRetryJob"
WHERE status IN ('pending','sending','dead') GROUP BY 1 ORDER BY 2 DESC;

-- ③ 这个人的推送怎么老失败
SELECT "createdAt", event, status, attempts, "lastError"
FROM "PushRetryJob" WHERE "recipientUserId" = $1 ORDER BY "createdAt" DESC LIMIT 20;
```

`lastError` 的四种前缀即四种处置：

| 前缀 | 含义 | 该做什么 |
|---|---|---|
| `provider_error: …` | 渠道坏了（网关 5xx / 超时 / 证书） | 看网关；队列会在 TTL 内自己重试 |
| `no_device_token` | 这个人没有 active token | 等客户端上报；**不是故障** |
| `provider_not_configured` | 没配 `PUSH_WEBHOOK_URL` / 配错（启动日志有 error） | 改 `.env` 并重启 |
| `invalid_payload: …` | `payload` 列被写坏了 | 已标 `dead`，查是谁写的 |

### 5.3 手动操作（都**不要**改 `dedupeKey`）

```sql
-- 让一条 dead 重新排队（运维唯一该做的「重放」）
UPDATE "PushRetryJob"
SET status='pending', attempts=0, "nextAttemptAt"=now(), "claimedAt"=NULL
WHERE id = $1 AND status='dead';
```

- **不要**为了「多发一次」而插入一条 `dedupeKey` 相同的新行 —— 唯一约束会挡；
  想真的再发一次，必须先改（或删）原行，而这会丢掉它的历史；
- **不要**手工把 `status` 写回 `pending` 而不清 `claimedAt`：`markRetry` 都会清它，
  留着旧值会让「是否正在发送中」变得不可读；
- 表会**持续增长**（`sent` / `dead` / `expired` 都不删）。当前**没有** retention job，
  归档策略见 §6 第 6 条。

### 5.4 告警

`推送渠道连续失败 3 次（最近一次：provider_error: 网关 500）—— 请检查网关凭据 / 网络；队列会在 TTL 内继续重试`
（warn，**只在跨过阈值时打一次**，一次成功之后重新武装）。
它只写日志，**没有**接入任何外部告警通道 —— 上线前请把这行日志接进告警规则（§6 第 5 条）。


---

## 6. 仍未落地（不粉饰）

1. **这不是真 outbox。** 请求路径**仍然先同步试一次**（`NotificationsService`，1s 兜底），
   失败才入队 —— 而入队发生在**业务事务之外**。所以「业务事务已提交、进程在入队前崩掉」
   这条缝隙还在：这一条推送**永久丢失**，表里连一行都不会有。
   真正的 outbox 是「入队放进业务事务内、请求路径完全不发」，那会改变通知与账本的相对位置
   （`01` §4 的推论要重写），必须单独一轮做。
2. **没有厂商凭据 / 网关 / 客户端上报**（W6-A 的遗留一条没变）：`PUSH_WEBHOOK_URL` 不配 ⇒
   `NoopPushAdapter` ⇒ 每次推送都 `provider_not_configured` ⇒ **每一行都是 structural**。
   线上这张表目前**永远是空的**（因为连 `Notification` 都没人触发）。
3. **队列里只有两种消息**（`approval.submitted` / `approval.status_changed`）。
   `notify()` 的其它路径（站内通知本身）不入队。
4. **可能重复发送一次**：崩在「已发出去、还没标记」之间时，`claimTimeout` 之后会被重领。
   要彻底消掉这个窗口，需要渠道侧幂等（例如网关按 `dedupeKey` 去重），**目前没有**。
5. **并发度为 1**：一批 `PUSH_RETRY_BATCH` 条是**串行** `await` 的。
   一个慢网关（每条都等到 1s 兜底）会让一轮耗时 `batch × 1s`。
   提并发时要先想清楚「网关被打」与「同一批的顺序性」，现在刻意保持简单。
6. **没有 retention / 归档**：`sent` / `dead` / `expired` 永不删除。
   接生产前要么加一个按 `createdAt` 的清理任务（先归档到冷存储），要么在监控里
   把行数当指标看 —— 现在两者都没有。
7. **没有 dead 重放接口**（只有 §5.3 那条 SQL）。
8. **指标是进程内的**：随重启归零、多实例各算各的。跨实例口径请查表，不要查 `snapshot()`。
9. **告警只写日志**：没有接入任何告警通道 / 看板。
10. **真机验证仍是 0**：「孩子手机弹出通知」一次都没发生过 —— 这一行要等第 2 条落地才能划掉。

---

## 7. 复跑基线（2026-10-24 实测）

```bash
cd backend
npm run typecheck          # EXIT=0
npm run typecheck:tests    # EXIT=0
npm test                   # 34 文件 / 664 用例全通过（含 test/push-retry.test.ts 36 条）
npm run test:db            # 14 文件 / 220 用例全通过（含 test-db/push-retry-db.dbtest.ts 14 条）
npm run honesty:probe      # ALL PASS（5 项；矩阵仍 35 动作，PRD §7 表格 35 行逐行一致）
```

本轮**未复跑**：`npm run build`、`contracts:emit`、`test:canfail`、`test:canfail:db`、
各项 `*:check`、`npm run ci`。
本轮**没有**改动作矩阵（`ActionType` 未变，仍是 **35** 个动作），也没有改权限矩阵，
所以上轮基线（29 号交接单 §6）对这些闸门仍然成立 —— 但**要拿到本轮的证据，请自己跑一遍**。
迁移已用 `MIGRATION_DATABASE_URL` + `prisma migrate deploy` 部署到开发库，
`PushRetryJob` 表与 4 个索引已确认存在（`test:db` 全部通过即是证据）。

---

## 8. 下一步（建议顺序）

1. **客户端上报**（唯一不需要任何厂商凭据就能推进的一步，见 29 号交接单 §7 第 1 条）：
   没有 token，队列里每一行都是 `no_device_token` —— 结构再对也发不出去。
2. **网关 + 真实适配器**：网关按 `dedupeKey` 去重即可把 §6 第 4 条关掉；
   `410` 必须回 `invalidTokens`（W6-A 的下线逻辑原样复用）。
3. **把入队搬进业务事务**（真 outbox）：`Notification` + `PushRetryJob` 同事务落库，
   请求路径**不再发送**，worker 成为唯一发送者。这是本项目推送链路的最后一块结构性欠账。
4. **retention**：按 `createdAt` 归档 `sent` / `expired`，`dead` 保留更久（它是证据）。
5. **可观测**：把 `toLogLine()` 与实际 `status` 分布接到看板；把连续失败告警接进告警通道；
   加一条「`pending` 里最老的一条超过 1 小时」的告警（它比失败率更早发现问题）。
6. **提并发**（可选）：`batch` 内并行发送时要给网关留背压 —— 现在不做是刻意的。

