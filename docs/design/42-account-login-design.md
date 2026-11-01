# 42 · App 账号登录（手机号 / 邮箱 + 密码）· **阶段 W9-D**

> **状态：后端已实现并全绿**（2026-10-30）。`npm test` **58 文件 / 1093 用例**，
> 其中 W9-D 新增 `test/account-login-unit.test.ts`（20 条）与
> `test/account-login-http.test.ts`（18 条）。客户端落地情况见 §8。
>
> **决策来源**：产品方 2026-10-30 明确 —— 「先做通小程序，App 用手机号或邮箱登录，
> **不授权微信**」。本文把这个决定翻译成契约，并写清它换掉了什么。

---

## 0. 一页结论

| 问题 | 结论 | 为什么（一句话） |
|---|---|---|
| App 的身份锚点是什么 | **`User.phone` / `User.email` + `passwordHash`** | 不碰微信 SDK ⇒ 没有开放平台审核、没有 `unionid`、没有 300 元/年 |
| 凭据形态 | 与小程序**同一种** `AuthSession` 不透明 token | 多一套凭据体系＝守卫要认两种东西，等于把 §9.3 的三分流出两遍 |
| 怎么证明「这个号是你的」 | **密码**（`scrypt-pw`，每行独立盐） | 零第三方通道：不需要短信服务商、不需要 SMTP；离线可测 |
| 忘记密码怎么办 | **回小程序重设**（微信登录已证明身份） | 这是"不接微信"却仍然不需要短信/邮件的**唯一**自洽解法（§5.2） |
| 能不能在 App 里注册 | **不能**（首版） | 否则手机号打错一位就静默生成新账号，用户会看到"孩子不见了"（§5.1） |
| token 存哪 | Flutter 侧 `dart:io` 写缓存目录（零依赖） | `README.md:19` 把"不引入 `shared_preferences`"写成硬约束（§7.2） |

---

## 1. 为什么不是另外两条路

三条候选在 `41` §6 列过，这里只记**否掉的理由**（都是外部的、不会因实现而改变）：

| 方案 | 否掉的原因 |
|---|---|
| 微信开放平台（App 内授权登录） | `fluwx` 等 SDK + **开放平台审核 1–2 周** + **300 元/年**认证费；且要补 `unionid` 才能把 App 与小程序认成同一个人 |
| 小程序扫码配对（`POST /auth/pair` + `claim`） | 要新写两个端点 + 两处 UI + 一条轮询链路；**产品方明确选了手机号** |
| 6 位日期码签发 token | 那个码**公开可推导**（`41`）—— 等于任何人都能算出来登录，`41` 已明确划界禁止 |

---

## 2. 身份模型：一个自然人，三种锚点

```
        User（自然人，权限的落点）
         ├── openId   ← 小程序 wx.login（W9-A，已有）
         ├── phone    ← App 登录（W9-D，新增）
         └── email    ← App 登录（W9-D，新增）
         ＋ passwordHash（App 登录的唯一验身材料）
```

★ 三者**并列**，不是三张表：`ChildMember` / `Child` / `AuditLog` 全部挂在 `User.id` 上，
拆表就会引出"到底哪个才是我"的第三个答案。`phone` / `email` 可空 ⇒
"只用微信、从不绑手机"的账号完全不受影响（迁移不写任何 UPDATE）。

**同一行 User 是这套方案成立的全部前提**：小程序里那位家长（`openId`）绑了手机号之后，
App 用该手机号登录才落到**同一个** `User`，才会看到同一个孩子。
否则 App 会走 `POST /children` 建出第二个家庭 —— 两个账号、两套积分、永不相见。

---

## 3. 端点契约

### 3.1 `POST /auth/login-account`（`@Public()`）

```jsonc
// 请求
{ "identifier": "13800138000" | "dad@example.com", "password": "…" }

// 200（与 POST /auth/login 的 LoginView 逐字段同构）
{ "token": "kps_…", "expiresAt": "…", "user": { "id": "…", "displayName": null },
  "membership": { "childId": "…", "role": "guardian" } | null }
```

| 情形 | 状态码 | code |
|---|---|---|
| 成功 | 200 | — |
| 密码错 / 账号不存在 / **从未设密码** | 401 | `ACCOUNT_INVALID_CREDENTIALS`（三者**逐字相同**） |
| 账号被停用 | 403 | `USER_NOT_ACTIVE` |
| 标识形状错 | 400 | `INVALID_IDENTIFIER`（`reason: EMPTY / TOO_LONG / PHONE_FORMAT / EMAIL_FORMAT`） |
| 超限 | 429 | `LOGIN_RATE_LIMITED`（与微信登录**共用**额度） |

### 3.2 `PUT /auth/account`（`AuthGuard`）

```jsonc
{ "phone": "138 0013 8000", "email": "Dad@Example.com",
  "password": "…", "currentPassword": "…" }   // 至少一个
// 200
{ "phone": "13800138000", "email": "dad@example.com", "hasPassword": true }
```

| 情形 | 状态码 | code |
|---|---|---|
| 成功 | 200 | — |
| 三个字段全空 | 400 | `ACCOUNT_NOTHING_TO_UPDATE` |
| 手机号 / 邮箱形状错 | 400 | `INVALID_PHONE` / `INVALID_EMAIL` |
| 已设过密码但没带 `currentPassword` | 400 | `CURRENT_PASSWORD_REQUIRED` |
| `currentPassword` 错 | 403 | `CURRENT_PASSWORD_INVALID` |
| 密码太弱 | 400 | `WEAK_PASSWORD`（`reason: TOO_SHORT / TOO_LONG / ALL_SAME / ALL_DIGITS / COMMON / SAME_AS_IDENTIFIER`） |
| 手机号/邮箱已被**别人**占用 | 409 | `IDENTIFIER_TAKEN`（`field: phone / email`） |

★ `CURRENT_PASSWORD_INVALID` 用 **403 而不是 401**：调用者是已认证的，
错的是他给的旧密码；401 会触发客户端"清 token 去登录页"，而他并不需要重新登录。

### 3.2.1 `GET /auth/account`（`AuthGuard`）—— 绑定页**必须先读**

```jsonc
// 200（与 PUT 的回包**逐字段同构**）
{ "phone": "13800138000" | null, "email": null | "dad@example.com", "hasPassword": false }
```

三个字段**全空是合法的**：它表示"这个账号还没有 App 登录账号"。

为什么必须单独有一条读路由（而不是让那一屏靠"填了再看报错"猜）：

| 不读会怎样 | 后果 |
|---|---|
| 只画一个空白手机号框 | 用户读成"我根本没绑过"，又绑一次 ⇒ 换号之后上一台手机的 App 登录再也进不来 |
| 不知道 `hasPassword` | 密码框只好一律写"设置密码"；已有密码时后端**强制**要 `currentPassword`，猜错 = 一次必然 400 的往返 + 一句看不懂的错 |

★ 两个入口共用一份 `AccountView`；三个字段全空在 **`GET` 里合法、`PUT` 里畸形**
（刚保存完不可能什么都没绑）。客户端的解析器就按这条差别分成
`AccountDto.fromReadJson()` / `fromJson()` 两个入口、共用一份 `parse()`。

### 3.3 落库的 `method`

`AUTH_METHODS` 从 `['wechat_mp','dev_seed']` 变成 `['wechat_mp','dev_seed','password']`。
白名单外的值 ⇒ 守卫 **500**（形状病），`test/auth-session-gate.test.ts` 里有一条
**专门用来拦住"随手加值"** 的用例，加值必须同时改它。

---

## 4. Schema 变更

`prisma/migrations/20261030120000_user_account/migration.sql`：

```sql
ALTER TABLE "User"
    ADD COLUMN "phone" TEXT,
    ADD COLUMN "email" TEXT,
    ADD COLUMN "passwordHash" TEXT,
    ADD COLUMN "passwordSetAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
```

四条都**可空** ⇒ 回滚就是 `DROP COLUMN`，零数据风险（同 `40` §12.1 对 `AuthSession` 的口径）。

**唯一索引与 NULL**：PostgreSQL 的唯一索引不约束 NULL，所以"一万个只用微信的用户、
`phone` 全为 NULL"不会撞键。但反过来，**唯一性必须靠应用层的规范化**才能成立 ——
`138 0013 8000` 与 `13800138000` 是两个不同的字符串，索引拦不住。
故写入与查询都走 `identity/account-identifier.ts` 一处（§6.1）。

**没有 `passwordSalt` 列**：盐写在哈希串本身
（`scrypt-pw$N$r$p$keylen$salt$hash`）。独立 salt 列在"旋转参数/迁移算法"时
多一份必须同步的状态。

---

## 5. 四条关键取舍（都写清了代价）

### 5.1 首版**不做**开放注册

`POST /auth/login-account` 查不到账号 ⇒ 401，**不会**顺手建一个。

代价：**没装小程序的家长用不了 App**。这是真实限制，不是遗漏。

收益（两条都不是理论风险）：
1. 不会产生"没有任何家庭的孤儿账号"。App 注册出来的 user 没有 `ChildMember`，
   进去只会看到 `POST /children` 引导 —— 而他其实在小程序里已经有孩子了。
2. 手机号打错一位（`13800138001`）会得到 401，而不是"悄悄给你开了个新号，
   然后你的孩子不见了"。

**将来要开放注册时的前置**：必须先有"用邀请码把新账号并入已有家庭"的引导，
否则上面第 2 条会立刻发生。

### 5.2 忘记密码 = 回小程序重设（这是"不接微信"仍能零通道的自洽解）

家长忘了 App 密码 → 打开小程序（微信自动登录，`openId` 已证明身份）→
「我的 → App 登录密码 → 重设」→ `PUT /auth/account`（已登录，无需 `currentPassword`）
→ 回 App 用新密码登录。

★ 这条闭环**不需要短信、不需要邮件、不需要客服**。它成立的唯一条件是
"这个人还能用小程序登录" —— 而这正是产品方选定的主入口。

**它不成立的场景**（写清，别当成不存在）：家长换了微信号 / 小程序被卸载且
换手机。此时他确实需要人工介入 —— 与"账号密码体系"本身的成本，不在本轮范围。

### 5.3 统一 401 而不是"分开说"

「账号不存在」「从未设密码」「密码错」共用同一个 401 与**逐字相同**的响应体
（`test/account-login-http.test.ts` 组 B 用 `assert.equal(wrong.text, missing.text)`
钉住）。手机号号段有限、邮箱可批量猜 —— 分开说就是一个**免费的枚举接口**。

配套措施：不存在的账号也会空跑一次 scrypt（`burnPasswordHashCost()`），
否则"响应快 = 这个号没注册"仍是一条侧信道。
★ 诚实标注：**这只对齐了主要成本，不是严格常数时间**（网络抖动远大于 40ms）。
它的定位是"取消那个一眼可见的差异"，不是密码学意义上的常量时间。

### 5.4 不做解绑、不做"多账号合并"

`PUT /auth/account` 只接受字符串（设置/覆盖），不接受 `null`（解绑）。
理由：解绑的唯一真实场景是"换号"，而换号必须先证明新号属于你，
提前解绑只会留下一个**谁都登不进的空窗账号**。
"同一个人两个 `User`（一个微信、一个手机号）"也不合并 —— 合并是数据迁移，
不是登录功能。

---

## 6. 三个纯函数层（都是可离线穷举的）

### 6.1 `identity/account-identifier.ts`

| 函数 | 规则 | 钉住的失败 |
|---|---|---|
| `normalizePhone` | 去空格/`-`/`()` → 剥 `+86`/`86` → `1[3-9]\d{9}` | 四种写法必须同值；`13800138000` 不能被误剥 |
| `normalizeEmail` | trim + **全小写** + 基本结构 | 不做 Gmail 点号归一（会把两个人合成一个账号） |
| `classifyIdentifier` | 含 `@` ⇒ 邮箱，否则手机号 | 不猜：`12345` 报 `PHONE_FORMAT` |
| `validatePasswordStrength` | 8–64 位、非单一字符、非纯数字、非弱口令、≠标识 | `SAME_AS_IDENTIFIER` **优先于** `ALL_DIGITS`（后者会让用户改成自己的号段） |

`identifierMessage()` / `passwordMessage()` 与规则放在同一文件：
同一条规则在登录、绑手机号、绑邮箱三处用，各写一遍必然出现三种说法。

### 6.2 `common/password-hash.ts`

格式 `scrypt-pw$<N>$<r>$<p>$<keylen>$<salt b64url>$<hash b64url>`，
N=16384 / r=8 / p=1 / keylen=32（Node 默认强度，单次 40–80ms）。

★ **前缀与 `pin-hash.ts` 的 `scrypt$` 不同，这是安全条款不是风格**：
共用前缀 ⇒ 把某个 4 位家长 PIN 的哈希抄进 `User.passwordHash`，
`verifyPassword('0000')` 就会通过。用例 `★ PIN 哈希不能当密码哈希用` 钉住它。

### 6.3 `AuthSessionPort.revokeOthers`

改密码后**踢掉其它所有会话**（`keepTokenHash` 保留当前这条）。
不这么做的后果很具体：密码泄露后攻击者已拿到 token，改密只是换了哈希，
那条 token 还能用满 7 天 —— 用户会以为"我改过了，应该没事了"。

---

## 7. 客户端

### 7.1 小程序（绑定入口）

「我的」页 → **App 登录账号** → 填手机号/邮箱 + 密码（+ 已有密码时填当前密码）→
`PUT /auth/account` → 成功后显示「已绑定 138****8000」。

★ 这一屏**必须**登录后才出现（走 `AuthGuard`）。它写的是"以后能不能登录"，
匿名可写等于任何人都能给别人的账号绑一个自己的手机号。

#### 7.1.1 那一屏的落点与四条实现纪律

| 件 | 说明 |
|---|---|
| 入口 | `pages/profile/index.tsx` 的「App 登录账号」一行（**不**按后端配置隐藏 —— App 不开放注册，藏起来就没有第二条路） |
| 面板 | `sheets/AppAccountSheet.tsx`；打开时先 `GET /auth/account`（预览模式直接给一句说明） |
| 数据层 | `auth_api.ts#fetchAccount` / `#updateAccount`、`auth_dto.ts#AccountDto.from{Read,}Json`、`account.ts`（掩码 + 预检 + 能否登） |
| 用例 | `.tmp_test/run-w9d.mjs` **14 条**（含产物里的配置注入闸门） |

① **先读再写**：没有 `GET` 就画不出「已绑定 138****8000 / 还差密码」，而这两个
结论恰恰是用户点进来的唯一目的（§3.2.1）。
② **只提交改动过的字段**：手机号框空着 ≠ 要清空手机号。JSON 里缺省 / `null` /
空串是三种意思，服务端只认"字段在不在" ⇒ "空 = 不改"必须由客户端保证。
③ **本地预检只拦一定会 400 的**：空、长度、手机号形状（`+86` / 分隔符先归一**仅用于判断**，
请求体发用户原文）。纯数字 / 常见弱口令 / 与标识相同这三条**不复制** ——
它们会随口径调整，复制一份就是两份真相；服务端的 `message` 每一支都写了下一步怎么改。
④ **明文密码只活在组件 state 里**：保存成功立刻清空，关面板即随组件卸载；
`401 ⇒ requiresLogin` 交给 store 的既有分流，`403 CURRENT_PASSWORD_INVALID`
**不**清 token（他不是要重登）。


#### 7.1.2 ★ 「小程序里看不到任何接口调用」的根因：配置注入只认**静态写法**

**现象**：点「我的 → App 登录账号」，面板写「预览模式」，微信开发者工具的 Network
面板**零请求**；换任何一屏也一样。

**根因**（不是这一屏的问题，是全端的问题）：

```ts
// 修复前：7 个文件的 defaultEnvironment() 都长这样
function defaultEnvironment(): ReadEnvironment {
  if (typeof process !== 'undefined' && process.env) return process.env  // ← 空对象
  return {}
}
```

Taro 的 `config/index.ts#env` 白名单靠 webpack `DefinePlugin` 注入，它替换的是
**整段字面量表达式** `process.env.TARO_APP_X`；而 `process.env`（整体）、
`process.env[key]`、`{ ...process.env }` 在编译后**仍是运行时的 `process.env`**，
小程序里那只是 webpack 的空 polyfill（`{}`）。

| | 结果 |
|---|---|
| `TARO_APP_KP_API_BASE_URL` | 永远 `undefined` ⇒ `AuthApiConfig.isConfigured === false` |
| `createAuthApiFromEnvironment()` / `createAccountBinderFromEnvironment()` | 恒返回 `null` |
| 面板 | 走 `binder === null` 分支 ⇒ 「没有配置后端地址」/预览文案 |
| 网络面板 | **一个请求都不发** |

★ 最坑的地方：`tsc --noEmit`、`run-w9a/w9b`、`build:weapp` **全部绿**。因为
Node 里 `process.env` 是真实的，只有**小程序运行时**才是空壳 —— 这类缺陷
只能靠**看产物**抓。

**证据**（修复前后各 grep 一次 `dist/common.js`）：

```text
修复前：function O(){return"undefined"!==typeof process&&process.env?process.env:{}}   ← 整体读
        dist 里 127.0.0.1:3000 只出现 1 次，还是错误提示文案里的示例字符串
修复后：TARO_APP_KP_API_BASE_URL:"http://127.0.0.1:3000"                                ← 编译期字面量
        整体的 process.env 读取：0 次
```

**修法**：新增 `src/data/compiled_env.ts#readCompiledEnvironment()`，**只在那里**
逐键静态书写 `process.env.TARO_APP_*`；七个 `defaultEnvironment()` 全部委托给它。

**新增一个配置键要同步三处**（缺任何一处都会静默失效）：

1. `.env.example`（文档）；
2. `config/index.ts` 的 `env` 白名单（否则 DefinePlugin 不注入）；
3. `compiled_env.ts#readCompiledEnvironment()`（否则读不到）
   + `.tmp_test/run-w9d.mjs` 的**键集合断言**（否则没人记得第 3 步）。

**回归闸门**：`run-w9d.mjs` 最后两条直接读 `dist/common.js`：
① 断言不存在整体的 `process.env` 读取；② 断言 `.env.local` 里的值以
`TARO_APP_KP_API_BASE_URL:"<值>"` 的形态出现在产物里。

★ 顺带修掉的**判据不一致**：面板原先用 `store.isLiveMode` 判断"有没有后端"，
而它要求 `baseUrl + deviceId + childId` **三项齐全**；绑定账号只需要 `baseUrl`
（Bearer 已足够）。两者不一致时会出现「界面说预览模式，请求其实发出去了」——
结果被文案挡住，用户同样读成"没接"。现在统一以 `binder === null` 为唯一判据。


### 7.2 Flutter（本轮）

| 部件 | 做法 |
|---|---|
| `lib/data/token_store.dart` | `TokenStore` 抽象 + `MemoryTokenStore`（测试）+ `FileTokenStore`（`dart:io` 写缓存目录） |
| `lib/data/auth_api.dart` | `loginAccount()` / `updateAccount()` / `logout()` / `session()` |
| `lib/screens/login_screen.dart` | 手机号/邮箱 + 密码，一个输入框（分类交给服务端） |
| `lib/screens/account_gate.dart` | 有 token ⇒ 放行；没有 ⇒ 登录页；**未配置后端 ⇒ 直接放行**（预览模式） |
| 四个客户端 | 构造时可注入 `tokenProvider`，`_send` 里拼 `Authorization: Bearer …` |

### 7.2.1 为什么 token 存"缓存目录"而不是加 `shared_preferences`

`README.md:19` 把这条写成硬约束：**不引入 `shared_preferences`，`flutter pub get`
在离线环境也能通过**。加它要联网 `pub get` + Android/iOS 平台配置，
而它换来的只是"换个目录"。

⇒ `FileTokenStore` 用 `Directory.systemTemp`（Android 上是应用缓存目录，
iOS 上是 `tmp`）。**代价写清**：系统清缓存 / 用户清数据 ⇒ token 丢失 ⇒
需要重新输入密码。这与"7 天绝对过期"的既有口径同一量级，
故不构成体验回归。

将来若要真正持久，只需换 `TokenStore` 一个实现（加 `shared_preferences`），
上层一行不用改 —— 这是把"依赖决策"关在一个类里的收益。

### 7.2.2 401 三分流（与小程序同一条口径）

| 服务端 | 客户端动作 |
|---|---|
| `TOKEN_EXPIRED` | **静默重登一次**（用存着的手机号/密码？→ 见 §9 第 2 条） |
| `TOKEN_INVALID` | 清 token → 登录页 |
| 网络 / 5xx | **保住 token**，不跳登录页 |

---

## 8. 落地状态

| 层 | 状态 | 证据 |
|---|---|---|
| Schema + 迁移 | ✅ | `prisma validate` 通过；`prisma/migrations/20261030120000_user_account/` |
| 纯函数（标识 / 密码 / 哈希） | ✅ | `test/account-login-unit.test.ts` **20 条** |
| 端口 + Prisma 适配器 | ✅ | `readAccountByIdentifier` / `readAccount` / `issueSession` / `writeAccount` / `revokeOthers` |
| Service + Controller | ✅ | `GET /auth/account`、`POST /auth/login-account`、`PUT /auth/account` |
| HTTP 端到端 | ✅ | `test/account-login-http.test.ts` **24 条**（含 token 真的过守卫、`GET` 的三种绑定形态） |
| 回归 | ✅ | `npm test` **58 文件 / 1099 用例 / 0 失败** |
| 小程序数据层 | ✅ | `auth_api.ts#fetchAccount` / `#updateAccount`、`AccountDto.from{Read,}Json`、`account.ts`（掩码 + 预检 + `accountLoginReady`） |
| 小程序**绑定页 UI** | ✅ | `sheets/AppAccountSheet.tsx` + 「我的 → App 登录账号」入口（§7.1.1）；`taro build --type weapp` 通过 |
| 小程序绑定页用例 | ✅ | `.tmp_test/run-w9d.mjs` **14 条**（GET/PUT 两个入口的差别、只发改动字段、空 token 不发请求、**产物里的配置注入**） |
| ★ 环境变量注入（跨阶段缺陷） | ✅ | 7 处 `defaultEnvironment()` 曾整体读 `process.env`（小程序里是空 polyfill）⇒ 客户端全为 `null`、全端静默停在预览模式；改走 `compiled_env.ts`，见 §7.1.2 |
| Flutter token 存储 / 登录页 / 闸门 / Bearer | ✅ | `token_store.dart`、`auth_api.dart`、`auth_dto.dart`、`login_screen.dart`、`account_gate.dart`，五个客户端的可选 `tokenProvider` |
| Flutter 用例 | ✅ | `test/account_login_test.dart` **17 条**；`flutter test` 全量 **415 条**、`dart analyze lib test` 0 issue |
| 真库用例（`P2002 ⇒ 409`、`UPDATE … RETURNING` 原子性） | ❌ 未写 | 需要活库，`npm run test:db` 环境 |

---

## 9. 未做清单（**每一条都是明确取舍，不是漏了**）

1. **开放注册**（`POST /auth/register`）—— 见 §5.1，前置是"邀请码并入家庭"。
2. **App 侧静默重登**：`TOKEN_EXPIRED` 时若要重登，客户端必须持有密码
   （或一个长期 refresher）。**把密码存在设备上是负收益** ——
   等于把"7 天 token 泄露"升级成"永久密码泄露"。
   ⇒ 本轮口径：`TOKEN_EXPIRED` 直接回登录页并提示"登录已过期，请重新输入密码"。
   这比"偷偷替你登"更诚实。
3. **解绑手机号/邮箱**（§5.4）。
4. **多账号合并 / 自然人注销**（`40` §2 已有的非目标）。
5. **按 IP 的失败计数锁账号**（PIN 有 `pinFailedCount`，账号侧只有
   进程内限流器 `LoginRateLimiter`；多实例部署时额度 × 实例数）。
6. **OTP 通道**（短信 / 邮件）—— 本轮完全不碰，故也没有服务商依赖。
7. **真机走查**（小程序绑定页 + App 登录页）。

---

## 10. 复现命令

```bash
cd backend
npx prisma validate                 # schema 合法
npx prisma generate                 # 让 TS 认识 phone/email/passwordHash
npm run typecheck                   # src
npm run typecheck:tests             # test + test-db
npm test                            # 58 文件 / 1099 用例
```

只跑本阶段的两组：

```bash
cd backend
npx tsc -p tsconfig.test.build.json
node --test .tmp_test_build/test/account-login-unit.test.js
node --test .tmp_test_build/test/account-login-http.test.js
```

小程序侧（绑定页那一屏）：

```bash
cd kids_points_mp
./node_modules/.bin/tsc -p .tmp_test/tsconfig.test.json   # 编译到 .tmp_test/dist
node .tmp_test/run-w9d.mjs                                # 14 条
npx taro build --type weapp                               # 产物里要能 grep 到 fetchAccount
```



