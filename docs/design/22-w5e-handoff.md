# 阶段 W5-E 交接单 · 档案改名（`PATCH /child` ＋ 双端「我的」页真写）

> **状态（2026-10-21）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm run typecheck` / `typecheck:tests` | ✅ 退出码 **0** |
> | `cd backend && npm test` | ✅ **456/456**（26 个用例文件；本阶段新增 `child-http.test.ts` 13 条 / 3 组） |
> | `flutter analyze` | ✅ 0 issue |
> | `flutter test` | ✅ **132/132**（本阶段新增 10 条：客户端 5 / store 4 / widget 1） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && npm run build:weapp` | ✅ 退出码 **0**（仅 Sass `@import` 弃用告警，仓库既有） |
> | `npx tsc -p .tmp_test/tsconfig.test.json` → `node .tmp_test/run.js` | ✅ **91/91**（老用例无回归） |
> | `node .tmp_test/run-w5e.mjs` | ✅ **10/10**（本阶段新增） |
> | 其它 runner（w4c / w4e / w5a / w5b / w5c / w5d） | ✅ 全绿（`ALL PASS`） |
> | 新增迁移 | ✅ **无**（`AuditLog.action` 是 `String`，不需要枚举迁移） |
>
> **给**：接手「习惯 CRUD / 邀请 / 头像 / 成员管理」的下一个会话。

## 1. 本阶段做了什么

「我的」页的昵称一直是**只读的死按钮**：点一下弹「只读模式」。
权限矩阵里 `edit_child_profile` 早就存在（guardian `ALLOW` / child `DENY`），
但没有任何端点兑现它。本阶段补上**唯一**的一条写入路径，并把双端的提示换成真写。

| 层 | 落点 | 行为 |
|---|---|---|
| 路由 | `backend/src/children/children.controller.ts` | `PATCH /child`，200，`@RequireAction('edit_child_profile')`，三道屏障（DeviceSession → Membership → Permissions） |
| DTO | `backend/src/children/dto/update-child-profile.dto.ts` | 只有 `name`；`@IsString @MinLength(1) @MaxLength(32)`；集合封闭，传 `childId` / `points` 一律 400 |
| 业务 | `backend/src/children/children.service.ts` | trim → 空 ⇒ 400 `CHILD_NAME_EMPTY`；`Array.from(name).length > 16` ⇒ 400 `CHILD_NAME_TOO_LONG`；回包 `{ childId, name }` |
| 端口 | `backend/src/children/children.repository.ts` | `ChildrenPort.renameChild()`；无库装配 **501** `CHILDREN_PERSISTENCE_NOT_IMPLEMENTED` |
| 适配器 | `backend/src/children/children.prisma.repository.ts` | 单事务：`SELECT … FOR UPDATE`（`status='active'`）→ 同名短路 → `UPDATE Child.name` → `AuditLog{action:'child.rename'}`；`P2025→404`、`P2002→409` |
| 装配 | `backend/src/children/children.module.ts` ＋ `app.module.ts` | `hasDatabase` 决定 Prisma 实现 / 501 实现（与 `RulesModule` / `HabitsModule` 同一手法） |
| Flutter DTO | `lib/data/write_dto.dart` | `ChildProfileDto { childId, name }`（严格：缺字段 / 类型不对 ⇒ malformed） |
| Flutter 客户端 | `lib/data/write_api.dart` | `renameChild(name)`：trim、空名在本地抛 `ArgumentError`（不发请求）、**不判长度**；回包 `childId` 必须等于会话 `childId`，否则 malformed |
| Flutter 错误文案 | `lib/data/write_api_errors.dart` | `CHILD_NAME_EMPTY` / `CHILD_NAME_TOO_LONG` → 中文（不把 400 甩给用户） |
| Flutter store | `lib/data/app_store.dart` | `isProfileWriteReadOnly` / `profileReadOnlyWriteMessage` / `submitRenameChild()`（三种世界） |
| Flutter UI | `lib/screens/profile_screen.dart` | 昵称弹窗改成 `TextFormField`（`initialValue` + `onChanged`）；成功 SnackBar「昵称已更新」，否则显示 store 返回的那句话 |
| 小程序 DTO | `kids_points_mp/src/data/write_dto.ts` | `ChildProfileDto` ＋ `write_api.ts` 的 `parseChildProfile()` |
| 小程序客户端 | `kids_points_mp/src/data/write_api.ts` | `renameChild(name)`，同上校验与 malformed 口径 |
| 小程序 store | `kids_points_mp/src/data/store.ts` | `isProfileWriteReadOnly` / `profileReadOnlyWriteMessage` / `submitRenameChild()` |
| 小程序 UI | `kids_points_mp/src/pages/profile/index.tsx` | 点头像 ⇒ `prompt()` ⇒ `store.submitRenameChild()` ⇒ `toast(message ?? '昵称已更新')`；**不再**截断到 16 字，也**不再**判全局 `isReadOnly` |
| Flutter 状态条 | `lib/widgets/read_status_banner.dart` | 可写分支文案改为「打卡 / 记一笔 / 兑换 / 昵称均会实时保存」（原文只说打卡，已经漏掉三个能力） |
| 小程序状态条 | `kids_points_mp/src/components/ReadStatusBanner/index.tsx` | 同上（两端字符串保持一致） |
| 只读文案 | 两端的 `readOnlyWriteMessage` / `profileReadOnlyWriteMessage` | 不再写「兑换 / 档案还没接后端」—— 那是旧事实；改成「写客户端未就绪或尚未接后端」 |

「我的」页剩下的两个入口（回收站、恢复演示数据）**仍然**保留只读拦截 ——
它们的后端还没接（回收站恢复 / 彻底删除、seed 重置），放开就是假写。

## 2. 关键实现决策

### 2.1 路由是 `PATCH /child`：单数、路径里没有 id

孩子身份**只**来自会话（`x-kp-device-id` + `x-kp-child-id` → `kpChildId`）。
路径里再带一个 id，就等于给客户端第二种「改谁」的写法，两者不一致时服务端只能二选一。
与 `POST /records/check-in`（习惯 id 在请求体、孩子 id 在会话）同一原则：
**身份来自会话，业务目标才来自请求**。请求体里出现 `childId` / `points` 一律 400
（`forbidNonWhitelisted`），和 `POST /point-rules` 拒绝 `direction` 同口径。

### 2.2 不带 `Idempotency-Key`，因为 PATCH 由构造幂等

同名改名在**锁内**短路：`current.name === input.name` ⇒ 直接回 200，
**不写 UPDATE、也不写 `child.rename` 审计**。于是重复提交不会产生第二份副作用，
客户端重试是安全的 —— 这比再维护一套「响应缓存 + 请求体哈希」更简单，也更诚实
（不假装保护，而是根本不需要保护）。

顺带解决审计噪声：若每次都插一条 `child.rename`，重试一次就会留下两条一模一样的
「A→A」，把审计变成流水账。PATCH 的语义是「把资源改成这个状态」，状态没变就没有变更可记。

### 2.3 单事务 + `SELECT … FOR UPDATE`：审计的 before 不能先读后写

改名本身是单行 UPDATE，看着不需要锁；但审计要写「改之前是什么」。
先读后写就是 TOCTOU：两位家长同时改 `A`，第二次的 before 可能读到已被覆盖的 `B`，
审计里就出现一条 `B→C`，而真实轨迹是 `A→B→C`。
行锁把「读旧值 / 写新值 / 记快照」收进同一临界区；`FOR UPDATE` 同时顺带确认孩子
还是 `active`（不存在 / 已删 ⇒ 404，跨孩子一律同答，不泄露「别人家有没有这个孩子」）。

库层失败只翻两类：`P2025 → 404 CHILD_NOT_FOUND`、`P2002 → 409 CHILD_NAME_CONFLICT`；
其余原样抛出 ⇒ 500，**不伪装成业务拒绝**。

### 2.4 16 个字符只有一处判据（服务端按码点）

三处「长度」用的数法完全不同：

| 位置 | 数的东西 | 16 个 emoji 的结果 |
|---|---|---|
| 小程序 `prompt()` | 原始字符串（原来还 `slice(0, 16)`） | 8 个就截断（**静默改写用户输入**） |
| DTO `MaxLength(32)` | UTF-16 code unit | 32 unit = 16 emoji ⇒ 恰好不拦 |
| `ChildrenService` | 码点 `Array.from(name).length` | 16 ⇒ 放行（**唯一业务判据**） |

所以：DTO 只做**粗上限** 32（防超长 payload、防把 10 万字符塞进锁里）；真正的 16 判定只有
`ChildrenService` 一处，错误码只有 `CHILD_NAME_EMPTY` / `CHILD_NAME_TOO_LONG` 两个。
双端输入框**不判长度**：Flutter 的 `maxLength: 16` 只是计数器（grapheme），小程序干脆不截断
（截断会让人以为「存上了」，其实存的是另一个名字）。

### 2.5 写成功后**不**重拉 `/home`（与 W4-E / W5-B 相反，是有意的）

`PATCH /child` 的回包就是档案本身，而且它在**锁内**产生 ⇒ 是权威值。
再跑一次 `refreshFromServer()` 只会多一次往返，还可能用一份**滞后**的 `/home` 快照
把刚写进去的名字盖回去（`/home` 与 PATCH 是两条独立请求，不共享事务）。
`submitRenameChild()` 因此只做：`profile.name = dto.name` → `_persist()`。
W4-E / W5-B 那两条写端点「先落地流水再刷新」是因为它们要的是**余额与流水**
（回包里没有），两条规则不冲突。用例直接钉住：改名后 `fetchHome` 调用次数**不变**。

### 2.6 只读判据用 `isProfileWriteReadOnly`，不用全局 `isReadOnly`

`isReadOnly` 当前等于「live 模式」（意即「写端点还没接」），用它挡昵称会让 live 模式
永远点不动 —— 与 W5-C 修 `isWishWriteReadOnly` 是同一个病。故每个能力一个判据：

- `isProfileWriteReadOnly = isLiveMode && _writeApi == null`；
- 预览（无后端）⇒ `false`，本地 `renameChild()` 直接生效；
- live 但写客户端构造失败 ⇒ `true`，页面显示 `profileReadOnlyWriteMessage`，
  **本地档案不动**（没保存就先改，刷新后必然打回原形，是「假成功」）。

### 2.7 顺手把「只读」相关文案改成现在的事实

W4 时代所有文案都在说「写入口还没接」；到 W5-E，「打卡 / 记一笔 / 兑换 / 昵称」
已经有端点，再说「还没接后端」就是假话：

| 位置 | 旧文案（已不成立） | 新文案 |
|---|---|---|
| 状态条（两端） | 数据来自服务器 · **打卡与撤销**会实时保存 | 数据来自服务器 · **打卡 / 记一笔 / 兑换 / 昵称**均会实时保存 |
| `readOnlyWriteMessage`（两端） | 只读模式：**兑换 / 档案**等写入**还没接后端** | 只读模式：这个操作暂时写不进去（**写客户端未就绪或尚未接后端**），没有保存。 |
| `profileReadOnlyWriteMessage`（两端） | 只读模式：昵称修改**还没有接上后端** | 只读模式：昵称修改暂时写不进去（**写客户端未就绪**），这次没有保存到服务器。 |

原因：这两个 getter 现在是「写客户端为 null」的兜底，真实原因可能是配置缺失 / 构造失败，
也可能是该能力确实没有端点（回收站恢复、恢复演示数据）。文案同时覆盖两种情况，
但**保留 `只读模式：` 前缀** —— 用例与页面都靠它识别（`contains('只读模式')`）。

## 3. 本轮真踩过的坑

| # | 坑 | 现象 | 处理 |
|---|---|---|---|
| 1 | **`npx tsx test/child-http.test.ts` 全红** | 13 条用例全 500，日志 `TypeError: Cannot read properties of undefined (reading 'renameChild')` —— 以为控制器 / 模块接错了 | tsx(esbuild) **不支持 `emitDecoratorMetadata`**，Nest 拿不到构造函数参数类型 ⇒ 注入出 `undefined`。必须走 `npm test`（tsc 编译到 `.tmp_test_build` 再跑）。**这条写下来，免得下一个人去「修」没坏的东西** |
| 2 | **`.tmp_test/dist` 多套了一层 `src/`** | 直接用 `tsc -p tsconfig.json --outDir .tmp_test/dist` 编译后，产物跑到 `.tmp_test/dist/src/data/`，而 runner `require('./dist/data/...')` 读的是**上一次的旧文件** ⇒ 改了代码用例却「全绿」 | 只用项目约定：`npx tsc -p .tmp_test/tsconfig.test.json`（`rootDir: ../src`）。改完先看 `dist/data/write_api.js` 时间戳 |
| 3 | **Flutter 弹窗的 `TextEditingController` 被 dispose 后仍在用** | 点保存抛 `A TextEditingController was used after being disposed`（`showDialog` 关掉后 `onChanged` / `then` 回调还引用 controller） | 改用 `TextFormField(initialValue: ...)` + `onChanged`，状态交给 `FormField` 自己管，页面不再 new / dispose controller |
| 4 | **弹窗 await 之后再用 `context`** | `ScaffoldMessenger.of(context)` 在 `await` 后可能已 unmounted（用户先退出页面） | `await` 之前先取 `ScaffoldMessenger.of(context)`，之后只用这个引用 |
| 5 | **小程序 `slice(0, 16)` 是静默改写** | 用户输入 20 字，界面「保存成功」，库里是前 16 字 —— 用户以为存的是自己写的 | 删掉截断，交给服务端判；超长回 400 `CHILD_NAME_TOO_LONG`，store 翻成「昵称最多 16 个字符（表情按 1 个算）」 |
| 6 | **同名短路放错层就是 TOCTOU** | 直觉写法是 service 里先查一次「名字一样吗」再调端口 —— 两次查询之间别人可能已改过 | 短路必须在**持锁的事务内**做（`lockChild()` 之后），端口返回值即权威 |

## 4. 证据（本阶段新增用例）

### 4.1 后端 `test/child-http.test.ts`（3 组 / 13 条）

| 组 | 用例 | 钉住的行为 |
|---|---|---|
| A 默认装配 | `PATCH /child ⇒ 501` | 无库时 **拒绝假装改名成功**（`CHILDREN_PERSISTENCE_NOT_IMPLEMENTED`） |
| B 身份与权限 | 缺设备头 ⇒ 401 | 身份没解析就根本到不了控制器 |
| | 孩子改档案 ⇒ 403 | 矩阵 `edit_child_profile` = guardian ALLOW / child DENY，端口零调用 |
| | viewer ⇒ 403 | 屏障一（不是成员）就拦下 |
| | 家长改档案 ⇒ 200 | 回包 `childId` 与端口收到的 `childId` 都来自会话，`operatorRole` 是真实角色 |
| C 请求形状 | 带 `childId` / 带 `points` ⇒ 400 | 集合封闭：客户端不许指定「改谁」、不许顺手改积分 |
| | 缺 `name` ⇒ 400 / 全空格 ⇒ 400 `CHILD_NAME_EMPTY` | 管道层长度 3 能过 `MinLength(1)`，trim 后在 service 拦住 |
| | 首尾空格被 trim 后才落库 | 端口收到的是 `'小明明'` 而不是 `'  小明明  '` |
| | 17 个汉字 ⇒ 400 `CHILD_NAME_TOO_LONG` | 码点计数确实生效 |
| | 16 个 emoji ⇒ **200** | 按码点而不是 UTF-16 code unit（DTO 的 32 粗上限也没误伤） |
| | 回包 `name` 以端口返回值为准 | 服务端可做进一步规范化，客户端照单全收 |

### 4.2 Flutter `test/write_api_test.dart`（新增 10 条）

| 组 | 用例 | 钉住的行为 |
|---|---|---|
| 档案写端点（5） | 请求形状 | 方法 `PATCH`、路径 `/child`、body 只有 `{name}`、身份头齐全、**没有** `Idempotency-Key` |
| | 空名本地拒 | 一个请求都不发 |
| | 回包 `childId` 与会话不一致 ⇒ malformed | 绝不把「别人家孩子」的名字写进本地档案 |
| | 400 两个业务码 | 翻成中文，不把 `400` 甩给用户 |
| | 403 | `forbidden` 分类与中文文案 |
| 档案写入口 · store 三种世界（4） | live 成功 | 用**服务端返回**的 name 覆盖 `profile.name`，`fetchHome` 调用次数不变 |
| | 名字没变 | 返回「昵称没有变化，这次没有提交。」且 0 请求 |
| | live 无写客户端 | 返回 `profileReadOnlyWriteMessage`，`profile.name` **不动** |
| | 预览 | 本地生效，返回 `null` |
| widget（1） | 「live 我的页：点头像改昵称真的 PATCH」 | 从界面点下去：弹窗输入 → 保存 → 1 次 `PATCH /child`，**不再**出现只读提示 |

### 4.3 小程序 `.tmp_test/run-w5e.mjs`（10 条）

客户端 4 条（形状 / 空名 / `childId` 不一致 / 400 两个业务码）＋ store 6 条
（live 成功且不多拉 `/home`、名字没变、live 无写客户端、预览、空名、写失败不改内存）。
与 Flutter 同构 —— **同一份语义在两端各有独立用例**，不是「一端写完另一端信它」。

## 5. 仍未落地（不粉饰）

- **只有昵称**：头像 / 生日 / `childId` 都不能改（`childId` 是主键，改它等于换一个孩子）；
  `ChildrenPort` 只有 `renameChild()` 一个方法 —— 端口不预先编造没人调用的方法。
- **孩子端永远 403**：「孩子自己改昵称」没有产品口径，矩阵就是 child DENY。
- **没有真库并发用例**：行锁 + 同名短路目前只有**端口替身**用例（`child-http.test.ts`
  用 fake 端口验证「控制器/服务层传了什么」）；`PrismaChildrenRepository` 的锁行为
  没有在真库里跑过「两个连接同时改名」的对照，建议补进 `test-db/`。
- **「我的」页另两个入口仍只读**：回收站恢复 / 彻底删除、恢复演示数据都还没有端点，
  点下去仍是只读提示（这是**如实**的，不是没做完的 UI）。
- **小程序输入弹窗依赖基础库 2.17.1**：`Taro.showModal({ editable: true })` 在更低版本上
  会退化成「只有一个确定按钮、没有输入框」，当前**没有降级 UI**（会发一个空名请求，
  由 store 回「昵称不能为空，这次没有保存。」兜住，但用户看不出为什么）。
- **改名不通知其它设备**：同一孩子换了台设备，要下拉刷新才会看到新昵称（没有推送 / 订阅）。
- **审计只记 `name`**：将来加头像等字段时，`child.rename` 的 before / after 快照要一起扩。
- **未做真机联调 / 压测**：并发同名、超长 emoji、系统输入法的组合字符（family emoji）
  只在 Node 里按码点验过，真机键盘输入未验证。

## 6. 复跑基线

```bash
# 后端
cd backend
npm run typecheck                                # 0
npm run typecheck:tests                          # 0
npm test                                         # 456/456（26 文件）
# ⚠️ 不要用 `npx tsx test/child-http.test.ts` 单独跑：tsx 不支持 emitDecoratorMetadata，
#    Nest 注入会拿到 undefined ⇒ 13 条全 500（假红，不是代码坏了）

# Flutter
flutter analyze                                  # 0 issue
flutter test                                     # 132/132

# 小程序（先现编 dist，再跑用例）
cd kids_points_mp
npx tsc --noEmit                                 # 0
npm run build:weapp                              # 0（仅有 Sass @import 弃用告警）
npx tsc -p .tmp_test/tsconfig.test.json          # 编到 .tmp_test/dist（rootDir ../src）
node .tmp_test/run.js                            # 91/91
node .tmp_test/run-w5e.mjs                       # 10/10
for f in .tmp_test/run-*.mjs; do node "$f"; done # w4c/w4e/w5a/w5b/w5c/w5d 均 ALL PASS
```
