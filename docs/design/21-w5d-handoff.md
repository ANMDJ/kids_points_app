# 阶段 W5-D 交接单 · 家长审批收件箱（小程序镜像 Flutter）

> **状态（2026-10-21）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npx tsc --noEmit` | ✅ 退出码 **0**（本阶段后端零改动） |
> | `cd backend && npm test` | ✅ **443/443**（25 个用例文件） |
> | `flutter analyze` | ✅ 0 issue |
> | `flutter test` | ✅ **122/122**（`test/approvals_test.dart` 17 条为上一阶段已落地的 Flutter 侧） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && npm run build:weapp` | ✅ 退出码 **0**（仅 Sass `@import` 弃用告警，仓库既有） |
> | `cd kids_points_mp && node .tmp_test/run.js` | ✅ **91/91**（老用例无回归） |
> | `node .tmp_test/run-w5d.mjs` | ✅ **16/16**（本阶段新增） |
> | 新增迁移 / 新端点 | ✅ **无**（`GET /approvals`、`POST /approvals/:id/decide` 早已存在） |
>
> **给**：接手「审批推送 / 撤回入口 / 档案 / 邀请 / 习惯 CRUD」的下一个会话。

## 1. 本阶段做了什么

后端与 Flutter 的家长审批收件箱在上一阶段已经落地；本阶段把**同一套语义**镜像到
Taro 小程序，并补上底部导航的第 4 个 tab。**服务端零改动**。

| 能力 | 小程序落点 |
|---|---|
| 收件箱读取 `GET /approvals?status=&limit=&cursor=` | `src/data/read_api.ts`（`fetchApprovals`）＋ `ApprovalsPageDto` / `ApprovalInboxItemDto` |
| 严格映射（含 `summary: null` 的宽松分支） | `src/data/read_mapper.ts`（`mapApprovalInboxItem` / `mapApprovalsPage`） |
| 批准 / 拒绝 `POST /approvals/:id/decide` | `src/data/write_api.ts`（`decideApproval`）＋ `src/data/write_api_errors.ts` |
| 领域纯函数（标题 / 内容 / 状态 / 剩余时间 / 拦截原因） | `src/data/approval.ts`（含本阶段新增的 `formatApprovalTime`） |
| 独立 store 切片 + 判定流程 | `src/data/store.ts`（`approvals` / `approvalStatus` / `approvalFilter` / `pendingApprovalCount` / `canDecideApprovals` / `decidingApprovalId` / `hasMoreApprovals`，方法 `ensureApprovalsLoaded` / `refreshApprovals` / `loadMoreApprovals` / `setApprovalFilter` / `decideApproval`） |
| 卡片 | `src/components/ApprovalCard/index.tsx`（`badge` 图标 + 标题 / 明细 / 提交时间 / 状态胶囊 / 拦截原因 / 拒绝 + 批准 / 提交中 spinner） |
| 空态 | `src/components/ApprovalEmptyHint/index.tsx`（预览 / 403 / 读失败 / 真空，重试入口） |
| 页面 | `src/pages/approvals/index.tsx`：待处理数胶囊、刷新、四个筛选 chip、旧数据错误横幅、卡片列表、底部翻页、下拉刷新、首屏 spinner |
| 导航 | `src/utils/nav.ts` 的 `TAB_PAGES` 由 3 → **4** 项（审批插在心愿与「我的」之间）；`AppBottomNav` 4 个 tab；`pages/profile` 的 `currentIndex` 2 → 3；新页 `currentIndex={2}` |
| 注册 | `src/app.config.ts` 增 `pages/approvals/index` |

## 2. 关键实现决策

### 2.1 收件箱是**独立** store 切片，403 不污染首页读状态

`approvalStatus` / `approvalError` / `approvalEpoch` / `approvalItems` 与
`readStatus` / `readError` / `recordEpoch` 完全分开。孩子设备调用
`GET /approvals` 会拿到 403 —— 如果复用同一份错误字段，首页与流水会被打上
「读取失败」，孩子每次进首页都看到红条，而真实原因只是「这台设备不能批申请」。
独立切片后，403 只出现在审批页的空态里（`error.kind === 'forbidden'`）。

### 2.2 `summary === null`：**禁止批准，保留拒绝**

`summary: null` 是**合法响应**（服务端 payload 读不懂，或 `kind` 比客户端新）。
所以：

- 卡片标题写「内容无法识别」，明细写「服务端返回的申请内容无法解析（数据异常），不能批准。」；
- `approvalBlockedReason()` 给出原因，批准按钮禁用；
- **拒绝仍然可用** —— 否则这一行会永久卡在列表里，家长连「处理掉它」都做不到。

判据全在 `approval.ts` 的纯函数里（`canApproveApproval` / `canRejectApproval` /
`approvalBlockedReason`），卡片和页面都不重新推导一遍。

### 2.3 未知 `status` 降级显示，不猜、不崩

`approvalStatusLabel()` 对四个已知状态给中文，其余一律
`状态未知（<原词>）`；`isApprovalPending()` 只认 `pending`。
这样服务端将来加状态时，客户端最差是「一条显示未知的只读行」，
而不是解析层抛 `malformed` 把整页打空。

### 2.4 `decideApproval` 的三层拦截：本地判死 → 占位防串批 → 409 重拉

1. **本地能判死的先拒**：预览 / 无写客户端 / 空 id / 已终态 / 已过期 / `summary=null` 时批准 ——
   一律直接返回文案，**一次请求都不发**（这些请求发出去只会换回 409）；
2. 发送前置 `decidingApprovalId`：双击不会变成两次判定（幂等键只是第二道防线），
   此时其它卡片的「批准」也一起禁用（`busy`），避免串批；
3. 回包 `status` 必须与本次操作一致（`approved` / `rejected`），不一致按契约漂移处理；
4. 成功：批准 → `refreshFromServer()` **再** `refreshApprovals()`（余额与流水的唯一可信源是服务端）；
   拒绝 → 只 `refreshApprovals()`（没有扣分，不必动首页）；
5. 409 `conflict` → 显示服务端文案并**立刻重拉列表**（本地那条已经过时，
   不刷新就会留一条点不动的申请）。

### 2.5 空态必须四分（另加一个 `idle` 兜底）

`ApprovalEmptyHint` 的四个分支：

| 条件 | 文案 |
|---|---|
| 预览模式 | 🌱「预览模式没有审批数据。连上后端后，孩子的兑换 / 加分申请会出现在这里。」 |
| `error.kind === 'forbidden'` | 🔒「当前身份没有批准申请的权限（403）。审批只能由家长设备处理；孩子设备可以继续提交申请。」＋「重试」 |
| 其它读失败 | ⚠️`<userMessage>` ＋「这不是「没有待审批」。」＋「重试」 |
| 读成功、列表空 | 🍃 筛选 ≠ 全部 →「没有符合条件的申请。」；筛选 = 全部 →「还没有任何申请。」 |

把 403 说成「暂无待审批」是最糟的谎：家长会以为孩子没提交，实际是这台设备批不了。
页面上再加一层：`items.length > 0 && approvalError !== null` 时顶部显示旧数据横幅
（`403` 时写「列表可能是旧的」），因为失败时**保留已加载的行**比清空更安全。

### 2.6 切筛选 = 重新向服务端要第一页

与流水页同一纪律：本地只过滤已加载的 20 条会漏掉后面的同类申请（那是假「全部」）。
`setApprovalFilter()` 清空列表 + 游标后重新请求，`status` 来自
`approvalFilterQuery()`（`all` → `undefined`，**不发** `status=all` —— 后端只认四个具体值）。

### 2.7 首帧把 `idle` 也当 loading

页面在 `useEffect` 里调 `ensureApprovalsLoaded()`（**不在 app 启动时**，
否则孩子设备一开小程序就吃一个 403）。挂载 → 第一帧的 `approvalStatus` 仍是 `idle`，
如果首屏 spinner 只判 `loading`，会先闪一下「还没有任何申请」再转圈。
所以 `firstLoad = isLiveMode && (status === 'loading' || status === 'idle') && items.length === 0`。

### 2.8 时间字段只认 ISO-8601 字符串

`readDate()` 要求服务端时间是 ISO 字符串（`Date.parse` 后取毫秒）。
用例夹具里写 `createdAt: Date.now()` 会拿到 `malformed：不是 ISO-8601 时间`，
整页（而不是某一条）变空 —— 本阶段就因此一次红了 12 条用例（见 §3）。

## 3. 本阶段踩到的坑

| # | 坑 | 表现 | 处置 |
|---|---|---|---|
| 1 | **夹具用毫秒数冒充服务端时间** | `run-w5d.mjs` 首跑 12/16 红，报 `items[0].createdAt` malformed；store 用例连带 `store.approvals[0]` 变 `undefined` | 夹具统一 `new Date(ms).toISOString()`；这也钉住了「DTO 不接受毫秒」这条契约 |
| 2 | **只改 DTO 不补 `fetchRecords` 替身** | 批准成功后会 `refreshFromServer()`，替身缺 `fetchRecords` 会让「批准成功」的用例误判成失败 | `fakeReadApi()` 补齐 `fetchHome` / `fetchRecords` / `fetchApprovals` 三个端点 + 各自计数 |
| 3 | **编辑时把整段用例替换掉** | 用 `old_text` 定位插入 store 用例时，把「筛选词表 / 时间格式」那一条整段覆盖掉（测试数量悄悄少 1） | 重新补回并核对用例条数（16）；**新增断言后必须数一遍 PASS 行**，不能只看 `ALL PASS` |
| 4 | **tab 从 3 变 4，`currentIndex` 是硬编码的** | 新增审批 tab 后，若「我的」页仍传 2，点「我的」会跳到审批 | 三处同步：`TAB_PAGES`、`AppBottomNav` ITEMS、每个 tab 页的 `currentIndex`（审批 2 / 我的 3） |

## 4. 证据（本阶段新增用例）

**小程序 `.tmp_test/run-w5d.mjs`（16 条用例；下表按断言拆开）** —— 数据层 / 模型 / store 三层：

| 用例 | 钉住的行为 |
|---|---|
| 未知 `summary.kind` | 映射成 `null`（不抛），且「批准禁用、拒绝可用」 |
| `hasMore` / `nextCursor` 自洽 | 两种坏形状都报 `malformed` |
| `redeem` 空 `wishId` | `malformed`（批准它等于兑一个不存在的心愿） |
| `summary=null` | 标题说「内容无法识别」，确认文案说「不能批准」 |
| 三种摘要文案 | 兑换扣 N 分 / 加分 `+N` ＋依据 / 新增心愿进心愿单 |
| 剩余时间 | 3 小时 / 90 分钟→「还剩 1 小时」/ 30 秒→「不到 1 分钟」/ 过期→`null` |
| 过期 / 未知状态 | 过期时两边都不可点、原因含「72 小时」；未知状态显示 `状态未知（x）` |
| `invalidated` + 原因 | 「已失效」＋「积分不够了」 |
| 筛选词表 / 请求参数 | `all` **不带** `status`；时间格式化 `10 月 21 日 14:05` |
| 预览模式 | `ready` + 空列表 + 零请求 + `canDecideApprovals === false` |
| `ensureApprovalsLoaded` | 只读一次；默认 `status=pending&limit=20&cursor=null` |
| 403 | `approvalStatus=error`、`approvalError.kind='forbidden'`，`readStatus` 仍是 `idle` |
| 切筛选 | 第二次请求带 `status=approved`，列表被服务端结果替换；`all` 不带 `status` |
| 批准成功 | 一次 `decide`、幂等键前缀 `approval-decide-`、重拉首页 + 列表、`decidingApprovalId` 归零 |
| 拒绝 | **不动首页**，但仍重拉列表 |
| 本地判死 | 读不懂 / 过期 / 已终态 → 0 请求 |
| 409 | 原样返回服务端文案 + 重拉列表 + 放开按钮 |
| 在途双击 | 第二次返回「正在处理中」且只发一次请求 |

**Flutter（上一阶段已落地，`test/approvals_test.dart` 17 条）**：客户端请求形状、
403 空态、`summary=null` 只禁用批准、过期、`pending` 计数、翻页、判定后的刷新顺序。
本阶段未改 Flutter 代码，`flutter test` 122/122 作为**不回归**证明。

**后端**：本阶段零改动；`npm test` 443/443 作为基线。

## 5. 仍未落地（不粉饰）

- **没有推送 / 轮询**：孩子提交申请后，家长必须**手动**下拉或点刷新才会看到；
  孩子端也收不到「已批准」的通知，只能回心愿页下拉。要真解决需要订阅消息 / 定时拉取，
  这涉及小程序订阅授权与服务端推送，本阶段没做。
- **撤回（`withdraw`）没有入口**：`POST /approvals/:id/withdraw` 后端早就有，
  双端都只做了批 / 拒。孩子想反悔仍得找家长拒绝。
- **页面点击流程没有运行时用例**：确认弹层走 `Taro.showModal`，
  `.tmp_test` 里只能测 store 的文案与判定；「取消 = 0 请求」目前只有 Flutter widget 用例覆盖。
- **只读模式只禁用、不解释**：`canDecideApprovals === false` 时两个按钮都变灰，
  卡片上没有一句「这台设备没有写权限」。live 但没配写客户端（`WriteApiClient`
  构造失败）时用户只会看到点不动的按钮，需要下阶段补一行说明。
- **旧数据横幅只在「已有列表 + 读取失败」时出现**：如果第一次就读失败，
  走的是空态的 ⚠️ 分支，两者文案不同但都没有把「上次成功时间」标出来。
- **未做真机联调 / 长列表压测**：翻页逻辑（`nextCursor`）只有替身用例，
  没在 200+ 条待审批的真实数据上跑过；下拉刷新的手感（`refresherTriggered`）也没真机验证。
- **底部 tab 仍无角标**：`pendingApprovalCount` 只在审批页标题旁显示，
  `AppBottomNav` 没有红点 —— 家长不进这一页就不知道有申请。
- **审批页不区分「谁提交的」**：`requesterUserId` 原样保留在模型里，但卡片没渲染；
  多孩子家庭无法从卡片判断是哪个孩子提的（后端按 `childId` 收口，收件箱本来就是单孩子视角）。

## 6. 复跑基线

```bash
# 后端（本阶段零改动，作为不回归基线）
cd backend
npx tsc --noEmit                                # 0
npm test                                        # 443/443（25 文件）

# Flutter（本阶段未改，作为不回归基线）
flutter analyze                                 # 0 issue
flutter test                                    # 122/122

# 小程序（先现编 dist，再跑用例）
cd kids_points_mp
npx tsc --noEmit                                # 0
npm run build:weapp                             # 0（仅有 Sass @import 弃用告警）
npx tsc -p .tmp_test/tsconfig.test.json         # 编到 .tmp_test/dist
node .tmp_test/run.js                           # 91/91
node .tmp_test/run-w5d.mjs                      # 16/16
```
