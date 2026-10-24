# 阶段 W6-A 交接单 · 设备 token 上报 ＋ 真实 Webhook 推送适配器

> **日期**：2026-10-24　**阶段**：W6-A（WF-6「真实推送」的第一步）
> **给**：接手「接 APNs / FCM / 微信订阅消息」「推送 outbox / 重试 / 去重」「客户端 token 上报」的下一个会话。

**一句话**：`28-w5k-handoff.md` §5.1 列的第 1、2、3 步这次**只做了一半的 1** ——
`DeviceToken` 表终于有了写入路径（`POST /device-tokens` / `POST /device-tokens/revoke`），
`PUSH_PORT` 也第一次有了**真的会发 HTTP** 的实现（`WebhookPushAdapter`）；
但**没有任何厂商凭据**，没有 APNs / FCM / 微信 SDK，也没有客户端上报。
「孩子手机弹出通知」**依然一次都没发生过**。

---

## 1. 本阶段做了什么

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 新动作 `manage_device_tokens`（guardian / child **双 ALLOW**，viewer fail-closed） | `src/contracts/permission-matrix.ts`、`prisma/schema.prisma`（`ActionType`）、迁移 `20261024090000_device_token_action` |
| 2 | 设备 token 端口 ＋ 两个适配器 | `src/device-tokens/device-tokens.repository.ts`（端口 + `NotImplemented…`）、`device-tokens.prisma.repository.ts` |
| 3 | 服务／控制器／DTO | `device-tokens.service.ts`、`device-tokens.controller.ts`、`dto/` |
| 4 | 两个模块（核心 / HTTP 分层） | `device-tokens.module.ts`、`device-tokens-http.module.ts` |
| 5 | **真实** Webhook 推送适配器 ＋ 配置解析 | `src/notifications/webhook-push.adapter.ts`、`push-webhook.config.ts` |
| 6 | `PUSH_PORT` 改由 `useFactory` 选绑定 | `src/notifications/notifications.module.ts` |
| 7 | 用例：离线 32 条 ＋ HTTP 20 条 ＋ 真库 14 条 | `test/device-tokens.test.ts`、`test/device-tokens-http.test.ts`、`test-db/device-tokens-db.dbtest.ts` |

**没有改**：`push.port.ts` 的接口形状、`NotificationsService` 的 1s 超时语义、
`ApprovalsService.decide()` 的调用位置、`Notification` 站内通知的任何行为。

---

## 2. 关键实现决策

### 2.1 为什么单独一个 `device-tokens` 模块，而不是塞进 `notifications`

`push.port.ts` 回答「消息怎么发出去」；`device-tokens` 回答「**发给谁**」。
两件事的写权限、生命周期、失效来源完全不同：消息是一次性的，token 长期存在且会过期 / 被注销。
混在 `notifications` 里，等于让「推送适配器」顺手拥有写库能力 ——
那样 `WebhookPushAdapter` 就能自己下线别人的设备，`410` 处理也无从审计。

### 2.2 控制器只存在于 `DeviceTokensHttpModule`，核心模块无控制器

`NotificationsModule` 需要 `DEVICE_TOKENS_REPOSITORY`（读 active token），
`AppModule` 需要 `DeviceTokensController`。若把控制器放进核心模块，
`NotificationsModule` 被 import 两次（`AppModule` ＋ 自身 `imports`）就会**重复注册路由**。
所以拆成两层：

- `device-tokens.module.ts`：`register({ hasDatabase })` 选 Prisma / `NotImplemented` 适配器，导出 service + token，**无 controller**；
- `device-tokens-http.module.ts`：imports 核心模块 + `DeviceSession` / `Membership` / `Permissions`，注册 controller **一次**。

### 2.3 `token` 是凭据：不进响应、不进 URL、不进日志

- 响应里**没有** `token` 字段（`DeviceTokenDto` 只有 `id` / `platform` / `active` / 时间）；
  客户端自己刚发过来的值，服务端不需要再说一遍；
- 注销走 `POST /device-tokens/revoke` ＋ **请求体**，**没有** `DELETE /device-tokens/:token`
  —— 路径段会进 access log / 反向代理日志 / 崩溃上报。用例里专门断言
  `GET /device-tokens/<token>` 返回 **404**（根本没有这条路由）；
- 409 / 404 的响应体同样不回显 `token`。

### 2.4 归属冲突 409，但「不是我的」= 404

| 场景 | 结果 | 理由 |
|---|---|---|
| 同一个 token 被**另一个账号**注册 | **409** `DEVICE_TOKEN_OWNED_BY_OTHER` | 请求形状是对的，是**状态**冲突；允许「后一次注册接管」= 共享平板上换人登录就能劫持前一个账号的推送 |
| 注销**别人的** token | **404** `DEVICE_TOKEN_NOT_FOUND` | 与 `Notification` 同一口径：区分 404 与 403 等于给出「这个 token 存在」的探测口 |

409 靠 `token` 唯一约束（`P2002`）兜住并发，**不靠先查后写**；
真库用例证明并发 4 次注册后库里**恰好一行、同一个 id**。

### 2.5 注销的幂等是**结构性的**（条件 `updateMany`）

```ts
updateMany({ where: { id, active: true }, data: { active: false, revokedAt: new Date() } })
```

两笔并发注销只有第一笔写 `revokedAt`，第二笔回读到的就是第一笔的值。
真库用例断言两条并发调用回**同一个**时间戳 —— 换成「先查后写」这条用例立刻红。

### 2.6 一个用户最多 10 个 active token（LRU）

网关每次要收**全部** token，不设上限就是放大器入口（注册接口本身「谁都能多写几行」）。
注册时在同一事务内把 `lastSeenAt` 最旧的行标成失效；`take: MAX + 1` 就够
（每次最多淘汰一条，反复注册会收敛），全量取出反而是「一次注册写一万行」的成本。
刷新已有 token **不触发**淘汰 —— 否则「刚重连的设备」会把自己挤掉。

### 2.7 `disabled` 与 `invalid` 都是 no-op，但**日志级别不同**

`readWebhookPushConfig()` 回三态：

| 结果 | 含义 | 日志 | 装配行为 |
|---|---|---|---|
| `ok` | 配了合法的 `PUSH_WEBHOOK_URL` | info（一次） | 绑 `WebhookPushAdapter` |
| `disabled` | 没配 / 只有空白 | info | `NoopPushAdapter`（**常态**，不是故障） |
| `invalid` | 不是合法 URL / 非 http(s) / 生产用 http | **error** | `NoopPushAdapter` |

`invalid` 之所以要 error：否则「配错了」与「没配」在日志里长得一样，
上线后只会看到推送全是 `provider_not_configured`，没人知道是 URL 写错了。
生产强制 https，因为请求体里是**可直接推送的设备 token**。

超时默认 800ms、夹在 `[100, 5000]`：必须**小于** `NotificationsService` 的 1s 兜底，
否则适配器永远等不到自己的超时，日志里只剩「推送超时」而看不出是网关慢。

### 2.8 `410` 只下线**这次真的发出去**的 token

网关回 `410` 时可能带 `invalidTokens: [...]`。实现把这份列表**与本次发送的集合求交**，
再调 `deactivateTokens()`：坏掉 / 被劫持的网关不能凭一个 token 串就下线任意设备。
同理 **5xx / 401 不动 token** —— 401 很可能只是我们配错了凭据；
按 401 清空用户设备，比「这次没推出去」严重得多。
`deactivateTokens()` 自身失败也只记 `provider_error`（`已置 0 条`），不让「状态写不进去」变成异常。

### 2.9 `childId` 只是记录，不是归属

`DeviceToken.childId` 是 `SetNull`：孩子档案被删 / 切换，token 仍然 `active`。
推送收件人恒为 `userId`（一个家长可能有两个孩子）；若按 `childId` 收口，
孩子换一个档案就得重新上报一次。真库组 E 用**删除孩子**证明这一条（那是被测动作，不是清理）。

### 2.10 文档也是契约：这次抓到 PRD §7 停在 29 个动作

改完矩阵才注意到：`docs/PRD.md` §7 的表格还写着「29 个动作」，
而代码从 W5-H / W5-J / W5-L 一路加到 **35**。十几轮 CI 全绿 ——
因为**没有任何一条检查读过文档**（`honesty:probe` 的 D 只对账 TS ↔ Prisma）。
六条动作（`view_members` / `change_member_role` / `view_own_approvals` /
`view_notifications` / `read_notifications` / `manage_device_tokens`）在文档里根本不存在，
而 PRD 是**需求侧的唯一入口**：看文档的人会以为孩子不能看成员、家长不能设角色、设备不能上报。

所以这次不只「补一张表」，而是补上**守卫 ⑤**：

- `honesty:probe` 新增检查 E —— 解析 PRD §7 表格与 `permission-matrix.ts`，
  逐行对**动作名 + 两侧判定**，标题里的动作数也必须对上；
- `test:canfail` 新增检查 D —— 把探针指向一份**故意写错**的夹具 PRD
  （`scripts/__fixtures__/prd-drifted.fixture.md`），必须**退出码非 0** 且**点名**
  `undo_check_in 判定不一致：PRD=ALLOW/ALLOW 代码=ALLOW/DENY`。

第 2 条是必须的：一个永远通过的检查等于没有检查（D13 的教训）。
「文档漏写」这种缺陷**不会让任何用例变红**，所以只能靠在闸门里**主动造一次红**来证明它可被听见。

顺带把 `.env.example` 补齐三个推送键（`PUSH_WEBHOOK_URL` / `PUSH_WEBHOOK_TOKEN` /
`PUSH_WEBHOOK_TIMEOUT_MS`）并注明「不配 = no-op，配错 = error」——
否则部署时没人知道该填什么，配错了也只会看到「推送全是 `provider_not_configured`」。

---

## 3. 落地清单（文件级）

### 3.1 新增

| 文件 | 作用 |
|---|---|
| `src/device-tokens/device-tokens.types.ts` | 平台常量 / 上限 / 行与结果类型 / 线格式 |
| `src/device-tokens/device-tokens.repository.ts` | 端口 ＋ `NotImplemented…`（四个方法全 **501**） |
| `src/device-tokens/device-tokens.prisma.repository.ts` | 唯一约束 / 条件注销 / LRU 淘汰 / 批量下线 |
| `src/device-tokens/device-tokens.service.ts` | 会话 actor → 端口入参；409 / 404 映射 |
| `src/device-tokens/device-tokens.controller.ts` | 两条 POST、三道屏障、回包不含 token |
| `src/device-tokens/dto/*.ts` | 请求体**集合封闭**（多一个键就 400） |
| `src/device-tokens/device-tokens.module.ts` | 核心模块（无 controller），`hasDatabase` 选适配器 |
| `src/device-tokens/device-tokens-http.module.ts` | HTTP 层，controller 只注册一次 |
| `src/notifications/push-webhook.config.ts` | `ok / disabled / invalid` 三态解析（纯函数） |
| `src/notifications/webhook-push.adapter.ts` | 真 HTTP `POST`、`x-kp-event`、可选 Bearer、超时、410 交集下线 |
| `prisma/migrations/20261024090000_device_token_action/migration.sql` | `ALTER TYPE "ActionType" ADD VALUE 'manage_device_tokens'` |
| `test/device-tokens.test.ts` | 组 A–F：矩阵 / 枚举对账 / 501 / service / 配置 / 适配器（真 HTTP 假网关） |
| `test/device-tokens-http.test.ts` | 组 A–D：501 / 屏障 / 成功路径与冲突码 / 请求体封闭 |
| `test-db/device-tokens-db.dbtest.ts` | 组 A–E：唯一约束 / LRU / 注销幂等 / 列表与批量下线 / `SetNull` |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `src/contracts/permission-matrix.ts` | 新增 `manage_device_tokens`；条数注释 33 → 35 |
| `prisma/schema.prisma` | `enum ActionType` 加值；条数注释 25 → 35 |
| `src/app.module.ts` | 注册 `DeviceTokensHttpModule.register()` |
| `src/notifications/notifications.module.ts` | `pushWebhook?` 装配项；`PUSH_PORT` 改 `useFactory: createPushAdapter(...)`；imports `DeviceTokensModule`；`logPushSelection()` |
| `src/notifications/push.port.ts` | 诚实注释更新：缺口 ② 已闭、缺口 ①（凭据）仍开 |
| `test/permission-matrix.test.ts` | 条数 34 → 35 |
| `contracts/permission-matrix.json` | 重新 emit（`actionCount: 35`） |
| `docs/PRD.md` | §7 表格补 6 行、标题与另三处「29 动作」→ **35**、§16.4 追加 v1.1 变更行 |
| `scripts/honesty-probe.mjs` | 新增检查 **E**：PRD §7 ↔ 矩阵逐行对账（支持 `HONESTY_PRD_PATH` 自测） |
| `scripts/test-can-fail.mjs` ＋ `scripts/__fixtures__/prd-drifted.fixture.md` | 新增检查 **D**：故意漂移的 PRD 必须让探针变红并点名（守卫 ⑤ 的可证伪性） |
| `.env.example` | 新增 `PUSH_WEBHOOK_URL` / `PUSH_WEBHOOK_TOKEN` / `PUSH_WEBHOOK_TIMEOUT_MS` 及三态说明 |

### 3.3 **没有**改

`push.port.ts` 的接口 · `NotificationsService.notify*()` 的超时与「永不抛错」·
`decide()` 的调用位置 · 站内通知的任何行为 · 任何客户端代码。

---

## 4. 三层证据（缺一层就等于没验完）

### 4.1 `test/device-tokens.test.ts` —— 32 条（无库）

| 组 | 证明了什么 |
|---|---|
| A | `manage_device_tokens` 在矩阵里两侧 **ALLOW**、viewer fail-closed；`DEVICE_PLATFORMS` 与 `schema.prisma` 的 `enum DevicePlatform` **逐字相等**（读 schema 文本对账，不是手抄）；上限是 10 |
| B | `NotImplementedDeviceTokensRepository` **四个方法全 501** —— 空数组 / 0 条都是「假装成功」 |
| C | service 只用会话 `userId`；token 被 trim；回包**不含 token**；`owned_by_other` ⇒ 409、`not_found` ⇒ 404 |
| D | `readWebhookPushConfig` 七种输入（空 / 空白 / 非法 URL / `ftp:` / 生产 http / 开发 http / 超时夹取） |
| E | `createPushAdapter` 的三态映射；`NotificationsModule` 在 `ok` 装配下 `PUSH_PORT` 真的是 `WebhookPushAdapter`，`disabled` 下仍是 no-op（**默认世界不变**） |
| F | `WebhookPushAdapter` 对**真起一个本地 HTTP 服务**的网关：2xx / 缺 `messageId` / 410 带 `invalidTokens` / 410 不带 / 503 / 无 token / 读库抛错 / 超时 / 下线失败 |

组 F **不打桩 `fetch`**：打桩就把超时、中止、响应体解析一起测掉了，
而这三件事恰恰是最容易写错的地方。

### 4.2 `test/device-tokens-http.test.ts` —— 20 条（真 Nest ＋ 真路由，端口是替身）

| 组 | 证明了什么 |
|---|---|
| A | 无库装配下两条路由都 **501**（不是 200，也不是空列表） |
| B | 成功路径：家长 / **孩子**都能登记；userId 与 childId 来自会话；重复上报同一 id；409 / 404 机器码；注销回 `active:false` |
| C | 请求体**集合封闭**：缺 token / 太短 / 含空白 / `platform=windows` / 多传 `userId`·`childId`·`active`·`id` 全 400 且**端口零调用**；`GET /device-tokens/<token>` ⇒ **404** |
| D | 三道屏障：缺身份 401、viewer 无成员位 403，两条路由都拦，端口零调用 |

### 4.3 `test-db/device-tokens-db.dbtest.ts` —— 14 条（真库）

替身永远证明不了的：唯一约束兜住**并发**（4 次并发注册 ⇒ 1 行 / 1 个 id）、
换账号注册后原行**一个字节没变**（含 `lastSeenAt`）、注册第 11 个淘汰的确实是 `lastSeenAt` 最旧的那条、
并发注销回**同一个** `revokedAt`、注销别人的 token ⇒ `not_found` 且行仍 `active`、
批量下线按 token 生效且重复调用回 0、删孩子后 `childId` 变 `null` 而 token 仍 `active`。

---

## 5. 仍未落地（不粉饰）

- **没有任何厂商凭据**：`WebhookPushAdapter` 只会 `POST` 我们自己的网关；
  APNs（`p8` + team/key id）/ FCM（service account）/ 微信订阅消息（`appid` + 模板 ID）**一个都没有**。
  `PUSH_WEBHOOK_URL` 不配 ⇒ 仍是 `NoopPushAdapter` ⇒ 推送如实返回 `provider_not_configured`。
- **网关那一侧不存在**：仓库里没有那个 HTTP 服务的实现（也不该有，它是外部组件）。
- **没有客户端上报**：Flutter / 小程序都还没申请通知权限、没取 token、没调 `POST /device-tokens`。
  所以**线上 `DeviceToken` 表仍然是空的**，适配器会如实回 `no_device_token`。
- **没有 outbox / 重试 / 去重 / 送达回执**：一次 `POST` 失败就结束，不重试。
  进程在写库后崩溃 ⇒ 这次推送永久丢失（与 W5-K 相同）。
  接 outbox 时注意：**写 outbox 可以在业务事务内，发送必须在事务外**，
  且去重键要能区分「同一个审批结论」与「同一个孩子两次不同决定」。
- **没有告警 / 指标**：`provider_error` 只写 error 日志，没有失败率看板。
- **没有真机验证**：「孩子手机弹出通知」一次都没发生过 —— 这一行要等第 1、3 条都落地才能划掉。
- **`410` 的语义依赖网关自觉**：网关若既不说哪些 token 失效、又对不同账号混发 410，
  我们只能把「本次发送的全部」下线（这是刻意的保守选择）。

---

## 6. 复跑基线（2026-10-24 实测）

```bash
cd backend
npm run typecheck && npm run typecheck:tests && npm run typecheck:tools   # 0
npm run prisma:validate                                                   # valid
npm test                                                                  # 33 文件 / 638 用例全通过
npm run test:db                                                           # 13 文件 / 206 用例全通过
npm run build                                                             # 0
npm run contracts:emit                                                    # ✔ 35 个动作
npm run honesty:probe                                                     # ALL PASS（5 项；含矩阵↔Prisma、PRD §7 逐行对账）
npm run test:canfail                                                      # ALL PASS（8 项；含守卫 ④ / ⑤）
npm run defects:check && npm run templates:check && npm run icons:check \
  && npm run relation:check && npm run restrictions:check                 # 全 ALL PASS
npm run test:canfail:db                                                   # ALL PASS（11 项；真库套件也证明会红）
npm run ci                                                                # 一条命令跑完上面全部 → EXIT=0
```

`npm run ci` **不**含 `test:db`（真库要活库），所以「CI 绿」≠「真库验过」；
两侧都要跑，这也是 `ci:db` 存在的理由。

`contracts/permission-matrix.json` 现在 `actionCount: 35`，且**必须先 `npm run build`**
再 `contracts:emit`（脚本读 `dist/`；直接 emit 会读到上一次的产物）。

---

## 7. 下一步（建议顺序）

1. **客户端上报**（无需任何厂商凭据就能做，先把表填起来）：
   小程序 `wx.request` 拿 code 换 session 后取 `wx.getSetting` / 订阅消息模板授权状态；
   Flutter 接 `firebase_messaging`（或先只上报一个占位 token 打通链路）。
   上报失败**不得**阻断登录 / 打卡。
2. **网关**：实现那个 `POST /push`（`{version, event, message, tokens}`），
   内部按 `platform` 分派 APNs / FCM / 微信；`410` 时必须回 `invalidTokens`。
3. **真实适配器**：把 `WebhookPushAdapter` 换成 `ApnsPushAdapter` / `FcmPushAdapter`，
   或保留 webhook 作为「网关客户端」—— 那时 410 的处理逻辑可以原样复用。
4. **outbox**：`Notification` 与 outbox 同事务落库，后台 worker 发送 + 指数退避 + 去重键。
5. **可观测**：`provider_error` 计数 / 按平台拆分 / 连续失败告警。


