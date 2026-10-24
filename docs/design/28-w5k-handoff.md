# 阶段 W5-K 交接单 · 审批结论推送端口（channel-agnostic push port）

> **状态（2026-10-23）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm run typecheck` / `typecheck:tests` | ✅ 退出码 **0** / **0** |
> | `cd backend && npm test` | ✅ **565/565**（W5-J 基线 553，本阶段 **+12**） |
> | `flutter analyze` | ✅ `No issues found!`（客户端**未改**，仅复验） |
> | `flutter test test/write_api_test.dart test/approvals_test.dart` | ✅ **127/127**（同上） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0**（小程序**未改**） |
> | 迁移 | **0 条**：`Notification` / `DeviceToken` 表 W0 已建，本阶段一行都没写 |
>
> **给**：接手「接 APNs / FCM / 微信订阅消息」「站内通知中心」「设备 token 上报」的下一个会话。

## 1. 本阶段做了什么

W5-D 之后，家长能在收件箱点「同意 / 拒绝」；W5-J 之后，孩子能在「我的申请」里看到终态。
但两边之间**没有任何连接**：孩子不主动重新打开那个面板，就永远不知道结果。
`27-w5j-handoff.md` §5 把这条列为「没有推送 / 没有角标」。

W5-K 把「审批结果 → 通知」这一段做成**渠道无关的端口**，并在**账本事务提交之后**调用。
**真实渠道仍未接**（见 §5），本阶段交付的是「路径已通、默认 no-op、可观测、可换绑」。

| 端 | 层 | 落点 | 行为 |
|---|---|---|---|
| 后端 | 端口 | `src/notifications/push.port.ts`（新增） | `PUSH_PORT` 令牌；`ApprovalStatusChangedPush`（**无 payload**）；`PushFailureReason` 三值：`provider_not_configured` / `no_device_token` / `provider_error`；`PushResult`；`PushPort.send()` |
| 后端 | 适配器 | `src/notifications/noop-push.adapter.ts`（新增） | 永远返回 `{ delivered: false, reason: 'provider_not_configured' }` —— **不假装送达** |
| 后端 | 服务 | `src/notifications/notifications.service.ts`（新增） | `notifyApprovalStatusChanged()`：1s 超时 + **永不抛错**；按 `reason` 记日志（未配置 / 无 token 是 debug，故障是 error） |
| 后端 | 装配 | `src/notifications/notifications.module.ts` | `PUSH_PORT → NoopPushAdapter`；只导出 `NotificationsService` + 端口 |
| 后端 | 调用点 | `src/approvals/approvals.service.ts` `decide()` | 端口返回终态**之后**调用；`approvals.module.ts` 导入 `NotificationsModule` |
| 用例 | — | `test/notifications.test.ts`（新增 6 条）、`test/approvals-http.test.ts` 组 G（6 条） | 见 §4 |

## 2. 关键实现决策

### 2.1 先把端口定下来，再谈渠道

三条候选渠道的口径完全不同：APNs / FCM 要设备 token，微信订阅消息要**用户每次授权**且模板固定，
站内通知要落 `Notification` 表。任何一条都还没做，而审批链路的时机问题今天就必须定死。
所以本阶段只承诺 **`PushPort` 的语义**，不承诺任何 SDK / 凭据 / 模板。

### 2.2 no-op 必须**如实**：`provider_not_configured`，不是 `delivered: true`

如果默认适配器返回成功，两个月后「审批 200」会被当成「孩子已经知道」，而实际上一条都没发。
`PushResult` 因此是**可穷举的三态**，默认适配器永远落在「没配置」这一支；日志也刻意用 `debug`
（没配置是当前常态，用 `error` 会把真正的故障淹没）。

### 2.3 推送在事务之外 —— 用**调用位置**钉住，而不是靠注释

`01` §4 与 `02` §9.23 的要求是「通知发送失败 → 账本已提交不受影响」。
本实现里这条不是靠 `try/catch` 兜出来的，而是靠**调用位置**：`ApprovalsService.decide()` 先
`await this.port.decide(...)`（端口内部是一个事务），拿到终态、`assertTerminalWithoutExecution()`
通过之后才调用 `notifyApprovalStatusChanged()`。即使把 `send()` 换成同步抛错，事务也已经提交。

对应可执行证据：`approvals-http.test.ts` 组 G 的「推送适配器抛错 ⇒ 审批仍 200 approved」。

### 2.4 只推「人做的决定」

| 触发 | 是否推送 | 理由 |
|---|---|---|
| `decide` → `approved` / `rejected` | ✅ | 申请人等待的就是这个结果 |
| 创建时显式自批（`autoApprove: true`，201） | ❌ | 收件人 == 批准人，推给自己是纯噪音 |
| `withdraw`（申请人自己撤回） | ❌ | 没有第二个人需要被通知；与 W5-J「撤回零副作用」一致 |
| `expired` / `invalidated` | ❌ | 不是人工决定。将来要推也应走独立事件（「你的申请过期了」），不能混进 `status_changed` |
| 新申请提交（家长待批） | ❌ | **本阶段不做**。家长收件箱仍要手动刷新 —— 这是下一个缺口，不要误以为已解决 |

收件人恒为 `requesterUserId`（不是客户端传入、不是 `childId` 推导）：审批行里已有申请人，重算会引入越权面。
`decidedByUserId` 随消息发出，渠道层若要显示「谁批的」不必再查库（当前也没有渠道）。

### 2.5 「失败」包含三种：抛错、超时、未送达

`sendWithTimeout()` 用 `Promise.race` 加 **1000ms** 上限：第三方 SDK 不抛错但**永不 resolve**
一样能把审批请求挂住。真实适配器应当**入队后立即返回**，这 1s 只是最后一道兜底，不承担重试。
`notifyApprovalStatusChanged()` 捕获一切（含非 `Error` 抛出），保证调用点不需要 `try/catch`。

### 2.6 消息里**不放内容**

只带 `approvalId` / `childId` / `recipientUserId` / `action` / `status` / `decidedByUserId` / `occurredAt`。
不带金额、不带心愿标题、不带规则名。两个理由：
① 第三方通道（尤其微信订阅消息）会把内容留在第三方；
② 「这条内容给谁看」应由渠道在取数时按权限再判，而不是把一份快照广播出去。

### 2.7 幂等 / 顺序：本实现是 **best-effort**

重复 `decide` 在端口层就是 `409 ALREADY_DECIDED`，因此不会重复推送（组 G 有断言）。
但**没有 outbox、没有重试、没有去重键**：进程在 `decide` 提交后、`send` 前崩溃，这条通知就永久丢失。
要「可靠投递」必须加 outbox 表 + 后台扫描（§5.1 第 6 步），不能靠在这 1s 里加重试。


## 3. 落地清单（文件级）

### 3.1 新增

| 文件 | 内容 |
|---|---|
| `backend/src/notifications/push.port.ts` | `PUSH_PORT`、`ApprovalStatusChangedPush`、`PushMessage`、`PushFailureReason`、`PushResult`、`PushPort` |
| `backend/src/notifications/noop-push.adapter.ts` | 默认适配器：`provider_not_configured` |
| `backend/src/notifications/notifications.service.ts` | 唯一入口；1s 超时；永不抛错；日志分级 |
| `backend/test/notifications.test.ts` | 6 条（默认装配 / 原样转发 / 抛错 / 非 Error / 超时） |
| `docs/design/28-w5k-handoff.md` | 本文 |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `backend/src/notifications/notifications.module.ts` | 原本是 `@Module({})` 空壳 ⇒ 提供 `NotificationsService` + `PUSH_PORT`，并导出两者；文件头改成「已通路径、未接渠道」的诚实状态 |
| `backend/src/approvals/approvals.module.ts` | `imports` 增加 `NotificationsModule`（与「有没有库」无关，故静态导入） |
| `backend/src/approvals/approvals.service.ts` | 构造函数注入 `NotificationsService`（显式 `@Inject`）；`decide()` 在端口返回后调用；创建时的自批路径**不调用** |
| `backend/test/approvals-http.test.ts` | `startApp()` 增加可选 `push` 参数；新增组 G（6 条） |

### 3.3 **没有**改

`prisma/schema.prisma` / 迁移 / 客户端（Flutter、小程序）/ 权限矩阵 / 矩阵快照 —— 一行未动。
因此「565 = 553 + 12」是本阶段全部的变化量。

## 4. 用例

### 4.1 `backend/test/notifications.test.ts`（6 条）

| 组 | 在钉什么 |
|---|---|
| 默认装配（2） | `NoopPushAdapter.send()` **恰好**返回 `{delivered:false, reason:'provider_not_configured'}`；模块把 `PUSH_PORT` 绑到它并导出 service（防止「端口存在但没人绑定」） |
| 服务（4） | 消息**原样转发**（字段不被 service 改写）；适配器抛 `Error` ⇒ `provider_error` + `detail`，**不向调用方抛**；抛字符串同样兜住；**永不 resolve ⇒ 1s 超时**兜成 `provider_error` |

### 4.2 `backend/test/approvals-http.test.ts` 组 G（6 条，真 HTTP + 真装配）

| 用例 | 断言 |
|---|---|
| 家长批准 | 推送**恰好一次**；`approvalId` / `childId` / `recipientUserId === 'u-kid'` / `action` / `status` / `decidedByUserId` 全对 |
| 家长拒绝 | `status === 'rejected'`，仍推一次 |
| 适配器抛错 | 审批仍 **200 / approved**，且适配器**确实被调用**（否则这条没测到故障路径） |
| 重复 decide | 第一次 200 ⇒ 第二次 409 `ALREADY_DECIDED`，推送总数仍是 **1** |
| 撤回 | 200 `withdrawn`，推送 **0** |
| 创建时自批 | 201 `approved`，推送 **0** |

### 4.3 为什么必须用 `npm test` 跑

`npx tsx --test test/approvals-http.test.ts` 会让 **`ValidationPipe` 整体静默失效**
（esbuild 不产出 `emitDecoratorMetadata`，见 `src/app.setup.ts` 文件头与 `scripts/run-tests.mjs`）。
实测：用 tsx 跑本文件会看到 `?status=duh` 返回 200 —— 那是加载器的问题，不是接线的回归。
**验收口径只有一个：`cd backend && npm test` → 565/565。**

## 5. 仍未落地（不粉饰）

- **没有任何真实渠道**：`NoopPushAdapter` 永远返回 `provider_not_configured`；没有 APNs / FCM /
  微信订阅消息的 SDK、凭据、模板 ID。全仓库仍无推送依赖。
  > ✅ **W6-A（2026-10-24）部分补上**：`PUSH_WEBHOOK_URL` 配好时 `PUSH_PORT` 绑到
  > `WebhookPushAdapter`（真发 HTTP，**仍无厂商凭据**，网关要自己实现）；
  > 没配就是今天这个 no-op，见 [`29-w6a-handoff.md`](./29-w6a-handoff.md)。
- **没有设备 token 上报端点**：`DeviceToken` 表 W0 已建（`platform` / `token` / `active` /
  `lastSeenAt` / `revokedAt`），但**没有一条写入路径**；`no_device_token` 目前只是端口契约的一部分，
  没有任何适配器会返回它。
  > ✅ **W6-A（2026-10-24）已补上**：`POST /device-tokens` / `POST /device-tokens/revoke`
  > ＋ 真会发 HTTP 的 `WebhookPushAdapter`，见 [`29-w6a-handoff.md`](./29-w6a-handoff.md)。
  > 仍缺的是**厂商凭据 / 网关实现 / 客户端上报** —— 线上表依然是空的。
- **没有站内通知的投递保证**：`Notification` 表在 W5-L 已开始写入（`decide()` 之后、事务外）并
  有列表 / 已读端点与双端「消息」面板，但**没有 outbox**：进程在写完前崩溃 ⇒ 那一 tick 永久丢失，
  且仍要用户打开 App 才看得到（见 §5.2）。
- **没有可靠投递**：无 outbox / 队列 / 重试 / 去重 / 送达回执。进程在提交后崩溃 ⇒ 通知永久丢失。
- **没有告警与指标**：`provider_error` 只写 error 日志；没有计数器、没有失败率看板。
- **没有偏好 / 免打扰**：也不区分「家长批准」与「家长拒绝」的文案。
- **没有客户端配合**：Flutter / 小程序都没有权限申请、token 获取、通知点击跳转。
- **没有真机验证**：本阶段全部证据是离线用例（端口 + HTTP），「孩子手机弹出通知」**一次都没发生过**。
- **1s 超时不是硬保证**：事件循环被阻塞时会晚触发；它只防「永久挂住」，不防「慢」。

### 5.1 接一个真实渠道的最小步骤（建议顺序）

1. **设备 token 上报**（表已存在，缺端点）：`POST /device-tokens`，身份只来自会话
   （`userId` 不来自请求体）；`(token)` 唯一、`active` 复用；登出 / 卸载 ⇒ `active=false` +
   `revokedAt`。**不要**把 token 放 query（会进访问日志）。
2. **发送侧适配器**：实现 `PushPort.send()`，**入队后立即返回**（网络调用交给 worker）。
   第三方返回「token 失效」时应把 `DeviceToken.active` 置 false，而不是无限重试。
3. **绑定**：把 `NotificationsModule` 里的 `{ provide: PUSH_PORT, useClass: NoopPushAdapter }`
   换成真实适配器（或在 `register(options)` 里按环境选）。**没有凭据时继续 no-op** ——
   不要写一个「返回 delivered:true」的假适配器。
4. **配置**：凭据只走环境变量 / secret manager；缺失时启动日志 `warn` 一次，避免「以为配了」。
5. **用例**：给真实适配器写契约用例（成功 / 401 / 410 token 失效 / 429 限流），
   并保留 `notifications.test.ts` 的三态断言；真机验证单列，不能拿单元测试替代。
6. **要可靠投递再加 outbox**：提交后写入 outbox（同事务写 outbox 是允许的，**发送**必须在事务外）
   + 后台扫描 + 去重键。当前实现明确是 best-effort，不要在它上面叠加「保证送达」的承诺。

### 5.2 站内通知（已落地：W5-L）

`Notification` 表已不空转。`decide()` 推送端口返回之后**另写一条站内通知**
（仍在账本事务之外，`01` §4 对「通知」一视同仁），收件人恒为 `requesterUserId`，
`approved` / `rejected` 各一条；自批 / 撤回 / 过期不写。

- 端点：`GET /notifications`（键集分页，`limit` 1–100，默认 20；回包带整份
  `unreadCount` 与 `nextCursor`/`hasMore`）+ `PATCH /notifications/:id/read`
  （无请求体，幂等：已读再调仍 200 并回第一次的 `readAt`）。
  两条都在矩阵里（`view_notifications` / `read_notifications`，guardian 与 child 双 ALLOW）。
- 收件人只来自会话：别人的 id 与不存在的 id 返回**同一句** 404
  `NOTIFICATION_NOT_FOUND`，不泄露「存在但不属于你」。
- 客户端：Flutter `notifications_sheet.dart` + `AppStore`（列表 / 红点两条 epoch）、
  小程序 `sheets/NotificationsSheet.tsx` + `store.ts`；「我的」页入口带未读数角标
  （`limit=1` 只换红点，不动列表；> 99 显示 `99+`）。
- 证据：`backend/test-db/notifications-db.dbtest.ts`（真库 × HTTP：DI、顺序 / 分页 /
  归属、幂等、404、追加写入）；双端 `notifications_test.dart` / 小程序 typecheck。

**边界（仍未做，别把它读成推送）**：没有 outbox，进程在写完通知前崩溃 ⇒ 这条就没了；
没有「已读全部」；没有按类型过滤 / 偏好 / 免打扰；**仍然需要用户打开 App 才看得到** ——
所以它是推送的补充，不是替代。§5.1 的六步一件都没被这一步替代。

### 5.3 新申请待确认时通知家长（W5-M）

W5-L 只解决「审批**结论**怎么回到申请人手里」；家长那一侧仍然要自己轮询收件箱。
W5-M 补上另一半：**有人提交、且结果落在 `pending` 时，给这个孩子的每位在场家长
各写一条站内通知 + 推一条推送**。

- 触发点：`ApprovalsService.createRequest()` 的 `pending` 分支，**在事务提交之后**调用
  `NotificationsService.notifyApprovalSubmitted()`。自动通过（`autoApprove` / 策略直接 `approved`）
  与自批**不发** —— 那时没有「等你确认」这件事。
- 收件人：`NotificationsPort.listActiveGuardianUserIds(childId)`
  （`ChildMember{ role: 'guardian', status: 'active' }`，按 `id` 排序保证可复跑），
  **排除提交人自己**：家长提交时只提醒另一位家长，孩子提交时两位家长都收到。
  家长集合的解析在通知层，`ApprovalsModule` 不需要认识 `ChildMember`。
- 消息：站内 `type = 'approval.submitted'`；`payload` **只有
  `{ approvalId, action, submittedByUserId }`** —— 没有金额 / 心愿标题 / 理由，
  与 W5-K 同一口径（第三方通道会保留内容）。正文只说「去收件箱看看」。
- 纪律：先写站内、再推送，两步都在审批事务之外；查家长 / 写通知 / 推送任何一步失败
  **只记日志**，`POST /approvals` 仍是 202 —— 「通知没发出去」不能把一次已成立的申请变成 5xx。
- 客户端：`type === 'approval.submitted'` 的胶囊是**「去审批」**（Flutter 关面板后由
  `HomeShell` 切到审批 tab；小程序 `switchTab(2, 3)`），而 `approved` / `rejected` 仍是
  「查看申请」→「我的申请」。两者都带 `approvalId`，只靠 payload 分不出该去哪。
- 证据：`backend/test/notifications.test.ts`（6 条：收件人展开 / 排除提交人 / 单点失败不抛）、
  `backend/test/approvals-http.test.ts` 组 H（`POST /approvals` 仍 202 且每人一条）；
  `backend/test-db/notifications-db.dbtest.ts` 组 E（真库 × 真 HTTP：成员位解析、
  孩子提交 ⇒ 两位家长、家长提交 ⇒ 只另一位、提交人红点不动）；Flutter `notifications_test.dart`
  新增 `isApprovalSubmitted` 一条。本轮复跑：`npm test` → **586/586**（W5-L 576，+10）、
  `npm run test:db` → **192/192**（+3）、`flutter test` → **200/200**（+1）、
  `flutter analyze` / `tsc --noEmit` → 0。
- 边界：`status != 'active'` 的家长位**收不到**（按定义就不该提醒）；没有 outbox，
  通知丢失不可补；推送仍是 `NoopPushAdapter`，所以「202」不等于「家长手机响了」；
  删除 / 撤回 / 过期都不会补发「已处理」给其他家长。

本轮复跑（W5-L 收口时）：`typecheck` / `typecheck:tests` → 0；`npm test` → **576/576**（31 文件，
W5-K 的 565 之上 **+11** 条通知用例）；`npm run test:db` → **189/189**（12 文件，含
`notifications-db.dbtest.ts`）；`flutter analyze` → 0、`flutter test` → **199/199**；
小程序 `tsc --noEmit` → 0、`npm run build:weapp` → 成功。

## 6. 复跑基线

```bash
cd backend
npm run typecheck && npm run typecheck:tests    # → 0 / 0
npm test                                        # → 565/565（31 个文件）
npm run build                                   # → 0

cd ..
flutter analyze                                 # → No issues found!
flutter test test/write_api_test.dart test/approvals_test.dart   # → 127/127

cd kids_points_mp
npx tsc --noEmit                                # → 0
```

手工冒烟（开发库，先 `npm run migrate:deploy`）：

```bash
# 1) 孩子提一条（202 pending）
curl -s -X POST http://localhost:3000/approvals \
  -H 'content-type: application/json' \
  -H 'x-kp-device-id: demo-device-child' -H 'x-kp-child-id: demo-child' \
  -d '{"action":"redeem"}'

# 2) 家长批准（200 approved）
curl -s -X POST http://localhost:3000/approvals/<approvalId>/decide \
  -H 'content-type: application/json' \
  -H 'idempotency-key: smoke-push-1' \
  -H 'x-kp-device-id: demo-device-dad' -H 'x-kp-child-id: demo-child' \
  -d '{"decision":"approved"}'
```

看什么：审批**照常 200**；服务日志里出现
`推送未送达（provider_not_configured）：approval=<id>`（**debug 级**，若日志级别过滤掉 debug 则看不到）。
这条日志就是「路径已通、渠道未接」的可观测证据 —— 它**不是错误**，也不是「已通知」。
