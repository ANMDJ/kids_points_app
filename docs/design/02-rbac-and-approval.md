# 02 · 双角色权限矩阵与审批工作流

> 本文档定义 guardian / child 双角色的完整权限模型、审批请求状态机，
> 以及**积分记录的不可变性与规则版本化**（§4–§5，回应"记录是否完整、改规则后历史是否变化"）。
>
> ⚠️ **文中 `prisma` 片段是设计草图**：字段名 / 默认值 / 约束的**权威定义**是
> `backend/prisma/schema.prisma`。已知差异：草图省略了主键的 `@default(cuid())`
> （已补 4 处：`PointRule` / `PointRuleVersion` / `DeviceSession` / `InviteCode`）与部分审计/索引字段。

## 1. 角色与成员模型

```
User（自然人，一个家长一个 User）
  │
  ├─ UserChildRelation（监护关系）
  │    └─ Child（孩子档案：姓名、学段、积分余额）
  │         └─ ChildMember（孩子侧成员位）★ 新增
  │              role ∈ { guardian, child }
  │
  └─ 通过 邀请码 加入其他 Child
```

**关键设计：一个 User 对一个 Child 可以同时是 `guardian`（家长）或 `child`（孩子本人账号）。**

`ChildMember` 是权限判定的**唯一入口**（而非 `UserChildRelation`），因为：

| 场景 | 是否需要 `ChildMember` |
|---|---|
| 爸爸（guardian）查看孩子积分 | ✅ 需要 |
| 孩子用自己的设备登录打卡 | ✅ 需要（role=child） |
| 妈妈（第二个 guardian）也能审批 | ✅ 需要 |
| 只读分享（爷爷奶奶看战绩） | ✅ 需要（**将来**可扩展 `role=viewer`） |

> ⚠️ **`viewer` 的现状（2026-10-12 裁定 D6）**：`MemberRole` 枚举里**已经有** `viewer`
> （`backend/prisma/schema.prisma:34`），但 §2 的权限矩阵**只有 `guardian` / `child` 两列**，
> 因此 `viewer` 一律 **fail-closed `DENY`**（`backend/src/contracts/permission-matrix.ts:94`）。
> 将来真要支持"只读分享"，**必须显式扩展矩阵列** —— 不允许在调用处各自打补丁。

`ChildMember` 唯一约束：`@@unique([childId, userId])` —— 同一人对同一孩子只有一个成员位。

```
ChildMember {
  id, childId, userId, role, status(active|removed),
  joinedAt, removedAt, invitedByUserId, pinHash?, pinSetAt?
}
```

---

## 2. `PERMISSION_MATRIX` —— 单一声明式事实源

**架构约束：权限只能在一处定义。** HTTP Guard 与 Agent `action-dispatcher` **必须消费同一张表**
（见 §3 屏障二），否则两条入口必然漂移。

> **两列还是三列？（2026-10-12 裁定 D6）** 本矩阵**故意只有 `guardian` / `child` 两列**。
> `MemberRole` 里的 `viewer` 是将来"只读分享"的扩展位，**当前一律 `DENY`**：
> `if (role === 'viewer') return 'DENY'`（`permission-matrix.ts:94`）。
> 要支持它**必须显式加列**；否则"只读"会退化成"每个调用处自己打补丁"。

```ts
// contracts/permission-matrix.ts  —— 后端与 Agent 共享的唯一事实源
export type Role = 'guardian' | 'child'
export type Verdict = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL'

export const PERMISSION_MATRIX: Record<ActionType, Record<Role, Verdict>> = {
  /* ── 查询类 ───────────────────────────────────────────── */
  view_child_points:      { guardian: 'ALLOW', child: 'ALLOW' },
  view_records:           { guardian: 'ALLOW', child: 'ALLOW' },
  view_rules:             { guardian: 'ALLOW', child: 'ALLOW' },
  view_wishes:            { guardian: 'ALLOW', child: 'ALLOW' },

  /* ── 打卡 ─────────────────────────────────────────────── */
  check_in_habit:         { guardian: 'ALLOW', child: 'ALLOW' },
  undo_check_in:          { guardian: 'ALLOW', child: 'DENY'  },

  /* ── 规则 ─────────────────────────────────────────────── */
  add_rule:               { guardian: 'ALLOW', child: 'DENY'  },
  update_rule:            { guardian: 'ALLOW', child: 'DENY'  },
  delete_rule:            { guardian: 'ALLOW', child: 'DENY'  },
  add_habit_from_rule:    { guardian: 'ALLOW', child: 'DENY'  },

  /* ── 心愿 ─────────────────────────────────────────────── */
  add_wish:               { guardian: 'ALLOW', child: 'REQUIRE_APPROVAL' },
  request_redeem:         { guardian: 'ALLOW', child: 'REQUIRE_APPROVAL' },
  delete_wish:            { guardian: 'ALLOW', child: 'DENY'  },

  /* ── 积分 ─────────────────────────────────────────────── */
  adjust_points:          { guardian: 'ALLOW', child: 'DENY'  },  // ← 见 §6 归一化
  request_points_bonus:   { guardian: 'ALLOW', child: 'ALLOW' },  // 孩子仅可"申请"
  redeem:                 { guardian: 'REQUIRE_APPROVAL', child: 'REQUIRE_APPROVAL' },

  /* ── 审批 ─────────────────────────────────────────────── */
  request_approval:       { guardian: 'ALLOW', child: 'ALLOW' },
  review_approvals:       { guardian: 'ALLOW', child: 'DENY'  },
  withdraw_request:       { guardian: 'ALLOW', child: 'ALLOW' },

  /* ── 成员与设置 ───────────────────────────────────────── */
  invite_member:          { guardian: 'ALLOW', child: 'DENY'  },
  remove_member:          { guardian: 'ALLOW', child: 'DENY'  },
  switch_role_mode:       { guardian: 'ALLOW', child: 'ALLOW' },  // 受 PIN 保护
  edit_child_profile:     { guardian: 'ALLOW', child: 'DENY'  },
  apply_onboarding:       { guardian: 'ALLOW', child: 'DENY'  },  // 见 04
  reset_demo_data:        { guardian: 'DENY',  child: 'DENY'  }   // ← E18：生产永久关闭
}
```

**为什么孩子的 `adjust_points` 是 `DENY` 而不是 `REQUIRE_APPROVAL`：**
因为"孩子申请加分"和"孩子申请奖励"是**两类不同的意图**，应为**两个 ActionType**。
混为一谈会导致审批界面上无法区分"孩子想要什么"。见 §6。

---

## 3. 三道屏障（每一道都必须独立成立）

```
请求 / Agent 动作
   │
   ├─ 身份：设备会话解析（W1-C）
   │    (deviceId, childId) → DeviceSession 行 → actor{userId, role}
   │    ✗ → 401 UNAUTHENTICATED（缺头）/ SESSION_NOT_FOUND（无会话）
   │    过期 guardian → **回落 child**（§9.19；降级而非拒绝）
   │    作用：回答"我是谁、我在这份档案上是什么角色"（服务端说了算）
   │
   ├─ 屏障一：成员资格门（Membership Gate）
   │    ChildMember(childId, userId).status === 'active' ？
   │    ✗ → 403 MEMBER_NOT_FOUND / MEMBER_REMOVED
   │    作用：回答"这个人跟这个孩子有没有关系"
   │
   ├─ 屏障二：权限矩阵（PERMISSION_MATRIX）
   │    verdict = MATRIX[action][member.role]
   │    DENY             → 403 FORBIDDEN
   │    REQUIRE_APPROVAL → 202 + 创建 ApprovalRequest（见 §4）
   │    ALLOW            → 进入屏障三
   │    作用：回答"这个角色能不能做这件事"
    │
    │    ✅ **W1-A 落地注（2026-10-14）**：上面是**目标口径**。已落地的是**判定段** ——
    │    `PermissionsGuard`：DENY → 403 FORBIDDEN；REQUIRE_APPROVAL → **403 APPROVAL_REQUIRED**；
    │    端点漏标 → 403 NO_ACTION_DECLARED；viewer / 未知动作 → DENY。
    │    **「202 + 建 ApprovalRequest」尚未落地**（建单需要业务参数，是 dispatcher 的活，见 §6）。
    │    差别**是刻意的**：判定阶段只能"拒绝并点名"，绝不静默放行。
   │
   └─ 屏障三：成员级收紧（Member-level Tightening）
        家长可对**单个孩子**追加限制，只能更严、不能更松：
        ChildMember.restrictions: {
          childCannotUndoCheckIn?: boolean
          childCannotAddWish?: boolean
          requireApprovalForBonusOver?: number   // 超过 N 分需审批（Q15：默认 ±50）
          // ↑ 形状**封闭**：键名就是上面这三个（多一个即拒 —— 见下方的守卫说明）
        }
        作用：回答"这个家里对这件事有没有额外约定"
```

**屏障三的方向性约束（重要）**：`restrictions` 只能把 `ALLOW` 收紧为 `REQUIRE_APPROVAL` 或 `DENY`，
**永远不能把 `DENY` 放宽**。否则家长可绕过产品安全底线（如让孩子自己审批自己的申请）。

### ✅ W1-B 落地注（2026-10-15）：三道屏障**都接在请求路径上了**

| 屏障 | 判定核（唯一实现点） | 请求路径上的消费点 | 用例 |
|---|---|---|---|
| 一 · 成员资格 | `backend/src/membership/membership.gate.ts`（纯函数 `resolveMembership()`）＋ 端口 `MembershipPort` | `MembershipGuard`（控制器级 `@UseGuards` 第 2 位） | `test/membership-gate.test.ts`（内核）／`test/membership-http.test.ts` 组 A（真 HTTP，**§9.21**） |
| 二 · 矩阵 | `backend/src/contracts/permission-matrix.ts` | `PermissionsGuard`（第 3 位） | `test/permissions-guard.test.ts` |
| 三 · 成员级收紧 | `backend/src/contracts/member-restrictions.ts` 的 `tightenVerdict()`（消费 `stricter()`） | 同上（**同一个** Guard：`stricter(矩阵判定, 限制判定)`） | `test/member-restrictions.test.ts`（含 **§9.22** 穷举）／`membership-http.test.ts` 组 B |

守卫链（**数组顺序即语义**）：`@UseGuards(TemporaryRoleHeaderGuard, MembershipGuard, PermissionsGuard)`。
（★ W1-C 之后：`@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)` —— 见下面的 W1-C 落地注。）

**这一步修掉的两个"看起来在安全"**：
1. `MembershipModule` 此前是**空壳**（全仓零调用者）—— "这个人跟这个孩子有没有关系"从来没人问过；
   于是只要角色头合法，就能对**任意** childId 走矩阵（矩阵**无权**回答资格问题，两者正交）。
2. `stricter()` 此前**没有被任何请求路径调用** —— 家长为单个孩子配的限制**配了等于没配**，
   而且"没生效"这件事**没人看得见**（比报错危险）。

**两条 fail-closed（W1-B 新增，都有可执行断言）**：
- `kpMember` 缺失 ⇒ `PermissionsGuard` **抛错（500）**："没查" ≠ "查了没有限制" ——
  后者会让屏障三**静默失效**；
- 成员位的 `restrictions` 形状坏了 ⇒ **500 `INVALID_MEMBER_RESTRICTIONS`**
  （**数据坏了 ≠ 没权限**：若混成 403，会被当成权限问题排查很久）。
  ★ D3b 的 `validateRestrictions()` 至此才有了**请求路径上的**调用方（此前只有离线闸门在调）。

**诚实标注（不粉饰，与"已完成"分开记）**：
- ⚠️ **成员位来自端口，默认实现是 501**（`MEMBERSHIP_QUERY_NOT_IMPLEMENTED`）：
  真装配下**没有人**被放过去（fail-closed），但它也**还没有真的查过库** ——
  真 Prisma 适配器属 W2。理由写在该文件的文件头：`MembershipModule` 一注入 `PrismaService`，
  **无库 CI 会在启动阶段就崩**（`PrismaService` 构造时缺 `DATABASE_URL` 即抛），而本仓库的 HTTP 用例是无库跑的。
- ⚠️ `requireApprovalForBonusOver`（**金额**阈值）**在 HTTP 路径上不生效** ——
  金额属 dispatcher 的 payload（§6 未落地），当前唯一调用方拿不到它。
  `membership-http.test.ts` 组 B 有一条**把这个现状钉住**的用例（而不是假装它在拦）。
- ⚠️ 三条限制键**都不**作用于 `request_approval` ⇒ **屏障三在 `/approvals` 上结构性不生效**
  （它作用于 dispatcher 落地后的 `add_wish` / `undo_check_in` / `request_points_bonus`）；
  HTTP 层用**同一套守卫链**的探针端点验证（组 B）。
- ⚠️ `POST /approvals/:id/decide` 用的是**请求头里的** childId，尚未与**审批行自己的** childId
  做同源校验（要等 `ApprovalRow` 读模型带上它）—— 即：跨家庭推进审批这条路径**还没堵**。
- ~~⚠️ 身份仍是**临时头**（`x-kp-role` / `x-kp-user-id` / **`x-kp-child-id`**）——~~
  ✅ **已由 W1-C 取代（2026-10-15）**：角色与 userId 改由**服务端会话行**给出，
  `x-kp-role` / `x-kp-user-id` **已废弃且不再被任何代码读取**（见下一节）。

### ✅ W1-C 落地注（2026-10-15）：身份（Identity）**也是真的了**

| 层 | 判定核（唯一实现点） | 请求路径上的消费点 | 用例 |
|---|---|---|---|
| 身份 · 会话解析 | `backend/src/device-session/session.gate.ts`（纯函数 `resolveSession()` / `effectiveRole()` / `toSessionActor()`）＋ 端口 `DeviceSessionPort` | `DeviceSessionGuard`（控制器级 `@UseGuards` **第 1 位**） | `test/session-gate.test.ts`（内核，5 组 **22 条**）／`test/device-session-http.test.ts`（真 HTTP，5 组 **22 条**） |

守卫链（**数组顺序即语义**）：`@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`。

**这一步修掉的核心病：角色/身份由客户端自选**。W1-A/W1-B 之后三道屏障**都是真的**，
但它们的共同输入 `actor` 来自**客户端自己发的头**：发 `x-kp-role: guardian` 就是家长，
发谁的 `x-kp-user-id` 就是谁（本文 §7 早已写明"不存客户端"的理由：小程序 storage 可直接改）。
于是"屏障拦得对不对"**没有人验证过** —— 拦一个**自称**是家长的人，与拦一个**真的**是家长的人，是两件事。
现在：**客户端只被允许回答「我是哪台设备（`x-kp-device-id`）、在哪个孩子的档案上（`x-kp-child-id`）」。**

**口径（逐字对齐 §7 / §9.19）**：

| 情形 | 结果 | 为什么 |
|---|---|---|
| 缺 `x-kp-device-id` 或 `x-kp-child-id`（含重复头/空串） | **401 `UNAUTHENTICATED`** | 身份不完整 ⇒ 后续三道屏障无从判定；**绝不**退化成"按 child 放行" |
| `(deviceId, childId)` 会话**查不到** | **401 `SESSION_NOT_FOUND`** | 「查不到」≠「匿名放行」——那会让整条权限链变成可选（同屏障一的教训） |
| 会话 `activeRole = guardian` 且 **已过期** | 角色**回落 `child`**（§9.19） | **降级，不是拒绝**：设备与身份仍有效。过期判 401 会让孩子连"看自己积分"都做不了（把 TTL 变成故障） |
| 会话行 `childId` ≠ 请求的 `childId` | **500 `SESSION_CHILD_MISMATCH`** | `(deviceId, childId)` 是**查询键**；对不上只可能是适配器**没按 childId 查**（实现问题，不是权限问题） |
| 会话 `activeRole` 不在 `guardian/child/viewer` 内 | **500 `INVALID_SESSION_ROLE`** | 库里存了枚举外的值 ⇒ **数据**问题；混报 403 会被当权限问题排查很久（同 D3b 纪律） |
| `expiresAt` 解析不出 | **500 `INVALID_SESSION_EXPIRY`** | `NaN > n` 恒 `false` ⇒ 静默"永不过期"—— 静默的失败最难查 |
| `NODE_ENV=production` | **503 `IDENTITY_NOT_IMPLEMENTED`** | ★ **故意保留**：角色/身份的**来源**可信了，但**设备凭据仍不可验证**（`x-kp-device-id` 谁都能报 ⇒ 可冒充别人的会话）。解药是 L2 之后的会话 token（§1），届时换成"凭据无效 ⇒ 401" |

**TTL 的边界口径在一处定死**：`expiresAt === now` 即**已过期**（写成 `>=` 还是 `>` 这件事不许两端各理解一种），
`isSessionActive()` 是唯一实现点，`test/session-gate.test.ts` 组 C 用边界值钉住。

**形状与判定刻意分开**（同屏障一/D3b 的纪律）：会话不存在是 **401**（身份问题），
形状坏是 **500**（数据/实现问题）—— 混在一起的后果很具体：一个**数据**问题会表现为"你没有权限"。

**两条 fail-closed（都可执行断言）**：
1. **端口默认实现是显式 501**（`SESSION_LOOKUP_NOT_IMPLEMENTED`）—— 默认装配下每个请求都**拒绝**
   （比"拦不住"强，但它**也还没有真的查过库**）；`device-session-http.test.ts` 组 D 专门钉住这一条；
2. **生产闸门 503**（上表最后一行）—— 组 E 钉住，且有一条**反向**用例：拆掉闸门即变红（见 `w1c-canfail.mjs` ⑥）。

**诚实标注（不粉饰，与"已完成"分开记）**：
- ⚠️ **会话查询的持久化实现未落地**：`DEVICE_SESSION_REPOSITORY` 默认实现是 **501**，
  真 Prisma 适配器属 **W2**（与 `ApprovalsPort` / `MembershipPort` 同一批）。理由同上：
  一注入 `PrismaService`，**无库 CI 会在启动阶段就崩**。
  ⇒ **"身份由服务端确立"说的是机制，不是"已经能登录了"。**
- ⚠️ **`deviceId` 本身不可验证** ⇒ 生产 503（见上表）。**"身份层已完成"这句话现在还不能说**，
  能说的是**"角色不再由客户端自选"**。
- ⚠️ **会话刷新（§7「每次 guardian 操作刷新 TTL」）未实现**：本 Guard **只读**（刷新要写库，属 W2）。
- ⚠️ **PIN 切换（§7 / §9.18）未实现**：没有"切家长模式"端点，`pinHash` / `pinLockedUntil` 目前无人使用。
- ⚠️ **`POST /approvals/:id/decide` 的跨家庭推进仍未堵**：它用的是请求里的 childId，
  与审批行自己的 childId 还没有同源校验（要等 `ApprovalRow` 带上它）—— 会话层的同源校验只解决了**一半**。

**屏障三的形状（`D3b`，已定形 —— 阶段 D-b，2026-10-13）**：上面那三个键的**唯一权威**是
`backend/src/contracts/member-restrictions.ts` 的 `RESTRICTION_KEYS` ＋ 运行时守卫
`validateRestrictions()`（未知键、错类型、越界一律拒；prisma 侧仍是 `Json` 列 ——
Prisma 无法表达 `Json` 的内部形状，所以定形落在应用层）。本节这个代码块与
`schema.prisma` 里那行形状注释都是**手抄**，由 `npm run restrictions:check`
（`tools/restrictions-check.mjs`）逐字比对：**改键名必须三处同改**。

```
最终判定 = min(矩阵判定, 成员级限制)    // 按 严苛度 排序：DENY > REQUIRE_APPROVAL > ALLOW
```

**为什么必须是三道而不是一道**：如果只做矩阵，家长无法对个别孩子加严；
如果只做成员限制，每加一个孩子都要重新配置全部权限，且产品无法保证安全底线。三者职责正交。

---

## 4. `ApprovalRequest` 状态机

### 4.1 状态图

```
                        ┌──────────────┐
   创建（屏障二命中）───▶ │   pending    │
                        └──────┬───────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
  ┌───────────┐         ┌───────────┐         ┌──────────────┐
  │ approved  │         │ rejected  │         │ withdrawn    │
  └─────┬─────┘         └───────────┘         └──────────────┘
        │ 执行动作失败 / 前提消失
        ▼
  ┌───────────────┐
  │ invalidated   │ ★ 第 5 个终态（Q4 = 甲）
  └───────────────┘
```

**终态集合**：`approved` / `rejected` / `withdrawn` / `invalidated` / `expired`（TTL 触发）

### 4.2 为什么需要 `invalidated`（不能只靠 `rejected`）

审批是**跨时间**的：家长 3 小时后才点"同意"，但**这段时间里前提可能已经消失**。

| 场景 | 无 `invalidated` 的后果 |
|---|---|
| 孩子申请兑换「汪汪零食」，家长同意前**孩子把该心愿删了** | 审批通过后**无法执行** → 只能报 500 或静默丢弃 |
| 孩子申请兑换，家长同意前**积分已被别的操作花掉** | 通过后扣成负数 → 账本不平 |
| 孩子申请"加分"，家长同意前**规则被删了** | 依据消失，无法解释这笔分从何而来 |
| 成员在审批期间**被移出家庭** | 不该再给已离开的成员发分 |

`invalidated` 携带 `autoReason`：
```ts
type AutoReason = 'WISH_DELETED' | 'RULE_DELETED' | 'HABIT_GONE'
                | 'INSUFFICIENT_POINTS' | 'MEMBER_REMOVED'
```

**语义区别（必须在 UI 上区分）**：
- `rejected` = **家长不同意**（人的决定）→ 孩子看到"爸爸说这次先不换"
- `invalidated` = **前提消失了**（系统的判定）→ 孩子看到"这个心愿已经不在心愿单里了，申请自动取消"

两者混用会让家长"莫名其妙背锅"，是必须避免的体验缺陷。

### 4.3 `ApprovalRequest` 表

```prisma
model ApprovalRequest {
  id              String   @id @default(cuid())
  childId         String
  requesterUserId String
  requesterRole   MemberRole
  actionType      ActionType
  payload         Json        // 动作参数快照（如 { wishId, costSnapshot }）
  status          ApprovalStatus  // pending|approved|rejected|withdrawn|invalidated|expired
  autoReason      AutoReason?     // 仅 invalidated 时存在
  decidedByUserId String?
  decidedAt       DateTime?
  decisionNote    String?
  expiresAt       DateTime        // TTL，默认 72h
  executedRecordId String?        // 批准并执行后产出哪条流水
  createdAt       DateTime @default(now())
  @@index([childId, status, createdAt])
  @@index([status, expiresAt])    // 供 TTL 扫描
}
```

**`payload` 必须快照成本**（`costSnapshot`），不能只存 `wishId`：
否则家长同意时心愿价格已被改过，扣分金额与孩子申请时看到的不一致 —— 又是一次"账对不上"。

### 4.4 审批通过的执行必须幂等

```
家长点「同意」
  → 检查 status === 'pending'（乐观锁：UPDATE ... WHERE id=? AND status='pending'）
  → 未命中 → 返回 409 ALREADY_DECIDED（防重复点击）
  → 命中   → 同一事务内：写 PointRecord + 更新余额 + status='approved' + executedRecordId
```

「同意」与分析统计、通知发送**必须分离**：推送失败不能回滚账本（见 `01` §事务边界）。

### 4.5 谁可以批准 —— 「自批」的裁定（2026-10-14，PRD §14.1 **P4**）

> 回应问题：**`redeem` 对两端都是 `REQUIRE_APPROVAL`，那到底"谁可以批准"？**
> 原状：**全仓无定义** —— 矩阵只回答"哪个角色能**发起**"，§4.1–§4.4 只回答"状态怎么走"；
> "批准人资格"既没有文字也没有判据（`grep` 全仓 0 处，`ApprovalRequest` 上也没有"批准人 ≠ 申请人"这类约束）。
> 后果不是安全漏洞，而是**功能死锁**：**单家长家庭**（只有一位 `guardian`）提交兑换后
> **没有任何人能批准** → 永远 `pending` → 到期被 `expired` 扫掉。
> 孩子"按规矩办事"反而换不出心愿 —— 这是必须修的体验缺陷，不是可选项。

**裁定：允许申请人自批，但自批必须是一次「显式动作」**（绝不静默自动批准）。

| 形态 | 做法 | 契约上的显式信号 |
|---|---|---|
| ① 两步式（二次确认） | 先建 `pending`，再由**申请人自己**调批准端点 | 多出来的那次批准调用（落库后 `decidedByUserId === requesterUserId`） |
| ② 一步式（申请时勾选"自动审批"） | 建请求带 `autoApprove: true`，同一事务内直接落 `approved` + 写流水 | `autoApprove === true` |

界面上的"弹窗二次确认"与"请求时勾选"**只是这两种形态的皮** —— 契约只看那个显式信号。

**硬约束（六条，全部可测）**：

1. **批准资格** = 矩阵 `review_approvals` 行为 `ALLOW` → 只有 `guardian`；`child` / `viewer` 一律不能批准。
2. **自批资格** = 动作对该角色是 `REQUIRE_APPROVAL` **且** 具备批准资格 —— 两条都由矩阵导出，
   **不新增第三处"批准人名单"**（权限只能在一处定义，§2）。
3. **不勾选就不批**：`autoApprove` 缺席 / `false` / 非布尔 → 一律 `pending`。
   ★ **不存在**"只有一位家长所以自动批准"的特例 —— 那会让同一个 API 随家庭人数改变安全语义，
   且审计里会凭空出现**没有人点过同意**的批准记录。
4. **没资格却显式要求自批 → 拒绝**：`400 SELF_APPROVAL_NOT_ALLOWED`，**不是静默忽略** ——
   静默忽略会让客户端以为已批，而库里那条 `pending` 谁也没看见
   （与 `member-restrictions.ts` 的多余键拒绝同一口径：形状 = 集合封闭）。
5. **同一执行路径**：自批与"他人批准"走**同一套**重校验 ＋ 同一事务 ＋ 同一流水，
   差别只落在 `decidedByUserId`。
6. **审计可辨**：`decidedByUserId === requesterUserId` ⇒ 自批（`isSelfApproved()`），
   审计动作名 `approval.self_approved`（`AuditLog.action` 本就是自由字符串）；
   **不新增字段 / 枚举 / 迁移**（同 §5 的 D4 口径：冗余的两份真相必然漂移）。

**边界（为什么它不扩大任何权限）**：家长本来就能 `adjust_points` / `add_wish`（矩阵 `ALLOW`），
自批只是把"自己提的兑换"从"等别人"变成"自己确认"；孩子**不能**自批，
故孩子的申请照旧受 §9.16 / §9.17 的每日配额与 ±50 上限约束 —— **自批不是绕过配额的通道**。

**唯一实现点**：`backend/src/contracts/approval-policy.ts`
（`canReview()` / `canSelfApprove()` / `decideRequestOutcome()` / `canDecide()` / `isSelfApproved()`），
配 `backend/test/approval-policy.test.ts`（10 条性质测试：含"不勾选一律 `pending`"与
"孩子自批被拒"两条会失败的对照）。
**落地状态（2026-10-14 阶段 B4，**上一版标注已被证伪**）**：✅ **HTTP 路径已建成并消费本文件** ——
`POST /approvals`（本文 §9.3 / §9.25 / §9.26 / §9.27 的状态码口径）与
`POST /approvals/:id/decide`（§9.10 的「双击同意 → 409」等），实现见 `backend/src/approvals/`，
用例见 `backend/test/approvals-http.test.ts`（**真起 Nest 服务 + 真发 HTTP 请求**）。
⚠️ 但**落库 / 账本流水 / 审计写入仍未落地**：`ApprovalsPort` 的默认实现是**显式 501**
（`APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`），不是静默成功。
★ 身份口径**已于 W1-C 更换**（2026-10-15）：W1-A/W1-B 时代的
`x-kp-role` / `x-kp-user-id` / `x-kp-child-id` **三个自报头**已改为
`x-kp-device-id` / `x-kp-child-id` **两个头 ＋ 服务端会话行**（角色与 userId 由 `DeviceSession` 给出，
两个自报头**不再被读取**）—— 详见 §3 的「W1-C 落地注」。
（被删掉的实现是 `backend/src/device-session/temporary-role.guard.ts`，本仓库已无此文件。）
★ `x-kp-child-id` 是 **W1-B 新增的必需项**：它喂给屏障一（"对这个孩子，你是什么身份"），
W1-C 之后它同时是**会话查询键的一半**。
**真装配复验（W1-B，2026-10-15，`tools/_scratch/w1b-live-probe.sh`，真 AppModule ＋ 真 Prisma）**：
三个头齐全 → **501 `MEMBERSHIP_QUERY_NOT_IMPLEMENTED`**（屏障一已接线，但成员查询端口未落地 ⇒
fail-closed：此刻**没有人**被放过去）；缺 `x-kp-child-id` → **401**；无身份头 → **401**；
`{action:'redeem', foo:1}` → **501**（★ Guard 在管道**之前**，所以屏障一的 501 会盖住管道的 400 ——
成员查询落地后这条会回到 400；这是顺序使然，不是管道坏了）。
启动日志含 `Mapped {/approvals/:id/decide, POST}` 与 `数据库已连接`。

---

## 5. ★ 积分记录的不可变性与规则版本化（核心）

> 回应问题：**"积分记录是否完整记录了积分规则？改规则后已完成记录是否变化？"**
> 答案：**完整记录（引用 + 快照双层）；改规则后历史记录完全不变化 —— 值、含义、可解释性皆不变。**

### 5.1 为什么"完整"必须是两层，而不是单纯复制

**反例：只有 `ruleId` 是不够的**
```ts
PointRecord { title:'番茄钟写作业', ruleId:'rule-A', pointsDelta: +1 }
// 家长后来把 rule-A 的分值改成 +3
// 追问："这条 +1 是按什么规则给的？"
//   → 查 rule-A 得到 { points: 3 } → 与记录的 +1 矛盾 → 无法解释
```

只有 `ruleId` 时，记录会指向**已变形的规则**，历史失去可解释性。**必须有 `ruleVersion`。**

**设计结构**
```
PointRecord（账本，append-only）
  ├─ 引用层  → ruleId + ruleVersion  →  PointRuleVersion（全量真相，永不修改）
  └─ 快照层  → titleSnapshot / pointsDelta / conditionSnapshot / dailyLimitSnapshot
                                       （反规范化，只为"列表渲染不用 join"）
```

| 层 | 作用 | 缺了会怎样 |
|---|---|---|
| `ruleId` + `ruleVersion` → `PointRuleVersion` | **"当时的规则完整是什么"** 的真相之源 | 无法解释历史（上面的反例） |
| 记录内快照字段 | 列表渲染、对账查询、统计 | 每渲染一行都要 join（性能），且规则被删后链条断裂 |

**一致性规则**：二者同事务写入；若不一致，**以 `PointRuleVersion` 为准**（真相之源，快照只是缓存）。

### 5.2 `PointRecord` 完整字段（设计规定）

| 字段 | 解决什么问题 | 缺了会怎样 |
|---|---|---|
| `ruleId` + `ruleVersion` | 依据哪条规则的哪个版本 | 无法解释"这分怎么来的" |
| `pointsDelta` | 本次变动（不可变） | — |
| `titleSnapshot` | 当时标题（**完整，不截断**） | 现状 `shortTitle` 截到 10 字符，标题永久丢失（B8） |
| `conditionSnapshot` / `dailyLimitSnapshot` | 当时的达成条件与频次上限 | 无法判断"当时允许几次" |
| `costSnapshot` | 兑换时的成本 | 心愿成本变更后无法解释历史扣分 |
| `wishId` / `habitId` | 回指对象 | 心愿删除后扣分原因永久丢失 |
| `source` | `child_self`/`guardian`/`agent`/`approval`/`system`/`correction` | 无法区分操作来源（A4） |
| `operatorUserId` + `operatorRole` | **真实操作人** | 现状硬编码"家长记录"，流水在撒谎（A4） |
| ~~`approvalRequestId`~~ **不落库**（裁定 D4） | 由哪条审批产生 | 决策链断裂 → 改由 `ApprovalRequest.executedRecordId`（**`@unique`**，`schema.prisma:558`）**单向**表达；双向冗余必然漂移 |
| `balanceAfter` | **记完后的余额** | **无法对账** —— 财务账本的基本要求（B6） |
| `idempotencyKey` | 防重复执行 | 重放会重复扣分 |
| `reversesRecordId` / `reversedAt` | 冲正关系 | 现状靠**删除**记录来撤销（B7） |
| `createdAt` | 时间 | — |

其中 `ruleVersion`、`operatorUserId`、`balanceAfter` 三项是本次设计**不可省略**的新增，
分别解决"解释不清 / 责任不明 / 对不上账"。

### 5.3 `PointRuleVersion` —— 规则版本表

```prisma
model PointRule {
  id             String  @id @default(cuid())
  childId        String
  title          String
  condition      String        // 结构字段（原 detail 第一段，见 E15）
  dailyLimit     Int           // 结构字段（原 limitText，见 A2）
  points         Int           // 恒为正；奖惩由 direction 表达
  direction      RuleDirection // reward | penalty
  icon           String
  color          String
  currentVersion Int     @default(1)
  status         RecordStatus  // active | deleted（软删，C9）
  deletedAt      DateTime?
  @@index([childId, status])
}

model PointRuleVersion {        // 只增不删，永久保留
  id              String  @id @default(cuid())
  ruleId          String
  version         Int
  title           String
  condition       String
  dailyLimit      Int
  points          Int
  direction       RuleDirection
  changedByUserId String
  changedAt       DateTime @default(now())
  changeNote      String?
  @@unique([ruleId, version])
}
```

**`update_rule` 事务**（原子）：
```
1. 读 currentVersion = v
2. 写 PointRuleVersion { version: v+1, ...新值 }
3. 更新 PointRule（含 currentVersion = v+1）
4. 写 AuditLog { action:'point_rule.update', before:{...v}, after:{...v+1} }
   ↑ 三步同一 $transaction
```

### 5.4 修改规则后的行为：具体时间线

```
3/1 10:00  家长建规则 R：「番茄钟写作业 +1 分 · 每天最多 2 次」
           → PointRuleVersion { ruleId:R, version:1, points:1, dailyLimit:2 }

3/2 09:00  孩子打卡
           → PointRecord rec#1 {
               ruleId:R, ruleVersion:1, pointsDelta:+1,
               titleSnapshot:'番茄钟写作业', balanceAfter:1 }

3/2 20:00  家长改规则 →「+3 分 · 每天最多 1 次」
           → PointRuleVersion { ruleId:R, version:2, points:3, dailyLimit:1 }
           → PointRule.currentVersion = 2
           → AuditLog { before:{v1}, after:{v2} }
           ★ rec#1 【完全不动】

3/3 09:00  孩子打卡
           → PointRecord rec#2 {
               ruleId:R, ruleVersion:2, pointsDelta:+3, balanceAfter:4 }
```

| 记录 | 显示 | 可解释性 |
|---|---|---|
| `rec#1` | `+1 分（按 v1：每天最多 2 次）` | ✅ 永远能回答"为什么是 1 分" |
| `rec#2` | `+3 分（按 v2：每天最多 1 次）` | ✅ 同上 |

**三层都不变**：① **值不变**（`+1` 永远不是 `+3`）；② **含义不变**（指向 `version:1`）；
③ **可对账**（`balanceAfter` 链：`0+1=1`，`1+3=4`）。

### 5.5 必须显式定义的语义边界：改规则对"今天已打卡"的影响

**场景**：规则「番茄钟 +1 · 每天最多 2 次」，孩子今天已打卡 1 次（拿到 1 分）。
家长把规则改成「+2 · 每天最多 1 次」。问：今天还剩几次？已拿的 1 分要不要补？

**规定语义（唯一能让双方都接受的）**：
> **历史不可回溯，未来从新规。**
> - 已发生的流水：**不动**（还是 +1）
> - 今日已用额度：**按新规重新计算**（已打卡 1 次 ≥ 新上限 1 次 → 今日剩余 0 次）
> - 已得的分：**不补差、不追扣**

**必须明确提示家长**（否则必然产生投诉）：
```
改动后，小满今天已完成 1 次，按新规则「每天最多 1 次」，今天不能再打卡了。
[确定修改] [取消]
```

> 本条是 `update_rule` 的**验收标准**，不是可选项。改完规则后"孩子今天打不了卡"却不知原因，
> 是最典型的家长困惑来源。

### 5.6 必须配套的限制：`PointRuleVersion` 永久保留

```
规则被删（软删）→ 规则主体从列表消失
   ↓ 若连带删除 PointRuleVersion
rec#1 的 (ruleId, ruleVersion) 指向空
   ↓
"这 +1 分按什么规则给的" → 永远无法回答
   ↓
"完整记录"的承诺失效
```

**规定**：
- `PointRule` 主体：可软删（`status=deleted`），90 天内可恢复（Q12）
- `PointRuleVersion`：**只增不删**（写入频率极低 —— 只在改规则时写一条，非每次打卡）
- `PointRecord`：**只增不删**（append-only），撤销用冲正而非删除

> 注意：**"配置 90 天可恢复"与"流水永久保留"是两件事**（Q12 修订）。
> 回收站只作用于"配置"（规则/心愿），永远不作用于"账本"。

**边界情况（W10 合规定稿）**：账号删除权 vs 账本保留。
- 建议：账号删除时**保留会计数据**（`pointsDelta`/`createdAt`/`ruleId` 等结构数据），
  **匿名化描述性文本**（`titleSnapshot`/`conditionSnapshot` 置为 `[已删除]`）。
- 效果：账仍然平、链条完整，但内容不可读 → 同时满足"删除权"与"账本完整性"。
- **schema 现在就要支持**（`titleSnapshot` 允许写占位值），否则 W10 要改表。

### 5.7 验收不变量 I1–I6（直接可写成测试）

| # | 不变量 | 测试方式 |
|---|---|---|
| I1 | 改规则后，所有已有记录的所有字段**逐字段不变** | 改前 `SELECT * FROM "PointRecord" WHERE "ruleId"=R` → 改规则 → 再查，**diff 必须为空**（标识符同 D5 勘误：camelCase 且带引号） |
| I2 | `balanceAfter` 链自洽 | 按 `childId, createdAt` 排序滚动求和 == `balanceAfter` |
| I3 | 每条记录的 `(ruleId, ruleVersion)` 必须能命中 `PointRuleVersion` | 左连接查 `NULL` 必须为 0 行 |
| I4 | 记录快照 == 其 `PointRuleVersion` 的对应值 | 写入时联合校验 |
| I5 | `PointRecord`/`PointRuleVersion` **无 UPDATE/DELETE 端点**，DB 层 `REVOKE`（**必须作用在应用角色上** —— 对表**所有者无效**） | 以**应用角色**直连 UPDATE 必须报错（`SQLSTATE 42501`） |
| I6 | 撤销打卡后，原记录仍在且新增一条冲正记录 | 记录数 **+1** 而非 −1；`reversesRecordId` 已设置 |

> ⚠️ **I5 的成立条件（W0 实测修正 —— 见 `06` §10 缺陷 7）**：`REVOKE` **对表所有者无效**。
> 若应用用所有者身份连库，I5 就是一句"看起来成立"的空承诺 —— 又一处**假绿**。
> 因此必须：**迁移走所有者、应用走仅 CRUD 的 `kids_points_app`**（裁定 D7），
> 并由 `prisma/sql/900_ledger_revoke.sql` **自检**权限是否真的生效（否则让迁移直接失败）；
> 验证脚本 `npm run db:verify` 按 **SQLSTATE 42501** 判定，**不依赖错误文案**。
> ★ 该角色（`kids_points_app`）的口令**不写在仓库里**：由 `prisma/sql/901_set_app_password.sql`
> 在部署时从环境变量注入（阶段 B2，2026-10-14）；`npm run db:verify` 另有 P1–P3 三条口令判据
> （非空 / 非占位值 / 长度下限 · 不与所有者口令复用 · 用户名必须分离）。

**落地注（W2-A，2026-10-15）：I2 / I4 / I6 已有代码，且**用的是同一把尺子****

| 不变量 | 落地物（`backend/src/ledger/ledger.gate.ts`） | 用例（`backend/test/ledger-gate.test.ts`） |
|---|---|---|
| **I4** 快照 == 版本行 | **双用尺子**：写侧 `assertSnapshotMatchesVersion()`（不一致即抛 ⇒ 500）、读侧 `findSnapshotMismatches()`（返回点名列的问题清单）；**并由构造保证** —— `buildRecordDraft()` 传了版本行时，快照字段一律取自版本行，调用方自己拼标题会被拒 | 组 D（**8 条**）＋ 组 C / C2（构造侧，共 12 条） |
| **I6** 撤销 ⇒ 新增冲正记录 | `reverseRecordDraft()`：`source='correction'` ＋ `reversesRecordId` ＋ 金额取反 ＋ **继承 `ruleId/ruleVersion`** ＋ 原记录**完全不动** | 组 E（11 条） |
| **I2** `balanceAfter` 链自洽 | `verifyBalanceChain()`：返回**人类可读的违例句**（空数组 = 自洽），**逐处**点亮断裂 | 组 F（9 条） |

- **同一个尺子两处用**是本条的设计要点：`findSnapshotMismatches()` / `verifyBalanceChain()`
  既在写入路径上把关，又是 W2-B 真库套件逐行跑的那把 —— 否则会出现
  "写入时校验一套、验证时另一套"，两边都绿而数据是错的。
- **I2 的起点是 0**（"该孩子的账本从空开始，且每一次余额变动都经账本"）。
  将来若引入**期初余额 / 数据迁移**，**必须改函数签名显式传起点** ——
  悄悄改起点等于让尺子说谎。
- ⚠️ **I2 的可见边界**：链条"自洽但余额为负"（−5 ⇒ −5，再 −5 ⇒ −10）它**判不出来** ——
  I2 只管 `Σ流水 == balanceAfter`，不管"余额本身是否合法"。后者由**写入侧拒绝**
  （`INSUFFICIENT_POINTS`，B6）＋ **真库层面再加一把尺子**（`Child.pointsBalance >= 0`，属 W2-B）共同守。
- ★★ **真库陷阱（W2-A 实测记录，W2-B 必须先处理）**：PostgreSQL 的 `now()` 在**同一事务内是同一个值**
  ⇒ 同事务写入的两条记录 `createdAt` **完全相同** ⇒ 单靠 `(childId, createdAt)` **无法定序**，
  本不变量（"滚动求和 == `balanceAfter`"）就**没有唯一解**。
  故 `verifyBalanceChain()` 遇并列时间戳时报 **`I2 顺序不可判：…`** 而**不**报"断裂"
  （换个排序就可能自洽 —— 那属于**报假病**，比不报更糟）。
  **修法在写入侧**：时间戳必须严格递增（显式传 `createdAt`，或加序列表 / 单调序），
  **不是**让校验器去猜顺序。
- **I4 的例外**：`source='correction'` 的冲正记录**继承** `ruleId/ruleVersion`（回答"哪一版规则产生了这笔分、
  又被谁撤销"），但 `titleSnapshot` 刻意是 `撤销：…` —— 拿它跟版本标题比**必然会红**。
  因此冲正记录**只校验 `(ruleId, ruleVersion)` 成对与指向，不比内容快照**。
- **诚实边界（不在本层冒充）**：**I1**（改规则后逐字段 diff 为空）／**I3**（`(ruleId, ruleVersion)`
  必须命中）／**I5**（`REVOKE`）**需要真库**，本层一行都没写 —— 它们随 W2-B 的真库套件交付
  （`npm run db:verify` 目前只覆盖 I5 的那一半）。另：账本持久化端口
  （`LEDGER_REPOSITORY`）**默认实现是 501**（`LEDGER_PERSISTENCE_NOT_IMPLEMENTED`）——
  **"账本内核已落地"说的是判定语义，不是"积分已经能记账了"**。
  > ★ **W2-C 修订**：这句在**无库**时仍然成立，但**有库**时已换成真实现（见下文"接线注"）——
  > "501 还是真适配器"由**装配时**按 `hasDatabaseUrl()` 决定，不再是一句静态结论。

**落地注（W2-B，2026-10-15）：I1 / I3 / I5 由真库套件交付；I2 的定序口径已定**

| 不变量 | 落地物 | 真库用例（`backend/test-db/ledger-db.dbtest.ts`） |
|---|---|---|
| **I1** 改规则不改历史 | 规则版本**追加式**写入（`PointRuleVersion`）＋ 记录里的 `ruleId/ruleVersion` 不外键级联删改 | 组 C：规则升到 v2 后，老记录**逐字段**不变、仍指向 v1 |
| **I3** `(ruleId, ruleVersion)` 必须命中 | **复合外键**（`PrismaLedgerRepository.mapWriteError`：`P2003` → `LEDGER_RULE_VERSION_MISSING`）⇒ 不靠"应用记得检查" | 组 D：全库**孤儿引用 = 0** ＋ **反向证明**（直接写一条指向空版本的记录 ⇒ 库自己拒绝） |
| **I5** 账本不可改删 | `prisma/sql/900_ledger_revoke.sql`（`REVOKE UPDATE/DELETE`） | 组 G：`UPDATE` / `DELETE` / Prisma 客户端 `update` 全被拒（判据是 **SQLSTATE 42501** —— 本机 PG 报中文，**不能**断言英文文案） |
| **I2** 链自洽 ＋ **可定序** | 写入侧保证 `createdAt` **严格递增**（见下） | 组 A：滚动求和自洽 ＋ 严格递增 ＋ 不照抄调用方时钟；组 B：并列时报「顺序不可判」 |
| **I6** 撤销 ⇒ 冲正 | `reverseRecordDraft()` 的落库形态 | 组 F：原记录**逐字段不动**、条数 **+1**、余额复原、二次冲正与"撤销的撤销"被拒 |
| **B6** 余额不许被截断 | 写入侧拒绝（`INSUFFICIENT_POINTS`）＋ 负数红线 | 组 I：全库**无负余额** ＋ 余额不足时**零记录**、余额不变 |

> 用例分布（`npm run test:db` → `1 个用例文件 / 17 个用例`，`ℹ suites 10`）：
> 组 A 2 ／ B 1 ／ C 1 ／ D 3 ／ E 2 ／ F 1 ／ G 1 ／ H 3 ／ I 2 ／ **J 1** = **17**
> （**J** 是 W2-C 补上的\"装配\"用例 —— 走真 DI 取端口，见下文\"接线注\"）。

- **`createdAt` 定序口径（上面那条"W2-B 必须先处理"的答案）**：严格递增由**写入侧**保证 ——
  `append()` 在单事务内 `SELECT … FOR UPDATE` → 取**库钟** ＋ `MAX(createdAt)` → 并列或回退时取
  `latest + 1ms`。库钟必须是 **`clock_timestamp()`**（同一事务内**会变**；`now()` 不会 ⇒ 同事务两笔会并列），
  **不是** `now()`。**调用方的 `now` 只用于业务语义，绝不写进 `createdAt`**
  （用例把调用方时钟设成 **2020 年**钉住这一点）。**不改 schema、不加序列表。**
- ⚠️ **真库当场抓到的第二个坑（离线用例结构上证明不了，记牢）**：`PointRecord.createdAt` 是
  **`timestamp without time zone`**，而 `clock_timestamp()` 是 **`with time zone`** —— 直接塞进 naive 列
  会被 PG 按**会话时区**换算（本机 `Asia/Shanghai`）⇒ 全部流水"**来自 8 小时后的未来**"，
  而**读回来处处自洽**：链仍严格递增、滚动求和仍对得上、类型也全对。
  修法：`(clock_timestamp() AT TIME ZONE 'UTC')`（naive 列存 **UTC 墙钟**，与 Prisma 自己写 `Date` 的约定一致）；
  并把判据**留在真库套件里**（组 A：`|createdAt − 现在| < 60s`）。
- ⚠️ **I5 的直接后果（不是设计选择）**：应用角色对 `PointRecord` 没有 `UPDATE` 权限 ⇒
  `PointRecord.reversedAt` **永远是 `null`**。所以"这笔被冲正过没有"**只能**从新记录反查
  （`readReversedIds()`）；任何按 `reversedAt` 判断的代码都会**永远认为没被冲正过**。
- ⚠️ **I2 在真库套件里的可见边界**：套件**故意不做全库 I2 扫描** —— 它自己就会造"并列 / 未来时间戳"的脏行，
  全库扫必红。真库侧只做**计数类红线**（全库无负余额、孤儿版本引用 = 0），
  逐笔滚动求和只对**每个用例自己新建的孩子**做。
- **仍未落地**：三个端口的真实现（`Approvals` / `Membership` / `DeviceSession`）**仍是 501**。
  `LEDGER_REPOSITORY` 那一半已于 **W2-C** 接好（见下）。
  另外：真库套件会**写入真实流水且删不掉**（`DELETE` 被 REVOKE、`Child` 是 `onDelete: Restrict`），
  故用随机 `RUN` 前缀隔离，且入口有 `NODE_ENV=production` 拒跑的守卫。

**接线注（W2-C，2026-10-15）：上面那句\"真适配器已写出、但未接进装配\"已经过期**

- `LedgerModule` 改成**动态模块**：`register()` 按 `hasDatabaseUrl()`
  （`backend/src/prisma/database-enabled.ts`，**判据只有一处**）分叉 ——
  **有** `DATABASE_URL` ⇒ `PrismaLedgerRepository`（真查库，**并导入 `PrismaModule`** 共用全仓唯一连接池）；
  **没有** ⇒ `NotImplementedLedgerRepository`（六个方法全抛 501，**响亮兜底**）。
  `app.module.ts` 里是 `LedgerModule.register()`（不传参 ⇒ 按环境推断；`main.ts` 第一行已加载 dotenv）。
- **为什么必须动态**（这就是当初那个卡点）：`PrismaService` 的构造函数在缺 `DATABASE_URL` 时**刻意**抛错，
  而 Nest 会**急切地**实例化被导入模块的全部 provider ⇒ 静态 `imports: [PrismaModule]` 会让
  `npm run test`（无库）在**装配阶段**就崩，连\"501 是默认行为\"这条用例都跑不到。
  所以\"要不要导入 `PrismaModule`\"必须在**装配时**就有答案。
- **两个世界各有各的响亮**，没有\"看起来一样\"的中间态：
  · 有库 ⇒ 第一次查库连不上就炸；查不到孩子 ⇒ **404**（不是\"余额 0\"兜底）；
  · 无库 ⇒ 每个方法 501（可执行断言）。
  **被明确排除的第三种做法**：无库时静默跳过记账 —— 那正是 B6（扣分被静默截断）的同类病。
- **用例两端各守一半**（缺一不可）：
  · 离线 `backend/test/ledger-wiring.test.ts`（**组 A–C / 8 条**）：判据纯函数、装配声明、
    以及用**替身 `PrismaService`** 证明\"有库时端口走的是**注入的**客户端\"（不是工厂里自己 `new` 一个 —— 那会绕过唯一连接池）；
  · 真库 `backend/test-db/ledger-db.dbtest.ts` **组 J**：用真 `register()` 建图、从注入器取端口，
    **读写的是真库**，并换一条连接复核（防止\"只是返回对象好看\"）。
    ★ 这条补的正是\"组 A–I 全是手工 `new` 实例 ⇒ 装到 501 上也会**全部照绿**\"的漏洞。


---

## 6. 孩子 `adjust_points` 的归一化（dispatcher 层）

矩阵中孩子 `adjust_points = DENY`。但**不能简单返回 403** —— 孩子确实有"我想要更多分"的正当诉求。

**在 `action-dispatcher` 归一化**（而非在矩阵里）：

```ts
// 孩子调用 adjust_points 时
if (role === 'child' && action === 'adjust_points') {
  if (payload.delta > 0) {
    // 归一化为"申请加分" → 走审批流（Q2 = B：孩子仅可申请正向加分）
    return dispatch('request_points_bonus', {
      ...payload,
      amount: payload.delta,
      requestedBy: 'child'
    })
  }
  // delta <= 0（孩子想给自己扣分）→ 无正当理由，且可能被自罚/炫耀滥用
  return deny('CHILD_CANNOT_DEDUCT')
}
```

**为什么在 dispatcher 而不在矩阵**：矩阵是**角色 × 动作**的静态表；
"按 `delta` 符号分流"是**参数相关**的业务逻辑。放进矩阵会让矩阵变形为代码。

**孩子申请加分的限额**（Q13 = 3 条/天，Q15 = 单笔 ±50）：
```
- 每日申请上限 3 条
- 24h 内相同事由（reason 归一化后）去重
- 单笔金额 ≤ 50
超出 → 403 CHILD_REQUEST_QUOTA_EXCEEDED（可读文案，禁止静默丢弃）
```

---

## 7. 角色模式切换（PIN）

**问题**：同一台手机，家长和孩子都要用。需要一个**低成本、可审计**的切换机制。

**设计**：服务端保存当前模式（**不信客户端**）：

```prisma
model DeviceSession {
  id         String   @id @default(cuid())
  deviceId   String
  childId    String
  userId     String
  activeRole MemberRole        // 服务端权威
  issuedAt   DateTime @default(now())
  expiresAt  DateTime          // TTL 5 分钟，到期回落 child
  @@unique([deviceId, childId])
}
```

| 规则 | 说明 |
|---|---|
| 默认角色 | `child`（**最小权限默认**）—— 手机在孩子手里时不能是家长模式 |
| 切到 `guardian` | 需输入 **PIN**（scrypt 哈希，`ChildMember.pinHash`） |
| TTL | 5 分钟无操作回落 `child`；每次 guardian 操作刷新 |
| PIN 错误 | 5 次锁定 15 分钟（防暴力） |
| 审计 | 每次切换写 `AuditLog`（含 `deviceId`） |

**为什么不存客户端**：客户端可被改（小程序 storage 可直接改）。服务端持有 `activeRole` 才能让
"家长模式"成为一个**真实的权限提升**，而不是一个 UI 开关。

### ✅ W1-C 落地注（2026-10-15）：这张表的"服务端权威"**已经是真的了**

- **落地物**：`backend/src/device-session/` 三件套 —— `session.gate.ts`（纯函数判定核）＋
  `device-session.repository.ts`（端口 `DeviceSessionPort` / 令牌 / 默认 **501**）＋
  `device-session.guard.ts`（`DeviceSessionGuard`，控制器级守卫链**第 1 位**）。
- **读的可信度**：`activeRole` / `userId` 来自**服务端会话行**；客户端只发
  `x-kp-device-id` ＋ `x-kp-child-id`（选择器），自报 `x-kp-role` / `x-kp-user-id` **不再被读取**
  （`device-session-http.test.ts` 组 A 专门钉住：自报 `guardian` 仍是 `child`）。
- **TTL**：`expiresAt === now` 即过期；`guardian` 过期 ⇒ **回落 `child`**（降级不是 401，§9.19）。
- ⚠️ **仍未落地**（与上表逐行对照）：**切到 `guardian`（PIN 校验） / 5 次锁 15 分钟 / 每次切换写审计 /
  每次 guardian 操作刷新 TTL** —— 这四行**都还没有端点**，`pinHash` / `pinLockedUntil` 至今无人使用；
  会话查询的**真 Prisma 适配器**属 W2（默认 501）。**"这张表已经全部实现"是错的**，
  现在成立的是**读路径**（"服务端说了算"这条原则）＋ **到期回落**。
- ⚠️ **凭据未认证**：`x-kp-device-id` 可被伪造 ⇒ `NODE_ENV=production` 一律 **503**（禁止上线）。

---

## 8. 邀请码（并发安全）

**问题**：邀请码的"校验剩余次数 → 插入成员 → 次数 +1"若分步执行，**并发下会超发**。

```ts
// ✗ 错误：读-改-写，两个请求可能同时通过校验
const code = await findCode(code)
if (code.usedCount >= code.maxUses) throw ...
await createMember(...)
await updateCode({ usedCount: code.usedCount + 1 })

// ✓ 正确：单条条件 UPDATE，原子占用
const rows = await prisma.$queryRaw`
  UPDATE "InviteCode"
     SET "usedCount" = "usedCount" + 1, "usedByUserId" = ${userId}, "usedAt" = now()
   WHERE code = ${code}
     AND "usedCount" < "maxUses"
     AND "expiresAt" > now()
     AND revoked = false
  RETURNING id
`
if (rows.length === 0) throw new ConflictException('INVITE_CODE_UNAVAILABLE')
// ↑ 只有真正抢到名额的请求才会继续创建成员
```

**要点**：`UPDATE ... WHERE "usedCount" < "maxUses" RETURNING` 是原子的 —— 数据库行锁保证
至多 `maxUses` 个请求能拿到 `RETURNING` 行。这比"先查后改"或"分布式锁"都更简单可靠。

> **列名勘误（裁定 D5，2026-10-12）**：本 schema **未使用 `@map` / `@@map`**
> （唯一的 `@map` 命中在 `schema.prisma:576` 的**注释**里），因此库内列名＝Prisma 字段名的
> **camelCase 原样**；PostgreSQL 会把未加引号的标识符折成小写，故本节示例**必须**写成
> `"usedCount"` / `"maxUses"` —— 原文的 `used_count` / `max_uses` 会直接报「列不存在」。
> **SQL 语义不变，只是标识符改写。**

```prisma
model InviteCode {
  id            String   @id @default(cuid())
  childId       String
  code          String   @unique
  role          MemberRole       // child | guardian | viewer
  maxUses       Int
  usedCount     Int      @default(0)
  usedByUserId  String?
  usedAt        DateTime?
  expiresAt     DateTime
  revoked       Boolean  @default(false)
  createdByUserId String
  createdAt     DateTime @default(now())
}
```

---

## 9. 验收测试计划（节选）

| # | 用例 | 期望 |
|---|---|---|
| 9.1 | 家长 `add_rule` | 201 |
| 9.2 | 孩子 `add_rule` | 403 FORBIDDEN |
| 9.3 | 孩子 `request_points_bonus(amount=10)` | 202 + `ApprovalRequest{status:pending}` |
| 9.4 | 家长 `adjust_points(-9999)` | 400 INSUFFICIENT_POINTS（**不静默截断**，B6） |
| 9.5 | 孩子 `adjust_points(delta=+10)` | 归一化为 `request_points_bonus`，202 |
| 9.6 | 邀请码并发 10 请求，`maxUses=3` | **恰好 3 成功**，7 个 409 |
| 9.7 | 家长批准后，孩子撤回 | 409 ALREADY_DECIDED |
| 9.8 | 批准兑换，但心愿在批准前被删 | `status=invalidated`, `autoReason=WISH_DELETED` |
| 9.9 | Agent 伪造 `plan.role=guardian`（实际 child） | **401，整份 plan 作废** |
| 9.10 | 同一家长双击「同意」 | 第二次 409（乐观锁），账本只扣一次 |
| 9.11 | **I1**：改规则后查历史记录 | **逐字段 diff 为空** |
| 9.12 | **I2**：`balanceAfter` 滚动求和 == 余额 | 相等 |
| 9.13 | **I6**：撤销打卡 | 记录数 **+1**（冲正），原记录保留 |
| 9.14 | **I5**：以**应用角色**直连 DB `UPDATE "PointRecord"` | 权限错误（`SQLSTATE 42501`；`npm run db:verify` 已按此判定） |
| 9.15 | 孩子 `adjust_points(delta=-5)` | 403 CHILD_CANNOT_DEDUCT |
| 9.16 | 孩子第 4 次申请加分（同日） | 403 CHILD_REQUEST_QUOTA_EXCEEDED |
| 9.17 | 孩子申请加分 51 分（Q15 = ±50） | 403 AMOUNT_EXCEEDS_LIMIT |
| 9.18 | PIN 连错 5 次 | 锁定 15 分钟 |
| 9.19 | `DeviceSession` 到期 | 角色回落 `child`（✅ W1-C：内核 `test/session-gate.test.ts` 组 C —— 含 `expiresAt === now` **边界**；真 HTTP `device-session-http.test.ts` 组 B） |
| 9.20 | 撤回同意（`GuardianConsent`） | 全链路写入停止，导出可下载 |
| 9.21 | 非成员访问 | 403 MEMBER_NOT_FOUND（✅ W1-B 已有真 HTTP 用例：`membership-http.test.ts` 组 A） |
| 9.22 | 成员级 `restrictions` 试图放宽矩阵 `DENY` | 被忽略，仍为 DENY（屏障三方向性）（✅ W1-B：内核**穷举** 25×2×6×5 ＋ HTTP 用例） |
| 9.23 | 通知发送失败 | 账本已提交不受影响（事务边界） |
| 9.24 | 孩子自助打卡 | `source=child_self`，`subtitle` **不含**"家长"（A4） |
| 9.25 | 家长建 `redeem` 请求并带 `autoApprove: true` | 直接 `approved` ＋ 生成流水；`decidedByUserId == requesterUserId`；审计 `approval.self_approved` |
| 9.26 | 孩子建 `request_redeem` 并带 `autoApprove: true` | **`400 SELF_APPROVAL_NOT_ALLOWED`**（**不得静默忽略成 `pending`** —— 客户端会以为已批） |
| 9.27 | **单家长家庭**：唯一家长提交 `redeem`，**不带** `autoApprove` | `pending`（**不自动批准**，先证明死锁已解而特权未扩）；同一家长二次确认 → `approved` |
| 9.28 | 客户端自报 `x-kp-role: guardian`，而**服务端会话**是 `child` | 仍按 `child` 判定（自报头**被忽略**，不产生任何提权）（✅ W1-C：`device-session-http.test.ts` 组 A / `approvals-http.test.ts`） |
| 9.29 | 缺 `x-kp-device-id` 或 `x-kp-child-id` | **401 `UNAUTHENTICATED`**（**不**退化成匿名 `child`）（✅ W1-C：`device-session-http.test.ts` 组 A） |
| 9.30 | 会话查询适配器**忽略** `childId` 参数（返回别人档案的行） | **500 `SESSION_CHILD_MISMATCH`**，**不放行**（✅ W1-C：内核组 D ＋ `w1c-canfail.mjs` ④） |

