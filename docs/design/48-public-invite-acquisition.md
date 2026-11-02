# 48 · 网站「邀请码获取」＋ 网站注册码（W12，2026-11-02）

> **状态：后端、网站页面、App 文案、小程序注册页已实现。**
> 证据见 §6（本轮实跑）。**并发由手工探针覆盖（60 → 恰好 50），`test-db` 常驻套件未写；未做真机走查、未部署**。
>
> 本文只回答五件事：**谁在什么时候、拿什么、走哪条路、失败看到什么、两端文案差在哪**。
> 字段级契约以本文 + 代码为准；`45`（家庭邀请码注册）与 `47`（两个门）仍然有效，
> 本文是**第三种来源**：网站发码。

---

## 0. 一分钟版

| 问题 | 答案 |
|---|---|
| 这是什么 | 一个**公开网页**：填手机号 + 邮箱 ⇒ 当场拿到一个邀请码 |
| 页面地址 | `GET /invite`（由后端直接发 HTML；见 §1.2） |
| 每天能发多少 | **默认 50 张**，`REGISTRATION_INVITE_DAILY_LIMIT` 可改（1..1000） |
| 码有效期 | **默认 7 天**，`REGISTRATION_INVITE_TTL_DAYS` 可改（1..30） |
| 码绑定什么 | **手机号 + 邮箱**（注册时填其中**任意一个**即可） |
| 一张码能用几次 | **一次**（`usedAt` 非空即不可再用） |
| 拿到码去哪注册 | 小程序**或** App，登录页「第一次用？用邀请码注册」 |
| 两端是什么关系 | **同一套账号、互不依赖**：任意一边注册后，另一边用同一手机号/邮箱 + 密码登录 |
| 用网站码注册后有几个孩子 | **0 个**。随后走既有 `POST /children` 引导建档案（`40` §7） |
| 和「邀请家长」什么关系 | **本轮不做邀请家长**；家庭邀请码（`POST /invites`）保持原样，本页不替代它 |

> ★ **它不是「开放注册」**：没有有效网站码，`/auth/register-invite` 仍然拒绝。
> 变的只是「码从哪里来」——以前只能家长在家庭里生成，现在也可以由网站按额度发放。

---

## 1. 用户流程

### 1.1 全景

```
访客（还没有账号）
  │ 打开网站 /invite
  │ 填手机号 + 邮箱
  ▼
POST /public/registration-invites
  │ ① 两个标识按 account-identifier.ts 规范化
  │ ② 业务日额度（KP_TIMEZONE）原子 +1
  │ ③ 密码学随机生成 8 位码，落 RegistrationInvite
  ▼
页面显示：ABCD-EFGH ＋ 绑定的脱敏手机号/邮箱 ＋ 有效期
  │ 复制 / 抄下来
  ├──────────────► 小程序：登录页 →「第一次用？用邀请码注册」
  └──────────────► App  ：登录页 →「第一次用？用邀请码注册」
                          │
                          ▼
                 POST /auth/register-invite
                 { inviteCode, identifier, password, displayName? }
                          │ ① 形状 / 标识 / 密码强度（与服务端同一份规则）
                          │ ② 先问来源：findByCode(code) → RegistrationInvite?
                          │    ├─ 是 ⇒ 走公开注册适配器
                          │    └─ 否 ⇒ 走既有家庭邀请码适配器
                          ▼
         User + 占码 + AuthSession + AuditLog（**一个事务**）
         ★ 不建 ChildMember / DeviceSession：零个孩子是**事实**
                          │
                          ▼
         客户端 GET /auth/session → children: []
                          │
                          ▼
         App `AccountGate` / 小程序闸门 →「同意并建立档案」→ POST /children
```

### 1.2 页面为什么由后端发（`GET /invite`）

| 方案 | 代价 |
|---|---|
| 另建静态站 / Caddy `file_server` | 要加一套部署规则；页面与 API 跨源或要额外反代；两处地址容易漂 |
| 后端发 HTML（**采用**） | 与 API **同源**（不用放宽 CORS）；只走现有容器；`/k` 与 8443 两个入口自动都可用 |

★ 页面里的请求路径是**相对**的（`public/registration-invites`，**不带**开头的 `/`）：
`https://…:8443/invite` 解析成 `/public/...`，`http://82.157.153.22/k/invite`
解析成 `/k/public/...`。写成绝对路径会让后者绕过 `/k` 前缀，打到 hub 静态站上（表面是 404）。

---

## 2. 数据模型与契约

### 2.1 两张新表（`prisma/schema.prisma`）

| 表 | 作用 | 关键列 |
|---|---|---|
| `RegistrationInvite` | 一张网站码 | `code` 唯一、`phone`、`email`、`expiresAt`、`usedAt`、`usedByUserId`、`revoked`、`issuedIpHash` |
| `RegistrationInviteQuota` | 每个业务日的已发数量 | 主键 `day`（`YYYY-MM-DD`，`KP_TIMEZONE`）、`issued` |

**为什么不是 `InviteCode` 的又一行**：那个表的 `childId` 是 NOT NULL 外键，
语义是「加入某个已存在的家庭」。网站申请人还没有家庭，硬塞只能先造一个假孩子 ——
那正是 `42` §5.1 拒绝开放注册时点名的孤儿数据。

**为什么额度要单独一张表**：`COUNT(*)` + `insert` 是 TOCTOU（两个并发请求都数到 49，
于是发出第 50、51 张）。额度做成**一行的原子自增**：

```sql
UPDATE "RegistrationInviteQuota"
   SET "issued" = "issued" + 1
 WHERE "day" = $1 AND "issued" < $2
RETURNING "issued"
```

恰好 `dailyLimit` 个请求拿到行；其余拿到 0 行 ⇒ 429。

### 2.2 三条路由

| 方法 | 路径 | 认证 | 回包 |
|---|---|---|---|
| GET | `/invite` | `@Public()` | HTML（`text/html; charset=utf-8`，`Cache-Control: no-store`） |
| GET | `/public/registration-invites/quota` | `@Public()` | `{ dailyLimit, remainingToday, resetsAt, timeZone }` |
| POST | `/public/registration-invites` | `@Public()` | **201** `{ code, expiresAt, phoneMasked, emailMasked, dailyLimit, remainingToday }` |

`POST` 的失败：

| 情形 | 状态 | code |
|---|---|---|
| 手机号形状错 | 400 | `INVALID_PHONE` |
| 邮箱形状错 | 400 | `INVALID_EMAIL` |
| 少 / 多字段 | 400 | 全局管道（`whitelist + forbidNonWhitelisted`） |
| 今日额度用完 | **429** | `REGISTRATION_INVITE_DAILY_LIMIT`（含 `retryAfterSeconds` / `dailyLimit`） |
| 无库装配 | 501 | `REGISTRATION_INVITE_NOT_IMPLEMENTED`（页面仍能打开，提交会如实报错） |

### 2.3 注册端点（既有路由，多了一条来源）

`POST /auth/register-invite` 的请求 / 成功回包**形状不变**，差别只有一处：

| 码来源 | `membership` | 事务内容 |
|---|---|---|
| 家庭邀请码（`InviteCode`） | `{ childId, role }` | User + 占码 + ChildMember + DeviceSession + AuthSession + Audit |
| 网站注册码（`RegistrationInvite`） | **`null`** | User + 占码 + AuthSession + Audit（**不建家庭相关两张表**） |

**为什么先 `findByCode` 再分叉**：两种码形状相同（8 位、同一字母表），只能靠表区分。
这次读只用于**路由**，不用于授权 —— 真正的「还能不能用」仍由各自事务里的一条
条件 SQL 回答（`claimInviteCode` / `claimRegistrationInvite`）。

**标识绑定在 SQL 里**：

```sql
UPDATE "RegistrationInvite"
   SET "usedAt" = now(), "usedByUserId" = $userId
 WHERE code = $code
   AND "usedAt" IS NULL
   AND revoked = false
   AND "expiresAt" > now()
   AND (phone = $identifier OR email = $identifier)
RETURNING id
```

⇒ 不存在 / 已用过 / 过期 / 吊销 / **标识不匹配** 全部返回 0 行 ⇒ 同一个
409 `INVITE_CODE_UNAVAILABLE`。区分它们等于给端点一个「哪些码存在」的探测面。

---

## 3. 安全与限额（每条都是明确选择）

1. **手机号 + 邮箱都必填**：码绑定这一对标识；只收一个会让另一类用户没有可核对的凭据。
2. **注册只认其一**：App / 小程序注册页只收一个标识，要求两个都填会把「用手机号注册」的人挡在门外。
3. **一人一码**：`usedAt` 非空即失效；多人共用不是本页的语义（那是家庭邀请码）。
4. **额度按业务日算**：`KP_TIMEZONE`（默认 `Asia/Shanghai`）零点重置，不是 UTC 日 ——
   否则北京时间 00:30 的申请会算进昨天。
5. **额度上限可配**：`REGISTRATION_INVITE_DAILY_LIMIT` 默认 50，合法 1..1000；
   `0` / 负数 / 非数字 ⇒ 回退 50；`100000` ⇒ 夹到 1000（防「等于没限额」）。
6. **IP 只存 HMAC**：`issuedIpHash`（`consent/hash-pii.ts`，没有盐时为 NULL），
   只用于事后核对「一天 50 张是不是同一个人刷的」，**不参与任何判定**。
7. **审计不写码本身**：`AuditLog` 只记 `registrationInviteId` 与 `via: 'website_invite'`。
8. **注册与登录共用限流**：`POST /auth/register-invite` 仍走 `LoginRateLimiter`
   （同 IP 20/分、同设备 10/分）。否则「发码有额度、注册不限流」等于开一个绕过口。
9. **网站发码端点没有单独限流**：它的成本上界是「每天 50 行 + 一次手机号/邮箱校验」，
   由全局额度兜住。**这是已知边界**：同一 IP 可以刷完当天 50 张（产品语义允许），
   若要按 IP 限流，应作为下一轮独立配置，而不是在这里猜一个阈值。

---

## 4. 两端文案（为什么必须不同）

同一句「用邀请码注册」，在小程序与 App 上**下一步不同**：

| 项 | 小程序 | App |
|---|---|---|
| 入口 | 登录页「第一次用？用邀请码注册」 | 登录页「第一次用？用邀请码注册」 |
| 另一个登录方式 | **微信一键登录** ＋ **手机号/邮箱 + 密码**（W12 补） | 手机号 / 邮箱 + 密码 |
| 注册成功后的下一步 | 零孩子 ⇒ 建立档案；家庭码 ⇒ 直接进首页 | 同左 |
| 页面提示重点 | 「也可以用微信登录；但要用同一个账号，请选手机号/邮箱登录」 | 「注册成功后按引导为孩子建立档案」 |

> ★ **微信身份与手机号/邮箱是两个登录凭据**：`POST /auth/login`（微信）按
> `openId` 建/查 `User`，它与网站码建的「手机号/邮箱账号」**不是自动合并的两行**。
> 页面必须把这件事讲清楚，否则用户会以为「微信登录一下就能看到 App 里的孩子」。
> 先用微信建过账号的人，需要在小程序「我的 → App 登录账号」绑定同一个手机号/邮箱
> 并设置密码，之后才能在 App 用这个号登录。

> ★ **W12 同时给小程序补了「手机号/邮箱 + 密码」登录**（`POST /auth/login-account`）。
> 这不是顺手加的：小程序原先只有 `POST /auth/login`（微信 openid），它会按
> `openId` 建一行**新的** `User`，与网站码建的「手机号/邮箱账号」不是同一行 ——
> 那样「同一套账号、互不依赖」在**客户端**上就是假的。
> 补上账号密码登录之后，同一账号才能在两端都进得去。

**共同说明（两端都写、网站也写）**：

> 小程序和 App 是**同一套账号，互不依赖**。在任意一边注册后，另一边用
> **同一个手机号或邮箱 + 密码**就能登录；不需要「先在小程序登录过」才能在 App 登录，
> 反过来也一样。

这条不是文案偏好：`User` 是同一行（`phone` / `email` 在 `User` 上），
`AuthSession` 与 `DeviceSession` 分工也与客户端类型无关。

---

## 5. 配置

| 环境变量 | 默认 | 合法范围 | 说明 |
|---|---|---|---|
| `REGISTRATION_INVITE_DAILY_LIMIT` | `50` | 1..1000 | 每个业务日最多发多少张 |
| `REGISTRATION_INVITE_TTL_DAYS` | `7` | 1..30 | 每张码有效期 |
| `KP_TIMEZONE` | `Asia/Shanghai` | IANA 名称 | 「业务日」按哪个时区算 |

★ 改额度**不需要发版**：`resolveRegistrationInviteConfig()` 每次请求都读环境变量；
容器重启即生效。非法值回退默认，不会 500。

---

## 6. 证据（本轮实跑）

| 层 | 证据 |
|---|---|
| 后端静态 | `tsc --noEmit -p tsconfig.json` **EXIT=0**；`tsconfig.test.json` **EXIT=0** |
| 后端用例 | `registration-invite-http.test.ts`（8 条）＋ `register-public-invite-http.test.ts`（8 条），见 §6.1 |
| 既有回归 | `npm test` **64 文件 / 1146 条全部通过**（含原有 1130 条基线） |
| App | `flutter analyze` **No issues found**；`flutter test` **459 条全部通过** |
| 小程序 | `npx tsc --noEmit -p tsconfig.json` **EXIT=0**；`npm run build:weapp` **Compiled successfully**（`dist/pages/register/` 已产出） |
| 活库（本地） | `prisma migrate deploy` 应用 17 个迁移；真起 `dist/main.js` 实测：`GET /invite` 200、`GET …/quota` **200 `{dailyLimit:50,remainingToday:50,resetsAt:2026-11-02T16:00Z,timeZone:Asia/Shanghai}`**、`POST …/registration-invites` **201** `{"code":"KXYG-QJ2D",...}`、用该码 `POST /auth/register-invite` **200 + `membership:null`**、随后 `GET /auth/session` **`children: []`**、同码再用 **409**。测试数据已清理（`User` / `RegistrationInvite` / 当日额度行）。 |
| 并发额度 | `npm run probe:invite-quota`（手工、不进 CI）→ **60 笔并发 / 恰好 50 笔 created、10 笔 quota_exhausted、50 个码无重复、quotaIssued=50**。★ 直接调用**真实适配器**（不是复刻 SQL），见 `scripts/probe-registration-invite-concurrency.ts`。 |
| 未跑 | 真机走查、线上部署；`test-db/` 里**尚未**加入本功能的常驻套件（并发证据目前来自上面的探针） |

### 6.1 新增用例钉住什么

`registration-invite-http.test.ts`：

1. 201 + 展示形码 + 脱敏手机号/邮箱 + `remainingToday`；
2. 手机号 / 邮箱形状错 ⇒ 400 且**零发码**；
3. 少字段 / 多字段 ⇒ 400；
4. 额度改成 7 ⇒ 回包与端口都是 7；有效期改成 1 天 ⇒ `expiresAt` 约 1 天后；
5. 非法额度 `0` ⇒ 回退 50；
6. 额度用完 ⇒ **429** + `retryAfterSeconds`；
7. `GET .../quota` 只读、不改额度；
8. `GET /invite` 能打开、含小程序 / App 两段文案与「同一套账号，互不依赖」；
9. 页面用**相对**路径请求接口（防 `/k` 前缀被绕过）。

`register-public-invite-http.test.ts`：

1. 网站码 + 匹配手机号 ⇒ 200、`membership: null`、token 真的过 `AuthGuard`；
2. 同一个码用**邮箱**也认；
3. 标识不匹配 ⇒ 409，两条路都**零写入**；
4. 已用过的网站码 ⇒ 409，且**不掉回**家庭邀请码路径；
5. 查不到的码 ⇒ 仍走家庭路径（既有行为逐字不变）；
6. 码形状错 ⇒ 400 `MALFORMED`，两次查码都没发生；
7. 缺设备头 ⇒ 400；多余 `role` ⇒ 400。

---

## 7. 未做 / 已知边界（每条都是明确取舍）

| 项 | 现状 | 影响 |
|---|---|---|
| 活库并发用例 | 有**手工探针**（`npm run probe:invite-quota`：60 → 50 通过）；`test-db/` 常驻套件未写 | 每次改额度 SQL 都应重跑探针；CI 不跑它（需要可写活库） |
| 网站发码的 IP 限流 | 未做（见 §3.9） | 同一 IP 可刷完当天额度 |
| 额度行的清理 | 一天一行，不清理 | 量级可忽略；将来要保留策略再单独做 |
| 「重新申请」 | 旧码**不吊销**，新码另发 | 用户可能同时持有两张有效码，各用一次；额度是唯一约束 |
| 手机号/邮箱验证 | **不发短信、不发邮件** | 申请人可以填别人的邮箱；码只授权「建号 + 绑该标识」，不证明拥有它 |
| 邀请家长 | **本轮不做** | 家庭邀请码 UI / 后端保持原样，未删未改 |
| 真机走查 | 未做 | 小程序注册页仅有编译证据 |
| 部署 | 未做 | `GET /invite` 随现有容器上线；无需新增 Caddy 规则 |

---

## 8. 与既有文档的关系

- `42` §5.1「不做开放注册」**仍然成立**：本页发的是**邀请码**，不是免码注册。
- `45`（家庭邀请码注册）**不变**：`POST /auth/register-invite` 的请求/回包形状不变；
  新增的只是「网站码 ⇒ `membership: null`」这一支。
- `47`（两个门）**不变**：网站码既不是「注册门」也不是「加入门」的替代，
  它是**注册门的第三种凭据来源**。家庭邀请码仍可用于加入已有家庭。
- `46` §2.2「同一把钥匙两个门」**只对 `InviteCode` 成立**：网站码**不能**用于
  `POST /invites/accept`（不在那张表里），这是刻意的 —— 它不绑定任何家庭。


