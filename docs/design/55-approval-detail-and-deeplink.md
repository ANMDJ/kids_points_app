# 55 · 审批详情 ＋ 通知深链（P1-3，2026-11-10）

> 上游口径：[`43`](./43-open-work-backlog.md) §3 P1-3（验收判据）、
> [`50`](./50-unfinished-reasons-and-unblock.md) §4 第 1 条（C 类，可直接开工）。
> 本文只记录**这一轮怎么落地**、哪些判据满足、哪些仍然是边界。

---

## 1. 一句话

**审批从「只有一行摘要的列表」变成「能打开这一条」**：后端补 `GET /approvals/:id`，
双端各有详情页；收件箱卡片、「我的申请」行、**通知里的胶囊**都直接落到那一条
（不再把用户丢进列表自己找）。

| 端 | 落点 | 行为 |
|---|---|---|
| 后端 | `src/approvals/approvals.controller.ts` | 新增 `GET /approvals/:id`，动作 `view_own_approvals`（两侧 ALLOW），收口在 service |
| 后端 | `src/approvals/approvals.service.ts#detail` | `findById(id, childId)` → `detailDenial()` → 404 `APPROVAL_NOT_FOUND` / 403 `NOT_REQUESTER` / 200 详情 |
| 后端 | `src/contracts/approval-policy.ts#detailDenial` | **唯一**放行判定：有批准资格的家长可看本孩子任意一条；否则必须本人 |
| 后端 | `src/approvals/approval-inbox.mapper.ts#toApprovalDetail` | 在列表行基础上补 `requesterRole`（建请求时的成员位快照）＋ `selfApproved`（`isSelfApproved()`） |
| 后端 | `src/approvals/approvals.repository.ts` / `approvals.prisma.repository.ts` | `ApprovalRow.requesterRole?`；`findById` 返回 `ApprovalListRow`（详情与列表同一份读模型） |
| App | `lib/screens/approval_detail_screen.dart` | 抬头（标题 / 状态 / 摘要 / 谁提的）、申请内容、处理情况、执行结果、时间、动作 |
| App | `lib/screens/approvals_screen.dart` | 卡片 `onTap` → 详情（`canDecide: true`）；返回时若改过状态就重拉 |
| App | `lib/screens/my_applications_screen.dart` | 行 `onTap` → 详情（`canWithdraw: true`）；返回**总是**重拉（撤回后行会变） |
| App | `lib/screens/notifications_screen.dart#_open` | 审批胶囊 → 详情；`approval.submitted` 给批准 / 拒绝，结果类只读 |
| App | `lib/data/{read_api,read_dto,read_mapper,app_store}.dart`、`lib/models/approval.dart` | `fetchApproval(id)`；`requesterRole` 可空；`requesterLabel` / `isSelfApproved` / `formatApprovalTime` 收到模型层 |
| 小程序 | `src/pages/approval-detail/{index.tsx,index.scss}` | 同构详情页；`mode=decide / withdraw / view` 决定显示哪些动作 |
| 小程序 | `src/data/{read_api,read_dto,read_mapper,approval,store}.ts` | `fetchApproval(id)`；`approvalRequesterLabel` / `isApprovalSelfApproved` |
| 小程序 | `components/ApprovalCard`、`pages/approvals`、`sheets/MyApplicationsSheet`、`sheets/NotificationsSheet` | 卡片 / 行 / 胶囊都可点进详情；按钮与撤回胶囊 `stopPropagation`（不误触） |
| 小程序 | `pages/profile/index.tsx` | `useDidShow` 递增 `returnTick` → 面板从详情返回后重拉（撤回后不留过时行） |

---

## 2. 验收判据逐条对照（`43` §3 P1-3）

| 判据 | 结果 | 证据 |
|---|---|---|
| 申请内容 / 金额 / 规则快照 | ✅ | `approval_detail_screen.dart#_contentCard`（**按 `summary` 的判别式分支**给字段，不把 JSON 原样丢给用户）；小程序 `Content` 同构 |
| 申请人 | ✅ | 服务端 `requesterRole`（`ApprovalRequest.requesterRole` 的**建请求快照**）→「孩子提交 / 家长提交 / 家庭成员提交」 |
| 时间 | ✅ | 抬头「提交于」＋ 时间卡（提交 / 有效期至 / 剩余）；处理卡有 `decidedAt` |
| 幂等键结果 | ✅（可核对） | 有 `executedRecordId` ⇒ 显示流水 id ＋ 一行说明「幂等键 `approval:<审批 id>`，重复批准只有一笔流水」 |
| **审计行** | ⚠️ **不外发** | 审计表（`AuditLog`）没有对客户端的读接口，本轮**不新开**（会把内部排障信息暴露给所有家长）。详情页给的是**可核对时间线** ＋ 执行流水 ＋ 幂等键；真正需要审计时走运维查库。见 §4 |
| 通知定位到**这一条** | ✅ | App `notifications_screen.dart#_open`；小程序 `NotificationsSheet` 胶囊 → `pages/approval-detail/index?id=…`（`run-w15` 与 `approval_detail_test` 各有一条深链用例） |
| 孩子侧「我的申请」能看详情与撤回结果 | ✅ | App `canWithdraw: true`（**不显示批准**，避免按下去必然 403）；小程序 `mode=withdraw` |

---

## 3. 四个关键设计决策

### 3.1 为什么要新端点，而不是「在列表里翻」

通知里的深链只有一个 `approvalId`。目标那条可能在后面的页、或已不在 `pending`
筛选里；客户端翻页去找既慢又可能找不到（而且「翻不到」和「不存在」长得一样）。
`GET /approvals/:id` 让「是否存在 / 能不能看」变成**一次可区分的事实**。

### 3.2 为什么端点挂 `view_own_approvals`，判定放 policy

同一个详情页服务两种人：

- **有批准资格的家长**（收件箱 / 「有人提交了申请」通知）—— 与收件箱一致；
- **申请人自己**（「我的申请」/ 审批结果通知）。

若挂 `review_approvals`，孩子会被 403 拦在门外，通知深链永远打不开自己的申请。
因此端点挂两侧 ALLOW 的 `view_own_approvals`，**真正的收口**在
`contracts/approval-policy.ts#detailDenial()` —— 与 `withdrawDenial()` 同一纪律：
`approvals.service.ts` 里**不出现任何角色判断**（头注释的硬约束）。

### 3.3 为什么 `findById` 的返回类型拓宽到 `ApprovalListRow`

详情要显示的正是**列表那一行**（payload 摘要 ＋ 三个时间戳），再补两件事。
如果另开 `findDetailById`，两份读模型迟早漂移（列表加了字段、详情忘了）。
`decide` / `withdraw` 只用父类型字段，不受影响。

### 3.4 为什么 `requesterRole` 是快照，不是现查 `ChildMember`

成员位是**可以在审批期间被改的**（家长 ↔ 孩子）。详情页回答的是
「**当时**是谁提的」，现查会把历史改写成现在的样子。该列本来就存在
`ApprovalRequest.requesterRole`，读侧原样透出即可。

---

## 4. 未做 / 边界（每条带卡点类别，口径见 `50`）

| 事项 | 卡点 | 说明 |
|---|---|---|
| **新端点未部署** | **A** | `GET /approvals/:id` 只在源码里。线上镜像不重建 ⇒ 客户端打开详情会拿到 404（路由不存在）。部署命令：`docker compose build kids-api && up -d`（要 `sudo docker`），之后探针应看到 `GET /kids/approvals/x` 从 **404 变成 401** |
| 客户端未发版 | **A** | App 要打新包（`flutter build apk --release …`）并上传 `/app/`；小程序 `dist/` 要在微信开发者工具里「上传」（扫码只有你能做） |
| 审计行读接口 | **B** | 要不要把 `AuditLog` 暴露给家长 = 产品/安全口径，不是技术问题。默认建议：**不暴露**，排障走运维查库 |
| 真机走查 | **D** | 三条路径：收件箱卡片 → 详情 → 批准；通知胶囊 → 详情（家长 / 孩子各一次）；我的申请 → 详情 → 撤回。本环境无 Android 设备 / 无 GUI |
| 小程序构建 | **D** | 本轮只跑 `tsc` ＋ `npm test`（21 个文件），**没有** `taro build --type weapp`，也没在开发者工具里打开过新页面 |
| 详情页的「返回后刷新」 | — | App：收件箱卡片返回时只在 `_changed` 时重拉；我的申请**总是**重拉。小程序：`profile` 的 `useDidShow` 递增 `returnTick` |

---

## 5. 本轮验证（命令实跑）

| 判据 | 命令 | 结果 |
|---|---|---|
| 后端类型 | `cd backend && npm run typecheck` | **EXIT=0** |
| 后端用例类型 | `npm run typecheck:tests` | **EXIT=0** |
| 后端用例 | 编译到 `.tmp_test_build/` 后跑 `approvals-http.test.js` | **72 条全通过**（新增组 I **6 条**） |
| App 静态 | `flutter --no-version-check analyze --no-pub` | **No issues found** |
| App 用例 | `flutter --no-version-check test` | **518 全通过**（新增 `test/approval_detail_test.dart` **8 条**） |
| 小程序类型 | `cd kids_points_mp && npx tsc --noEmit -p tsconfig.json` | **EXIT=0** |
| 小程序用例 | `npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-all.mjs` | **21 个用例文件全通过**（新增 `run-w15.mjs` **9 条**） |
| 真机 / 浏览器 E2E | — | **未做**（D 类） |

---

## 6. 下次怎么复核

```powershell
# 后端：详情端点（含「孩子读别人的 ⇒ 403 NOT_REQUESTER」）
cd backend
node node_modules/typescript/bin/tsc -p tsconfig.test.build.json
node --test .tmp_test_build/test/approvals-http.test.js

# App：详情页 + 深链
flutter test test/approval_detail_test.dart

# 小程序：数据层 + 深链路由参数
cd kids_points_mp
npx tsc -p .tmp_test/tsconfig.test.json
node .tmp_test/run-w15.mjs
```

> 线上判据（部署后）：`curl -i -H 'x-kp-device-id: …' -H 'x-kp-child-id: …' \
> https://hub.littlewish.top:8443/kids/approvals/<id>` ⇒ 无 token **401**（不是 404）；
> 有 token 且是申请人 / 家长 ⇒ **200**。

