# 44 · W10-B：运行期身份闭环 ＋ App 自更新（2026-11-02）

> 本文是阶段交接单。两件事一起做，是因为它们共享同一个前提：
> **安装包里不再写死\"我是谁 / 我在哪个孩子上\"**。
> 身份链修好后，公开发布的包才能既连得上后端、又知道该不该提示更新。

---

## 1. 做了什么（一句话版）

| 项 | 之前 | 现在 |
|---|---|---|
| 设备 id | `--dart-define=KP_DEVICE_ID`（编译期） | 首启生成 `kp-dev-<24 hex>`，持久化到 `kp_session` |
| 孩子 id | `--dart-define=KP_CHILD_ID`（编译期） | 登录后 `POST /auth/child-session` 签发，持久化 |
| 冷启动 | 靠预置的演示会话行 | token + childId 在本地 ⇒ 直接进首页；缺一个就重新建立 |
| 无孩子账号 | 一屏 401 | 「先创建一个孩子」引导（同意 → `/children` → `child-session` → 改名） |
| 换账号 | 旧 childId 残留 | 登录前先清空；新账号重新建立，`AppStore.resetForIdentity()` 清缓存 |
| 版本更新 | 无 | `GET /app/version` + 启动检查 + 手动入口 + 浏览器下载 |

---

## 2. 代码落点

### 2.1 运行期身份

| 文件 | 职责 |
|---|---|
| `lib/data/session_store_base.dart` | `SessionSnapshot` / `SessionStore` / 设备 id 形状校验与生成 |
| `lib/data/session_store_io.dart` | `FileSessionStore`（`Directory.systemTemp/kp_session`，JSON） |
| `lib/data/session_store_web.dart` | `LocalStorageSessionStore`（`localStorage["kp_session"]`） |
| `lib/data/session_scope.dart` | 唯一持有者：`restore` / `beginAccount` / `adoptChild` / `clearChild` |
| `lib/data/identity_api.dart` | `GET /auth/session`、`POST /auth/child-session`、`POST /children`、`PATCH /child` |
| `lib/screens/account_gate.dart` | 五态闸门：checking / preparing / signedIn / needLogin / needChild / blocked |
| `lib/screens/create_child_screen.dart` | `membership == null` 的可执行引导 |
| `lib/data/read_api.dart` | `ReadApiConfig` 编译期只剩 `baseUrl`；身份改为运行期 getter |

`ReadApiConfig` 的三种校验刻意分开：

- `baseUrlError` —— 这个包连不连后端（决定预览模式 / 登录页）；
- `transportValidationError` —— `baseUrl + deviceId`（登录、child-session、日期码）；
- `validationError` —— 再加 `childId`（业务读写；缺孩子时**一个请求都不发**）。

### 2.2 版本更新

| 文件 | 职责 |
|---|---|
| `backend/src/app-version/*` | `GET /app/version`（`@Public()`）+ 纯函数 `resolveAppVersion` |
| `lib/data/app_version_api.dart` | DTO（严格校验 URL/版本号）+ 客户端 + 版本比较 |
| `lib/screens/update_gate.dart` | 启动 / 回前台检查（6h 节流）、更新弹窗、手动检查 |
| `lib/data/url_opener*.dart` | 打开外部链接：Android MethodChannel / 桌面 Process / Web `window.open` |
| `lib/app_version.dart` | 版本常量（与 `pubspec.yaml` 由用例双向钉住） |
| `android/.../MainActivity.kt` | `kp/url_opener` → `Intent.ACTION_VIEW` |

服务端配置（`backend/.env.example` 的 `APP_*` 段）全部有默认值；
版本号 / URL 形状不合法时**回退默认值并继续服务**，不会 500。

---

## 3. 验收证据（2026-11-02 本机实测）

| 项 | 命令 | 结果 |
|---|---|---|
| Flutter 静态检查 | `flutter analyze` | **No issues found**（15.2s） |
| Flutter 单测 | `flutter test` | **452 条全通过**（+28 条：session / identity / update） |
| 后端类型检查 | `npm run typecheck` + `typecheck:tests` | 0 error |
| 后端单测 | `npm test` | **61 个用例文件 / 1119 条全通过**（+1 文件 / +7 条） |
| 线上端点 | `curl https://hub.littlewish.top:8443/kids/app/version` | **200**，JSON 与默认配置逐字一致 |
| APK | `flutter build apk --release --dart-define=KP_API_BASE_URL=…/kids` | 见 README 的下载地址 |

新增用例钉住的行为：

- `session_scope_test.dart`：设备 id 跨进程复用 / 坏值重生成 / 换账号只清孩子 /
  没有 childId 时业务客户端**不发请求**；
- `identity_api_test.dart`：child-session 请求不带 `x-kp-child-id`、401 清 token、
  回包缺 `children` ⇒ malformed；
- `account_gate_identity_test.dart`：自动建会话、零孩子引导、失败可重试、
  `membership:null` 的二次确认、换账号不串数据；
- `app_version_test.dart`：数值版本比较、`javascript:` 下载地址被拒、
  登录前也能查版本、强制更新没有「稍后」。

---

## 4. 部署变更

1. **Caddy**：`hub.littlewish.top:8443` 新增
   `handle_path /kids/* { reverse_proxy 127.0.0.1:3000 }`。
   脚本：`deploy/ensure-kids-route.sh`（幂等、改前备份、`caddy validate` 失败自动还原）。
   ★ 2026-11-02 上午 cline-console 的部署把 IP 站点的 `@kids path /k/*` 移除了；
   现在 App 的 baseUrl 是 `https://hub.littlewish.top:8443/kids`。
2. **后端镜像**：新增 `AppVersionModule`，`docker compose build && up -d` 后
   `GET /app/version` 生效（不涉及数据库迁移）。
3. **APK 静态目录**：沿用已有的 `/app/*` →
   `/var/www/cline-hub/app/`。上传 `kids-points-1.0.1.apk` 与
   `kids-points-app.apk`（后者是 `/app/version` 返回的稳定地址）。
4. **版本号**：`pubspec.yaml`、`lib/app_version.dart`、服务器 `APP_LATEST_*`
   三处一起改。发布新版本时只换 APK 文件名并更新 `APP_LATEST_*`。

---

## 5. 诚实边界（本轮没做 / 没验）

- **没有真机走查**：P0-1 的链路由 widget 用例 + 线上 curl 证明接线，
  没有在真实 Android 设备上从登录点到首页（`43` §9 的缺口仍成立）。
- **签名仍是 debug key**：`android/app/build.gradle.kts` 的 release 仍用
  `signingConfigs.debug`，只适合内部分发；上架前必须换正式签名。
- **多孩子未做**：D1 的选择是首版只支持一个；多孩子时取第一个，是明确取舍。
- **iOS 未构建**：`url_opener_io.dart` 覆盖了 macOS / Linux，但 iOS 的
  `Info.plist` ATS 与真机安装未验证。
- **版本信息不落库**：`APP_*` 是环境变量，改完要 `docker compose up -d`；
  没有后台管理界面。
- **没有强制更新的服务端兜底**：`minimumVersion` 由客户端自觉判断，
  旧客户端（<1.0.1）根本不知道这个端点。
