# 阶段 W5-H 交接单 · 成员管理（`/members` 三条路由 · 最后一位家长 · 降级即收票）

> **状态（2026-10-22）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm run typecheck` / `typecheck:tests` / `build` | ✅ 退出码 **0** |
> | `cd backend && npm test` | ✅ **544/544**（30 个用例文件；本阶段新增 **+25**：`members-http.test.ts` 19 / `membership-gate.test.ts` +5 / `permission-matrix.test.ts` +1） |
> | `cd backend && npm run test:db` | ✅ **173/173**（11 个用例文件；本阶段新增 `members-db.dbtest.ts` **18 条 / 5 组**，**含真库并发**） |
> | `cd backend && npm run contracts:emit` | ✅ **31 个动作**（新增 `view_members` / `change_member_role`；`contracts/permission-matrix.json` 已重生成） |
> | `cd backend && npm run honesty:probe` | ✅ 4/4，其中 **D：矩阵 ↔ Prisma `ActionType` 两侧一致，共 31 个动作** |
> | `cd backend && npm run defects:check` | ✅ **19/19 `ALL PASS`**（本阶段不动台账） |
> | `cd backend && npm run test:canfail` / `test:canfail:db` | ✅ **6/6**（A/A2/B/B2/C/C2 —— C 组就是守卫 ④ 的常设证伪）＋ **11/11** |
> | 新增迁移 | ✅ **1 条**：`20261022090000_member_actions` —— 只给 `ActionType` 加 2 个枚举值，**没有 DDL 动表** |
> | Flutter / 小程序 | ⚠️ **本轮零改动**（纯服务端；双端还没有成员管理界面 —— 见 §5） |
>
> **给**：接手「双端成员管理界面」「L2 登录链路（`code2session`）」「习惯 CRUD」的下一个会话。

## 1. 本阶段做了什么

W5-G 收尾时 `ALREADY_MEMBER` 的文案里已经写着「角色只由家长在成员管理里调整」，
而那个成员管理**一行代码都没有**（`24-w5g-handoff.md` §5 第 2 条）。
本阶段把三条路由补齐，并把「家里不会一个家长都不剩」从文档承诺变成**真库并发断言**。

| 层 | 落点 | 行为 |
|---|---|---|
| 类型 / 线格式 | `backend/src/members/members.types.ts` | `MutableMemberRole = 'child' \| 'guardian'`（**排除 `viewer`**）、`MemberRow`（端口行，`Date`）、`MemberDto`（线格式，ISO 串 ＋ `isSelf`）、`MemberListResponse { items }`、`MemberRemoveResponse { memberId, status:'removed', removedAt }` |
| 端口 | `backend/src/members/members.repository.ts` | 三个方法对应三条路由；无库装配 `NotImplementedMembersRepository` 三个方法全 **501** `MEMBERS_PERSISTENCE_NOT_IMPLEMENTED` |
| 适配器 | `backend/src/members/members.prisma.repository.ts` | `listActiveMembers`（`role` 排序 ＋ `joinedAt` 次序，字段集合封闭）、`changeMemberRole`（锁 → 计数 → 条件 UPDATE → 收会话 → 审计，**一个事务**）、`removeMember`（同款，软删 ＋ 审计） |
| 业务层 | `backend/src/members/members.service.ts` | 只做三件事：`Date` → ISO、标 `isSelf`、把 actor / deviceId 透传给端口。**不**判「最后一位家长」「是不是自己」（那需要库里的事实，且必须与写入同事务回答） |
| 控制器 | `backend/src/members/members.controller.ts` | `GET /members`（`view_members`）、`PATCH /members/:id`（`change_member_role`）、`DELETE /members/:id`（`remove_member`，`@HttpCode(200)`）；三条都 **三道屏障** |
| DTO | `backend/src/members/dto/update-member-role.dto.ts` | 集合封闭：只有 `role`，且 `@IsIn(['child','guardian'])`（不是 `@IsEnum(MemberRole)`） |
| 模块 | `backend/src/members/members.module.ts` | `MembersModule.register({ hasDatabase? })`：有库 ⇒ `PrismaMembersRepository` ＋ `PrismaModule`；无库 ⇒ 501 且**不**导入 `PrismaModule` |
| 权限 | `backend/src/contracts/permission-matrix.ts` | 新增 `view_members`（guardian ALLOW / child ALLOW）、`change_member_role`（guardian ALLOW / child DENY）；`remove_member` 早已在矩阵里 |
| 读路径收口 | `backend/src/membership/membership.gate.ts` ＋ `membership.guard.ts` | `clampRoleToMembership()`：**矩阵查表用的角色 = min(会话角色, 成员位角色)**，在屏障一通过后立刻改写 `req.kpActor` |
| 接线 | `backend/src/app.module.ts` | `MembersModule.register()` |
| 用例 | `backend/test/members-http.test.ts`、`test/permission-matrix.test.ts`、`test/membership-gate.test.ts`、`test-db/members-db.dbtest.ts` | 见 §4 |
| 闸门 | `backend/scripts/run-tests.mjs` | **新增守卫 ④**：不许有「整个文件被当成一条用例」（本阶段自己踩到，见 §3.1） |

## 2. 关键实现决策

### 2.1 最后一位家长：为什么必须「锁住这个孩子的全部成员位」

「把一个家长降级 / 移出」只在**还有别的家长**时才允许。这是**集合**事实（`count(*)`），
三种写法只有一种在并发下成立：

| 写法 | 并发下会发生什么 |
|---|---|
| 先查后写 | 两个家长同时把对方降级，双方都读到 `count = 2` ⇒ **双双成功，家里一个家长都不剩** |
| 单条条件 `UPDATE … WHERE (SELECT count(*) …) > 1` | READ COMMITTED 下两条语句各看自己的语句快照，子查询也可能双双读到 2 ⇒ 同样能一起过 |
| **先 `SELECT … ORDER BY id FOR UPDATE` 锁住全部成员位，再计数、再写** | 第二笔事务等第一笔提交，在**已提交**的数据上重新计数（`FOR UPDATE` 的 EPQ 重检会丢掉已不满足条件的行）⇒ 多出来的那一笔得到 409 |

本条已落地为**真库断言**（组 D）：3 位家长环形降级 ⇒ **恰好 2 成功 / 1×409、库里恒剩 1 位家长**；
互为操作人的互删 ⇒ 1 成功 / 1×409。锁的粒度是"一个孩子的成员位"（家庭规模个位数行），
两笔事务都按 `id` 升序加锁，**不会死锁**。条件 UPDATE 里的 `count` 子查询保留作**第二道保险**
（将来若有人把锁去掉，它仍能挡住一部分错误）。

### 2.2 降级 = 同时收回会话（同一事务），读路径再收一次

`DeviceSession.activeRole` 与 `ChildMember.role` 是两份事实：前者是"这台设备此刻用什么模式"，
后者是"这个人在这个家里是什么身份"。把成员位改成 `child` 却不改会话，等于**降级只写了个字段** ——
那位家长的设备照样能改别人。所以适配器在**同一事务**里把 `(childId, userId)` 上
`activeRole='guardian'` 的会话改成 `child`（**只动这个孩子的会话**，别的家庭不受影响）。

「写路径记得同步」不该是唯一保障：只要还有一条路径（手工改库、将来的批量脚本、迁移）
留下了一张 guardian 的票，被降级的人就还能以家长身份操作。于是 `clampRoleToMembership()`
在读路径再收一次：**矩阵查表用的角色 = min(会话角色, 成员位角色)**。
这不是"提权"：会话 guardian／成员位 child ⇒ child；会话 child／成员位 guardian ⇒ child（模式没切换，本来就该是 child）；
会话 viewer ⇒ viewer（矩阵一律 DENY）。方向与 `02 §3`「屏障三只能更严」一致，收紧的是**角色本身**。

### 2.3 三条路由的权限判定：`view_members` 为什么对孩子开放

| 路由 | 动作 | guardian | child | 理由 |
|---|---|---|---|---|
| `GET /members` | `view_members` | ALLOW | **ALLOW** | 孩子本来就看得见"家里有谁"（选择器里能切到的就是他认识的）。藏起来只会让界面出现"一个匿名家长"。列表只含 `displayName` / 角色 / 时间，**不含**手机号、`openId`、PIN —— 这不是敏感数据，是"这个家有几口人"。与 `view_trash` 同一判断 |
| `PATCH /members/:id` | `change_member_role` | ALLOW | DENY | 改别人的身份就是改权限边界 |
| `DELETE /members/:id` | `remove_member` | ALLOW | DENY | 同上；且"退出家庭"是另一个产品决定（§2.4） |

`viewer` 在两列里都没有 ⇒ `resolveVerdict()` 的 fail-closed 分支一律 `DENY`
（`permission-matrix.test.ts` 新增用例专门钉这一条，防止有人"顺手"给 viewer 开一列）。

### 2.4 两条写路由都**禁止作用于自己**（403 `CANNOT_MODIFY_SELF`）

- 自我降级 = 一次误触就把自己锁在门外，而**没有家长能把你救回来**（能救的人也被你降掉了）；
- "退出家庭"需要迁移数据、决定流水归属，不该由 `DELETE /members/:id` 顺手实现。

两条都拒绝之后，「最后一位家长」保护才真正成立：只剩一位家长时，他既不能降自己、也不能被自己移出，
而别人动他就撞上 `LAST_GUARDIAN_PROTECTED`。**这两条拒绝是保护成立的前提，不是礼貌**。

### 2.5 没有 `Idempotency-Key`，也没有 `expectedVersion`

- `PATCH`：目标角色与现状相同 ⇒ 200 且**不写审计**（构造幂等）；真库组 B 钉住"连点两次只有一条 `member.role_change`"；
- `DELETE`：已经移出 ⇒ 200、`removedAt` **保持第一次的值**、不写第二条审计（同 `revoke` 的手法）。

两者都不需要缓存一个"重放结果" —— 结果本来就一样。也不加 `expectedVersion`：
版本号只能防"基于旧视图的覆盖"，而这里真正危险的并发是**两个家长同时把对方降级**，
他们看到的是**同一个版本**（§2.1 的锁才是对策）。

### 2.6 线格式**只下发事实，不下发结论**

`GET /members` 给 `role` / `status` / `isSelf`，**不**给 `canChangeRole` / `canRemove` / `actions: [...]`。
谁能对谁做什么由屏障二在服务端判定；把结论抄进线格式，等于让界面拿着一个**可能已经过期**的判断去渲染按钮。
界面该做的是「我是家长 ⇒ 显示这些入口」，被拒绝时按 403 的 `code` 解释原因。

`isSelf` 是唯一一个"服务端算、客户端不该算"的字段：客户端**不知道自己的 userId**
（身份在服务端会话里，客户端只持有设备 id），所以"这一行是不是我"只能由服务端回答。
`status` 保留也不是结论而是**库里的事实**（与 `InviteCode.revoked` 同口径）：将来若加 `includeRemoved`，
线格式不需要变。

### 2.7 移出**不删会话**

删了会话，屏障一只能回 401 `SESSION_NOT_FOUND` —— 把"你已被移出"伪装成"你没登录"，
用户会去重登、重登之后还是什么都没有。会话行留着，屏障一才会回 **403 `MEMBER_REMOVED`**，
那句话才是能解释的。真库组 C 钉住这一点（`removeMember` 之后 `DeviceSession` 行仍在）。

### 2.8 审计快照只含 `role` / `status`

`member.role_change` 的 `before/after` 是 `{role}` / `{role}`，`member.remove` 是 `{role,status}` / `{status}`。
`pinHash` / `restrictions` / `openId` **一律不进审计** —— 审计表的读取面比成员表宽得多，
把凭据的哈希抄进去等于扩大攻击面（与 W5-G「审计里不写码」同一条纪律）。

### 2.9 错误码与状态码

| 场景 | 状态 | `code` |
|---|---|---|
| 无库装配 | 501 | `MEMBERS_PERSISTENCE_NOT_IMPLEMENTED` |
| 身份缺失 / 会话失效 | 401 | `UNAUTHENTICATED` / `SESSION_NOT_FOUND` |
| 屏障一不过 | 403 | `MEMBER_NOT_FOUND` / `MEMBER_REMOVED` |
| 屏障二不过（孩子改角色 / 移出；viewer 任何写） | 403 | `FORBIDDEN` |
| 对自己下手 | 403 | `CANNOT_MODIFY_SELF` |
| 成员位不存在 / **属于别的孩子** | 404 | `MEMBER_NOT_FOUND`（两种情况**共用同一句话**，不给"这个 id 存在吗"当探测器） |
| `PATCH` 的目标成员位已是 `removed` | 409 | `MEMBER_NOT_ACTIVE`（`DELETE` 同一情形**不报错**：200 ＋ 原 `removedAt`；端口结果里 `alreadyRemoved=true`，**不上线格式**，见 §2.5） |
| 会把这个孩子降成 0 位家长 | 409 | `LAST_GUARDIAN_PROTECTED` |
| 请求体多字段 / 缺 `role` / `role='viewer'` | 400 | `VALIDATION_FAILED`（`ValidationPipe` 全局口径） |

`DELETE` 用 **200** 而不是 204：回包要与请求**验明正身**（`{memberId, status:'removed', removedAt}`），
204 无 body 就只能靠"没报错"猜（同 W5-A 的 `ruleId`、W5-G 的 `{id, revoked}` 手法）。

## 3. 本阶段踩到的坑（都是真踩的）

### 3.1 ★ 我自己的真库套件差点变成 D12 假绿

`members-db.dbtest.ts` 里 `after(async () => { … })` **少写了一个 `})`**，
于是后面 5 个 `describe` / 18 个 `it` 全被关进了 `after` 回调里。后果：

| 现象 | 说明 |
|---|---|
| 语法合法、`tsc` 不报错 | 因为括号总体**是配平的**（文件末尾多出的 `})` 正好补上） |
| 报告显示 `✔ members-db.dbtest.js (11322ms)` | Node 把**文件本身**记成一条用例 |
| `ℹ tests 1 / suites 0` | 18 条用例一条都没注册 |
| `npm run test:db` → **156/156 全绿** | 那个文件的"贡献"是 1，守卫 ② 的 `tests ≥ 文件数` 照样满足 |

**修法**：补齐 `})`，真库套件变成 `tests 18 / suites 5 / pass 18`（总计 173）。

**防复发（新增守卫 ④，`scripts/run-tests.mjs`）**：报告里出现**顶格**的 `<…>.test.js (…ms)`
行 ⇒ 红，并点名是哪个文件、提示"多半是 `describe` 被少写一个 `})` 关进了 hook 里"。
判据来自实测：健康的 30 文件 / 544 用例输出里**一行都没有**这种行。

**证伪（必须能变红，否则守卫没有牙齿）**：`scripts/test-can-fail.mjs` 的 **C / C2** 就是常设证伪 ——
每次 `npm run test:canfail` 都会在 `test/tmp-guard-probe/` **现场写**一个「`describe` 被关进 `after()`」的夹具，
交给 `run-tests.mjs`，要求**退出码非 0 且点名那个文件**，跑完在 `finally` 里删掉：

```text
✔ …\.tmp_test_build\test\tmp-guard-probe\only-nested.test.js (164.3841ms)
ℹ tests 1   ℹ suites 0   ℹ pass 1
FAIL  1 个用例文件**一条子用例都没注册**，却被记成通过：
      · .tmp_test_build\test\tmp-guard-probe\only-nested.test.js
退出码=1
```

★ 夹具里的 `it` **必须通过**（`assert.equal(1,1)`）：若它 assert 失败，Node 自己就会给非 0 退出码，
那条检查就变成「红在别的理由上」，证明不了守卫 ④ 有牙齿（这是 D-a 阶段踩过的同款坑）。
`npm run test:canfail` 因此从 4 项变 **6 项**，`test:canfail:db` 仍 11/11 —— 新守卫没有误伤。

### 3.2 另外两条（把断言写错了，不是代码错了）

- 组 A 里 `makeUser('a1-grandma')` 的默认 `displayName` 是 `DB 成员 a1-grandma`，却断言"列表里是 `null`" ⇒
  显式传 `null` 才有意义（这条断言要证的是"空昵称原样透传，不编一个默认名"）。
- 组 C 移出家长后断言"成员列表为空"——**爸爸还在列表里**。应断言"被移出的那一行不在了、爸爸还在"
  （写成空等于把"列表把幸存家长也抹掉了"当成正确行为，D13 的形状）。

### 3.3 增量编译 + 手工 `--outDir` 会给你看旧产物

`.tmp_test_build/` 里有 `tsconfig.test.tsbuildinfo`：改完源码再 `tsc --outDir .tmp_test_build`
有时**不会**重编那个文件，看到的是上一版产物（§3.1 一度因此显得"跑过了"）。
复跑前请 `rm -rf .tmp_test_build`（`npm test` 自己会清，手工命令不会）。

## 4. 用例清单

### 4.1 离线（`test/members-http.test.ts`，19 条 / 4 组）

| 组 | 覆盖 |
|---|---|
| A | 默认装配（端口未注入）⇒ 三条路由全 **501** `MEMBERS_PERSISTENCE_NOT_IMPLEMENTED` |
| B | 缺身份头 401；viewer 403；孩子三条路由 403 且**端口零调用**；被降级的会话 `PATCH` 403（读路径 clamp）；同一会话 `GET` 仍 200 |
| C | 成功路径与线格式：`{items}` / `MemberDto` 字段集合、`isSelf`、ISO 时间；`role='viewer'` 400；多字段 400；缺 `role` 400；`DELETE` 幂等（同 `removedAt`）；端口 404 / 403 / 409 原样透传 |

### 4.2 权限与屏障（`test/permission-matrix.test.ts` ＋ `test/membership-gate.test.ts`）

- 矩阵动作数 **29 → 31**，并新增一组钉住 W5-H 的六个判定（含 **viewer 一律 DENY** 的 fail-closed）；
- `clampRoleToMembership()` 5 条：guardian+guardian ⇒ guardian、guardian+child ⇒ child、
  child+guardian ⇒ child、viewer+任何 ⇒ viewer、**未知组合不得"向上"取**。

### 4.3 真库（`test-db/members-db.dbtest.ts`，18 条 / 5 组）

| 组 | 覆盖 |
|---|---|
| A `listActiveMembers` | 顺序（家长 → 孩子 → viewer，同级按 `joinedAt`）、**字段集合封闭**（多一个字段就红）、`removed` 不在列表、别家的行不混进来、空数组 |
| B `changeMemberRole` | 写库 ＋ **同事务收会话**（只动这个孩子）＋ 审计快照；**升级不碰会话**；同角色重复调用 ⇒ 无第二条审计；`CANNOT_MODIFY_SELF` / `MEMBER_NOT_FOUND`（含跨孩子）/ `MEMBER_NOT_ACTIVE` / `LAST_GUARDIAN_PROTECTED` 各自的**库内状态不变** |
| C `removeMember` | 软删（`status='removed'` ＋ `removedAt`）＋ **会话仍保留** ＋ 一条审计；重复调用 `removedAt` 不变；自我移出 403；唯一家长 409；移出**孩子**不受"最后一位家长"影响 |
| D **并发** | 3 位家长环形降级 ⇒ 2 成功 / 1×409、恒剩 1 位家长、2 条审计；互为操作人的互删 ⇒ 1 成功 / 1×409；同一降级连点两次 ⇒ 两个都成功但 `changed` 只有一次 true、一条审计 |

## 5. 仍未落地（不粉饰）

- **双端没有成员管理 UI**（Flutter / 小程序本轮零改动）：没有成员列表、角色切换、移出确认；
  三条路由目前只有 curl / 测试能调。`ALREADY_MEMBER` 的文案（"角色只由家长在成员管理里调整"）
  现在**服务端能做到了，界面上还找不到入口**。
- **"退出家庭"不存在**：`DELETE /members/:id` 刻意不接受"删自己"，所以没有自助退出路径。
  真要做，需要先决定流水归属与数据迁移（`02` 未定义）。
- **成员位没有 `updatedAt`**：`ChildMember` 没有这列，界面上"什么时候改的角色"只能查审计。
- **列表不分页、不筛 `removed`**：单孩子量小，但没有上限保护；被移出的人只能在审计里看到。
- **`viewer` 无法创建**：`PATCH` 的 `role` 只接受 `child` / `guardian`，邀请码也没有 `viewer`
  ⇒ 这个角色**只有历史数据里可能存在**（矩阵里一律 DENY）。
- **没有 PIN / 会话刷新**：`02 §7` 的 5 分钟会话 + 每次 guardian 操作刷新仍未落地。
  因此本阶段的"降级即收票"是**唯一**的降权手段，误操作只能靠另一位家长改回来。
- **审计里没有"操作人角色 vs 目标角色"的解释字段**：只有 `before/after` 的 `role`，
  "谁把谁改成什么"要靠 `actorUserId` + 快照拼。
- **未做真机联调**：本轮没有客户端改动，也就没有真机验证（与 W5-F / W5-G 结论一致）。

## 6. 复跑基线

```bash
cd backend
npm run typecheck && npm run typecheck:tests && npm run build
rm -rf .tmp_test_build          # 增量编译会给你看旧产物（§3.3）
npm test                        # → 544/544（30 文件；含本阶段 25 条）
npm run contracts:emit          # → 31 个动作（新增 view_members / change_member_role）
npm run honesty:probe           # → 4/4（D：矩阵 ↔ Prisma enum 31 一致）
npm run defects:check           # → 19/19 ALL PASS
npm run test:canfail            # → 6/6（A/A2/B/B2/C/C2，C 组常设证伪守卫 ④）

npm run db:verify               # 角色 / REVOKE / 表结构体检
npm run test:db                 # → 173/173（11 文件；members-db 18 条 / 5 组，含并发）
npm run test:canfail:db         # → 11/11
```

手工冒烟（开发库，需先 `npm run migrate:deploy` 让 `ActionType` 两个新值存在）：

```bash
curl -s http://localhost:3000/members \
  -H 'x-kp-device-id: demo-device-guardian' -H 'x-kp-child-id: demo-child'
curl -s -X PATCH http://localhost:3000/members/<memberId> \
  -H 'content-type: application/json' \
  -H 'x-kp-device-id: demo-device-guardian' -H 'x-kp-child-id: demo-child' \
  -d '{"role":"child"}'
```
