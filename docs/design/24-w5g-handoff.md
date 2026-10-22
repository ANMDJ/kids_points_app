# 阶段 W5-G 交接单 · 邀请码（`/invites` 四条路由 · 原子占位 · 真库并发对照）

> **状态（2026-10-22）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm run typecheck` / `typecheck:tests` | ✅ 退出码 **0** |
> | `cd backend && npm run build` | ✅ 退出码 **0** |
> | `cd backend && npm test` | ✅ **519/519**（29 个用例文件；本阶段新增 +42：`invite-code.test.ts` 15 / `invites-http.test.ts` 27） |
> | `cd backend && npm run test:db` | ✅ **155/155**（10 个用例文件；本阶段新增 `invites-db.dbtest.ts` **18 条 / 7 组**，**含真库并发**） |
> | `cd backend && npm run contracts:emit` | ✅ 矩阵 **29 个动作 —— 无变化**（`invite_member` 早已在矩阵里：guardian ALLOW / child DENY） |
> | `npm run seed:demo`（真库，连跑两次） | ✅ 幂等 + 可重复演示（第二次把码**重置**为可用、把亲戚位改成 `removed`） |
> | 真 HTTP 冒烟（`node dist/main.js` + curl） | ✅ `GET /invites` 200 → `accept` 200 → 再 accept **409 `ALREADY_MEMBER`** → `usedCount=1` |
> | 新增迁移 | ✅ **无**：`InviteCode` 在 `20261012022042_w0_init` 就有，本阶段**一行 DDL 都没写** |
> | Flutter / 小程序 | ⚠️ **本轮零改动**（纯服务端；双端还没有邀请码界面 —— 见 §5） |
>
> **给**：接手「成员管理（改角色 / 移出 / 列成员）」「L2 登录链路（`code2session`）」「双端邀请码界面」的下一个会话。

## 1. 本阶段做了什么

W0 建表时 `InviteCode` 就已经在了（`code` 唯一、`maxUses` / `usedCount` / `expiresAt` / `revoked`），
`02 §8` 也写了「必须用单条条件 UPDATE 占位，**不得**先查后改」，但**没有任何端点**：
一个家庭想把爷爷奶奶拉进来，只能手工往库里插行。
本阶段把**四条路由**补齐，并把「并发不超发」这件事从文档承诺变成**真库上的断言**。

| 层 | 落点 | 行为 |
|---|---|---|
| 纯函数层 | `backend/src/invites/invite-code.ts` | 字母表（31 字符，去掉 `0/O/1/I/L`）、`generateInviteCode()`（`node:crypto.randomInt`，`pick` 可注入）、`normalizeInviteCode()`（去空白/连字符 + 转大写）、`isWellFormedInviteCode()`、`formatInviteCode()`、`withFreshInviteCode()`（撞码重试，**每次一个新事务**）、常量（`MAX_INVITE_USES=10` / `MAX_INVITE_TTL_DAYS=30` / `INVITE_SESSION_TTL_MS`） |
| 类型 / 线格式 | `backend/src/invites/invites.types.ts` | `InviteRole = 'child' \| 'guardian'`（**没有** `viewer`）、`InviteRow`（端口行，`Date`）、`InviteCodeDto`（线格式，ISO 串）、`InviteRevokeResponse { id, revoked: true }`、`InviteAcceptResponse { childId, role, sessionExpiresAt }` |
| 端口 | `backend/src/invites/invites.repository.ts` | 四个方法对应四条路由，**没有 `findByCode()`**；无库装配 `NotImplementedInvitesRepository` 四个方法全 **501** `INVITES_PERSISTENCE_NOT_IMPLEMENTED` |
| 适配器 | `backend/src/invites/invites.prisma.repository.ts` | `create`（单事务：查 active 孩子 → 建码 → `invite.create` 审计，**审计里不写码**）、`list`（`createdAt desc, id asc`）、`revoke`（条件 `UPDATE … WHERE revoked=false RETURNING`，0 行再分「已吊销」/「不存在」）、`accept`（原子占位 + 成员位 + 设备会话 + `member.join` 审计，**全在一个事务**）、`P2002/P2003` 映射 |
| 业务层 | `backend/src/invites/invites.service.ts` | 天 → 绝对时刻（`DAY_MS` 只在这里出现一次）、规范化 + 形状校验（400 `INVITE_CODE_MALFORMED`）、`Date` → ISO。**不**判断「码还能不能用」、**不**判断「孩子还在不在」 |
| 控制器 | `backend/src/invites/invites.controller.ts` | `POST /invites`、`GET /invites`、`POST /invites/:id/revoke`（三条 `@RequireAction('invite_member')` + 三道屏障）、`POST /invites/accept`（**只有身份屏障**，理由见 §2.1） |
| DTO | `backend/src/invites/dto/create-invite.dto.ts`、`dto/accept-invite.dto.ts` | 建码集合封闭：只有 `role`（`@IsIn(['child','guardian'])`）/ `maxUses`（1..10）/ `expiresInDays`（1..30）；accept 只有 `code`（1..32，粗上限） |
| 模块 | `backend/src/invites/invites.module.ts` | `InvitesModule.register({ hasDatabase? })`：有库 ⇒ `PrismaInvitesRepository` + `PrismaModule`；无库 ⇒ 501（**不**导入 `PrismaModule`）。`hasDatabase` 向下传给 `DeviceSessionModule` / `MembershipModule`，**只有一个来源** |
| 接线 | `backend/src/app.module.ts` | `InvitesModule.register()`（省略参数 ⇒ 按环境推断，生产代码唯一允许的省略处） |
| 演示数据 | `backend/prisma/seed/demo-family.ts`、`package.json` 的 `seed:demo` | 一次性造齐「孩子 + 家长成员位 + 两台设备会话 + 一张可重复演示的码」，`NODE_ENV=production` 直接拒绝 |
| 用例 | `backend/test/invite-code.test.ts`、`backend/test/invites-http.test.ts`、`backend/test-db/invites-db.dbtest.ts` | 见 §4（离线 42 条 + 真库 18 条） |

## 2. 关键实现决策

### 2.1 `accept` 是全项目**唯一**一条「只有身份屏障」的路由

前三条路由的被授权人是**这个孩子的现有成员**，所以「屏障一（成员位）+ 屏障二（矩阵）」问得出问题。
`accept` 的被授权人**按定义还不是**成员 —— 这正是它的用途。若也要求「先有成员位」，
这条路由对真正的被邀请人永远 403，成为一条只对内部人可用的死路。

于是判据变成「**持有家长签发的码**」：

- 屏障一（成员资格）由**码本身**替代：guardian 生成、有次数上限、有有效期、可吊销，且占位是库层面原子的；
- 屏障二（矩阵）没有可查的列：矩阵描述的是「成员对某孩子的操作」，非成员无意义，`resolveVerdict()` 查不出结论；
- **身份屏障保留**：`accept` 不能匿名调用 —— 它要往 `ChildMember` / `DeviceSession` 写一个 `userId`，
  而「你是谁」必须来自服务端会话（`x-kp-device-id` + `x-kp-child-id` 能查到会话行），不是请求体。

⚠️ 因此它的前提是：**调用方已经在某处有一个会话**。全新设备上「第一次加入」还需要登录链路
（L2 / `code2session`，`05 §6` 的阻塞项）—— 本轮**不假装已经有了**，`prisma/seed/demo-family.ts`
就是专门把这套前提一次造齐、好让这条路由能被手工验证的。

### 2.2 原子占位就是一条 `UPDATE … RETURNING`，端口上**没有** `findByCode()`

```sql
UPDATE "InviteCode"
   SET "usedCount" = "usedCount" + 1, "usedByUserId" = $1, "usedAt" = now()
 WHERE code = $2 AND "usedCount" < "maxUses"
   AND "expiresAt" > now() AND revoked = false
RETURNING id, "childId", role::text, "createdByUserId"
```

行锁保证**至多 `maxUses` 个请求**拿到 `RETURNING` 行。`02 §8` 的「不得先查后改」在这里是
**结构性**保证：端口上根本没有「只查不占」的方法，下一个人想写 TOCTOU 得先改端口签名。

⚠️ 与 `02 §8` 示例的差异：示例用 snake_case（`used_count`），而 `schema.prisma` **没用 `@map`**，
列名是 camelCase 且必须带引号（W0 决策 D5，`06 §3`）。照抄示例 SQL 会直接 `column does not exist`。

### 2.3 占位与成员位必须在**同一个事务**里：失败要能回滚名额

`ALREADY_MEMBER` / `DEVICE_SESSION_CONFLICT` / 成员位唯一约束冲突都发生在**占位成功之后**。
抛错 ⇒ 整个事务回滚 ⇒ `usedCount` 回到原值 —— 用户什么也没得到，就**不许烧掉一次名额**。

两类失败的机制**不一样**，用例分开钉（`invites-db.dbtest.ts` 组 D）：
「过期 / 已吊销 / 码不存在」是条件 `UPDATE` **匹配 0 行**（根本没占位），
「已是成员 / 设备会话冲突」是**占位成功后抛错 → 整笔回滚**。两者的可观测结论相同：
`usedCount` 仍是 **0**。

### 2.4 撞码重试必须**每次都开新事务**

`code` 上有唯一约束，两个请求同时生成同一个码时一个成功一个 `P2002` —— 这是**正常的**并发结果。
但 PostgreSQL 的事务一旦报错就进入 aborted 状态，同一事务里后续语句全部失败，
所以在同一个事务里重试是**假的**（第二次开始只会收到 `current transaction is aborted`）。
`withFreshInviteCode()` 因此把「一次尝试」整体包在 `$transaction` 里：失败就回滚整笔（含审计），
下一个码重开一笔。重试 5 次仍撞 ⇒ **抛最后一次的真实撞码错误**（纯函数层不编一个「重试失败」），
再由适配器的 `mapWriteError()` 映射成 409 `INVITE_CODE_GENERATION_FAILED`（概率 `(1/31^8)^5 ≈ 0`）。

### 2.5 「不存在 / 已用完 / 已过期 / 已吊销」对客户端是**同一句话**

四种情况都收敛成 409 `INVITE_CODE_UNAVAILABLE`。区分它们会让 `accept` 变成
「哪些码存在」的探测器（枚举 8 位码本来就很便宜），而用户能做的动作完全相同：**找家长再要一个**。

### 2.6 形状错是 **400**，码不可用是 **409** —— 两类失败不许互相伪装

`DEMO234`（7 位）/ `DEMO234O`（含 `O`）这类是**输入**问题：用户只是抄漏/抄错了字符，
告诉他「邀请码已失效」会让他去找家长重发。所以 DTO 过后再由
`isWellFormedInviteCode()` 判一次，不合形状 ⇒ 400 `INVITE_CODE_MALFORMED`（回包里带上收到的原文）。
规范化只做**无歧义**转换（去空白、去连字符、转大写），**不**猜「`O`→`0`」—— 字母表里本来就没有 `O`。

### 2.7 已是成员 ⇒ 409 `ALREADY_MEMBER`，且**不烧名额、不改角色**

重复点「加入」不是需要缓存掉的错误，而是正确答案：告诉用户「你已经是成员了，这次没消耗名额」。
角色只由家长在成员管理里改 —— 否则一个人可以用一张 `guardian` 码给自己**升级**（`02 §8` 的
「不能给别人比自己更高的角色」的另一面）。并发下 `@@unique(childId,userId)` 是最终裁判：
`P2002` 也翻成 `ALREADY_MEMBER`（不是 500）。

### 2.8 曾被移出的人用新码**回来**，复用同一行；共享平板冲突要响亮

- `ChildMember` 的唯一约束是 `@@unique([childId,userId])`，所以「回来」只能 `update` 那一行：
  `status='active'`、`removedAt=null`、`joinedAt=now`、`role` 以**新码**为准（`invitedByUserId` 也换）。
  库里**不会**多出第二行 —— `invites-db.dbtest.ts` 组 E 钉住「id 不变」。
- 这台设备在这个孩子上已经有**别人**的会话 ⇒ 409 `DEVICE_SESSION_CONFLICT`，**不静默覆盖**。
  静默覆盖 = 把那位家长的会话悄悄变成新加入者的（一份凭据被顶掉），而共享平板在家里很常见。

### 2.9 审计里**不写码**，只记 `inviteCodeId`

`AuditLog` 的读取面比邀请码列表宽（`02 §8`）。码是**凭据**，写进审计等于把它复制到一个
「不该看见也能看见」的地方。因此 `invite.create` 的 `after` 只有 `{role, maxUses, expiresAt}`，
`member.join` 的 `after` 只有 `{role, inviteCodeId}`。

### 2.10 四条路由都**不加** `Idempotency-Key`

- `create`：每次调用**应该**产生一个新码（这不是重放同一个请求）。加幂等键会让
  「我刚才那个码呢」变成一个查不到的状态；
- `revoke`：**构造幂等** —— 已吊销再吊销回同一个 200，且**不写第二条** `invite.revoke` 审计；
- `accept`：次数上限本身就是并发判据（条件 UPDATE），重复提交得到 `ALREADY_MEMBER` 且不烧名额。

### 2.11 会话 TTL 是 **30 天**，不是 `02 §7` 的 5 分钟（已知偏差，回包如实返回）

`02 §7` 的 5 分钟口径前提是**PIN 校验切换角色**，而那条写路径**至今没有端点**。
若这里也发 5 分钟，一位刚用邀请码加入的共同监护人会在 5 分钟后悄悄掉回 `child`，
且**没有任何办法**把角色提回去 —— 表现为「家长按钮突然全变 403」。
所以本轮按**设备登录**口径发 30 天（`INVITE_SESSION_TTL_MS`），并在回包里给出
`sessionExpiresAt`（不隐瞒期限）。**PIN 落地后这里必须改回 5 分钟 + 每次 guardian 操作刷新。**

### 2.12 `viewer` **不是**可邀请角色；可邀请角色只有两个

矩阵里没有 viewer 的列（一律 DENY，`02 §2` D6）。发一张 viewer 邀请码 = 邀请一个
**加入后什么都做不了**的人 —— 一张「看起来很客气、实际是死路」的票。
所以 DTO 用 `@IsIn(['child','guardian'])` 而不是 `@IsEnum(MemberRole)`；要放开必须先给矩阵加列。
适配器读到 `viewer`（只可能来自直接改库）⇒ **500** `INVITE_ROLE_UNUSABLE`：
混报成 409 会让「有人手改过库」被当成「这个码不可用」查很久（D3b 同一条纪律）。

### 2.13 `GET /invites` 同样要求 `invite_member`

列表回的是**码本身**，而码就是钥匙：看得见 = 可以拿去加入。
一个「只读查看」权限在这里没有意义，所以矩阵里**没有** `view_invites`，也不该有。
列表排序 `createdAt desc, id asc`（同毫秒批量造数时顺序才稳定），**不分页**（见 §5）。

## 3. 本轮真踩过的坑

1. **演示码 `DEMO2345` 其实是不合法形状**（字母表里没有 `O`）。脚本注释里还写着
   「只含字母表内字符」，而它自己就不满足 —— 真 HTTP 冒烟时 `accept` 立刻回
   400 `INVITE_CODE_MALFORMED`。**修法不是换个字符串了事**：脚本现在 `import`
   真实的 `isWellFormedInviteCode()` 并在写库前**断言**，演示码换成 `MAMA2345`。
   教训：任何"手写一个合法 X"的地方，都要让**同一个校验器**来说话。
2. **邀请码用例的夹具撞上了唯一约束**。最初的 `codeFor(label)` 用「base-31 多项式哈希」
   把 label 变成码，但 `label` 的 `charCode` 在 48–122，**远大于 31**，多项式退化成
   `charCode` 的线性组合 ⇒ 第一次跑就在 `InviteCode_code_key` 上撞车（P2002）。
   现改为**构造性**派生：`((种子 % 块数) * 4096 + 严格递增计数器) % 31^8`，
   同一轮内两两不同不需要概率论证，跨轮靠种子（来自 UUID）落在不同块。
   教训：**"看起来像哈希"的函数不等于单射**，夹具的唯一性要能一眼看出来。
3. **`tsx` 按 CJS 编译，seed 脚本不能顶层 await**（`06 §10` 缺陷 14 的老坑，本轮又踩一次）：
   写成 `void main().finally(...)`。
4. **`prisma/**` 仍然不在任何 tsconfig 的 include 里**（`06 §10` 缺陷 12 未修）：
   `npm run typecheck` **不会**检查 `prisma/seed/demo-family.ts`。本轮手动跑了一次
   `npx tsc --noEmit --ignoreConfig --strict --noUnusedLocals … prisma/seed/demo-family.ts`
   才算验过。谁要在 seed 里写 TypeScript，请照做（或先把这个缺陷修掉）。
5. **相对路径少一层**：`prisma/seed/` 里写 `../src/...` 会解析到 `prisma/src/...`，
   而报错只说 `Cannot find module '../src/invites/invite-code'`（不带扩展名），
   看起来像 tsx 解析不了 `.ts` —— 实际是路径错。正确是 `../../src/...`。

## 4. 证据（本阶段新增用例）

### 4.1 `test/invite-code.test.ts`（4 组 / 15 条，纯函数，不建图不连库）

| 组 | 钉住的事 |
|---|---|
| A：字母表（31 字符、去掉易认错的 5 个） | 长度 31、**不含** `0 O 1 I L`、无重复；`generateInviteCode()` 生成的码**每一个都**通过 `isWellFormedInviteCode()`；`pick` 注入后是确定性的 |
| B：规范化只做无歧义转换 | `ab-cd efgh` / `  ABCD EFGH ` / 小写 ⇒ 同一个裸码；**不**把 `O`→`0`、`l`→`1`（猜错会把"输错了"变成"码无效但看起来对"） |
| C：`withFreshInviteCode` | 撞码 ⇒ 换码重试并最终成功；用尽次数 ⇒ 抛**最后一次的真实撞码错误**（不编一个"重试失败"，`409` 由适配器映射）；**非撞码错误立刻上抛**（不吞成"重试中"，也不多生成码） |
| D：常量（产品口径，改它要改文档） | `MAX_INVITE_USES=10`、`MAX_INVITE_TTL_DAYS=30`、`INVITE_CODE_LENGTH=8`、`INVITE_SESSION_TTL_MS=30 天` |

### 4.2 `test/invites-http.test.ts`（4 组 / 27 条，真 Nest 图 + 端口替身）

| 组 | 钉住的事 |
|---|---|
| A：默认装配（端口未注入）⇒ 四条路由全 **501** | 空列表会被读成「还没有邀请码」（然后生成第二个一模一样的码），假装加入成功更坏 —— 宁可明确失败 |
| B：管理侧三道屏障 / 加入侧只有身份屏障 | 缺 `x-kp-device-id`/`x-kp-child-id` ⇒ 401；无成员位 ⇒ 403 `MEMBER_NOT_FOUND`；**孩子**发码/列表/吊销 ⇒ 403 且**端口零调用**；`accept` 不做成员位检查（否则被邀请人永远 403） |
| C：家长路径与响应形状 | `POST /invites` 201 `{id,code,role,maxUses,usedCount,expiresAt(ISO),revoked,createdAt(ISO)}`；`GET /invites` `{items:[…]}`；`POST /:id/revoke` 200 `{id,revoked:true}`；`accept` 200 `{childId,role,sessionExpiresAt}`；`childId` 只来自会话（带 `?childId=` 也不影响）；`accept` 传给端口的是**已规范化**的裸码 |
| D：形状 400 / 业务 409 —— 两类失败不许互相伪装 | 7 位 / 含 `O` / 空串 ⇒ 400 `INVITE_CODE_MALFORMED`（端口零调用）；端口 409 `INVITE_CODE_UNAVAILABLE` / `ALREADY_MEMBER` / `DEVICE_SESSION_CONFLICT` 原样映射成 409（**不翻成 500**）；404 `INVITE_NOT_FOUND` / `CHILD_NOT_FOUND` 同样原样透传 |

### 4.3 `test-db/invites-db.dbtest.ts`（7 组 / 18 条，**真库**）

| 组 | 钉住的事 |
|---|---|
| A：`createInvite` | 真写入一行；`invite.create` 审计**没有码**（`JSON.stringify(after)` 里搜不到 code）；孩子不存在 ⇒ 404 `CHILD_NOT_FOUND` 且**一行都没留下**；`role=child` 的码按 child 落库 |
| B：`listInvites` | 只看得到**自己孩子**的行（别的孩子的码不出现）；排序 `createdAt desc` |
| C：★ **并发不超发** | `maxUses=3`，**10 个请求同时** accept ⇒ **恰好 3 成功、7 个 409 `INVITE_CODE_UNAVAILABLE`**，`usedCount` 恒为 **3**，成员位 3 行、会话 3 行（与成功数一致）。这是 `02 §9.6` 的验收条件，也是本轮唯一"文档承诺 → 真库断言"的闭环 |
| D：★ **占位失败回滚** | `ALREADY_MEMBER` / `DEVICE_SESSION_CONFLICT` 之后 `usedCount` 仍是 **0**（用户没得到东西，名额不许烧） |
| D-续：过期 / 吊销 / 不存在 | 三种都收敛成 409 `INVITE_CODE_UNAVAILABLE`；过期码 `usedCount` 仍是 0；吊销码 `revoked` 保持不变 |
| E：★ 加入成功写了什么 | 成员位 `active` + `invitedByUserId` = 码的创建者；设备会话按 `(deviceId, childId)` 建/更；`member.join` 审计带 `inviteCodeId` 但**不带码**；**曾被移出的人**用新码回来 ⇒ **复用同一行**（id 不变）；同一人再点一次 ⇒ 409 `ALREADY_MEMBER` |
| F：`revokeInvite` | 吊销**构造幂等**（再吊销回同一 200、**审计不增加**）；跨孩子 ⇒ 404 `INVITE_NOT_FOUND` 且那一行**没有被吊销**；吊销后再 accept ⇒ 409 |

### 4.4 真 HTTP 冒烟（`node --env-file=.env dist/main.js` + `curl`，2026-10-22 实跑）

```text
== 1) GET /invites（家长 demo-device-guardian）—— HTTP 200
{"items":[{"id":"cmvicpamu00035wmxkrkfqocq","code":"MAMA2345","role":"guardian","maxUses":3,
  "usedCount":0,"expiresAt":"2026-10-28T17:04:10.110Z","revoked":false,
  "createdAt":"2026-10-21T16:53:09.270Z"}]}

== 2) POST /invites/accept（亲戚 demo-device-relative，code=MAMA2345）—— HTTP 200
{"childId":"demo-child","role":"guardian","sessionExpiresAt":"2026-11-20T17:07:31.311Z"}

== 3) 再点一次 —— HTTP 409
{"code":"ALREADY_MEMBER","message":"你已经是这个孩子的成员了，这次没有消耗邀请码，
  角色也没有被改变。（角色只由家长在成员管理里调整。）"}

== 4) GET /invites —— HTTP 200，usedCount 从 0 变 1
{"items":[{"id":"cmvicpamu00035wmxkrkfqocq","code":"MAMA2345","role":"guardian","maxUses":3,
  "usedCount":1,"expiresAt":"2026-10-28T17:04:10.110Z","revoked":false,
  "createdAt":"2026-10-21T16:53:09.270Z"}]}
```

四行合起来正好是本阶段要证的四件事：**看得见码 / 能用 / 不能重复用（且不烧名额）/ 用掉了 1 次**。
`sessionExpiresAt` 与加入时刻恰好差 30 天 —— §2.11 的 TTL 在真 HTTP 路径上也是同一个值。
冒烟完再跑一次 `npm run seed:demo` 把演示状态复位（`usedCount=0` + 亲戚位改回 `removed`），
下一个人拿到的还是同一个 `MAMA2345`。


## 5. 仍未落地（不粉饰）

- **`accept` 对「全新设备上的第一次加入」仍然不可用**：它要求调用方已有一个
  `DeviceSession` 行，而「设备 → 用户」的绑定本该由登录（L2 / `code2session`，`05 §6`）完成。
  本轮把这条前提**写清楚**（controller 头注释 + 演示脚本），没有假装它能工作。
  换句话说：**现在的邀请码能解决"已有账号的人加入新家庭"，不能解决"新用户注册"。**
- ~~**没有成员管理端点**~~ → **W5-H 已补齐**（`GET /members` / `PATCH /members/:id` /
  `DELETE /members/:id`，含最后一位家长并发保护与降级即收回会话，见
  [`25-w5h-handoff.md`](./25-w5h-handoff.md)）：改角色 / 移出成员 / 列出成员都有端点了，
  但**双端仍然没有界面**。`ALREADY_MEMBER` 的文案里写着「角色只由家长在成员管理里调整」，
  现在服务端能做到了，界面入口还没有。
- **双端没有任何邀请码 UI**（Flutter / 小程序本轮零改动）：没有「生成 / 复制 / 吊销」面板，
  也没有「输入邀请码加入」的输入框。四个端点目前只有 curl 能用。
- **`accept` 没有速率限制**：码空间是 `31^8 ≈ 8.5×10^11`，爆破在工程上不可行，但
  「一个人拿着一个已知码反复试」这件事没有任何节流。全项目也还没有 `@nestjs/throttler`。
- **邀请码列表不分页**：单孩子量小，但没有上限保护。
- **`usedByUserId` 只记最后一个人**：`maxUses>1` 时那条 UPDATE 每次都覆盖它，
  所以「这个码被哪几个人用过」查不出来。要回答这个问题需要一张 `InviteCodeUse` 明细表
  （现在是靠 `member.join` 审计里的 `inviteCodeId` 反查，能查但不直观）。
- **`inviteCodeId` 在审计里是"引用"而非外键**：`AuditLog.targetId` 没有约束，
  邀请码行若被物理删除（目前没有这种路径），审计里的 id 会变成孤儿。
- **PIN 相关的会话语义仍未落地**：见 §2.11 —— 30 天 TTL 是**已知偏差**，
  `02 §7` 的 5 分钟 + 每次 guardian 操作刷新要等 PIN 端点。
- **没有真机联调**：本轮没有任何客户端，也就没有真机验证（与 W5-F 的结论一致）。
- **`prisma/**` 仍不在 tsconfig include 里**（见 §3 第 4 条）：演示脚本的类型检查靠手动命令。

## 6. 复跑基线

```bash
# 后端（离线）
cd backend
npm run typecheck && npm run typecheck:tests && npm run build
npm test                                   # → 519/519（29 文件；含本阶段 42 条）
npm run contracts:emit                     # → 29 个动作（本阶段**不会**改动矩阵文件）

# 后端（真库）
npm run db:verify                          # 角色 / REVOKE / 表结构体检
npm run test:db                            # → 155/155（10 文件；含 invites-db 18 条 / 7 组）
npm run test:canfail:db                    # 诚实性：注入必失败项必须红

# 演示数据 + 手工冒烟（会写真实的行，仅限开发库；NODE_ENV=production 会拒绝）
npm run seed:demo                          # 幂等、可重复：重置 DEMO 码、把亲戚位改回 removed
node --env-file=.env dist/main.js &        # 起服务（端口 3000）
curl -s http://localhost:3000/invites \
  -H 'x-kp-device-id: demo-device-guardian' -H 'x-kp-child-id: demo-child'
curl -s -X POST http://localhost:3000/invites/accept \
  -H 'content-type: application/json' \
  -H 'x-kp-device-id: demo-device-relative' -H 'x-kp-child-id: demo-child' \
  -d '{"code":"MAMA2345"}'                 # → {childId, role, sessionExpiresAt}
```

演示脚本的会话 TTL 直接 `import` 了 `INVITE_SESSION_TTL_MS`（它自己在注释里也写了理由：
两处各写一个 30 天，等 PIN 落地改回 5 分钟时必然漏一处）。



