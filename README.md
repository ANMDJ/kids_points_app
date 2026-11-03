# 积分小管家（kids_points_app）

一个面向孩子的「习惯打卡 + 积分奖励」Flutter App，按设计稿 1:1 实现了 5 个页面：

> 产品需求文档（PRD）：[`docs/PRD.md`](./docs/PRD.md)　·　可评审的设计事实源：[`docs/design/`](./docs/design/README.md)
>
> **续开发待办**（2026-11-02 快照，含实测基线与 P0/P1/P2 清单）：[`docs/design/43-open-work-backlog.md`](./docs/design/43-open-work-backlog.md)
>
> 微信小程序高保真原型（双击即开、可点可演示）：[`prototype/index.html`](./prototype/index.html)　·　说明见 [`prototype/README.md`](./prototype/README.md)

| 设计稿页面 | 实现文件 | 主要交互 |
| --- | --- | --- |
| 首页（积分罐 + 今天的习惯） | `lib/screens/home_screen.dart` | 点习惯卡打卡加分、长按撤销、“记一笔”手动加减分 |
| 心愿单（甜的心愿单） | `lib/screens/wishlist_screen.dart` | 积分够→“兑换”扣分并记录；不够→“还差 N”；新增/删除心愿 |
| 我的（孩子档案 + 战绩） | `lib/screens/profile_screen.dart` | 点头像改昵称、复制 ID、进入积分记录 / 积分规则、恢复演示数据（**仅开发环境**，release 构建会被闸门拒绝） |
| 积分记录 | `lib/screens/points_record_screen.dart` | 全部 / 表扬 / 兑换 / 调整 筛选，按 今天 / 昨天 分组 |
| 积分规则 | `lib/screens/points_rule_screen.dart` | 新增规则；长按规则可“加入今天的习惯”或删除 |

## 技术说明

- **纯 Flutter SDK 实现，零第三方依赖**：不引入 provider / intl / shared_preferences，`flutter pub get` 在离线环境也能通过。
- **状态管理**：`AppStore extends ChangeNotifier` + `AppScope extends InheritedNotifier<AppStore>`，放在 `MaterialApp` 之上，弹窗里也能取到同一个 store。
- **视觉**：所有插画都是 `CustomPainter` 手绘（积分罐、叶子装饰），emoji 作为插画元素，**不需要任何图片资源**，也不会出现资源路径报错。
- **数据持久化**：当前是内存态（重启回到**空态** —— 首启不预置演示数据，种子只在"恢复演示数据"与测试夹具里用）。要持久化只需在 `AppStore._persist()` 里写入
  `shared_preferences` / `sqflite`，UI 层无需改动（详见 `lib/data/app_store.dart` 注释）。
- **测试**：`test/app_test.dart` 覆盖打卡、重复打卡、撤销、加减分、兑换、筛选、新增规则以及 3 个界面冒烟用例。

## 如何运行

本目录只包含跨平台共享代码（`lib/`、`pubspec.yaml`、`test/`），平台工程目录需要由 Flutter 生成一次：

```bash
cd kids_points_app

# 1) 生成缺失的平台目录（web/ 已随仓库提供；已存在的不会被覆盖）
flutter create . --project-name kids_points_app --platforms=android,ios,web,windows

# 2) 拉依赖（离线环境可加 --offline）
flutter pub get

# 3) 运行（示例）
flutter run -d windows     # 桌面窗口，最快预览
flutter run -d chrome      # 浏览器
flutter run                # 连接的手机 / 模拟器
```

> 想在手机上看效果，推荐把窗口/设备宽度保持在 390~430 逻辑像素（iPhone 尺寸），布局就是设计稿的比例。

### 跑测试与静态检查

```bash
flutter analyze
flutter test
```

`test/platform_portability_test.dart` 是**平台无关**的（不 import `dart:io`），
所以同一批断言可以在浏览器里再跑一遍 —— 这是「Web 上真的能用」最直接的证据：

```bash
flutter test test/platform_portability_test.dart                    # VM：文件存储 + dart:io HttpClient
flutter test test/platform_portability_test.dart --platform chrome  # 浏览器：localStorage + XMLHttpRequest
```

> 其余用例会 `import 'dart:io'`（测试替身直接抛 `SocketException` 模拟断网），
> 只能在 VM 上跑，不要对整个 `test/` 目录加 `--platform chrome`。

### Web 预览（W10-A，2026-10-30）

`web/` 已随仓库提供，直接 `flutter run -d chrome` 就能启动，不必先 `flutter create`。

> ⚠️ **第一屏显示什么，由 `--dart-define` 决定，不是登录坏了。**
> 没配 `KP_API_BASE_URL` ⇒ `ReadApiConfig.hasBaseUrl` 为 `false`，
> `AccountGate` 据此判定为**预览模式并直接放行**（见 `lib/screens/account_gate.dart`
> 文件头）—— 于是你一进来就是首页 + 本地空态。
> 想看登录页，只配地址即可（设备 / 孩子 id 已在运行期生成与签发）：
>
> ```bash
> flutter run -d chrome --web-port=5173 \
>   --dart-define=KP_API_BASE_URL=http://127.0.0.1:3000
> ```
>
> 本地账号来自 `npm run seed:account`（`13800138000 / demo12345`）。
> 本地没有 token ⇒ 首屏就是「登录积分小管家」；登录成功后 token 落在
> 浏览器 `localStorage`（键 `kp_token`），刷新会直接进首页。
> 设备 id / 孩子 id 落在 `localStorage` 的 `kp_session`（JSON）。

### 连线上后端（Flutter App，W10-B 之后）

> ★ **编译期只需要一项**：`KP_API_BASE_URL`。
> `KP_DEVICE_ID` / `KP_CHILD_ID` **已废弃**（2026-11-02，P0-1）：
> 设备 id 首启生成并持久化（`kp_session`），孩子 id 登录后由
> `POST /auth/child-session` 签发。旧参数**填了也不生效** ——
> 这正是「换一个家庭不用重新打包」的前提。
>
> 没配 `KP_API_BASE_URL` ⇒ `ReadApiConfig.hasBaseUrl` 为 `false`，
> `AccountGate` 判定为**预览模式并直接放行**：你看到的是本地空态，
> **一个请求都不发，也没有任何报错**。

线上入口（App）：

| 入口 | baseUrl | 说明 |
| --- | --- | --- |
| 域名 + 8443 + `/kids`（**当前主路径**） | `https://hub.littlewish.top:8443/kids` | Caddy `handle_path /kids/*` → `127.0.0.1:3000`；证书系统可信，不需要明文例外 |
| IP + `/k`（小程序用） | `http://82.157.153.22/k` | 2026-11-02 起当前 Caddyfile 里这段随 cline-console 部署被移除；恢复前 App 用上面那条 |

`backend` 容器只发布到 `127.0.0.1:3000`（`deploy/compose.yaml`），公网**不能**
直连 `:3000`，必须经 Caddy。

```bash
# 构建正式包（不需要任何设备 / 孩子 id）
flutter build apk --release \
  --dart-define=KP_API_BASE_URL=https://hub.littlewish.top:8443/kids
```

首次启动的顺序（全部在 App 里自动完成）：

1. 登录（手机号 / 邮箱 + 密码）；**没有账号**时点「第一次用？用邀请码注册」（W11-A）→ token 落盘；
2. `GET /auth/session` 查成员位；
3. 有孩子 ⇒ `POST /auth/child-session` 建立 `(deviceId, childId)` 会话 → 首页；
4. 没有孩子 ⇒ 建孩子引导（同意 → `POST /children` → `child-session` → `PATCH /child` 改昵称）；
5. 失败 ⇒ 「暂时进不去」+ **重试 / 重新登录**，不会先渲染首页再被 401 打回。

冷启动：token + childId 都在本地 ⇒ 直接进首页；token 被撤销 / 换账号 ⇒
旧 childId 先被清掉，新账号重新建立会话（不串数据）。

### 第一次怎么登录（没有账号时）

**不开放自助注册**，但有两条**邀请码**来源（W11-A / W12，2026-11-02）：

| 来源 | 从哪拿 | 注册后是什么 |
| --- | --- | --- |
| **网站「邀请码获取」**（W12） | 打开 `…/invite`，填手机号 + 邮箱当场领取（默认每天 50 个、7 天有效） | 一个**零个孩子**的新账号，随后按引导建立孩子档案 |
| **家庭邀请码**（W11-A） | 家里已经在用的家长在小程序「我的 → 邀请码」生成 | 直接加入该家庭（`membership` 指向那个孩子） |

网站入口与 API 同源，**不需要改 Caddy**：
`https://hub.littlewish.top:8443/kids/invite` —— **当前唯一可用入口**（2026-11-03 实测 200）。
另两条**现在打不开**，别写进给用户的指引：

- `http://82.157.153.22/k/invite` → **404**（`/k` 段在 2026-11-02 的部署里被移除）；
- `https://www.littlewish.top:8443/invite` → **连不上**（`curl` 超时，见
  `docs/design/48-public-invite-acquisition.md` §7）。
每日额度 / 有效期可配：`REGISTRATION_INVITE_DAILY_LIMIT`（默认 `50`）、
`REGISTRATION_INVITE_TTL_DAYS`（默认 `7`），详见
[`docs/design/48-public-invite-acquisition.md`](./docs/design/48-public-invite-acquisition.md)。

**小程序与 App 都能注册，且互不依赖**：同一张码在任意一边用一次即失效；
两边是同一套账号（`User.phone/email`），注册后用同一个手机号/邮箱 + 密码在另一边登录即可，
不存在「必须先在某个端登录过」的前置。

| 你的情况 | 怎么进 |
| --- | --- |
| 本地演示（已存在的家长） | `cd backend && npm run seed:demo && npm run seed:account` → `13800138000 / demo12345` |
| 全新的人（本地） | 用 `seed:demo` 生成的邀请码 `MAMA2345`（guardian · 3 次名额 · 7 天）＋ 任意未注册手机号 ＋ 自定密码；或起本地服务后访问 `http://127.0.0.1:3000/invite` 领网站码 |
| 线上 | 打开 `https://hub.littlewish.top:8443/kids/invite` 领取网站码；或请家里已经在用的家长生成家庭邀请码。线上**没有**预置演示账号 |

登录页底部有「第一次用？用邀请码注册」：填邀请码 + 手机号/邮箱 + 密码即可，
注册成功**直接进 App**（不需要再登录一次）。失败时留在注册页，错误文案来自服务端；
点「返回登录」可以放弃注册（不会留下半成品账号 —— 后端是一个事务）。
小程序登录页有同一个入口（W12），注册页在 `kids_points_mp/src/pages/register/`。

密码要求（App 注册页密码框下面**常驻**这一行，不是输入就消失的占位符）：
**8–64 位，至少含一个字母；不能是纯数字、同一字符重复、常见弱密码，也不能和手机号/邮箱相同。**
App 在提交前用 `lib/data/password_rules.dart` 本地判一次（服务端规则的镜像），
不合格就直接在表单下方说清是哪一条 —— 不再发一次必然 400 的请求。服务端仍是唯一裁定者。

> **网站码绑定申请时填的手机号 + 邮箱**：注册页填的「手机号或邮箱」必须是其中**之一**，
> 否则会拿到 `409 INVITE_CODE_UNAVAILABLE`（四种「不能用」故意同形，不会告诉你原因）。
> App 注册页在标识输入框下也有这句提示（2026-11-03 补）。

> 邀请码是**凭据**：有次数上限 / 有效期 / 可吊销（家庭码），或单次 + 有效期（网站码）。
> 四种「不能用」（不存在 / 过期 / 用完 / 吊销）故意给同一个 `409 INVITE_CODE_UNAVAILABLE`
> —— 区分它们等于告诉别人「哪些码存在」。网站码还会核对**申请时填的手机号或邮箱**。
> 手机号已被注册时是 `409 IDENTIFIER_TAKEN`（提示直接登录），不是「格式不对」。

**注册时看到的 400 / 409 分别是什么意思**（2026-11-03 起 App 会显示**服务端那句原文**，
不再只说「HTTP 400」——原因见 `lib/data/write_api_errors.dart` 的 `serverMessage()`）：

| 状态 + `code` | 意思 | 下一步 |
| --- | --- | --- |
| `400 WEAK_PASSWORD` | 密码太弱：不足 8 位 / 纯数字 / 同一个字符重复 / 常见弱口令（如 `abc12345`、`12345678`）/ 与手机号邮箱相同 | 换 8–64 位、至少带一个字母的密码（App 注册页提交前已本地拦一次，2026-11-03 起） |
| `400 INVITE_CODE_MALFORMED` | 码的**形状**不对：不是 8 位，或含字母表里没有的 `0/O/1/I/L` | 照原码重抄（空格 / 连字符会自动去掉） |
| `400 INVALID_IDENTIFIER` | 手机号不是 11 位大陆号，或邮箱缺 `@` | 改输入 |
| `400 DEVICE_ID_REQUIRED` | App 没带上设备标识（首启生成失败） | 重启 App 再试 |
| `409 INVITE_CODE_UNAVAILABLE` | 码不存在 / 过期 / 用完 / 吊销，**或**网站码与这里填的手机号邮箱不一致 | 用申请时的号；或回 `/invite` 重新领一张 |
| `409 IDENTIFIER_TAKEN` | 这个手机号/邮箱已经注册过 | 点「返回登录」直接用密码登录 |

> 注册前已经登录过别的账号时，先到「我的 → 退出登录」再注册 —— App 之前的版本
> 没有这个入口，只能清应用数据（2026-11-03 已补）。

> 明文 HTTP 例外仍保留在 `AndroidManifest.xml`（`usesCleartextTraffic="true"`）
> 与 iOS ATS，只影响 `http://` 入口；走 `https://…:8443` 不需要它们。

### App 版本更新（W10-B，2026-11-02）

- 服务端：`GET /app/version`（**匿名**）返回最新版本 / 最低版本 / 下载地址 / 更新说明。
  数据源是环境变量（`backend/.env.example` 的 `APP_*` 段），配错会回退默认值、不会 500。
- 客户端：启动与回到前台时检查（6 小时节流）；有新版本才弹窗，可「稍后」；
  低于最低版本时强制更新（没有「稍后」）。
- 「立即更新」用系统浏览器打开 APK 直链（Android 走 `MethodChannel('kp/url_opener')`，
  桌面 / Web 各有实现，**仍然零第三方依赖**）；打不开时退回到「复制链接」。
- 手动入口：**登录页底部**「当前版本 vX · 检查更新」与「我的 → 检查更新（vX）」；
  有新版本时两处都会直接变成「发现新版本 vY · 点此更新」，「我的」页头像下方还会出现横幅。
- 发布新版要同时改三处：`pubspec.yaml` 的 `version:`、`lib/app_version.dart` 的常量、
  服务器的 `APP_LATEST_VERSION` / `APP_LATEST_BUILD`（测试会钉住前两处一致）。
- APK 放在 Caddy 的 `/app/*` 静态目录：

  ```text
  /var/www/cline-hub/app/kids-points-1.0.4.apk
  https://hub.littlewish.top:8443/app/kids-points-1.0.4.apk
  ```

- 当前这一版（**1.0.4+5**，2026-11-03 发布）的下载地址：
  <https://hub.littlewish.top:8443/app/kids-points-app.apk>
  （52,578,938 字节；与 `kids-points-1.0.4.apk` 同一份文件）


浏览器里没有 `dart:io`，所以下面三处各自有一份平台实现，由条件导入
（`if (dart.library.js_interop)`）在编译期选定 —— **上层业务代码只有一份**：

| 关注点 | 移动 / 桌面 | 浏览器 |
| --- | --- | --- |
| HTTP 传输层 | `http_transport_io.dart`：`dart:io HttpClient` | `http_transport_web.dart`：`XMLHttpRequest`（手写 `dart:js_interop`） |
| token 存储 | `token_store_io.dart`：缓存目录里的文件 | `token_store_web.dart`：`window.localStorage` |
| 操作系统名 | `operating_system_io.dart`：`Platform.operatingSystem` | `operating_system_web.dart`：固定 `web` |

仍然**零第三方依赖**：没有引入 `package:http` / `package:web` / `shared_preferences`。

联调时会撞上浏览器自己的规矩（与代码无关，但表现成「网络错误」）：

1. **CORS**（W10-A 已内置，`backend/src/cors.setup.ts`）：页面在 `http://localhost:PORT`、
   接口在 `http://127.0.0.1:3000` 属于跨源。请求带 `authorization` / `x-kp-device-id` /
   `content-type: application/json` ⇒ 浏览器先发 `OPTIONS` 预检；没有 CORS 响应头时
   真请求**根本不会发出**，界面提示「连不上服务器」。
   后端现在的口径：`NODE_ENV !== production` 且未配 `CORS_ALLOWED_ORIGINS` ⇒
   自动放行 `localhost` / `127.0.0.1` / `[::1]` 的**任意端口**；
   生产必须显式写白名单（留空 = 不启用，并打一条 warn）。
2. **混合内容**：页面是 `https://` 而接口是 `http://` 会被浏览器直接拦掉。
3. `--web-browser-flag="--disable-web-security"` 只能用于排查，**不要**当成方案。

Web 版定位是**预览 / 联调**：不做推送（`PushTokenConfig` 会明确拒绝 `web`），
也没有离线缓存策略。产出可部署静态站点用 `flutter build web --release`（输出到 `build/web/`）。

### 在浏览器里走一遍「登录 → 验证码 → 引导」（W10-A 已验证）

前提：本机 PostgreSQL 已启动，`backend/.env` 里的两条连接串可用。

```bash
# ① 迁移到最新（含 W9-D 给 User 加的 phone / email / passwordHash）
#    ★ 迁移要用**表所有者**连接串，应用角色没有 DDL 权限
cd backend
DATABASE_URL="$(grep '^MIGRATION_DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')" \
  npx prisma migrate deploy

# ② 演示家庭（demo-child / demo-guardian / demo-device-guardian）+ 演示登录账号
npm run seed:demo
npm run seed:account     # 13800138000 / demo12345

# ③ 起后端（日志里应能看到「CORS 已启用：本机 localhost / 127.0.0.1 / [::1] 任意端口」）
npm start

# ④ 另一个终端：起 Web 版
cd ..
flutter run -d chrome --web-port=5173 \
  --dart-define=KP_API_BASE_URL=http://127.0.0.1:3000 \
  --dart-define=KP_DEVICE_ID=demo-device-guardian \
  --dart-define=KP_CHILD_ID=demo-child
```

首屏是登录页 → 输入 `13800138000` / `demo12345` → 日期码闸门
（今天的码 = `MMDD` + ISO 星期两位；例：2026-10-30 是周五 ⇒ `103005`）→ 首次引导 7 步。

> 以上每一步都在真实无头 Chrome 里跑通过：`POST /auth/login-account` 200、
> token 写入 `localStorage["kp_token"]`、`GET /home` 200、日期码通过后进入引导页。
> 如果哪一步卡住，先看后端日志里有没有那条 `OPTIONS` —— 一条都没有就是预检没过。

## 目录结构

```
lib/
├── main.dart                   # 入口：AppScope + MaterialApp
├── theme/
│   ├── app_colors.dart         # 奶油黄 + 薄荷绿色板
│   └── app_theme.dart
├── models/                     # Habit / Wish / PointRecord / PointRule / ChildProfile
├── data/
│   ├── seed_data.dart          # 演示数据种子（**首启不加载**；仅供"恢复演示数据"与测试夹具）
│   ├── app_store.dart          # 状态中心：打卡 / 记一笔 / 兑换 / 规则
│   ├── app_scope.dart          # InheritedNotifier 注入
│   ├── http_transport.dart     # 传输层平台入口：VM 用 dart:io、Web 用 XMLHttpRequest
│   └── token_store.dart        # token 持有者 + 存储平台入口：VM 落文件、Web 用 localStorage
├── widgets/                    # 积分罐、叶子、软按钮、胶囊、卡片、步进器等组件
└── screens/
    ├── home_shell.dart         # 底部导航（首页 / 心愿单 / 我的）
    ├── home_screen.dart
    ├── wishlist_screen.dart
    ├── profile_screen.dart
    ├── points_record_screen.dart
    ├── points_rule_screen.dart
    └── sheets/                 # 记一笔 / 新增心愿 / 新增规则 / 规则操作
```

## 交互亮点

- 积分数字变化用 `TweenAnimationBuilder` 做了一个滚动动画，打卡/兑换时孩子能直观看到分数变化。
- 打卡成功后弹出提示，长按卡片可撤销（同时移除今天的表扬流水并扣回分数）。
- 心愿卡积分不足时按钮变成灰色的“还差 N”，并实时随积分变化。
- 新增规则时可以选加分或扣分方向、图标和分值；保存后可一键加入首页习惯。
