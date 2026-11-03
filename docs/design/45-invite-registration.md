# 45 · 邀请码注册（App 端「第一次登录」的入口）· **阶段 W11-A**

> **状态：后端 + Flutter 已实现并全绿**（2026-11-02）。
> 证据：后端 `npm test` **新增 11 条**（`test/invite-register-http.test.ts`）、
> `typecheck` / `typecheck:tests` 0 error；Flutter `flutter test` **456 条全通过**
> （新增 `test/invite_register_test.dart` 4 条）、`flutter analyze` **No issues found**。
>
> **决策来源**：`42-account-login-design.md` §9 第 1 条 ——
> 「开放注册」的前置是**邀请码并入家庭**。本文就是那个前置条件。
>
> **它不推翻 `42` §5.1**：开放注册仍然不做。做的是「**凭邀请**注册」。

---

## 0. 一页结论

| 问题 | 结论 | 为什么（一句话） |
|---|---|---|
| 第一次登录从哪来 | **邀请码 + 手机号/邮箱 + 密码** → `POST /auth/register-invite` | 新用户没有账号；不给他入口，App 只服务「已经在小程序里建过号」的人 |
| 为什么不开放注册 | **不做**，只做邀请制 | 开放注册会让「手机号打错一位」静默变成孤儿账号 + 「我的孩子不见了」（`42` §5.1） |
| 邀请码从哪来 | 家长在小程序里生成（`POST /invites`，「我的 → 家庭成员」） | 码是家长签发、有次数上限、有有效期、可吊销的**凭据**（`02` §8） |
| 新账号是什么角色 | **邀请码行上的 `role`** | 请求体里没有 `role`；多传一个 `role` ⇒ 全局管道 **400** |
| 四种「码不能用」 | **同一个 409** `INVITE_CODE_UNAVAILABLE` | 区分它们等于给这个端点一个「哪些码存在」的探测面，而用户能做的动作相同 |
| 手机号已注册 | **409** `IDENTIFIER_TAKEN`（不是 400） | 400 会让用户反复改写法；真相是「直接登录」 |
| 注册成功后 | 直接拿到 `AuthSession` token + `membership` | 注册与登录**同形**回包；客户端复用同一套解析与 child-session 编排 |
| 服务端失败会不会留垃圾 | **不会**：一个事务、失败整笔回滚 | 否则会出现「账号建了、码没占上」「码占了、人没加进去」 |

---

## 1. 本轮之前缺的是什么

| 事实 | 位置 | 后果 |
|---|---|---|
| App 只有 `POST /auth/login-account`（登录），**没有注册** | `lib/data/auth_api.dart` | 新家长打开 App 只能看到一个需要账号的登录页 |
| `POST /invites/accept` 要求**已有会话** | `backend/src/invites/invites.controller.ts` 文件头 | 全新设备 / 全新用户走不通这条「加入家庭」的路 |
| 账号只能由小程序（微信登录）产生 | `identity.service.ts#loginWithAccount` 注释 | 没有微信、只有手机的用户完全进不来 |
| `42` §9 第 1 条把「邀请码并入家庭」写成开放注册的前置 | `docs/design/42` | 本轮把它补上 |

> 一句话：**邀请码解决了「加入哪个家庭」，注册解决了「你是谁」；把它们放进同一个事务，App 才有第一个真人用户。**

---

## 2. 后端契约

### 2.1 `POST /auth/register-invite`（`@Public()`，200）

```jsonc
// 请求（全局管道 whitelist + forbidNonWhitelisted：多余字段一律 400）
{ "inviteCode": "MAMA-2345", "identifier": "138 0013 8000",
  "password": "jiazhang2026", "displayName": "妈妈" }   // displayName 选填

// 200 —— 与 POST /auth/login-account 的 LoginView **逐字段同构**
{ "token": "kps_…", "expiresAt": "…",
  "user": { "id": "…", "displayName": "妈妈" },
  "membership": { "childId": "…", "role": "guardian" } }
```

| 情形 | 状态码 | code |
|---|---|---|
| 成功 | 200 | — |
| 码形状不对（抄漏 `/` 含 `0 O 1 I L`） | 400 | `INVITE_CODE_MALFORMED` |
| 码不存在 / 过期 / 用完 / 吊销 | 409 | `INVITE_CODE_UNAVAILABLE`（四者**逐字相同**） |
| 手机号/邮箱已被注册 | 409 | `IDENTIFIER_TAKEN`（`field: phone / email`） |
| 标识形状错 | 400 | `INVALID_IDENTIFIER` |
| 密码太弱 | 400 | `WEAK_PASSWORD`（`reason` 与 `42` §3.2 同一套） |
| 缺 `x-kp-device-id` | 400 | `DEVICE_ID_REQUIRED` |
| 这台设备在该孩子上已有别人的会话 | 409 | `DEVICE_SESSION_CONFLICT` |
| 超限 | 429 | `LOGIN_RATE_LIMITED`（与两个登录端点**共用**额度） |
| 孩子档案已删除 | 404 | `CHILD_NOT_FOUND` |

### 2.2 一个事务、七步（顺序不能换）

```
① User          手机号/邮箱 + passwordHash（唯一列冲突 ⇒ 409 IDENTIFIER_TAKEN）
② 占邀请码       条件 UPDATE（唯一判据，与 /invites/accept 共用）
③ 孩子是否还在   status='active'（软删档案的码 = 通往空房子的钥匙）
④ ChildMember   角色**只**来自邀请码行
⑤ DeviceSession (deviceId, childId)，已有别人的会话 ⇒ 409
⑥ AuthSession   tokenHash + method='password'（明文只在响应里出现一次）
⑦ AuditLog      action='member.join'，after 只记码行 id，**不记码本身**
```

★ **为什么先建 User、再占码**：`InviteCode.usedByUserId` 是外键，占位语句需要已存在的
userId。这不会留下孤儿账号 —— 整个方法是一个交互式事务，占码失败（返回 `null`）时
抛出异常，`User` 那一行一起回滚。

### 2.3 一条共享判据（本轮顺手修的重复）

邀请码「还能不能用」原本只有 `invites.prisma.repository.ts` 里的那条
`UPDATE … WHERE "usedCount" < "maxUses" AND "expiresAt" > now() AND revoked = false`。
注册路径如果各抄一份，就会出现**两份「什么叫可用」**（边界 `>` vs `>=`、吊销怎么算）。

⇒ 抽到 `backend/src/invites/invite-claim.ts`：

- `claimInviteCode(tx, { code, userId })`：返回占位行或 `null`；
- `toInviteRole(role)`：`child | guardian` 之外 ⇒ **500**（库里有脏数据）。

`invites.prisma.repository.ts` 改为调用同一份函数（只搬代码，行为不变：
`invites-http.test.ts` + `test-db` 口径不受影响）。

### 2.4 为什么单独一个端口（`INVITE_REGISTRATION_REPOSITORY`）

不并进 `IdentityPort`：那个接口 7 个方法每个都有 2 个测试替身，加第 8 个方法 = 一次性
改 4 个替身，而 3 个永远用不到它 —— 正是 `identity.repository.ts` 文件头警告的
「接口面变宽 ⇒ 替身越来越难写」。无库装配时它回 **501**，绝不「假装注册成功」。

---

## 3. Flutter 端

### 3.1 `AuthApi.registerWithInvite()`

与 `loginAccount` 三条不变量一致：**密码不落盘**、**不拿旧 token 换新 token**、
拿到 token **立刻** `holder.adopt()`（调用方不再手工转存）。

本地只拦「空」与**密码强度**（密码那一条是 2026-11-03 加的例外）：码形状 / 标识形状
仍然只有服务端一份规则（`invite-code.ts` / `account-identifier.ts`）—— 抄一遍会漂移，
用户会看到「本地说可以、服务端说不行」。

密码强度为什么要抄：**规则本身就是给用户看的要求**。2026-11-03 用户拿网站码来注册，
App 直接把请求发出去、再显示服务端 `400 WEAK_PASSWORD`：他知道「密码有问题」，
却不知道要求是什么，只能一次次试。`lib/data/password_rules.dart` 是
`validatePasswordStrength()` 的逐条镜像（8–64 位 / 非单一字符 / 非纯数字 /
非常见弱口令 / ≠ 标识），注册页提交前先判、密码框下常驻一行要求；
`test/password_rules_test.dart` 直接读后端源文件钉住阈值、弱口令表与六句文案，
改一边忘另一边会红。**服务端仍是唯一裁定者**：两边万一不一致，以它回的 `message` 为准。

### 3.2 三屏流转（`AccountGate` 的一个新相位）

```
needLogin ──「第一次用？用邀请码注册」──▶ needRegister
    ▲                                        │
    └────────────「返回登录」─────────────────┘
                                             │ 提交成功
                                             ▼
                        preparing（POST /auth/child-session）→ signedIn
```

| 决策 | 做法 | 理由 |
|---|---|---|
| 登录页只放一个**次级**入口 | `TextButton`，不是与「登录」并列的主按钮 | 绝大多数打开 App 的人是回来登录的 |
| 注册失败留在**注册页** | `_register` 的 catch 设 `_phase = needRegister` | 弹回登录页会把刚输入的邀请码 / 手机号全丢掉 |
| 注册**成功**后 child-session 失败 | 走 `_handleIdentityFailure`（重试 / 重新登录），**不**回注册页 | 账号已经建好；再点一次会 409 `IDENTIFIER_TAKEN`，用户会以为没注册成功 |
| `authApi == null`（预览模式） | 不渲染注册入口 | 画一个点了没反应的按钮是撒谎 |

### 3.3 界面（`lib/screens/register_screen.dart`）

- 字段顺序：**邀请码 → 手机号/邮箱 → 密码 → 称呼（选填）**。
  邀请码放第一，是因为它是这条路由唯一的授权凭据 —— 用户应该第一眼就知道
  「我需要向家长要一个码」，而不是填完才被 409 打回来。
- 没有「获取验证码」/「微信登录」：两者都需要本项目刻意不引入的第三方通道。
- 密码不回显在任何错误里（提示会被截图 / 进日志）。

---

## 4. 安全与取舍（每条都是明确选择）

1. **角色只来自邀请码**：DTO 没有 `role`；全局管道对多余键 400。
   否则「child 码 + `role=guardian`」就是一条现成的提权路径。
2. **限流共用**：注册和两个登录端点共享 `LoginRateLimiter` 的额度
   （同 IP 20/分、同设备 10/分）。不共用 = 用注册绕过登录限流。
3. **必须带 `x-kp-device-id`**：`DeviceSession` 的行键是 `(deviceId, childId)`。
   没有它也能签 token，但那个 token 永远过不了业务守卫 —— 用户会看到
   「注册成功」然后每个请求 401。
4. **手机号打错的最坏情况**：他会得到一个**加入了正确家庭**的新账号，
   而不是孤儿数据；而正确号码仍可再注册一次（若已被占用则是 409，提示去登录）。
   这比「先查不到就建一个」好：后者会把打错的号码变成「孩子不见了」。
5. **码是凭据**：8 位、31 个易辨认字符、密码学随机、次数上限、有效期上限 30 天、可吊销；
   审计只记码行 id，**不记码本身**（读取面比码本身宽）。
6. **不发明文密码 / token 进日志**：端口只收 `passwordHash` 与 `tokenHash`；
   审计里没有任何凭据。

---

## 5. 证据（可复核）

| 层 | 证据 |
|---|---|
| 后端类型 | `npm run typecheck` / `typecheck:tests` 均 0 error |
| 后端用例 | `node --test .tmp_test_build/test/invite-register-http.test.js` **11 pass / 0 fail** |
| 既有回归 | `invites-http` + `account-login-http` + `identity-http` + `date-code` **101 pass**（85 + 16） |
| Flutter 静态 | `flutter analyze` **No issues found** |
| Flutter 用例 | `flutter test` **456 条全通过**（新增 4 条） |
| 未跑 | `test-db`（活库回滚 / `P2002`）、真机走查、小程序 `build:weapp` |

`invite-register-http.test.ts` 逐条钉住：

1. 注册成功 ⇒ 200 + token 真的过 `AuthGuard`（`GET /auth/session` 200）+ `membership` 指向码里的孩子；
2. 码 / 标识归一化（`mama-2345`、`+86 138-0013-8000`）+ 密码哈希后才进端口；
3. 角色来自码（child 码 ⇒ child）；
4. 码形状错 ⇒ 400 且**零写入**；
5. 码不可用四种情况 ⇒ **同一个 409**；
6. 弱密码 ⇒ 400（在花 scrypt 之前）；
7. 标识形状错 ⇒ 400；
8. 手机号已注册 ⇒ 409 `IDENTIFIER_TAKEN`；
9. 缺设备头 ⇒ 400 `DEVICE_ID_REQUIRED`；
10. 请求体多一个 `role` ⇒ 400；
11. 同一设备第 11 次 ⇒ 429 `LOGIN_RATE_LIMITED`。

---

## 6. 未做清单（**每一条都是明确取舍**）

1. **活库用例**：`test-db/invite-registration-db.dbtest.ts` **未写、未跑**。
   需要证明的是「占码失败 ⇒ 0 个 User」（整笔回滚）与 `P2002 ⇒ 409`。
   本轮只有内存替身，**不能**把绿读成「事务已验证」。
2. **小程序侧不需要这个入口**：小程序走微信登录，注册 = `wx.login` 建 User；
   它负责的是**生成**邀请码（`POST /invites` 已有）。
3. **邀请码使用明细**：`InviteCode.usedByUserId` 只有一列，`maxUses>1` 时只代表
   最后一次使用者。要做「谁用了哪个码」需要一张使用明细表（新表 + 迁移）。
4. **注册后不能自助找回密码**：仍是「回小程序重设」（`42` §5.2）。
   ★ 邀请码**不能**拿来当重设凭据：它绑定的是 `childId`，不是手机号 / `User`；
   任何持有该孩子有效码的人都能借此接管别人的账号（`46` §2.1 有攻击路径）。
   要做 App 内自助重设，必须先新增一条**绑定账号**的通道
   （一次性恢复码 / 短信 / 邮件 / 已登录设备）。
5. **成人协议未落库**：注册页只有一句「注册即表示同意」，没有成人协议表
   （现有 `GuardianConsent` 是**孩子**的同意，语义不同，不能复用）。
6. **邀请码吊销不影响已注册用户**：吊销只阻止**新**加入；已加入的人要移出请走
   `DELETE /members/:id`（成员管理）。
7. **真机走查**：没有在真机上点过这条链路。

---

## 7. 复现命令 & 「第一次怎么登录」操作手册

### 7.1 本地（PostgreSQL + 后端）

```bash
cd backend
npx prisma migrate deploy          # 用 MIGRATION_DATABASE_URL（表所有者）
npm run seed:demo                  # demo-child / demo-guardian / 邀请码 MAMA2345
npm run seed:account               # 13800138000 / demo12345（演示家长）
npm start
```

| 场景 | 用什么 | 说明 |
|---|---|---|
| **已存在的演示家长** | `13800138000` / `demo12345` | 来自 `npm run seed:account`；登录后直接进演示家庭 |
| **一个全新的人（邀请码注册）** | 邀请码 `MAMA2345` + 任意未注册手机号 + 自定密码 | 来自 `npm run seed:demo`；码为 guardian、3 次名额、7 天有效 |
| **线上** | 由家长在小程序「我的 → 家庭成员」生成 | 线上**没有**预置账号，这是唯一入口 |

```bash
# Flutter（Web 预览）
flutter run -d chrome --web-port=5173 \
  --dart-define=KP_API_BASE_URL=http://127.0.0.1:3000
```

首屏是登录页：

- 有账号 ⇒ 手机号/邮箱 + 密码 → 登录；
- 没账号 ⇒ 点「第一次用？用邀请码注册」→ 填邀请码 / 手机号 / 密码 → 注册并登录。

### 7.2 只用 curl 验一遍

```bash
curl -s -X POST http://127.0.0.1:3000/auth/register-invite \
  -H 'content-type: application/json' \
  -H 'x-kp-device-id: dev-new-phone' \
  -d '{"inviteCode":"MAMA2345","identifier":"13900139000","password":"jiazhang2026","displayName":"妈妈"}'
```

期望：`200` + `token` + `membership.childId = demo-child`；再用该 token 请求
`GET /auth/session` 应为 `200`（`45` §5 的第 1 条就是这条闭环）。

