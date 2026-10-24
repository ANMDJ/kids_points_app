# 阶段 W6-D 交接单 · 通知 / 推送对账（只告警）＋ `PushRetryJob` 保留清理

> **日期**：2026-10-24　**阶段**：W6-D（W6 里**不需要厂商凭据**的最后两件事）
> **给**：接手「接 APNs / FCM / 微信网关」「客户端 token 上报」「把告警接到外部通道」的下一个会话。

**一句话**：W6-C 交接单 §5 的第 2 条（没有对账）与第 4 条（没有 retention）已落地 ——
新增一个**只读、只告警、绝不自动补发**的对账 worker，和一个只删 `sent` / `expired` / `dead`
的分批清理 worker。**但**仍然没有厂商凭据 / 网关 / 客户端 token 上报，
所以「孩子手机弹出通知」依然一次都没发生过；对账在这种情况下会**安静**（见 §2.3）。

---

## 1. 本阶段做了什么

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 对账端口 / 配置 / 漂移判定 / 日志级别 / 无库 501 | `src/notifications/notifications.reconcile.ts` |
| 2 | 对账的 Prisma 实现（两段 `NOT EXISTS` ＋ 一段 `GROUP BY` ＋ 状态分布） | `src/notifications/notifications.reconcile.prisma.repository.ts` |
| 3 | 对账 worker（默认 5 分钟一轮，启动即跑一轮，`unref()`，防重入） | `src/notifications/notifications.reconcile.worker.ts` |
| 4 | 保留策略端口 / 三档保留期 / 截止线 / 无库 501 | `src/notifications/push-retry.retention.ts` |
| 5 | 保留清理的 Prisma 实现（`DELETE … WHERE id IN (SELECT … ORDER BY updatedAt LIMIT n)`） | `src/notifications/push-retry.retention.prisma.repository.ts` |
| 6 | 保留清理 worker（默认 1 小时一轮，每状态最多 10 批 × `batchSize`） | `src/notifications/push-retry.retention.worker.ts` |
| 7 | 装配：两个端口 / 两份配置 / 两个 worker 的 provider + export，无库时选 501 实现 | `src/notifications/notifications.module.ts` |
| 8 | 启动：`NotificationsReconcileWorker.start()` / `PushRetryRetentionWorker.start()` | `src/main.ts` |
| 9 | 索引 `@@index([status, updatedAt])` ＋ 手工迁移 | `prisma/schema.prisma`、`prisma/migrations/20261025090000_push_retry_retention_index/` |
| 10 | 离线用例 40 条（对账 19 ＋ 保留 21） | `test/notifications-reconcile.test.ts`、`test/push-retry-retention.test.ts` |
| 11 | 真库用例 17 条（对账 11 ＋ 保留 6） | `test-db/notifications-reconcile-db.dbtest.ts`、`test-db/push-retry-retention-db.dbtest.ts` |

**没有改**：`Notification` / `PushRetryJob` 的写入路径（W6-C 的 outbox）、worker 的领取 / 退避 / 结算逻辑、
`GET /notifications`、权限矩阵（仍 35 个动作）、任何账本表。

---

## 2. 关键实现决策

### 2.1 对账只读、只告警，**不自动补发**

「自动补一条推送」听起来贴心，实际是**再打扰用户一次**。缺口有两种完全相反的原因：

- 通知写了、任务被人工删了 ⇒ 补发是对的；
- 任务写得对、通知是脏数据（或用户已经被别处告知）⇒ 补发就是二次打扰。

对账端口的形状因此只有 `snapshot(now)`，**连一个写方法都没有**：
想让机器补发也没有 API 可调。发现缺口后按 §4 的 runbook 人工处置。

### 2.2 匹配键为什么必须是「收件人 + approvalId + 事件语义」三层

两表之间**没有外键**（W6-B 刻意如此：投递事实要比业务行活得久），能对上的只有 outbox
写两行时用的同一个 `payload.approvalId` 与同一个收件人：

| `Notification.type` | ⇔ | `PushRetryJob.event` | 附加条件 |
|---|---|---|---|
| `approval.submitted` | | `approval.submitted` | — |
| `approval.approved` / `approval.rejected` | | `approval.status_changed` | `payload.status` 必须与通知类型一致 |

三个条件缺一不可，各自都有真库用例证明：

- 少了 **`payload.status`** ⇒ 「批准通知」与「拒绝任务」会被错配成一对（真库 D1：应 1/1，错配则 0/0）；
- 少了 **`recipientUserId`** ⇒ 同一 `approvalId` 的「发给家长的 submitted」会替
  「发给孩子的 status_changed」作证，对账**恒为 0**（真库 C1）。这是最容易写错的一条：
  单看 approvalId 一切正常，只有收件人条件能拆开两组行。

### 2.3 什么**不**算漂移：状态分布

`dead` / `expired` / `pending` 的条数**不参与**漂移判定，只是随日志一起打出来（`describeReconcile`）。
理由很具体：当前没有网关 ⇒ 每条任务最终都会 `expired`。若把 `expired > 0` 当成错误，
对账会从上线第一天起**永远报警**，而「永远为真的告警」等于没有告警。

`oldestPendingAgeMs` 同理只是观测值（`null` 表示一条 pending 都没有，和「等了 0ms」不是一回事）。

### 2.4 `duplicateNotifications`：为什么「配对都齐」也可能有漂移

W6-C 的去重是「先查 `dedupeKey`、再写两表 + `skipDuplicates`」。并发窗口里可能多写一条
**站内通知**（队列有唯一约束，不会重复）。这种漂移在「配对存在性」看来**完全健康**：
两边的行都找得到对面。所以在两段 `NOT EXISTS` 之外还有一段分组计数：

```sql
SELECT COALESCE(sum(cnt - 1), 0)::int
FROM (
  SELECT count(*) AS cnt
  FROM "Notification"
  WHERE type IN ('approval.submitted','approval.approved','approval.rejected')
  GROUP BY "recipientUserId", "type", payload->>'approvalId'
  HAVING count(*) > 1
) g
```

分组键与 outbox 的去重键**同构**：少 `type` 会把「approved + rejected 各一条」误判成重复；
少 `recipientUserId` 会把「两位家长各一条」误判成重复（真库 F2 就测这个）。
`payload.approvalId` 为 `NULL` 的行会互相成组 —— 那是脏数据（审批提醒必带 approvalId），
算成重复方向正确。

### 2.5 保留清理：只删三个终态，三档保留期，时间字段是 `updatedAt`

| 状态 | 默认保留 | 依据 |
|---|---|---|
| `sent` | 7 天 | 已送达；留一周够回答「那天到底发了没」 |
| `expired` | 7 天 | 结构性失败（没配网关 / 没设备），同一批原因 |
| `dead` | 30 天 | **它是证据**：渠道反复失败通常要事后复盘 |
| `pending` / `sending` | **永不删** | 一个还没送、一个可能正在送；删了等于丢消息 / 重复发送 |

时间字段选 `updatedAt` 而不是 `sentAt`：`expired` / `dead` 没有各自的「终结时刻」列，
三条终态路径都只做一次 `updateMany`，`updatedAt` 恰好就是那个时刻。
**代价**：人工改过某行的 `lastError` 会把保留期从改动时刻重算 —— 归档任务里这是可接受的
保守方向（晚删 > 误删）。真库 D1 专门测「`createdAt` 很老但 `updatedAt` 很新 ⇒ 不删」。

### 2.6 分批 + 部分失败仍抛：`DELETE` 必须有上限

`deleteMany` **不支持 `limit`**，所以适配器手写：

```sql
DELETE FROM "PushRetryJob"
WHERE "id" IN (
  SELECT "id" FROM "PushRetryJob"
  WHERE "status" = $1::"PushRetryStatus" AND "updatedAt" < $2
  ORDER BY "updatedAt" ASC LIMIT $3
)
```

- 每批 `batchSize`（默认 500）、每状态每轮最多 10 批（`PUSH_RETRY_RETENTION_MAX_ROUNDS`）；
  删不完下一轮继续，不漏、只是慢；
- 严格 `<`：`updatedAt` 恰好等于截止线的行**保留**（真库 B1），否则反复重跑会出现「边界行随机消失」；
- 三个状态各自 `try/catch` 继续 —— 一个状态失败不该让另外两个也停；
  **但一轮里只要有失败，tick 结束时仍会抛错**（worker 记 error）：
  部分成功不是成功，吞掉它就等于「清理过了」；
- 适配器在发 SQL 前用**运行期白名单**再验一次状态：TS 联合类型在运行时不存在，
  有人用 `as` 或 JS 调用传 `'pending'`，就等于删掉还没发出去的行（真库 E1）。

### 2.7 无库装配：501，**不**返回全零

`NotImplementedNotificationsReconcile.snapshot()` 抛 501，而不是返回一份全零快照 ——
全零会被 worker 读成「一切正常」，而我们**一行都没查过**。
`NotImplementedPushRetryRetention.deleteSettled()` 同样抛 501，而不是返回 0 条删除 ——
那会被日志读成「清理完成」。这与 `NotImplementedNotificationsRepository`
「不返回空列表冒充没有通知」是同一条纪律。

---

## 3. 落地清单（文件级）

### 3.1 新增

| 文件 | 作用 |
|---|---|
| `src/notifications/notifications.reconcile.ts` | 端口、快照类型、`hasReconcileDrift` / `reconcileLogLevel` / `describeReconcile`、配置读取、501 实现 |
| `src/notifications/notifications.reconcile.prisma.repository.ts` | 两段 `NOT EXISTS` ＋ 重复计数 ＋ 状态分布 ＋ 最老 pending |
| `src/notifications/notifications.reconcile.worker.ts` | 定时器、首轮立即执行、防重入、异常记 error |
| `src/notifications/push-retry.retention.ts` | 端口、三档保留期、`retentionCutoffs`、配置读取、501 实现 |
| `src/notifications/push-retry.retention.prisma.repository.ts` | 分批 `DELETE` ＋ 运行期状态白名单 |
| `src/notifications/push-retry.retention.worker.ts` | 定时器、批循环、部分失败仍抛 |
| `prisma/migrations/20261025090000_push_retry_retention_index/` | `(status, updatedAt)` 索引 |
| `test/notifications-reconcile.test.ts` | 19 条离线用例 |
| `test/push-retry-retention.test.ts` | 21 条离线用例 |
| `test-db/notifications-reconcile-db.dbtest.ts` | 11 条真库用例 |
| `test-db/push-retry-retention-db.dbtest.ts` | 6 条真库用例 |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | `PushRetryJob` 增 `@@index([status, updatedAt])`（`claimDue` 用的 `(status, nextAttemptAt)` 保留） |
| `src/notifications/notifications.module.ts` | 两个端口 / 两份配置 / 两个 worker 的装配与导出；新增 `reconcile` / `retention` 装配选项与选择日志 |
| `src/main.ts` | 启动两个 worker（与 `PushRetryWorker` 同一位置） |
| `.env.example` | 新增 8 个旋钮（对账 2 个、保留清理 6 个）及关闭语义 |

---

## 4. 人工处置 runbook（对账报警之后）

> 对账**不会**替你做任何写入。下面全部是人工 SQL，执行前先确认 `DATABASE_URL` 指向的不是生产。

### 4.1 先看这条审批的两侧现状

```sql
-- 把 $1 换成报警日志里那条 approvalId（payload.approvalId）
SELECT 'notification' AS side, n.id, n."recipientUserId", n.type AS kind, n."createdAt" AS at
FROM "Notification" n
WHERE n.payload->>'approvalId' = $1
UNION ALL
SELECT 'job', j.id, j."recipientUserId",
       j.event || COALESCE(':' || (j.payload->>'status'), ''), j."createdAt"
FROM "PushRetryJob" j
WHERE j.payload->>'approvalId' = $1
ORDER BY side, at;
```

### 4.2 只有通知、没有任务（`notificationsWithoutJob`）

1. 先确认任务是否真的缺：上面 SQL 里 `job` 那半为空，或 `event` / `payload.status` 与通知类型不匹配；
2. **只有当 `approval.submitted` 那条通知对应的家长确实还需要手机提醒**、且没超过 TTL 时，才补一条任务：

```sql
INSERT INTO "PushRetryJob"
  (id, event, "dedupeKey", payload, "recipientUserId", "childId", status,
   attempts, "maxAttempts", "nextAttemptAt", "expiresAt", "createdAt", "updatedAt")
VALUES
  ('manual-' || gen_random_uuid()::text,
   'approval.status_changed',
   'approval.status_changed:<approvalId>:<userId>:approved',  -- 形状必须与 outbox 一致
   '{"type":"approval.status_changed","approvalId":"<approvalId>","status":"approved", ...}'::jsonb,
   '<userId>', '<childId>', 'pending', 0, 6, now(), now() + interval '24 hours', now(), now());
```

★ `dedupeKey` 形状写错（少 `:approved` 后缀）会让将来真的重复入队，先对照
`buildPushRetryDedupeKey`。**不要**为了让对账归零而补一条「用户不需要」的推送 ——
补出来的是一条真实弹窗。

### 4.3 只有任务、没有通知（`jobsWithoutNotification`）

站内通知是**事实记录**（用户回看消息列表），一般不删。要么补一条通知（不带新任务）：

```sql
INSERT INTO "Notification"
  (id, "childId", "recipientUserId", "recipientRole", type, title, body, payload, "createdAt")
VALUES ('manual-' || gen_random_uuid()::text, '<childId>', '<userId>', 'guardian',
        'approval.submitted', '<与 outbox 一致的文案>', '<同上>',
        jsonb_build_object('approvalId', '<approvalId>'), now());
```

要么确认这条任务是脏数据，按 §4.5 处理。

### 4.4 重复的站内通知（`duplicateNotifications`）

```sql
-- 找出多出来的那几条（每组保留 createdAt 最早的一条）
SELECT id, "recipientUserId", type, payload->>'approvalId' AS approval_id, "createdAt"
FROM "Notification"
WHERE type IN ('approval.submitted','approval.approved','approval.rejected')
  AND payload->>'approvalId' = $1
ORDER BY "recipientUserId", type, "createdAt";
```

确认是同一事实的重复后，删除多余行（保留最早一条；`readAt` 已读也照删 —— 保留的是同内容）。
**不要**连带删任务：队列里本来就只有一条。

### 4.5 处置完的验收

等下一轮（默认 5 分钟）看日志是否变成
`通知 / 推送对账无缺口：notifications_without_job=0 jobs_without_notification=0 duplicate_notifications=0 …`
（这行是 `debug` 级别；只看得到 warn 的话，直接重跑本节 4.1 的 SQL 确认两侧配平）。

---

## 5. 已知代价与仍未落地（不粉饰）

1. **`payload` 是 JSON 列，没有索引**：两段 `NOT EXISTS` 与重复计数都要解 JSON；
   当前数据量下 5 分钟一轮可以接受，但代价随 `Notification` / `PushRetryJob` 行数线性增长。
   数据量上来后应改为**写入时冗余一列 `approvalId`**（可索引），
   **不要**给 `payload->>` 建表达式索引 —— 后者同样会随 JSON 形状漂移。
2. **对账没有时间窗口、没有分页、没有超时**：每次都是全表口径。表大到一轮跑不完时，
   现在的行为是「跳过本轮」（防重入），日志里只有一条 `debug`，
   运维需要从「最老 pending 时长」或 `duplicate_notifications` 是否持续不降来判断。
3. **对账只能发现「单边缺失」与「通知重复」，发现不了「两侧都被删」**：
   两表都没有外键、也没有第三处事实源；要发现这种缺失只能反过来扫
   `ApprovalRequest`（当前没有做，`invalidated` / `expired` 也不在通知口径内）。
4. **保留清理删的是证据**：`sent` 超过 7 天、`dead` 超过 30 天后就无法回答
   「那条推送当时到底发了没」。要长期留证据必须**先归档到别处**（本阶段没做），
   靠调大 `PUSH_RETRY_RETENTION_*_MS` 只能把问题往后推。
5. **`updatedAt` 口径的副作用**：人工改过一行（例如补 `lastError`）会把它的保留期
   从改动时刻重新算起。方向是保守的（晚删 > 误删），但「30 天后必然消失」这句话
   对人工改过的行不成立。
6. **多实例没有任何分布式锁**：N 个实例就会打 N 份对账告警、并让清理互相争行锁
   （清理本身幂等，不会多删；但同一批行可能被两个实例各试一次）。上多实例前应加
   advisory lock 或改成单实例任务。
7. **告警只写日志**：warn / error 没有接外部通道（与 W6-B 一致），没有 dead 重放接口，
   也没有 dry-run（想先看会删多少行，只能手动跑对应的 `SELECT count(*)`）。
8. **保留期是全表统一口径**：不能按孩子 / 租户区分，也没有「某些 `dead` 永久保留」的白名单。
9. **真机推送仍未验证**（W6-A 遗留不变）：没有厂商凭据、没有网关实现、没有客户端 token 上报。
   对账在这种情况下**不会**因为「队列里全是 expired」而报警 —— 见 §2.3，这是刻意的。

---

## 6. 复跑基线（2026-10-24 实测）

```bash
cd backend
npm run prisma:validate    # valid
npx prisma migrate status  # 9 个迁移全部已应用（含 20261025090000_push_retry_retention_index）
npm run typecheck          # EXIT=0
npm run typecheck:tests    # EXIT=0
npm test                   # 37 文件 / 693 用例全通过（本轮新增 40 条）
npm run test:db            # 17 文件 / 240 用例全通过（本轮新增 17 条）
npm run test:canfail       # ALL PASS（8 项）
npm run test:canfail:db    # ALL PASS（11 项）
npm run honesty:probe      # ALL PASS（5 项，矩阵仍 35 动作）
npm run defects:check      # ALL PASS（对账 19 条）
npm run templates:check    # ALL PASS
npm run icons:check        # ALL PASS（7 项）
npm run relation:check     # ALL PASS（5 项）
npm run restrictions:check # ALL PASS
```

> **一次已知的假红（与本轮无关，重跑即绿）**：`npm test` 有时候会在
> `test/read-http.test.ts` 的「默认装配（只读端口未注入）⇒ 501」上失败，
> 报 `fetch failed / cause: bad port`。原因是该文件用 `app.listen(0)` 让系统分配端口，
> 而 Undici（Node 内置 `fetch`）**拒绝连接一批「不安全端口」**（如 6697 / 6667 等），
> 系统偶尔正好分到其中之一 —— 与服务端行为无关。重跑 `npm test` 即可（本轮实测 693/693）。
> 真正的修法是给 `listen(0)` 加「落到受限端口就重试」的重试器（尚未做，属测试基建债）。

---

## 7. 下一步（建议顺序）

1. **客户端上报 device token**（W6-A 遗留）：没有 token，每一行都是 `no_device_token`，
   这是唯一不需要厂商凭据就能推进的一步。
2. **网关 + 真实适配器**：网关按 `dedupeKey` 去重，可同时关掉「崩溃重领导致重复发送」的窗口。
3. **把告警接出去**：`通知 / 推送对账发现缺口` 与 `保留清理失败` 两行日志接 Slack / 邮件；
   否则这两条 worker 的价值只剩「事后翻日志」。
4. **对账加时间窗口 / 增量口径**（见 §5 第 1、2 条）：先冗余 `approvalId` 列，再把扫描限定在最近 N 天。
5. **保留清理加归档**：删除前把行导出（对象存储 / 冷表），解决 §5 第 4 条。
6. **多实例加锁**（§5 第 6 条）：advisory lock 或单实例调度。
