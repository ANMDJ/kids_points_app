# 40 · 登录与会话（身份层的最后一块）· **设计稿（待评审）**

> **状态：设计稿 · 一行代码都没写**（2026-10-29）。
> 本文只定**形状**与**取舍**，不含实现；落地顺序见 §13，**需要你先裁定的 7 件事在 §14**。
>
> **触发点**：L2 已于 2026-10-29 解除（正式 AppID ＋ **有效** AppSecret，见 `05` §6 / `PRD` §12）。
> 凭据只是**外部前置**；`code2session → 会话 token` 这条链路今天**一段都没有**
> （`grep -rn WECHAT_MP backend/src` 为空）。

---

## 0. 一页结论

| 问题 | 结论 | 为什么（一句话） |
|---|---|---|
| 客户端拿什么凭据 | **不透明随机 token**（32 字节，库里只存 `sha256`），**不用 JWT** | 撤销/降级本来就要查库，JWT 的无状态优势在本项目归零（§4） |
| 存哪张表 | **新增 `AuthSession`**，不复用 `DeviceSession` | 登录发生在"选哪个孩子"**之前**，而 `DeviceSession` 的唯一键是 `(deviceId, childId)`（§5） |
| openid 怎么落 | `User.openId`（已有、已 `@unique`）＋ 原子 upsert | 列已经在了，缺的只是"谁来写"（§6） |
| 新用户怎么建家庭 | **新增 `POST /children`** | 仓库里**没有** `model Family`，"家庭"＝一个 `Child` 档案（§7） |
| Flutter 端怎么登录 | **本轮不接**（无微信 SDK） | 微信开放平台那条要 **1–2 周审核**；另一条"不需要等待"的（扫码配对）是新凭据链路，值得单独一轮（§10） |
| 生产 503 闸门 | 换成真 `401`，**并有用例钉住"生产不再 503"** | 否则"能上线"永远只是注释里的一句话（§9） |

**本期不做**：找回 PIN、注销账号（自然人级）、多设备会话管理 UI、`unionid`、短信通道、真机走查。

---

## 1. 事实核查（全部来自当前代码，可直接复核）

### 1.1 凭据已就位，但**没有任何代码读它**

| 证据 | 位置 |
|---|---|
| 正式 AppID 已进工程配置 | `kids_points_mp/project.config.json:5` → `"appid": "wx40666b1cbd5907c0"` |
| AppID / AppSecret 进环境变量（**不入库**） | `backend/.env`（被 `backend/.gitignore:12` 忽略）、模板 `backend/.env.example` |
| 有效性**实测过**，不是"填好了" | 拿假 `js_code` 打 `sns/jscode2session`：有效凭据 ⇒ `40029 invalid code`；`.env` 里原来那份 ⇒ `40125 invalid appsecret`（早已失效，2026-10-29 已替换） |
| **零引用** | `grep -rn 'WECHAT_MP' backend/src` ⇒ 空 |

> 「配好了」≠「接上了」。这一条是本文档存在的原因。

### 1.2 身份链路今天的样子

`DeviceSessionGuard`（`backend/src/device-session/device-session.guard.ts`）读两个头：

| 头 | 常量 | 语义 |
|---|---|---|
| `x-kp-device-id` | `DEVICE_ID_HEADER`（L37） | **客户端自报**的设备 id（今天的"凭据"） |
| `x-kp-child-id` | `CHILD_ID_HEADER`（L49） | 选择器：会话作用在哪个孩子上 |

四处 fail-closed：缺头 ⇒ 401；查不到会话 ⇒ 401 `SESSION_NOT_FOUND`；行形状坏 ⇒ 500；
**`NODE_ENV === 'production'` ⇒ 503 `IDENTITY_NOT_IMPLEMENTED`**（L110）。

### 1.3 ★ 主论点：`DeviceSession` 今天同时承担了两件不同的事

| 同一列 | 语义 A（身份） | 语义 B（家长模式窗口） |
|---|---|---|
| `expiresAt` | 邀请码加入时写 **30 天**（`src/invites/invite-code.ts:49` `INVITE_SESSION_TTL_MS`） | 进家长模式时写 **5 分钟**（`02` §7，`auth.service.ts`） |
| `activeRole` | 这个人的角色 | 这 5 分钟里是不是家长 |

**这不是"设计得巧"，是"一列两个语义"**，代价已经在 W8-C 付过一次：
`parent-mode.policy.ts#parentModeSourceOf()` 只能**靠算术猜**"这 5 分钟是 PIN 换的还是邀请码给的"
（`expiresAt − now > TTL` ⇒ `session`，否则 `pin`），并且 §7 ⑥ 只能写明"**不落库**"——
不是不想落，是**没有地方可落**（多存一列只会多一个能与之打架的字段）。

登录链路会把这件事推到极限：**登录拿到的凭据是跨孩子的、跨设备的、且与"家长模式"无关**。
把它塞进一张按 `(deviceId, childId)` 切分、且 `expiresAt` 已被家长模式占用的表，是行不通的（§5.1）。

### 1.4 没有 `POST /children`，也没有 `Family` 表

- `backend/src/**` 里 `@Controller(...)` 共 **17 个**（`records` 有两个控制器）：`approvals / auth / child / consent /
  device-tokens / export / family-deletion / habits / invites / members / notifications / onboarding /
  point-rules / records(×2) / trash / wishes` —— **没有** `families`，**也没有** `me`。
- `prisma/schema.prisma` 里**没有** `model Family`："家庭"在产品语言里等于**一个 `Child` 档案**
  （连 `FamilyDeletionRequest` 也是按 `childId` 收口）。
- 因此孩子只能由两处产生：`prisma/seed/**`（演示）与 `invites`（加入**已有**孩子）。
  **"第一个家长从零建一个孩子"这件事，今天没有入口。**

### 1.5 ★ 零孩子用户过不了同意闸门（循环依赖）

`POST /consent` 挂着 `DeviceSessionGuard`（`src/consent/consent.controller.ts:47,57`），
`childId` **只**来自会话 ⇒ 一个刚登录、还没有孩子的用户**无法同意**；
而 `POST /children` 若要求"先同意再建孩子"就死锁。§7.3 给出唯一不违反 `04` §5 的解法。

### 1.6 客户端凭据是**编译期常量**，且**不持久化**

| 端 | 今天 | 位置 |
|---|---|---|
| Flutter | `--dart-define=KP_DEVICE_ID/KP_CHILD_ID` | `lib/data/read_api.dart:14-15, 36-40` |
| 小程序 | `TARO_APP_KP_DEVICE_ID/TARO_APP_KP_CHILD_ID` | `kids_points_mp/src/data/read_api.ts:82` |
| 小程序 state | **只在内存**（重启即失） | `kids_points_mp/src/data/store.ts:157` 明写"要落地持久化时只需在 `persist` 里接入 `Taro.setStorageSync`" |

⇒ 登录链路对客户端意味着**两个新能力**：① 运行期拿到凭据；② 把它安全地存下来。

---

## 2. 目标 / 非目标

**目标（本期验收的口径）**

1. `NODE_ENV=production` 下**能安全地认出一个自然人**：凭据不可伪造、可撤销、可过期；
2. 全新设备从零走通：**登录 → 建/加入家庭 → 引导 → 用**（今天只有"加入"这一段）；
3. **离线可测**：CI 不依赖外网、不依赖真实 `js_code`（否则这条链路永远只有手工证据）；
4. 每一个"能做到"都有**可失败的用例**（§13 每步的退出判据）。

**非目标（明确不做，免得被当成漏了）**

- 找回家长 PIN（`02` §7 至今未定义，见 §7 的 W8-C 落地注）；
- 自然人注销 / 账号合并；
- 多设备会话管理界面（"踢掉另一台设备"）；
- `unionid` / 开放平台打通（§6.3 记为已知缺口）；
- Flutter 端微信登录（§10 单列，且**不是本轮**）；
- 限流器本体（属部署基础设施，§11 记为前置依赖，不在本设计内实现）。

---

## 3. 分层：**认证 ≠ 授权上下文**（整个设计的骨架）

```
请求
 │  Authorization: Bearer kps_xxx          ← 认证（你是谁），跨孩子、跨设备
 ▼
AuthGuard ──► req.kpUser = { userId, authSessionId }
 │  x-kp-child-id                          ← 选择器（在哪个孩子的档案上）
 ▼
DeviceSessionGuard ──► req.kpActor = { userId, role } ＋ req.kpChildId
 │                                       ← 授权上下文（这台设备、这个孩子、什么角色）
 ▼
MembershipGuard（成员位）→ PermissionsGuard（矩阵）→ ConsentGuard（同意）
```

**两层会话回答两个不同问题，且生命周期差 3 个数量级：**

| 概念 | 表 | 回答 | 建议 TTL | 到期后果 |
|---|---|---|---|---|
| 认证会话 | **`AuthSession`（新）** | "你是谁" | 7 天（绝对，见 §4.3） | **401** ⇒ 客户端静默重登 |
| 设备×孩子上下文 | `DeviceSession`（现有） | "这台设备在这个孩子上是谁、什么角色" | 30 天（邀请）/ 引导期 | **401**（绑定失效） |
| 家长模式窗口 | `DeviceSession.activeRole` + `expiresAt` | "此刻是不是家长" | 5 分钟 | **回落 `child`**（降级，**不是** 401） |

> ★ 第三行的"到期不是错误"是 `02` §9.19 已定的口径（孩子不能因为家长窗口过期就连自己的积分都看不了）。
> 它与第一行**必须**分开写，否则"过期"会在两种含义之间摇摆 —— 那正是今天 `modeSource` 要做算术的原因。

---

## 4. D1 · 凭据形态：**不透明 token**（`sha256` 落库），**明确拒绝 JWT**

### 4.1 形状

```
kps_<base64url(32 随机字节)>      例：kps_7Qm2…（总长 4 + 43 = 47 字符）
```

- 前缀 `kps_`：让 token 在**日志 / 密钥扫描 / 粘贴事故**里一眼可识别（同 `ghp_` / `sk-` 的用意）；
- 库里只存 `tokenHash = sha256(token)` 的 64 位十六进制，**明文只在登录响应里出现一次**；
- 校验 = `findFirst({ tokenHash, revokedAt: null, expiresAt: { gt: now } })` —— 一次索引查询。

### 4.2 为什么 `sha256` 而不是 `scrypt`（与 PIN 相反，理由必须写清）

| | PIN | token |
|---|---|---|
| 熵 | 4–6 位数字 ⇒ **13–20 bit**，可离线穷举 | 32 字节 ⇒ **256 bit**，不可穷举 |
| 威胁 | 库被读走 ⇒ 穷举出 PIN | 库被读走 ⇒ 已无法反推 token |
| 对策 | **慢哈希**（scrypt）＋ 失败计数 ＋ 锁定（已在 `ChildMember` 上） | 快哈希足够；慢哈希只会让**每个请求**多 30ms CPU |

⇒ 「按熵选算法」：低熵凭据配慢哈希与锁定，高熵凭据配快哈希。**给 token 套 scrypt 是负收益**。

### 4.3 为什么是 7 天绝对到期，而不是"滑动 30 天"

- **`wx.login` 是静默的**：不弹窗、不需要用户任何动作 ⇒ "过期就重新登录"的成本≈0。
  这是移动端可以做短 TTL 的前提，也是本项目**不需要**长寿命 token 的根本原因。
- 滑动窗口（每次使用延长）会让"手机丢了 / 家长换了设备"的凭据**无限期活着**，
  而撤销只能靠人工点"退出登录" —— 一条**没人会点**的路径。
- `lastSeenAt` 仍然更新，但它只回答"这台设备还活着吗"（运营/审计用），**不参与过期判定**。
  ⚠️ 把 `lastSeenAt` 顺手拿去延长 `expiresAt` 是本设计最容易发生的退化，故在字段注释里钉死。

### 4.4 为什么**不用** JWT（四条，都是本项目的具体处境）

1. **撤销只能靠另建一张表**：成员被移出、家长换手机、token 泄露 —— 全部需要"立刻失效"。
   JWT 的解药是 revocation list，而那就是一次 DB 查询 ⇒ **无状态优势归零**，只剩复杂度。
2. **省不掉 IO**：`MembershipGuard` 每个请求都要查 `ChildMember`，`DeviceSessionGuard` 要查 `DeviceSession`。
   多一次 `AuthSession` 查询不是瓶颈；而 JWT 省下的那一次，换来的是"角色可能过期但 token 仍有效"的空白地带。
3. **密钥轮换是整套运维**（`kid` / 双密钥并存 / 提前发布），而本项目**连 CI 都还没接**（`README` 待办）。
4. **本仓库的失败模式是"静默信任"**：`exp` 的边界写成 `>` 还是 `>=`、`NaN` 比较恒 false……
   这类错在 JWT 里**没人替你查**（`02` §9.19 专门为 `expiresAt === now` 定过口径）。
   不透明 token **什么都不声称**，一切以库为准 —— 与 `session.gate.ts` "形状与判定分开"同一条纪律。

> 备选记录：若将来出现"跨服务调用"（本仓库目前是单体 + 4 个进程内 worker），再议 JWT。
> 那时的正确做法是 **JWT 只做服务间凭据**，面向客户端的仍是本设计的不透明 token。

### 4.5 撤销语义（三种情形，答案不同）

| 情形 | token 是否失效 | 用户看到什么 |
|---|---|---|
| `POST /auth/logout` | ✅ `revokedAt = now` | 立刻回登录页 |
| 到期（7 天） | ✅ 自然失效 | 401 `TOKEN_EXPIRED` ⇒ **静默重登** |
| **被移出家庭 / 降级** | ❌ **不吊销** | 仍能登录，但后续请求 **403**（`MEMBER_REMOVED` / 矩阵 DENY） |

第三行与 W5-H「移出不删 `DeviceSession`」**同一条理由**：把"你被移出"伪装成"你没登录"，
会让用户在一个**永远不会成功**的登录页上反复重试（而解药只是"去找家长要个新码"）。

---

## 5. D2 · 数据模型：**新增 `AuthSession`**，不给 `DeviceSession` 加列

### 5.1 为什么不能复用 `DeviceSession`（三条，任一条都足以否决）

1. **唯一键位置不对**：`@@unique([deviceId, childId])`。登录时**还没有** `childId`
   （一个家长可能有两个孩子，且登录发生在"选孩子"之前）。硬塞就得把 `childId` 变可空
   ⇒ 拆唯一约束 ⇒ `membership` / `auth` / `session.gate` 全线要处理"没有孩子的行" ⇒ **比新建一张表贵得多**。
2. **`deviceId` 是客户端自报的**，把它做成凭据的一半，正是今天 503 的根因。
   新表里 `deviceId` **只进审计**，不参与任何判定。
3. **一列两语义**（§1.3）：`activeRole` + `expiresAt` 已经是家长模式窗口，
   再塞一个"身份到期"就回到今天这个补丁状态。

### 5.2 提议的表（形状，非最终迁移）

```prisma
/// 认证会话（W9-A 提议）：**"你是谁"**，与 DeviceSession（"你在哪个孩子上是什么角色"）分开。
model AuthSession {
  id            String   @id @default(cuid())
  userId        String

  /// sha256(token) 的十六进制（64 字符）。**明文只在登录响应里出现一次，绝不落库**。
  /// ★ 与 ChildMember.pinHash 的 scrypt 不同：token 是 256 bit 随机数，慢哈希是负收益（§4.2）。
  tokenHash     String   @unique

  /// 认证方式白名单：wechat_mp | dev_seed（后者仅非生产，§12）。
  /// ★ 用 String + 应用层白名单，**不建 PG 枚举** —— 理由见 5.2.1。
  method        String

  /// 签发时客户端自报的设备标识：**只进审计，不参与任何判定**（§5.1 第 2 条）。
  deviceId      String?

  issuedAt      DateTime @default(now())
  /// 只回答"这台设备还活着吗"，**不参与过期判定**（§4.3）。
  lastSeenAt    DateTime @default(now())
  /// 绝对到期：**不因使用而延长**。
  expiresAt     DateTime

  revokedAt     DateTime?
  revokedReason String?

  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, revokedAt])
  @@index([expiresAt])
}
```

另需在 `User` 上加一行反向关系：`authSessions AuthSession[]`。

#### 5.2.1 为什么 `method` 不做成 PG 枚举

本仓库为 `RelationKind` 付过代价：枚举值要在**三处**逐字一致（schema / 迁移 DDL / 注释），
靠 `npm run relation:check` 逐字比对。`method` 只有 2 个值、只被服务端写、且**永不出现在权限判定里**，
让它进枚举是"为一致性付闸门成本"。改用 `String` + 一个 `AUTH_METHODS` 白名单：
读到白名单外的值 ⇒ **500**（形状问题，与 `session.gate.ts#INVALID_SESSION_ROLE` 同一口径），
不是 401、更不是默默当成 `wechat_mp`。

### 5.3 两个 `expiresAt` 的边界（写死在一处，别在调用处各自理解）

| 表.列 | 到期判定 | 到期后果 | 唯一定义点 |
|---|---|---|---|
| `AuthSession.expiresAt` | `now >= expiresAt` **即过期**（`===` 算过期） | 401 `TOKEN_EXPIRED` | 新内核 `auth-session.gate.ts` |
| `DeviceSession.expiresAt` | 同上（已定） | `guardian` 回落 `child` | `session.gate.ts#isSessionActive` |

> 两处**都**要写用例钉住 `===` 的边界（`test/session-gate.test.ts` 已有先例）。
> 口径必须一致：一处说"到期时刻还算有效"、另一处说"不算"，会让"刚好第 7 天"变成随机行为。

### 5.4 备选方案 B（给 `DeviceSession` 加列）与它的成本

```
+ tokenHash         String?   @unique
+ identityExpiresAt DateTime?          // 与 expiresAt 分工
~ expiresAt 语义收窄为"家长模式窗口"
```

- **代价 1**：`(deviceId, childId)` 唯一键要求"登录时先知道 childId" ⇒ 登录接口要么强制传 `childId`
  （家长在没选孩子前无法登录），要么把 `childId` 变可空（§5.1 第 1 条）。
- **代价 2**：一次登录会有 **N 行**（每个孩子一行）⇒ token 重复存 N 份，撤销要"改 N 行"
  （漏一行就是幽灵凭据）。
- **代价 3**：`activeRole` / `expiresAt` 的既有读路径（`session.gate` / `auth.service` / 三端 DTO）
  全都要重新解释一遍语义 —— 而 W8-C 刚把这套契约（`modeSource`）在**三端**对齐过。
- **结论**：❌ 不选。**B 省下一张表，付出的是三类热点逻辑的重解释。**

### 5.5 顺带解决一个历史包袱：`modeSource` 的第三个取值

引导期的家长会话（§7.5）会暴露 `modeSource` 的一个漏洞：

- 引导期 `activeRole='guardian'`、窗口 5 分钟，而 `ChildMember.pinHash` **还是 `null`**（PIN 在引导第⑤步才设）；
- `parentModeSourceOf()` 现在只按"窗口长度"判 ⇒ 会把这段**没有 PIN 的** 5 分钟画成 `pin`
  ⇒ 客户端显示"用 PIN 换的 5 分钟家长模式"，而用户根本没输过 PIN（也还没有 PIN 可输）。

**提议（不新增列）**：给 `parentModeSourceOf()` 补一个入参 `hasPin: boolean`，值域扩为
`'pin' | 'session' | 'bootstrap' | null`：

```
不在家长模式（activeRole !== guardian 或已过期）      ⇒ null
窗口 > PARENT_MODE_TTL_MS（邀请码/登录带来的长窗口）   ⇒ 'session'
窗口 ≤ TTL 且 pinHash === null（引导期，还没有 PIN）   ⇒ 'bootstrap'
其它                                                 ⇒ 'pin'
```

三端 DTO 只需把 `bootstrap` 并入"≤300 秒"的合法区间（现有 `pin ⇒ 1..300` 的校验正好适用），
**不需要改区间**，只需放行第三个枚举值。⚠️ 这是**跨端契约变更**，必须三端 + 两侧用例一起改
（W8-C 的教训：只改服务端会让客户端把合法数据判成"数据格式不符合预期"）。

---

## 6. D3 · `openid` ↔ `User` 映射

### 6.1 落点：`User.openId`（已存在、已 `@unique`、**可空**）

`prisma/schema.prisma:221` 的注释写着"L2（主体认证）完成前可能为空"—— 那句注释在本次落地后**作废**，
应改为"由 `POST /auth/login` 写入；`null` 只出现在历史/演示数据里"。

### 6.2 并发：一次原子 upsert，不"先查后写"

```
upsert({ where: { openId }, create: { openId, displayName: null }, update: {} })
```

- 理由：同一家长在两台设备上同时首次登录是**正常动作**（不是攻击），
  「先 `findUnique` 再 `create`」在 READ COMMITTED 下会双双看到 `null` ⇒ 第二个 `INSERT` 撞唯一键 ⇒ 500。
  本仓库在 W5-H 已经吃过同族的亏（"先查后写"必须换成锁或单条条件语句）。
- Prisma 在 PostgreSQL 上会把这种 upsert 编译成**单条 `INSERT … ON CONFLICT`**，
  但这是**实现细节**，不能只写在注释里 ⇒ 必须有一条**真库并发用例**（§13 S6）：
  `Promise.all([login(openid X), login(openid X)])` ⇒ `User` 恰好 **1 行**，两次都 200。
- `displayName`：微信 `code2session` **不返回**昵称/头像（要 `getUserProfile`，且已收紧）。
  ⇒ 新用户 `displayName = null`，由引导第②步的昵称或后续设置页补齐。**不要**用 `'微信用户'` 之类的假数据填充
  （那会让"这个孩子是谁家的"在成员列表里不可分辨）。

### 6.3 三个已知缺口（写清，不偷偷绕过）

| 缺口 | 现状 | 建议 |
|---|---|---|
| `unionid` 无列 | schema 里只有 `openId` | **本轮不加**：只有一个小程序，`openid` 足够；接 Flutter 微信登录时再加列 + 回填（`§10 B`） |
| `openId` 与 AppID 绑定 | 换 AppID ⇒ 所有 openid 全变 ⇒ 老用户"消失" | 本项目**尚未上线**，代价为 0；上线后若要换主体，必须先导出 `openid` 做迁移映射 |
| `session_key` | 微信每次登录都会返回 | **绝不落库、绝不返回客户端**：本项目不解密用户信息，存它就是存一份可解密的密钥 |

---

## 7. D4 · 新用户 bootstrap：`POST /children`

### 7.1 为什么必须有它（三个事实叠出来的死角）

1. 没有建孩子的端点（§1.4）；
2. `POST /consent` 要 `childId`，而 `childId` 只来自会话（§1.5）；
3. `POST /onboarding/complete` 要 **guardian** 成员位（矩阵 `apply_onboarding`）。

⇒ 一个全新用户登录后：不能同意、不能引导、不能建孩子。**这三条是同一个洞。**

### 7.2 命名：**`POST /children` 而不是 `POST /families`**

仓库里**没有** `Family` 模型，"家庭"是产品语言，落地单位是 `Child`
（`FamilyDeletionRequest` 也是按 `childId` 收口）。叫 `/families` 会让下一个人去找一张不存在的表。
UI 文案继续叫"家庭"没问题，**接口叫它真实的东西**。

### 7.3 同意先行：解法是"**先建壳，后采集**"（两步）

`04` §5 的硬约束是"同意必须**早于**采集昵称"，而我们要在**同一次请求**里建孩子 + 记同意 ——
事务内的语句顺序（先写 `GuardianConsent` 再写 `Child`）**不能替代** UI 顺序：
用户在同一屏里既勾选又填了昵称，那仍然是"先采集后征求"（只是时间差了几十毫秒）。

**推荐流程（两步，且第二步已存在）**：

```
① POST /children   body: { consent: { accepted: true } }            ← 只带同意，不带任何孩子信息
                   → 事务：GuardianConsent + Child(name='宝贝', onboardedAt=null)
                          + ChildMember(guardian) + UserChildRelation + DeviceSession + AuditLog
② PATCH  /child    body: { name: '小明' }                            ← 已存在（W5-E），guardian 专属
```

- 服务端对 ① 的校验：`consent.accepted` 必须**字面 `true`**（缺 / `false` / 字符串 `"true"` 一律 400
  `CONSENT_NOT_ACCEPTED` —— 与 W7-D 的 `{confirmed:true}` 同一口径）；
  版本号由服务端 `CONSENT_TEXT_VERSION` 给出，**客户端不能自报**（已有纪律）。
- 占位名 `'宝贝'` 的代价：用户中途退出会留下一个叫"宝贝"的档案。**缓解**：`onboardedAt = null`
  已经是"未完成引导"的权威标记，前端会强制回到引导（`OnboardingGate` 只在 `onboarded:false` 时拦）。
  ⚠️ 别把它做成"隐藏的脏数据"：`GET /auth/session` 返回的孩子名就是真实值，客户端照实显示。
- **备选（不推荐）**：`POST /children` 也接受 `childName` ⇒ 少一次请求，但把"先同意后采集"变成一句口号。

### 7.4 事务边界（7 步，同一 `$transaction`）

| # | 写什么 | 为什么在这一步 |
|---|---|---|
| 1 | 读 `AuthSession` → `userId` | 身份**只**来自 Bearer token，绝不从 body 取 |
| 2 | 查该 user 的 `ChildMember`（`status=active`） | 首版**一人一家庭**（§14 Q3）；已有 ⇒ 409 `CHILD_LIMIT_REACHED` |
| 3 | `GuardianConsent`（`consentVersion` 服务端给、`ipHash/userAgentHash` 只存 HMAC） | 合规：同意记录必须**先于**任何儿童字段落库 |
| 4 | `Child`（`name='宝贝'`、`onboardedAt=null`、`pointsBalance=0`） | 余额初值 0，账本同源（`01` §4） |
| 5 | `ChildMember`（`role=guardian`、`status=active`、`pinHash=null`） | 屏障一的唯一入口（`02` §1） |
| 6 | `UserChildRelation`（`relation` 取 body 的 `relation`，缺省 `other`） | 与成员位**不是**同一件事（§1 明确：只作监护关系记录） |
| 7 | `DeviceSession`（`activeRole='guardian'`、`expiresAt=now+5min`）＋ `AuditLog`（`action:'child.create'`） | 引导期需要家长权限（§7.5） |

**为什么不在这一步写规则/习惯**：引导第⑤步采纳模板是 `POST /onboarding/complete` 的事
（已有 18 条模板 + 幂等语义），提前写会让"用户中途退出"留下半套规则。

### 7.5 首个会话的角色：`guardian` + **5 分钟窗口**（且没有 PIN）

- 引导全程 ≤ 90 秒（`04` §2 的目标），5 分钟足够；
- 但**必须**顺带把 `02` §7 那条"每次 guardian 操作刷新 TTL"落地（W8-C 只做了进入时那一次）——
  否则用户在引导第⑤步（采纳 18 条模板 + 设 PIN）时窗口刚好过期 ⇒ `apply_onboarding` **403**
  ⇒ 表现为"引导坏了"，而实际是权限按设计降级。**这条不做，§7 的整条流程会在真机上随机失败。**
- `pinHash === null` 期间的 `modeSource` 必须是 `bootstrap`，否则客户端会把这段窗口画成"PIN 换的"（§5.5）。
- 设 PIN 之后（`POST /onboarding/complete` 内），后续进入家长模式一律走 PIN。

### 7.6 这条路由**没有**三道屏障（必须在代码注释里写清）

`POST /children` 只挂 `AuthGuard`：

| 屏障 | 为什么此刻无意义 |
|---|---|
| 成员资格（`MembershipGuard`） | 用户**按定义**还不是任何孩子的成员 —— 这正是它的用途（与 `POST /invites/accept` 同一条理由） |
| 权限矩阵（`PermissionsGuard`） | 矩阵描述"成员对某孩子的操作"，没有孩子就没有列可查 |
| 同意闸门（`ConsentGuard`） | 这道路由**本身就是**建立同意的那一步 |
| `Idempotency-Key` | 不需要：重复提交会命中 409 `CHILD_LIMIT_REACHED`（构造幂等），缓存反而掩盖"我已经建过了" |

⇒ 全仓库**第二条**没有三道屏障的路由（第一条是 `POST /invites/accept`，`02` §8）。
这类例外必须**显式点名 + 说明判据**，否则下一个人会以为"是不是漏挂了 Guard"。

---

## 8. D5 · 端点契约（5 条新路由）

### 8.1 一览

| 方法 | 路径 | 守卫 | 请求体 | 响应 | 主要错误 |
|---|---|---|---|---|---|
| `POST` | `/auth/login` | **无**（见 8.2） | `{ code }` | `{ token, expiresAt, user:{id, displayName}, membership:{childId, role} \| null }` | 401 `WECHAT_CODE_INVALID` / 502 `WECHAT_UNAVAILABLE` / 503 `WECHAT_NOT_CONFIGURED` / 429 `LOGIN_RATE_LIMITED` |
| `POST` | `/auth/logout` | `AuthGuard` | 无 | `204` | 401 |
| `GET` | `/auth/session` | `AuthGuard` | — | `{ user, expiresAt, children:[{ childId, name, role }] }` | 401 |
| `POST` | `/children` | `AuthGuard` | `{ consent:{accepted:true}, relation? }` | `200 { childId, role, parentModeUntil, modeSource:'bootstrap' }` | 400 `CONSENT_NOT_ACCEPTED` / 409 `CHILD_LIMIT_REACHED` |
| `POST` | `/auth/child-session` | `AuthGuard` | `{ childId }` | `200 { childId, role, sessionExpiresAt }` | 403 `NOT_A_MEMBER` |

### 8.2 `POST /auth/login` 为什么**只能**是没有守卫的裸路由

它要**签发**凭据，所以**不能**要求凭据 —— 这与 `POST /invites/accept` 需要身份屏障的情形不同：
那里至少"你已经是谁"是已知的。于是授权判据只能是"**持有微信签发的一次性 `code`**"：

| 防线 | 谁提供 | 服务端是否要自己再做 |
|---|---|---|
| `code` 一次性 / 5 分钟有效 / 绑定 AppID | 微信 | ❌ 不可重复使用由微信保证（二次使用返回 `40163 code been used`） |
| 频率限制 | **本服务端（没有）** | ✅ **必须**（§11.1）—— 否则这个端点就是"免费的 openid 探测 + 资源消耗"入口 |

错误码映射（**逐条**来自微信文档，不要凭直觉）：

| 微信 `errcode` | 我们的响应 | 客户端该做什么 |
|---|---|---|
| `40029` invalid code | 401 `WECHAT_CODE_INVALID` | 重新 `wx.login()` 后再试**一次**（第二次仍失败 ⇒ 展示"登录失败，请重试"） |
| `40163` code been used | 401 `WECHAT_CODE_INVALID` | 同上 |
| `45011` 频率限制 | 429 `LOGIN_RATE_LIMITED` | 退避，**不要**自动重试 |
| `40125` invalid appsecret / `40013` invalid appid | 500 `WECHAT_CREDENTIAL_INVALID` | **不是用户的问题**：告警给运维（这是配置坏了，不该让用户看到"重试"） |
| 网络超时 / 非 JSON | 502 `WECHAT_UNAVAILABLE` | 退避重试 |

> ★ 最后两行是**最容易做错**的一处：把"我们自己的配置坏了"报成"用户登录失败"，
> 会让所有人（用户、客服、开发）都以为问题在用户侧。`40125` 在 2026-10-29 就真实发生过一次
> （`backend/.env` 里那份旧 secret）。

### 8.3 `GET /auth/session` 为什么必须返回 `children`

登录之后客户端**必须知道 `childId`** 才能发任何后续请求，而今天它只能靠**编译期常量**（§1.6）。
没有这个字段，登录链路对客户端是**不完整**的：token 拿到了，却不知道"对哪个孩子"。
⇒ 一次登录 → 一次会话查询 → 拿到 `children`（0 个就进 `POST /children`，1 个就直入，N 个就选）。

### 8.4 `POST /auth/child-session` 在解决什么

`DeviceSession` 的行键是 `(deviceId, childId)`，而 `userId` 是**行上的一个字段**（不是键的一半）。
新设备登录后，这个用户在这台设备上**还没有行** ⇒ 必须先建（或复用）一行，才能过 `DeviceSessionGuard`。
它做的就是 `invites` 里那一步 upsert 的"已登录版本"：

```
upsert(where: { deviceId_childId }, create: { …, activeRole: 成员位角色, expiresAt: now+30d },
                                    update: { userId, activeRole: 成员位角色, expiresAt })
```

三条必须校验的前置（缺一条就是越权）：

1. `x-kp-device-id` 存在（**它已降级为"设备标识"**，见 §9.2）；
2. 调用者在该 `childId` 上有 `ChildMember(status=active)` ⇒ 否则 403 `NOT_A_MEMBER`；
3. 该 `(deviceId, childId)` 行若已属于**别的** user ⇒ 409 `DEVICE_SESSION_CONFLICT`（与邀请码同一条文案口径，
   共享平板是真实现场）。

---

## 9. D6 · Guard 改造：把 503 换成真的 401

### 9.1 新的守卫链顺序

```
AuthGuard（新，第 0 位）→ DeviceSessionGuard（改）→ MembershipGuard → PermissionsGuard → ConsentGuard
```

`AuthGuard` 与 `DeviceSessionGuard` **都不能**注册成 `APP_GUARD`（顺序理由见
`permissions.guard.ts` 的"顺序"一节，W1-C 已经栽过这个坑）。

### 9.2 `x-kp-device-id` 的降级（**这是安全闸门真正换掉的地方**）

| | 今天 | 改造后 |
|---|---|---|
| 它是什么 | **唯一的凭据**（客户端自报即可用） | **设备标识**（类似"这台设备的行号"，客户端生成并持久化） |
| 缺了会怎样 | 401 | 401（`DeviceSession` 的行键需要它） |
| 报别人的会怎样 | ⚠️ **直接以别人身份操作**（今天的洞） | ✅ 行上的 `userId` 与 token 的 `userId` 不符 ⇒ **401 `SESSION_NOT_FOUND`** |

新增的这道**同源校验**（`row.userId === kpUser.userId`）才是"身份层完成"的判据 ——
**W1-C 的 `x-kp-device-id` 之所以必须留 503，就是因为这一步不存在。**

> 响应码的选择：行存在但属于别人时，返回 **401 `SESSION_NOT_FOUND`**（不返回 403）。
> 理由：403 会告诉探测者"这台设备在**这个孩子**上确实有一个会话"—— 那是一条不该泄露的事实。
> 服务端**日志**另记一条 `warn`（`deviceId` + 两个 userId 的前 8 位），便于发现真实攻击。

### 9.3 错误码全表（客户端必须能区分这几种"401"）

| 场景 | 码 | HTTP | 客户端动作 |
|---|---|---|---|
| 没有 `Authorization` | `UNAUTHENTICATED` | 401 | 进登录页 |
| token 格式不对 / 查不到 / 已撤销 | `TOKEN_INVALID` | 401 | 清 token，进登录页 |
| token 到期 | `TOKEN_EXPIRED` | 401 | **静默重登一次**再重试原请求（只一次） |
| token 有效，但 `(deviceId, childId)` 无行 / 行属于别人 | `SESSION_NOT_FOUND` | 401 | 调 `POST /auth/child-session` 补行，失败再进登录页 |
| 身份/会话行**形状**坏（角色不在枚举、时间解析不出） | 500（沿用 `session.gate`） | 500 | 报错并上报；**不要**当成"没权限" |

> ★ 第三行与第四行**必须分开**：`TOKEN_EXPIRED` 可以静默修（重登），`SESSION_NOT_FOUND` 要换一步（补行）。
> 合成一个码的结果是"家长每次换手机都会看到登录页，而重登也修不好"。

### 9.4 生产闸门怎么删（**不是简单删掉那 6 行**）

```ts
// 今天（device-session.guard.ts:110）
if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException(...)
```

替换为：

1. `NODE_ENV === 'production'` 时**只**认 `Authorization`，`x-kp-device-id` 不再作为身份来源（已无身份来源）；
2. 迁移旁路 `AUTH_DEVICE_ID_FALLBACK`（默认 `0`）**只在非生产**生效；
   `NODE_ENV=production && AUTH_DEVICE_ID_FALLBACK=1` ⇒ **启动即抛错**（fail-closed：不让一句环境变量把洞打开）；
3. **用例必须钉住两条相反的事实**：
   - 组 E 改写：生产 + 无 token ⇒ **401**（不再是 503）；
   - 新增：生产 + `AUTH_DEVICE_ID_FALLBACK=1` ⇒ **启动失败**（否则这条旁路会在某个 `.env` 里活到线上）。

### 9.5 这次改造要动的既有用例（数量先摸清，别拍脑袋）

| 范围 | 量 | 处理方式 |
|---|---|---|
| `backend/test/**` 用 `x-kp-device-id` 的文件 | **19 个 / 45 处** | 走 `AUTH_DEVICE_ID_FALLBACK=1`（测试装配默认开），**逐文件**迁移到 Bearer 作为后续清理 |
| `backend/test-db/**` 用它的文件 | **14 个** | 同上（真库用例的价值在事务/并发，不在凭据形态） |
| 钉住 503 的两处 | `test/device-session-http.test.ts:479`（组 E）、`test/approvals-http.test.ts:831` | **必须先改**，否则"改造完成"与"用例还是绿的"会同时成立（D12 假绿的形状） |
| 客户端 | Flutter **1 处**（`lib/data/read_api.dart:14`）／小程序 **1 处**（`kids_points_mp/src/data/read_api.ts:25`） | 都是**常量定义**（头名本身），保留不动；改的是"值从哪来"⇒ §10 |

> ⚠️ 这张表的意思是：**旁路不是偷懒，是让"19+14 个文件的迁移"能被拆成可回滚的小步**。
> 但它同时是**唯一**一条"改造完成却仍不安全"的路径 ⇒ 所以 §9.4 第 3 条必须同时落地。

---

## 10. D7 · 客户端：小程序能做，Flutter **没有路可走**（这是真的分叉点）

### 10.1 小程序（本轮可完整落地）

```
wx.login() → code → POST /auth/login → token
  → Taro.setStorageSync('kp_token', token)      ← 新能力（store 今天只在内存）
  → GET /auth/session  ⇒ children
      · 0 个 → POST /children（勾选同意）
      · 1 个 → POST /auth/child-session → 之后所有请求带 Authorization + x-kp-child-id
      · N 个 → 选择器（首版 §14 Q3 建议限 1，走不到这里）
```

三条必须写死的客户端纪律：

1. **静默重登只重试一次**：`TOKEN_EXPIRED` ⇒ 重登 ⇒ 重放原请求；再 401 ⇒ 展示登录页。
   不做这个限制就是**无限循环**（登录本身也可能 401）。
2. **`TOKEN_EXPIRED` 与 `TOKEN_INVALID` 分开处理**（§9.3）。
3. **预览模式不变**：三项 env 缺一就继续走本地预览数据（`read_api.ts:93`），
   登录链路**不得**让"没配后端的开发者"看到登录页。

### 10.2 Flutter：三条路，代价差一个数量级

| 方案 | 用户动作 | 我们要做什么 | 等待周期 | 代价 |
|---|---|---|---|---|
| **A. 本轮不接** | 无（继续 `--dart-define` 调试身份） | 无 | **0** | Flutter 仍是"演示级身份"，**不能上线** |
| **B. 微信开放平台 App 登录** | 点"微信登录" | 接 `fluwx`/官方 SDK、申请开放平台移动应用、**认证费 300 元/年**、`unionid` 打通（要加列 + 回填） | **1–2 周**（审核，纯等待） | 最正规，也是唯一"一个自然人一个账号"的方案 |
| **C. 扫码配对** | 用小程序扫 Flutter 屏幕上的码 | 新端点（`POST /auth/pair` 发 6 位码 + `POST /auth/pair/claim`）、新 UI 两处 | **0** | 多一条凭据链路（配对码也是凭据，要同样的 TTL/一次性/限流） |

**推荐：本轮 A，下一轮 C**。理由：

- B 是**日历门**（1–2 周审核 + 300 元/年），而 C 的等待是 0 —— 先把能做的做完，再决定要不要付这笔钱；
- C 不需要 App 上架、不需要开放平台认证，**且顺带解决"家长没有微信 App 的平板"**；
- A 期间 Flutter 的 `--dart-define` **只能在非生产**：`NODE_ENV=production` 下登录链路已生效 ⇒
  Flutter 上生产必然 401 —— 这是**故意的**，让"Flutter 没接登录"这件事无法被忽略。

### 10.3 客户端凭据存储（两端都别过度设计）

| 端 | 存哪 | 风险 |
|---|---|---|
| 小程序 | `Taro.setStorageSync` | 同设备可读（`02` §7 早就说过"storage 可被改"）；**7 天 TTL 是主要防线** |
| Flutter（走 C 之后） | 先 `shared_preferences`，**是否上 `flutter_secure_storage` 见 §14 Q5** | 新依赖 = 新平台配置（iOS Keychain / Android Keystore） |

---

## 11. D8 · 安全与滥用（**含一条不属于代码的前置**）

### 11.1 前置：限流器**今天不存在**

`main.ts` 没有 helmet、没有全局 rate limit（`PRD` 的部署缺口清单里已记）。
`POST /auth/login` 是全仓库**唯一**免认证的写路由，没有限流时它有三个用途：
① 刷 openid 探测；② 刷 CPU（每次一次外网请求）；③ 把微信的 `45011` 直接引到我们身上。

**建议判据**（实现可以是内存桶，也可以是反代 `limit_req`，但**必须有一处**）：
`每 IP 每分钟 20 次 / 每 deviceId 每分钟 10 次`，超限 **429**（不是 503）。

### 11.2 日志脱敏（三条硬规则）

| 绝不写日志 | 为什么 |
|---|---|
| `token` 明文 / `tokenHash` | 前者是凭据，后者是"凭据的指纹"（可用来撞库比对） |
| `code`（微信登录码） | 5 分钟内有效，泄露即可被抢登 |
| `WECHAT_MP_SECRET` / `session_key` | 前者是根凭据，后者可解密用户数据 |

★ **`code2session` 用 POST form，不要用 GET query**：微信两种都支持，但 GET 会把
`secret` 写进**访问日志 / 反代日志 / 浏览器与 APM 的 URL 记录**。这一条在"哪天接了 APM"时会救命。

### 11.3 会话固定（session fixation）

登录成功**必须新签发** token，**绝不**接受"拿旧 token 换新 token"。否则攻击者可以先塞一个自己知道的
token 给受害者，等受害者登录后继续用同一个 token。`POST /auth/login` 不读 `Authorization`（§8.2），
这条天然满足 —— 但要**写一条用例**钉住（防"顺手加个续期"）。

### 11.4 AppSecret 的处理建议（**这条需要你现在决定**）

- 它已经出现在聊天记录里（等同于已泄露给任何能看到该记录的一方）；
- 重置步骤：微信公众平台 → 开发 → 开发管理 → 开发设置 → **重置 AppSecret** →
  新值写进 `backend/.env`（**不要**写进 `.env.example` / 代码 / 文档）→ 重启后端；
- **重置不影响**已签发的 `AuthSession`（那是我们自己的表），只影响"下一次 `code2session`"；
- 若不重置：至少确认这份记录没有被转发 / 没有进公开仓库（`git check-ignore backend/.env` ✅ 已验证）。

---

## 12. D9 · 迁移与回滚

### 12.1 迁移（三步，全部可逆）

| # | 迁移 | 内容 | 回滚 |
|---|---|---|---|
| M1 | `20261029xxxxxx_auth_session` | `CREATE TABLE "AuthSession"` + 2 个索引 + `User` 反向关系（无列变更） | `DROP TABLE "AuthSession"`（纯增量，不动既有表 ⇒ **零数据风险**） |
| M2 | （后续，不在本轮） | `DeviceSession.expiresAt` **语义**收窄 | 只改写入方，**不删列、不改类型** ⇒ 回滚 = 换回旧代码 |
| M3 | seed | `seed:demo` 增一条 `AuthSession`（`method='dev_seed'`，**token 明文打印一次**到 stdout） | 重跑 `db:verify` 不受影响 |

> ★ M1 之所以敢做，是因为它**只加表**。任何"改既有表"的迁移都要按本仓库的既有纪律
> 写 `-v ON_ERROR_STOP=1` 的 `psql` 自检（见 `.env.example` 里那段为什么）。

### 12.2 双读期（**这是唯一允许"能用旧凭据"的窗口**）

```
未带 Authorization：
  ├─ AUTH_DEVICE_ID_FALLBACK=1 且 NODE_ENV!=production ⇒ 走旧路径（今天的 DeviceSessionGuard 行为）
  └─ 否则 ⇒ 401 UNAUTHENTICATED
带 Authorization：
  └─ 走新路径（AuthGuard + 同源校验），**永不**回落到旧路径
```

- 测试装配（`test/support/*`）默认 `AUTH_DEVICE_ID_FALLBACK=1` ⇒ 19 + 14 个文件不用一次性重写；
- 生产恒为 `0`，且 `1` ⇒ **启动抛错**（§9.4）；
- 双读期的**结束判据**是 §13 S6 完成（两套客户端都走 Bearer），不是"感觉差不多了"。

### 12.3 回滚判据（**不看"能不能启动"**）

回滚后必须重跑并贴出退出码：`npm run typecheck`、`npm test`、`npm run test:db`、`npm run db:verify`、
`flutter analyze` + `flutter test`、小程序 `tsc` + `build:weapp` +
`node .tmp_test/run-<本轮>.mjs`。**"启动成功"与"链路正确"是两件事** ——
本仓库的 D12 假绿、`40125` 事件都是"看起来起来了"的产物。

---

## 13. D10 · 落地顺序（每步都能独立合并、独立回滚）

| 步 | 内容 | 退出判据（**可失败**，不是"我看过了"） |
|---|---|---|
| **S1** | `AuthSession` 表 + 迁移 M1 + 纯函数内核 `auth-session.gate.ts`（token 形状 / `sha256` / 过期边界） | 内核可离线穷举：`===` 边界、白名单外的 `method` ⇒ 500、`revokedAt` 非空 ⇒ 拒绝 |
| **S2** | `WechatCode2Session` **端口** + 假实现（CI）+ 一条**手工**联通脚本 `npm run wx:probe`（用真 AppID/Secret，不进 CI） | CI 全绿且**零外网**；`wx:probe` 独立可跑（它才是真凭据的证据） |
| **S3** | `POST /auth/login` / `POST /auth/logout` / `GET /auth/session` | §8.2 的错误映射逐条有用例；登录响应**不含** `session_key`；日志探针查不到 token |
| **S4** | `AuthGuard` + `DeviceSessionGuard` 改造 + 删 503 + 两条相反用例（§9.4） | 生产 + 无 token ⇒ **401**；生产 + 旁路=1 ⇒ **启动失败**；19+14 个旧文件仍绿 |
| **S5** | `POST /children` + `POST /auth/child-session` | 同一事务 6 张表各 1 行；不带 `accepted:true` ⇒ 400 且**库里 0 个 Child**；重复调用 ⇒ 409 |
| **S6** | 小程序客户端（`wx.login` + 持久化 + 401 分流）＋ 真库并发用例（§6.2） | `run-<本轮>.mjs` 全 PASS；`Promise.all` 双登录 ⇒ `User` 恰 1 行 |
| **S7** | `seed:demo` 演示 token + 文档同步（§15） | `npm run ci` / `ci:db` EXIT=0；四处文档与代码一致 |

**为什么这个顺序**：S1/S2 是纯离线（不碰 HTTP、不碰凭据），失败成本最低；
S4 是最危险的一步（它在改所有请求的入口），所以必须排在"新路径已经有用例"之后。

---

## 14. 需要你裁定的 7 件事（每件都给了默认建议）

| # | 问题 | 建议 | 如果选另一个会怎样 |
|---|---|---|---|
| **Q1** | Flutter 怎么登录？ | **本轮 A（不接）**，下一轮 C（扫码配对） | 选 B ⇒ 先启动 1–2 周开放平台审核 + 300 元/年，且有 `unionid` 加列迁移 |
| **Q2** | `AuthSession` TTL | **7 天绝对**（§4.3） | 30 天 ⇒ 丢手机后的暴露窗口 ×4，换来的只是"少一次静默重登" |
| **Q3** | 一个 user 能建几个孩子 | **首版限 1**（`POST /children` 已有 active 成员位就 409） | 允许多个 ⇒ 必须同时做"切换孩子" UI + `GET /auth/session` 的选择器，范围翻倍 |
| **Q4** | `modeSource` 是否加 `bootstrap` | **加**（§5.5，不新增列） | 不加 ⇒ 引导期客户端显示"用 PIN 换的 5 分钟"，而当时根本没有 PIN（会引来"PIN 被绕过"的误报） |
| **Q5** | 是否引入 `flutter_secure_storage` | **等 C 落地再定** | 现在就加 ⇒ 多一个原生依赖 + iOS/Android 配置，而 A 期间 Flutter 根本没有 token 要存 |
| **Q6** | 演示/开发是否保留 `x-kp-device-id` 旁路 | **保留，但仅非生产 + 生产置 1 必崩**（§9.4/§12.2） | 不保留 ⇒ S4 要一次性改 33 个测试文件，无法小步回滚 |
| **Q7** | AppSecret 是否重置 | **建议重置**（§11.4，它已在聊天记录里） | 不重置 ⇒ 风险取决于这份记录的传播范围；`git` 侧已确认未入库 |

> 这 7 条都不阻塞"评审"，但每一条都会改变代码形状 —— **默认值我会按"建议"落地**，
> 你只需要指出不同意的编号。

---

## 15. 本设计落地时要同步的既有文档（**现在不改，避免文档跑到代码前面**）

| 文档 | 要改什么 | 为什么容易漏 |
|---|---|---|
| `02` §1 | `User.openId` 的"L2 前可能为空"注释作废 | 那句注释现在是**唯一**说明 openId 来源的地方 |
| `02` §7 | 加"两表分工"一节（认证会话 vs 角色窗口） | 否则下一个读者会以为 `AuthSession` 是重复建设 |
| `02` §3 / `device-session.guard.ts` 头注释 | "生产 503 故意保留"→"已由 `AuthGuard` 取代" | 这段注释是**当前**最权威的 503 理由，不改就会自相矛盾 |
| `05` §6 | L2 行已 ✅（本轮已改），补"登录链路"为代码任务 | 否则 L2 看起来像"连登录都做完了" |
| `PRD` §11 / §12 / §15 | 里程碑加 W9-A、L2 行、诚实状态 | §15 是"已完成清单"的事实源 |
| `README` 索引 | 加本文件一行 + 状态"设计稿（待评审）" | 索引是唯一的入口 |
| `03-existing-defects.md` | 是否新增一条"身份凭据不可验证"（从阻塞项变代码任务） | 它现在挂在 L2 名下，L2 关了就**找不到**了 |

---

## 16. 一句话总结（给评审用）

> **L2 只是把"能不能用微信登录"这件事从"买不到"变成了"还没写"。**
> 本条设计要做的事只有一件：**把"你是谁"（`AuthSession`）从"你在这台设备这个孩子上是什么角色"
> （`DeviceSession`）里拆出来**，然后补上今天缺的两个入口 —— `POST /auth/login`（凭据从哪来）
> 与 `POST /children`（第一个孩子从哪来）。
> 拆开之后，`NODE_ENV=production` 的那道 503 才有资格换成真正的 401。

