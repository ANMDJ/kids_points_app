# 阶段 W5-J 交接单 · 「我的申请」＋撤回（后端 + Flutter + 小程序）

> **状态（2026-10-23）**
>
> | 验证 | 结果 |
> |---|---|
> | `cd backend && npm run typecheck` / `typecheck:tests` | ✅ 退出码 **0** |
> | `cd backend && npm test` | ✅ **553/553**（W5-I 基线 544，本阶段 **+9**） |
> | `flutter analyze` | ✅ `No issues found!`（13.4s） |
> | `flutter test test/write_api_test.dart test/approvals_test.dart` | ✅ **127/127**（本阶段新增撤回 / 我的申请用例） |
> | `cd kids_points_mp && npx tsc --noEmit` | ✅ 退出码 **0** |
> | `cd kids_points_mp && npm run build:weapp` | ✅ 退出码 **0**（仅既有 Sass `@import` 弃用告警，无 `ERROR`） |
> | `cd kids_points_mp && npm run build:h5` | ✅ 退出码 **0**（仅既有 asset size 告警） |
> | `cd kids_points_mp && node .tmp_test/run-w5j.mjs` | ✅ **14/14**（模型 3 / 读 3 / 写 8） |
> | 权限矩阵 | **32 个动作**（新增 `view_own_approvals`：guardian / child 双 ALLOW） |
> | 迁移 | **1 条**（`20261023090000_own_approval_action`，只 `ALTER TYPE … ADD VALUE`，无 DDL 动表） |
>
> **给**：接手「审批推送 / 申请详情页 / 成员管理 UI / 真机联调」的下一个会话。

## 1. 本阶段做了什么

在此之前，孩子提交「兑换 / 加分 / 新增心愿」后**只能看到那一次 POST 的返回体**：
离开页面或重启小程序，就再也找不到自己提过什么；家长收件箱 `GET /approvals`
对孩子是 403（`review_approvals` child DENY），所以这不是「少一个撤回按钮」，
而是**申请人根本没有读路径**。W5-J 补上「我提交的」这条读路径与撤回动作。

| 端 | 层 | 落点 | 行为 |
|---|---|---|---|
| 后端 | 权限 | `src/contracts/permission-matrix.ts` + 迁移 | 新增 `view_own_approvals`（双角色 ALLOW）；撤回继续复用 `withdraw_request` |
| 后端 | 读 | `GET /approvals/mine`（`approvals.controller.ts` / `approvals.service.ts` / 端口 `listForRequester`） | `childId`（屏障一）＋ `requesterUserId = 会话 actor`（不是 query）双条件收口；支持 `status` / `limit` / `cursor`，与收件箱同一分页形状 |
| 后端 | 写 | `POST /approvals/:id/withdraw`（W3-B 已有路由，本阶段补测试与客户端） | 无请求体；`Idempotency-Key`；只允许 `pending → withdrawn` |
| Flutter | 只读 | `lib/data/read_api.dart`、`read_dto.dart`、`read_mapper.dart` | `fetchMyApprovals()` → `GET /approvals/mine`，默认 `status=all` |
| Flutter | 写入 | `lib/data/write_api.dart`、`write_api_errors.dart` | `withdrawApproval(id)`（空 body + 幂等键）；`NOT_REQUESTER` / `ALREADY_DECIDED` 归一 |
| Flutter | 状态 | `lib/data/app_store.dart` | `fetchMyApprovals()` 不写全局收件箱状态；`withdrawApproval()` 只认 `status == withdrawn` |
| Flutter | UI | `lib/screens/sheets/my_applications_sheet.dart` ＋ `profile_screen.dart` 入口 | 列表 / 分页 / 重试 / 空态 / 逐行撤回 + 确认框；「我的」新增「我的申请」 |
| 小程序 | 只读 | `src/data/read_api.ts`（`fetchMyApprovals` + 共用 `approvalPageQuery`）、`read_dto.ts`、`read_mapper.ts` | 同形状，时间转 epoch 毫秒 |
| 小程序 | 写入 | `src/data/write_api.ts`、`write_api_errors.ts` | 同上；`withdrawApproval()` 发 `POST /approvals/:id/withdraw`、`body = null` |
| 小程序 | 状态 | `src/data/store.ts` | `canWithdrawApprovals`、`fetchMyApprovals()`、`withdrawApproval()` |
| 小程序 | UI | `src/sheets/MyApplicationsSheet.tsx` ＋ `sheets.scss`（`kp-myapp__*`）＋ `pages/profile/index.tsx` | 与 Flutter 同构；`items` / `cursor` / `error` 全部组件本地 |
| 用例 | — | `backend/test/approvals-http.test.ts`、`test/membership-http.test.ts`、`test/permission-matrix.test.ts`；Flutter 两个测试文件；`.tmp_test/run-w5j.mjs`（新建 14 条） | 见 §4 |

## 2. 关键实现决策

### 2.1 「我的申请」是新端点 + 新动作，不是给收件箱加参数

```text
GET /approvals        → childId 全量（待我批准）      → review_approvals（child 403）
GET /approvals/mine   → requesterUserId = 会话 actor → view_own_approvals（双 ALLOW）
```


### 2.2 撤回是「申请人收回」，不是「否决」

| | 撤回（W5-J） | 拒绝（W5-D） |
|---|---|---|
| 谁能做 | **只有申请人本人**（家长也不行） | 有 `review_approvals` 的家长 |
| 请求体 | **无** | `{ decision: 'rejected' }` |
| 审计 | `withdraw_request` | `decide(rejected)`，带判定人 / 时间 |
| 目标状态 | `withdrawn` | `rejected` |

家长对别人提的申请点「撤回」会得到 403 `NOT_REQUESTER`；文案明确让他改用「拒绝」——
两条路径的留痕不同，不能混。服务端判定只有一份：`withdrawDenial()`（角色 → 申请人 →
`pending`），service 只把原因映射成 HTTP，不在 controller 里重写条件。

### 2.3 `summary === null` 也必须能撤回

家长侧 W5-D 的规则是「坏 payload 只禁批准、不禁拒绝」，避免坏行永久卡住。
申请人侧同理，而且**只有申请人能救它**（孩子看不到家长收件箱）：

```text
canWithdrawApproval(item, now) = item.status === 'pending' && item.expiresAt > now
```

它**刻意不读 `summary`**。如果加上 `summary !== null`，一条 payload 损坏的申请
既不能被家长批准（看不见内容），也不能被申请人撤回 ⇒ 永远停在 `pending`。

### 2.4 撤回不碰余额 / 流水 / 首页，收件箱只在「已加载」时刷新

`pending` 的申请还没有执行，撤回只改状态：

- **不刷新 `/home`**：积分、流水、心愿都没变，刷新只会多一次往返；
- **收件箱仅在 `approvalReadStatus !== idle` 时刷新**：孩子的设备请求
  `GET /approvals` 必然 403，撤回成功后凭空多发一次注定失败的请求，会把界面
  画成「撤回失败」；
- **409 也只在收件箱已加载时刷新**：本地那一行已经过时（被批 / 过期 / 被拒），
  但没加载过收件箱的设备不需要为它付一次 403。

### 2.5 回包必须验明正身：`status !== 'withdrawn'` 不算成功

与 `ruleId` / `executedRecordId` / `invite.id` 同一手法。若服务端回 200 但状态是
`approved`（契约漂移 / 代理缓存了旧响应），客户端若当成功提示「已撤回」，
家长那边其实还能批 —— 用户会以为事情结束了。两端都返回可展示文案
「服务端返回的状态是「x」，与这次撤回不一致，请刷新确认。」

### 2.6 两个列表的状态**不共用**

小程序 `AppStore` 的收件箱切片有 `approvals` / `approvalError` / `approvalReadStatus`
与游标。`fetchMyApprovals()` 刻意**只返回页对象**，不写任何全局字段：

- 共用列表 ⇒ 先打开「我的申请」再打开家长收件箱，游标 / 错误 / 空态会互相污染；
- 共用 `approvalReadStatus` ⇒ 孩子打开「我的申请」会把收件箱从 `idle` 推到 `ready`，
  之后撤回时就会误判「收件箱已加载」而多发一次 403。

所以 `MyApplicationsSheet` 自己持有 `items` / `nextCursor` / `hasMore` / `loadError` /
`loadedOnce`，与 Flutter 侧一致。

### 2.7 空态必须区分「没拉到」和「真的没有」

| 条件 | 文案 |
|---|---|
| `loadError != null` | 顶部错误行 + 重试（错误原文，不吞） |
| 正在加载 | 正在加载申请… |
| 从未成功加载 | 申请列表还没加载 |
| 预览模式 | 预览模式没有申请记录 |
| live + 成功 + 0 条 | 还没有提交过申请 |

把 403 / 断网画成「还没有提交过申请」是本项目反复记过的坑（W5-I §2.7 同款）。

### 2.8 分页是键集，组件本地按 id 去重

`GET /approvals/mine` 与收件箱共用 `limit + 1` 的键集分页。客户端仍然按 `id`
去重一次：键集翻页本不该重叠，但「加载更多」被快速点两次时，两个在途请求可能
拿回同一页。小程序 `load(false)` 有 `loading` 闸门，去重是第二道保险。

### 2.9 确认文案要说清「撤回不是撤销已发生的兑换」

撤回只对 `pending` 有效，但用户很容易把它理解成「把已经扣的分退回来」。
两端共用同一句模型层文案（Dart `approvalWithdrawConfirmText()` /
TS `approvalWithdrawConfirmText()`）：

> 撤回后兑换「乐高」的申请不会再被批准，积分与心愿都不会变化。

确认框的按钮是「撤回 / 取消」，取消 **0 请求**。

混成 `GET /approvals?mine=1` 有两个问题：

- **权限没法表达**：同一个路由上，家长要全量、孩子只能看自己。用 query 分支意味着
  guard 只认动作、service 再补一条「孩子必须带 mine=1」的规则 —— 漏一次就是
  「孩子看到全家的审批」。
- **语义不同**：收件箱回答「待我批准」，我的申请回答「我提过什么」。后者的
  `pending` 行要画「撤回」，前者要画「批准 / 拒绝」；把两套动作塞进一个列表，
  迟早会出现「家长给自提的申请点批准」这种必然失败的按钮。

因此权限动作也**没有复用** `review_approvals`，而是新增 `view_own_approvals`
（`02 §3` 口径：动作名 = 界面能做什么）。服务端收口条件写死为
`childId + requesterUserId`，`requesterUserId` **只来自会话**，query 里根本没有这个字段。


## 3. 本阶段踩到的坑

### 3.1 路由顺序：`GET /approvals/mine` 必须声明在参数路由之前

`/approvals/:id` 类路由一旦先注册，`mine` 会被当成 id。本阶段把 `@Get('mine')`
放在 controller 的 `list()` 之前，并有用例钉住路径。

### 3.2 幂等键头是**小写** `idempotency-key`

写客户端统一用 `headers['idempotency-key']`。测试里按 `'Idempotency-Key'` 取会得到
`undefined` —— 本轮 `.tmp_test/run-w5j.mjs` 真的这样红过一次。Node 的 http 头名
大小写不敏感，但**我们自己的 transport 是普通对象**，大小写敏感。

### 3.3 `WriteApiException.fromHttp` 要的是**已解码的 Map**，不是 JSON 字符串

直接传 `body: JSON.stringify(...)` 会拿不到 `code`，403 `NOT_REQUESTER` 会退化成
通用 forbidden 文案。用例里固定用对象。

### 3.4 小程序 store 的「已加载」判据是 `approvalStatusValue`，不是 `approvals.length`

用长度判断会把「加载过但确实是空列表」误判成「没加载」。撤回后的刷新策略必须用
状态值（`idle` vs 其它），本轮 store 用例两半都钉了。

### 3.5 本地能判死的先拒，别让用户等一次网络往返

已终态 / 已过期 / 预览模式 / 无写客户端，全部在 store 里先返回文案，**一次请求都不发**。
服务端仍会独立判定（409 / 403），客户端只是「别给一个按下去注定失败的按钮」。

### 3.6 `withdrawn` 之后没有「撤销撤回」

`02 §4.1` 没有 `withdrawn → pending`。需要时重新提交一条新申请；界面不画
「恢复」按钮，否则等于发明了一个不存在的状态迁移。

### 3.7 `contracts:emit` 读的是 `dist/`，不是 `src/`

本阶段第一次直接跑 `npm run contracts:emit`，输出仍是 **31 个动作** —— 因为脚本
`backend/scripts/emit-matrix.mjs` 明确要求先 `npm run build`，它 require 的是
`dist/contracts/permission-matrix.js`。**先 build 再 emit** 才得到 32。
这条与 W0 记过的「run.js 跑产物不跑源码」同源：**漏掉编译步骤，契约会静默少一个动作**，
而 `advisor` 侧会按 31 个动作的 JSON 运行 —— 新端点看起来没有权限定义。

## 4. 用例清单

### 4.1 后端（`npm test` → 553/553）

| 文件 | 覆盖 |
|---|---|
| `test/approvals-http.test.ts`（新增 8 条 `it`） | `GET /approvals/mine`：孩子只读到自己提的、家长也能读自己提的、同家庭别人提的不可见、跨孩子隔离、默认 `pending` / 终态用 `status` 取、键集翻页、未知 query（含 `requesterUserId`）⇒ 400 且端口未被调用、坏游标 400、`viewer` 403。**撤回的 6 条用例是 W3-B 基线**（200 `withdrawn` / 非申请人 403 `NOT_REQUESTER` / 已批准 409 / 过期 409 / 不存在 404 / 跨孩子 404），本轮一并复跑 |
| `test/permission-matrix.test.ts` | 矩阵新增 `view_own_approvals` 双 ALLOW；动作总数 32 |
| `test/membership-http.test.ts` | 权限矩阵快照同步 |
| 真库 | 本阶段未新增 dbtest：撤回的锁与事务在 W3-B 已覆盖；`npm run test:db` 沿用 W5-H 基线 **173/173**（本轮未复跑） |

### 4.2 Flutter（`flutter test` 两文件 → 127/127）

| 组 | 覆盖 |
|---|---|
| `test/approvals_test.dart` `fetchMyApprovals` | 默认 `status=all`、路径是 `mine`、身份头照旧、游标翻页、不写全局收件箱 / 不拉首页 |
| `test/approvals_test.dart` `withdrawApproval` | 预览 / 只读本地拦下 0 请求、`status != withdrawn` 报契约漂移、409 刷新策略、成功不刷首页 |
| `test/write_api_test.dart` 撤回 | `POST` + id 去空白 + 空 body + 幂等键 + 绝不带 applicant 参数；403 `NOT_REQUESTER`、409 文案；回包 id 不符 / 缺字段 ⇒ `malformed` |

### 4.3 小程序（`.tmp_test/run-w5j.mjs` → 14/14）

| 组 | 条数 | 覆盖 |
|---|---|---|
| 模型 | 3 | 坏 payload 仍可撤回；已终态 / 已过期不可撤回（且按传入时刻现算）；确认文案说清「不会扣分 / 不会加心愿」 |
| 读 | 3 | `/approvals/mine?limit&cursor`、不写收件箱状态、不顺手拉收件箱；预览返回空页；`ReadApiClient` 路径正确 + 越界 `limit` 本地拒 |
| 写 | 8 | `POST /:id/withdraw` 无 body + 幂等键（小写头）；成功且收件箱未加载时 0 次 `/approvals`；已加载时刷新一次；契约漂移；409 原样展示 + 刷新 + 不碰余额；403 `NOT_REQUESTER`；本地终态 / 过期 0 请求；预览模式不假成功 |

## 5. 仍未落地（不粉饰）

- **没有推送 / 没有角标**：申请人要打开「我的申请」才知道状态变了；家长批准后
  孩子端不会收到任何通知。
- **没有申请详情页**：列表只显示 `summary` 摘要；`withdrawn` 之后也看不到
  「谁在什么时候批过」。审计接口未对客户端开放。
- **没有筛选 chip**：`GET /approvals/mine` 支持 `status`，但两端 UI 固定拉全部
  （符合「我提过什么」的预期）；数据量大时只能靠「加载更多」。
- **成员管理 UI（W5-H 遗留）仍未建**；`POST /invites/accept` 仍等 L2 登录。
- **没有真机 / 微信开发者工具截图验证**：证据只有 `tsc` + `build:weapp` +
  `build:h5` + 离线用例。底部弹窗、长列表、`confirm` 在真机上的表现是**推断**。
- **Flutter 侧没有 widget 测试**：127 条都在 store / API / 模型层，UI 只经
  `flutter analyze`。
- **`npm run test:db` 本轮未复跑**：本阶段没有改事务 / 锁 / SQL；如接手要动
  `approvals.prisma.repository.ts`，先跑一次真库基线。

## 6. 复跑基线

```bash
cd backend
npm run typecheck && npm run typecheck:tests    # → 0 / 0
npm test                                        # → 553/553
npm run build                                   # → 0
npm run contracts:emit                          # → 32 个动作（必须先 build：脚本读 dist/）

cd ..
flutter analyze                                 # → No issues found!
flutter test test/write_api_test.dart test/approvals_test.dart   # → 127/127

cd kids_points_mp
npx tsc --noEmit                                # → 0
npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w5j.mjs
                                                # → 14/14（模型 3 / 读 3 / 写 8）
npm run build:weapp                             # → 0（只剩既有 Sass @import 弃用告警）
npm run build:h5                                # → 0（只剩 asset size 告警）
```

手工冒烟（开发库，先 `npm run migrate:deploy`）：

```bash
# 我提交的申请（孩子设备与家长设备都应是 200，但各自只看到自己提的）
curl -s 'http://localhost:3000/approvals/mine?status=all&limit=20' \
  -H 'x-kp-device-id: demo-device-child' -H 'x-kp-child-id: demo-child'

# 撤回（必须是 pending 且是本人提的）
curl -s -X POST http://localhost:3000/approvals/<approvalId>/withdraw \
  -H 'idempotency-key: smoke-withdraw-1' \
  -H 'x-kp-device-id: demo-device-child' -H 'x-kp-child-id: demo-child'
```

对照面：

- 用**另一位家长**的设备撤同一条 ⇒ 403 `NOT_REQUESTER`（文案让他改用「拒绝」）；
- 撤回后再撤一次 ⇒ 409 `ALREADY_DECIDED`，且第一次的 `decidedAt` 不变；
- 家长设备 `GET /approvals` 仍看不到 `withdrawn` 的待办（状态筛选默认 `pending`）。

**入口位置**：两端都在「我的」页，成员管理 / 邀请码下方新增「我的申请」一行
（小程序剪贴板图标），点开是底部弹窗（Flutter `showModalBottomSheet` /
小程序 `SheetFrame`），**打开才拉数据**，不占首页刷新预算。
