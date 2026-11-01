# 积分小管家（kids_points_app）

一个面向孩子的「习惯打卡 + 积分奖励」Flutter App，按设计稿 1:1 实现了 5 个页面：

> 产品需求文档（PRD）：[`docs/PRD.md`](./docs/PRD.md)　·　可评审的设计事实源：[`docs/design/`](./docs/design/README.md)
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
> 三项配置（`KP_API_BASE_URL` / `KP_DEVICE_ID` / `KP_CHILD_ID`）缺任何一项，
> `ReadApiConfig.isConfigured` 就是 `false`，`AccountGate` 据此判定为**预览模式并直接放行**
> （见 `lib/screens/account_gate.dart` 文件头）—— 于是你一进来就是首页 + 本地演示数据。
> 想看登录页，把三项配齐再启动：
>
> ```bash
> flutter run -d chrome --web-port=5173 \
>   --dart-define=KP_API_BASE_URL=http://127.0.0.1:3000 \
>   --dart-define=KP_DEVICE_ID=demo-device-guardian \
>   --dart-define=KP_CHILD_ID=demo-child
> ```
>
> `demo-device-guardian` / `demo-child` 来自 `npm run seed:demo`（见下面的完整步骤）。
> 配齐且本地没有 token ⇒ 首屏就是「登录积分小管家」；登录成功后 token 落在
> 浏览器 `localStorage`（键 `kp_token`），刷新会直接进首页。

### 连线上后端（Flutter App，2026-11-01）

> ★ **先记住这条**：三项 `--dart-define` **缺任何一项**，`ReadApiConfig.isConfigured`
> 就是 `false`，`AccountGate` 判定为**预览模式并直接放行**（`account_gate.dart:94`）——
> 于是你看到的是 seed 演示数据、**一个请求都不发，而且没有任何报错**。
> 「配了地址却还是演示数据」几乎都是漏了后两项。

线上有两个入口，App 两个都能用：

| 入口 | baseUrl | 前提 |
| --- | --- | --- |
| IP + `/k` 前缀（**小程序**用） | `http://82.157.153.22/k` | 平台放行明文（已配好，见下） |
| 域名 + 8443（**App 主路径**） | `https://www.littlewish.top:8443` | 腾讯云 DV 证书已固定、8443 已放行 |

`backend` 容器只发布到 `127.0.0.1:3000`（`deploy/compose.yaml:26`），公网**不能**
直连 `:3000`，必须经 Caddy。

#### 走 IP（当下可用）

`deploy/README.md` §4 的 `@kids` 段已经 `uri strip_prefix /k`，所以把 `/k` 当成
baseUrl 的一部分即可。**端口不受影响**：`ReadApiConfig.uri()` 用的是
`base.replace(path: …)`（`read_api.dart:83`），host 与 port 原样保留。

```bash
flutter run -d <device> \
  --dart-define=KP_API_BASE_URL=http://82.157.153.22/k \
  --dart-define=KP_DEVICE_ID=demo-device-guardian \
  --dart-define=KP_CHILD_ID=demo-child
```

> 明文 HTTP 在 Android（targetSdk ≥ 28）和 iOS（ATS）上**默认都是禁的**，这次一并开了例外：
> `android/app/src/main/AndroidManifest.xml` 的 `android:usesCleartextTraffic="true"`、
> `ios/Runner/Info.plist` 的 `NSAppTransportSecurity → NSAllowsArbitraryLoads`。
> 不开的表现是「网络错误」——请求在**系统网络栈**就被拒，后端日志里一条都不会有。

⚠️ 线上要先跑过 `deploy/README.md` §6.3（`seed:demo` + `seed:account`），
否则会**登录成功、之后每个请求都 401**（`x-kp-device-id` 查不到 `DeviceSession`）。

#### 走 8443（App 主路径，且不需要任何明文例外）

小程序受微信「服务器域名 + 备案」约束，**Flutter App 不受**：自建 App 只要求
证书能被系统信任，没有 ICP 前置条件。8443 的价值是绕开未备案域名在 80/443 上
可能被运营商/云厂商拦截的问题。

服务器侧**已经配好**（腾讯云证书已固定、安全组已放行 8443）。要复核就一条命令：

```bash
bash deploy/smoke-8443.sh     # 7 项全绿再动客户端；跑完会打印该用的 baseUrl
```

> ⚠️ **别把小程序也切到 8443**：微信后台的「服务器域名」要求域名**已备案**，
> 备案没下来之前那个输入框根本填不进去。小程序继续用 `http://82.157.153.22/k`，
> 两条入口并存是正确状态（`deploy/smoke-8443.sh` 第 6 项专门验证 `/k` 没被挤掉）。

客户端**代码一行不用改**，只换地址：

```bash
flutter run -d <device> \
  --dart-define=KP_API_BASE_URL=https://www.littlewish.top:8443 \
  --dart-define=KP_DEVICE_ID=demo-device-guardian \
  --dart-define=KP_CHILD_ID=demo-child
```

> 走 https 之后，上面那两处明文例外都应当删掉。注意 `IoReadTransport` 用的是原生
> `HttpClient` 且**没有** `badCertificateCallback`（`http_transport_io.dart`），
> 所以自签名证书一定失败 —— 必须是**系统信任**的证书。
>
> **为什么是 `www` 而不是 `kids`（2026-11-01 实测结论）**：
> `kids.littlewish.top` 走 ACME 自动签发**签不出来**。Let's Encrypt 是多视角验证，
> 亚太节点拿到的是 DNSPod 备案拦截页（`reader size limit exceeded`），
> TLS-ALPN-01 走 443 又直接 `Connection reset by peer`；Caddy 自动切到 ZeroSSL 同样未成。
> 于是改用腾讯云手动签发的 DV 证书 —— 但它的 SAN 是
> `littlewish.top` + `www.littlewish.top`，**不含** `*.littlewish.top`，
> 而 `www` 恰好已解析到 82.157.153.22（主域 `littlewish.top` 还没有 A 记录）。
> 所以当前唯一能通过系统证书校验的入口就是 `https://www.littlewish.top:8443`。
>
> ⚠️ 这张证书 **2027-01-29 到期，且不会自动续期**。到期前去腾讯云重新签发，
> 覆盖服务器上的 `/etc/caddy/certs/littlewish.top.{crt,key}`，再 `systemctl reload caddy`。
> 想彻底摆脱手动续期，只有两条路：① 拿到 `kids.littlewish.top` 的证书；
> ② 给 Caddy 重编译加 DNSPod 插件，走 DNS-01 签通配符。

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
