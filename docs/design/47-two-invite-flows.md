# 47 · 两个邀请码：产品流程与时序图

> **状态：流程对齐稿（2026-11-02）。本文不改任何代码、不改任何契约。**
>
> 依据：`45`（注册门，已落地）、`24` + `02` §8（加入门，后端已落地）、
> `46` §2.2（**产品上是两种邀请，实现上只有一张码表**）。
>
> 读法：本文只回答四件事 —— **谁、在什么时候、拿什么、走哪条路；失败时看到什么**。
> 字段级契约仍以 `45` §2 / `02` §8 为准，本文不重复。

---

## 0. 一分钟版

| 问题 | 答案 |
|---|---|
| 「两个邀请码」是哪两个 | **注册邀请**（没账号的人凭码建号）与**加入邀请**（已有账号的人凭码进家庭） |
| 是两张码吗 | **不是**。同一张 `InviteCode`、同一把钥匙、两个门（`46` §2.2） |
| 码上还有什么维度 | `role`：`guardian`（邀请家长）或 `child`（邀请孩子）。它与「两个门」是**正交**的 |
| 谁生成码 | 家庭里的 guardian，在小程序「我的 → 家庭成员」（`POST /invites`） |
| 两个门分别在哪 | 注册门 = App 登录页「第一次用？用邀请码注册」；加入门 = **目前没有客户端入口** |
| 两条路的终点一样吗 | 一样：`ChildMember(active)` + `DeviceSession` + `AuditLog(member.join)`；注册门多一个 `User` 和一条 `AuthSession` |
| 一句话记住 | **码决定「进哪个家庭、什么角色」；门决定「要不要顺手建个账号」** |

> ★ 不要把 `role=guardian` / `role=child` 当成「两个邀请码」。那是**一个码的两种角色**，
> 走的仍是同一个门、同一条占位语句。真正需要区分的是**用的人有没有账号**。

---

## 1. 参与者与前置

| 参与者 | 说明 | 现在有什么 |
|---|---|---|
| **家长 A**（签发人） | 已在目标家庭里的 `guardian` | 小程序能生成 / 查看 / 吊销码（`POST` / `GET` / `:id/revoke`） |
| **新家长 B**（没有账号） | 新手机、新家长，App 首装 | App 有注册页（`lib/screens/register_screen.dart`） |
| **已有账号的 C** | 另一位家长 / 亲戚 / 要加入「第二个孩子」的人 | **双端都没有「输入邀请码加入」的入口** |
| **目标孩子 X** | 码绑定的 `childId`，必须 `status='active'` | 由码决定，**不由请求头决定** |
| 服务端 | 一个事务完成占码 + 成员位 + 会话 + 审计 | 两条路共用 `invite-claim.ts` 的同一条 SQL |

三条与产品直接相关的事实：

1. **码是凭据**：8 位、31 个易辨认字符（去掉 `0 O 1 I L`）、密码学随机、
   次数上限 10、有效期上限 30 天、可吊销、审计里不写码本身（`invite-code.ts` 文件头）。
2. **码只授权「加入这个家庭」**：它绑 `childId`，不绑手机号，因此**永远不能用来重设密码**
   （攻击路径见 `46` §2.1）。
3. **服务端只下发事实、不下发结论**：`GET /invites` 给 `usedCount / maxUses / expiresAt / revoked`，
   **不给** `expired` 或 `usable`。界面自己算（`invites.types.ts` 文件头）。

---

## 2. 全景：一个码，两个门

```
         ┌───────────────────────────────────────────────┐
         │ 家长 A（guardian）生成一个邀请码               │
         │ 小程序「我的 → 家庭成员」→ POST /invites       │
         └───────────────────────┬───────────────────────┘
                                 │ 分享（口头念 / 微信 / 纸条）
                 ┌───────────────┴────────────────┐
                 ▼                                ▼
        对方还没有账号                     对方已经有账号
     （新家长 / 全新手机）              （另一位家长 / 亲戚 / 加第二个孩子）
                 │                                │
                 ▼                                ▼
   注册门 POST /auth/register-invite     加入门 POST /invites/accept
   码 + 手机号/邮箱 + 密码                  码（不再要密码）
                 │                                │
                 └───────────────┬────────────────┘
                                 ▼
        ┌────────────────────────────────────────────────────┐
        │ 同一个结果：ChildMember(active)                     │
        │            + DeviceSession(deviceId, childId_X)     │
        │            + AuditLog(action='member.join')         │
        │ 差别：注册门额外建 User + AuthSession（登录态）      │
        └────────────────────────────────────────────────────┘
```

### 2.1 对方该走哪个门（产品决策树）

| 对方的状态 | 注册门 | 加入门 | 结论 |
|---|---|---|---|
| 没有账号 | ✅ 建号 + 入家庭 + 登录 | ❌ 没有会话可过身份屏障 | 走**注册门** |
| 有账号，且已有 ≥1 个孩子的成员位 | ❌ 409 `IDENTIFIER_TAKEN`（号已注册） | ✅ 复用账号加入新家庭 | 走**加入门** |
| 有账号，但**一个孩子都没有** | ❌ 409 `IDENTIFIER_TAKEN` | ❌ 401 `SESSION_NOT_FOUND`（见 §10 P0-1） | ⚠️ **当前是死角** |
| 曾被移出该家庭（`status='removed'`） | ❌ 同上 | ✅ 复用同一成员行回来（`removedAt` 清空）；前提是这台设备上该孩子的会话还没过期 —— 移除**不删**会话 | 走**加入门**（无 UI） |

> ★ 最后一行是代码里明确写下的行为（`invites.prisma.repository.ts` 第 2 步的 `update` 分支），
> 不是推测；但**没有任何客户端能发出这个请求**。

### 2.2 一个反直觉、但必须讲对的细节

**加入门的请求头里的 `x-kp-child-id`，不是「要加入的那个孩子」。**

- 码决定 `childId_X`（占位语句 `RETURNING "childId"`）；
- 请求头里的 `childId` 只用来让 `DeviceSessionGuard` 找到**一条属于你的、已存在的会话**；
- 所以典型调用是：拿你**已有**的孩子 A 的会话过头，用一张指向孩子 B 的码加入 B。

这不是设计美感问题，而是当前实现的前提（`invites.controller.ts` 文件头「⚠️ 因此它的前提是」
那一段）：`accept` 只挂了身份屏障，而身份屏障查的是 `(deviceId, childId)` 会话行。
后果写在 §10 P0-1。

---

## 3. 前置时序：家长 A 生成码（两个门共用）

```
家长A(guardian)      小程序              API                    PostgreSQL
     │                 │                  │                         │
     │ 打开家庭成员     │                  │                         │
     │────────────────▶│                  │                         │
     │ 选角色/次数/天数  │                  │                         │
     │────────────────▶│ POST /invites    │                         │
     │                 │ {role,           │                         │
     │                 │  maxUses,        │                         │
     │                 │  expiresInDays}  │                         │
     │                 │─────────────────▶│                         │
     │                 │                  │ ① 身份屏障（会话→actor） │
     │                 │                  │ ② 成员资格（这个孩子的人）│
     │                 │                  │ ③ 矩阵 invite_member    │
     │                 │                  │    guardian ALLOW/child DENY
     │                 │                  │ ④ 同意闸门 ConsentGuard │
     │                 │                  │ ⑤ role ∈ {child,guardian}
     │                 │                  │    maxUses 1..10        │
     │                 │                  │    expiresInDays 1..30  │
     │                 │                  │ ⑥ 生成 8 位码（密码学随机）│
     │                 │                  │ ⑦ BEGIN ───────────────▶│
     │                 │                  │   孩子 status='active'? │
     │                 │                  │────────────────────────▶│
     │                 │                  │   INSERT InviteCode     │
     │                 │                  │────────────────────────▶│
     │                 │                  │   INSERT AuditLog       │
     │                 │                  │   （只记码行 id，不记码）│
     │                 │                  │   COMMIT ──────────────▶│
     │                 │                  │◀────────────────────────│
     │                 │ 200 {id, code:   │                         │
     │                 │   "ABCDEFGH", …} │                         │
     │                 │◀─────────────────│                         │
     │ 显示 ABCD-EFGH  │                  │                         │
     │◀────────────────│                  │                         │
```

**失败分支（产品只需记住三句）**

| 情形 | 结果 | 用户该做什么 |
|---|---|---|
| 孩子档案已删（`status≠active`） | 404 `CHILD_NOT_FOUND`，**不发码** | 换一个孩子 / 恢复档案 |
| 连续 5 次撞码（概率 ≈ 0） | 409 `INVITE_CODE_GENERATION_FAILED` | 重试 |
| 孩子角色调用（child 点「邀请」） | 403（矩阵 DENY） | 只能由家长发码 |

> 撞码重试**每次是一笔独立事务**：PostgreSQL 事务一旦报错就整体 aborted，
> 在同一事务里重试是假的（`invites.prisma.repository.ts` 文件头最后一段）。

---

## 4. 时序图 A：注册门（没有账号的人）

```
新家长B(App)              API                              PostgreSQL
     │ 码 + 手机号/邮箱 + 密码  │                                 │
     │────────────────────────▶│                                 │
     │                         │ 0 限流（同 IP 20/分、同设备 10/分）│
     │                         │   与两个登录端点共用额度          │
     │                         │ 1 缺 x-kp-device-id               │
     │                         │   ⇒ 400 DEVICE_ID_REQUIRED        │
     │                         │ 2 normalizeInviteCode             │
     │                         │   （去空格/连字符、转大写）        │
     │                         │   形状不对 ⇒ 400 MALFORMED        │
     │                         │ 3 classifyIdentifier              │
     │                         │   手机/邮箱形状错 ⇒ 400            │
     │                         │ 4 validatePasswordStrength        │
     │                         │   太弱 ⇒ 400 WEAK_PASSWORD        │
     │                         │ 5 scrypt 哈希 + 新签 token        │
     │                         │ 6 BEGIN ────────────────────────▶│
     │                         │   ① INSERT User ────────────────▶│
     │                         │      唯一列冲突 ⇒ 409 IDENTIFIER_TAKEN
     │                         │   ② 占码（条件 UPDATE，唯一判据）─▶│
     │                         │      null ⇒ 409 UNAVAILABLE       │
     │                         │   ③ 孩子 status='active'? ───────▶│
     │                         │      否 ⇒ 404 CHILD_NOT_FOUND     │
     │                         │   ④ INSERT ChildMember            │
     │                         │      （角色来自码，不来自请求体）  │
     │                         │   ⑤ 本设备已有别人的会话?          │
     │                         │      ⇒ 409 DEVICE_SESSION_CONFLICT│
     │                         │      upsert DeviceSession ───────▶│
     │                         │   ⑥ INSERT AuthSession            │
     │                         │      （method='password'）        │
     │                         │   ⑦ INSERT AuditLog member.join   │
     │                         │   COMMIT ───────────────────────▶│
     │                         │◀─────────────────────────────────│
     │ 200 {token, expiresAt,  │                                  │
     │      user, membership}  │                                  │
     │◀────────────────────────│                                  │
     │ adopt(token)            │                                  │
     │ POST /auth/child-session│                                  │
     │────────────────────────▶│ → signedIn                       │
```

**两条产品必须知道的语义**

1. **任一步失败 ⇒ 整笔回滚（含第 ① 步的 `User`）**。所以不会出现
   「账号建了、码没占上」或「码占了、人没加进去」的半成品。
2. **先建 `User` 再占码** 不是顺序错误：`InviteCode.usedByUserId` 是外键，
   占位语句需要已存在的 `userId`；靠事务回滚兜底（`45` §2.2 的 ★）。

**回包与登录逐字段同构**：客户端复用同一套解析与 `child-session` 编排 ——
注册成功后再走一次 `POST /auth/child-session`，不是注册接口自己发设备会话。

---

## 5. 时序图 B：加入门（已有账号的人）

```
已有账号C(App)                 API                        PostgreSQL
     │ Bearer token              │                             │
     │ + x-kp-device-id          │                             │
     │ + x-kp-child-id = 孩子A   │                             │
     │ POST /invites/accept {code:"…B"}                        │
     │──────────────────────────▶│                             │
     │                           │ 身份屏障：AuthGuard          │
     │                           │   + DeviceSessionGuard       │
     │                           │   └ 必须查到「C 在 A 上的会话」
     │                           │     否则 401（缺头/无会话/同源不符）
     │                           │ normalize + 形状校验         │
     │                           │   否 ⇒ 400 MALFORMED         │
     │                           │ BEGIN ──────────────────────▶│
     │                           │ ① 占码（同一条 UPDATE）──────▶│
     │                           │      null ⇒ 409 UNAVAILABLE  │
     │                           │      四种情况逐字相同         │
     │                           │ ② 已是该孩子 active 成员? ────▶│
     │                           │      是 ⇒ 409 ALREADY_MEMBER │
     │                           │      （回滚，不烧名额）       │
     │                           │ ③ 无成员行 ⇒ INSERT          │
     │                           │    曾被移出 ⇒ UPDATE 同一行   │
     │                           │      （removedAt 清空）       │
     │                           │ ④ 本设备在「目标孩子B」上     │
     │                           │    已有别人的会话?            │
     │                           │      ⇒ 409 DEVICE_SESSION_CONFLICT
     │                           │      upsert DeviceSession ──▶│
     │                           │ ⑤ INSERT AuditLog            │
     │                           │      member.join             │
     │                           │      （after 只记码行 id）    │
     │                           │ COMMIT ─────────────────────▶│
     │                           │◀────────────────────────────│
     │ 200 {childId:B, role,     │                             │
     │      sessionExpiresAt}    │                             │
     │◀──────────────────────────│                             │
```

**与注册门的三处关键差异**

| | 注册门 | 加入门 |
|---|---|---|
| 身份来源 | 无（`@Public()`），授权**只**靠码 | 已有登录态 + 一条已存在的设备会话 |
| 写的表 | `User` + 码 + `ChildMember` + `DeviceSession` + `AuthSession` + `AuditLog` | 码 + `ChildMember` + `DeviceSession` + `AuditLog` |
| 回包 | 登录态（token / expiresAt / user / membership） | 只有「进了哪、什么角色、会话到何时」 |

> 加入门**不挂** `ConsentGuard`：它依赖 `@RequireAction` 元数据，而 `accept` 不是矩阵动作
> （矩阵描述的是「成员对某孩子的操作」，被邀请人此刻还不是成员）。
> 同理它也不挂 `MembershipGuard` —— 那会让真正的被邀请人永远 403。

---

## 6. 现状：两个门的「门把手」不对称

| 能力 | 后端 | 小程序 | App |
|---|---|---|---|
| 生成 / 列表 / 吊销码 | ✅ 四条路由 | ✅ 「我的 → 家庭成员」 | ❌ |
| **注册门** `POST /auth/register-invite` | ✅ | —（小程序走微信登录，不需要） | ✅ 登录页次级入口 + 注册页 |
| **加入门** `POST /invites/accept` | ✅（含真库用例） | ❌ 0 命中 | ❌ 0 命中 |

> 结论（产品口径）：**今天真正能走通的只有「注册门」。**
> 「已有账号的人凭码加入」这条路后端已经具备，但用户没有任何地方可以输入码。
> 这不是本文的推测：`43` §3 P0-3 已记为「双端 `acceptInvite` 0 命中」，
> 本轮复核 `lib/**` 与 `kids_points_mp/src/**` 仍是 0 命中。

---

## 7. 码的一生（状态机）

```
        家长生成
           │
           ▼
     ┌───────────┐   被用一次（usedCount +1）   ┌───────────┐
     │   可用     │───────────────────────────▶│ 部分使用   │
     │ used<max  │◀───────────────────────────│ used<max  │
     └─────┬─────┘        （仍是同一个状态）     └─────┬─────┘
           │                                          │ used == max
           │ 到期 / 吊销 / 孩子档案被软删               ▼
           │                                    ┌───────────┐
           └───────────────────────────────────▶│  已用完    │
                                                └───────────┘
             三条「直接判死」的边：
               · expiresAt <= now()      → 过期
               · revoked = true          → 已吊销
               · Child.status ≠ 'active' → 通往空房子的钥匙
```

**判据只有一处**：`invite-claim.ts#claimInviteCode` 的那条
`UPDATE … WHERE "usedCount" < "maxUses" AND "expiresAt" > now() AND revoked = false RETURNING`。
两个门都调它，**不允许**任何调用方先 `findUnique` 再判断（那是 TOCTOU）。

**四种「不能用」对用户是同一句话**：不存在 / 已用完 / 已过期 / 已吊销 ⇒ 同一个
409 `INVITE_CODE_UNAVAILABLE`。区分它们等于给端点一个「哪些码存在」的探测面，
而用户能做的动作完全相同：找家长再要一个。

---

## 8. 用户看到什么：错误 → 下一步

| HTTP | code | 哪个门 | 用户看到的产品含义 | 下一步 |
|---|---|---|---|---|
| 400 | `INVITE_CODE_MALFORMED` | 两门 | 码**抄错/抄漏**了（不是失效） | 检查 8 位、别把 `0/O`、`1/I/L` 抄进去 |
| 409 | `INVITE_CODE_UNAVAILABLE` | 两门 | 码不能用（四种情况同答） | 找家长换新码；已注册过就直接登录 |
| 409 | `IDENTIFIER_TAKEN` | 注册门 | 这个手机号/邮箱**已经注册过** | 返回登录（不是反复改写法） |
| 409 | `ALREADY_MEMBER` | 加入门 | 你已经是这个孩子的成员 | 直接进 App；**没有消耗名额** |
| 409 | `DEVICE_SESSION_CONFLICT` | 两门 | 这台设备上已有**别人**的会话 | 先切换账号，或换设备 |
| 404 | `CHILD_NOT_FOUND` | 两门 | 这个码对应的孩子档案已删 | 找家长要新码 |
| 400 | `INVALID_IDENTIFIER` / `WEAK_PASSWORD` | 注册门 | 手机号/邮箱或密码不合格 | 按提示改；与登录同一套规则 |
| 400 | `DEVICE_ID_REQUIRED` | 注册门 | 客户端没带设备 id（实现问题） | 不是用户能修的；属客户端 bug |
| 401 | `SESSION_NOT_FOUND` / `UNAUTHENTICATED` | 加入门 | 没有登录态，或没有可用的设备会话 | 先登录；零孩子账号见 §10 P0-1 |
| 429 | `LOGIN_RATE_LIMITED` | 注册门 | 试太快（与登录共用额度） | 等 `retryAfterSeconds`，**不要自动重试** |

---

## 9. 并发语义：名额到底会不会被烧掉

| 场景 | 结果 |
|---|---|
| 10 个人同时用一个 `maxUses=3` 的码 | **恰好 3 个成功**，其余 7 个 409 `UNAVAILABLE` |
| 同一个人重复点「加入」（已是成员） | 409 `ALREADY_MEMBER`，**回滚**，`usedCount` 不变 |
| 占码成功但写成员位失败（如设备冲突） | 整笔回滚，`usedCount` 回到原值 |
| 两个请求同时生成同一个随机码 | 一个成功、一个 `P2002` → 换码重试（最多 5 次） |

> 产品含义：**「失败」不收费**。任何 4xx 都不应该让家长看到「名额少了一个」。
> 这也是为什么不能用「先查次数 → 再插入 → 再 +1」的实现。

---

## 10. 产品缺口（按严重度，全部有代码依据）

### P0-1 · 「有账号但零孩子」的人两条路都走不通

- 注册门：手机号已存在 ⇒ 409 `IDENTIFIER_TAKEN`（`invite-registration.prisma.repository.ts` 的 `mapRegistrationError`）。
- 加入门：`DeviceSessionGuard` 要求 `x-kp-child-id` + 一条有效会话行
  （`device-session.guard.ts` 第 127–137 行）；而 `POST /auth/child-session`
  又要求**已经是该孩子的 active 成员**（`identity.service.ts` 第 745–747 行）。
  零孩子 ⇒ 开不出任何会话 ⇒ `accept` 永远 401。
- 谁会踩到：**被移出家庭后换了设备、或会话已过期**的人；成员位被误删的账号；
  只在小程序里建过号但从未加入任何家庭的人。
  ★ 刚被移出、且这台设备上的会话仍在有效期内的人**还能**走加入门回来 ——
  移除成员**不删** `DeviceSession`（`members.prisma.repository.ts` 文件头末段：
  「让屏障一回 `MEMBER_REMOVED` 而不是 401」）。但一旦换设备或会话过期，
  `child-session` 又要求 active 成员位（403 `NOT_A_MEMBER`），就落进这个死角。
- 产品上需要一个决定：允许「登录后凭码认领」（`accept` 改成只要求 `AuthGuard`，
  不要 `DeviceSessionGuard`），或给这类账号一条「先建一个孩子」的出口。
  ⚠️ 这属于契约变更，本文只记录，不动手。

### P0-2 · 加入门没有任何客户端入口

- 双端 `acceptInvite` / `invites/accept` 均 0 命中（本轮复核）。
- 也就是说：家长 A 生成码 → 家长 C 没有地方输入 → 只能靠 curl。
- 影响：`POST /invites/accept` 目前只是「后端能力」，不是「产品功能」。

### P1-1 · 一张表两个门，没有 `purpose`

- 同一张 `InviteCode` 既能注册也能加入（`46` §2.2）。
- 产品含义：**不能把「成员码」当成比「注册码」更弱的凭据** —— 它们本来就是同一张。
- 要拆成互不通用的一对凭据，需要给码加 `purpose` 并在占位语句里分别校验（新功能，未做）。

### P1-2 · 吊销只挡「新加入」，不踢「已加入」

- 吊销后再用 ⇒ 409；已加入的人仍在家庭里（`45` §6.6）。
- 要移出请走成员管理 `DELETE /members/:id`。产品文案必须说清，否则家长会以为「吊销=清人」。

### P1-3 · 家长会话 TTL 是 30 天，不是 02 §7 的 5 分钟

- 邀请加入后签发的设备会话用 `INVITE_SESSION_TTL_MS = 30 天`（`invite-code.ts` 已标注为**已知偏差**）。
- 原因：PIN 切换角色的写端点还没落地，发 5 分钟会让共同监护人 5 分钟后静默掉回 `child`，
  且没有任何办法提回去（表现为「家长按钮突然全 403」）。
- PIN 落地后两处必须一起改成 5 分钟 + 每次 guardian 操作刷新。

### P2 · 其余已知边界

| 项 | 现状 | 影响 |
|---|---|---|
| 邀请码使用明细 | `InviteCode.usedByUserId` 只有一列，`maxUses>1` 时只代表**最后一个**使用者 | 无法回答「谁用了这个码」 |
| 注册页成人协议 | 只有一句「注册即表示同意」，无协议表 | 合规文本仍是占位 |
| 活库回滚用例 | `test-db/invite-registration-db.dbtest.ts` 未写未跑 | 「事务回滚」只有内存替身证据 |
| 小程序注册门 | 不需要（微信登录建号） | 它只负责**生成**码 |

---

## 11. 走查脚本（等加入门有 UI 后按这个验收）

**场景 1 · 新家长（注册门，今天就能走）**

1. 家长 A 在小程序生成 `role=guardian`、3 次、7 天的码；
2. 新手机装 App → 登录页点「第一次用？用邀请码注册」；
3. 填码 / 未注册手机号 / 密码 → 提交；
4. 期望：直接进家庭首页；「我的」显示 guardian；家长 A 的成员列表多一人；
5. 再点一次注册：期望 409 `IDENTIFIER_TAKEN`，**不产生第二个账号**。

**场景 2 · 已有账号的家长（加入门，后端 curl 可验）**

1. C 先登录，拿到 token；用自己**已有**孩子 A 的 `childId` 过一次 `child-session`；
2. `POST /invites/accept`，头带 `x-kp-child-id: A`，体带指向孩子 B 的码；
3. 期望 200 `{childId: B, role, sessionExpiresAt}`；
4. 再用 B 的 `childId` 调 `child-session` → 200；此后 `GET /home` 在 B 上可用；
5. 重复第 2 步：期望 409 `ALREADY_MEMBER`，且码的 `usedCount` **不变**。

**场景 3 · 码不能用的四种情况**

1. 过期：把码的 `expiresAt` 改成过去 → 期望 409 `UNAVAILABLE`；
2. 用完：`maxUses=1` 用两次 → 第二次 409 `UNAVAILABLE`；
3. 吊销：小程序点吊销 → 期望 409 `UNAVAILABLE`；已加入的人**仍在**家庭里；
4. 抄错：输 7 位 → 期望 400 `MALFORMED`（文案必须与 409 不同）。

---

## 12. 诚实边界

- 本文所有结论来自**代码与既有文档**，没有新增任何运行证据；§10 P0-1 的「死角」是
  **按守卫链推导**出来的，没有用一条真实 curl 复现过。动手改之前应先花 10 分钟实测确认。
- 没有真机走查；`test-db`（活库回滚 / `P2002`）本轮未跑。
- 本文**不提议**任何具体实现；P0-1 的两种解法各有契约代价，需产品先裁定。
- 与旧文档冲突时：契约以 `45` / `02` §8 为准，产品优先级以 `43` 为准，
  本文只负责把「两个门」讲成一条能走通的用户路径。

