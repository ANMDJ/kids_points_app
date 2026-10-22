# 阶段 W5-I 交接单 · 双端邀请码界面（生成 / 列表 / 吊销；接受加入仍未建）

> **状态（2026-10-22）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm run typecheck` / `typecheck:tests` | ✅ 退出码 **0**（本阶段**后端零改动**） |
> | `cd backend && npm test` | ✅ **544/544**（30 个用例文件，与 W5-H 基线一致；邀请码服务端在 W5-G 已收口） |
> | `cd kids_points_app && flutter analyze` | ✅ `No issues found!`（13.9s） |
> | `cd kids_points_app && flutter test test/write_api_test.dart` | ✅ **98/98**（本阶段新增 **+8**：邀请码拉取 / 生成 / 吊销） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && npm run build:weapp` | ✅ 退出码 **0**（仅既有 Sass `@import` 弃用告警，**无** `ERROR` / `error TS`） |
> | `cd kids_points_mp && node .tmp_test/run-w5i.mjs` | ✅ **19/19**（types 3 / mapper 2 / store 9 / client 5） |
> | 权限矩阵 | 本轮**不加动作**：三条路由复用 W5-G 的 `invite_member`（guardian ALLOW / child DENY），仍是 **31 个动作** |
>
> **给**：接手「`POST /invites/accept` 客户端接线（依赖 L2 登录）」「真机联调」「成员管理双端 UI（W5-H 遗留）」的下一个会话。

## 1. 本阶段做了什么

W5-H 收尾时，`ALREADY_MEMBER` 的文案已经写着「让家长发一个邀请码」，
而**双端都没有任何生成 / 查看邀请码的入口**（`25-w5h-handoff.md` §5），
服务端 `POST/GET /invites`、`POST /invites/:id/revoke` 只有 curl 能调。
本阶段把「家长生成 → 复制发给家人 → 用不掉就吊销」这条链路在 Flutter 与小程序两端接上。

| 端 | 层 | 落点 | 行为 |
|---|---|---|---|
| 双端 | 模型 | `lib/models/invite.dart`（145 行）／ `kids_points_mp/src/data/types.ts`（§邀请码） | `InviteCode`（`expiresAt` 为绝对时刻）、`InviteCodeStatus` 四态、`statusAt(now)` / `inviteStatusOf(invite, now)`、`remainingUses`、`displayCode`、`usageText`、`expiresText`、`statusLabel`、`revokedInviteCopy()` |
| Flutter | 只读 | `lib/data/read_dto.dart`、`read_mapper.dart`、`read_api.dart` | `GET /invites` → `InviteListResponse { items }` 严格 DTO；`usedCount > maxUses` 之类越界值不崩、由 `remainingUses` 夹到 0 |
| Flutter | 写入 | `lib/data/write_dto.dart`、`write_api.dart`、`write_api_errors.dart` | `POST /invites`（只有 `role` / `maxUses` / `expiresInDays`）、`POST /invites/:id/revoke`（**无请求体**）；错误归一（400 `INVITE_CODE_MALFORMED` 类形状错、409 撞码 / 角色变了、404 `INVITE_NOT_FOUND`） |
| Flutter | 状态 | `lib/data/app_store.dart` | `invites` / `invitesError` / `invitesReadStatus` / `busyInviteId` / `isInviteWriteBusy` / `isInviteWriteReadOnly` / `canManageInvites`（= `canManageMembers`）、`refreshInvites()`、`submitCreateInvite()`、`submitRevokeInvite()` |
| Flutter | UI | `lib/screens/sheets/invite_sheet.dart`（519 行）＋ `lib/screens/profile_screen.dart` 入口 | 生成卡片（角色 / 名额 / 有效期 chips）、列表行（码 + 状态徽标 + 角色·名额 + 有效期 + 复制 / 吊销）、空态三分、错误行 + 重试、「我的」菜单新增「邀请码」 |
| 小程序 | 只读 | `src/data/read_dto.ts`、`read_mapper.ts`、`read_api.ts` | 同形状；`expiresAt` / `createdAt` 解析成 `number`（毫秒） |
| 小程序 | 写入 | `src/data/write_dto.ts`、`write_api.ts`、`write_api_errors.ts` | 同两条路由；`createInvite()` **不带** `Idempotency-Key`（每次生成都是新码） |
| 小程序 | 状态 | `src/data/store.ts` | `invites` / `invitesError` / `memberError` / `invitesReadStatus` / `busyInviteId` / `isInviteWriteBusy` / `isInviteWriteReadOnly` / `inviteReadOnlyWriteMessage` / `canManageInvites`、三个动作方法 |
| 小程序 | UI | `src/sheets/InviteSheet.tsx`（376 行）＋ `src/sheets/sheets.scss`（`kp-invite__*`）＋ `src/pages/profile/index.tsx` | 与 Flutter 同构：角色闸门、生成表单、列表、空 / 错 / 重试、预览模式与孩子视角提示；`Taro.setClipboardData` 复制裸码 |
| 用例 | — | `test/write_api_test.dart`（+8）、`.tmp_test/run-w5i.mjs`（新建，19 条） | 见 §4 |

## 2. 关键实现决策

### 2.1 打开面板先拉成员，再拉邀请码 —— 顺序是**权限**决定的，不是习惯

`invite_member` 在矩阵里是 **guardian ALLOW / child DENY**（`02` §3），
而客户端唯一的「我是谁」来源是 `GET /members` 里 `isSelf === true` 那一行
（W5-H 刻意只下发事实、不下发结论，见 `25-w5h-handoff.md` §2.6）。于是：

```text
打开面板 → refreshMembers()（拿到 selfMember.role）
        → canManageInvites ? refreshInvites() : 不发请求
```

- 直接拉 `/invites` 也能让家长看到列表，但**孩子必然吃 403** —— 用一次注定失败的请求
  「探测」角色，既多付一轮往返，又必须把 403 与断网分开渲染，否则会画成「加载失败」。
- 角色没拉到时（`selfMember == null`）**既不给表单也不说「你不是家长」**：
  两种猜法都会把真实原因（403 / 断网 / 成员接口 501）藏起来。此时只画
  「正在确认你的家庭成员身份…」或错误行 + 重试。
- 重试按钮走 `refreshMembers → refreshInvites` 的**同一条** bootstrap，不复用「只刷列表」，
  因为失败的那个请求很可能就是成员请求。

### 2.2 状态是**渲染时现算**的，缓存结论会说谎

```text
status = revoked > exhausted > expired > usable
```

优先级**不按「严重程度」排，按「确定性」排**：

- `revoked` / `exhausted` 是**库里的既成事实**（`revoked=true`、`usedCount >= maxUses`），
  与客户端时钟无关；
- `expired` 依赖 `Date.now()`。若把它排在前面，同一张「已用满且已过期」的码
  在两台时钟不同的手机上会显示不同徽标，而「已用完」才是它不能再用下去的**真实原因**。

因此 `inviteStatusOf(invite, now)` 每次都传当前时刻（`InviteSheet.tsx` 的 `inviteRow`、
Flutter 的 `statusAt(DateTime.now())`），**不存** `isExpired` 布尔值：
弹窗开着跨过有效期时，缓存下来的 `expired` 会一直说「可用」。

### 2.3 生成表单是**封闭选项**，不是自由输入

| 字段 | UI 选项 | 服务端允许 | 为什么 UI 更窄 |
|---|---|---|---|
| `role` | 孩子 / 家长 | `child \| guardian`（`@IsIn`，**排除 viewer**） | `viewer` 在矩阵里没有列，发出去等于邀请一个「加入后什么都做不了」的人（`create-invite.dto.ts` 注释） |
| `maxUses` | 1 / 3 / 5 人 | `1..10`（`MAX_INVITE_USES`） | 常用子集；自由输入只会换来 400，不如直接给合法集合 |
| `expiresInDays` | 1 / 7 / 30 天 | `1..30`（`MAX_INVITE_TTL_DAYS`） | 同上；30 天就是上限，过期后必须重发 |

- 表单默认「孩子 · 1 人 · 7 天」——最常见的「给另一个孩子开号」。
- 客户端**不接受 `expiresAt`**：只说「要几天」，绝对时刻由服务端算
  （`invites.service.ts` 的 `new Date(Date.now() + days * DAY_MS)`），客户端不决定凭据。

### 2.4 生成**不加**幂等键；吊销是构造幂等；回包要**回显校验**

- `POST /invites` 每次调用都**应该**产生一个新码。加 `Idempotency-Key` 会让
  「我刚生成的那个码呢」变成一个查不到的状态（`invites.controller.ts` 注释），
  所以 `write_api` 的 `createInvite()` 刻意不带这个头。
- `POST /invites/:id/revoke` 不需要幂等键：服务端已吊销再吊销仍是 200，
  且**不写第二条审计**；客户端本地也不重发（已 `revoked` 的行直接拒绝，见 §2.6）。
- 回包**必须回显校验**：`role` / `maxUses` 与请求不一致、`id` 与目标行不一致 ⇒ 按
  `malformed` 处理（用例覆盖，见 §4）。理由与 W4-E 的 `executedRecordId == record.id`
  同源：**回包错位比报错更危险**，它会让界面把 A 的码当成 B 的。

### 2.5 复制的是**裸码**，展示的是分组码

`inviteDisplayCode()`（`ABCD-2345`）只用于界面与 toast；
`Taro.setClipboardData({ data: invite.code })` / Flutter `Clipboard.setData` 复制的是
**8 位裸码**。这样即使对方用的客户端不会 `normalizeInviteCode`（去空格 / 去连字符 / 转大写），
粘进去也能直接用。反过来若复制带连字符的形式，任何一个没做归一化的入口都会说「码无效」。

复制失败必须说话（小程序 `.catch` ⇒ 「复制失败，请长按邀请码手动复制」）：
静默失败让人以为已复制，粘贴出来是上一条剪贴板内容 —— 这种错误无法自查。

### 2.6 已吊销的行不再画「吊销」按钮

服务端是幂等的，多点一次不会出错；但**按钮已经没有意义**，留着只会让人怀疑
「是不是没成功」。所以 `status === 'revoked'` 直接不渲染该按钮。
反之在**写请求在途**时按钮要禁用（`busyInviteId === invite.id` ⇒ 「吊销中…」），
避免同一行连点两次发出两个请求。

吊销前的确认文案两件事必须说清：
① 这个码**不能再用来加入**；② **已加入的成员不受影响**（`DELETE` 只吊销码，不动成员位）。

### 2.7 空态必须三分，不能把「没拉到」画成「没有」

| 条件 | 文案 |
|---|---|
| `inviteError !== null` | 「邀请码列表没能加载」（另有错误行 + 重试） |
| `invitesReadStatus === 'loading'` | 「正在加载邀请码…」 |
| 其它 | 「还没有生成过邀请码」 |

家长看到「还没有生成过邀请码」会以为**自己的码被删了**；
而真实原因可能是 403、断网或后端 501。同理，失败时**保留已有行**（不清空列表），
否则一次抖动就把刚生成的码从眼前抹掉，还得重新找。

### 2.8 预览模式不编假码

`isLiveMode == false`（未注入 `TARO_APP_KP_*` / Flutter 未配 `--dart-define`）时，
面板只显示「预览模式没有真实的邀请码。接入后端后才能生成和吊销邀请码。」

预览模式编一个 `ABCD-2345` 出来，用户会**真的拿去发给家人**，然后对方说「码无效」——
这比不做功能更糟。同一口径见 W4-E 的「live 无写客户端必须拒绝而不是本地假写」。

### 2.9 live 但没注入写客户端 ⇒ 只读，且**不改内存**

`isInviteWriteReadOnly` 为真时，点「生成邀请码」/「吊销」只弹
`inviteReadOnlyWriteMessage`，**不发请求、不动 `invites` 列表**。
本地假插一行（或直接把 `revoked` 改成 true）会让界面显示一个服务端根本不存在的状态，
下次刷新就悄悄回滚 —— 用户会认为「这个 App 的码会自己复活」。

## 3. 本阶段踩到的坑（都是真踩的）

### 3.1 用 403 去「探测」角色，会把权限问题画成加载问题

第一版直接在 `useEffect` 里 `refreshInvites()`。家长视角没问题，
**孩子视角**必然 403，而 store 把 403 记进 `invitesError` ⇒ 界面显示
「邀请码加载失败：没有权限」，看起来像故障，实际是**正常的产品状态**（孩子本来就不该看）。
改法不是「把 403 文案写好看点」，而是**先确认角色再决定发不发这个请求**（§2.1）。
教训：`DENY` 的动作不要靠「请求失败」来发现，客户端必须有一条**主动**的角色来源。

### 3.2 状态优先级：别按「严重程度」排，要按「确定性」排

「已过期」听起来比「已用完」更严重，但它是**唯一**依赖本机时钟的判断。
一个 `usedCount == maxUses` 且 `expiresAt` 已过的码，若「过期」优先，
时钟偏快 / 偏慢的两台设备会显示不同徽标 —— 同一张码出现两种结论。
所以顺序固定为 **revoked > exhausted > expired**（先答库里的既成事实），
并在用例里把这条顺序钉死（`run-w5i.mjs` 第 1 条），防止后续「顺手调整」。

### 3.3 `409` 不等于「失败」，`404` 才是「这一行已经不在了」

- 生成时的 409（撞码 / 期间角色变了）⇒ **必须重拉列表**：本地状态已经过时，
  继续显示旧列表会让人以为「生成没成功」，其实很可能成功了、只是响应丢了。
- 吊销时的 404 ⇒ 同样重拉（这一行在服务端已经不存在）。
- 吊销成功 ⇒ **不重拉**，只把那一行换成 `revokedInviteCopy()`：
  一次写操作换来一次整表往返，等于为了一个布尔值付一次网络抖动风险。

### 3.4 小程序的错误字段名是 `memberError`，不是 `membersError`

成员列表的错误在 store 里叫 `memberError`（单数），邀请码的叫 `invitesError`（复数）。
两个名字很像，写错时**不会**报运行期错误 —— 只会一直是 `undefined`，
表现为「错误行永远不出现」。这类拼写靠 `tsc --noEmit` 才能挡住，
所以本阶段的验收里 `tsc` 是**必须**的一项，不能只跑 `build:weapp`。

### 3.5 `.tmp_test/run-w5i.mjs` 跑的是编译产物，不是 `src/*.ts`

测试脚本 import 的是 `.tmp_test_build/` 下的 JS（由 `.tmp_test/tsconfig.test.json` 编译）。
**不重编译就会对着旧产物下结论**（W5-H §3.3 的老坑）：改了 `types.ts` 却仍然全绿，
很容易被读成「改动没影响」。复跑顺序固定为：
`npx tsc -p .tmp_test/tsconfig.test.json` → `node .tmp_test/run-w5i.mjs`。

### 3.6 小程序的 `catch` 不能省

`Taro.setClipboardData` 返回 Promise，第一版只写了 `.then`。在开发者工具里通常不会失败，
所以看起来没问题；但真机在无剪贴板权限 / 系统限制时会 reject ⇒ 未处理的 Promise、
**一句提示都没有**。现在 `.catch` 会提示「复制失败，请长按邀请码手动复制」。

## 4. 用例清单

### 4.1 Flutter（`test/write_api_test.dart`，本阶段 +8，共 98）

| 用例 | 断言重点 |
|---|---|
| 打开面板才拉邀请码 | 事实照服务端落地；状态由本地 `statusAt(now)` 现算，不读缓存 |
| 孩子视角 `canManageInvites` 为假 | 与成员权限**同一条线**（`canManageMembers`），不是另起一套判断 |
| 生成：插到表头 | 参数按表单发出；结束后 `isInviteWriteBusy` 解除 |
| 生成冲突（409） | 回报原因**并重拉列表**（本地状态已过时） |
| 吊销：只把那一行标成已吊销 | 其余字段不动；**不重拉** |
| 重复吊销 | 本地就拒，**一次请求都不发** |
| 吊销 404 | 回报原因并重拉（这一行已经不在了） |
| live 但没注入写客户端 | 只读文案；列表**不动**（不本地假写） |

### 4.2 小程序（`.tmp_test/run-w5i.mjs`，19 条 / 4 组）

| 组 | 条数 | 覆盖 |
|---|---|---|
| types | 3 | 状态优先级 `revoked > exhausted > expired > usable`；`remainingUses` 夹到 0；徽标 / 角色 / 用量文案；`displayCode` 只在 8 位时分组 |
| mapper | 2 | `viewer` / 空码 / `usedCount > maxUses` ⇒ `malformed`；合法行**逐字段**落成 `InviteCode`（多一个字段就红） |
| store | 9 | `refreshInvites` 成功 / 失败**保留旧列表**且 403 照实上报；`canManageInvites` 只看 `isSelf` 那一行；生成成功插表头；生成 409 重拉；非法角色本地拒；吊销只动目标行；已吊销本地拒；live 无写客户端拒绝且**不改内存** |
| client | 5 | `POST /invites` 只发三个字段且**不带**幂等键；回包 `role` / `maxUses` 与请求不一致 ⇒ `malformed`；参数越界本地拒；`revoke` 无请求体且回包 `id` 不符 ⇒ `malformed`；404 `INVITE_NOT_FOUND` / 409 各自归一 |

### 4.3 服务端

本轮**零改动**，邀请码路由的用例（`test/invite-code.test.ts`、`test/invites-http.test.ts`、
`test-db/invites-db.dbtest.ts`）沿用 W5-G 基线；`npm test` 仍是 **544/544**。

## 5. 仍未落地（不粉饰）

- **`POST /invites/accept` 双端都没有客户端方法，也没有 UI。** 这不是漏做，是**顺序问题**：
  - 该路由只挂 `DeviceSessionGuard`（被邀请人**天然不是**这个孩子的成员，不能过
    `MembershipGuard`），但客户端所有 live 请求都要带 `x-kp-child-id`，而这个值只能来自
    「已经加入的家庭」—— 全新成员在设备上**没有任何孩子上下文**可填；
  - 真正缺的是 L2 登录链路（`code2session`，`05` §6 阻塞项）。在它落地之前硬接，
    唯一能跑通的场景是「已经在这个家庭的设备再 accept」⇒ 服务端回 `ALREADY_MEMBER`，
    零产品价值；
  - 决策：等 L2 落地后，把它放进**引导流程**（新设备首次进入 → 输入邀请码 / 扫家庭码），
    **不要**塞进「我的 → 邀请码」——那里是家长发码的地方，不是被邀请人兑码的地方。
- **成员管理 UI（W5-H 遗留）仍未建**：本阶段只是**读** `GET /members` 拿 `isSelf` 判角色，
  没有成员列表、角色降级、移出确认界面。`ALREADY_MEMBER` 的文案指向的「成员管理」入口
  在双端仍不存在。
- **邀请码没有「谁用了」**：线格式只有 `usedCount`，回答不了「这张码被哪几个人用了」。
  审计里**刻意不写码本身**（`invite-code.ts` 注释：审计读取面比邀请码列表宽），
  所以连「按码查审计」都不成立。
- **列表不分页、没有上限**：单孩子邀请码量小，理论上可以无限累积（过期 / 已吊销的行也不清）。
- **`viewer` 无法被邀请**：`role` 只收 `child` / `guardian`，这个角色只可能存在于历史数据。
- **会话 TTL 是 30 天，不是 `02 §7` 的 5 分钟**：W5-G 的已知偏差（没有 PIN 端点，
  发 5 分钟会让刚加入的家长 5 分钟后静默掉回 `child`）。PIN 落地后**必须**改。
- **状态不会自动重绘**：状态虽是「渲染时现算」而不是缓存，但两端都没有定时器 ——
  弹窗静置跨过有效期时不会自己变成「已过期」，要等下一次交互 / 重开面板。
  这是**已知行为**（比缓存一个布尔值安全，但不是实时的）。
- **没有真机 / 微信开发者工具截图验证**：本轮证据只有 `tsc --noEmit` + `build:weapp` +
  离线用例；H5 未跑，剪贴板、长列表滚动、底部弹窗在真机上的表现都是**推断**。
- **Flutter 侧没有 widget 测试**：8 条用例都在 store / API 层，UI 只经 `flutter analyze`。

## 6. 复跑基线

```bash
cd backend
npm run typecheck && npm run typecheck:tests    # → 0 / 0（本阶段后端零改动）
npm test                                        # → 544/544（30 个用例文件）

cd ../kids_points_app
flutter analyze                                 # → No issues found!（≈14s）
flutter test test/write_api_test.dart           # → 98/98（含 W5-I 8 条）

cd ../kids_points_mp
npx tsc --noEmit                                # → 0（能挡住 §3.4 那类拼写错误）
npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w5i.mjs
                                                # → 19/19（types 3 / mapper 2 / store 9 / client 5）
npm run build:weapp                             # → 0（只剩既有 Sass @import 弃用告警）
```

手工冒烟（开发库，先 `npm run migrate:deploy`；需要已 seed 的家庭与设备 id）：

```bash
curl -s http://localhost:3000/invites \
  -H 'x-kp-device-id: demo-device-guardian' -H 'x-kp-child-id: demo-child'

curl -s -X POST http://localhost:3000/invites \
  -H 'content-type: application/json' \
  -H 'x-kp-device-id: demo-device-guardian' -H 'x-kp-child-id: demo-child' \
  -d '{"role":"child","maxUses":1,"expiresInDays":7}'

curl -s -X POST http://localhost:3000/invites/<inviteId>/revoke \
  -H 'x-kp-device-id: demo-device-guardian' -H 'x-kp-child-id: demo-child'
```

对照面（同一条请求，孩子设备应得 403，且**界面不会**把这次 403 画成「加载失败」）：
`-H 'x-kp-device-id: demo-device-child'`。



**入口位置**：两端都在「我的」页，成员管理下方／相邻位置新增「邀请码」一行（小程序礼物图标 `#f6c64a`），
点开是底部弹窗（Flutter `SheetFrame` / 小程序 `SheetFrame`），**打开才拉数据**，不占首页刷新预算。
