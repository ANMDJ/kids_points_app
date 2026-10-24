# 阶段 W6-C 交接单 · 审批通知的真 outbox（`Notification` + `PushRetryJob` 同事务）

> **日期**：2026-10-24　**阶段**：W6-C（WF-6「真实推送」的结构性收尾）
> **给**：接手「接 APNs / FCM / 微信」「客户端 token 上报」「通知对账与可观测」的下一个会话。

**一句话**：W6-B 的第 3 条欠账（真 outbox）已落地 —— 审批提交 / 批准 / 拒绝时，
`Notification` 与 `PushRetryJob` 在**审批的同一个数据库事务**里写入，请求路径**一次推送都不发**，
`PushRetryWorker` 成为唯一发送者。**但**仍然没有厂商凭据 / 网关 / 客户端 token 上报，
所以线上只会「有站内通知、没有手机弹窗」，队列里的行最终会因结构性失败在 TTL 后 `expired`。

---

## 1. 本阶段做了什么

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 审批文案与消息构造（纯函数，从 service 搬出） | `src/notifications/approval-notification.content.ts` |
| 2 | outbox 端口 + Prisma 实现 + 无库 501 实现 | `src/notifications/notifications.outbox.ts` |
| 3 | `NOTIFICATIONS_OUTBOX` 装配；`PUSH_PORT` 不再套重试装饰器，直接别名 `PUSH_DELIVERY_PORT` | `src/notifications/notifications.module.ts` |
| 4 | `createPending` / `decide(approved/rejected)` 在事务内调用 outbox | `src/approvals/approvals.prisma.repository.ts` |
| 5 | `NotificationsService` 收敛为**只读**（删除 `notifyApproval*`、推送依赖、文案） | `src/notifications/notifications.service.ts` |
| 6 | `ApprovalsService` 删除 `NotificationsService` 依赖与提交后的通知调用 | `src/approvals/approvals.service.ts` |
| 7 | 离线用例：outbox 收件人 / 去重 / 文案 / 失败边界 / 501 | `test/notifications-outbox.test.ts`（8 条） |
| 8 | 真库用例：同事务两行、真实监护人解析、outbox 抛错回滚审批 | `test-db/approvals-outbox-db.dbtest.ts`（3 条） |
| 9 | 改写 HTTP 用例：请求路径**零推送、零通知写入** | `test/approvals-http.test.ts` 组 G / H |

**没有改**：`PushRetryJob` 表结构、worker 的领取 / 退避 / 结算逻辑、`PushPort` / `PushResult` 形状、
`Notification` 读接口（`GET /notifications`、`PATCH /notifications/:id/read`）、
任何账本表 / 业务表、权限矩阵。

---

## 2. 关键实现决策

### 2.1 为什么「在审批事务里写两行」不违反 `01` §4

`01` §4 禁止的是把**外部推送**放进账本事务：推送服务不可靠，网关 500 会回滚一笔已经成立的加分。
本阶段写进事务的只有**同一个 Postgres 里的两行本地数据**（`Notification`、`PushRetryJob`），
不调用任何第三方。外部投递仍然只发生在 `PushRetryWorker` 里、事务之外。

失败边界因此变成两句话：

- **outbox 写失败 ⇒ 审批事务回滚**（审批与提醒同生共死，不会「批了但没人知道」）；
- **外部推送失败 ⇒ 只影响 `PushRetryJob` 的 attempts / status**，永远不回滚账本。

### 2.2 唯一发送者：`PUSH_PORT` 现在就是 `PUSH_DELIVERY_PORT`

W6-B 里 `PUSH_PORT = new PushRetryAdapter(delivery)`，业务路径仍会同步试发一次、失败才入队。
W6-C 把 `PUSH_PORT` 改成 `useExisting: PUSH_DELIVERY_PORT`：

| 令牌 | 谁用 | 现在做什么 |
|---|---|---|
| `PUSH_PORT` | 业务（目前没有业务调用方） | 原始适配器，只发一次；**审批路径不再调用** |
| `PUSH_DELIVERY_PORT` | `PushRetryWorker` | 原始适配器，worker 的唯一投递出口 |

保留 `PUSH_PORT` 是为了不破坏既有装配 / 用例的注入点，但它**不再是「带自动入队」的端口**。
`PushRetryAdapter` 仍留在代码里供需要「失败即入队」的其它场景使用，审批不再使用它。

### 2.3 收件人解析放在 outbox，而不是 service

`approval.submitted` 的收件人是这个孩子的 **active guardian**（`ChildMember.role='guardian'`
且 `status='active'`），并**排除提交人**。解析与写入在同一个事务里：

- 家长自己提交、需要另一位确认时，不会只发给自己；
- 提交那一刻成员位是什么样，通知就发给谁（不跨时间回查）；
- 同一 `userId` 去重、空 id 丢弃（坏数据不变成发给 `''` 的通知）。

`approval.status_changed` 的收件人固定是 `ApprovalRequest.requesterUserId`（申请人）。

### 2.4 去重：先查 `dedupeKey`，再写两表

写入顺序是：`findMany(dedupeKey in keys)` → 过滤已存在的条目 → `notification.createMany` →
`pushRetryJob.createMany({ skipDuplicates: true })`。

- 已存在的键**整条跳过**，避免「站内多一条、队列没有」的两边对不上；
- 竞态兜底仍靠唯一约束，跳过的条数计入 `duplicates` 指标；
- 审批路径本身不会并发写同一键：`decide` 先 `FOR UPDATE` 锁行，`createPending` 每次是新审批 id。

★ 仍有**极小的竞态窗口**：查完到写入之间，另一个事务可能插入同一 `dedupeKey`。
此时队列不会重复，但可能多出一条站内通知；当前**没有对账任务**（见 §5 第 2 条）。

### 2.5 失败是响亮的，不是吞掉的

`NotificationsOutboxPort` 的方法**允许抛错**，`PrismaApprovalsRepository` 不捕获：

- 审批事务回滚 ⇒ 不会出现「approved 了但通知表没有行」；
- `PushRetryMetrics.recordEnqueueFailure()` 记一次；
- 无库装配用 `NotImplementedNotificationsOutbox` 抛 501，绝不假装写入成功。

这与 `NotificationsService` 旧口径（「通知永不抛错」）不同，是**刻意**的：
旧口径保护的是「已提交的审批不被通知失败改写」；现在通知写入是审批事务的一部分，
它失败时审批本来就没有提交，因此必须让调用方看见失败。

### 2.6 `invalidated` / `expired` / `withdrawn` 不写结论通知

- `invalidated`（前提消失）与 `expired`（TTL 到期）不是「家长的决定」，
  给申请人的文案若写成「未通过」会让家长莫名背锅；当前**不写**。
- `withdrawn`（申请人自己撤回）也不写：申请人知道自己撤回了。
- `createSelfApproved`（创建时显式自批）不写 outbox：收件人就是批准人自己，属于噪音。

这些与 W5-K/W5-M 的行为一致，但**是产品口径，不是技术限制**；若产品要求
「兑换失败也要告诉孩子」，应新增 `approval.invalidated` 文案并在这里补一条调用。


---

## 3. 落地清单（文件级）

### 3.1 新增

| 文件 | 作用 |
|---|---|
| `src/notifications/approval-notification.content.ts` | `approvalLabel` / 两种文案 / 两种消息构造（纯函数） |
| `src/notifications/notifications.outbox.ts` | `NOTIFICATIONS_OUTBOX`、端口、Prisma 实现、无库实现 |
| `test/notifications-outbox.test.ts` | 8 条离线用例（收件人、去重、失败、501） |
| `test-db/approvals-outbox-db.dbtest.ts` | 3 条真库用例（同事务、真实监护人、回滚） |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `src/notifications/notifications.module.ts` | 注册 outbox；`PUSH_PORT` 别名原始适配器；导出 outbox |
| `src/notifications/notifications.service.ts` | 只保留 `list` / `markRead`；删除推送与写入依赖 |
| `src/approvals/approvals.prisma.repository.ts` | `createPending` 与 `decide` 的两个终态分支调用 outbox |
| `src/approvals/approvals.service.ts` | 删除 `NotificationsService` 依赖与提交后调用 |
| `src/notifications/push-retry.metrics.ts` | `recordEnqueued` / `recordDuplicate` 接受条数 |
| `test/approvals-http.test.ts` | 组 G/H 改为「请求路径零推送 / 零通知写入」 |
| `test/notifications.test.ts` | 按只读 service + 模块装配改写 |

---

## 4. 证据

### 4.1 离线（`npm test`）

- `test/notifications-outbox.test.ts` —— 8 条：
  - 两位 guardian 各一条 `approval.submitted`，提交人不在收件人里；
  - 无 guardian（或全被排除）⇒ 零写入，审批仍可提交；
  - 同一 `dedupeKey` 已存在 ⇒ 不重复写通知 / 队列，`duplicates` 计数正确；
  - `approval.status_changed` 只发申请人，文案 / payload 形状正确；
  - outbox 写失败 ⇒ 错误上抛，不被吞掉；
  - 无库实现 ⇒ 501 `NOTIFICATIONS_OUTBOX_NOT_IMPLEMENTED`。
- `test/approvals-http.test.ts` 组 G/H —— 请求路径**一次推送都没发**、**一次通知都没写**；
  审批结果不受「推送端口抛错」影响（因为根本没调用）。

### 4.2 真库（`npm run test:db`）

`test-db/approvals-outbox-db.dbtest.ts` —— 3 条：

1. 孩子提交 `add_wish` ⇒ 202；`Notification` 两条（两位 active guardian）、`PushRetryJob` 两条，
   去重键分别为 `approval.submitted:<id>:<dad>` / `:<mom>`，提交人没有；
2. 家长批准 ⇒ 200；申请人一条 `approval.approved`，队列一条
   `approval.status_changed:<id>:<kid>:approved`；
3. 注入「outbox 必抛」的端口直接调 `createPending` ⇒ 审批行随事务回滚，一行都不留。

第 3 条是离线替身证明不了的：它验证的是真实的 `$transaction` 回滚，而不是一个内存返回值。

---

## 5. 仍未落地（不粉饰）

1. **没有厂商凭据 / 网关 / 客户端 token 上报**（W6-A 遗留未变）：
   `PUSH_WEBHOOK_URL` 不配 ⇒ `NoopPushAdapter` ⇒ 每条任务 `provider_not_configured`（structural），
   不消耗 attempts，5 分钟重试一次，直到 24h TTL 后 `expired`。
   **「孩子手机弹出通知」仍然一次都没发生过。**
2. **没有对账任务**：§2.4 的极小竞态若真的发生，可能多出一条 `Notification` 而没有对应任务。
   当前只能靠人工按 `payload.approvalId` 对比两表；没有定时对账 / 自动修复。
3. **`invalidated` / `expired` / `withdrawn` / 创建时自批不发通知**（见 §2.6，产品口径待确认）。
   注意：走 `/decide` 的「两步式自批」仍会给申请人（= 批准人）发一条结论通知 ——
   这是 W6-C 之前就有的行为，本轮未改；若要按「自批是噪音」处理，需在 outbox 调用处
   判断 `decidedByUserId === requesterUserId` 并跳过。
4. **`PushRetryJob` 没有 retention / 归档**：`sent` / `dead` / `expired` 永不删除；
   现在每条审批都会产生行，增长会比 W6-B 更快，接生产前必须定归档策略。
5. **worker 只在 `main.ts` 启动**：若以其它方式嵌入 `AppModule`（脚本、测试、Serverless 入口）
   而没调 `PushRetryWorker.start()`，outbox 行会一直 `pending`。部署检查清单要包含这一条。
6. **指标仍是进程内的**：`PushRetryMetrics.snapshot()` 随重启归零、多实例各算各的；
   跨实例口径请查 `PushRetryJob` 表。
7. **没有 dead 重放接口**，也没有外部告警通道（连续失败只写 warn 日志）。
8. **`notification` 与 `job` 的写入不是「一个 SQL」**：同一事务里的两条 `createMany`，
   `notification` 先写；若第二条失败，事务回滚两条都消失，语义上仍是全有或全无。


---

## 6. 运维提示（W6-C 新增）

```sql
-- 某条审批的站内通知与推送任务是否成对（正常应一一对应）
SELECT n."recipientUserId", n.type, j."dedupeKey", j.status, j."lastError"
FROM "Notification" n
LEFT JOIN "PushRetryJob" j
  ON j."recipientUserId" = n."recipientUserId"
 AND j.payload->>'approvalId' = n.payload->>'approvalId'
WHERE n.payload->>'approvalId' = $1
ORDER BY n."createdAt";

-- outbox 写了、但队列里没有对应行（对账缺口）
SELECT n.*
FROM "Notification" n
WHERE n.type IN ('approval.submitted', 'approval.approved', 'approval.rejected')
  AND NOT EXISTS (
    SELECT 1 FROM "PushRetryJob" j
    WHERE j."recipientUserId" = n."recipientUserId"
      AND j.payload->>'approvalId' = n.payload->>'approvalId'
      AND j.event = CASE n.type
        WHEN 'approval.submitted' THEN 'approval.submitted'
        ELSE 'approval.status_changed'
      END
  );
```

启动日志应出现：

- `推送重试队列已装配（每 …ms，批量 …，TTL …ms，渠道故障上限 … 次）`；
- 未配网关时：`未配置 PUSH_WEBHOOK_URL —— 推送使用 no-op（provider_not_configured）`。

若只有前者、没有后者：先确认日志级别包含 `debug`（no-op 那行是 `Logger.debug`）；
级别够还看不到，说明网关已配置（此时应出现 `推送走 webhook 网关`）。
若两者都没有：`PUSH_RETRY_ENABLED=0` / 无库时会打 `warn`，否则检查 `NotificationsModule` 是否被导入。

---

## 7. 复跑基线（2026-10-24 实测）

```bash
cd backend
npm run prisma:validate    # valid
npm run typecheck          # EXIT=0
npm run typecheck:tests    # EXIT=0
npm run build              # nest build 成功
npm test                   # 35 文件 / 653 用例全通过
npm run test:db            # 15 文件 / 223 用例全通过（含本轮新增 3 条）
npm run test:canfail       # ALL PASS（8 项）
npm run test:canfail:db    # ALL PASS（11 项）
npm run honesty:probe      # ALL PASS（5 项，矩阵仍 35 动作）
npm run defects:check      # ALL PASS（对账 19 条）
npm run templates:check    # ALL PASS
npm run icons:check        # ALL PASS（7 项）
npm run relation:check     # ALL PASS（5 项）
npm run restrictions:check # ALL PASS
```

本轮**未复跑**：完整 `npm run ci` / `npm run ci:db`（上面的命令已逐条跑过）。
`npm run contracts:emit` 已跑，35 个动作，产物无 diff。

---

## 8. 下一步（建议顺序）

1. **客户端上报 device token**：没有 token，队列里每一行都是 `no_device_token`；
   这是唯一不需要厂商凭据就能推进的一步。
2. **网关 + 真实适配器**：网关按 `dedupeKey` 去重，可同时关掉「崩溃重领导致重复发送」的窗口。
3. **对账任务**：按 §6 的 SQL 定时找「通知有、任务无」与「任务有、通知无」；
   发现后只告警、不自动补发（补发必须人工确认，避免二次打扰）。
4. **retention**：按 `createdAt` 归档 `sent` / `expired`，`dead` 保留更久（它是证据）。
5. **产品确认**：`invalidated` / `expired` 是否要通知申请人；若要，补文案与 outbox 调用。
6. **可观测**：把 `toLogLine()`、`status` 分布、最老 `pending` 时长接入看板与告警通道。
