# AGENTS.md —— 给 AI 协作者的项目约束

> 只写「不写就一定会反复犯」的硬约束。产品/设计事实见 [`docs/design/`](./docs/design/README.md)，
> 需求口径见 [`docs/PRD.md`](./docs/PRD.md)。本文件由 Cline 作为工作区规则自动加载。

## 1. 搜索纪律：编译产物不是证据

**禁止把构建产物当搜索目标。** 具体路径（全部已在 `.gitignore` 里）：

| 类别 | 路径 |
|---|---|
| Flutter / Dart | `build/`、`.dart_tool/`、`.widget_preview/`、`*.iml` |
| 后端 | `backend/dist/`、`backend/.tmp_test_build/`、`backend/node_modules/` |
| 小程序 / H5 | `kids_points_mp/dist/`、`kids_points_mp/node_modules/`、`.tmp_test/dist/`、`.tmp_test/chrome-profile/` |
| 原生 | `ios/Pods/`、`ios/Flutter/ephemeral/`、`ios/Flutter/Generated.xcconfig`、`ios/Flutter/flutter_export_environment.sh`、`android/.gradle/` |
| 日志 | `*.log`（仓库根还堆着几十个 `.tmp_*.log` 探针日志） |

判断依据（不是偏好，是可验证的事实）：

- **它们不入库**。`git ls-files build .dart_tool` → **0 行**；`git check-ignore -v` 对
  `.dart_tool`、`build`、`backend/dist`、`.widget_preview`、`node_modules` 全部命中各自
  `.gitignore`。提交里没有的东西，本来就不该成为排查证据。
- **代价实测**（2026-11-02，cline-core 4.1.26）：内置 `search_codebase` 报
  `Searched 1519 files`，而提交口径只有 **793** 个文件 —— 差额 726 个几乎全是生成物；
  同一查询 `flutter_build|package_config` 的 17 条命中 **100%** 落在
  `.widget_preview/.dart_tool/**` 与 `ios/Flutter/ephemeral/**`，对定位 bug 零贡献。
- **它挡不住**：`search_codebase` 没有路径过滤参数，其内置黑名单
  `node_modules / vendor / .git / dist / build / .next / coverage / __pycache__ / .venv / venv /
  .cache / .turbo / .output / out / target / bin / obj` 里**没有** `.dart_tool`、
  `.widget_preview`、`ios/Flutter/ephemeral`；`.ignore` / `.gitignore` 对它无效
  （详见 `.ignore` 文件头的实测附注）。

### 怎么做

1. **仓库级检索用命令，不用工具**：
   `node tools/search-tracked.mjs '<正则>'`（文件集 = `git ls-files --cached --others --exclude-standard`，
   即「未来 commit 可能包含的全部文件」；另有产物硬黑名单兜底与 `--self-test` 自检）。
   支持 `--case-sensitive / --context N / --max N / --files-only`。
2. **用 `search_codebase` 时**：pattern 必须带业务标识（`Idempotency-Key`、`invite`、
   `RelationKind` 之类），**不要**用 `widget`、`build`、`config`、`version` 这种会吸满生成物的词；
   命中里一旦出现上表路径，直接判为噪音，不进结论。
3. **确实要看产物内容**（例如「打出来的包里写的是什么版本号」）：先确定具体文件路径，再用
   `read_files` 读那一个文件；**不做**全仓 pattern 搜索。
4. **查编译类问题的正确顺序**：拿编译器的 `EXIT` 码 + 报错原文 → 读报错点名的源文件 →
   读相关配置（`pubspec.yaml`、`tsconfig`、`nest-cli.json`、`prisma/schema.prisma`）→ 必要时重跑命令。
   产物里永远不会写着「为什么编译不过」。

## 2. 会话收尾：每次都要报「还未开发的任务」

**每次对话结束时（包括只问问题、一行代码都没改的那次），回答的最后必须有一节
「当前还未开发的任务」。** 不是可选项，也不是「这次没改代码就不用报」。

唯一口径（不要每次自己重新发明一份清单）：

1. [`docs/design/43-open-work-backlog.md`](./docs/design/43-open-work-backlog.md) **§0 当前未开发任务快照** —— 主清单；
2. [`deploy/README.md`](./deploy/README.md) §8 —— 线上/运维视角的补充（备份、探活、网络附加…）；
3. 各交接单（`44`–`48` 等）的「未做 / 已知边界」小节 —— 功能细节与取舍。

写法要求：

- 每条形如 `编号 · 一句话 · 证据（文件:行 / 命令 / 文档锚点）`；**已完成的不列**。
- **每条「未做」还必须标卡点类别**（2026-11-03 新增）：`A` 要用户凭据/本机 GUI ·
  `B` 要产品裁定 · `C` 我能直接做但没排期 · `D` 只能真机/真库验收。归属与解锁条件见
  [`docs/design/50-unfinished-reasons-and-unblock.md`](./docs/design/50-unfinished-reasons-and-unblock.md)。
  只写「未做」不写卡点 = 下次会话仍然不知道能不能推进。
- **禁止臆造与夸大**：清单里每条都要能指到代码或文档；本轮**没验证**的条目必须写
  「未复核」，不许把「文档说没做」说成「我刚验证过」。
- **完成一条任务时，同一轮**就在 `43` §0 里划掉（或移到「已完成」行）并写日期 + 证据，
  然后在回复里注明「`43` §0 已更新」。只改代码不改这张表 = 下一次会话会报错清单。
- 清单只报**未开发/未验收**的事实，不加优先级建议以外的扩写；需要产品裁定的，
  指向 `43` §8 的 D1–D6，不要自己替产品拍板。

## 3. 变更记录

| 日期 | 变更 | 起因 |
|---|---|---|
| 2026-11-02 | 新增本节 + `tools/search-tracked.mjs`；`.ignore` 头部的实测附注同步更新 | 检索命中被 `.dart_tool/**`、`.widget_preview/.dart_tool/**`、`ios/Flutter/ephemeral/**` 淹没（1519 vs 793）；`.ignore` 对 `search_codebase` 无效 |
| 2026-11-03 | 新增 §2「会话收尾：每次都要报未开发任务」；`43` 增加 §0 当前快照；`README` 的网站邀请码入口改为实测可用地址 | 用户要求每次对话结束都汇报「当前还未开发的任务」，并要求写进规则 |
| 2026-11-03 | App 补「我的 → 退出登录」（P0-2a）；注册/登录失败改为显示**服务端原文** | 用户报「App 注册报 400，但界面只写 HTTP 400」，无法自查 |
| 2026-11-03 | 注册页**本地校验密码强度**（`lib/data/password_rules.dart`，服务端规则镜像）＋ 密码框下常驻要求文案 ＋ 标识框下「网站码只认申请时的手机号/邮箱」提示 | 用户报「拿到邀请码注册还是说我有问题」：他知道密码不合格，但不知道要求；且不知道网站码绑定申请时的标识 |
| 2026-11-03 | **P0-2b**：App「我的 → 登录账号」面板（`GET/PUT /auth/account`）＋ `SessionActions` 带同一份 `AuthApi` | 后端两条端点早有、App 里 0 个调用方：改密码 / 换手机号只能回小程序，而小程序要先微信登录 |
| 2026-11-03 | **小程序密码规则三份一致**：新增 `kids_points_mp/src/utils/password_rules.ts`，注册页 + `AppAccountSheet` 都改走它；新增守门脚本 `tools/password-rules-check.mjs`（三份逐字比对，篡改副本实测 exit 1），接进 `npm run password:check` / `npm run ci` | 小程序原来只查长度，`密码最多 64 位。` 与服务端文案已漂移；改一边忘另一边必然复发 |
| 2026-11-03 | **P0-5 探活上线**：`backend/src/health/`（存活不查库 / 就绪 `SELECT 1` + 硬超时 + 脱敏）、compose `healthcheck`、`deploy/watchdog-kids-api.sh`、`smoke-8443.sh` 第 8 项；线上实测 `/k/health` 与 `/kids/health` 均 200，容器 `(healthy)`，watchdog cron 已装 | 之前只有 `restart: unless-stopped`（只认进程退出）；事件循环卡死时进程还活着，`docker ps` 永远显示 `Up` |
| 2026-11-03 | **恢复 `/k/*` 公网入口**（Caddyfile 备份 → `handle_path /k/*` → `caddy validate` → `reload`）：`/k/health` `/k/app/version` `/k/invite` 实测 200 | 2026-11-02 该段被整段移除，小程序 `.env.local` 指向的入口全 404（表现为"连不上服务器"） |
| 2026-11-03 | **P0-4 备份 + 恢复演练**：`deploy/backup-kids-db.sh`（`/usr/local/bin/kids-backup.sh`），root cron `17 3 * * *`；实跑 `restore_test` 恢复出 24 张表、`PointRecord` 行数与线上一致 | 线上一个 `pg18` 容器、零备份：误删/磁盘坏 = 家庭账本全丢 |
| 2026-11-03 | `43` §0 新增 **0.1「发布」到底卡在哪**：能做的（SSH + `sudo docker`、镜像、APK、Caddy、备份）与只能你做的（微信开发者工具扫码上传、商店账号/正式签名）分开写清 | 用户问「昨天还能发版，今天怎么说没权限」——查后是 `docker.sock` 需要 `sudo`，不是账号被降权 |
| 2026-11-03 | **发布 1.0.4+5**（APK `/app/kids-points-1.0.4.apk` ＋ 稳定地址 `kids-points-app.apk`，`Content-Length 52578938`）；`kids.env` 的 `APP_LATEST_*` / `APP_PUBLISHED_AT` / `APP_RELEASE_NOTES` 同步；`/k/app/version` 实测 `1.0.4 / 5` | 1.0.3+4 的包**早于**今天的修复（密码提示、登录账号面板都在提交前），不发新包等于这些修复只存在于源码 |
| 2026-11-03 | 记录 **git 推送的真实故障点**：本机 `http.proxy=http://127.0.0.1:7897`，代理没起时 `git push` 报 `Failed to connect to 127.0.0.1 port 7897`（很容易被误读成"没权限"）；`git -c http.proxy= -c https.proxy= push` 可直连 | 用户问「昨天还能发，今天说没权限」——检查后是本地代理未运行，不是账号权限 |
| 2026-11-03 | **P0-3 双端「加入家庭」**（`POST /invites/accept`）：App 新增 `IdentityApi.acceptInvite()` ＋ `FamilyJoinActions` ＋ 「我的 → 加入家庭」面板；小程序新增 `WriteApi.acceptInvite()` ＋ `store.submitAcceptInvite()` ＋ `JoinFamilySheet` ＋ 同一入口；另加 `tools/invite-code-check.mjs`（邀请码形状三份逐字比对，篡改副本实测 exit 1），接进 `npm run invite:check` / `ci` | 邀请码只能**生成**不能**接受**：已有账号的亲戚拿到码后双端都没有入口（W11-A 只覆盖"还没有账号"）；形状规则一旦三份手抄漂移就是「本地放行、服务端 400」 |
| 2026-11-03 | **「我的 → 立即锁定入口」按用户要求移除**（`profile_screen.dart` 不再渲染；`AppStore.lockDateCodeGate()` 仅留诊断/用例，生产 0 调用方；重开 App 仍会重新上锁） | 用户明确「这个功能不要」；它是给验证闸门用的开发入口，不该出现在产品界面 |
| 2026-11-03 | **「记一笔」不再被全局只读误拦**（双端）：首页判据由 `isReadOnly`（`live ⇒ true`）改为 `isAdjustReadOnly`（仅 live 且无写客户端）；App `app_store.dart` / 小程序 `store.ts` ＋ `pages/home` | 用户实测「记一笔」提示「后端未就绪」——`POST /records/adjust` 早已上线，是界面判据把每个连后端的家庭都拦了 |
| 2026-11-03 | **孩子新增心愿真的落审批单**（双端）：`submitAddWish` 在 403 `APPROVAL_REQUIRED` 后调用 `POST /approvals`（action=`add_wish`），返回 `pendingApproval`；成员级 DENY 仍原样报错 | 用户实测「提示需要家长审批，但切回家长模式收件箱里没有这条」——开了口子却没落单，等于假提示 |
| 2026-11-03 | **D7 落地：引导第⑥步 PIN 必填（双端）＋ 家长模式面板的可执行出口**：新增 `validateRequiredParentPin()`（`lib/models/onboarding.dart`，不动「空串=没填」的旧判据）、`onboarding_screen.dart` 的 `_complete`/`_buildFooter`/`_stepPin`、小程序 `pages/onboarding/index.tsx` 的 `step === 5`；App 面板新增「退出登录，用手机号/密码重新登录」（借闸门那一份 `SessionActions.signOut`，`parent_mode_sheet.dart`），小程序把死文案改成指向「我的 → 退出登录」；服务端 `parentPin` 仍可省略，只为旧装机包保留（DTO 注释已写清）；证据 = `flutter test` **500**、`flutter analyze` 0 issue、小程序 `tsc` **EXIT=0**、后端 `typecheck` **0 error**，详见 `docs/design/49-bootstrap-guardian-window-pin.md` §5 | 网站码注册只发 5 分钟家长窗口（`identity.service.ts:791`），到期 `effectiveRole()` 回落 `child`（`session.gate.ts:117-131`），而设 PIN 要 `manage_parent_pin`（对孩子 DENY）⇒ 跳过 PIN 的账号 5 分钟后既进不了家长模式、也没权限补设，旧提示「请先用家长账号进入一次家长模式」是一句做不到的话 |
| 2026-11-03 | **W14 孩子模式限时窗口**（`docs/design/51-kid-mode-window.md`）：`DeviceSession.kidModeUntil` ＋ `POST/DELETE /auth/kid-mode`；判定优先级 `kidModeUntil > activeRole/expiresAt`，**到期不自动回家长模式**（A 方案，停 child 等 PIN）；双端面板（1–30 分钟、默认 15、「先写在纸上」提示）＋ App 首页状态条；`tools/kid-mode-check.mjs` 三端守门；另补小程序 `npm test`（20 个 `run-*.mjs` 统一入口）。证据 = 后端 `npm test` **1195 全通过**、`test-db` 新增 `kid-mode-db.dbtest.ts`、`flutter test` / `analyze`、小程序 `npm test` 全通过、守门脚本篡改副本 exit 1 | 会话 `1793685029278_j6mpl`（用户要求：默认家长模式、孩子模式限时 ≤30 分钟、先写在纸上、PIN 的位置）；上一轮只出方案未落地，用户要求「能开发就直接开发」 |
| 2026-11-03 | **D7 提交入库 ＋ 新增 [`50-unfinished-reasons-and-unblock.md`](./docs/design/50-unfinished-reasons-and-unblock.md)**：把 `43` §0 每条未做项标成 **A 凭据/本机 GUI · B 产品裁定 · C 可代做 · D 真机验收**，并规定「只写未做、不写卡点」视为不合格汇报；`43` §0 顶部与 `docs/design/README.md` 同步索引 | 用户问「未完成的需求为什么没符合？你不能符合吗」，并担心上一轮说过的家长模式方案没落地。查后确认：D7 代码已在工作区但**未提交**（29 个文件未入库），本轮提交并补一份可查的卡点说明 |
| 2026-11-04 | **P0-6 本机 PIN 锁 ＋ 申请/消息整页化**（`docs/design/52-app-pin-lock.md`）：删掉「日期＋星期」6 位验证码闸门（`date_code_gate.dart` / `date_code_api.dart` / `date_code_dto.dart` / 两个用例，`git rm`），换成 `lib/screens/pin_guard.dart`（冷启动 / `paused`·`hidden` / 孩子模式到点才上锁；家长设备没 PIN 先进 `parent_pin_setup_screen.dart`）；新增 `lib/widgets/pin_pad.dart`（圆点＋自绘数字键盘，不弹系统键盘）；「我的申请 / 消息」从底部弹窗改成 `my_applications_screen.dart` / `notifications_screen.dart` 整页列表；后端新增 `POST /auth/parent-pin/verify`（只校验、**不改角色**，否则 30 天家长会话解锁几次被压成 5 分钟），`auth-http.test.ts` 组 H 6 条；后端**已重建镜像并 `up -d`**（容器 `(healthy)`，`POST /auth/parent-pin/verify` **404 → 401**）；`flutter test` **509 全通过**、`flutter analyze` **No issues found**、后端 `npm test` **1201 全通过** | 用户 2026-11-04 四条要求（申请/消息不要弹窗、PIN 改数字输入像锁屏、日期码锁屏没意义改 PIN 锁、家长进来先设 PIN 且退到后台回来自动锁） |
| 2026-11-04 | **前后端发布 1.0.5+6**：`pubspec.yaml` / `lib/app_version.dart` / `kids.env` 三处 `1.0.5 / 6`；APK `/app/kids-points-1.0.5.apk`（`Content-Length 52808674`）＋ 稳定地址 `kids-points-app.apk`；后端镜像重建 → `prisma migrate deploy` 补 `20261103120000_kid_mode` → 重跑 `900` → `verify-db` **ALL PASS** → 容器 `(healthy)`。线上判据：`/kids/app/version` → `1.0.5 / 6`；`POST /kids/auth/kid-mode` 从 **404** 变 **401**（= W14 端点已上线）；`flutter test` **519 全通过**、小程序 `npm test` **ALL PASS**。同时把 `43` §0 里 8 条「未复核」补成**本轮复核**（P1-2/3/4/5/9/10、P2 两项、网站入口 `www:8443` 仍 000） | 用户问「前后端发版，未复核的任务是什么原因不能复核」：查后发现线上后端还是 W14 之前的镜像（`kid-mode` 404）、APK 停在 1.0.4+5（落后 4 个提交），而「未复核」只是上一轮没重跑，不是不能复核 |

| 2026-11-04 | **补齐「网站发码并发」真库常驻套件**（`43` §0 的「测试边界」一条）：新增 `backend/test-db/registration-invites-db.dbtest.ts`（6 条 —— 60 笔并发恰好 50 张、用尽后不再发、`dailyLimit=1` 首张不误判、两笔并发恰好 1 成功、落码失败回滚额度、`readQuota` 只读）；`test/registration-invite-http.test.ts` 的「由 `test-db/` 负责」那句注释改为指向真实文件；`43` §0 这一条划为**已完成**，`48` §7、`50` §1/§3 同步。证据 = `npm run typecheck:tests` **EXIT=0**、`npm run db:verify` **ALL PASS**、`npm run test:db` **25 文件 / 379 条全通过**（日志 `backend/.tmp_dbtest_20261104b.log`）；首轮实跑抓到自己的一个 bug（两条用例各自 `freshDay()` ⇒ 5 !== 0），已修 | 用户问「未复核的需求为什么没符合？跟用户有什么关系？是你不会，还是不能在回归测试/单元测试里做」：查后发现 `test/` 里的注释指向一个**不存在**的真库文件（悬空承诺），而这一条本来就属于「我能直接做」的 C 类 |
| 2026-11-04 | **本轮交付 4 条 C 类**（`docs/design/53-request-id-pin-reset-and-c.md`）：requestId ＋ 全局异常过滤器（`src/common/request-id.ts` / `all-exceptions.filter.ts` / `applyHttpFoundation`，**4xx 报文形状不改**）· 忘记家长 PIN 重置（`POST /auth/parent-pin/reset`，账号密码再验证 ＋ 每分钟 5 次 ＋ 审计 `via=account_password_reset`）· 网站发码 IP 限流（`REGISTRATION_INVITE_IP_DAILY_LIMIT` 默认 5，同事务 count，429 `REGISTRATION_INVITE_IP_LIMIT`）· 迁移随启动（`backend/docker-entrypoint.sh`，失败不接流量）。证据 = 新增 `test/request-id-http.test.ts` **9 条** ＋ `auth-http.test.ts` 组 I **7 条** ＋ `registration-invite-http.test.ts` **1 条**，`typecheck` / `typecheck:tests` / `typecheck:tools` 全 **EXIT=0** | 用户 2026-11-04：「接上次会话 B 没问题，你做 C、D 都做」—— B 类按默认建议认可，本轮先把后端/运维侧 4 条做完；P1-3 / P1-2 / P1-4 / P1-5 / P1-10 仍未开工，`53` §6 逐条写明 |

