# 阶段 W6-F 交接单 · 推送 token 生命周期重报与注销入口

> **日期**：2026-10-25　**阶段**：W6-F（W6-E 遗留的「只在启动报一次」收口）
> **给**：接真实 APNs / FCM / 微信订阅消息、或在登录流程落地后接「退出即注销」的下一个会话。

**一句话**：W6-E 的 `PushTokenRegistrar` 不再是用完就关的一次性对象 ——
新增 `PushTokenRuntime` 持有它，启动上报一次、App 回到前台按 5 分钟冷却窗口重报、
`revoke()` 先停用再注销；Flutter 绑定只在 `PushTokenLifecycle` 这一层出现。

---

## 1. 本阶段做了什么

| # | 交付物 | 位置 |
|---|---|---|
| 1 | 进程级运行时：启动 / resume 冷却重报 / 注销停用 / 延迟释放 | `lib/data/push_token_runtime.dart` |
| 2 | Flutter 生命周期胶水：只监听 `resumed`，注册 / 摘除 `WidgetsBindingObserver` | `lib/data/push_token_lifecycle.dart` |
| 3 | `main()` 不再 `whenComplete(close)`；改为长期持有 runtime，首帧仍不等待网络 | `lib/main.dart` |
| 4 | 16 条新用例（启动 / 单飞 / 冷却 / 失败冷却 / 时钟回拨 / 注销 / dispose / 异常兜底 / 生命周期） | `test/push_token_runtime_test.dart` |

**没有改**：后端任何一行、`DeviceTokenApi`、`PushTokenRegistrar` 的行为、`WriteApi`、
`AppStore`、页面、权限矩阵（仍 35 个动作）。

---

## 2. 运行时状态机

```text
main()
  ├─ WidgetsFlutterBinding.ensureInitialized()
  ├─ ReadApiConfig 未配齐 → 不创建 runtime（本地预览照旧）
  └─ 配齐 → _startPushToken()
        ├─ PushTokenConfig.fromEnvironment()   // 没 token ⇒ return
        ├─ PushTokenRegistrar(api, source)
        ├─ PushTokenRuntime(registrar)         // 默认冷却 5 分钟
        └─ PushTokenLifecycle(runtime).start() // addObserver + runtime.start()
```

| 调用 | 行为 | 返回 |
|---|---|---|
| `runtime.start()` | 绕过冷却窗口；`registrar.report()` 自己仍按同 token 去重 / 单飞 | 必定非 null |
| `runtime.reportIfDue()` | 未 `start()` / 已注销 / 冷却中 ⇒ 不做事 | null = **什么都没做** |
| `runtime.revoke()` | **先**置 `stopped=true`，再等在途上报结束，最后 `registrar.revoke()` | 必定非 null |
| `runtime.dispose()` | 只释放一次；有在途请求则等它结束再 `close()` | void |

`start()` 与 `reportIfDue()` 共用同一个在途 Future：并发的 `start()` 返回
`identical(first, second) == true`，底层只发一次请求（16 条用例之一钉死）。

---

## 3. 关键实现决策

### 3.1 冷却窗口放在 runtime，不放进 registrar

`PushTokenRegistrar` 的契约是「你让我报，我就按单飞 / 去重报一次」——它是执行器。
「多久允许再报一次」是生命周期策略；放进 registrar 会让 `main()` 的启动语义也变含糊
（启动到底该不该绕过冷却？）。因此 runtime 持有 `minReportInterval`（默认 **5 分钟**），
`start()` 显式 `force: true`，`reportIfDue()` 才检查窗口。

### 3.2 失败也消耗冷却窗口

网络失败 / 5xx / 401 都会记录 `_lastAttemptAt`。否则用户每切一次前台就发一次请求，
断网时会形成「切前台 → 等 10 秒超时 → 再切」的循环。冷却过后仍会重试，且
`PushTokenRegistrar` 不缓存失败，所以不是「一次失败就永久放弃」。

### 3.3 注销先停用，再发请求

如果先 `await revoke()` 再置停用，一个并发的 `resumed` 可能在上报请求返回前又把
同一个 token 登记回去，用户退出登录后仍收推送。因此 `revoke()` 在**发请求之前**
就把 runtime 置为 `stopped`，并让 `reportIfDue()` 直接返回 null；注销失败也不会自动
恢复上报（要等下一次显式 `start()`，即下一次登录）。

### 3.4 只认 `resumed`

暂停 / 后台不触发上报：很多 SDK 在后台读 token 会失败，iOS 后台网络也不保证执行。
回到前台再读来源既安全又足够覆盖「token 轮换 / 用户刚授权通知」两个场景。

### 3.5 dispose 等待在途请求

`dispose()` 若立刻 `close()` HttpClient，正在进行的上报会以「连接被关闭」失败，
日志里出现一个与用户无关的错误。runtime 因此记录 `_inFlight`，只有它结束后才
`registrar.close()`；重复 `dispose()` 只 close 一次（用例覆盖）。

### 3.6 为什么数据层还留一个 Flutter 文件

`PushTokenRuntime` 是纯 Dart（不 import Flutter），全部策略都能脱离
`WidgetsBinding` 单测；`PushTokenLifecycle` 只做 `addObserver` / `removeObserver`
和状态过滤。这样接真实 SDK 时不需要把测试跑在 widget binding 上。

---

## 4. 证据（2026-10-25 实测）

```bash
cd kids_points_app
flutter analyze          # No issues found!
flutter test             # +256: All tests passed!
flutter test test/push_token_runtime_test.dart   # +16: All tests passed!
```

新增 16 条覆盖：

| 组 | 覆盖 |
|---|---|
| 启动与单飞 | 立即上报并记录尝试时刻；并发 `start()` 同一 Future；未 start 的 resume 不发请求 |
| 冷却与轮换 | 1 分钟内不报、5 分钟后报；失败也消耗窗口；时钟回拨不永久锁死 |
| 注销与停用 | 注销后 resume 不再登记；等在途上报结束再注销；注销后 `start()` 可重新登记 |
| 释放与兜底 | dispose 后全部 no-op；重复 dispose 只 close 一次；在途请求结束才 close；registrar 抛错被兜住且日志无 token |
| 生命周期 | 只认 resumed；重复 start 不重复上报；退出登录 revoke 后 resume 不登记 |

---

## 5. 边界：现在仍然没有什么

1. **仍然没有真实厂商 SDK**：没有 `firebase_messaging` / APNs / 微信订阅消息依赖，
   没有通知权限申请；当前 token 来源仍是**仅调试构建**的 `KP_PUSH_TOKEN`。
2. **没有订阅 SDK 的 token refresh 流**：轮换要等下一次 `resumed` 才会被读到；
   真实 SDK 落地后可以加 `Stream<String>` 直接触发 `reportIfDue(force: true)`。
3. **没有登录流程，所以没有真正的「退出登录」调用点**：`revoke()` 入口已就绪，
   但当前 UI 没有账号态，不能假装已经接上。
4. **没有跨启动持久化去重**：冷启动仍会发一次（服务端构造幂等，只刷新 `lastSeenAt`）。
5. **没有真机 / 真后端证据**：16 条仍是注入替身；没有一条真 HTTP + 真 Nest 的 e2e。
6. **没有网关 / 厂商凭据**：`DeviceToken` 表即使有行，`PushRetryJob` 仍会结构性失败。
7. **小程序仍没有上报**（缺微信登录 / 可信 `openid`，理由见 `33-w6e-handoff.md` §3.6）。

---

## 6. 下一步（建议顺序）

1. **接真实 SDK**：实现 `PushTokenSource`（FCM / APNs），申请权限后调用
   `PushTokenLifecycle.start()`；token refresh 回调里调用 `reportIfDue()` 或
   `start()`。不要把 SDK 调用塞进 `main()`。
2. **登录流程落地时接注销**：退出登录 / 切换账号调用 `PushTokenLifecycle.revoke()`；
   重新登录后调用 `start()` 恢复。
3. **本地联调真链路**：起后端 + `KP_PUSH_TOKEN`，确认 `DeviceToken` 真出现一行，
   且日志不含 token；再手工 resume 一次确认没有重复行（服务端刷新 `lastSeenAt`）。
4. **小程序**：先做微信登录 / code2session，再决定 `weapp` token 语义；
   **不要**先造一个假来源。
5. **端到端测试**：已由 **W6-G** 补上 —— `backend/test-db/push-delivery-e2e-db.dbtest.ts`
   用真 `AppModule` / 真 Prisma / 真 `PushRetryWorker.tick()` / 真 `WebhookPushAdapter`
   打到本地 `node:http` 网关（200 / 500 / 410 / 无 token 四类分支）。
   仍未验证的是「网关再往后的真实厂商投递」，见 `35-w6g-handoff.md` §5。

---

## 7. 复跑命令

```bash
cd kids_points_app

flutter analyze
flutter test
flutter test test/push_token_runtime_test.dart

dart format --output=none --set-exit-if-changed \
  lib/data/push_token_runtime.dart \
  lib/data/push_token_lifecycle.dart \
  lib/main.dart \
  test/push_token_runtime_test.dart
```

> 不要对全仓库跑 `dart format`：基线里仍有 23 个**与 W6-F 无关**的文件不符合当前
> formatter 版本；全量格式化会制造一大片无意义 diff。只检查本轮碰过的文件。
