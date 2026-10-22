# 阶段 W5-C 交接单 · 心愿兑换走 `POST /approvals`（`action=redeem`）＋双端接线

> **状态（2026-10-20）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm test` | ✅ **434/434**（25 个用例文件） |
> | `cd backend && npm run test:db` | ✅ **137/137**（9 个用例文件；`test-db/approvals-db.dbtest.ts` 新增 1 条 409） |
> | `cd backend && npm run typecheck` / `typecheck:tests` | ✅ 退出码 **0** |
> | `flutter analyze` | ✅ 0 issue |
> | `flutter test` | ✅ **105/105**（W5-C 新增 12 条：客户端 3 ＋ 错误映射 1 ＋ store 6 ＋ 确认弹层 2） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && node .tmp_test/run.js` | ✅ **91/91**（W5-C 新增 **19** 条，ESM 子进程） |
> | 新增迁移 | ✅ **无**（兑换复用 `ApprovalRequest` ＋既有账本内核） |
>
> **给**：接手下一步（家长审批页 / 档案 / 邀请 / 习惯 CRUD）的下一个会话。

## 1. 本阶段做了什么

心愿「兑换」从**只读拦截**变成真写（并在点下去之前弹确认），双端同构，且**没有**新增后端路由：

| 动作 | 入口 | live 模式 | 预览模式 |
|---|---|---|---|
| 兑换心愿 | 心愿页点「兑换」→ **确认弹层** → 提交 | `POST /approvals`（`action='redeem'`） | 原本地 `redeem()`（同一确认弹层） |
| 新增 / 删除心愿 | 心愿页 FAB / 长按 | 已由 W5-B 接通 | 原本地行为 |
| 记一笔 / 打卡 / 规则 | 首页 / 规则页 | 已由 W5-B / W4-E / W5-A 接通 | 原本地行为 |
| 家长审批（批准 / 拒绝 / 撤回） | —— | **仍无 UI** | —— |

客户端：

- Flutter：`lib/data/write_dto.dart`（`ApprovalDto`）、`lib/data/write_api.dart`
  （`WriteApi.requestRedeem()` ＋ `WriteApiClient.requestRedeem()`）、
  `lib/data/write_api_errors.dart`（409 `WISH_ALREADY_REDEEMED`）、
  `lib/data/app_store.dart`（`submitRedeemWish()` ＋ `_autoReasonText()` ＋ `redeemConfirmText()`）、
  `lib/screens/wishlist_screen.dart`（`onRedeem` 改异步 ＋ `_confirmRedeem()` 确认弹层）。
- 小程序：`kids_points_mp/src/data/write_dto.ts`（`ApprovalDto`）、
  `src/data/write_api.ts`（接口 ＋ `parseApproval()`）、`src/data/write_api_errors.ts`、
  `src/data/store.ts`（`submitRedeemWish()` ＋ `autoReasonText()` ＋ `redeemConfirmText()`）、
  `src/pages/wishlist/index.tsx`（`handleRedeem` 改异步 ＋ `confirm()` 确认弹层）。

服务端：**零改动**（`POST /approvals`、`redeem` 执行器、`WISH_ALREADY_REDEEMED` 早已在 W3-C 落地）；
本阶段只补了**真库用例**证明这条 409 真的会出来且**不建审批行**。

## 2. 关键实现决策

### 2.1 兑换**没有**独立路由，`POST /approvals` 是唯一正确路径

`02` §2 的矩阵里 `redeem: { guardian: REQUIRE_APPROVAL, child: REQUIRE_APPROVAL }` ——
两个角色都不能"直接兑换"，所以「建一条审批」不是绕路，而是**唯一入口**。
客户端因此**不**去猜"我是不是家长、能不能直接扣"，只发一条申请，由服务端按会话角色定审批流。

### 2.2 请求体只发 `action` + `targetId`：`costSnapshot` 与 `autoApprove` 都不发

- `costSnapshot` **服务端自己快照**（`02` §4.3：家长 3 小时后同意时按孩子申请时看到的价格扣）。
  客户端发价格等于让客户端决定扣多少分。
- `autoApprove` 是「申请人要求自批」的**显式勾选**：孩子没有批准资格 ⇒ 只会换来
  400 `SELF_APPROVAL_NOT_ALLOWED`（9.26）；家长也不该被这个界面代勾（9.27 刻意要求二次确认）。

### 2.3 `pending` 是**正常结果**，不是成功 —— `null` 只留给「已生效」

`submitRedeemWish()` 的返回值语义与别的写入口不同：**`null` 只在 `approved` 时返回**。
`pending` 会返回一句必须展示给用户的文案（「已提交给家长确认：批准后才会扣 N 分…」），
因为此刻**一分都没扣**。把它当成功静默掉，孩子会以为已经兑换、家长却还没批；
本地先扣一次分再等刷新打回，则会出现「余额自己涨回去」的灵异现象。

其余状态各自有话说：`rejected`（家长拒绝）/ `withdrawn`（申请人撤回）/
`invalidated`（前提消失，带 `autoReason` 的具体原因）/ **未知状态**（不猜，让人刷新确认）。

### 2.4 `status` 保持**原始字符串**，不建 Dart/TS 枚举

服务端将来加状态（如 `expired` 走审批列表而非建请求回包）时，客户端应当**降级成
「未知，请刷新查看」**，而不是在解析层崩掉 —— 崩掉会让用户连"结果不明"都看不到。
枚举只用在**配色**这种真正封闭、两端必须同源的集合上（`WishCoverStyle`）。

### 2.5 `approved` 一律以**服务端快照**为准，客户端不自己减分

`approved` 分支只做一件事：`refreshFromServer()`。理由与 W4-E / W5-B 一致 ——
`balanceAfter` 由服务端在行锁内算，客户端手里的 `points` 可能已经过期（另一位家长刚扣过）。
本地手写 `points - wish.cost` 会在这条路径上引入"扣了但没扣对"的错账。

### 2.6 409 `WISH_ALREADY_REDEEMED` 的文案说「**没有提交**」

被这个 409 拒掉时，服务端**没有**建审批行。文案若写「提交失败」，孩子会去审批页
找一条根本不存在的申请，或反复重试。两端统一为：
「这个心愿已经兑换过了，再申请一次会重复扣分，所以没有提交。」

### 2.7 本地心愿列表只用来拼文案，**不**当成"能不能兑换"的判据

live 分支里 `wishList.find(id)` 的结果只用来算「要扣多少分」这句话；
**找不到也照样发请求** —— 列表可能已经过期（心愿被别的设备删了、或孩子在另一台机器上刚兑换），
真正有没有、还能不能兑换由服务端回答（404 `WISH_NOT_FOUND` / 409 `WISH_ALREADY_REDEEMED`）。

### 2.8 兑换前必须弹确认，且 live / 预览要说**两种话**

兑换是**花钱**的动作，误触的代价是扣分（预览）或打扰家长（live），所以点「兑换」先弹确认，
取消就一次请求都不发。文案不写在页面里，而由 `AppStore.redeemConfirmText(wish)` 给：

| 模式 | 文案要点 | 为什么只能这么说 |
|---|---|---|
| live | 「提交给家长确认」「批准后才会扣 N 分」「现在还没有扣」，按钮写**提交申请** | `redeem` 是 `REQUIRE_APPROVAL`：确认后只是建一条审批，一分不扣。写「立即扣除」就是在骗人 |
| 预览 | 「立即扣除」「心愿会标记为已兑换」，按钮写**确认兑换** | 没有服务端可申请，确认就真的本地扣分。写「等家长确认」等于演一场没人会批的戏 |

按钮文案由 `isLiveMode` 决定（live = `提交申请`，预览 = `确认兑换`），
不写成同一个「确定」—— 用户按下去之前就该知道这一下是"申请"还是"扣分"。

### 2.9 兑换的入口判据是 `isWishWriteReadOnly`，**不是** `isReadOnly`

`isReadOnly` 是旧口径（「live 模式下其余写入口仍只读」＝ `isLiveMode`），
心愿页原本沿用它做兑换前的拦截 —— 结果 **live 模式下点兑换只会弹「只读模式」，永远发不出审批请求**。
新增 / 删除早已改用 `isWishWriteReadOnly`（＝ live 且**没注入写客户端**），兑换现在与它们一致。
这条只改客户端：store 的 `submitRedeemWish()` 本身是好的，所以只跑 store 用例的测试**发现不了**它，
必须有一条**从界面点下去**的用例钉住（见 §4 的 widget 用例）。

## 3. 本阶段踩到的坑

| # | 坑 | 处理 |
|---|---|---|
| 1 | 先查本地心愿、查不到就返回「这个心愿已经不在列表里了」，**排在了只读拦截之前** | live 且**没注入写客户端**时，用户看到的会是"心愿没了"而不是"现在是只读模式"。改成先判模式 / 写客户端，再取心愿拼文案（取不到也给中性文案）。小程序 `submitRedeemWish` 已按此顺序重写 |
| 2 | 小程序运行时用例跑的是 `.tmp_test/dist` 里的**旧编译产物**，`requestRedeem` 根本不存在 | 与 W5-B 同一个坑：必须先 `npx tsc -p .tmp_test/tsconfig.test.json` 现编再跑 `run.js` |
| 3 | `WriteApi` 是小程序侧的**接口**（不是类），新增 `requestRedeem` 后 `.tmp_test` 里的替身形状对不上 | `run-w5c.mjs` 的 `fakeWriteApi()` 必须补上 `requestRedeem` ＋独立的 `calls.requestRedeem` 计数；漏补时 `npx tsc --noEmit` 会红（但 `.tmp_test/dist` 是现编的，别把"能跑起来"当"签名对了"） |
| 4 | `redeem` 与 `request_redeem` 两个动作**权限格里不同**（guardian：前者 REQUIRE_APPROVAL、后者 **ALLOW**） | 本阶段统一发 `redeem`：孩子侧两者都要求审批且**执行路径相同**；家长侧发 `redeem` 会停在 `pending`（9.27 刻意如此）。见 §5 的待决策项 |
| 5 | `requestRedeem('')` 会抛 `ArgumentError`，而 `submitRedeemWish()` 的兜底 `catch` 把它翻成「兑换申请已发出，但结果无法确认」 | **一个字节都没发出去，却让用户去查结果**。小程序本就有 `id === ''` 守卫，Flutter 这阶段才补上（「心愿 id 不能为空」），两端各加一条 store 用例钉住"不发请求、不动余额" |
| 6 | 双端心愿页的兑换拦截都写着 `store.isReadOnly`，而它等于 `isLiveMode` —— **live 模式一上线就点不动兑换**，只会看到「只读模式：兑换 / 记一笔 / 档案还没接后端」 | store 用例全绿（它们直接调 `submitRedeemWish()`），只有**从界面点**才会发现。改判 `isWishWriteReadOnly`，并补一条 widget 用例：点「兑换」→ 弹确认 → 取消 = 0 次请求 → 再确认 = 1 次 `POST /approvals` |
| 7 | 确认弹层若沿用「确定 / 取消」两个中性词，用户按下去才知道是"申请"还是"扣分" | 按钮文案跟 `isLiveMode` 走（live = `提交申请`，预览 = `确认兑换`）；正文由 `redeemConfirmText()` 统一给，页面不自己拼句 |

## 4. 证据（本阶段新增用例）

**Flutter（新增 12 条）**：`test/write_api_test.dart` 11 条 ＋ `test/app_test.dart` 1 条。

| 用例 | 钉住的行为 |
|---|---|
| `POST /approvals` 请求形状 | `body` **恰好**是 `{action:'redeem', targetId}`，带 `Idempotency-Key` / 设备头 / 孩子头 |
| 空 `wishId` | 客户端本地 `ArgumentError`，一次请求都不发 |
| 回包缺 `status` | `malformed`（宁可报错也不猜审批结果） |
| 409 `WISH_ALREADY_REDEEMED` | `conflict` ＋ 文案含「没有提交」 |
| store：`pending` | 返回字符串、含「已提交给家长确认」「批准后才会扣 40 分」，**余额与流水都不动** |
| store：`approved` | 返回 `null`，余额取**服务端快照**（11 → 1，不是本地 11-40） |
| store：`invalidated` | 文案带 `autoReason` 的可读原因（`INSUFFICIENT_POINTS` →「积分不够了」）＋「积分没有变动」 |
| store：未知状态 | 不猜：返回「未知的审批状态…请刷新」 |
| store：空心愿 id | 本地就拒、**不发请求**（否则 `ArgumentError` 会被兜底文案说成「申请已发出」） |
| store：确认文案 | live 含「提交给家长确认 / 批准后才会扣 40 分 / 现在还没有扣」且**不含**「立即扣除」；预览反过来（含「立即扣除」、不含「提交给家长确认」） |
| widget：点「兑换」 | 先弹「兑换心愿」确认层，正文说明「家长批准后才会扣」；**取消 = 0 次请求、余额不变**；再点并「提交申请」= **1 次 `POST /approvals`**、余额仍是 100（`pending` 不动余额） |
| widget：预览模式（`app_test.dart`） | 弹层正文写「立即扣除」；取消后 `points` 不变；点「确认兑换」后 `points - 40`、该心愿 `redeemed` |

**小程序 `.tmp_test/run-w5c.mjs`（新增 19 条）**：上述客户端 3 条 ＋ 409 映射 1 条 ＋
store 5 条（`invalidated` 用的是 `WISH_DELETED`，另加空心愿 id 一条）＋ **确认文案 1 条**，
另含 W5-B 已有的心愿新增 / 删除 9 条（本文件同时是心愿写入口的完整回归）。
只读模式那一条额外覆盖：
`submitRedeemWish()` 在**没有写客户端**时返回只读文案，不本地扣分。
确认弹层本身在小程序侧只能靠页面（`Taro.showModal`），因此**没有**运行时用例覆盖点击流程 ——
文案与模式分支放在 store 里就是为了让它能被测到，页面只负责"弹 / 不弹"。

**后端 `test-db/approvals-db.dbtest.ts`（新增 1 条）**：孩子对一个 `redeemed: true` 的心愿
发 `POST /approvals` ⇒ **409 `WISH_ALREADY_REDEEMED`**、**不建审批行**、**不写流水**、
心愿状态不变。夹具新增 `wishDone`（`redeemed: true` 是历史事实，本文件不碰账本）。

## 5. 仍未落地（不粉饰）

- **家长审批页双端都没有**：`pending` 之后只能靠后端 `decide` 接口（`POST /approvals/:id/decide`）
  或后台过期扫描推进；孩子端没有任何轮询 / 推送，只能手动下拉刷新看结果。
- **`redeem` vs `request_redeem` 的动作选择是待决策项**：本阶段统一发 `redeem`。
  若要「家长点兑换立即生效」，可改成家长侧发 `request_redeem`（矩阵里 guardian=ALLOW）
  或带 `autoApprove: true`（9.25 允许，审计记 `approval.self_approved`）；
  但 9.27 的「单家长也先 pending」是**刻意的防误触**，改之前需要产品口径确认。
  **确认弹层已经补上**（§2.8），所以真改成"家长点即扣分"时只需改文案与动作，不必再补弹层。
- **确认弹层只挡住"发起"这一步**：`pending` 之后没有撤销入口（撤回 `withdraw` 只有后端接口），
  孩子想反悔得找家长拒绝。
- **未做真机联调 / 压测**：幂等并发重放仍只由后端真库用例覆盖。
- **小程序 `onRedeem` 返回的 `Promise` 没有被 `await`**（`onRedeem={() => handleRedeem(wish)}`）：
  当前没有需要等待的 UI 状态；若将来要按钮 `loading` 态，得把 `Promise` 接进组件 props。
- **同类旧口径还留在别处（本阶段只改了兑换）**：首页「记一笔」、我的页（改昵称 / 恢复演示数据）
  双端仍判 `store.isReadOnly`（＝ `isLiveMode`）。`POST /records/adjust` 的矩阵是
  **guardian ALLOW / child DENY**，所以孩子点「记一笔」现在会被挡下——结果是对的，
  **文案是错的**（说的是「还没接后端」，实际是"这件事要家长来记"）。
  下一步需要产品口径：家长端开放、孩子端隐藏按钮（或换文案），别再靠只读文案兜。

## 6. 复跑基线

```bash
# 后端
cd backend
npm run typecheck && npm run typecheck:tests   # 0 / 0
npm test                                        # 434/434（25 文件）
npm run test:db                                 # 137/137（9 文件，需要真库）
npm run ci                                      # CI_EXIT=0

# Flutter
flutter analyze                                 # 0 issue
flutter test                                    # 105/105

# 小程序（先现编 dist，再跑用例）
cd kids_points_mp
npx tsc --noEmit                                # 0
npx tsc -p .tmp_test/tsconfig.test.json         # 编到 .tmp_test/dist
node .tmp_test/run.js                           # 91/91（run-w5c.mjs 19 条）
```
