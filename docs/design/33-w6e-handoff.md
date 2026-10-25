# 阶段 W6-E 交接单 · Flutter 客户端设备 token 上报

> **日期**：2026-10-25　**阶段**：W6-E（W6-A 遗留的「客户端上报」在 Flutter 端打通）
> **给**：接真实 APNs / FCM / 微信订阅消息、或继续做「换 token / 退出登录自动注销」的下一个会话。

**一句话**：后端 `POST /device-tokens` / `/revoke` 终于有了 Flutter 调用方 ——
启动时 fire-and-forget 上报，**上报失败绝不阻断启动 / 登录 / 打卡**；
当前 token 来源是**仅调试构建可用**的编译期值，真实厂商 SDK 适配器是下一步。

---

## 1. 本阶段做了什么

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 设备 token DTO ＋ 两条写入口的独立 API 客户端 | `lib/data/device_token_api.dart` |
| 2 | 推送配置解析 / token 来源抽象 / 上报器（单飞、去重、409 不重试） | `lib/data/push_token_registration.dart` |
| 3 | 启动接入（后端已配置时才上报，不 `await`，不阻塞首帧） | `lib/main.dart` |
| 4 | API 用例 16 条（逐字节路径 / 请求体 / 请求头、错误归一、注销 token 不进 URL） | `test/device_token_api_test.dart` |
| 5 | 上报器 + 配置用例 24 条（成功 / 无 token / 失败隔离 / 409 / 单飞 / 注销 / 日志安全） | `test/push_token_registration_test.dart` |

**没有改**：后端任何一行、`WriteApi` 接口、`AppStore`、任何页面、权限矩阵（仍 35 个动作）、
`read_api.dart` / `write_api.dart` 的既有传输层。

---

## 2. 端到端链路

### 2.1 启动顺序

```text
main()
  ├─ ReadApiConfig.fromEnvironment()          // 三项 --dart-define 是否齐全
  ├─ configured == false → 不碰推送，直接 runApp（本地预览照旧）
  ├─ configured == true  → _reportPushToken(config)   // 不 await
  │     ├─ PushTokenConfig.fromEnvironment()  // 没配 token ⇒ 立刻返回
  │     ├─ 配置非法 / 发布构建 ⇒ debugPrint 一条，返回
  │     ├─ PushTokenRegistrar(api: DeviceTokenApiClient(...), source: ...)
  │     └─ unawaited(report().then(log).whenComplete(close))
  └─ runApp(...)                              // 首帧永远不等网络
```

`_reportPushToken` **没有** `try/catch` 兜底：`PushTokenRegistrar` 的契约是
`report()` / `revoke()` **永不抛错**，异常都在内部归一成 `PushTokenResult`
（连 `PushTokenSource.platform` 这种外部 getter 抛错也在 `report()` 内兜住）。
这一条由 24 条上报器用例守着，而不是靠调用方到处包 `try`。

### 2.2 配置：未配置 ≠ 配置错误

| 输入 | `enabled` | `validationError` | 行为 |
|---|---|---|---|
| 没有 `KP_PUSH_TOKEN` | `false` | `null` | 静默跳过（预览 / 未接推送的正常状态） |
| 有 token，平台可推断或显式给出 | `true` | `null` | 生成 `ConfiguredPushTokenSource` 并上报 |
| 有 token，但平台无法推断 / 不在枚举 | `true` | 非空 | 打日志后跳过（**不能**当成“没配置”） |
| 有 token，但太短 / 含空白 | `true` | 非空 | 同上 |
| 有 token，但 release / profile 构建 | `true` | 非空 | 同上（防止所有安装抢同一个 token） |

平台推断只认 `android` / `ios`（`Platform.operatingSystem`）；`weapp` 必须显式给
`KP_PUSH_PLATFORM=weapp`，因为桌面 / 未知系统**不猜**。

### 2.3 上报器状态机

| 结果 | 触发条件 | 下次启动会重试吗 |
|---|---|---|
| `registered` | 服务端 2xx，或本次进程内同一 `(platform, token)` 已成功 | 不发请求，直接返回 `registered` |
| `noToken` | 来源返回 null / 空白 / 抛错 | 会（本次进程不缓存失败） |
| `failed` | 网络 / 超时 / 5xx / 401 / 403 / 解析失败 / 平台不支持 | 会 |
| `ownedByOther` | 409 `DEVICE_TOKEN_OWNED_BY_OTHER` | **不会**（同一 token 本次进程内直接短路；换 token 才解除） |
| `revoked` | 注销 2xx，或 404 `DEVICE_TOKEN_NOT_FOUND` | — |

两个并发 `report()` 返回**同一个 Future**（`identical(first, second) == true`），
底层只发一次请求；`whenComplete` 只在仍是当前 Future 时清空 `_inFlight`，
避免晚到的完成回调把后一次上报误清掉。

### 2.4 HTTP 契约（与 W6-A 后端逐字对齐）

```http
POST /device-tokens
Content-Type: application/json; charset=utf-8
Accept: application/json
x-kp-device-id: <config.deviceId>
x-kp-child-id: <config.childId>

{"platform":"android","token":"..."}
```

- **没有 `Idempotency-Key`**：服务端对同一 token 的注册是构造幂等（刷新 `lastSeenAt`），
  加幂等键只会让“第二次上报”拿到缓存回包而不刷新时间。
- 注销同理：`POST /device-tokens/revoke`，token **只在 body**，不进 URL。
- 回包解析为 `DeviceTokenDto`，**没有 `token` 字段**（后端刻意不回显）。
- 本地先按后端 DTO 同口径校验：8–512、无空白、平台在 `{ios,android,weapp}`；
  非法值用 `ArgumentError` 在发请求前拒绝（**异常 message 不含 token**）。

---

## 3. 关键实现决策

### 3.1 为什么单独一个 `DeviceTokenApi`，不并进 `WriteApi`

`WriteApi` 的每个方法都是“家庭业务写入”：失败会改变页面上的余额 / 列表，调用方必须处理。
token 上报是**附加能力**，失败只影响推送。如果把它加进 `WriteApi`：

1. 现有多个 `implements WriteApi` 的测试替身会全部编译失败，而它们与推送无关；
2. `AppStore` 会看起来拥有一个“推送”职责，之后任何重构都可能把它卷进业务错误处理；
3. “什么时候重试”会变得无法回答 —— 业务写入要立刻告诉用户，token 上报只该等下次启动。

因此它是**独立接口 + 独立客户端 + 独立错误出口**，唯一共享的是
`ReadApiConfig` 的身份头和 `WriteTransport` / `WriteApiException`。

### 3.2 409 是终点，不是可重试的失败

一个 token 只能属于一个账号。这个 409 重试一万次还是 409，所以上报器把
`(token → ownedByOther 结果)` 记在本次进程内；同一 token 再来直接短路，**一个请求都不发**。
换 token 后自动解除（用例覆盖“换 token 后能重新登记”）。

这不是缓存失败：网络 / 5xx / 401 一律不缓存，下次 `report()` 会重新发。

### 3.3 注销 404 按“已注销”处理

`DEVICE_TOKEN_NOT_FOUND` 的目标状态已经达成（这个 token 本来就不在本账号下），
报成失败只会让人去重试一个永远不会成功的请求。注销成功与 404 都清空本地缓存。

### 3.4 日志里没有 token —— 包括 SDK 自己抛的异常

两条硬约束：

- `PushTokenResult.message` / `dto` 不含 token；
- `[push]` 日志只打状态与原因，**SDK 异常只打 `runtimeType`**。

第二条是实测逼出来的：最初日志打 `$error`，测试里 `StateError('messaging not ready')`
通过了，但真实 SDK 的异常串经常把 token 一起带出来（例如 `Invalid token: eyJ...`）。
只打类型既保留了“哪类错误”的诊断价值，又不会把凭据写进日志。

`DeviceTokenApiClient` 的 `ArgumentError` 也刻意不用 `ArgumentError.value(token, ...)`
—— 那个构造会把 token 放进 `toString()`。

### 3.5 为什么编译期 token 只允许调试构建

`KP_PUSH_TOKEN` 天生只能用于手工联调：真实 token 由 APNs / FCM 在运行时下发。
发布包里若带一个写死的 token，所有安装都会登记同一个地址（后端 409，推送永远不落到新用户）。
`allowConfiguredPushToken()` 因此是 `!release && !profile`，且**不提供**关闭开关。

### 3.6 小程序端本阶段不做（不是遗漏）

`weapp` 平台确实在枚举里，但微信小程序的“推送”是**订阅消息**：服务端要按
`openid` / `template_id` 发，而当前仓库**没有微信登录（code2session）链路**，
拿不到可信 `openid`。此时在 Taro 里造一个 `token` 来源只会是假数据，
会让 `DeviceToken` 表出现无法投递的行 —— 比“没上报”更糟。

因此 W6-E 明确只做 Flutter；小程序等微信登录落地后，再按
`PushTokenSource` 同款接口补 `weapp` 来源（或由服务端在 code2session 时写入）。

---

## 4. 证据（2026-10-25 实测）

```bash
cd kids_points_app
flutter analyze          # No issues found!（25.8s）
flutter test             # +240: All tests passed!
```

新增用例共 **40** 条：

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/device_token_api_test.dart` | 16 | DTO 严格解析（未知平台 / `active` 与 `revokedAt` 不一致 / 坏时间）、注册与注销的路径 / body / 请求头逐项、无 `Idempotency-Key`、本地长度 / 空白拒绝、未配置 `CLIENT_NOT_CONFIGURED`、409 / 404 业务码保留、空 / 非 JSON 回包、超时 / `SocketException`、注销 token 不进 URL |
| `test/push_token_registration_test.dart` | 24 | 配置四态、成功登记、同 token 去重、token 轮换、无 token / 空白 / SDK 抛错、平台不支持 / 平台 getter 抛错、409 单次短路、网络失败可重试、401 保留状态码、单飞 `identical`、注销成功 / 404 / 无 token、`close` 透传、日志与结果不含 token |

**顺手修掉一个与 W6-E 无关的“日期炸弹”**：`test/approvals_test.dart` 的默认
`expiresAt` 原为 `2026-10-23`，到 2026-10-25 已过期 ⇒ 批准按钮被禁用 ⇒
“批准先弹确认”用例变红（与服务端 / 本轮改动无关）。已把默认值改为 `2099-01-01`，
需要过期的用例仍显式传 `expiresAt`。修后全量 **240/240**。


---

## 5. 边界：现在仍然没有什么

1. **没有真实厂商 SDK**：不申请通知权限、不调 `FirebaseMessaging.getToken()`、
   不接 APNs。当前只有调试构建的固定 token。
2. **没有生命周期钩子**：只在 `main()` 报一次。token 在运行中轮换、App 从后台回来、
   用户刚授权通知，都不会触发第二次上报（`PushTokenRegistrar.report()` 可重复调用，
   只差接线）。
3. **没有退出登录自动注销**：当前没有登录链路；账号切换时不会调 `revoke()`。
4. **没有跨启动去重**：去重和 409 短路都是**进程内**的；冷启动会重新发一次
   （服务端构造幂等，只会刷新 `lastSeenAt`）。
5. **没有真机 / 真后端证据**：用例全部是注入替身，**没有**一条用真 `HttpClient`
   + 真 Nest 的端到端测试；也没有在手机上验证过通知弹出。
6. **没有网关 / 厂商凭据**：所以即使 `DeviceToken` 表有行，`PushRetryJob` 仍会
   以结构性失败走到 `expired`（W6-B / W6-C / W6-D 的边界未变）。
7. **小程序没有上报**（理由见 §3.6）。

---

## 6. 下一步（建议顺序）

1. **接真实 SDK**：实现 `PushTokenSource`（FCM / APNs），申请权限后再 `report()`；
   仍然只在 `PushTokenConfig` 之外加适配器，**不要**把 SDK 调用塞进 `main()`。
2. **接生命周期**：`AppLifecycleState.resumed` 与 SDK 的 token refresh 回调各调一次
   `report()`（单飞 + 去重已就绪）；退出登录调 `revoke()`。
3. **本地联调真链路**：起后端 + 配 `KP_PUSH_TOKEN`，确认 `DeviceToken` 真出现一行，
   且日志里没有 token；再手工调用一次 `/revoke` 验证 404 分支。
4. **小程序**：先做微信登录 / code2session，再决定 `weapp` token 的语义
   （openid 本身？还是服务端生成的投递标识？）—— **不要**先造一个假来源。
5. **端到端测试**：如果后端起得来，补一条“真 HTTP + 真 Prisma”的 smoke，
   把“客户端能写进库”从替身证据升级成集成证据。

---

## 7. 复跑命令

```bash
cd kids_points_app

# 静态检查 + 全量 Flutter 用例
flutter analyze
flutter test

# 只跑本轮新增的两组
flutter test test/device_token_api_test.dart test/push_token_registration_test.dart
```

后端基线未改动，仍以 `backend/npm run ci` / `ci:db` 为准（见 `32-w6d-handoff.md` §6）。

---

## 8. 文件清单

| 文件 | 作用 |
|---|---|
| `lib/data/device_token_api.dart` | `DeviceTokenDto`（严格解析、状态一致性）、`DeviceTokenApi`、`DeviceTokenApiClient` |
| `lib/data/push_token_registration.dart` | `PushTokenConfig`、`PushTokenSource` / `ConfiguredPushTokenSource`、`PushTokenStatus` / `PushTokenResult`、`PushTokenRegistrar` |
| `lib/main.dart` | `_reportPushToken()`，仅在后端已配置时 fire-and-forget |
| `test/device_token_api_test.dart` | API 契约与错误归类（16） |
| `test/push_token_registration_test.dart` | 配置 / 上报器行为（24） |
| `test/approvals_test.dart` | 仅改默认 `expiresAt`（日期炸弹，见 §4） |
