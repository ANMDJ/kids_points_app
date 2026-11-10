# 52 · 本机 PIN 锁 ＋ 申请/消息整页化（2026-11-04）

> 用户原话（本轮四条）：
> 1. 「页面调整：把『申请』和『消息』两个页面改成列表形式，不要弹窗。」
> 2. 「PIN 码输入：把 PIN 码改成数字输入，像锁屏那样。」
> 3. 「锁屏功能修改：去掉日期规则验证功能，那个锁屏没有意义，把它改成 PIN 锁。」
> 4. 「家长模式逻辑：(a) 当前不是默认家长模式吗？家长进来的时候先设置 PIN 码。
>    (b) 只要应用退出前台，再回来的时候就需要重新输入 PIN 码验证。」
>
> 这份文档只回答三件事：**改在哪、为什么这么改、哪些边界还没做**。
> 功能设计的上游仍是 `02` §7（家长模式 / PIN）与 `51`（孩子模式窗口）。

---

## 1. 四条需求 → 落地位置

| 需求 | 落地 | 证据（文件） |
|---|---|---|
| ① 申请 / 消息改成整页列表 | 新页面 `MyApplicationsScreen` / `NotificationsScreen`（`Scaffold` ＋ `GradientPage` ＋ `PageHeader` ＋ `ListView`）；入口从「弹窗」改成 `Navigator.push` | `lib/screens/my_applications_screen.dart`、`lib/screens/notifications_screen.dart`、`lib/screens/profile_screen.dart`（两处 `onTap`）；**删除** `lib/screens/sheets/my_applications_sheet.dart`、`lib/screens/sheets/notifications_sheet.dart` |
| ② PIN 改成「锁屏式数字输入」 | 新组件 `PinPad`：6 个圆点 ＋ 自绘数字键盘（0–9 / 退格 / 清空），**不弹系统键盘**；四处使用：本机锁屏、家长模式面板、设置 PIN 页、**首启引导第⑥步** | `lib/widgets/pin_pad.dart`；`lib/screens/pin_guard.dart`；`lib/screens/sheets/parent_mode_sheet.dart`；`lib/screens/parent_pin_setup_screen.dart`；`lib/screens/onboarding_screen.dart`（`_stepPin()`） |
| ③ 去掉「日期规则」锁屏，改成 PIN 锁 | `DateCodeGate` 整条链路删除（界面 / 客户端 / DTO / 用例）；`main.dart` 换成 `PinGuard` | **删除**：`lib/screens/date_code_gate.dart`、`lib/data/date_code_api.dart`、`lib/data/date_code_dto.dart`、`test/date_code_gate_test.dart`、`test/date_code_test.dart`；`lib/main.dart` 的 `home` = `OnboardingGate → PinGuard → HomeShell` |
| ④(a) 家长进来先设 PIN | 家长身份 ＋ 服务端说「没有 PIN」⇒ 强制设置页（三步：当前 PIN → 新 PIN → 再输一遍） | `lib/screens/pin_guard.dart` 的 `!isParentPinConfigured && isParentMode` 分支；`lib/screens/parent_pin_setup_screen.dart`（`gate: true`） |
| ④(b) 退出前台回来要重新输 PIN | `PinGuard` 监听 `AppLifecycleState.paused / hidden` ⇒ `store.lockAppForBackground()`；回前台不自动解锁 | `lib/screens/pin_guard.dart` 的 `didChangeAppLifecycleState`；`lib/data/app_store.dart` 的 `lockAppForBackground()` / `settleAppLockAfterResume()` |

**注意**：服务端 `POST /auth/date-code`（`backend/src/identity/`）**没有删**。
它是匿名校验端点、不写任何数据，删掉要动迁移与小程序契约；App 只是**不再调用**它。
要彻底下线应另开一条任务（见 §5）。

---

## 2. 为什么「解锁」不能复用 `POST /auth/parent-mode`

> ★ **2026-11-10 修订（产品要求，见 [`54`](./54-pin-window-tabs-and-habits.md)）**：
> 本节的口径**仍然成立**于「设 / 改 PIN 的第一步：验证当前 PIN」和「成员位被降级 /
> 旧服务端」的降级路径；但**用户明确要求**「输入 PIN = 进入家长模式 + 5 分钟倒计时」，
> 所以 `PinGuard` 的解锁现在**就是** `POST /auth/parent-mode`（再输一次即重置 5 分钟）。
> 代价（那台设备的 30 天家长会话会被写成 5 分钟）已在 `54` §3 写清，且回退只需把
> `unlockAppWithPin` 改回调 `checkParentPin`。

这是本轮**唯一**需要动后端的理由，也是很容易踩回来的一步。

| 事实 | 出处 |
|---|---|
| `POST /auth/parent-mode` 写库时把 `expiresAt` 固定成 `now + 5 分钟` | `backend/src/auth/auth.service.ts` 的 `enterParentMode`（`expiresAt: parentModeExpiresAt(now)`） |
| 一台**以家长身份登录**的设备（邀请码加入，会话 30 天）本来就 `guardian`；它的「来源」是按剩余时间派的：`> 300 秒 ⇒ session` | `backend/src/auth/parent-mode.policy.ts#parentModeSourceOf`、`PARENT_MODE_TTL_MS = 5 * 60 * 1000` |
| 所以：解锁若走 `POST /auth/parent-mode`，家长设备解锁一次就被压成 5 分钟，5 分钟后掉回 `child` | 上面的两行合起来就是结论 —— 这也正是用户问「当前不是默认家长模式吗」的成因 |

于是新增**只校验、不改角色**的端点：

```
POST /auth/parent-pin/verify   权限动作：switch_role_mode（矩阵对孩子也 ALLOW）
请求 { pin }
200  { valid: true, remainingAttempts }
400  PARENT_PIN_FORMAT_INVALID（不计次）
403  PARENT_PIN_INVALID（计次，回 remainingAttempts）
409  PARENT_PIN_NOT_SET
429  PARENT_PIN_LOCKED（锁定期内连 scrypt 都不跑）
```

实现与口径：`backend/src/auth/auth.service.ts#verifyParentPin`、路由在
`backend/src/auth/auth.controller.ts`（`@Post('parent-pin/verify')`）、DTO 在
`backend/src/auth/dto/verify-parent-pin.dto.ts`。

三个**刻意**的选择：

1. **成功不清零 `pinFailedCount`**：这个端点必须能对「孩子模式进行中」的设备使用
   （锁屏不该被 409 卡住），而任何一次写会话行都会与 `kidModeUntil` 的优先级打架。
   清零点仍然只有 `enterParentMode` / `setParentPin`。
2. **不要求成员位是 guardian**：PIN 落在成员位上。若一位家长被降级成 child，
   他仍应该能解开自己手机上的锁；这个端点不授予任何权限。要求 guardian 会让那台
   设备变成**永久打不开**（又一个 D7）。
3. **旧服务端的降级**：客户端收到 **404** 时退回 `enterParentMode()`
   （`lib/data/app_store.dart#_unlockByEnteringParentMode`）。代价是那台设备会变成
   5 分钟窗口 —— 宁可降级，也不能让用户永远停在锁屏。

---

## 3. 状态机（`PinGuard`）

| 条件（按顺序判） | 显示 |
|---|---|
| 没注入家长模式客户端（预览 / 测试夹具） | 直接放行 |
| 一次都拉不到 `/auth/parent-mode`（`parentModeReadStatus == error`） | 放行（软锁不 brick，见 §4） |
| 状态还没拉到（idle / loading） | 「正在准备本机锁…」（不露一眼首页） |
| 已拉到、`pinConfigured == false`、且**当前是家长模式** | 强制「先设置家长 PIN」 |
| 已拉到、`pinConfigured == false`、且不是家长模式（孩子自己的设备） | 放行（孩子没有 `manage_parent_pin` 权限，拦了就是第七个「做不到的提示」） |
| 孩子模式**窗口内**（`kidModeUntil > now`） | 放行（锁上会让孩子切一次应用就再也回不来） |
| `isAppUnlocked` | 显示 `child`（首页） |
| 其余（冷启动 / 从后台回来 / 孩子模式到点） | 「已锁定」＋ PinPad ＋「解锁」 |

解锁成功会写入 `isAppUnlocked = true` 的时机只有四个：
`unlockAppWithPin()`、`enterParentMode()`、`exitKidMode()`、`setParentPin()`
（后三个都是「刚刚证明过自己知道 PIN」，否则用户会立刻被再问一次）。
`_resetToEmpty()`（冷启动 / 换身份）把它清回 `false`。

---

## 4. 已知边界（不粉饰）

1. **它是软锁，不是安全边界。** 值对不对只在服务端判定（库里只有 `scrypt$…`）；
   客户端不保存任何 PIN 的派生值，所以：
   - **断网时解不开**（显示网络错误，不是「PIN 错」）；
   - 反过来，**一次都拉不到 `/auth/parent-mode`**（不知道有没有 PIN）时闸门放行。
     这意味着「飞行模式 ＋ 杀进程」可以绕过这道门 —— 与旧日期码闸门同一量级
     （旧的那道门连码都能从界面算出来）。真正拦住越权的仍然是服务端矩阵。
2. **只有 `paused` / `hidden` 才算「退出前台」。** `inactive`（下拉通知栏、来电横幅、
   系统弹窗）**不锁** —— 否则家长每瞥一眼通知都要重新输一遍 PIN。
3. **孩子模式窗口内不锁。** 手机本来就是给孩子用的；窗口结束时：
   - 应用在后台 ⇒ 回来时 `settleAppLockAfterResume()` 补锁；
   - 应用一直开着 ⇒ 下次回到前台 / 重建时锁上（孩子模式横幅会显示「时间到了」）。
   这是 `51` 的 A 方案（到点不自动回家长模式）在锁屏上的延伸。
4. **解锁改角色（2026-11-10 起）。** 旧口径是「解锁不改角色」，现在按用户第 1 / 13 条
   改成「解锁 = 进入家长模式，5 分钟窗口」，倒计时显示在四个 tab 的抬头栏
   （`lib/widgets/parent_mode_banner.dart`）。因此 `child` 设备解锁后仍是 `child`
   （成员位决定），而**家长设备**解锁后拿到的是 5 分钟窗口，不再是 30 天。
   详见 [`54`](./54-pin-window-tabs-and-habits.md) §2 / §3。
5. **锁状态不持久化。** App 被杀后重开 = 重新锁（与旧闸门一致）；这是刻意的：
   把「已解锁」写进磁盘等于让「杀进程再开」变成一次绕过。

---

## 5. 验收证据（本轮实跑）

| 判据 | 结果 |
|---|---|
| `flutter analyze` | **No issues found! (ran in 24.2s)** |
| `flutter test` | **509 全通过**（新增 `test/pin_pad_test.dart` 7 条 ＋ `test/pin_guard_test.dart` **10** 条） |
| 后端 `npm test` | **66 个用例文件 / 1201 个用例全部通过**；新增「组 H：`POST /auth/parent-pin/verify`」6 条（正确 200 / 403 计次 / 400 不计次 / 409 没设 PIN / 429 锁定 / 孩子模式也能验） |
| 后端 `npm run typecheck` ＋ `typecheck:tests` | 0 error |
| 旧用例 | `date_code_gate_test.dart` / `date_code_test.dart` 随功能删除；`notifications_test.dart` / `parent_mode_test.dart` 原断言不改仍全绿 |
| **线上新端点** | 镜像重建 + `up -d` 后容器 `(healthy)`；`POST http://127.0.0.1:3000/auth/parent-pin/verify` → **401**（未认证；部署前是 **404**）；`GET /health` → **200**。旧客户端不受影响（它们不调这条） |

### 5.1 复现命令

```bash
# App
flutter analyze
flutter test

# 后端（无库）
cd backend && npm run typecheck && npm test

# 线上（只读探针）
ssh -i ~/.ssh/kids.pem ubuntu@82.157.153.22 \
  'curl -s -o /dev/null -w %{http_code} -X POST -H content-type:application/json \
   -d {} http://127.0.0.1:3000/auth/parent-pin/verify'   # 期望 401（不是 404）
```

---

## 6. 还没做（每条都标卡点类别，口径见 `50-unfinished-reasons-and-unblock.md`）

| 事项 | 卡点 | 说明 |
|---|---|---|
| 新 App 包（APK / 小程序）没有构建与上传 | **APK ✅ 已发（2026-11-05，1.0.6+7）· 小程序仍是 C** | **2026-11-05 已补发 APK**：`pubspec.yaml` / `lib/app_version.dart` → `1.0.6 / 7`，`flutter build apk --release --dart-define=KP_API_BASE_URL=https://hub.littlewish.top:8443/kids` 产出 **52,825,362 字节**，上传 `/app/kids-points-1.0.6.apk` ＋ 稳定地址 `kids-points-app.apk`，`kids.env` 的 `APP_LATEST_*` 同步后 `up -d --force-recreate kids-api`，线上 `/kids/app/version` = `1.0.6 / 7`。**上一轮（2026-11-04）就是漏了这一步**：1.0.5+6 的包打包于 04:25，比本文件对应的提交（06:38）早 2 小时，所以旧包里日期码闸门照旧 —— 用户 2026-11-05 报「不是已经去掉了吗」。小程序 `dist/` 仍未上传（A 类） |
| 真机验收：锁屏键盘手感、后台往返、孩子模式到点 | **D**（要真机） | 本环境无 Android 设备 / 无 GUI |
| `POST /auth/date-code` 服务端端点仍在 | **B**（要产品裁定） | 删它要动迁移 + `41` 交接单 + 小程序契约；App 已零调用方 |


