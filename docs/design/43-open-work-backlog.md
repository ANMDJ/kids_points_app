# 43 · 未完成事项与续开发清单（快照：2026-11-02；§0 于 2026-11-03 复核）

> 本文是**跨会话的接力棒**：新开会话先读这一份，再按 §7 的「开场提示」启动。
> 它不重复功能设计，只回答三件事：
>
> 1. **现在真有什么** —— §1 是本轮（2026-11-02）**亲手跑出来**的命令与数字，不是抄旧文档；
> 2. **还差什么、为什么算没做完** —— 每条都带 `文件:行` 或「全仓 0 命中」这类可复核证据；
> 3. **下一个人按什么顺序做、做完怎么验收** —— 每条都有勾选式验收判据。
>
> 与既有文档的关系：功能设计仍以 `01`–`42` 为准；`deploy/README.md` §8 是**线上运维视角**的
> 缺口（2026-11-01 体检）。本文把它们合并成一份可执行待办，并补上 W9 之后新出现的问题。
> 三者冲突时：**功能实现**以代码 + `01`–`42` 为准，**线上**以 `deploy/README.md` 为准，
> **优先级**以本文为准（本文日期最新）。

---

## 0. 当前未开发任务（会话收尾必报 · 复核 2026-11-03）

> 本表是**「还没做什么」的唯一口径**，由 [`AGENTS.md`](../../AGENTS.md) §2 要求每次会话结束时汇报。
> 每完成一条：在这里划掉或移到最下面的「已完成」，并写**日期 + 证据**；不要只改代码不改这张表。
>
> 证据列标注 **「本轮复核」**＝2026-11-03 用命令/代码实际查过；标注 **「未复核」**＝沿用
> 2026-11-02 快照（§3–§6），没有重新验证，汇报时必须照实写。
>
> ★ **每条「未做」都要能回答「卡在哪一类」**（2026-11-03 新增）：A 要你的凭据/本机 GUI ·
> B 要产品裁定 · C 我能直接做但没排期 · D 只能真机/真库验收。逐条归属与解锁条件见
> [`50-unfinished-reasons-and-unblock.md`](./50-unfinished-reasons-and-unblock.md)。
> 只写「未做」不写卡点 = 下次会话仍然不知道能不能推进。

| 编号 | 任务 | 现状 | 证据 |
|---|---|---|---|
| **P0-2** | App「登录账号」面板 ＋「我的 → 退出登录」 | ✅ **已完成（2026-11-03）**（拆成 P0-2a / P0-2b 两条落地） | 本轮复核：「退出登录」= `lib/screens/session_actions.dart`（`signedIn` 分支注入）＋ `account_gate.dart` 的 `_signOut()`（清 childId + `onIdentityChanged`）＋ `profile_screen.dart` 的二次确认；「登录账号」= 下面的 P0-2b；证据 = `test/session_actions_test.dart` **2 条** ＋ `test/account_sheet_test.dart` **6 条**，`flutter test` **492 全通过**、`flutter analyze` 0 issue |
| **P0-2b** | App 内「登录账号」面板：绑定/换绑手机号邮箱、设置/修改密码（`PUT /auth/account`） | ✅ **已完成（2026-11-03）** | 本轮复核：`lib/data/auth_api.dart` 新增 `fetchAccount()`（`GET /auth/account`）；`lib/screens/sheets/account_sheet.dart`（先读再画、只提交改动过的字段、`403 CURRENT_PASSWORD_INVALID` 留在本页）；入口 = 「我的」页「登录账号」（`profile_screen.dart`），`SessionActions` 带上同一份 `AuthApi`（同一 holder，401 才会真的清 token）；证据 = `test/account_sheet_test.dart` **6 条** |
| **P0-3** | 「已有账号 → 输入邀请码加入家庭」（`POST /invites/accept`）双端入口 | ✅ **已完成（2026-11-03，双端）** | 本轮复核：**App** —— `lib/data/identity_api.dart` 新增 `acceptInvite()`（`POST /invites/accept`，回包复用 `ChildSessionResult`）；新增 `lib/screens/family_join_actions.dart`（动作只有一份），`account_gate.dart` 的 `_joinFamily` 走完 accept → `SessionScope.adoptChild` → `onIdentityChanged`；`lib/screens/sheets/join_family_sheet.dart` + 「我的 → 加入家庭」（`profile_screen.dart`）；`write_api_errors.dart` 补 `ALREADY_MEMBER` 取服务端原文。**小程序** —— `kids_points_mp/src/utils/invite_code.ts`、`write_dto.ts` 的 `InviteAcceptDto`、`write_api.ts` 的 `acceptInvite()`（带 `x-kp-child-id`）、`store.ts` 的 `submitAcceptInvite()`（切换 `sharedDeviceContext` + 清上一个家庭缓存 + 拉新首页）、`sheets/JoinFamilySheet.tsx` + 「我的」入口；`write_api_errors.ts` 补 400 `INVITE_CODE_MALFORMED` / 409 `INVITE_CODE_UNAVAILABLE` / `ALREADY_MEMBER`。**守门** —— 新增 `tools/invite-code-check.mjs`（三份逐字比对，篡改副本实测 **exit 1**），已接进 `npm run invite:check` 与 `npm run ci`。**证据**：`flutter test` **492 全通过**（新增 `test/join_family_test.dart` **9 条**）、`flutter analyze` **0 issue**、`kids_points_mp` `tsc --noEmit` **0 error**、`backend npm run typecheck` **0 error**、`node tools/invite-code-check.mjs` **PASS**。**仍未做**：真机 / 真库走一次「A 生成 → B 接受 → B 能读」的端到端验收（本环境无 GUI，见 §9） |
| **签名** | App release 包用的是 **debug 签名** | **未做**（要你决定 keystore 的保管与口令） | 本轮复核：`android/app/build.gradle.kts:34-36` —— `TODO: Add your own signing config` ＋ `signingConfig = signingConfigs.getByName("debug")`。后果：任何人都能用公开的 debug key 给同一包名签「更新」；换正式密钥又必须卸载重装 |
| **注册闭环** | 真机用**网站码**走完一次注册（含用户 2026-11-03 报的那次 400 的真实原因） | **验收未完成** | 本轮复核（2026-11-03 二次发版）：线上 `GET /k/app/version` → **`1.0.4 / build 5`**（`pubspec.yaml` / `lib/app_version.dart` / `kids.env` 三处一致，APK `Content-Length: 52578938`）；线上探针三种拒绝的形状都对 —— 码形状错 `400 INVITE_CODE_MALFORMED`、码不存在 `409 INVITE_CODE_UNAVAILABLE`、弱口令 `400 WEAK_PASSWORD`。**2026-11-03 已做**：① `write_api_errors.dart` 显示服务端原文；② 注册页本地判密码强度（`lib/data/password_rules.dart`）＋ 密码要求**常驻**文案；③ 标识框下明确「网站码只认申请时填的手机号/邮箱」；④ 「我的 → 登录账号」（可在 App 内改密）。**仍缺**：真机用 1.0.4+5 走完一次**成功**注册；用户那次 400 的具体触发条件仍未取得（需其回报界面文案） |
| **注册一致（小程序）** | 小程序注册页补本地密码校验 ＋ 完整要求文案（App 2026-11-03 已做） | ✅ **已完成（2026-11-03）** | 本轮复核：新增 `kids_points_mp/src/utils/password_rules.ts`（服务端规则镜像）；`pages/register/index.tsx` 提交前判强度 + 密码框下**常驻**要求文案；`sheets/AppAccountSheet.tsx` 的「设置/修改密码」同样走它（原来只查长度，`密码最多 64 位。` 与服务端文案本就漂移）；新增守门脚本 `tools/password-rules-check.mjs`（三份逐字比对，篡改副本实测 **exit 1**），已接进 `npm run password:check` 与 `npm run ci` |
| **P0-4** | 数据库备份 ＋ 一次恢复演练 | ✅ **已完成（2026-11-03）** | 本轮复核（真机执行）：`deploy/backup-kids-db.sh` → 装到 `/usr/local/bin/kids-backup.sh`，root crontab `17 3 * * *`（保留 14 天）；实跑 `OK 备份完成 …/kids_points_2026-11-03_1226.sql.gz（10000 字节）`＋`OK 恢复演练：restore_test 恢复出 24 张表，PointRecord=0（与线上一致）`＋临时库已删。**仍未做**：备份离开本机（要 COS 密钥）、失败告警（同 P0-5 外部通道） |
| **P0-5** | 探活 / 告警（`GET /health`、compose `healthcheck`） | 🟡 **代码侧 ＋ 自愈已上线（2026-11-03）**，告警通道仍缺 | 本轮复核（线上实测）：`https://hub.littlewish.top:8443/kids/health` → `200 {"status":"ok",…}`；`/kids/health/ready` → `200 {"checks":{"database":{"status":"up","latencyMs":1}}}`；`/k/health` 同 200（`/k` 段已恢复）；容器 `Up 19 seconds (healthy)`；root crontab 已装 `*/5 * * * * /usr/local/bin/kids-watchdog.sh`。**仍未做**：① 外部告警通道（要 webhook）；② uptime 监控（外部探针，整机挂了 watchdog 也一起挂） |
| **家长模式（引导期 5 分钟窗口）** | 用**网站码**注册并建孩子档案后，家长权限只有 **5 分钟**；到期回落 `child`（不是退出登录） | ✅ **已按 D7 默认建议落地（2026-11-03）** | 本轮复核（行为）：`backend/src/identity/identity.prisma.repository.ts:321-330`（`POST /children` 写 `activeRole='guardian'` ＋ `expiresAt=parentModeUntil`＝5 分钟）；`backend/src/device-session/session.gate.ts:117-131`（`guardian` 且过期 ⇒ **回落 `child`**，不是 401）；`backend/src/auth/parent-mode.policy.ts:27-28`（`PARENT_MODE_TTL_MS=5min`）。**另一条路**：用**家庭邀请码（guardian）**注册 ⇒ `identity/invite-registration.prisma.repository.ts:108-124` 写 30 天家长会话，不受 5 分钟限制。**本轮已做**：① 双端引导第⑥步 PIN 改**必填**（`lib/models/onboarding.dart#validateRequiredParentPin()`、`kids_points_mp/src/pages/onboarding/index.tsx` 的 `step === 5`；按钮固定「完成引导」，留空即本地红字、零请求）；② **存量**「跳过 PIN」的账号在面板里有**可点的出口**（App `parent_mode_sheet.dart` 的「退出登录，用手机号/密码重新登录」，借闸门那一份 `SessionActions.signOut`；小程序文案指向「我的」页那条带二次确认的退出）；③ 服务端 `parentPin` 仍可省略，**只为旧版本装机包**保留（`complete-onboarding.dto.ts` 注释已写清）。证据 = `flutter test` **500 全通过**（新增 3：`test/onboarding_test.dart` 必填判据 2 条 ＋ `test/parent_mode_test.dart` 面板 widget 1 条）、`flutter analyze` **0 issue**、小程序 `tsc` **EXIT=0**、后端 `typecheck` **0 error**；详见 `49-bootstrap-guardian-window-pin.md`。**仍未做**：真机走查（新账号留空必须被拦；存量账号「退出 → 重登 → 设 PIN」全路径）、小程序上传 / 新 APK |
| **P0-4 外发备份 / P0-5 外部告警** | 备份只落在本机；探活没有外部告警 | **未做**（要两样外部凭据） | 本轮复核：`deploy/backup-kids-db.sh` 的备份留在 `/var/backups/kids_points`（同一台机器），失败只写日志；`/kids/health` 只回答 HTTP，进程/整机挂了没有外部通道喊人。**P0-4 要的 “COS 密钥” = 腾讯云对象存储（Tencent Cloud Object Storage）**：把每日 `pg_dump` 的 `.sql.gz` 传到**另一台机器/另一个盘**，避免「服务器磁盘坏 = 家庭账本全丢」。只需要**一个桶的写权限**（子账号 SecretId/SecretKey ＋ 桶名 ＋ 地域），**不是**账号主密钥；**P0-5 只要求一个 webhook URL**（企业微信 / 钉钉 / Telegram 均可）。两项都**不影响 App 现有功能**，只决定「出事能不能恢复 / 出事有没有人知道」 |
| **P0-6** | 法务文本定稿 ＋ 双端协议全文页 | **未做**（等法务，L5） | 用户 2026-11-03 明确：「法律文案这不用你管，到时候我就更新了」⇒ 本项**不由开发侧推进**；双端协议全文页（可点开的页面）仍缺，属工程侧可做部分，未开工（未复核） |
| **P0-7** | pg18 网络附加自愈（`docker network connect` 是运行时状态） | ✅ **已完成（2026-11-03）** | 本轮复核（线上）：`deploy/ensure-kids-pg-network.sh` → `/usr/local/bin/kids-pg-network.sh`，root crontab `*/10 * * * *`；实跑 `run_exit=0`（当前已连接，静默退出）；`docker inspect pg18` 的 Networks 里确有 `deploy_default`。**仍未做**：把 pg18 搬进 compose（要动 hub 编排） |
| **P1-1** | 推送落地（厂商 SDK / 小程序订阅消息） | **未做** | 本轮复核：`requestSubscribeMessage` 全仓只在 `43`/`design/README` 被**讨论**，`kids_points_mp/src/**` 0 命中 |
| **P1-2** | 回收站 90 天到期自动清理 worker | **未做** | 未复核（§4 P1-2） |
| **P1-3** | 审批详情页 ＋ 通知深链 | **未做** | 未复核（§4 P1-3） |
| **P1-4** | 习惯独立 CRUD（`POST/PATCH /habits`） | **未做** | 未复核（§4 P1-4） |
| **P1-5** | 孩子头像（预设 / 上传二选一） | **未做** | 未复核（§4 P1-5） |
| **P1-6** | 加分配额 / 金额阈值限制生效 | **未做** | 本轮复核：`backend/src/permissions/permissions.guard.ts:114` 仍写着「不传 `amount`」，`amount` 在 Guard 里无其他命中 |
| **P1-7** | 忘记家长 PIN 的重置通道 | **未做** —— ★ 自 W14 起从 P1 变成**硬前置**：孩子模式到期后 PIN 是唯一出口，忘记 PIN = 这台设备停在 child 收不回来（缓解：没设 PIN 不许开孩子模式） | 本轮复核：`backend/src/auth/auth.service.ts` 的 `setParentPin` 注释仍写「没有找回通道」；全仓无 reset 端点 |
| **P1-9** | App token 持久化（现在 `Directory.systemTemp`，清缓存即掉登录） | **未做**（有意等 P1-1 一起改） | 未复核（§4 P1-9） |
| **P1-10** | Web 版定位（对外可用 / 仅联调）未写死 | **未做** | 未复核（§4 P1-10） |
| **P2** | CI 平台、requestId/全局异常过滤、登录外限流、单实例假设、迁移随启动、镜像体积、App 分发策略、UI 级 E2E | **未做**（整张表都在） | 未复核（§5 ＋ `deploy/README.md` §8 P2） |
| **W12 边界** | 网站发码 **IP 限流**、额度行清理、手机号/邮箱**不验证**、「重新申请」不吊销旧码 | **未做**（明确取舍） | 未复核（`48` §7） |
| **发布边界** | 小程序 `dist/` 已构建但**未上传** | **未做** | 本轮复核：`kids_points_mp/dist/` 存在但未上传（微信开发者工具需要本机登录，见下「发布权限」）。★ `.env.local` 里的 `/k` 入口**已于 2026-11-03 恢复**：Caddyfile 备份 → 插入 `handle_path /k/*` → `caddy validate` 通过 → `reload`；实测 `/k/health` 200、`/k/app/version` 200、`/k/invite` 200 |
| **网站入口** | `https://www.littlewish.top:8443/invite` 连不上（`curl` 超时 000）；`ip:80/k/invite` 与 `hub…:8443/kids/invite` 均 **200** | **文档已修 ＋ `/k` 已恢复**（2026-11-03）；`www:8443` 仍不通（要不要恢复它需运维裁定） | 本轮复核：`/k/invite` → 200（Caddy 恢复 `handle_path /k/*` 后）；`hub…:8443/kids/invite` → 200；`www:8443` 未重测（**未复核**） |
| **测试边界** | `test-db/` 常驻套件补「网站发码并发」用例（目前只有手工探针 `npm run probe:invite-quota`） | **未做** | 未复核（`48` §7） |
| **验收边界** | 真机走查 / 浏览器 E2E（**从未做过**） | **未做** | 未复核（§9） |

**已完成（不再列入汇报，详见对应交接单）**：P0-1 运行期身份闭环（W10-B，`44`）·
P1-8 邀请制注册（W11-A，`45`）· 网站发码 ＋ `/invite` 页面（W12，`48`，2026-11-03 已上线）·
**P0-2a App「我的 → 退出登录」**（2026-11-03）· **P0-2b App「我的 → 登录账号」**
（2026-11-03：`GET/PUT /auth/account` 都有了调用方；证据 = `test/account_sheet_test.dart` **6 条**）·
**P0-3 双端「加入家庭」**（2026-11-03：`POST /invites/accept` 在 `lib/**` 与
`kids_points_mp/src/**` 都有调用方；App `join_family_sheet.dart` / 小程序 `JoinFamilySheet.tsx`；
证据 = `test/join_family_test.dart` **9 条** ＋ `tools/invite-code-check.mjs` 三份形状守门）·
**小程序密码规则与 App / 服务端三份一致**（2026-11-03：`kids_points_mp/src/utils/password_rules.ts`
＋ 守门脚本 `tools/password-rules-check.mjs`，`npm run password:check`）· **注册/登录失败原因透传**
（2026-11-03：`lib/data/write_api_errors.dart` 对 `WEAK_PASSWORD` / `INVITE_CODE_MALFORMED` /
`INVALID_IDENTIFIER` / `DEVICE_ID_REQUIRED` / `INVITE_CODE_UNAVAILABLE` / `IDENTIFIER_TAKEN` /
`ACCOUNT_INVALID_CREDENTIALS` / `USER_NOT_ACTIVE` / `LOGIN_RATE_LIMITED` 一律显示服务端原文，
不再只说「HTTP 400」；证据 = `test/write_api_test.dart` 新增 6 条用例）·
**注册页本地密码校验 ＋ 要求文案**（2026-11-03：`lib/data/password_rules.dart` 镜像
`validatePasswordStrength()`，`auth_api.dart` 的注册 / 改密也走同一份；注册页密码框下常驻
「8–64 位、至少含一个字母…」；证据 = `test/password_rules_test.dart` **9 条**（含读后端 TS 的
同源钉住）＋ `test/invite_register_test.dart` 新增「弱密码 ⇒ 本地提示、零请求」）·
**「我的 → 立即锁定入口」已按用户要求移除**（2026-11-03：`lib/screens/profile_screen.dart` 不再渲染该行；
`AppStore.lockDateCodeGate()` 仅留给诊断/用例，生产 0 调用方；重开 App 仍会重新上锁）·
**「记一笔」不再被全局只读误拦**（2026-11-03：首页判据由 `store.isReadOnly`（`live ⇒ true`）改为
`store.isAdjustReadOnly`（仅 live 且无写客户端）；证据 = `test/read_api_test.dart` 更新 +
`test/write_api_test.dart` 新增「live 首页点记一笔打开弹层」）·
**孩子新增心愿会真的落审批单**（2026-11-03：`submitAddWish` 收到 403 `APPROVAL_REQUIRED` 后调用
`POST /approvals`（action=`add_wish`），返回 `pendingApproval` 而不是只说「需要家长确认」；
App `lib/data/write_api.dart` ＋ 小程序 `src/data/write_api.ts` 双端同构；证据 =
`test/write_api_test.dart` 新增 4 条（含「成员级 DENY 不得改走审批」）＋
`kids_points_mp/.tmp_test/run-w5c.mjs` 同步改 3 条）·
**W14 孩子模式限时窗口**（2026-11-03：`DeviceSession.kidModeUntil` ＋ `POST/DELETE /auth/kid-mode`；
到期**不**自动回家长模式（A 方案），收回要家长 PIN；双端面板 ＋ App 首页状态条；
证据 = 后端 `npm test` **1195 全通过**、`test-db/kid-mode-db.dbtest.ts`、`flutter test`（见 `51` §7）、
小程序 `npm test`、`tools/kid-mode-check.mjs`；详见 [`51`](./51-kid-mode-window.md)）·
**小程序 `npm test` 终于存在**（2026-11-03：`kids_points_mp/package.json` 新增 `typecheck` / `test` /
`test:kid-mode`，`test` = `tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-all.mjs`，
把 20 个 `run-*.mjs` 全部串起来；W10 之后的行为测试不再"写了没人跑"）。

### 0.1 「发布」到底卡在哪（2026-11-03 实测，别再靠印象）

> 起因：用户问「昨天你还发布版本，今天怎么说没有权限了」。查后的答案是：
> **发布权限一直都有，昨天那条路今天照样能走**；卡住的是另外两件事。

| 能做什么 | 现状 | 证据（2026-11-03 实跑） |
|---|---|---|
| 连服务器 / 看容器 | ✅ 可以 | `ssh -i ~/.ssh/kids.pem ubuntu@82.157.153.22` → `SSH_OK`；
ubuntu 在 `sudo` 组，`docker` 需要 `sudo`（**这就是「permission denied」的真正来源**：`/var/run/docker.sock` 不是 docker 组可写，不是账号被降权） |
| 重建后端镜像 + 重启 | ✅ 已做 | `sudo docker compose build` → `Image kids-api:0.1.0 Built`；`up -d` → `Up 19 seconds (healthy)` |
| 上传 APK / 改版本端点 | ✅ 可以（昨天就是这么发的） | `/app/kids-points-1.0.3.apk` 在服；`GET /k/app/version` → `1.0.3 / build 4` |
| 改 Caddy（公网入口） | ✅ 已做 | 备份 → `caddy validate` → `systemctl reload caddy`；`/k/*` 恢复为 200 |
| 数据库备份 / 恢复演练 | ✅ 已做 | 见 §0 P0-4 |
| **上传微信小程序** | ❌ **只能在你的机器上点** | 需要「微信开发者工具」本机登录（扫码）+ 小程序 AppID 后台；本环境没有 GUI/扫码，也没有开发者工具的 CLI 登录态 |
| **应用商店上架（Google Play / App Store）** | ❌ 需要开发者账号 + 你自己的签名密钥 | `android/app/build.gradle.kts:34-36` 现在写的是 `TODO: Add your own signing config` / `signingConfig = signingConfigs.getByName("debug")` —— **release 包用的是 debug 签名**。这把钥匙全世界的 Android SDK 里都有一份，任何人可以给同一个包名签一个"更新"；换正式密钥又必须卸载重装 |

**结论**：说「没有权限」是不准确的 —— 那是「需要一个只有你能提供的凭据/登录」。
凡是不需要扫码、不需要商店账号的发布动作（后端镜像、APK 上传、Caddy、备份），
我都可以直接做完并当场验证。

---

## 1. 本轮实测基线（2026-11-02）

| 项 | 命令 | 结果 |
|---|---|---|
| 仓库状态 | `git status --porcelain` | 干净；HEAD = `2e595b6`（W9-B/C 接入小程序） |
| Flutter 静态检查 | `flutter analyze` | **No issues found**（22.9s） |
| Flutter 单测 | `flutter test` | **424 条全通过**（10s） |
| 后端类型检查 | `npm run typecheck` / `npm run typecheck:tests` | 均 **0 error** |
| 后端单测 | `npm test` | **60 个用例文件 / 1112 条全通过**（59.1s，`fail 0`） |
| 小程序类型检查 | `cd kids_points_mp` → `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **0 error**（无输出即通过） |
| 数据库相关 | `npm run test:db` / `db:verify` | **本轮未跑**（需要活的 PostgreSQL） |
| 小程序构建 | `npm run build:weapp` | **本轮未跑**（只跑了 tsc） |
| Web 端测试 | `flutter test --platform chrome` | **本轮未跑** |
| 真机 / 浏览器 E2E | —— | **从未有过**（见 §9） |

> ★ 本轮**只读 + 跑测试**，没有改任何业务代码。本文所有「没做」的判断都建立在
> 「全仓 grep 0 命中」或「代码里只有接口定义、没有调用方」之上，不靠印象。

---

## 2. 一页结论

**功能已经走到「能演示」，但 App 还没走到「能交给第二个家庭」，线上也还没走到「能放心过夜」。**

| 判断 | 一句话理由 |
|---|---|
| 演示链路是通的 | README 的 `seed:demo` + 三项 `--dart-define` 路径被真机验证过（`README.md`「连线上后端」一节） |
| **但 App 的真实用户链路是断的** | 登录只加了 `Authorization`，身份仍来自**编译期** `KP_DEVICE_ID` / `KP_CHILD_ID`；App **从不调用** `POST /auth/child-session`（§3 P0-1） |
| 邀请码只有「生成」，没有「加入」 | 后端 `POST /invites/accept` 有真库用例，但双端 `acceptInvite` **0 命中**（§3 P0-3） |
| 线上最贵的三件事都没做 | 备份、探活/告警、pg18 网络附加自愈（`deploy/README.md` §8 P0） |
| 合规仍卡在文本 | 法务文本占位、无协议全文页（L5），小程序审核会直接卡住 |
| 触达仍是 0 | 无厂商推送 SDK / 凭据，小程序无 `requestSubscribeMessage`（§4 P1-1） |

**建议的下一步只有一条**：先做 **P0-1**（App 运行期身份闭环）。它不做，后面所有 App 功能都
只能在一台「预置了 demo 会话」的机器上演示，不能算交付。

---

## 3. P0 · 不做就不算「能用」

### P0-1 · App 的身份链路没有闭环（登录成功也可能立刻 401）

> ✅ **已完成（2026-11-02，W10-B）**——见 [`44-w10b-runtime-identity-and-app-update.md`](./44-w10b-runtime-identity-and-app-update.md)。
> 设备 id 改为首启生成并持久化；登录 / 冷启动都会 `POST /auth/child-session`；
> 没有孩子的账号进「先创建一个孩子」引导；换账号先清旧 childId。
> 证据：`flutter test` **452 条**（新增 session / identity / gate 三组）、
> `curl https://hub.littlewish.top:8443/kids/app/version` **200**、
> `flutter build apk --release`（**不带** `KP_DEVICE_ID` / `KP_CHILD_ID`）产物可下载。
> 下面的原始分析保留不改（历史可追溯），其中\"建议实现顺序\"已按 ①–⑤ 落地。

**现象**：账号密码登录成功后，App 仍然用**编译期**的 `KP_DEVICE_ID` / `KP_CHILD_ID` 发请求。
在一个没有预置 `DeviceSession` 行的真机上，第一个 `GET /home` 会返回
`401 SESSION_NOT_FOUND`，报文写着「请先调用 `POST /auth/child-session`」——
而 App 里**没有这个调用**。

**证据**

- `lib/data/read_api.dart:40-43`：三个值全部来自 `String.fromEnvironment(...)`；
  `:67-72`：缺 `deviceId` / `childId` 直接判「未配置」。
- `lib/main.dart:29-30`：`configured` 只看这三项；`:51-69`：所有客户端都用这份编译期配置。
- `lib/data/auth_api.dart:97-100`：登录成功后**只做** `holder.adopt(result.token)`。
- `lib/data/auth_dto.dart:81-83`：`childId` / `role` 解析出来了，但全仓**没有消费方**。
- `backend/src/device-session/device-session.guard.ts:127-140`：即使有 token，
  仍要求 `x-kp-device-id` + `x-kp-child-id`，并**按 `(deviceId, childId)` 查会话行**；
  `:162-180`：还要求会话行 `userId` 与 token 的 `userId` **同源**，否则 401。
- `backend/src/identity/identity.controller.ts:183`：`POST /auth/child-session` 已存在；
  Flutter 侧对 `child-session` 的引用**只有一条注释**（`auth_dto.dart:15`），**0 个调用**。

**为什么必须现在做**

现在能演示，是因为 README 要求先 `npm run seed:demo`（造出 `demo-device-guardian` /
`demo-child` 的会话行），再把这两个值**编进安装包**。这意味着：换一个家庭就要重新打一个包；
公开发布的包只能连到演示家庭。这不是「体验问题」，是**不能交付**。

**建议实现顺序**（按依赖排，不要跳）

1. 把 `ReadApiConfig` 拆成两半：**编译期**只剩 `baseUrl`；**运行期**新增
   `SessionScope { deviceId, childId?, role? }`（可空），放在 `AuthTokenHolder` 旁边，
   与 token 一起持久化（同一目录 / 同一 localStorage，见 `token_store*.dart`）。
2. 首次启动生成设备 id（随机、持久化；可复用 `kids_points_mp/src/data/device_identity.ts` 的口径），
   **不再从 `--dart-define` 读**。
3. 登录成功后：`membership != null` ⇒ `POST /auth/child-session` ⇒ 写入 `SessionScope`；
   `membership == null` ⇒ 进「建孩子 / 请先在小程序建家庭」引导（后端 `POST /children` 已有）。
4. 六个客户端（read / write / onboarding / parent-mode / device-token / date-code）从
   `SessionScope` **动态取值**，不再在构造时快照。
5. `AccountGate` 增加一个中间态：`signedIn 但 scope 未就绪` ⇒ 显示「正在建立本机会话」，
   不要先渲染首页再被 401 打回登录页。

**验收判据**

- [ ] 一个**不带** `KP_DEVICE_ID` / `KP_CHILD_ID` 的 release 包：登录 → 自动建会话 → `GET /home` 200。
- [ ] 杀掉进程重开：仍进首页（设备 id + token 都持久化）；清 token 后回登录页，可重新登录。
- [ ] 同一台设备换另一个账号登录：旧 token 被撤销、新账号重新 `child-session`，**不串数据**。
- [ ] `membership: null` 的账号：看到可执行的建孩子引导，而不是一堆 401。
- [ ] 用例钉住：没有 `childId` 时**不发**业务请求；`child-session` 失败时回到可重试状态。
- [ ] `README.md` 的「三项 `--dart-define`」段落同步改写（这是文档债务，见 §6）。

**估计** 1.5–2.5 人日（客户端重构 + 6 个客户端改造 + 用例）· **依赖** 无（后端已就绪）

---

### P0-2 · App 里没有「登录账号」入口，也没有「退出登录」

**现象**：`AuthApi` 已经有 `updateAccount`（绑定手机号/邮箱/改密）与 `logout`，
但**没有任何界面调用它们**。App 用户无法自己创建登录账号，也无法退出；
而「创建账号」目前只能去小程序 `AppAccountSheet` 做。

**证据**

- `lib/data/auth_api.dart:44-57` 定义、`:103-145` 实现；全仓 `logout(` 只有这两处（**0 个调用方**）。
- `lib/screens/profile_screen.dart:301-360`：菜单里有同意 / 导出 / 删除 / 回收站，**没有账号行**。
- `lib/data/auth_api.dart` 缺 `GET /auth/account` 客户端方法（小程序侧有 `fetchAccount`，
  后端 `identity.controller.ts:142` 也有），所以面板连「当前绑了什么」都读不到。

**验收判据**

- [ ] 「我的」多一行「登录账号」：显示掩码手机号 / 邮箱 / 是否已设密码（`GET /auth/account`）。
- [ ] 设置 / 修改手机号、邮箱、密码；已设密码时必须带 `currentPassword`。
- [ ] 错误文案区分：`409 IDENTIFIER_TAKEN`（被占用）、`400 WEAK_PASSWORD`、
      `403 CURRENT_PASSWORD_INVALID`（**不是** 401，不应跳登录页）。
- [ ] 「退出登录」：调 `POST /auth/logout` → 清 token → 回登录页 → **同时**调
      `PushTokenRuntime.revoke()`（该能力已存在：`lib/data/push_token_runtime.dart:94`，
      目前**无人调用**），避免退出后还能收到上一位用户的通知。
- [ ] 用例：密码不落盘（沿用 `auth_api.dart` 文件头的三条不变量）。

**估计** 1 人日 · **依赖** P0-1（退出后要能重新建立会话）

---

### P0-3 · 邀请码能生成，却没人能用它加入（双端都没有入口）

**现象**：家长生成邀请码发给亲戚，亲戚打开小程序/App **没有地方输入它**。

> 🟡 **部分缓解（2026-11-02，W11-A）**：**还没有账号**的人现在有一条路 ——
> App 登录页「第一次用？用邀请码注册」（`POST /auth/register-invite`，见
> [`45-invite-registration.md`](./45-invite-registration.md)）。
> 它覆盖的是「**新用户**凭码加入一个已有家庭」；**不覆盖**「**已有账号**的人
> 再加入第二个家庭」。那种情况仍然需要 `acceptInvite` 入口，本条的验收判据不变。

**证据**

- 后端端点存在：`backend/src/invites/invites.controller.ts:104`（`POST /invites/accept`），
  并已有真库用例 `backend/test-db/invites-db.dbtest.ts`。
- 客户端 **0 命中**：`acceptInvite` / `invites/accept` 在 `lib/**` 与 `kids_points_mp/src/**`
  都搜不到；`lib/screens/sheets/invite_sheet.dart` 只有列表 / 生成 / 复制 / 吊销。
- `deploy/README.md:478-490` 已把它列为 P1 ⑸，并指出「等登录链路」这个旧阻塞理由**已不成立**。

**验收判据**

- [x] 双端各有入口（2026-11-03 落地：「我的 → 加入家庭」；D3 按默认走**先登录再输码**，
      入口只在 `isAuthenticated` / `FamilyJoinActions != null` 时渲染）。
- [x] 加入成功后客户端**切换**到新家庭：App 走 `SessionScope.adoptChild` +
      `onIdentityChanged`（子树以 childId 为 key，整体重建并重拉 `/home`）；
      小程序走 `sharedDeviceContext.applyChild` + `resetToEmpty()` + `refreshFromServer()`。
      ⚠️ 真机数据验收（B 真看到 A 家的积分）**尚未**跑，见 §9。
- [x] 三类可区分、且失败**不消耗**名额：400 `INVITE_CODE_MALFORMED`（形状）/ 409
      `INVITE_CODE_UNAVAILABLE`（不存在 / 过期 / 用完 / 吊销，**后端故意同形**，
      避免成为「哪些码存在」的探针）/ 409 `ALREADY_MEMBER`。
- [ ] 一条端到端用例：A 生成 → B 接受 → B 能读 → A 能在成员列表看到 B。
      后端真库用例已有（`backend/test-db/invites-db.dbtest.ts`）；客户端本次只覆盖到
      「accept → adoptChild → 清缓存」（`test/join_family_test.dart`），**跨端端到端未跑**
      （需要活 PostgreSQL + 两台设备，见 §9）。

> **已知边界（不是本次遗漏，是后端契约）**：`accept` 挂着 `DeviceSessionGuard`，
> 要求本机已有一条 `(deviceId, childId)` 会话行 —— 因此**零孩子的账号**走不了这条路
> （它要么先 `POST /children` 建一个孩子，要么用网站码重新注册）。
> D3 的默认（先登录再输码）与这个约束一致：入口只画在有会话的「我的」页。
>
> **另一个已知体验点**：加入成功后走的是 `AppStore.resetForIdentity()`（与登录 / 换账号
> 同一条），它会把**日期码闸门**一并重置 ⇒ 用户会遇到一次「请再输今天 6 位码」。
> 这是刻意的：同一个 reset 也用于换账号，若在这里保留取巧的"解锁"标记，
> 换账号后下一个人就能绕过闸门。要改成"换孩子不重锁"需要给闸门加一个设备级状态
> 与一条产品裁定，本轮**没有**做。

**估计** 0.5–1 人日（双端）· **依赖** P0-1（App 侧需要真实会话）

---

### P0-4 · 数据库没有任何备份（最贵的一条）

**证据**：`deploy/README.md:391-423`（P0 ①）—— 线上只有一个 `pg18` 容器，没有备份任务、
没有恢复演练；一次误删 / 磁盘故障就回到零。

**验收判据**

- [ ] 每日 `pg_dump`（或 WAL 归档）落到**另一块盘 / 对象存储**，保留 ≥ 7 天。
- [ ] 至少做过一次**恢复演练**：把备份恢复到一个临时库，`npm run db:verify` 全 PASS。
- [ ] 备份失败会告警（与 P0-5 共用通道）。

**估计** 0.5 人日 + 一次演练 · **依赖** 无（可与 P0-1 并行）

---

### P0-5 · 没有探活 / 告警，容器假死不会自愈

**证据**：`deploy/README.md:424-446`（P0 ②）；后端**没有** `GET /health`（本轮 grep
`health` 只在注释里命中一次），compose 也没有 `healthcheck`。

**验收判据**

- [ ] `GET /health`：不查库的存活探针 + 查库的就绪探针（两者分开，别让库慢把进程判死）。
- [ ] compose `healthcheck` + 重启策略；5 个 worker 卡死能被发现。
- [ ] 外部告警（哪怕是最简的定时 curl + 邮件/IM）覆盖：进程 down、连续 5xx、备份失败。

**估计** 0.5 人日 · **依赖** 无

---

### P0-6 · 法务文本仍是占位版本，且没有协议全文页

**证据**：`deploy/README.md:458-475`（P0 ④）；`kids_points_mp/src` 里 `隐私政策` **0 命中**，
协议只在两处作为**不可点击的纯文本**出现；版本号仍是 `2026-10-draft`（`PRD.md:788`）。

**验收判据**

- [ ] 《用户协议》《儿童个人信息保护规则》定稿，版本号替换 `CONSENT_TEXT_VERSION`。
- [ ] 双端都有**可打开的全文页**，并与 `POST /consent` 展示的版本一致。
- [ ] 引导第①步的勾选文案与全文页逐条对齐（审核会对照）。

**估计** 0.5 人日工程 + **法务等待**（日历门）· **依赖** L5

---

### P0-7 · pg18 的网络附加是手工的，重启即失效

**证据**：`deploy/README.md:447-457`（P0 ③）—— `docker network connect deploy_default pg18`
是运行时状态；`compose down` 或容器重建后丢失，表现为「容器 Up、日志刷 P1001」。

**验收判据**

- [ ] 把 pg18 的网络定义纳入编排（首选），或提供**开机自愈**（systemd oneshot / compose hook）。
- [ ] 一条自检命令能区分「库没起」与「网络没接」。
- [ ] `deploy/README.md` §0 的警告随之改写（别留一条「记得手工跑」的运维知识）。

**估计** 0.5 人日 · **依赖** 无

---

## 4. P1 · 功能闭环与留存（用户会发现，但不会报错）

### P1-1 · 推送一条都发不出去（真机 0 次）

**证据**

- 服务端链路已建（W5-K～W6-G），但 `PUSH_WEBHOOK_URL` 为空 ⇒ `NoopPushAdapter`
  （`backend/.env.example:90`），`deploy/README.md:492-498`（P1 ⑥）。
- 客户端 token 来源仍是调试配置：发布构建**明确拒绝** `KP_PUSH_TOKEN`
  （`lib/data/push_token_registration.dart:149`），真 token 必须由厂商 SDK 提供 —— **没有接**。
- 小程序**没有** `requestSubscribeMessage`（全仓 0 命中），订阅消息模板 ID 也未申请（L3）。

**验收判据**

- [ ] 选定通道（见 §8 决策 2）并接一个真实 SDK：Flutter（APNs/FCM 或国内厂商）/ 小程序订阅消息。
- [ ] 一台真机收到「孩子提交兑换」的通知，点开能到审批页。
- [ ] token 轮换 / 退出登录 / 410 下线三条路径各有一条真机或真库证据。

**估计** 2–4 人日 + 凭据等待 · **依赖** L3

---

### P1-2 · 回收站 90 天到期不自动清理

**证据**：`deploy/README.md:499-505`（P1 ⑦）；现有 retention worker 只管
`PushRetryJob` / `Notification`，软删行与 append-only 流水**只增不减**。

**验收判据**

- [ ] 一个 retention worker（与现有 5 个同风格）：到期软删行**分批**物理删除 / 归档。
- [ ] 巡检口径：能查出「超过阈值仍未被清理」的行数；失败只告警，不阻塞业务。
- [ ] 用例：边界（90 天整）、批量上限、与「彻底删除」入口不打架。

**估计** 1 人日 · **依赖** 无

---

### P1-3 · 审批只有列表，没有详情；通知也没有深链

**证据**：双端 UI 里 `详情` **0 命中**；`NotificationsSheet` 只做列表与「去审批」。
`12-w3c-handoff.md` §9 也把「详情」留在边界外。

**验收判据**

- [ ] 审批详情：申请内容 / 金额 / 规则快照 / 申请人 / 时间 / 幂等键结果 / 审计行。
- [ ] 从通知点进来能定位到**这一条**（而不是只切 tab）。
- [ ] 孩子侧「我的申请」同样能看详情与撤回结果。

**估计** 1–1.5 人日（双端）· **依赖** 无

---

### P1-4 · 习惯没有独立 CRUD（只能「按规则加习惯」）

**证据**：后端只有 `POST /records/check-in`、`POST /records/:id/reverse`
（`backend/src/habits/habits.controller.ts:60,97`）与 `DELETE /habits/:id`
（`habits.lifecycle.controller.ts:50`）；建习惯只能 `POST /point-rules/:id/habits`。
⇒ 不能建「不挂规则的日常」、不能改名、不能排序。

**验收判据**

- [ ] `POST /habits` / `PATCH /habits/:id`（标题、图标、排序、是否扣分）＋ 矩阵动作与迁移。
- [ ] 双端入口；改名不改变历史流水的快照（I3）。
- [ ] 用例：跨孩子 404、软删后不可改、排序稳定。

**估计** 1.5 人日 · **依赖** 需要先定「习惯与规则的关系」（§8 决策 6）

---

### P1-5 · 孩子没有头像（只有 emoji）

**证据**：`avatar` 在 `lib/` 与 `kids_points_mp/src` 里只出现在注释中；`profile_screen.dart:73-75`
固定画 `🧒`。

**验收判据**

- [ ] 至少支持「从相册选 / 预设头像」二选一；图片上传要有大小与类型限制。
- [ ] 与 `GET /home` 的档案字段同源；换设备后仍能看到。
- [ ] 不做图片上传也要有**预设头像**可选（避免为了一个头像引入对象存储）。

**估计** 0.5–1.5 人日（取决于是否做上传）· **依赖** §8 决策 6（是否做上传）

---

### P1-6 · 加分配额与「金额阈值」限制没有生效

**证据**

- `backend/src/permissions/permissions.guard.ts:115`：**不传 `amount`** ⇒
  `requireApprovalForBonusOver` 在 HTTP 路径上**不生效**，并有专门用例钉着这个事实。
- `12-w3c-handoff.md:213-218`：每天 3 条 / 同因去重属 dispatcher，**尚未实现**。

**验收判据**

- [ ] dispatcher 拿到金额后把 `amount` 传进 `tightenVerdict`，并补「超过阈值 ⇒ 403 APPROVAL_REQUIRED」
      与「未超过 ⇒ 放行」两条对照用例。
- [ ] 每日加分条数 / 同因去重有明确口径（拒绝还是转审批），并有真库用例。
- [ ] 现有那条「此刻判不动」的用例**改写成新行为**（别直接删）。

**估计** 1 人日 · **依赖** 需要产品确认限制口径

---

### P1-7 · 忘记家长 PIN 没有重置通道

**证据**：`PRD.md:772`（W8-C 行）明确写「故意留白」；任何无凭据重置都会让 PIN 变成装饰品。

**验收判据**

- [ ] 走「监护人身份再验证」（账号密码 / 小程序已登录会话）后重置，并写审计。
- [ ] 重置后旧 PIN 立即失效、失败计数清零。
- [ ] 不引入「客服口头重置」这类无法审计的路径。

**估计** 0.5–1 人日 · **依赖** 身份再验证口径

---

### P1-8 · 开放注册（前置：邀请码加入）

> 🟢 **已按「只做邀请制」收口（2026-11-02，W11-A）**：`POST /auth/register-invite`
> 已落地，见 [`45-invite-registration.md`](./45-invite-registration.md)。
> ★ **无邀请码仍然不能注册** —— 本条原本要的「开放注册」按 `42` §5.1 **仍然不做**；
> 留在清单里是为了区分两件事：**邀请制注册 ≠ 开放注册**。

**证据**：`42-account-login-design.md` §9 第 1 条 —— 不做开放注册的理由是
「手机号打错一位就静默生成看不到孩子的新账号」，前置是邀请码并入家庭。

**验收判据**

- [x] 注册后必须能通过邀请码加入一个已有家庭（W11-A：一个事务同时写成员位，不存在「空账号」）。
- [x] 注册与登录同样限流（共用 `LoginRateLimiter`）；失败文案不泄露「这个号是否已注册」
      （凭邀请码即可注册，故不构成「按手机号探测」的接口；已注册回 409 `IDENTIFIER_TAKEN`）。
- [x] **无邀请码不能注册**（`INVITE_CODE_UNAVAILABLE` / `INVITE_CODE_MALFORMED`）。

**估计** 1 人日 · **依赖** P0-3

---

### P1-9 · App token 存在临时目录（清缓存即掉登录）

**证据**：`42-account-login-design.md` §7.2.1 —— `FileTokenStore` 写 `Directory.systemTemp`，
理由是 README 把「零第三方依赖」写成硬约束。

**取舍**：这不是 bug。若要改，只需换 `TokenStore` 一个实现
（`lib/data/token_store*.dart`），上层一行不用改；代价是引入 `shared_preferences` /
`flutter_secure_storage`，破坏离线 `pub get`。

**建议**：等 P1-1 接厂商推送 SDK 时**一起**决定 —— 反正那时已经不可能保持零依赖。

---

### P1-10 · Web 版只有「预览/联调」定位，发布链路未定

**证据**：`README.md:190-191` —— 不做推送（`PushTokenConfig` 拒绝 `web`）、无离线缓存；
`flutter build web` 未进 CI / 部署脚本。

**验收判据**

- [ ] 明确 Web 是「内部联调」还是「对外可用」；对外则要补：静态资源缓存策略、
      `localStorage` token 的 XSS 说明、CORS 生产白名单。
- [ ] 若是内部联调：在 README 与部署文档里写死「不对外」，避免被当成产品入口。

---

## 5. P2 · 工程面（不咬人，但会让下次事故变慢）

来源：`deploy/README.md:513-524`（P2 表）+ 本轮复核。

| 项 | 现状证据 | 建议 |
|---|---|---|
| **没有 CI 平台** | 全仓无 `.github/workflows`；`docs/design/README.md:284` 仍写「仍待你定 CI 平台」 | 先定平台（GitHub Actions / 自建 runner），把 `npm run ci`（**16 步**）与 Flutter / 小程序两条流水线接进去 |
| **无 requestId / 无全局异常过滤器** | `@Catch(` / `useGlobalFilters` 全仓 0 命中 | 加 `APP_FILTER` + 请求 id，日志至少 JSON 化；线上 500 才能对上用户截图 |
| **除登录外没有限流** | 只有 `login-rate-limiter.ts`；Caddy 标准版没有 `rate_limit`（要插件重编译） | 写端点已有业务规则兜底；若要平台级限流，先在应用层做（按 IP + 路由） |
| **单实例假设** | 5 个 worker 直接 `setInterval`（`main.ts`），无分布式锁；限流是进程内存 | 加 DB advisory lock 或单实例部署写死；否则第二台机器会重复执行审批扫描 |
| **迁移不随启动执行** | compose `CMD` 只有 `node dist/main.js` | entrypoint 先 `prisma migrate deploy`（幂等）+ `set -e` + 告警；别让它静默进重启循环 |
| **镜像 912MB** | `deploy/README.md` §1 | 不急；`devDependencies` 是 seed/verify 需要，**别随手 `--omit=dev`** |
| **App 分发完全空白** | 无签名 / 打包 / 渠道 / 版本号策略；`android/`、`ios/` 无 release 配置 | 与 P0-1 一起做：一个「能装到别人手机上」的包，是验收 P0-1 的前提 |
| **没有 UI 级 E2E** | 双端证据都是「编译 + 单测 + 假传输层」 | 至少一条真机走查脚本（登录 → 引导 → 打卡 → 审批） |

---

## 6. 文档同步债务（**本轮只记录，未改历史交接单**）

历史交接单是**当时**的事实，不该批量改写；但下面这些**结论性陈述**已经会让新人读错，应尽快修：

| 位置 | 现在写的 | 实际 | 建议改法 |
|---|---|---|---|
| `docs/PRD.md:759` | `flutter test` **296/296** | 本轮 **424** 条 | 改成「见 `design/43` §1 最新基线」，别在 PRD 里维护会漂的数字 |
| `docs/PRD.md:787` | 首启引导「**双端 UI 仍未开发**」 | W8-B 已落地（`39-w8b-handoff.md`） | 改为 ✅ 并指向 `39` |
| `docs/PRD.md:788` | 同意链路「**前端未接**」 | W7-B 已落地双端面板 | 改为 ✅ 并指向对应交接单 |
| `docs/PRD.md:794-810` | §15.3「下一步（W4）」 | 已过 W5–W9 十几个阶段 | 整段替换为「见 `design/43-open-work-backlog.md`」 |
| `docs/design/40-login-and-session-design.md:3` | 「设计稿 · **一行代码都没写**」 | W9-A/B/D 已落地 | 在文件头加一行「已由 W9 系列落地，见 `42`」，正文保留作设计史 |
| `docs/design/README.md:1597` | `npm run ci` **15 步** | `package.json` 实际 **16 步**（含 `onboarding:check`） | 改成 16，并加一句「步数会漂，以 `package.json` 为准」 |
| `docs/design/README.md:49`（`40` 行状态） | 🟡「后端已实现 / 未做 Flutter」 | Flutter 登录链路已落地（`42`） | 状态列改为与 `42` 一致 |
| `README.md:88-91` | 「三项 `--dart-define` 缺一即预览模式」 | **仍然成立**，但 P0-1 会把它改掉 | P0-1 完成时同步改写，不要留旧说明 |

> 规矩：**每完成一条待办，只改与它直接相关的那一段**；不要为了「看起来整齐」重写历史交接单。
> 历史文档的价值在于「当时确实这么想、这么验」，改掉就失去了可追溯性。

---

## 7. 推荐推进顺序与「新会话开场提示」

### 7.1 三个迭代

| 迭代 | 目标 | 包含 | 出口判据 |
|---|---|---|---|
| **A（1–2 天）** | App 能交给第二个家庭 | P0-1 → P0-2 → P0-3（至少小程序侧）→ 真机走查 | 全新手机、全新账号：登录 → 建会话 → 打卡 → 家长审批，全程不碰 `--dart-define` |
| **B（1–2 天）** | 线上能过夜 | P0-4 → P0-5 → P0-7 → P0-6（等法务） | 备份能恢复、探活会告警、重启后自动连库 |
| **C（按需）** | 留住人 | P1-1 → P1-3 → P1-2 → P1-4/5 → P2 | 真机收到推送、审批能看详情、回收站不涨破盘 |

### 7.2 新会话开场提示（可直接复制）

```text
接手 kids_points_app。先读 docs/design/43-open-work-backlog.md（本轮快照与待办），
再读 docs/design/01 overview / 02 rbac / 42 account-login，以及 deploy/README.md §8。

本轮只做 P0-1：App 运行期身份闭环（deviceId 运行期生成 + 登录后 POST /auth/child-session
+ childId 不再来自 --dart-define）。验收判据见 43 §3 P0-1。

要求：
1) 先跑基线：flutter analyze / flutter test / backend npm run typecheck + npm test；
2) 不许假绿：新用例必须能在改坏实现时变红（至少手动证伪一次）；
3) 不改历史交接单；完成后只更新 43 的对应条目与索引状态；
4) 提交信息按 docs/design/README.md「Git 记录规范」。
```

### 7.3 必读文件（按顺序）

1. `docs/design/43-open-work-backlog.md`（本文）
2. `docs/design/01-overview.md`（架构 / 事务边界 / 信任边界）
3. `docs/design/02-rbac-and-approval.md`（权限矩阵 / 三道屏障 / 审批状态机）
4. `docs/design/40-login-and-session-design.md`（身份语义与取舍，注意状态行已过时）
5. `docs/design/42-account-login-design.md`（App 登录的契约与硬取舍）
6. `deploy/README.md` §0–§9（线上拓扑、迁移五步链、已知坑、缺口体检）

---

## 8. 需要产品/运维裁定的 7 件事（**不裁定就别开工**）

| 编号 | 问题 | 为什么必须先定 | 默认建议 |
|---|---|---|---|
| D1 | App 首版是否支持**多个孩子** | 决定 P0-1 是做「直接进」还是「先选孩子」 | 首版只支持 1 个；多孩子返回明确文案，别静默取第一个 |
| D2 | 推送通道选哪个 | 决定 P1-1 的全部工作量与凭据等待 | 小程序走订阅消息；App 国内 Android 需厂商通道，iOS 走 APNs —— 先选**一个**平台打通 |
| D3 | 未登录能否输入邀请码 | 决定 P0-3 的入口位置与后端是否需要「登录后认领」 | 先登录再输入（`accept` 已要求身份；少一条临时凭据链路） |
| D4 | 回收站到期是「自动彻底删除」还是「只标记」 | 决定 P1-2 的数据风险 | 先归档到 `deletedAt` 90 天后**软删转硬删**，但保留审计摘要；不要无声抹掉 |
| D5 | 是否坚持「零第三方依赖」 | 决定 P1-9（token 持久化）与 P1-1（推送 SDK）能不能做 | 推送必须破例；token 持久化跟着一起换，别分两次 |
| D6 | 习惯能否独立于规则存在；头像是否做上传 | 决定 P1-4 与 P1-5 的接口形状与迁移 | 习惯允许独立（`Habit` 已是独立表）；头像先做预设、不做上传 |
| D7 | 引导期的「5 分钟家长窗口」：跳过 PIN 的账号要不要一条自助补设通道 | 决定引导第⑥步是否改成**必填**，以及面板文案能不能执行。旧客户端跳过 PIN ⇒ 5 分钟后既进不了家长模式，也无法补设（旧文案「请先用家长账号进入一次家长模式」不可执行） | ✅ **2026-11-03 已按默认方案落地**（见 `49`）：引导第⑥步双端 PIN **必填**；存量无 PIN 账号在面板给「退出登录 → 用手机号/密码重新登录」；权限矩阵不动 |

---

## 9. 诚实边界（本轮**没有**验证的事）

- **没有跑真库**：`npm run test:db` / `db:verify` / `ci:db` 全部未跑（需要活 PostgreSQL）。
  本文关于迁移、I5、worker 的判断来自代码与历史交接单，不是本轮实测。
- **没有跑小程序构建**：只跑了 `tsc --noEmit`；`taro build --type weapp` 与
  `.tmp_test/run*.mjs` 未跑。
- **没有跑 Web 测试**：`flutter test --platform chrome` 未跑。
- **没有任何真机 / 浏览器 E2E**：P0-1 的「401 SESSION_NOT_FOUND」是根据
  `device-session.guard.ts` 的判定路径**推出来**的，没有在真机上复现过。
  动手前建议先花 10 分钟实测确认（这也是一条验收证据）。
- **`deploy/README.md` §8 的线上体检是 2026-11-01 的**：本文引用它时未逐条复核服务器现状，
  只复核了代码侧能复核的部分（如无 `/health`、无 CI 平台）。

---

## 10. 复现命令（本轮实际用过）

```powershell
# 仓库状态
git status --porcelain
git --no-pager log -3 --pretty=format:'%h %ad %s' --date=iso

# Flutter
flutter analyze
flutter test

# 后端（无库）
cd backend
npm run typecheck
npm run typecheck:tests
npm test                      # 60 文件 / 1112 条

# 小程序（只做类型检查）
cd ..\kids_points_mp
.\node_modules\.bin\tsc --noEmit -p tsconfig.json

# 证据检索（本文用过的几条）
cd ..
Get-ChildItem lib,kids_points_mp\src -Recurse -Include *.dart,*.ts,*.tsx |
  Select-String -Pattern 'acceptInvite|invites/accept'
Get-ChildItem lib -Recurse -Include *.dart |
  Select-String -Pattern 'child-session|logout\('
Select-String -Path backend\src\permissions\permissions.guard.ts -Pattern 'amount'
```

> 需要活库时：`npm run test:db`（真库套件）、`npm run db:verify`（I5 十二项判据）、
> `npm run ci:db`（两者 + 反向对照）。跑之前先按 `deploy/README.md` §2 把迁移链走完。

