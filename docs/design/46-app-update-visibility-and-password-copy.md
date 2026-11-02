# 46 · W11-B：更新入口可见性 ＋「忘记密码」的 App 内说明（2026-11-02）

> 本文是一次**产品反馈驱动**的收口：用户说「我看不到更新按钮」「APP 的忘记密码文案
> 为什么在讲小程序」。两条都不是新功能，而是**已有的能力没有被摆到用户面前**。
>
> 前置：`44`（App 自更新）、`42` §5.2（忘记密码 = 回小程序重设）、`45`（邀请码注册）。
>
> **2026-11-02 修订**：§2.1 明确区分「注册（create）」与「重设（update）」；
> 新增 §2.2 记录「注册邀请 / 加入邀请目前共用同一张 `InviteCode`」。

---

## 1. 反馈对应的真实缺口

| 用户看到的现象 | 代码里的真实原因 | 本轮怎么改 |
|---|---|---|
| 打开 App 没有「更新」按钮 | ① 线上 `APP_LATEST_*` 与安装包**同版本**（1.0.1+2）⇒ 本来就不该提示；② 手动入口只在「我的 → 检查更新」，而登录闸门在里面 ⇒ 登录不进去的人永远看不到 | 登录页底部常驻「当前版本 · 检查更新」；有新版时变成「发现新版本 vX · 点此更新」；「我的」页头像下方加横幅 |
| 「APP 的忘记密码为什么写在小程序」 | 登录页只有一行灰色转述，没有可点入口；注册冲突的 409 文案也直接写「请在小程序里重设」 | 登录页加可点的「忘记密码？」→ App 自己的对话框写清四步；服务端 409 / 401 文案改成「返回登录 → 点忘记密码查看步骤」 |
| 新功能（邀请码注册）没出现 | 13:46 构建的 APK 早于 14:00 之后的 W11-A 改动 | 版本升到 **1.0.2+3** 并重新发布 APK（见 §3） |

---

## 2. 代码落点

| 文件 | 改动 |
|---|---|
| `lib/screens/login_screen.dart` | 新增「忘记密码？」TextButton + 四步说明对话框；底部 `_VersionFooter`（无版本服务 ⇒ 只报版本，不画假按钮） |
| `lib/screens/profile_screen.dart` | 头像下方 `_UpdateBanner`；「检查更新」行在 `hasUpdate` 时直接写「发现新版本 vX · 点此更新」 |
| `lib/data/auth_api.dart` | `CLIENT_NO_TOKEN` 文案：补充「用邀请码注册 / 在小程序绑定」两条真实入口 |
| `backend/src/identity/identity.service.ts` | 统一 401 文案：指向「我的 → App 登录账号」，并说明忘记密码也在那里重设（**不改变**三态同形判定） |
| `backend/src/identity/invite-registration.prisma.repository.ts` | `IDENTIFIER_TAKEN` 409 文案：改成「返回登录 → 点忘记密码查看步骤」 |
| `pubspec.yaml` / `lib/app_version.dart` / `backend/src/app-version/app-version.policy.ts` | 版本号 **1.0.2+3**；默认 `APP_*` 与发布说明同步 |
| `backend/.env.example` / `README.md` / `deploy/README.md` | 发布手册同步到 1.0.2+3 与新的两个入口 |

### 2.1 为什么「忘记密码」仍然不在 App 里直接改

> **这一节只回答「重设密码」（改写一个已存在的账号），不是在质疑邀请码注册。**
> 注册永远不会改到别人的账号：手机号已存在时 `POST /auth/register-invite`
> 直接 409 `IDENTIFIER_TAKEN`（`user.create` + 唯一索引，零字段写入）。
> 两者的区别见下面的对照表。

改密必须先证明「这个号是你的」。本项目**零短信、零邮件**（`42` §0），
所以唯一自洽的证明就是小程序里的微信登录（`42` §5.2）。

| | 注册（`POST /auth/register-invite`） | 重设密码（**当前不存在**） |
|---|---|---|
| 对 `User` 做什么 | **新建**一行 | **改写**已有行 |
| 手机号已被占用时 | 409 `IDENTIFIER_TAKEN`，一个字段都不写 | 会变成「接管这个账号」 |
| 邀请码能证明什么 | 「有人邀请你进这个 **childId** 的家庭」 | 什么也证明不了（码绑 `childId`，不绑手机号） |
| 最坏情况 | 多一个加入同一家庭的新账号 | 任何知道手机号的人都能登录成号主 |

★ 一句话：**注册是 create，重设是 update**。邀请码能授权前者，不能授权后者。

为什么邀请码不能当重设凭据（具体攻击路径）：

1. 码的行键是 `childId`（`InviteCode.childId`），与手机号、`User` 都没有关系；
2. 码可以被**任何 guardian 生成**、可以 `maxUses > 1`、可以转发；
3. 于是任何一个拿到该孩子有效码的人（新加入的家长 / 从聊天记录里翻到码的人）
   都能构造 `{ inviteCode, phone: "13800138000", newPassword }`，
   把**发码人自己**的账号密码改掉，然后用新密码登录 —— 这正是「账号接管」。
   把 `inviteCode` 去掉只会更糟：连码都不需要了。

> 要真正做「App 内自助重设」，必须先新增一条**绑定账号**的身份通道
> （短信 / 邮件 / 一次性恢复码 / 已登录设备）。其中「注册时发一次性恢复码、
> 重置时校验 `identifier + recoveryCode`」与「用户自己注册、自己保管凭据」
> 的产品直觉最一致，且仍然零短信零邮件；但它需要新列 + 迁移 + 用例，
> 不在本阶段（`45` §6.4 已把「自助找回密码」列为未做）。

### 2.2 目前其实只有**一张**邀请码表

产品语义上确实有两种「邀请」：

| 语义 | 谁在用 | 代码入口 |
|---|---|---|
| **注册邀请**：没有账号的人凭码建号 | 新家长 / 新设备 | `POST /auth/register-invite` |
| **加入邀请**：已有账号的人凭码进入某个孩子 | 另一位家长 / 另一个孩子 | `POST /invites/accept` |

但两者**共用**同一张 `InviteCode`（`childId` + `role` + `maxUses` + `expiresAt`），
即「同一把钥匙，两个门」：一张成员码同时也是一张注册码。

> 如果产品上要把它们拆成互不通用的一对凭据，需要给码加
> `purpose`（`member_join` / `account_register`）并在占位语句里分别校验 ——
> 这是新功能，本阶段没有做。在此之前，不要把「成员码」当成比「注册码」
> 更弱的凭据：它们本来就是同一张。
> ★ 但即便拆开，**两者都不能用来重设密码** —— 原因见 §2.1 的攻击路径。

---

## 3. 发布 1.0.2+3（三处版本号 + 一次上传）

```bash
# 1) 本机构建（版本号已改为 1.0.2+3）
flutter build apk --release \
  --dart-define=KP_API_BASE_URL=https://hub.littlewish.top:8443/kids

# 2) 上传（稳定地址 kids-points-app.apk + 版本化文件）
scp build/app/outputs/flutter-apk/app-release.apk \
  ubuntu@82.157.153.22:/tmp/kids-points-1.0.2.apk
ssh ubuntu@82.157.153.22 \
  'sudo install -o caddy -g caddy -m 644 /tmp/kids-points-1.0.2.apk /var/www/cline-hub/app/ && \
   sudo cp /var/www/cline-hub/app/kids-points-1.0.2.apk /var/www/cline-hub/app/kids-points-app.apk'

# 3) 版本信息（/srv/kids-points/kids.env）改成 1.0.2 / 3，然后
cd /srv/kids-points/deploy && sudo docker compose up -d
```

发布后**旧包**（1.0.1+2）下次启动或回前台就会看到「发现新版本 v1.0.2」，
点「立即更新」用系统浏览器下载新 APK；登录页与「我的」页也各有一个入口。

---

## 4. 证据（2026-11-02 本机）

| 项 | 命令 | 结果 |
|---|---|---|
| Flutter 静态检查 | `flutter analyze` | **No issues found** |
| Flutter 单测 | `flutter test` | **459 条全通过**（新增 3 条：忘记密码对话框 / 预览版本文案 / 登录页新版提示） |
| 后端类型检查 | `npm run typecheck` + `typecheck:tests` | 0 error |
| 后端单测 | `npm test` | **62 个用例文件 / 1130 条全通过**（含 W11-A 新增 11 条） |
| 线上版本端点 | `GET /kids/app/version` | **200**，`latestVersion=1.0.2 / latestBuild=3`，发布说明已更新 |
| 线上注册端点 | `POST /kids/auth/register-invite`（`inviteCode=AA`） | **400 `INVITE_CODE_MALFORMED`**（从 404 → 路由已上线） |
| APK | `aapt dump badging app-release.apk` | `versionCode='3' versionName='1.0.2'`，label「积分小管家」 |
| APK 下载 | `HEAD /app/kids-points-1.0.2.apk` | **200**，`content-length=52545942` |
| 容器 | `docker compose up -d` | `deploy-kids-api-1` 已用新镜像重建，日志「数据库已连接 / 已启动」 |

---

## 5. 诚实边界

- **App 仍然不能自助重设密码**：本轮只把「去哪里重设、怎么重设」讲清楚，没有新增身份通道。
- **升级安装仍用 debug 签名**（`44` §5）：同一台机器构建的包可覆盖安装，正式分发前必须换正式签名。
- **没有真机走查**：入口与文案由 widget 用例钉住，未在真实 Android 设备上点过。
- **强制更新门槛未变**：`APP_MINIMUM_*` 仍是 1.0.0 / 1，1.0.1 用户可以自己选择是否更新。
