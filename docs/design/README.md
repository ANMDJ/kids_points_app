# 设计文档索引 · Kids Points

> 本目录是**可评审的设计事实源**，所有条目均以现有代码中的真实方法/调用点为依据，非推测。

> **需求侧文档**（面向「做什么、为什么做、做到什么程度算完成」）见 [`../PRD.md`](../PRD.md) ——
> 它整合本目录 `01`–`16` 的事实，不重复承载实现细节；两者冲突时**以本目录的设计文档为准**。

| 文档 | 内容 | 状态 |
|---|---|---|
| [`01-overview.md`](./01-overview.md) | 系统概览、架构与信任边界、**事务边界**、模块边界、数据模型总览 | ✅ 完成 |
| [`02-rbac-and-approval.md`](./02-rbac-and-approval.md) | 双角色权限矩阵、三道屏障、审批状态机、**积分记录不可变性与规则版本化** | ✅ 完成 |
| [`03-existing-defects.md`](./03-existing-defects.md) | 既有缺陷清单（A/B/C/D/E 五类共 **19 条**：原 18 条 ＋ C5 补入的 `D9`）+ 修复顺序 | ✅ 完成 |
| [`04-onboarding-and-templates.md`](./04-onboarding-and-templates.md) | 首次引导流程、规则模板库、同意与合规 | ✅ 完成 |
| [`05-dev-plan.md`](./05-dev-plan.md) | 开发计划（**AI 辅助重估 ≈6.1 周**）、压缩选项（已否决）、风险登记、**阻塞项 L1–L6**、**决策登记 P1–P3** | ✅ 完成 |
| [`06-w0-report.md`](./06-w0-report.md) | **W0 实施报告**：**6 处文档缺陷 + 9 处落地缺陷（编号 7–15）**、D1–D10 **决策已全部裁定（12 条，见 §3.1）**、产物清单、**真实命令与退出码**、**§10 数据库打通与三项验收门关闭**、**两个"假绿"陷阱与反向对照** | ✅ W0 已执行 |
| [`07-c3-handoff.md`](./07-c3-handoff.md) | **阶段 C3 交接单**（E16 心愿配色 → 稳定枚举 `WishCoverStyle`）：已落地清单＋行号、**七道闸门实测与退出码**、**证伪 6 例（含 ③ 的实测勘误）**、**本轮真踩过的 9 条陷阱** | ✅ C3 已收口 |
| [`08-c4-handoff.md`](./08-c4-handoff.md) | **阶段 C4 交接单**（C9 软删除/回收站 ＋ C10 规则可编辑 ＋ C11 `AuditLog`）：**后端 schema/索引/`REVOKE` 就绪清单**、双端**空白落点与调用方行号**、守门人三块 `unfixed→fixed` 的改法与反回退断言、**七道闸门基线**、**5 件待决策** | ✅ C4 已收口 |
| [`09-c5-handoff.md`](./09-c5-handoff.md) | **阶段 C5 交接单**（`D9` 图标名 ↔ `IconData`）：**三端类型表与「为什么光有映射表不够」**、落地清单（文件级）、**新增闸门 `icons:check` 的 7 项检查**、**闸门 12/12 ＋ 用例 3/3 ＋ 3/3 证伪**、**两次「反例假绿」的自我纠正**、遗留（编辑不可改图标 / 名单仍手抄） | ✅ C5 已收口 |
| [`10-d1b-handoff.md`](./10-d1b-handoff.md) | **阶段 D-a 交接单**（`D1b` `relation` 升枚举 `RelationKind`）：**三处手抄契约 ＋ Prisma 默认 `DROP+ADD` 会静默清列这个坑**、落地清单、**新增闸门 `relation:check` 的 5 项检查**、**证伪 15 例（含 3 控制例）**、**三条自我纠正**、遗留（`D3b` / 首启引导 / 闸门 ④ 目前"无字面量可查"） | ✅ D-a 已收口 |
| [`11-d3b-handoff.md`](./11-d3b-handoff.md) | **阶段 D-b 交接单**（`D3b` `ChildMember.restrictions` 裸 `Json` 定形）：**为什么定形只能落在应用层（Prisma 表达不了 `Json` 内部形状）**、权威源 ↔ 两处手抄的三处对账、落地清单、**新增闸门 `restrictions:check` 的 6 项检查**、**证伪 17 例（14 反例：每例"红且只点名自己" ＋ 3 控制例）**、**`02` §3 去掉开放标记 `...` 的口径修正**、遗留（写入路径未开工 / 闸门此刻"无字面量可查"） | ✅ D-b 已收口 |
| [`12-w3c-handoff.md`](./12-w3c-handoff.md) | **阶段 W3-C 交接单**（审批链路收尾）：**4 执行器 / 5 种 `autoReason` / `expireDue()` 后台扫描 / `Idempotency-Key`**、真库证据与可复跑基线、**`add_wish` 无流水 / 加分流水不带 `ruleId` / 幂等响应缓存不在业务事务**等 8 条防复发坑、W4 接手顺序与仍未落地边界 | ✅ W3-C 已收口 |
| [`13-w4a-handoff.md`](./13-w4a-handoff.md) | **阶段 W4-A 交接单**（只读后端 `GET /home` / `GET /records`）：**端口/适配器/映射/三道屏障**、`goodHabitCount` 与 `rewardCount` 的历史口径、`limit + 1` 分页、三层证据（离线 HTTP / 装配 / 真库）、**真库抓到的 `/records` 对已删孩子返回空页**、仍未落地的写端点边界 | ✅ W4-A 已收口 |
| [`14-w4b-handoff.md`](./14-w4b-handoff.md) | **阶段 W4-B 交接单**（记录页键集分页）：`cursor` / `nextCursor` 契约、同毫秒 `(createdAt, id)` 双条件、非法游标 400、Flutter DTO/AppStore/UI 三态、**live 只读拦截位置**、`didChangeDependencies` 同步 notify 的坑、可复跑基线 | ✅ W4-B 已收口 |
| [`15-w4c-handoff.md`](./15-w4c-handoff.md) | **阶段 W4-C 交接单**（小程序只读接入）：三项 env 编译期注入与缺一降级、Taro `ReadApiClient` / 严格 DTO / `readEpoch` 防竞态、记录页服务端分类过滤 ＋ 游标翻页、只读写入口拦截、首页/记录页下拉刷新、**首屏未完成时切分类的双端同款竞态修复**、可复跑基线 | ✅ W4-C 已收口 |
| [`16-w4d-handoff.md`](./16-w4d-handoff.md) | **阶段 W4-D 交接单**（打卡 / 撤销写入）：`POST /records/check-in` / `:id/reverse` 的单事务 8 步、共用 `appendDraftInTx()`（锁 + 库钟 + 严格递增 + 余额 CAS）、业务日 `[start,end)` 与撤销释放名额、幂等三态与 `undo:<recordId>`、**真库抓到的 naive timestamp +8h / 未来边界行推后所有打卡 / 快照必须来自规则版本行**、前端写入口仍未放开 | ✅ W4-D 已收口 |
| [`17-w4e-handoff.md`](./17-w4e-handoff.md) | **阶段 W4-E 交接单**（双端 live 打卡 / 撤销）：独立 `WriteTransport`（不改只读路径）、`submitCheckIn` / `submitUndoCheckIn`、写成功后先落地返回流水再刷新快照、`executedRecordId==record.id` 强校验、业务码优先的 409 / 404 文案、双击串行与幂等键、**live 无写客户端必须拒绝而不是本地假写** | ✅ W4-E 已收口 |
| [`18-w5a-handoff.md`](./18-w5a-handoff.md) | **阶段 W5-A 交接单**（规则写端点）：四条路由（建 / 改 / 软删 / 按规则加习惯）＋三道屏障 ＋ `Idempotency-Key`、`expectedVersion` 乐观锁与 409 文案、**DELETE 无 body 也无 `Content-Type`**、回包 `ruleId` / `executedRecordId` 类同款「验明正身」、带符号分值原样发出、写回包与 `GET /home` 共用 `mapRule` / `mapHabit`、删除先改本地镜像再刷新、**缺陷闸门 E15 改为钉参数形状** | ✅ W5-A 已收口 |
| [`19-w5b-handoff.md`](./19-w5b-handoff.md) | **阶段 W5-B 交接单**（记一笔写端点）：`POST /records/adjust` ＋三道屏障（孩子 403）＋幂等、**余额由服务端锁内决定**（409 `INSUFFICIENT_POINTS`）、请求体集合封闭（`childId` / `source` / `balanceAfter` 不许客户端说）、0 分三层拒绝、live 不预置本地流水（id / 余额只认回包）、弹层 `saving` 态、双端 12 条运行时用例 | ✅ W5-B 已收口（**基线数字已被 20 号单取代**） |
| [`20-w5c-handoff.md`](./20-w5c-handoff.md) | **阶段 W5-C 交接单**（心愿兑换）：兑换**没有独立路由**，只能走 `POST /approvals`（`action='redeem'`）、请求体只发 `action + targetId`（不发 `costSnapshot` / `autoApprove`）、**`pending` 不是成功**（`null` 只留给 `approved`）、`approved` 只刷新服务端快照、409 `WISH_ALREADY_REDEEMED` 说「没有提交」、`status` 保持字符串降级、本地心愿只用于拼文案、**兑换前确认弹层**（live 说「提交申请 / 批准后才扣」，预览说「立即扣除」，取消 0 请求）、入口判据 `isWishWriteReadOnly`（原 `isReadOnly` 会让 live 兑换永远点不动）、真库补 409 用例 | ✅ W5-C 已收口 |
| [`21-w5d-handoff.md`](./21-w5d-handoff.md) | **阶段 W5-D 交接单**（家长审批收件箱 · 小程序镜像）：收件箱是**独立 store 切片**（403 不污染首页读状态）、`summary=null` **只禁批准不禁拒绝**（坏行不能永久卡住）、未知 `status` 显示「状态未知（x）」、`decideApproval` 三层拦截（本地判死 → `decidingApprovalId` 防串批 → 409 重拉）、**批准**重拉首页 + 列表 / **拒绝**只重拉列表、空态四分（预览 / 403 / 读失败 / 真空）、切筛选重新向服务端要第一页（`all` 不发 `status`）、首帧把 `idle` 当 loading、底部 tab 3 → **4**（`currentIndex` 三处同步）、`run-w5d.mjs` 16 条＋**夹具必须用 ISO 时间**这个坑 | ✅ W5-D 已收口 |
| [`22-w5e-handoff.md`](./22-w5e-handoff.md) | **阶段 W5-E 交接单**（档案改名）：`PATCH /child`（200 `{childId, name}`，身份只来自会话、路径无 id）、矩阵 `edit_child_profile`（孩子 403）、**无 `Idempotency-Key`**（同名在锁内短路 ⇒ 构造幂等、不写 UPDATE 不写审计）、单事务 `FOR UPDATE` ＋ `child.rename` 快照（防审计 `A→C` 丢一段）、**16 字只按码点判一处**（DTO 32 是 UTF-16 粗上限）、`P2025→404` / `P2002→409`、双端 `submitRenameChild()` **写后不重拉 `/home`**（回包即权威）、`isProfileWriteReadOnly` 取代全局 `isReadOnly`、Flutter 弹窗改 `TextFormField` 修「controller 已 dispose」、小程序不再 `slice(0,16)` 静默截断 | ✅ W5-E 已收口 |
| [`23-w5f-handoff.md`](./23-w5f-handoff.md) | **阶段 W5-F 交接单**（回收站 · 软删 90 天）：`DELETE /habits/:id` 与 `/trash` 三条路由（`view_trash` 孩子 **ALLOW**、恢复/彻底删除孩子 DENY）、**服务端只下发 `deletedAt`，`expired` 由双端同一 90 天常量现算**（不缓存、不自动清理、过期条目仍列出）、恢复由构造幂等 / 彻底删除重复调用得 404（故都不加 `Idempotency-Key`）、彻底删除两道闸（`TRASH_ITEM_NOT_DELETED` / `TRASH_ITEM_REFERENCED`）、习惯的父规则还在回收站 ⇒ `TRASH_PARENT_RULE_DELETED`、审计必须写在 `delete()` **之前** 且 `after = JsonNull`、`PointRuleVersion` 是 `Restrict` 要先删版本行、**回收站读失败绝不清空列表**（清空＝假装已彻底删除）、小程序分支只认 `readApi !== null` **不看 `usingPreview`**、未知 `kind` 一律响亮失败（400 / `malformed`，绝不跳过一行）、回包 `{kind,id}` 验明正身、批量清理如实报 `purged`/`failed` | ✅ W5-F 已收口 |
| [`24-w5g-handoff.md`](./24-w5g-handoff.md) | **阶段 W5-G 交接单**（邀请码）：`/invites` 四条路由（`invite_member` guardian ALLOW / child DENY；`accept` **只有身份屏障** —— 被邀请人按定义还不是成员）、**原子占位 = 一条 `UPDATE … WHERE usedCount < maxUses AND expiresAt > now() AND revoked = false RETURNING`**（端口上**没有** `findByCode()`，TOCTOU 无处可写）、占位与成员位 / 会话 / 审计**同一事务**（失败回滚 ⇒ 名额不被烧）、真库并发 **10 个请求 vs `maxUses=3` ⇒ 恰好 3 成功 / 7×409**、四种不可用收敛成同一 409、形状错 400 `INVITE_CODE_MALFORMED`（不猜 `O→0`）、`ALREADY_MEMBER` 不烧名额不改角色、`removed` 成员用新码回来复用同一行、共享平板 ⇒ `DEVICE_SESSION_CONFLICT`、审计**不写码**、均不加 `Idempotency-Key`、会话 TTL **30 天**（偏离 `02 §7` 5 分钟，PIN 未落地）、`viewer` 不可邀请、**演示脚本 `npm run seed:demo`**（演示码 `MAMA2345`，用真实校验器断言） | ✅ W5-G 已收口（服务端；**双端 UI 未建**） |
| [`25-w5h-handoff.md`](./25-w5h-handoff.md) | **阶段 W5-H 交接单**（成员管理）：`/members` 三条路由（`view_members` 孩子 **ALLOW** / `change_member_role` / `remove_member` 孩子 DENY）、**最后一位家长保护靠 `SELECT … ORDER BY id FOR UPDATE` 锁住该孩子全部成员位**（先查后写与单条条件 `UPDATE` 在 READ COMMITTED 下都能双双通过）、降级与**同事务收回 `DeviceSession.activeRole`** ＋ 读路径 `clampRoleToMembership()`（矩阵角色 = min(会话, 成员位)）、两条写路由**禁止作用于自己**（`CANNOT_MODIFY_SELF`）、`PATCH` 同角色 / `DELETE` 重复调用都是**构造幂等**（不写第二条审计、`removedAt` 不变）、移出**不删会话**（否则 `MEMBER_REMOVED` 退化成 401）、线格式只给 `role`/`status`/`isSelf` 不给权限结论、审计快照只含 `role`/`status`、`viewer` 不可作为目标角色、真库 **3 家长环形降级 ⇒ 恰好 2 成功 / 1×409**、**新增测试守卫 ④**（文件级 `✔` ⇒ 红，专治 `describe` 被关进 hook 的 D12 式假绿；已在 `test:canfail` C/C2 常设证伪） | ✅ W5-H 已收口（服务端；**双端 UI 未建**） |
| [`26-w5i-handoff.md`](./26-w5i-handoff.md) | **阶段 W5-I 交接单**（双端邀请码界面）：**先拉成员再拉邀请码**（`invite_member` 仅 guardian ALLOW，用 403 探测角色会把权限画成故障）、状态**渲染时现算**且优先级 `revoked > exhausted > expired`（先答库里的既成事实，再答依赖时钟的判断）、生成表单是**封闭选项**（1/3/5 人 · 1/7/30 天；服务端 1..10 / 1..30）、`POST /invites` **不带**幂等键而吊销是构造幂等、回包 `role`/`maxUses`/`id` **回显校验**、复制**裸码**（展示才分组）、已吊销行不再画吊销按钮、空态**三分**（没拉到 / 加载中 / 真的没有）、预览模式**不编假码**、live 无写客户端**拒绝而不本地假写**、生成 409 与吊销 404 重拉而吊销成功只改本行、Flutter **+8** / 小程序 **19** 条用例、**`accept` 仍无客户端（等 L2 登录）** | ✅ W5-I 已收口（**双端 UI 已建**；`accept` 与成员管理 UI 未建） |
| [`27-w5j-handoff.md`](./27-w5j-handoff.md) | **阶段 W5-J 交接单**（「我的申请」＋撤回）：申请人**没有读路径**才是真缺口（收件箱对孩子 403）、新端点 `GET /approvals/mine` ＋ 新动作 `view_own_approvals`（双 ALLOW，**不复用** `review_approvals`）、收口写死 `childId + requesterUserId = 会话 actor`（query 里没有这个字段）、`POST /:id/withdraw` **无请求体**、`summary === null` **也必须能撤回**（否则坏行永久卡住）、撤回**不刷首页**且收件箱**仅在已加载时**刷新（孩子请求 `/approvals` 必然 403）、回包 `status !== withdrawn` 算**契约漂移**、两端列表状态**不共用**（游标 / 错误互不污染）、空态区分「没拉到 / 还在加载 / 真的没有」、Flutter **127** / 小程序 **14** 条用例、真库本轮未复跑 | ✅ W5-J 已收口（**双端 UI 已建**；推送 / 详情页 / 成员管理 UI 未建） |
| [`28-w5k-handoff.md`](./28-w5k-handoff.md) | **阶段 W5-K 交接单**（审批结论推送端口）：业务只认识 `NotificationsService.notifyApprovalStatusChanged()`（**1s 超时 + 永不抛错**），渠道只认识 `PUSH_PORT`；默认 `NoopPushAdapter` **如实**返回 `provider_not_configured`（**不假成功**）；调用点在 `decide()` **端口返回之后**（账本已提交，`01` §4 / `02` §9.23），推送故障**不改写 200**；只推 `approved` / `rejected`，收件人恒为 `requesterUserId`，**自批 / 撤回 / 过期不推**；消息**不带金额 / 标题**（第三方通道会保留内容）；重复 decide 409 不重复推送；**没有真实渠道 / 设备 token 上报**（站内通知中心已在 W5-L 补上，见 §5.2），接入清单见 §5.1；backend **+12**（565/565）、**无迁移**；§5.2 = W5-L 站内通知中心、§5.3 = W5-M 提交即通知家长 | ✅ W5-K 已收口（**仅后端端口**；渠道 / 客户端未接） |
| [`29-w6a-handoff.md`](./29-w6a-handoff.md) | **阶段 W6-A 交接单**（设备 token 上报 ＋ 真实 Webhook 推送）：新动作 `manage_device_tokens`（guardian / child **双 ALLOW**）＋ 迁移；`POST /device-tokens` / `POST /device-tokens/revoke`（身份只来自会话、**响应不回显 token**、注销走**请求体**没有 `/:token` 路由、`owned_by_other` ⇒ **409** / 不是我的 ⇒ **404**、同一用户 **LRU 上限 10**）；`PUSH_PORT` 改 `useFactory` 选绑定，`WebhookPushAdapter` **真的发 HTTP**（`{version,event,message,tokens}`、`x-kp-event`、可选 Bearer、800ms 超时、**410 只下线本次发送的 token**、5xx/401 不动 token），配置三态 `ok / disabled / invalid`（`invalid` 打 error）；核心模块**无 controller** 以免重复注册路由；三层证据 = 离线 32 ＋ HTTP 20 ＋ 真库 14（并发唯一约束 / LRU / 条件注销幂等 / `SetNull`）；`npm test` **638/638**、`test:db` **206/206**、矩阵 **35** 动作；**仍无厂商凭据 / 网关 / 客户端上报 / outbox** | ✅ W6-A 已收口（**仅服务端**；真机推送未验） |
| [`30-w6b-handoff.md`](./30-w6b-handoff.md) | **阶段 W6-B 交接单**（推送失败重试队列 `PushRetryJob`）：新枚举 ＋ 新表（`dedupeKey` 唯一 / **无** User·Child 外键 / `expiresAt` 必填）＋ 迁移；`PUSH_PORT`（业务：发一次 + **失败即入队**）与 `PUSH_DELIVERY_PORT`（worker：只发一次）**两个令牌**，杜绝「重试再入队」的环；失败分两类 —— `provider_error` **消耗** `attempts`、按 30s→1m→2m→4m→8m→16m（封顶 30m）退避、用满 6 次 ⇒ `dead`；`no_device_token` / `provider_not_configured` **不消耗**次数、固定 5m 重试到 TTL ⇒ `expired`；`claimDue` = 单条 `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING`（**真库抓到 `RETURNING` 行序未定义**，已在应用侧按 `nextAttemptAt` 重排），`sending` 超 `claimTimeout` 可回收（崩溃自愈，极端下**可能重复发一次**）；六个 `PUSH_RETRY_*` 旋钮（非法值夹取、开关拼错仍开启、`enabled=0` 打 warn）；连续 3 次失败打一条 warn（成功才重新武装）；证据 = 离线 **36** ＋ 真库 **14**（并发不重叠 / `sending` 回收 / 条件结算 / 唯一约束**不改写原行**），`npm test` **664/664**、`test:db` **220/220**、矩阵仍 **35** 动作；**这不是真 outbox**（请求路径仍同步发一次、入队在事务外）、仍无厂商凭据 / 网关 / 客户端上报 / retention / 外接告警 | ✅ W6-B 已收口（**仅服务端**；真机推送未验） |
| [`31-w6c-handoff.md`](./31-w6c-handoff.md) | **阶段 W6-C 交接单**（审批通知的**真 outbox**）：`approval.submitted` / `approved` / `rejected` 的 `Notification` 与 `PushRetryJob` 在**审批的同一个数据库事务**里写入（`createPending` / `decide` 内），请求路径**一次推送都不发**、`PushRetryWorker` 成为唯一发送者；收件人解析（active guardian、排除提交人）与去重（先查 `dedupeKey`、`skipDuplicates` 兜竞态）都在 outbox；`PUSH_PORT` 不再套重试装饰器（`useExisting: PUSH_DELIVERY_PORT`），`NotificationsService` 收敛为**只读**；outbox 写失败 ⇒ 审批事务回滚（响亮失败，无库 501），外部推送失败仍只影响 `attempts` / `status`；证据 = 离线 8 ＋ HTTP 组 G/H ＋ 真库 3（同事务两行 / 真实监护人 / 注入抛错回滚审批），`npm test` **653/653**、`test:db` **223/223**、矩阵仍 **35** 动作；**仍无厂商凭据 / 网关 / 客户端 token 上报 / 对账 / retention** | ✅ W6-C 已收口（**仅服务端**；真机推送未验） |
| [`32-w6d-handoff.md`](./32-w6d-handoff.md) | **阶段 W6-D 交接单**（对账 ＋ 保留清理）：`NotificationsReconcileWorker` **只读、只告警、绝不自动补发**（端口只有一个 `snapshot(now)`），匹配键三层 —— `recipientUserId` ＋ `payload.approvalId` ＋ 事件语义（`submitted`⇔`submitted`；`approved`/`rejected`⇔`status_changed` 且 `payload.status` 相符），缺任一层都会让对账恒为 0 或把「批准通知 ↔ 拒绝任务」错配；额外一条**分组计数** `duplicateNotifications`（同「收件人+类型+approvalId」出现 n 次计 n−1）—— W6-C 唯一残留竞态（多一条站内通知、任务只有一条）在「配对存在性」看来完全健康；状态分布 `dead`/`expired`/`pending` **不算漂移**（没配网关时会把告警变成永远为真）；`PushRetryRetentionWorker` 只删 `sent`(7d)/`expired`(7d)/`dead`(30d)，`pending`/`sending` 永不删，时间字段 `updatedAt`（三终态统一的终结时刻），严格 `<` 截止线，分批 `DELETE … WHERE id IN (SELECT … ORDER BY updatedAt LIMIT n)`（`deleteMany` 无 limit）＋ 适配器运行期状态白名单，**部分失败一轮仍抛错**；两个无库实现都抛 **501**（不返回全零快照 / 0 条删除冒充「一切正常」）；新增 `@@index([status, updatedAt])` 迁移；证据 = 离线 **40** ＋ 真库 **17**（收件人隔离 / 状态错配 / 重复计数 / 真实删除范围 / 边界 1ms / `LIMIT` / 枚举强转 / `updatedAt` 口径），`npm test` **693/693**、`test:db` **240/240**、矩阵仍 **35** 动作；**仍无厂商凭据 / 网关 / 客户端 token 上报**（真机推送未验），无外部告警通道、无归档、无多实例锁 | ✅ W6-D 已收口（**仅服务端**；真机推送未验） |
| [`33-w6e-handoff.md`](./33-w6e-handoff.md) | **阶段 W6-E 交接单**（Flutter 设备 token 上报）：独立 `DeviceTokenApi`（**不并进 `WriteApi`** —— 推送失败不得影响打卡 / 登录 / 首页，且现有 `implements WriteApi` 替身不该被牵连）；`PushTokenConfig` 区分「未配置 / 配置错误」（release/profile **拒绝**编译期 `KP_PUSH_TOKEN`）；`PushTokenRegistrar` **永不抛错**、单飞（并发拿到同一 Future）、同 token 去重、**409 `OWNED_BY_OTHER` 进程内短路不重试**、注销 404 按已注销；`main()` fire-and-forget 并 `whenComplete(close)`（W6-F 已改为长期存活的 runtime）；日志 / 结果 / `ArgumentError` **都不含 token**（SDK 异常只打 `runtimeType`）；新增 40 条用例，`flutter analyze` 无问题、`flutter test` **240/240**；**W6-E 当时仍无真实 FCM/APNs SDK、无生命周期重报、无退出登录注销、无真机 / 真后端证据**（生命周期重报 / 注销入口已由 W6-F 补上）；小程序因缺微信登录（`openid`）**刻意不做** | ✅ W6-E 已收口（**仅 Flutter**；厂商 SDK 未接） |
| [`34-w6f-handoff.md`](./34-w6f-handoff.md) | **阶段 W6-F 交接单**（推送 token 生命周期）：`PushTokenRuntime` 长期持有 registrar —— `start()` 启动即报、`reportIfDue()` 只在 **resumed** 时按 **5 分钟冷却**重报（失败也消耗窗口，避免断网时每次切前台都等超时）、`revoke()` **先停用再注销**（并发 resume 不会把 token 登记回去）、`dispose()` 等在途请求结束才关 HttpClient；`PushTokenLifecycle` 是唯一 Flutter 绑定胶水，只认 `resumed`；新增 **16** 条用例，`flutter analyze` 无问题、`flutter test` **256/256**；**仍无真实 FCM/APNs SDK、无 token refresh 流、无登录流程调用点、无真机证据** | ✅ W6-F 已收口（**仅 Flutter**；真实 SDK 未接） |
| [`35-w6g-handoff.md`](./35-w6g-handoff.md) | **阶段 W6-G 交接单**（推送链路端到端冒烟）：`test-db/push-delivery-e2e-db.dbtest.ts` 用**真 `AppModule` ＋ 真 Prisma ＋ 真 `PushRetryWorker.tick()` ＋ 真 `WebhookPushAdapter`**，把「审批 HTTP → 同事务 outbox → 领件 → 查 active token → POST **本地 `node:http` 网关** → 回写任务」一次跑通；只覆盖 `PUSH_DELIVERY_PORT`（仍是生产适配器，仅 URL 指向本地）与 `PUSH_RETRY_CONFIG.batchSize=1`，**不需要 L2/L3 推送凭据**；网关三种回应分别钉死 `sent` / 渠道故障 `attempts+1` / `410` 下线 token；★ 500 组额外断言**推送失败不回滚业务**（审批仍 `approved`、心愿仍落库），无 token 组断言网关 **0 次调用**且 `attempts` **仍 0**（结构性失败不烧次数）；共享库不 DELETE，靠 `nextAttemptAt=2000-01-01` 选行；证据 = `test:db` **246/246**（本套件 **6** 条）、`npm test` **693/693**、矩阵仍 **35** 动作；**仍无真实厂商 SDK / 凭据、无客户端参与、无调度计时 / 真机到达验证** | ✅ W6-G 已收口（**服务端链路已接通到本地网关**；真机推送未验） |
| [`36-w7a-handoff.md`](./36-w7a-handoff.md) | **阶段 W7-A 交接单**（监护人同意 · 后端）：`GET /consent` / `POST /consent` / `POST /consent/withdraw` ＋ 矩阵 **37** 动作（`view_consent` / `manage_consent`，对孩子均 DENY，迁移 `20261026090000_consent_actions`）；「撤回后写入停止」落在**第四道屏障** `ConsentGuard`，判据是 `contracts/consent-policy.ts` 的**显式清单**（24 写 / 13 豁免，两个集合恰好划分全部动作，未知动作按写 fail-closed）；豁免口（`manage_consent` / `view_consent` / `withdraw_request` / `switch_role_mode`）是合规要求 —— 否则「可撤回」变成「可永久锁死」；`GuardianConsent` 授予 / 撤回在 `$transaction` + `SELECT … FOR UPDATE` 内完成（同版本重复授予不写审计、重复撤回幂等、从未授予撤回 ⇒ **409 `CONSENT_NOT_GRANTED`**）；`none`（从未同意）**同样 403**，不自动补假同意；IP / UA 只存 HMAC（无 `CONSENT_PII_SALT` ⇒ 存 `null`）；证据 = `npm test` **41 文件 / 746 条**（新增 `consent-policy` / `consent-guard` / `consent-http` / `consent-pii`）、`honesty:probe` 5 项全 PASS、`npm run ci` **CI_EXIT=0**；**L5 法务文本未定稿（版本号仍占位）、前端同意入口未建（导出已由 W7-C、删除已由 W7-D 落地）、真库并发幂等无用例** | ✅ W7-A 已收口（**仅后端**；引导第①步 UI 未做） |
| [`37-w7c-handoff.md`](./37-w7c-handoff.md) | **阶段 W7-C 交接单**（家庭数据导出）：`GET /export` ＋ 矩阵 **38** 动作（`export_family_data`，guardian ALLOW / **child DENY**，迁移 `20261027090000_export_action`）；一份 JSON 含档案 / 成员 / 规则与版本 / 习惯 / 心愿 / 流水 / 审批 / 同意 / 审计九段，`summary` 如实给出 `counts` / `totals` / `truncated` / `truncatedSections`（`EXPORT_LIMITS`：流水 5 万、审批与审计各 5 千、小集合 2 千）；★ **不挂 `ConsentGuard`** —— 撤回同意后仍必须可用（04 §5 可携带权），清单变成 24 写 / 14 豁免；`Content-Disposition` 纯 ASCII ＋ `no-store`；无库 **501** 绝不返回空文件；双端只解析文件头与摘要、**复制服务端原文**，先 `refreshMembers()` 判角色（孩子不发请求）、单飞、失败不清空旧文件；证据 = `npm test` **43 文件 / 780 条**（`export-http` 9 ＋ `export-wiring` 23）、`flutter test` **296/296**（新增 22 条，含「刷新失败同时报错」）、小程序 `tsc` / `build:weapp` EXIT=0、`node .tmp_test/run-w7c.mjs` **12/12**（导出数据层的运行时用例：截断自洽 / `rawJson` 逐字 / 错误归一 / 单飞 / 失败保留旧文件）；**真库 `test-db/export-db.dbtest.ts` 19/19 通过（`test:db` 19 文件 / 265 用例全绿、`ci:db` EXIT=0）**（删除已由 W7-D 落地） | ✅ W7-C 已收口（后端 ＋ 双端 ＋ 真库） |
| [`38-w7d-handoff.md`](./38-w7d-handoff.md) | **阶段 W7-D 交接单**（家庭数据删除）：`GET/POST /family-deletion` ＋ `POST /family-deletion/cancel`，矩阵 **40** 动作（`view_family_deletion` / `manage_family_deletion`，guardian ALLOW / **child DENY**，迁移 `20261027110000_family_deletion`）；申请 ⇒ `pending`（冷却 **7 天**，落库 `scheduledFor`，可撤销）⇒ worker 到期 `executed`（**同一事务**内就地匿名化：孩子昵称 / 成员 PIN / 规则与版本文字 / 流水文本 / 审批 payload / 通知 / 同意 IP·UA 抹掉，**流水数值与余额保留**，02 §5.7 I5）；`{confirmed:true}` 二次确认（缺 / `false` / 字符串都 400）；两条路由**不挂** `ConsentGuard`（撤回同意后仍必须能删，04 §5），清单 24 写 / 16 豁免；部分唯一索引保证「一个孩子最多一条 pending」；900 脚本新增**列级** UPDATE 例外（文本列可抹、分数列仍 42501）并自检；双端面板：先判角色、显示剩余天数 / 撤销 / 执行摘要、读失败不清空旧状态；证据 = `npm test` **47 文件 / 830 条**、`db:verify` ALL PASS、`test:db` **20 文件 / 287 条**、`flutter test` **315/315**、小程序 `tsc` / `build:weapp` EXIT=0、`run-w7d.mjs` **17/17**；**已知边界**：审计历史不抹（追加式）、多 worker 竞争未压测、自然人注销不在范围 | ✅ W7-D 已收口（后端 ＋ 双端 ＋ 真库） |
| [`39-w8b-handoff.md`](./39-w8b-handoff.md) | **阶段 W8-B 交接单**（首启引导 · 双端 UI）：Flutter `OnboardingScreen` / `OnboardingGate` ＋ 小程序 `pages/onboarding/**`、启动闸门只在 `onboarded:false` 时拦（**403 / 网络错误一律放行** —— 「不知道」≠「未引导」）、第①步同意未勾选不发请求、第③④步 `undefined` vs `null` vs `[]` 三种意图、`complete` 后**逐条**补 `Habit`（扣分约定不加、409 视为已在）、`complete` 409 一律重拉状态；新增闸门 `onboarding:check`（4 学段 / 6 关注点三处逐字同序，3 例证伪全红）；证据 = `flutter test` **338/338**、小程序 `tsc` / `build:weapp` EXIT=0、`run-w8b.mjs` **14/14**、`npm run ci` **CI_EXIT=0**；**仍未做**：切家长模式 PIN 校验端点、真机七步走查、小程序非首页入口闸门 | ✅ W8-B 已收口（**双端 UI**；真机未走查） |
| [`40-login-and-session-design.md`](./40-login-and-session-design.md) | **登录与会话 · 设计稿（待评审，2026-10-29）**：L2 解除后的**身份层收口**。核心论点 = `DeviceSession` 今天同时承担"身份"与"家长模式窗口"两件事（`expiresAt` 一边 30 天、一边 5 分钟，`modeSource` 只能靠算术猜）；提议**新增 `AuthSession`**（不透明 token，库里只存 `sha256`）与现有 `DeviceSession` 分工；补今天缺的两个入口 `POST /auth/login`（`code2session`）与 `POST /children`（零孩子用户过不了同意闸门：没有建孩子的端点）；`x-kp-device-id` 从**凭据**降级为**设备标识**＋新增同源校验（`row.userId === token.userId`），生产 503 才有资格换真 401；含 openid 并发 upsert、7 天绝对 TTL、Flutter 三条路（A 不接 / B 开放平台 1–2 周 / C 扫码配对）、迁移与回滚、**7 条待裁定问题** | 🟡 **后端已实现**（W9-A，2026-10-29；`npm test` 55 文件 / 1039 用例 EXIT=0、`test:db` 16 例真库）＋**小程序数据层已落地**（`auth_api` / `auth_dto` / `auth_session` / `device_identity` / `auth_token_holder`，`run-w9a.mjs` **52/52**、`build:weapp` EXIT=0）＋新增 `npm run wx:probe`（真凭据手工联通，**不进** CI）；**W9-B 补上了小程序登录页 / 启动闸门**（`pages/login` 六态闸门 ＋ `useAuthGate` 挂四个 tab 页 ＋ 「我的」退出登录 ＋ 读请求 401 三分流：`TOKEN_EXPIRED` 静默重登一次 / `TOKEN_INVALID` 回登录页 / 网络错误保住 token，`run-w9b.mjs` **14/14**）；**未做**：Flutter（§14 Q1 选 A 本轮不接）、`seed:demo` 演示 token |
| [`41-w9c-date-code-handoff.md`](./41-w9c-date-code-handoff.md) | **阶段 W9-C 交接单**（固定规则「日期 ＋ 星期」6 位验证码）：规则 `MMDD ＋ 两位 ISO 星期`（2026-10-29 周四 ⇒ `102904`），按 `Asia/Shanghai` 墙钟算（复用 `businessDayOf`）、容差 ±1 天、`acceptedUntil` ＝ 命中日 24:00 ＋ 1 天；新端点 `POST /auth/date-code`（**第三处 `@Public()`**，判据写实为「响应里没有任何凭据」：不签发 token / 不读用户数据），码不对回 **200 `{valid:false}`** 而非 401（它是校验结果，不是认证失败），形状错 400、超限 429 `DATE_CODE_RATE_LIMITED`（与登录共用 `LoginRateLimiter`）；Flutter 侧 `date_code_dto` / `date_code_api`（本地 6 位预检不发请求、`valid=false` 不是异常、三类形状矛盾判 `malformed`、429 带 `retryAfterSeconds`）；★ **明确划界**：该码公开可推导 ⇒ 只能当家长门软锁，**不得**用于登录 / 绑定设备 / 签发凭据；证据 = `npm test` **56 文件 / 1055 条**（新增 16）、`flutter test` **398 条**（新增 26）、`flutter analyze` 0 issue、真机 curl 五种情形与文档逐字一致；Flutter 侧**启动闸门**已落地（`lib/screens/date_code_gate.dart`：输今天的码才进 App；只内存放行、不签发凭据；拿不到状态时**继续锁着**，与 `OnboardingGate` 方向相反）；**未做**：token 签发（缺身份锚点）、token 持久化、四个客户端的 `Authorization` | 🟡 启动闸门已落地（**软锁，不是登录**）；token / 持久化未做 |
| [`42-account-login-design.md`](./42-account-login-design.md) | **阶段 W9-D · App 账号登录（手机号 / 邮箱 + 密码）**：产品方裁定「先做通小程序，App 用手机号或邮箱登录，**不授权微信**」⇒ 身份锚点从「微信开放平台 / 扫码配对 / 日期码」改为 `User.phone` / `User.email` + `passwordHash`（`scrypt-pw$…`，**前缀与 `ChildMember.pinHash` 的 `scrypt$` 不同**，防止 4 位 PIN 哈希被当账号密码用）；`AuthSession.method` 白名单加 `password`（第三值，`auth-session-gate.test.ts` 有一条专门拦"随手加值"的用例）；新端点 `POST /auth/login-account`（**第四处 `@Public()`**，判据补全为「要么不返回凭据，要么它就是签发凭据的那一个」）与 `GET` / `PUT /auth/account`（`AuthGuard`：读绑定状态 / 绑定标识 + 设/改密码，改密后 `revokeOthers` 踢掉其它会话、保留当前这条）；★ 三条硬取舍：**不做开放注册**（否则手机号打错一位就静默生成"看不到孩子"的新账号）、**忘记密码 = 回小程序重设**（微信身份已证明，故整条链路零短信/零邮件）、**失败一律同一个 401**（账号不存在 / 从未设密码 / 密码错逐字同形，且空跑 `burnPasswordHashCost()` 对齐时序）；Flutter 侧 `token_store`（`AuthTokenHolder` + `FileTokenStore`，**不引入 `shared_preferences`**，写 `Directory.systemTemp` ⇒ 清缓存即需重登，与 7 天绝对过期同量级）+ `auth_api` / `auth_dto` / `login_screen` / `account_gate`（三层闸门最外层；**没配后端 ⇒ 放行**，与 `DateCodeGate` 朝安全方向倒相反）+ 五个客户端的可选 `tokenProvider`（默认 null ⇒ 不发 `Authorization`，既有调用点逐字不变）；证据 = `npm test` **58 文件 / 1099 条**（新增 44）、`flutter test` **415 条**（新增 17）、`dart analyze lib test` 0 issue、小程序 `tsc --noEmit` + `run-w9a/w9b/w9d` + 绑定页（`sheets/AppAccountSheet.tsx` + `account.ts`，先 `GET` 再 `PUT`、只提交改动字段）+ `taro build --type weapp` 全绿；★ 顺带查出并修掉一个**跨阶段缺陷**：7 处 `defaultEnvironment()` 曾整体读 `process.env`（Taro 的 DefinePlugin 只替换 `process.env.TARO_APP_X` 这种整段字面量，小程序运行时 `process.env` 是空的 polyfill）⇒ 所有 API 客户端恒为 `null`、整端静默停在预览模式**一个请求都不发**，而 `tsc` / 单测 / 构建全绿；改为 `compiled_env.ts#readCompiledEnvironment()` 逐键静态读，并在 `run-w9d.mjs` 里加了**看产物**的两条闸门；**未做**：开放注册、App 侧静默重登（不把密码存设备）、解绑标识、真机走查、真库用例（`P2002 ⇒ 409`） | 🟢 后端 + 小程序数据层与绑定页 + Flutter 登录链路已落地 |
| [`../PRD.md`](../PRD.md) | **产品需求文档**（需求侧：目标与指标 / FR-01–FR-12 / 权限矩阵 **41 动作** / 数据模型摘要 / 里程碑 W0–W9 与验收门 / 阻塞项 / 决策登记 / **§15 诚实落地状态**） | ✅ 2026-10-14 入库（2026-10-27 矩阵同步至 41 动作） |
| [`../../prototype/README.md`](../../prototype/README.md) | **微信小程序高保真原型**（双击 `prototype/index.html` 即开；自检 `node prototype/verify.mjs` → 11/11）。⚠️ 它自述的「与 `kids_points_mp` 同源」**当前无闸门**，见待办 13 | ⚠️ 已入库，**同源闸门待补** |

## 当前落地进度

> ⚠️ **读法**：以下按阶段留档，**后面的阶段会推翻前面的结论**。当前（2026-10-19）最关键的一条：
> 后端**已有只读入口** —— **W4-A** 起 `GET /home` / `GET /records` 有库时是真 Prisma 查询（无库仍 501）；
> **W4-B** 起 `/records` 支持键集分页，Flutter 配齐 `--dart-define` 时会接真实只读数据（未配置仍是本地预览）。
> **W4-C** 起小程序也接这两条端点：配齐 `TARO_APP_KP_*` 三项 env 时读数来自服务器
> （未配齐仍是本地预览），记录页分页使用 `nextCursor`；live 模式所有写入口只提示只读。
> **W4-D** 起后端补上两条写入口：`POST /records/check-in` / `POST /records/:id/reverse`
> 有库时真事务落库（流水 + 余额 + 审计），撤销是 append-only 冲正。
> **W4-E** 起双端 live 首页真正调用这两条端点（不再只提示只读）：
> 打卡 / 长按撤销会落库并刷新服务端快照；**其它写入口（记一笔 / 心愿 / 档案）仍只读**。
> **W5-A** 起规则页四条写入口也不再只读：`POST /point-rules`、`PATCH`（带 `expectedVersion`
> 乐观锁）、`DELETE`（软删进回收站）、`POST /point-rules/:id/habits`，双端同构。
> **W5-B** 起首页「记一笔」也真写：`POST /records/adjust`（余额与 `balanceAfter` 由服务端锁内决定，
> 409 `INSUFFICIENT_POINTS` 会带原因返回），双端同构。
> **W5-C** 起心愿「兑换」也真写：**兑换没有独立路由**，双端都走 `POST /approvals`
> （`action='redeem'`，请求体只有 `action + targetId`）；回包 `pending` 时**还没扣分**，
> 因此 `submitRedeemWish()` 只在 `approved` 时返回 `null`。
> 点「兑换」**先弹确认**（live：「提交给家长确认，批准后才扣」；预览：「立即扣除」），取消不发请求。
> **W5-D** 起**家长审批收件箱双端都有 UI**（`GET /approvals` + `POST /approvals/:id/decide`）：
> 待处理 / 已通过 / 已拒绝 / 全部四个筛选、`summary=null` 只禁批准不禁拒绝、
> 403 如实说「没有批准权限」、切筛选重新向服务端要第一页、批准后重拉首页快照。
> 小程序底部导航由 3 个 tab 变 **4 个**（审批插在心愿与「我的」之间）。
> **W5-E** 起「我的」页的昵称也能真改：`PATCH /child`（guardian 专属，孩子 403），
> 回包 `{ childId, name }` 直接覆盖本地档案 —— **写后不重拉 `/home`**（回包即权威，
> 再拉一次可能用滞后快照把新名字盖回去）。同名改名回 200 但**不写库、不写审计**（构造幂等）。
> 昵称长度只按**码点**判一处（服务端 16 个字符，emoji 算 1 个）。
> **W5-F** 起删除全部改成**软删 + 回收站**：`DELETE /habits/:id`（孩子 403）与
> `GET /trash`、`POST /trash/:kind/:id/restore`、`DELETE /trash/:kind/:id`；
> 回收站**孩子也能看**（`view_trash` ALLOW），恢复 / 彻底删除只给家长。
> 服务端只下发 `deletedAt`，`expired` 由双端同一份 90 天常量现算；
> 到期**不自动清理**，过期条目仍列出（标红、只能彻底删除）。
> **W5-G** 起邀请码有端点：`POST /invites`（建）/ `GET /invites`（列）/ `POST /invites/:id/revoke`
> （`invite_member`，孩子 403）与 `POST /invites/accept`（**只有身份屏障** —— 被邀请人按定义
> 还不是成员）。**占位是一条条件 `UPDATE … RETURNING`**，端口上根本没有「只查不占」的方法；
> 占位 / 成员位 / 设备会话 / 审计在**同一事务**，失败一律回滚（名额不被烧）。
> ⚠️ 它解决的是「已有账号的人加入新家庭」，**「全新设备的第一次加入」仍要等登录链路（L2）**。
> **W5-H** 起成员管理有端点：`GET /members`（`view_members`，**孩子也 ALLOW** —— 列表只含昵称 / 角色 / 时间）、
> `PATCH /members/:id`（`change_member_role`）、`DELETE /members/:id`（`remove_member`），后两条孩子 403。
> **「家里不会一个家长都不剩」由库层面的串行化保证**：先 `SELECT … ORDER BY id FOR UPDATE` 锁住这个孩子的
> 全部成员位再计数（先查后写的两个并发请求会双双看到 `count=2`）。降级在**同一事务**里把该用户的
> `DeviceSession.activeRole` 收回 `child`，读路径再用 `clampRoleToMembership()` 收一次
> （矩阵角色 = min(会话角色, 成员位角色)）。两条写路由都**禁止作用于自己**（否则自我降级 = 把自己锁在门外，
> 而没有家长能救你）。`PATCH` 同角色、`DELETE` 重复调用都是**构造幂等**（不写第二条审计、`removedAt` 不变）。
> 移出**不删会话**（删了屏障一只能回 401，把「你被移出」伪装成「你没登录」）。
> ⚠️ 双端**都还没有成员管理界面**，「退出家庭」也不存在（`DELETE` 刻意不接受删自己）。
> **W5-I** 起**双端都有邀请码界面**（「我的 → 邀请码」底部弹窗）：家长可生成（角色 / 名额 / 有效期
> 三个封闭选项）、复制裸码、吊销；孩子看到的是「请让家长生成一个码给你」，**不会**用一个注定 403
> 的请求去探测角色（先 `GET /members` 拿 `isSelf` 再决定拉不拉 `/invites`）。邀请码状态
> （可用 / 已用完 / 已过期 / 已吊销）**渲染时现算**、优先级 `revoked > exhausted > expired`；
> 生成 409 与吊销 404 都会重拉列表，吊销成功只改本行。**`POST /invites/accept` 仍无客户端** ——
> 全新设备的第一次加入要等 L2 登录链路（`05` §6），详见 [`26-w5i-handoff.md`](./26-w5i-handoff.md) §5。
> **W5-J** 起**申请人有了读路径与撤回**：`GET /approvals/mine`（`view_own_approvals`，双角色 ALLOW）
> 按 `requesterUserId = 会话 actor` 收口，只回**自己提的**申请；「我的 → 我的申请」底部弹窗
> 列出全部状态并支持键集分页。**撤回是申请人动作，不是否决**：`POST /approvals/:id/withdraw`
> 无请求体、只有本人能做（家长想反对请用「拒绝」），只把 `pending → withdrawn` ——
> **不写流水、不动积分、不恢复心愿**，因此不刷新首页。`summary` 读不懂的待处理行
> **仍然可以撤回**（否则只有申请人能救的坏行会永久卡住）。回包状态不是 `withdrawn` 时
> 客户端按契约漂移处理，不会假报成功。详见 [`27-w5j-handoff.md`](./27-w5j-handoff.md)。
> 头像、恢复演示数据仍未建；审批**没有推送**、**没有申请详情页**。
> `ApprovalsPort` **不再是 501** —— **W3-A** 起有库时是真 Prisma 适配器（同事务写流水/余额/审计），
> **W3-B** 起 `withdrawn` 可达且审批读写按 `childId` 收口；**W3-C** 起执行器/扫描/幂等键收尾。
> 前文所有「审批有库也是 501」都是
> **W2-D 当时**的事实；以本目录最后几段（W3-A / W3-B / W3-C / W4-A / W4-B / W4-C / W4-D / W4-E）为准。
> **W7-A（2026-10-26）** 监护人同意链路（**仅后端**）：`GET /consent` / `POST /consent` /
> `POST /consent/withdraw` ＋ 第四道屏障 `ConsentGuard` —— 撤回（或从未同意）后 24 个写动作
> 一律 `403 CONSENT_REQUIRED`，清单在 `backend/src/contracts/consent-policy.ts`
> （读路径、撤回自己的申请、**重新同意**豁免，否则「可撤回」会变成死状态）。
> 引导第①步的勾选界面由 **W8-B** 落地（Flutter / 小程序各一套七步流程），
> 法务文本仍是占位版本（导出已由 W7-C、删除已由 W7-D 落地）；
> 详见 [`36-w7a-handoff.md`](./36-w7a-handoff.md)。
> **W7-C（2026-10-27）** 家庭数据导出：`GET /export`（`export_family_data`，
> guardian ALLOW / child DENY）把这一个孩子的九段数据打成一份 JSON，
> `summary` 如实标注条数与**被截断的段**；★ 它**不挂 `ConsentGuard`** ——
> 撤回同意后仍必须可用（04 §5 可携带权），因此清单变成 24 写 / 14 豁免。
> 双端只解析文件头与摘要，**复制的是服务端原文**；孩子视角不发请求。
> 真库用例 `test-db/export-db.dbtest.ts` **19/19 通过**（`npm run test:db` 19 文件 / 265 用例全绿、
> `npm run ci:db` EXIT=0；首跑顺带修掉「真库夹具没有 `GuardianConsent` 行」的 W7-A 遗留）；
> 详见 [`37-w7c-handoff.md`](./37-w7c-handoff.md)。
> **W7-D（2026-10-27）** 家庭数据删除：`POST /family-deletion` 申请（`{confirmed:true}`、
> 冷却 **7 天**，落库 `scheduledFor`）→ 可 `POST /family-deletion/cancel` →
> worker 到期在**同一事务**内就地匿名化（`02` §9.20）。`GET /family-deletion` 回
> `none / pending / cancelled / executed` + 执行摘要（哪类数据动了几行、保留多少条流水与余额）。
> ★ 两条路由同样**不挂** `ConsentGuard` —— 撤回同意后仍必须能删（04 §5），清单 24 写 / 16 豁免；
> 真库用例 `test-db/deletion-db.dbtest.ts` 用**已撤回**的同意行跑通全链路，并证明
> 「文本列可抹、`pointsDelta` / `balanceAfter` 仍被 REVOKE」（900 的列级例外）。
> 证据：`npm test` 47 文件 / 830 条、`test:db` 20 文件 / 287 条、`flutter test` 315/315、
> 小程序 `run-w7d.mjs` 17/17；详见 [`38-w7d-handoff.md`](./38-w7d-handoff.md)。
> **W8-A（2026-10-27）** 首启引导**后端**：`GET /onboarding`（`view_onboarding`，**不挂**
> `ConsentGuard` —— 未同意时引导页必须能打开）＋ `PATCH /onboarding/profile`（③④步草稿，
> `undefined` 沿用 / `null` 清空学段 / `[]` 全不选，值未变不写库）＋
> `POST /onboarding/complete`（`apply_onboarding`，**受管**；**非幂等**，重复 409；
> 事务内重校验模板仍 active，缺一条 404 且零副作用；规则按提交顺序复制并各带 v1 版本行；
> 可选 PIN 存 `scrypt$…` 自描述哈希、审计只记 `pinSet`）。矩阵 **40 → 41**，写 / 豁免
> **24 / 17**。详见 PRD §15（W8-A 一行）。
> **W8-B（2026-10-27）** 首启引导**双端 UI**：Flutter `OnboardingScreen`（七步）＋
> `OnboardingGate`（启动闸门）＋ 小程序 `pages/onboarding/**`；★ 闸门只在
> `onboarded:false` 时拦 —— **403（孩子身份）/ 网络错误一律放行**（「不知道」≠「未引导」，
> 一次超时不该变成一场发不出请求的强制引导），「我的」页留「重试 / 继续」入口。
> 第③④步的三种意图（未传 / `null` / `[]`）在请求体里真的不同；`complete` 之后客户端用
> **既有**端点 `POST /point-rules/:id/habits` **逐条**补习惯（扣分约定不加 —— A1；
> 409 视为已在；单条失败只进第⑦步的「需手动」清单）；`complete` 409 一律**重拉状态**
> 而不是原地重试。新增闸门 `npm run onboarding:check`：4 学段 / 6 关注点在
> 后端契约、Flutter、小程序三处**逐字同序**（3 例证伪全红）。
> 证据：`flutter test` **338/338**（新增 23 条）、`tsc` / `build:weapp` EXIT=0、
> `run-w8b.mjs` **14/14**、`npm run ci` **CI_EXIT=0**；
> 仍未做：**切家长模式 PIN 校验端点**、真机七步走查、小程序非首页入口闸门。
> 详见 [`39-w8b-handoff.md`](./39-w8b-handoff.md)。

### ✅ 已完成并验证

**D12 —— 测试器花括号嵌套错位 → CI 假通过**

根因不是"最后两个测试没跑"，而是 `check('seed')` 与 `check('addQuickNote')` 的回调未在自身位置闭合，
把 `console.log(summary)` / `process.exitCode` 挤进了 `addQuickNote` 回调内部：

| 验证项 | 修复前 | 修复后 |
|---|---|---|
| 汇总行位置 | 第 11 项后（**早于 2 个检查完成**） | 全部 13 项之后 |
| 末尾检查失败时的退出码 | `0`（**CI 假绿**） | `1` |
| 诚实性探针（注入必失败项） | 不传导 | **`EXIT_CODE=1`** ✅ |

**前端可控制缺陷（双端同步修复，含回归用例）**

| 编号 | 缺陷 | Taro (`kids_points_mp/`) | Flutter (`lib/`) |
|---|---|---|---|
| A1 | 负分规则被 `Math.abs()` 抹平 → 扣分变加分 | ✅ | ✅ |
| A4 | 流水硬编码"家长记录"、无操作人 | ✅ | ✅ |
| A5 | `addQuickNote` 加分错误递增 `rewardCount` | ✅ | ✅ |
| B6 | 扣分静默截断 → **账本不平** | ✅ | ✅ |
| B7 | `undoCheckIn` 物理删除流水 → 改为**冲正** | ✅ | ✅ |
| B8 | 兑换标题被 `shortTitle` **永久截断** | ✅ | ✅ |
| E18 | `resetToSeed` 生产可达 **＋ 首启即假数据**（C1 补第二半） | ✅ | ✅ |
| E19 | 小标题串接方式不统一 | ✅ | ✅ |
| D13 | 测试断言把缺陷固化为"正确行为"（C1 补齐 10/10 条） | ✅ | ✅ |
| C9 | 全部物理删除 → **软删除 ＋ 回收站（90 天）**（C4） | ✅ | ✅ |
| C10 | 规则**无法编辑** → `updateRule` ＋ 版本表（C4） | ✅ | ✅ |
| C11 | 无 `AuditLog` → **追加式审计**（C4） | ✅ | ✅ |

验证结果：
- `node kids_points_mp/.tmp_test/run.js` → **19/19 PASS，`EXIT_CODE=0`**（产物由下方流水线第 1 步现编，见「陈旧产物」说明）
- `npx tsc --noEmit -p tsconfig.json` → **`EXIT=0`**
- `flutter test` → **29/29 PASS**（`TEST_EXIT=0`；`app_test.dart` **28** ＋ `widget_test.dart` **1**）
  —— 修前 **21/21**，C1 新增 3 条（首启空态 ×2 ＋ 空态渲染冒烟 ×1），**C2 再新增 5 条**（演示数据只带结构字段 ×1、
  「每天最多 2 次」真能打 2 次 ×1、冲正排除 ×1、展示串由结构字段派生 ×1、频次越界被拒 ×1）。
  **别只数 `app_test.dart`**：`flutter test` 会跑 `test/` 下全部文件。
- `flutter analyze` → **0 issue，`EXIT=0`**（C1 顺手清零了 6 条既有 `prefer_const_constructors` info：
  **info 也会让 `flutter analyze` 退出码为 1** —— 于是它与 `analysis_options.yaml` 里"不阻断构建"的注释互相矛盾，
  流水线的 `flutter analyze && flutter test` 更是根本串不起来。已实测：清零后 exit 0、测试仍 29/29）
- **C2 追加**：`backend npm run ci` **ALL PASS**（含 `defects:check` **18/18**）；另跑 **6 例代码级证伪**全部变红、还原回绿。
- **C3（✅ 已收口 2026-10-12，提交 `90e9ce7`；交接单 [`07-c3-handoff.md`](./07-c3-handoff.md)）**：**E16** 心愿配色由 `wishes.length % 4` 升为稳定枚举 `WishCoverStyle`（补空档 + id 哈希，双端同源，下标归零）。
  已实测：`run.js` **20/20**、`flutter test` **32/32**、`flutter analyze` **0 issue**、Taro `tsc --noEmit` **EXIT=0**；
  收口闸门：`node tools/defect-status.mjs` **`ALL PASS`（18 条）**、`backend npm run ci` **8 步全绿**；**证伪 6 例**（造假必红、还原必绿）。
  一条**实测勘误**（写进 `07` §4.3 ③ / §5 第 9 条）：Flutter 取色回退成数组下标时，`flutter analyze` 与整包 `flutter test` **全绿**（
  配色表凑巧与枚举同序 → 行为等价），真正拦住它的是守门人一条 `A.lack` —— **断言名 ≠ 断言力**。
- **C4（✅ 已收口 2026-10-13，提交 `f3f4e21`；交接单 [`08-c4-handoff.md`](./08-c4-handoff.md)）**：**C9**（软删除 ＋ 回收站）＋ **C10**（`updateRule` 规则可编辑 ＋ 版本表）＋ **C11**（追加式审计），双端同步，守门人三块 `unfixed → fixed`。
  已实测：Taro `tsc --noEmit` **EXIT=0**、`npm run build:weapp` **EXIT=0**、`run.js` **25/25 ALL PASS**（新增 C9 ×3 / C10 / C11）；
  `flutter analyze` **0 issue**、`flutter test` **38/38**（`app_test.dart` 37 ＋ `widget_test.dart` 1；本轮新增 6 条）；`node tools/defect-status.mjs` **18/18 ALL PASS**。
  - **本轮最重要的语义**：删除＝**改状态位**（原对象仍在、可恢复），90 天保留期是**纯函数**（89/90/91 天可测），
    但**判定与动作分离** —— 过期不等于自动删，真删必须 UI 显式调 `purgeExpiredTrash()`。
  - **`updateRule` 是"四步一笔"**（归档版本 → 改本体 → 同步派生习惯 → 写审计，只 `persist()` 一次）：
    分两次调用会留下"改了但没记"的窗口。因此 Flutter 侧 `Habit.title/points/condition/dailyLimit` 不再 `final`
    —— 守门人 A2 那条 `final int dailyLimit;` 断言**被新语义作废**，与台账同批改掉（`03` §0 开头的 C4 说明）。
  - **审计的抓法**：只断言 `auditLog.length == 1` 会**全绿放行**「存引用」的假审计；真断言是"写完审计再改原对象，再读审计，内容必须不变"（两端都有）。
  - **诚实边界**：`AuditAction` 只列**前端真能触达**的 5 类动作，成员增删 / 角色切换 / 同意（consent）**本轮未实现**、也没有伪造取值 —— 不假装覆盖（`03` §C11 现状）。
    > **W5-H 补记（2026-10-22）**：服务端现在**会写** `member.role_change` / `member.remove`
    > （Prisma `ActionType` 已有这两个值），但**客户端的 `AuditAction` 枚举仍未覆盖**它们 ——
    > 双端还没有成员管理界面，也没有审计查看页。别把「服务端会写」读成「前端看得见」。
  - **证伪自测 6/6**（`03` 验收门有逐例清单）：台账改回「未修」、物理删回退、审计改成 `push`、少一处 `activeOnly`、`updateRule` 偷换 id —— 每例都**点名对应条目**变红，还原（sha256 比对）后回绿。
- **C5（✅ 已收口 2026-10-13；交接单 [`09-c5-handoff.md`](./09-c5-handoff.md)）**：**`D9`** 图标字段跨端类型不一致 ——
  双端数据层只存**名字**（Flutter `icon: IconData` → `iconName: String`），名字的唯一事实收进
  `lib/theme/app_icons.dart`（常量表 ＋ 映射表 ＋ `iconDataFor()` ＋ 兜底 `fallbackIcon` ＋ 白名单 `isKnownIconName()`）；
  两端 `addRule` 越界**拒绝**，未登记的名字画 `unknown` 占位（**不是空白**）；
  **新增闸门** `tools/icon-names-check.mjs`（`npm run icons:check`，接进 `npm run ci` 第 7 步）比对
  Taro / Flutter / 后端**三份手抄名单**（各 **29** 个名字）。
  已实测：`run.js` **27/27**、`flutter test` **41/41**、`flutter analyze` **0 issue**、`npm run build:weapp` **EXIT=0**、
  闸门 **7/7**、台账 **19/19**、`backend npm run ci` **9 步 `CI_EXIT=0`**；**证伪 12 ＋ 3 ＋ 3 例全部变红且点名**。
  - **为什么不止加一张映射表**：名字在三端各有一份手抄清单（后端那份没法 import 小程序的 TS），
    漂移的表现是「某个图标在某一端悄悄变成占位」—— **三端的编译器都不会说一句话**。闸门才是这条缺陷的解药。
  - **台账补录**：`D9` 此前**从未进过 `03` §0 表**（只活在决策登记里），补进去的那一刻闸门立刻
    `FAIL D9 台账=（无此行）` / `FAILED 1 项（共对账 19 条）` —— **fail-closed 按设计工作**；补上验证器后转绿。
  - **两处诚实记录**：① **编辑规则不再允许改图标**（`RuleVersion` 快照无 icon 字段，允许改会让版本回放对不上）；
    ② 三份名单**仍是手抄**，现在只是「漂移会被抓住」。
  - **两次「反例假绿」的自我纠正**（写进 `03` 验收门）：闸门脚本曾因"改了 A、检查读 B"而假绿；
    `fallbackIcon` 的第一版注入与映射表值**行为等价**故不红 —— **红不了的不是用例，是反例**。



**阶段 C1（2026-10-12）新增的回归用例 —— 全部先验证过"能失败"再让它们变绿**：
- `E18 首启必须为空态：不预置任何演示数据`（Taro）／`首启空态（修 E18）`（Flutter）
  —— 修前分别报 `首启不得预置 124 分假数据` 与符号缺失；**种子数据降级为显式夹具** `seededStore()`
  （靠构造函数偷偷种数据，正是 E18 本身）。
- `E18 生产构建不可达：判据语义 + 真实生产模块双证` —— ①纯函数 `demoResetAllowed('production') === false`；
  ②以 `NODE_ENV=production` **重新加载真实模块**，断言 `ALLOW_DEMO_RESET === false`、
  且 `resetToSeed()` 返回 `false` **且不清空真实数据**。守卫因此**可被测试**，不再依赖"恰好跑在开发机上"。

### ✅ W0 已执行（`06` §5 附真实命令与退出码）

| 产物 | 验证 | 结果 |
|---|---|---|
| `backend/prisma/schema.prisma`（**18 表 / 14 枚举**） | `prisma validate` | ✅ `is valid 🚀` |
| Prisma Client | `prisma generate` | ✅ v7.10.0 |
| 13 个域模块签名 + Prisma 7 adapter 接入 | `tsc --noEmit` | ✅ `EXIT=0` |
| 构建 | `nest build` | ✅ `EXIT=0` |
| **CI 诚实性探针**（含 D12 回归守卫） | `npm run honesty:probe` | ✅ 4/4，**且经夹具证明能失败** |
| **缺陷台账对账守卫（2026-10-12 新增）** | `npm run defects:check` | ✅ 18 条声明与代码逐条一致（**C5 起为 19 条** —— 补入 `D9`）；**7 类篡改台账全部变红**；**C2 起补反回退断言**（`*.checked =` 写入数 = 0 / seed 不得再写展示串 / `rule.detail.split` 归零），并再加 **6 例代码级证伪全部变红**；**C5 起含跨端图标名闸门** `npm run icons:check`（`03` 里 D9 那条有反向断言：数据层 `IconData` 命中数必须 0、渲染点各恰好 1 次等） |
| 模板库（18 条，按 P2 缩减） | `npm run templates:check` | ✅ 7 类坏数据全拦 |
| 跨语言契约 | `npm run contracts:emit` | ✅ 25 动作 → JSON |
| 工具代码类型检查（**新增**） | `npm run typecheck:tools` | ✅ 覆盖 `scripts/**`、`prisma/**`、`prisma.config.ts` |
| **端到端** | **`npm run ci`** | ✅ `EXIT=0` |
| **数据库层不变量 I5（新增）** | `npm run db:verify` | ✅ 7 项全 PASS；**反向对照证明它能变红** |

✅ **L1 已解除（2026-10-12）**：迁移可执行 / I5 实际生效 / 应用真实启动 —— 三项验收门全部通过。证据见 `06` §10。

### ⏳ 待办（按依赖顺序）

1. ~~**L1 · 数据库环境**~~ → ✅ **已关闭（方案 B：原生 PostgreSQL 18.6）**。
   当前基线：`.env` 中 `DATABASE_URL` = 应用角色 `kids_points_app`（**仅 CRUD**）；
   `MIGRATION_DATABASE_URL` = 所有者（跑迁移与授权）。
   ⚠ **`prisma migrate reset` 之后必须重跑** `prisma/sql/900_ledger_revoke.sql` **+** `npm run seed`
   —— 两者都**不会**自动补（原因见 `06` §10.3 与缺陷 11）。
2. ~~**第 1 天必须并行启动的日历门**（`05` §6）~~ —— **L2 已解除（2026-10-29）**：正式 AppID
   `wx40666b1cbd5907c0` 已进 `project.config.json`，AppSecret 进 `backend/.env`（不入库；
   用 `jscode2session` 的 `40029` vs `40125` 把旧值证伪过）。**但登录端点仍未写**。
   **只剩 L4**：域名 + HTTPS + 备案（7–20 工作日，**纯等待，AI 无法加速**），
   小程序服务器域名白名单也依赖它 —— 越晚启动越会顶穿整个计划。
3. ~~**L5 · git 仓库**~~ → ✅ **已完成（2026-10-12）**：`git init -b main` + 首次提交
   **`35c0d62`**（234 个文件入库、工作区 0 差异），建仓卫生一并修正（见下方「Git 记录规范」）。
   **仍待你定**：**CI 平台**（GitHub Actions / Gitee Go / 自建）—— 流水线命令本身已就绪（`npm run ci`）。
4. **W2**：`03` 剩余缺陷原为 3 条（`C9` / `C10` / `C11`，＝阶段 **C4**）—— ✅ **已于 2026-10-13 收口**（后端 W0 就绪的 schema 直接复用）。
   W2 的前端收尾 **`D9`**（图标名字 → `IconData` 映射，＝阶段 **C5**）—— ✅ **已于 2026-10-13 收口**：
   双端数据层只存**名字**、渲染时才查表，并新增跨端闸门 `npm run icons:check`
   （`tools/icon-names-check.mjs`，7 项）守住「Taro / Flutter / 后端三份手抄名单」不漂移。
   `03` 台账因此由 **18 条变 19 条**（D9 此前**从未进过台账**，C5 补录 —— 见 `03` §0 与 §D9）。
   （原列 8 条里的 `E15` / `E17` / `A2` / `A3` **已于阶段 C2 收口** —— 见第 9 条。）
5. ~~**请你逐条确认 `06` §3 的 D1–D10**~~ → ✅ **已全部裁定（2026-10-12）**：**12 条锁定**
   （含本轮新立的 **D1b** `relation` 升枚举 / **D3b** `restrictions` 定形校验），结果见 `06` §3.1。
   **已落地**：D1b → 阶段 D-a（✅ **2026-10-13，见 `10-d1b-handoff.md`**）、D3b → 阶段 D-b（✅ **2026-10-13，见 `11-d3b-handoff.md`**）—— 加上 **D9 已于阶段 C5 落地**，**12 条决策全部落地**。
6. 已决策：**P1** 不压缩工期；**P2** L6 不到位（模板定稿 **18 条**）；
   **P3** `02` §5 不可变性与规则版本确认定稿。
7. **W1 开工前要先补的两件事**（`06` §10.6）：
   ① ~~**引入测试框架**~~ → ✅ **已完成（2026-10-14，阶段 B1）** —— 现在只有手写断言的 `npm run db:verify`，"回归"不能只靠人肉重跑脚本，故补上**常设测试套件**：
   `node:test`（Node 内置 runner）＋ 既有 `tsx` 作加载器，**零新增依赖**（选型是实测的：Node 26 原生类型剥离
   连模块都解析不了，jest/vitest 需新增依赖且 TS 6.0.3 有兼容风险）；新增 `npm run test` /
   `typecheck:tests` / `test:canfail` 三步进 CI（**11 → 14 步**），首批用例覆盖矩阵性质与
   `restrictions` 守卫行为。**两个 fail-closed 守卫**：① 「**0 用例不算通过**」——
   实测空目录时 runner 是 `ℹ tests 0` 且**退出码 0**，故入口自己遍历文件并强制用例数 ≥ 文件数；
   ② `test:canfail` 用必红夹具证明「测试真的会红」且**点名失败用例**。详见「CI 步骤」节的「测试框架」小节。
   > **实测基线（2026-10-14 收口时跑的，非推断）**：`npm run ci` → **`CI_EXIT=0`（14 步）**；
   > `npm run test` → **3 个用例文件 / 26 个用例全部通过**（`TEST_EXIT=0`；B3 加自批策略后由 16 → 26）；`npm run test:canfail` →
   > **4/4 ALL PASS**（`CANFAIL_EXIT=0`）。其中 canfail 的附注行**当场复现**了第 ① 条守卫的依据：
   > runner 自己对空目录是「退出码=0，用例数=0」—— 即那条守卫拦的是**真实存在**的假绿，不是假想需求。
   ② ~~**`kids_points_app` 口令改为部署注入**~~ → ✅ **已完成（2026-10-14，阶段 B2）** —— 口令已从仓库里**彻底移出**：
   `900_ledger_revoke.sql` 只建角色（`CREATE ROLE … LOGIN`，**不设口令**），口令改由新增的
   `prisma/sql/901_set_app_password.sql` 在部署时从环境变量注入（`-v app_password=…`），
   脚本开头是 fail-closed 守卫（变量缺失即 `RAISE EXCEPTION`，**不是**靠 `\quit` —— 实测 `\quit 1` 不支持退出码）；
   `.env.example` 占位符换成 `REPLACE_ME_BY_DEPLOY`；`npm run db:verify` 增补
   **P1a/P1b/P1c/P2/P3** 五条口令判据（非空 · 非占位值 · 长度下限 · 不与所有者口令复用 · 用户名必须分离）。
   > **实测基线（2026-10-14 收口时跑的，非推断）**：① 不带 `-v app_password` 跑 901 → **退出码 3**（守卫真的会失败，不是空承诺）；
   > ② 注入后**旧口令**（`change-me-before-production`）连接 → **`SQLSTATE 28P01` 认证失败**（口令确实换了）；
   > ③ 新口令跑 `db:verify` → **12/12 ALL PASS**（`DB_VERIFY_EXIT=0`，含 P1–P3）；
   > ④ 反向对照：把 `DATABASE_URL` 换回占位口令 → **P1b 变红并点名命中项**（`DB_VERIFY_EXIT=1`）；
   > ⑤ `npm run ci` → **`CI_EXIT=0`（14 步）**。
   > 顺带修掉一个**假绿**：实测脚本内 `RAISE EXCEPTION` 在**不带** `-v ON_ERROR_STOP=1` 时 psql 退出码**仍是 0** ——
   > 故 900 / 901 与全部文档命令一律补上 `ON_ERROR_STOP=1`（此前 900 第 ④ 段那句"让脚本失败"是空话）。
8. ~~**C1 · E18 ＋ D13 收口**~~ → ✅ **已完成（2026-10-12，提交 `24c5c73` → `4699518`）**：
   首启改为**空态**、生产闸门拆成**可测判据**（`demoResetAllowed()` ＋ 派生常量）、种子降级为**显式夹具**、
   D13 第 10 条断言改写；`run.js` **16/16**、`flutter test` **24/24**、`flutter analyze` **0 issue**、
   `defects:check` **18/18**，守门人 7 个篡改反例全部变红。
   **下一步**：**首启引导流程**（`04`）—— 空态目前**只渲染空列表，没有引导**，别把「空态」当成「引导已完成」；
   引导落地前，`04` 的能力清单仍是"未实现"状态。
9. ~~**C2 · `E15` ＋ `E17` ＋ `A2` ＋ `A3` 收口**~~ → ✅ **已完成（2026-10-12）**：
   双端同步把 `condition` / `dailyLimit` 升为**结构字段**，`detail` / `checked` / `limitText` / `doneText`
   全部降级为**派生值**；`run.js` **19/19**、`flutter test` **29/29**、`flutter analyze` **0 issue**、
   `defects:check` **18/18**、`backend npm run ci` ALL PASS；**证伪 6/6**（造假必红、还原必绿）。
   **两条诚实说明**（写进 `03` §0.2）：① 演示规则 `rule-3` 的「每周 1 次」在权威 schema 里**没有周期字段可表达**，
   结构字段化后落成 `dailyLimit: 1`，派生串变「每天 1 次」—— **真实语义变更**，不是漏改；
   ② `03` §A3 原公式只排除 `correction`，**漏了「已被冲正的原记录」**（撤销后界面仍显示已打卡），已修正。
   **遗留**：`rule-3` 的周频次要真支持，得先给后端 schema 加周期字段；`E16` **已收口（C3）**，`C9` / `C10` / `C11` **已收口（C4，2026-10-13）**，`D9` **已收口（C5，2026-10-13）** —— **`03` 队列清空**。
10. ~~**C5 · `D9` 收口**~~ → ✅ **已完成（2026-10-13）**：Flutter 数据层 `icon: IconData` → `iconName: String`
   （`Habit` / `PointRule` / `PointRecord`），名字的唯一事实收进 `lib/theme/app_icons.dart`
   （常量表 ＋ 映射表 ＋ `iconDataFor()` ＋ 兜底 `fallbackIcon` ＋ 白名单 `isKnownIconName()`）；
   两端 `addRule` 越界**拒绝**、渲染口对未登记的名字给 `unknown` 占位而不是空白；
   **新增闸门** `tools/icon-names-check.mjs`（`npm run icons:check`，接进 `npm run ci`）比对三份手抄名单。
   实测：`run.js` **27/27**、`flutter test` **41/41**、`flutter analyze` 0 issue、闸门 **7/7**、
   台账 **19/19**、`backend npm run ci` **`CI_EXIT=0`（9 步）**；证伪 **12 ＋ 3 ＋ 3** 例全红且点名。
   **两处诚实记录**：① **编辑规则不再允许改图标**（`RuleVersion` 快照无 icon 字段，允许改会让版本回放对不上）；
   ② D9 此前**从未进过台账**（只在 `06` §3.1 决策登记里），C5 补录时闸门立刻 fail-closed 报红 —— 见 `03` §0 说明。
   **下一步**：`D3b` → 阶段 D-b（`06` §3.1），以及 `04` 的**首启引导**仍未实现。
11. ~~**D-a · `D1b` 收口**~~ → ✅ **已完成（2026-10-13，见 `10-d1b-handoff.md`）**：
   `UserChildRelation.relation` 由自由字符串升为枚举 **`RelationKind`**（**father / mother / grandparent / other**，
   取值口径取自原 schema 注释）；迁移动了**手工一处** —— Prisma 默认生成的 `DROP COLUMN + ADD COLUMN`
   会**静默清空该列**（自带警告，有数据也不报错），改成 `ALTER COLUMN … TYPE … USING` 保数据转型
   （库里若有枚举外的值则**迁移当场失败**，而不是把列抹掉）；
   **新增闸门** `tools/relation-kind-check.mjs`（`npm run relation:check`，5 项，接进 `npm run ci` **第 8 步**）。
   实测：闸门 **5/5**、证伪 **15 例**（9 个反例各只点名自己 ＋ 3 个控制例 ＋ 真文件 sha256 未变 ＋ 清理后回绿）、
   `backend npm run ci` **`CI_EXIT=0`（10 步）**、真实库反向探针 `relation='sister'` **被枚举拒绝**
   （正向对照 `'father'` 只因**外键**失败）、迁移链 `seed → 900 → db:verify` **ALL PASS**（I5 仍生效）；
   前端未改动，复跑 `run.js` **27/27**、`flutter analyze` **0 issue**、`flutter test` **41/41**。
   **三条诚实记录**：① 闸门**首跑红在错的理由上**（它把迁移文件里"Prisma 原文是 DROP COLUMN…"的
   解释性注释当成了证据，补了只取可执行语句的 `stripSqlComments()`）；
   ② 证伪脚本首版**副本残留**，让"红"出现在别的检查上（"逐条点名"整个失效，加 `reset()` 才复现）；
   ③ 闸门 ④ 目前是**防将来**的 —— 仓库里 `relation` 字面量 0 处（后端 API 未开工）。
   **下一步**：`D3b`（`restrictions` 定形校验）→ 阶段 D-b。
12. ~~**D-b · `D3b` 收口**~~ → ✅ **已完成（2026-10-13，见 `11-d3b-handoff.md`）**：`ChildMember.restrictions`（裸 `Json`）**定形** ——
   权威形状收进 `backend/src/contracts/member-restrictions.ts`（**类型** `ChildMemberRestrictions`：三键全可选
   ＋ **运行时守卫** `validateRestrictions()`：`plainToInstance` ＋ `whitelist` ＋ `forbidNonWhitelisted`，
   未知键 / 错类型 / 越界**一律拒**），配 `backend/scripts/check-restrictions.ts` 的 **A/B 两段式离线自检**
   （`npm run restrictions:check`，接进 `npm run ci` **第 9 步** ⇒ **11 步**）与闸门 `tools/restrictions-check.mjs`（**6 项**）。
   实测：自检 **5/5**、闸门 **6/6**、`backend npm run ci` **`CI_EXIT=0`（11 步）**；
   证伪 **14 反例（每个只点名自己那一项）＋ 3 控制例 ＋ 3 收尾（真文件 sha256 未变 / 清理副本后回绿 / 副本已删）= 20 行 PASS**。
   **三条诚实记录**：① 自检首跑**红在 B2 断言过严**（一个坏值可同时违反 `@IsInt` 与 `@Min`，
   改成"错误只点名那个键"而非"恰好 1 条"，并顺手修掉一处 TS 收窄错误 —— 都在**自检脚本**里，不在产品代码里）；
   ② `02` §3 代码块原有 `...`（"可能还有别的键"）与"形状封闭"**语义冲突**，本轮**去掉**并写明三处手抄的对账口径
   —— 这是**口径修正**，不是漏改；③ 守卫此刻**还没有被任何写入路径调用**（`backend/src` / `lib` / `test` /
   `kids_points_mp/src` 里 `restrictions` 命中**各 0 处**；另 32 处命中在 `kids_points_mp/node_modules/**` 第三方类型里），
   闸门是**防将来**的：别把绿灯读成"屏障三已验收"。
   **下一步**：`04` 的**首启引导**（仍是空白）／ `tools/**` 工具职责地图。
13. **原型的「同源契约」尚未被闸门守着**（2026-10-14 与 PRD / 原型同批入库时**如实记录**）：
   `prototype/README.md` §3 声称配色 / 字号 / 图标 / 派生文案 / 初始数据「**全部照抄仓库**」，
   但 `prototype/verify.mjs` **只读 `prototype/` 自身**（`index.html` ＋ `app.js`），断言的是**写死的期望值**；
   而 `tools/icon-names-check.mjs` 只对账 **Taro / Flutter / 后端三份**手抄名单 —— **原型是第四份，不在覆盖内**。
   实测四组未对账面（只读探针 `tools/_scratch/e1-probe.mjs` 可复跑）：① 图标 `ICONS` 键集合
   （原型 29 项 = `kids_points_mp/src/components/Icon/icons.ts` 29 项，**当前相等但无人守**）；
   ② 6 个派生文案函数（原型 ↔ `kids_points_mp/src/data/types.ts`，行号 L508/541/546/627/658/671）；
   ③ 色板 `vars.scss` ↔ `prototype/styles.css`（24 vs 23，同名值全等，差 4 条待逐条判定）；
   ④ PRD §7 的 **25 动作** ↔ `contracts/permission-matrix.json`（PRD 自称"唯一事实源"，实为第二份手抄）。
   **下一步**：新增 `tools/prototype-check.mjs`（fail-closed ＋ 可逐条证伪）并接进 `npm run ci`（**11 → 12 步**），
   同时把 `prototype/verify.mjs` 纳管。本轮的下手包：`tools/_scratch/next-session-e1.md`（**临时物，不入库**）。
   另注：`prototype/app.js` 是**严格模式 IIFE、零对外出口**，派生函数外部调不到 —— 做行为对账前需先加只读出口。
   **⏸ 优先级：用户已明确「暂缓执行」（2026-10-14）** —— 理由：它**不是产品功能**、**不阻塞任何开发**
   （已实测：`backend/package.json` / `tools/**` / `backend/scripts/**` 对 `prototype/` 的引用**为 0**，`npm run ci` 仍 11 步）。
   **触发条件（满足任一条就应当捡起）**：① 有人**照着 `prototype/` 去实现小程序 UI**（W4/W5 前后）；
   ② 改动 `kids_points_mp/src/components/Icon/icons.ts`、`src/styles/vars.scss`、`src/data/types.ts` 的
   图标 / 色板 / 派生文案；③ 改动 `contracts/permission-matrix.json`。**在那之前不必做**。
14. **「谁可以批准」（自批）—— 用户已裁定，契约已定形（2026-10-14，阶段 B3）**：
   原状是**功能死锁**、不是安全漏洞：`redeem` 对两端都是 `REQUIRE_APPROVAL`，
   但"批准人资格"全仓**无定义**（矩阵只回答"哪个角色能**发起**"，`02` §4.1–§4.4 只回答"状态怎么走"）——
   **单家长家庭**（只有一位 `guardian`）提交兑换后**没有任何人能批准** → 永远 `pending` → 到期被 `expired` 扫掉。
   用户裁定：**允许申请人自批，但自批必须是一次「显式动作」** —— ① 两步式（提交后**本人**二次确认）
   或 ② 一步式（申请时勾选"自动审批"，`autoApprove: true`）；界面"弹窗"与"勾选"都只是这两种形态的皮。
   **未勾选 / 缺字段一律 `pending`** —— 不存在"只有一位家长就自动批准"的特例（那会让同一 API
   随家庭人数改变安全语义，且审计里出现没有人点过同意的批准）。
   判据收进 `backend/src/contracts/approval-policy.ts`（`canReview` / `canSelfApprove` /
   `decideRequestOutcome` / `canDecide` / `isSelfApproved`）—— **完全由矩阵导出**，不新增第三处名单；
   孩子与 `viewer` 不能自批（`review_approvals` 为 `DENY`）；没资格却传 `autoApprove` →
   `400 SELF_APPROVAL_NOT_ALLOWED`（**不静默忽略**，同 `restrictions` 的多余键拒绝口径）。
   **不新增字段 / 枚举 / 迁移**：自批由 `decidedByUserId == requesterUserId` 判定（同 D4 口径），
   审计动作名 `approval.self_approved`（`AuditLog.action` 本就是自由字符串）。
   文档同步：PRD §14.1 **P4** ／ FR-04 ／ FR-08（验收 9.25–9.27）／ §7 注 ／ §15.1–§15.3；
   `02` **§4.5** ／ §9（9.25–9.27）。用例：`backend/test/approval-policy.test.ts`（10 条，全套 26/26）。
   > **实测基线（2026-10-14 收口时跑的，非推断）**：`npm run test` → **3 个用例文件 / 26 个用例全通过**；
   > **两条反向对照**（改完即还原，`sha256` 复原：`927dcc84…`）：
   > ① 把「不勾选就不批」改成真值判断 → 第 1 条用例**变红并点名**（`autoApprove=1` 被误判成显式勾选）；
   > ② 拿掉 `canReview()` 资格检查（孩子也能自批）→ **2 条变红**（"孩子永远不能自批" ＋ "资格完全由矩阵导出"）。
   > `npm run ci` → **`CI_EXIT=0`（14 步）**。
   **遗留（W1 必做）**：审批写入路径（含自批）落地时**必须消费** `approval-policy.ts`，
   不得在 controller / service 里另写一份判定；`02` §4.5 的六条硬约束要逐条落成 HTTP 用例。
   **✅ 已推进（阶段 B4，2026-10-14）**：HTTP 路径建成并**真实消费** `approval-policy.ts` —— 见下面第 15 条。

15. ~~**「谁可以批准」的 HTTP 路径**~~ → ✅ **已完成（2026-10-14，阶段 B4）**：审批从「契约」走到「线上路径」——
   `POST /approvals`（**202** pending ／ **201** 自批 ／ **400** 没资格却要自批）与
   `POST /approvals/:id/decide`（200 ／ 403 无批准资格 ／ 409 已决 ／ 404 没有这条），
   判定**完全消费** `backend/src/contracts/approval-policy.ts`（`approvals.service.ts` 内**零角色判断**），
   用例 `backend/test/approvals-http.test.ts`（**真起 Nest 服务 + 真发 HTTP 请求**，26 条）。
   全局管道经 `backend/src/app.setup.ts` 的 `applyGlobalPipes()` 装配（`main.ts` 与测试**同一函数**）。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **4 个用例文件 / 52 个用例全通过**；
   > **四条证伪**（改完即还原，`sha256` 复原：`b9ca4232…` / `7d3eea13…` / `e266d449…` / `d02c9be9…`）：
   > ① 关掉 `ValidationPipe` 的白名单 → 「未知键 → 400」**变红并点名**；② 在 service 里硬编码
   > 「child 一律不能自批」→ 「唯一事实源：改矩阵行为必须跟着变」**变红并点名**；
   > ③ 让默认仓储「假装成功」→ 「501 fail-closed」**变红并点名**；④ 让 `tsc` 少产出一个测试文件 → 新守卫**变红并点名**。
   > `npm run ci` → **`CI_EXIT=0`（14 步）**。
   > **真实应用探针（同日，`node dist/main.js` —— 真实 AppModule ＋ 真实 Prisma ＋ 真实全局管道，非测试替身）**：
   > 合法请求（guardian / redeem 未勾选）→ **501 `APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`**；孩子要自批 → **400 `SELF_APPROVAL_NOT_ALLOWED`**；
   > 带多余键 `foo` → **400**；缺身份头 → **401 `UNAUTHENTICATED`**；启动日志含
   > `Mapped {/approvals/:id/decide, POST}` 与 `数据库已连接`。脚本 `tools/_scratch/b4-live-probe.sh`（可复跑）。
   **两条硬事实（本轮实测得到，都会咬人）**：① **测试入口从 `tsx` 换成「先 `tsc` 真编译再跑」**——
   esbuild/tsx 对**不在 tsconfig `include` 内**的文件连装饰器都不转译
   （`Parameter decorators only work when experimental decorators are enabled`）；挪进 `include` 后**更糟**：
   `ValidationPipe` 因缺 `emitDecoratorMetadata` 而**静默整体失效**（实测 `{action:'redeem', foo:1}` 返回 **201**）。
   现在 `tsc -p tsconfig.test.build.json` → `.tmp_test_build/` → 再跑（metadata 与生产同一套）；
   ② 新增守卫：**源码测试文件数 == 编译产物文件数**（少一个即红并点名），
   防「文件静默没编译出来 ⇒ 静默没跑」（与 D12 同类）；`--test-concurrency=1` 同时定死「共享状态不许并发」。
   **两条诚实记录**：① **落库 / 账本流水 / 审计写入仍未落地** —— `ApprovalsPort` 的默认实现是
   **显式 501**（`APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`），组 A 的 4 条用例专门钉住「不许假装成功」；
   ② ~~身份是**临时口径**（`x-kp-role` / `x-kp-user-id` 头）~~ ✅ **已由 W1-C 删除**
   （`src/device-session/temporary-role.guard.ts` **本仓库已无此文件**，见第 18 条）。
   **下一步**：~~W1 剩余两段（身份 ＝ `DeviceSession`；屏障一／三）~~ → 两段均已完成（第 17／18 条）→
   **W2**（账本内核 ＋ `ApprovalsPort` ／ `MembershipPort` ／ `DeviceSessionPort` 的 Prisma 实现）。
   > ★ 后续：其中「**屏障一／三**」已由 **W1-B（2026-10-15）** 完成（第 17 条）、
   > 「**身份**」已由 **W1-C（2026-10-15）** 完成（第 18 条）。
   > ★ 再更新（2026-10-16，W2-D）：这批 W2 工作里，**账本内核＋装配**已由 W2-A/B/C 交付、
   > **`MembershipPort` / `DeviceSessionPort` 的 Prisma 实现**已由 **W2-D** 交付；
   > **`ApprovalsPort` 仍是 501（★ 有库也是）** —— 见第 19 条的 W2-D 段。

16. ~~**权限矩阵没有调用者（屏障二只是注释）**~~ → ✅ **已落地（2026-10-14，阶段 W1-A）**：
   `PERMISSION_MATRIX` 此前**没有任何请求路径会查它**（`resolveVerdict` 只被单测调用）——
   一张没人查的权限表等于注释，它不会拦住任何人。现在接上**唯一一个**消费点：
   `backend/src/permissions/permissions.guard.ts`（`PermissionsGuard` ＋ `@RequireAction('动作名')`），
   判定**全部**来自矩阵（guard 内**零**角色名单）。三值语义按 `02` §3：
   `ALLOW` → 放行；`DENY` → **403 `FORBIDDEN`**；`REQUIRE_APPROVAL` → **403 `APPROVAL_REQUIRED`**；
   **端点漏标** → **403 `NO_ACTION_DECLARED`**；`viewer` ／未知动作 → `DENY`（继承 D6）。
   挂载点是**控制器级** `@UseGuards(TemporaryRoleHeaderGuard, PermissionsGuard)` ——
   （★ W1-C 之后写成 `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`，
   第 1 位换成了**服务端会话解析**，见第 18 条。）
   **不是** `APP_GUARD`：Nest 的 Guard 顺序是「全局 → 控制器 → 方法」，全局注册会让屏障二
   **先于**身份解析执行（拿到空 `actor`）；数组顺序（身份在前）同理，写反即**响亮失败**。
   `Actor` / `RequestWithActor` 随之从临时头文件迁到 `src/permissions/actor.ts`
   （类型搬家与行为变更分成两次 diff：W1-C 删临时 Guard 时不会牵动审批模块）。
   用例 `backend/test/permissions-guard.test.ts`（**真起 Nest ＋ 真发 HTTP**，16 条）＋
   **改掉一条旧断言**：`approvals-http.test.ts` 里「viewer 传 `autoApprove` → 400」现在由屏障二在
   **更外层**拦成 **403**（拦得更早，**不是覆盖丢失**：policy 层的 viewer fail-closed
   仍由 `approval-policy.test.ts` 的纯函数用例钉着）。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **5 个用例文件 / 68 个用例全通过**；
   > `npm run ci` → **`CI_EXIT=0`（14 步）**。**六条证伪**（`tools/_scratch/w1a-canfail.mjs`，
   > 改完即还原、逐条 `sha256` 复原）：① 让矩阵的 `DENY` 对 `review_approvals` 失效 →
   > 「child DENY ⇒ 403」**变红并点名**；② 让 `viewer` 从 `DENY` 变回 `ALLOW` → 「viewer 一律 403」**红**；
   > ③ 让 `REQUIRE_APPROVAL` 对 `add_wish` 失效 → 「403 `APPROVAL_REQUIRED`」**红**；
   > ④ 在 guard 里硬编码一份名单 → 组 D「改矩阵 ⇒ 行为必须跟着变」**红**；
   > ⑤ 删掉 controller 上的 `@RequireAction` → 「child 批准 ⇒ 403」**红**；
   > ⑥ 让 `@RequireAction` 写入 `undefined` → 「双角色 `ALLOW` 都放行」**红**。
   > **证伪的两个前提（本轮实测得到，会咬人）**：① **变异必须编译得过** —— `false && …` 会让整块
   > 不可达、`actor` 的类型收窄随之丢失，`tsc` 报 **`TS18048`** 而**测试根本没跑**
   > （于是"点名"断言失败；那也是 `run-tests.mjs`「编译不过就拒绝跑测试」那道守卫真生效的证据）；
   > ② 组 D 的手法是**运行期改矩阵对象**（`as const` 只管类型层）—— 这是「矩阵之外不得有第二份判定」
   > 唯一能被证伪的方式。
   **仍未落地（不粉饰，与"已完成"分开记）**：① ~~**屏障一**（成员资格门 `MembershipModule`）无调用者~~
   ／ ② ~~**屏障三**（`member-restrictions.ts` 的 `stricter()`）**未接入任何请求路径**~~
   → 两条均由 **W1-B 接线**（见下面第 17 条）；③ ~~actor 仍是**临时头**（`x-kp-role`）——
   **屏障二是真的，「我是谁」目前还是假的**~~ ✅ **已由 W1-C（2026-10-15）修掉**（第 18 条）：
   actor 现在来自**服务端会话行**，`x-kp-role` / `x-kp-user-id` 已废弃且不再被读取。
   **下一步**：~~W1-B（屏障三接线 ＋ 成员资格门）~~ → ✅ 见第 17 条；~~下一段是 **W1-C**（`DeviceSession`，随后删临时 Guard）~~ → ✅ 见第 18 条。

17. ~~**屏障一（成员资格门）无调用者 ＋ `stricter()` 未接进请求路径**~~ → ✅ **已落地（2026-10-15，阶段 W1-B）**：
   三道屏障**都接在同一条请求路径上**了。此前 `MembershipModule` 是**空壳**（全仓零调用者）、
   `stricter()` **没有任何调用者** —— 也就是："这个人跟这个孩子有没有关系"从来没人问过
   （只要角色头合法，就能对**任意** childId 走矩阵），而家长为单个孩子配的限制**配了等于没配**
   且**没人看得见**。
   **落地物**：`backend/src/membership/` 三件套（`membership.gate.ts` 纯函数判定内核 ＋
   `membership.repository.ts` 端口/令牌/默认 501 ＋ `membership.guard.ts` 守卫）
   ＋ `contracts/member-restrictions.ts` 新增 `tightenVerdict()`（消费 `stricter()`，
   即**屏障三的判定核**，且**只能更严**在代码形状上就成立）
   ＋ `permissions.guard.ts` 换成 `tightenVerdict(矩阵判定, member.restrictions, …)`。
   **守卫链（数组顺序即语义）**：`@UseGuards(TemporaryRoleHeaderGuard, MembershipGuard, PermissionsGuard)`
   （★ 第 1 位已由 **W1-C** 换成 `DeviceSessionGuard`，见第 18 条。）
   —— 身份 → **资格** → **矩阵＋成员级收紧**；`ApprovalsModule` 随之接入 `MembershipModule`。
   ★ 实测坑：`@UseGuards(类)` 时 Nest 在**宿主模块**上下文里实例化守卫，
   所以 `MembershipModule` 必须**导出端口令牌**（只导出 Guard 会直接
   `Nest can't resolve dependencies of the MembershipGuard (?) … Symbol(MEMBERSHIP_REPOSITORY)`）。
   **两条新的 fail-closed（都可执行断言）**：① `kpMember` 缺失 ⇒ `PermissionsGuard` **抛错（500）**
   ——"没查" ≠ "查了没有限制"；② 成员位 `restrictions` 形状坏了 ⇒ **500 `INVALID_MEMBER_RESTRICTIONS`**
   （**数据坏了 ≠ 没权限**）—— D3b 的 `validateRestrictions()` 至此才有了**请求路径上的**调用方。
   **身份从两个头变三个头**：新增 **`x-kp-child-id`**（屏障一的必要输入；它是 `DeviceSession.childId`
   的临时替身），缺任一个头 → **401**（缺孩子上下文**绝不**退化成"跳过检查"）。
   **两条旧断言的行为变更（都改在明处，不是漂移）**：`approvals-http.test.ts` 与
   `permissions-guard.test.ts` 里 viewer 的 403 码由 `FORBIDDEN` 变为 **`MEMBER_NOT_FOUND`** ——
   `viewer` 不是任何孩子的成员位，所以他在**屏障一**就被拦下（屏障一先于屏障二，02 §3）；
   "viewer 在矩阵里无列 ⇒ DENY" 仍由 `permission-matrix.test.ts` 的纯函数穷举钉着。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **7 个用例文件 / 98 个用例全通过**
   > （W1-A 之后是 5 / 68；新增 `membership-gate.test.ts` 8 条、`membership-http.test.ts` 16 条、
   > `member-restrictions.test.ts` +6 条屏障三内核用例，含 §9.22 的**穷举** 25 动作 × 2 角色 × 6 限制 × 5 金额）；
   > `npm run ci` → **`CI_EXIT=0`（14 步）**；**六条证伪**（`tools/_scratch/w1b-canfail.mjs`，
   > 改完即还原、逐条 `sha256` 复原，`ALL PASS`）：① 让"查不到成员位"变成编造一个成员 →
   > 「非成员 ⇒ 403」**红**；② 让"已移除"不再被拒 → 「removed ⇒ 403」**红**；
   > ③ 让 `childCannotAddWish` 失效 → 「add_wish 被收紧」**红**；④ `stricter()` 写丢 →
   > 「§9.22 方向性（穷举）」**红**；⑤ 让裸 `Json` 形状校验失效 → 「形状坏了 ⇒ 500」**红**；
   > ⑥ 把 childId 写死 → 「childId 真的参与判定」**红**。
   > **真装配复验（`tools/_scratch/w1b-live-probe.sh`，真 AppModule ＋ 真 Prisma ＋ 真全局管道）**：
   > 三个头齐全 → **501 `MEMBERSHIP_QUERY_NOT_IMPLEMENTED`**；缺 `x-kp-child-id` → **401**；
   > 无身份头 → **401**；多余键 → **501**（Guard 在管道之前，屏障一的 501 盖住管道的 400）；
   > 启动日志含 `Mapped {/approvals/:id/decide, POST}` 与 `数据库已连接`。
   > ⚠️ **W2-D 修订（2026-10-16）**：以上是 **W1-B 时段（无库装配）** 的结论，原样成立；
   > **有库**世界里屏障一已真查库 ⇒ 那两个 501 分别变成 **403 `MEMBER_NOT_FOUND`**（成员位不存在）
   > 与 **400**（成员位存在 ⇒ 管道照常生效）。★ 原句"成员查询落地后回到 400"**只在成员位存在时成立**；
   > ✅ **有库这一半已实测（2026-10-17）**：`tools/_scratch/w2d-live-probe.mjs`（真 `dist/main.js` ＋ 真库 ＋ 真 HTTP）
   > **12/12** 符合预期 —— 成员位不存在 ⇒ **403 `MEMBER_NOT_FOUND`**；`status='removed'` ⇒ **403 `MEMBER_REMOVED`**
   > （两种 403 在真数据上分得开）；多余键 ⇒ **400**（`statusCode:400`，**无**业务 code）；
   > 合法 guardian ⇒ **501 `APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`**。同一矩阵已入库为
   > `backend/test-db/approvals-db.dbtest.ts`（12 条，接进 `npm run test:db`）—— 结论不再只有临时物支撑。
   > **证伪的坑又踩了一次（值得记住）**：① 号变异原本写成在 guard 里加 `&& verdict.code !== 'MEMBER_NOT_FOUND'`
   > —— **编译不过**（它破坏 `verdict` 的类型收窄，DENY 分支没有 `.row`，`tsc` 报 TS2339），
   > runner 直接拒绝跑测试 ⇒ 表现为"没点名"。**W1-A 已记录过同一条教训**，本轮复现一次，
   > 于是把该条改成动**判定内核**（能编译、且正是要防的"查不到就跳过"）。
   **仍未落地（不粉饰，与"已完成"分开记）**：① ~~**成员位仍是端口 + 内存替身**
   —— 默认实现是 **501**（真装配下**没有人**被放过去，但它也**还没真的查过库**；真 Prisma 适配器属 W2，
   理由：`MembershipModule` 一注入 `PrismaService`，**无库 CI 会在启动阶段就崩**）~~ →
   ✅ **已由 W2-D 结清（2026-10-16，见第 19 条的 W2-D 段）**：**有库** ⇒ `PrismaMembershipRepository`
   （真查 `ChildMember`，复合键 `(childId, userId)`）、**无库** ⇒ 仍旧 501；
   ★ 原先"一注入 `PrismaService`，无库 CI 就崩"这个卡点，已由 W2-C 的**动态模块**口径消掉；
   ② **`requireApprovalForBonusOver`（金额阈值）在 HTTP 路径上不生效** —— 金额属 dispatcher 的 payload
   （02 §6 未落地），有一条用例**把这个现状钉住**；三条限制键**都不**作用于 `request_approval`
   ⇒ **屏障三在 `/approvals` 上结构性不生效**（HTTP 层用同一套守卫链的探针端点验证）；
   ③ `POST /approvals/:id/decide` 用的是**请求头里的** childId，**尚未**与审批行自己的 childId
   做同源校验（要等 `ApprovalRow` 带上它）—— 即跨家庭推进审批这条路径**还没堵**；
   ④ ~~actor 仍是**临时头**（三个）—— **三道屏障都是真的，「我是谁」目前还是假的**~~ →
   ✅ **已由 W1-C 修掉**（第 18 条）：actor 改由**服务端会话行**给出。
   **下一步**：~~W1-C（`DeviceSession`：把"我是谁 / 对哪个孩子"由服务端确立，随后删临时 Guard）~~ → ✅ 见第 18 条 →
   ~~W2（账本内核 ＋ `ApprovalsPort` / `MembershipPort` / `DeviceSessionPort` 的 Prisma 实现）~~。
   > ★ 2026-10-16：这笔 W2 账**已按端口拆开结清** —— 账本内核＋装配属 W2-A/B/C；
   > `MembershipPort` / `DeviceSessionPort` 已由 **W2-D** 接真库；**`ApprovalsPort` 仍在账上**（有库也是 501，
   > 见第 19 条的 W2-D 段）。

18. ~~**角色 / 身份由客户端自报（临时头）**~~ → ✅ **已落地（2026-10-15，阶段 W1-C）**：
   W1-A / W1-B 之后三道屏障**都是真的**，但它们的共同输入 `actor` 来自**客户端自己发的头**：
   发 `x-kp-role: guardian` 就是家长、发谁的 `x-kp-user-id` 就是谁（`02` §7 早就写明"不存客户端"的理由：
   小程序 storage 可直接改）。于是"屏障拦得对不对"**没有人验证过** —— 拦住一个**自称**是家长的人，
   与拦住一个**真的**是家长的人，是两件事：**屏障是真的，「我是谁」是假的**。
   **落地物**：`backend/src/device-session/` 三件套 —— `session.gate.ts`（**纯函数**判定内核：
   `resolveSession()` / `effectiveRole()` / `toSessionActor()`）＋ `device-session.repository.ts`
   （端口 `DeviceSessionPort` ＋ 令牌 ＋ 默认 **501**）＋ `device-session.guard.ts`（`DeviceSessionGuard`）。
   **守卫链第 1 位换人**：`@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`
   —— 顺序仍**载荷**（写成 `APP_GUARD` 会让屏障先于身份跑、拿到空 actor，理由同 W1-A）。
   **身份从"三个自报头"变成"两个头 ＋ 一次服务端查询"**：客户端只被允许回答
   `x-kp-device-id`（哪台设备）＋ `x-kp-child-id`（哪个孩子的档案）；**角色与 userId 由会话行给出**；
   `temporary-role.guard.ts` **已删除**（`src/device-session/` 下已无此文件）。
   **口径（对齐 `02` §7 / §9.19）**：缺任一个头 ⇒ **401 `UNAUTHENTICATED`**（含重复头 / 空串）；
   会话**查不到** ⇒ **401 `SESSION_NOT_FOUND`**（★ 不默认成匿名 child —— 那会让整条权限链变成可选）；
   `guardian` 会话**过期 ⇒ 角色回落 `child`**（**降级不是拒绝**：过期判 401 会把 TTL 变成故障，
   孩子连"看自己积分"都做不了）；**形状坏 ⇒ 500**（`INVALID_SESSION_ROLE` / `INVALID_SESSION_EXPIRY` /
   `SESSION_CHILD_MISMATCH`），与 401/403 严格分开 —— **数据问题不该被当成权限问题排查**。
   ★ TTL 边界（`expiresAt === now` 即过期）在 `session.gate.ts` **一处**定死。
   ★ `SESSION_CHILD_MISMATCH` 是**留给适配器的守卫**：`(deviceId, childId)` 是查询键，
   适配器若忽略 `childId`（只按 deviceId 查），返回的行就会与请求对不上、当场 500（④ 证伪专盯它）。
   **两条 fail-closed（都可执行断言）**：① **无库装配**时端口默认实现**显式 501**
   （`SESSION_LOOKUP_NOT_IMPLEMENTED`）⇒ **无库时每个请求都拒绝**（★ W2-D 起**有库**走真适配器，
   查不到即 401 `SESSION_NOT_FOUND` —— 两者都 fail-closed，但"响亮"的名字不同）；② `NODE_ENV=production` ⇒
   **503 `IDENTITY_NOT_IMPLEMENTED`**（★ 故意保留：角色/身份的**来源**可信了，
   但**设备凭据仍不可验证** —— `x-kp-device-id` 谁都能报 ⇒ 可冒充别人的会话；解药是 L2 之后的会话 token）。
   > **实测基线（收口时跑的，非推断）**：`npm run test` → **9 个用例文件 / 144 个用例全部通过**
   > （W1-B 之后是 7 / 98；新增 `session-gate.test.ts` **22 条**、
   > `device-session-http.test.ts` **22 条**，迁移后的 `approvals-http.test.ts` 27 条 /
   > `permissions-guard.test.ts` 17 条 / `membership-http.test.ts` 16 条；
   > 逐文件数字取自 `node --test <单个产物文件>` 的汇总行，九个文件相加 **= 144**，与 runner 汇总一致）；
   > `npm run ci` → **`CI_EXIT=0`（14 步）**；**六条证伪**（`tools/_scratch/w1c-canfail.mjs`，
   > 改完即还原、逐条 `sha256` 复原，`ALL PASS`）：
   > ① 让"查不到会话"变成放行（编造一份会话）→ 「`SESSION_NOT_FOUND`」**红**；
   > ② 让客户端自报的 `x-kp-role` **重新生效** → 「自报角色无效」**红**（本阶段的核心回归）；
   > ③ 让 TTL 到期**不**降级 → 「§9.19 过期 ⇒ 回落 child」**红**；
   > ④ 关掉 `childId` 同源校验 → 「`SESSION_CHILD_MISMATCH`」**红**；
   > ⑤ 让端口默认实现返回**假会话**而不是 501 → 「默认装配 fail-closed」**红**；
   > ⑥ 拆掉生产闸门 → 「生产 ⇒ 503」**红**。
   > **真装配复验（`tools/_scratch/w1c-live-probe.sh`，真 AppModule ＋ 真 Prisma ＋ 真全局管道，6 条全中）**：
   > 设备＋孩子上下文齐全 → **501 `SESSION_LOOKUP_NOT_IMPLEMENTED`**；**只发 W1-A/W1-B 的三个自报头
   > （不发设备头）→ 401**（自报角色**不再是身份**）；自报 `guardian` ＋ 设备头齐全 → 仍是 501；
   > 缺 `x-kp-child-id` → 401；无头 → 401；`NODE_ENV=production` → **503**。
   > ★ 与 W1-B 的探针**对照着看**（两轮各自的"①号请求"＝**当轮口径下头齐全的合法 `POST /approvals`**）：
   > 501 **换了名字**（W1-B：`MEMBERSHIP_QUERY_NOT_IMPLEMENTED` → W1-C：`SESSION_LOOKUP_NOT_IMPLEMENTED`）——
   > 这是"身份层现在排在屏障一**之前**"的**可观测**证据（而不是注释里的一句声明）。
   > ⚠️ 严格说**两次的请求头并不相同**（W1-B 是三个自报头，W1-C 换成"设备＋孩子上下文"）——
   > 头集合变了**正是本阶段的目的**；若把 W1-B 的三个头**原样**发过来，W1-C 给的是 **401**（见上一条）。
   > **证伪的坑第三次出现（三条记录已一致）**：④ 号变异原本写成 `if (false && row.childId !== requestedChildId)`，
   > `tsc` 报 **TS18047**（`row` 的**非空收窄**被字面量 `false` 短路掉，`row.deviceId` 变成 possibly null）
   > ⇒ 编译不过 ⇒ runner 拒绝跑测试 ⇒ 表现为"没点名"。W1-A 是 `TS18048` / W1-B 是 `TS2339`，
   > 三次都栽在**同一条**纪律上：**变异必须先确认能编译**（改用"永假比较"`row.childId.length < 0` 后立刻变红）。
   **仍未落地（不粉饰，与"已完成"分开记）**：① ~~**会话查询的实现** ——
   `DEVICE_SESSION_REPOSITORY` 默认实现是 **501**，真 Prisma 适配器属 **W2**
   （同一取舍：一注入 `PrismaService`，**无库 CI 会在启动阶段就崩**）~~ →
   ✅ **已由 W2-D 结清（2026-10-16，见第 19 条的 W2-D 段）**：**有库** ⇒ `PrismaDeviceSessionRepository`
   （真查 `DeviceSession`，复合键 `(deviceId, childId)`）、**无库** ⇒ 仍旧 501；
   ⇒ **"身份由服务端确立"说的是机制，不是"已经能登录了"**（这一句**不变** —— `deviceId` 仍不可验证，见下条）；
   ② **凭据未认证** —— `deviceId` 不可验证 ⇒ 生产 503（**"身份层已完成"这句话现在还不能说**，
   能说的是"**角色不再由客户端自选**"）；
   ③ **PIN 切换 / 锁 15 分钟 / 审计 / 会话刷新（`02` §7 那四行）全都未实现** ——
   没有"切家长模式"端点，`pinHash` / `pinLockedUntil` 至今无人使用；
   ④ `POST /approvals/:id/decide` 的**跨家庭推进仍未堵**（用的是请求里的 childId，
   与审批行自己的 childId 尚未同源校验）—— 会话层只解决了**一半**。
   **下一步**：~~W2（账本内核 ＋ 三个端口的 Prisma 实现：`Approvals` / `Membership` / `DeviceSession`）~~。
   > ★ 2026-10-16：账本内核＋装配属 W2-A/B/C；`Membership` / `DeviceSession` 已由 **W2-D** 接真库；
   > **`ApprovalsPort` 仍在账上（有库也是 501）**。

19. ~~**账本只有前端一份语义（后端没有内核）**~~ → ✅ **已落地（2026-10-15，阶段 W2-A）**：
    A1 / A4 / B6 / B7 / B8 这几条**前端**已修好的账本缺陷（见上表「前端可控制缺陷」），
    在**后端**一直没有对应物：评分、扣分、兑换、撤销的语义只活在
    `kids_points_mp/src/data/store.ts` 与 `lib/data/app_store.dart` 里，
    后端连一个"这一笔该记多少分"的判定都没有。后果不是"少个功能"，而是
    **同一条语义在两处各写一遍、迟早漂移 —— 而漂移的地方正好是账目**：
    前端不再用 `Math.abs` 抹平符号、后端若自己再实现一遍就又会抹平；
    前端拒绝余额不足、后端若改成截断就又会出现 `Σ流水 ≠ 余额`。
    **落地物**：`backend/src/ledger/` —— `ledger.gate.ts`（**纯函数**判定内核：
    `signedDelta()` / `resolveBalanceAfter()` / `buildRecordDraft()` / `reverseRecordDraft()` /
    `findSnapshotMismatches()` / `assertSnapshotMatchesVersion()` / `verifyBalanceChain()`）
    ＋ `ledger.repository.ts`（端口 `LedgerPort` ＋ 令牌 ＋ 默认 **501**）
    ＋ `ledger.module.ts`（真装配，导出令牌）＋ `test/ledger-gate.test.ts`（**组 A–G，9 个 suite / 59 条用例**）。
    **内核不碰 HTTP / DB / Prisma 客户端实例**（只借 Prisma 的**枚举类型**）⇒ 可以**离线穷举**
    （余额恰好扣到 0、规则方向是 `penalty`、原记录已被冲正过、同一毫秒的两笔……），
    且 `verifyBalanceChain()` / `findSnapshotMismatches()` 这两把尺子**W2-B 的真库套件直接复用**
    —— 同一个尺子两处用，才不会出现"写入时校验一套、验证时另一套"。
    **修的五条病（逐条对上前端的同编号）**：① **A1** —— 符号**只有一个来源**
    （`direction × points`，**绝不用 `Math.abs`**）；负分规则若被调用方按 `+Math.abs(points)` 记，
    直接拒绝（`DELTA_RULE_MISMATCH`），**不猜**；② **A4** —— 流水记**真实**操作人
    （`operatorUserId` / `operatorRole`），且 `child_self` 必须是孩子、`guardian` 必须是家长；
    `system` 来源**不许**带操作人（"系统干的"与"某人干的"必须分得开）；
    ③ **B6** —— 余额不足**拒绝**（`INSUFFICIENT_POINTS`），**绝不截断到 0**
    （旧实现 `if (points < 0) points = 0` 会让余额照改、流水照记 ⇒ 账本再也对不上）；
    ④ **B7** —— 撤销写**冲正**记录（`source='correction'` ＋ `reversesRecordId` ＋ 金额取反），
    原记录**完全不动** ⇒ 流水条数 **+1 而非 −1**；⑤ **B8** —— `titleSnapshot` **完整不截断**
    （截断只允许发生在渲染层）、兑换必须带 `costSnapshot`（心愿被删后这笔扣分仍解释得清）。
    **落地的不变量（`02` §5.7）**：**I4**（快照 == 版本行的对应值）—— 双用：
    写侧 `assertSnapshotMatchesVersion()` 落库前不一致即拒（宁可 500），读侧
    `findSnapshotMismatches()` 给真库套件逐行点名到「哪个孩子、哪条记录、哪一列、期望多少、实际多少」；
    且**由构造保证**：传了版本行时快照字段一律取自版本行，调用方**无法**自己拼标题。
    **I6**（撤销 = 冲正）见上；**I2**（`balanceAfter` 链自洽）—— `verifyBalanceChain()`
    返回**人类可读的违例句**（空数组 = 自洽），并**逐处**点亮断裂（不是第一处就收工）。
    **两条 fail-closed（都可执行断言）**：① 端口默认实现**显式 501**
    （`LEDGER_PERSISTENCE_NOT_IMPLEMENTED`：**读余额 / 读原记录 / 读已冲正集合 / 读版本行 /
    追加一笔 / 读整条链** 六个方法全拒）⇒ 默认装配下**任何走账本的路径都是 501** ——
    假装写成功会让积分"看起来扣了却根本没落库"，那是本仓库最贵的病；
    ② **错误分型**（与 `session.gate.ts` 同纪律）：数据/装配坏了 ⇒ `LedgerShapeError`（**500**），
    正常业务分支（积分不够 / 重复冲正 / 记 0 分）⇒ `LedgerDeniedError`（**400/409**）
    —— **数据问题不许被当成"用户操作不对"**。
    ★ **枚举白名单用 `Record<Prisma枚举, true>`** 提供**编译期穷举**：Prisma 枚举加值时这里编译报错
    ⇒ **被迫做决定**（而不是静默把新值当 `praise` 放行）。
    > **实测基线（收口时跑的，非推断）**：`npm run test` → **10 个用例文件 / 203 个用例全部通过**
    > （W1-C 之后是 9 / 144；新增 `ledger-gate.test.ts` **59 条**，逐文件数字取自
    > `node --test <单个产物文件>` 的汇总行：**9 个 suite / 59 条**，相加 **= 203**，与 runner 汇总一致）；
    > ★ **踩过一次的坑（记下来给 W2-B）**：`node --test .tmp_test_build/test/xxx.test.js` 读的是**磁盘上现成的产物** ——
    > 若上一次跑的是 `npm run test:canfail`（它会在**变异后**编译、跑完再把源码还原），
    > 产物就是**变异版**的。实测：直接这么数 `ledger-gate.test.js` 得到 **57/59（2 红）**，
    > 而 `npm run test` **同一条代码 59/59 全绿** —— 那是**假红**，不是回归。
    > 纪律：**取逐文件数字前先 `npm run test`（或 `npm run build`）刷新产物**。
    > `npm run ci` → **`CI_EXIT=0`（14 步）**；**六条证伪**（`tools/_scratch/w2a-canfail.mjs`，
    > 改完即还原、逐条 `sha256` 复原，`ALL PASS`）：
    > ① 让 `signedDelta` 用 `Math.abs` 抹平符号（**A1 原病**）→「负分规则被抹平」**红**；
    > ② 让余额不足**截断到 0** 而不是拒绝（**B6 原病**）→「静默截断」**红**；
    > ③ 让操作人硬编码成"家长"（**A4 原病**）→「操作人必须是真实操作人」**红**；
    > ④ 让"已被冲正过"的记录**再冲一次**（幂等保护失效）→「`ALREADY_REVERSED`」**红**；
    > ⑤ 让端口默认实现**假装写成功**（返回假记录）→「默认装配 fail-closed」**红**；
    > ⑥ 让 I2 对账器不再核对 `balanceAfter`（比较条件改成永假）→「F 组・中部断裂」**红**。
    > ★ ⑥ 的点名走的是**用例名**而非断言消息：关掉对账器后它先在"违例条数"那步就红了，
    > 根本走不到"期望多少、实际多少" —— **点名要跟着实际红在哪儿走**（与 W1-C ④ 同一条纪律）。
    > ★ **真库陷阱（本轮实测记录，W2-B 必须处理）**：PostgreSQL 的 `now()` 在**同一事务内是同一个值**
    > ⇒ 同事务写入的两条记录 `createdAt` **完全相同** ⇒ 单靠 `(childId, createdAt)` **无法定序**，
    > `balanceAfter` 滚动求和就**没有唯一解**。因此 `verifyBalanceChain()` 遇到同一孩子的并列时间戳时
    > **报「I2 顺序不可判」而不是报「断裂」** —— 换个排序就可能自洽，那属于**报假病**（比不报更糟）；
    > 修法在**写入侧**（时间戳必须严格递增：显式传 `createdAt` 或加序列表），**不是让尺子猜顺序**。
    > ★ 另记一条**尺子的可见边界**（写进用例，免得被当真）：链"自洽但余额为负"（−5 ⇒ −5，−5 ⇒ −10）
    > **I2 判不出来** —— I2 只管 `Σ流水 == balanceAfter`，管不了"余额本身是否合法"；
    > 后者由写入侧拒绝（B6）＋ 真库层面再加一把尺子（`Child.pointsBalance >= 0`，属 W2-B）共同守。
    **仍未落地（不粉饰，与"已完成"分开记）**：① **真 Prisma 适配器** ——
    `LEDGER_REPOSITORY` 默认实现是 **501**，**没有任何写入路径是通的**
    ⇒ **"账本内核已落地"说的是判定语义，不是"积分已经能记账了"**（同一取舍：一注入 `PrismaService`，
    无库 CI 会在启动阶段就崩）；② ~~**I1 / I3 / I5 三条不变量仍未有代码**（逐字段 diff /
    复合外键命中 / `REVOKE`）~~ → ✅ **已由 W2-B 的真库套件交付**（组 C / 组 D / 组 G）；
    ③ `idempotencyKey` 的**重放保护尚未接线**（`IdempotencyRecord` 表 ＋ 请求体哈希），
    内核这一层只负责把**空白串归一成 `null`**（"看起来给了键"的假键不许成立）。
    **下一步**：W2-B（`LedgerRepository` 的 Prisma 实现 ＋ 三个端口的真实现 ＋ 真库不变量套件，
    先解决上面的 `createdAt` 定序陷阱）。

    **W2-B 进展（2026-10-15；必须与上面的「仍未落地」合起来读，别只看这一段）**：
    ① `backend/src/ledger/ledger.prisma.repository.ts`（`PrismaLedgerRepository`）—— 六个方法全实现，
    `append()` 在**单事务**内：`SELECT … FOR UPDATE` 锁住余额行 → 取库钟与最新时间戳 → 余额 **CAS**
    （`WHERE pointsBalance = 期望值`；陈旧草稿 ⇒ 409 `LEDGER_BALANCE_CHANGED`）→ `INSERT`；
    `mapWriteError`：`P2002` → `LEDGER_DUPLICATE_IDEMPOTENCY_KEY`（**库层唯一约束**拦重放）、
    `P2003` → `LEDGER_RULE_VERSION_MISSING`（⇒ **I3 由复合外键强制**，不靠"应用记得检查"）；
    ★ 另有一条**只能靠真库发现**的结论：`PointRecord.reversedAt` **永远是 `null`**（应用角色对它没有
    `UPDATE` 权限，I5）⇒「已被冲正」**只能**从新记录反查（`readReversedIds()`）——
    任何按 `reversedAt` 判断"冲正过没有"的代码都会**永远认为没被冲正过**。
    ② `backend/test-db/ledger-db.dbtest.ts`（**组 A–I / 9 个 suite / 16 条**；W2-C 又加了组 J ⇒ 现为 **A–J / 10 个 suite / 17 条**）：I1（改规则后老记录**逐字段**
    不变 ＋ 仍指向旧版本）、I2（滚动求和自洽 ＋ `createdAt` **严格递增** ＋ 库钟不许抄调用方的 `now`）、
    I3（全库扫孤儿引用 = 0 ＋ **反向证明**：直接写一条指向空版本的记录 ⇒ 库自己拒绝 `P2003`）、
    I4（逐行跑 `findSnapshotMismatches()`，含负分规则；并用"喂一份被改过的版本行必须有输出"证明**尺子有牙齿**）、
    I5（`UPDATE` / `DELETE` / Prisma 客户端 `update` 全被拒 —— 按 **SQLSTATE 42501** 判定，
    **不能**按英文文案断言：本机 PG 报的是中文）、I6（冲正后原记录**逐字段不动**、条数 **+1**、
    余额复原、二次冲正与"撤销的撤销"分别被 `ALREADY_REVERSED` / `CANNOT_REVERSE_REVERSAL` 拒）、
    并发（两笔基于同一余额 ⇒ **恰好一笔**成功、另一笔 409）、幂等键重复 ⇒ 409 且**整笔回滚**
    （第二次是重新读余额构造的草稿，拦住它的**只有**唯一约束）、以及 B6 红线（全库**无负余额** ＋
    余额不足时零记录、余额不变）。
    ③ **`createdAt` 定序的实现口径**（上面那条"W2-B 必须处理"的陷阱）：严格递增由**写入侧**保证 ——
    库钟取 `clock_timestamp()`（**同一事务内会变**，`now()` 不会）＋ `MAX(createdAt)`，
    并列或回退时取 `latest + 1ms`；**调用方的 `now` 只用于业务语义，绝不写进 `createdAt`**
    （用例把调用方时钟设成 2020 年，钉住这一点）。**不改 schema、不加序列表。**
    > ★ **真库当场抓到第二个离线用例永远抓不到的 bug（形态值得记住）**：`PointRecord.createdAt` 是
    > **`timestamp without time zone`**，而 `clock_timestamp()` 是 **`with time zone`** ——
    > 直接塞进 naive 列会被 PG 按**会话时区**换算（本机 `Asia/Shanghai`）⇒ 全部流水"来自 **8 小时后的未来**"，
    > 而**读回来处处自洽**：链仍严格递增、求和仍对得上、类型也全对。**只在"和真实时间比"时才露馅。**
    > 修法 `(clock_timestamp() AT TIME ZONE 'UTC')`（naive 列存 UTC 墙钟，与 Prisma 自己写 `Date` 的约定一致），
    > 并把判据**留在真库套件里**（组 A：`|createdAt − 现在| < 60s`）——
    > 这类"静默偏移一个时区"的病，纯语义的离线用例**结构上证明不了**。
    > 记这条的用处：它解释了「为什么 W2-B 非要有真库套件不可」，比任何口号都具体。
    **仍未落地（W2-B 时段的状态；① 已由 W2-C 结清，见紧下面那一段）**：① ~~**没接进装配** ——
    `LEDGER_REPOSITORY` 仍是 501（一注入 `PrismaService`，无库 CI 会在启动阶段就崩 ⇒
    需要一个"没有 `DATABASE_URL` 也不炸"的装配口径，这才是那块拼图）~~；② 真库套件**故意不做全库 I2 扫描**
    （它自己就会造并列/未来时间戳的脏行），只做计数类红线（负余额、孤儿版本）；
    且账本表 `DELETE` 被 REVOKE ＋ `Child` 是 `onDelete: Restrict` ⇒ **夹具写进去的数据删不掉**，
    只能用随机 `RUN` 前缀隔离 —— 读这份套件的人先知道这一点，才不会以为它污染了库；
    ③ `Approvals` / `Membership` / `DeviceSession` 三个端口**仍是 501**（与上面第 15／16／18 条同一笔账）
    —— ★ **W2-D 之后只剩 `Approvals` 一个**（另两个已接真库；见下面的 W2-D 段）；
    ④ `idempotencyKey` 的重放保护仍**未接线**到 HTTP（库里已能拦，但**没有任何请求路径在用它**）。
    **下一步**：把 `PrismaLedgerRepository` 接进 `LedgerModule`（先解决无库 CI 的装配口径），
    再逐个替换三个端口的 501，并同步改掉那些**钉住 501 现状**的用例（它们现在钉的是"还没接"，
    接线后必须改成钉"真的查了库"）。
    > ★ 2026-10-16 回填：第一句已由 **W2-C** 兑现；"逐个替换"已由 **W2-D** 兑现**两个**
    > （`Membership` / `DeviceSession`，用例也按要求从"钉 501"扩成"钉真查库"——离线守装配、真库守键）；
    > **剩下 `ApprovalsPort` 未替换（有库也是 501）**。

    **W2-C 进展（2026-10-15）：`PrismaLedgerRepository` 接进装配 —— 上一段的"下一步"第一句已兑现**

    ① `backend/src/prisma/database-enabled.ts` ⇒ `hasDatabaseUrl()`：**全仓唯一的"有没有库"判据**
    （`DATABASE_URL` 存在且 `trim()` 后非空）。它**刻意比 `PrismaService` 严一档**（空白串也算"没有"）：
    `PrismaService` 缺库时在构造函数里**抛错**，所以危险方向只有"装配说有、它说没有" ⇒
    把严的那一侧放在装配上，这个方向就永远不可能出现。
    ② `ledger.module.ts` 改成**动态模块**：`LedgerModule.register({ hasDatabase? })` ——
    **有库** ⇒ 绑 `PrismaLedgerRepository` ＋ `imports: [PrismaModule]`（共用全仓唯一的连接池，**不另开连接**）；
    **无库** ⇒ 绑 `NotImplementedLedgerRepository` ＋ **不导入** `PrismaModule`（六个方法全 501）。
    Nest 会**急切地**实例化被导入模块的 provider ⇒ "要不要导入 `PrismaModule`"必须在**装配时**定下来 ——
    这就是上面第 ① 条那个卡点，静态 `imports` 无解。`app.module.ts` 用 `LedgerModule.register()`（不传参 ⇒ 按环境推断）。
    ③ **两个世界各有各的响亮**，没有"看起来一样"的中间态：有库 ⇒ 查不到孩子报 **404**
    （**不是**"余额 0"兜底）；无库 ⇒ 每个方法 501（可执行断言）。
    **被明确排除的第三种做法**：无库时静默跳过记账 —— 那是 B6（扣分被静默截断）的同类病。
    ④ 用例**两端各守一半**：`backend/test/ledger-wiring.test.ts`（离线 8 条，不含库）守"装配**声明**了什么" ——
    判据纯函数、绑定的类、`imports` 里有没有 `PrismaModule`、用**替身 `PrismaService`** 证明端口用的是**注入的**客户端
    （不是工厂里自己 `new` —— 那会绕过唯一连接池）、无库时六个方法**全 501**；
    `backend/test-db/ledger-db.dbtest.ts` **组 J** 守"真图上**真的**查了库" —— 真 `register()` 建图 →
    从注入器取端口 → 写一笔、读回来、**再换一条连接复核**。
    ★ 缺一不可：只有离线用例时**接反了也全绿**（组 A–I 全是手工 `new` 实例，装到 501 上照样绿）；
    只有真库用例时**没人看无库那条路**（而那正是 CI 的默认路）。
    ⑤ 基线：**`npm test`** ⇒ **11 个用例文件 / 211 条全绿**；**`npm run test:db`** ⇒ **1 个用例文件 / 17 条**（10 个 suite）全绿
    （`npm run ci` 报的是 15 步，不报用例条数 —— 见文末基线块）。
    ⑥ **证伪**（`tools/_scratch/w2b-canfail.mjs`，临时物不入库）：5 条变异各自被点名 ——
    分叉接反 ⇒ 离线组 A 红；无库也硬导 `PrismaModule` ⇒ 无库用例整体起不来（点名 `DATABASE_URL`）；
    `register()` 忽略传参 ⇒ "绑定跟着 options 走"红；判据放宽到空串也算有库 ⇒ "空串 ⇒ 无库"红；
    查不到孩子时返回 0 兜底 ⇒ "404 不是 0"红。
    **仍未落地（W2-D 之后已收窄，见紧下面那一段）**：`Approvals` 端口的 `ApprovalsPort`
    **仍是 501**（★ **有库也是** —— W2-D 只让它把世界**转发**给两个子模块，不给它自己选实现）；
    `Membership` / `DeviceSession` 两半已由 W2-D 结清（无库时仍是 501）；
    `idempotencyKey` 的重放保护仍**未接线**到 HTTP（库层已能拦，但**没有请求路径在用它**）。

    **W2-D 进展（2026-10-16）：身份层与屏障一接真库 —— 三个端口的账从"三"变"二 ＋ 一"**

    ① `device-session.module.ts` / `membership.module.ts` 改成**动态模块**（`register({ hasDatabase? })`），
    与 `LedgerModule`（W2-C）**同一口径、同一个判据**（`hasDatabaseUrl()`，全部集中在 `prisma/database-enabled.ts`）：
    **有库** ⇒ `PrismaDeviceSessionRepository` / `PrismaMembershipRepository` ＋ `imports: [PrismaModule]`
    （共用全仓唯一的连接池）；**无库** ⇒ 两个 `NotImplemented*Repository`（**显式 501**，
    且 `PrismaService` 根本**不会被实例化**）。两个适配器各自只做**一次**按**复合唯一键**的读：
    `findUnique({ where: { deviceId_childId: { deviceId, childId } } })` / `(childId, userId)` ——
    childId 是**键的一半**，不是事后过滤器；`select` 恰好五列，**适配器只读不判**
    （TTL 回落 child、角色白名单、`MEMBER_REMOVED` vs `MEMBER_NOT_FOUND` 全在内核里，只有一处权威）。
    ② `ApprovalsModule` 也改成动态模块，但它的职责**只是转发**：`options.hasDatabase ?? hasDatabaseUrl()`
    之后**原样**交给上面两个子模块；**它自己不选实现** ⇒ **`ApprovalsPort` 仍是 501（有库也是）**。
    ★ 为什么非转发不可（不是整齐，是**可复现性**）：两个子模块按环境推断时，
    `Test.createTestingModule({ imports: [ApprovalsModule] })` 的用例**够不着**它们的 options ⇒
    本机导出过 `DATABASE_URL` 的人，跑离线用例会在装配阶段把 `PrismaModule` 拉进图、**悄悄连上真库**
    （三个端口都被替身覆盖 ⇒ **不会红，只会变慢 ＋ 碰真数据**）；CI 机器上同一份用例验的却是另一件事。
    现在用例写 `register({ hasDatabase: false })` 就把世界钉死（`approvals-http` / `membership-http` /
    `device-session-http` 三个文件**全部**这么写）。
    ③ **两个世界各有各的响亮**：有库 ⇒ 会话查不到 **401 `SESSION_NOT_FOUND`**、成员位不存在
    **403 `MEMBER_NOT_FOUND`**、`status='removed'` **403 `MEMBER_REMOVED`**（三者**不同** ——
    靠"有没有那一行"分，不靠适配器顺手过滤）；无库 ⇒ 501（可执行断言，HTTP 用例正跑在这个世界上）。
    ④ 用例**两端各守一半**（缺一不可，与 W2-C 同一结构）：
    · 离线 `test/device-session-wiring.test.ts` / `membership-wiring.test.ts` / `approvals-wiring.test.ts`
    守"装配**声明**了什么" —— 分叉映射、显式 options 覆盖环境、`imports` 里有没有 `PrismaModule`、
    真 DI 图里取到的端口是哪个类、**替身 `PrismaService` 收到的 `where` 恰好是复合键那一个对象**、
    无库时端口 501 且整张图里**没有** `PrismaService`；`hasDatabase: true` 但无 `DATABASE_URL` ⇒
    **响亮地崩**（不是静默回落 501）。
    · 真库 `test-db/identity-db.dbtest.ts`（组 A–D）守"真库**真的**按那个键各读各的" ——
    同一设备对两个孩子**各一行**（`findSession` 各返回各的）＋ `@@unique` 的 **P2002** 真的会拦；
    过期行**照样读得出来**（TTL 判定归内核，不归 SQL）；`active / removed / 无行` 三态靠**独立 `count()`** 复核；
    组 D 用真 `register()` 建图、从注入器取端口读真库，并证明 `ApprovalsModule.register()` 的转发**真的生效**
    （两个子模块同一世界、`ApprovalsPort` 仍 501、`DeviceSessionGuard` 在真图上能解析）。
    ★ 缺一不可：只有离线用例 ⇒ 把 `findFirst({ where: { deviceId } })`（单键退化）写进去**照样绿**
    （替身只能证明**交出去的键**）；只有真库用例 ⇒ **没人看无库那条路**（而那正是 CI 的默认路）。
    · ★ **第三半（2026-10-17 补）**：`test-db/approvals-db.dbtest.ts` —— **真库 × 真 HTTP**（真 `AppModule`、
    真守卫链、真 `fetch`）**12 条**。前两半都够不着这一格：离线 HTTP 用例把世界**钉死**在无库
    （所以"一半真库、一半 501"的装配在它们眼里完全正常），真库用例只验适配器**不发请求**。
    它钉住的正是此前只有"预期"的那句话：有库时最终状态码是 **401 `SESSION_NOT_FOUND` / 403 `MEMBER_NOT_FOUND` /
    403 `MEMBER_REMOVED` / 403 `FORBIDDEN` / 400（管道）/ 501 `APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`**。
    另有一条世界口径：**空 `DATABASE_URL` ⇒ 真 `AppModule` 起不来**（`PrismaService` 构造即抛错）——
    "无库装配"只存在于子模块/用例里，生产不会静默落进 501 世界。
    > ⚠️ **W3-A（2026-10-18）之后，最后那个 501 已不成立**：有库时合法请求会**真的落库**
    > （`202 / 200 / 201`），并同事务写流水 / 余额 / 审计。上面这一段是 **W2-D 当时**的事实，留档不改写；
    > W3-B 起跨孩子的审批 id 还会得到 `404`（见紧下面的 W3 段）。
    ⑤ 基线（真跑，**不是推断**）：`npm test` ⇒ **14 个用例文件 / 241 条**（`ℹ suites 44`）全绿
    （W2-C 时 11 / 211）；`npm run test:db` ⇒ **3 个文件 / 40 条**（`ℹ suites 20`）全绿（W2-D 首跑时 2 / 28）；
    真库 × 真 HTTP 的探针 `tools/_scratch/w2d-live-probe.mjs` ⇒ **12/12**（`PROBE_EXIT=0`，夹具自清、残留计数 0）；
    `npm run ci` ⇒ **`CI_EXIT=0`（15 步）**、`npm run ci:db` ⇒ **`CIDB_EXIT=0`**（上一轮；本轮只复跑 `test:db`，理由见文末基线块）。
    ⑥ **证伪**（`tools/_scratch/w2d-canfail.mjs`，临时物不入库）：共 **12 条**（离线 ①–⑧ ＋ 真库 ⑨–⑫）。
    ①–⑩ 上一轮 **ALL PASS**；**本轮新增 ⑪⑫ 并各自单跑**（`KP_CANFAIL_ONLY=⑪/⑫ … --db`）⇒ **ALL PASS**
    （退出码=1、点名到位、`sha256` 复原）：⑪ 只转发**半个世界**（屏障一硬接 501）⇒ 新用例「MEMBER_NOT_FOUND」红；
    ⑫ 适配器筛掉 `removed` ⇒ 新用例「MEMBER_REMOVED」红（同一个病在 HTTP 层也被抓到，不只是适配器层）。
    ①–⑩ 的落点：两条装配分叉接反 ⇒ 离线组红（点名"绑定跟着 options 走"）；`ApprovalsModule` 忽略传参 ⇒ "转发没生效"红；
    只转发一个子模块 ⇒ "无库：屏障一端口不是 501"红；复合键**值**写错（`childId: deviceId`）⇒ 替身收到的
    `where` 不匹配 ⇒ 红；读时筛掉过期行 ⇒ "适配器改写了会话行"红；筛掉 `removed` ⇒ "适配器改写了成员位"红；
    把非法 `restrictions` 洗成 `{}` ⇒ "过滤成了 {}"红；**真库**侧：单键退化（`where: { deviceId }`）⇒
    跨孩子串行 ⇒ "childId 被当成过滤器了"红、筛掉 `removed` ⇒ "读成了 null"红。
    **仍未落地（W2-D 当时的状态；① 已由 W3-A 结清，见紧下面那一段）**：
    ① ~~**`ApprovalsPort` 仍是 501**（**有库、无库都是**）—— 落库 / 同事务写账本 / 审计写入属下一段~~
    → ✅ **W3-A（2026-10-18）已结清**：有库 ⇒ `PrismaApprovalsRepository`（同一事务写四张表）；
    无库 ⇒ 仍显式 501。② **设备凭据仍不可验证**（`x-kp-device-id` 可伪造 ⇒
    `NODE_ENV=production` 一律 **503**；解药是 L2 之后的会话 token）；③ **会话刷新 / PIN 切换 /
    锁 15 分钟 / 切换写审计**（`02` §7 那四行）**一行都没做** —— W2-D 交付的是**读路径**；
    ④ `idempotencyKey` 的重放保护仍**未接线**到 HTTP。


**W3-A 进展（2026-10-18）：审批执行路径接真库 —— 批准 / 自批在同一事务写账本与余额**

    ① 装配：`ApprovalsModule.register({ hasDatabase })` 在**有库**时把 `APPROVALS_REPOSITORY`
    绑到 `PrismaApprovalsRepository`（无库仍是 `NotImplementedApprovalsRepository` 的显式 501）。
    service / controller **一行都没改** —— 这正是端口存在的意义（判世界与做写入互不污染）。
    ② 事务顺序（每一步都有理由，见 `approvals.prisma.repository.ts` 文件头）：
    `SELECT … FOR UPDATE` 锁审批行 → 状态守卫 ＋ TTL 惰性过期 → 锁 `Child` 余额行 →
    **只在 `ledger.gate` 判定**（`buildRecordDraft()` 生成草稿）→ 余额 CAS → 写 `PointRecord`
    （`idempotencyKey = approval:<id>`）→ 条件更新请求终态（`WHERE status='pending'`）→ 写 `AuditLog`。
    ③ ★ **`invalidated` / `expired` 一律“先提交、再返回”**，绝不在事务里抛 409：
    在事务里抛会让刚写下的终态回滚 ⇒ 客户端重试永远看到 `pending`（死循环）。
    HTTP 的 409 由 `ApprovalsService.assertTerminalWithoutExecution()` 翻 —— 它只看状态。
    ④ payload 在**建请求时**快照 `{ wishId, titleSnapshot, costSnapshot }`（`02` §4.3）：
    家长 3 小时后同意时，扣分必须等于孩子申请时看到的价格，而不是现价。
    ⑤ 用例：离线 `test/approvals-wiring.test.ts` 钉装配；真库 `test-db/approvals-execution-db.dbtest.ts`
    组 A–C 钉「四张表同一事务」「双击只扣一次」「余额不足 / 心愿被删 → invalidated 且零流水」
    「Σ流水 == 余额 ＋ 链完整」。
    ⑥ **W3-A 留下的一个真实缺陷（已由 W3-B 修，留档防复发）**：`decide` 只按 `id` 读/写，
    **没有把 `childId` 当键**。屏障一只验「你对请求头里的孩子是不是成员」⇒ 一位 guardian
    只要拿到别家审批 id，就能批准并扣那一家的分。离线替身**证明不了**这一点（替身按 id 返回）。
    ⑦ 基线（真跑）：`npm test` ⇒ **14 个文件 / 254 条**（`ℹ suites 45`）全绿；
    `npm run test:db` ⇒ **4 个文件 / 62 条**（`ℹ suites 24`）全绿；`npm run ci` ⇒ **`CI_EXIT=0`（15 步）**。

    **W3-B 进展（2026-10-18）：第 5 个终态可达 ＋ 审批读写按孩子收口**

    ① **租户隔离（修 ⑥ 那个缺陷）**：`findById` / `decide` / `withdraw` 的 `childId` 是
    **查询条件**（`WHERE id = ? AND childId = ?`），不是读出来再比较；TTL 的
    `updateMany` 也带 `childId`（否则跨孩子请求会把别家的 `pending` 提前置过期）。
    跨孩子的 id 与「不存在」返回**同一个 404 `APPROVAL_NOT_FOUND`** —— 403/404 的差别
    本身就在泄露「另一家存在这条审批」。
    ② **撤回**：新增 `POST /approvals/:id/withdraw`，第 5 个终态 `withdrawn` 可达。
    判定只有一处：`approval-policy.ts` 的 `withdrawDenial()`（角色 → 是否本人 → 是否 `pending`），
    service 与 Prisma 适配器**消费同一份**。语义：只有申请人本人（另一位家长 → `403 NOT_REQUESTER`，
    不同意请用 `decide(rejected)`）；已终态 → `409 ALREADY_DECIDED`；TTL 已过 →
    `409 APPROVAL_EXPIRED`；**不写流水、不动余额、不改心愿**；`decidedByUserId` / `decidedAt`
    保持 `null`；审计 `approval.withdrawn`。并发上与批准同一个 `FOR UPDATE` ＋ 条件 UPDATE，
    两边只有一个赢家。
    ③ 用例：离线 `approvals-http` 组 D（跨孩子 decide → 404，且**不调用** decide）＋
    组 F（撤回 8 条：本人 / 非本人 / 孩子本人 / 批准后 / 重复 / 不存在 / 跨孩子 / viewer）；
    真库 `approvals-execution-db` 组 D（撤回零账本 ＋ 审计；重复撤回审计仍 1 条；
    TTL 过期留历史；**第二家的 guardian 拿 child1 的 id 去 decide / withdraw ⇒ 404，
    child1 的行与账、child2 的账都不变**；本家 guardian 仍能处理作对照）。
    ④ 仍未落地（**已被紧下面的 W3-C 结清，留档**）：执行器只覆盖 `redeem`；
    `expired` 只有惰性判定、没有后台扫描任务；`idempotencyKey` 的重放保护未接线到 HTTP；
    设备凭据仍不可验证（生产 503）；会话刷新 / PIN 切换 / 锁 15 分钟未做。
    ⑤ 基线同 W3-A 的 ⑦（本轮真跑）：**254 / 62 / `CI_EXIT=0`**。


**W3-C 进展（2026-10-18）：W3 收尾 —— 执行器 / autoReason / 后台过期 / 幂等键**

    ① **执行器从 1 个扩到 4 个**：`redeem` / `request_redeem`（同一执行路径）/
    `request_points_bonus`（`+amount`，`adjust/approval` 流水）/ `add_wish`（创建 Wish，
    不产生流水，`executedRecordId=null`）。未支持动作仍在**建请求时** 400
    `APPROVAL_ACTION_NOT_EXECUTABLE`，不落永远批不动的 pending。
    ② **`autoReason` 五种全部可复现**：`WISH_DELETED` / `INSUFFICIENT_POINTS`（兑换）；
    `RULE_DELETED` / `HABIT_GONE`（加分申请的 ruleId/habitId 在批准前被软删）；
    `MEMBER_REMOVED`（执行前查申请人 `ChildMember.status`，非 active ⇒ invalidated）。
    ③ **`expired` 后台扫描**：`ApprovalsExpiryService` 在 `main.ts` 启动，
    `ApprovalsPort.expireDue()` 用 `FOR UPDATE SKIP LOCKED` ＋ 条件 UPDATE 批量置过期；
    审计与状态同一事务，重复扫描不重复计数。惰性过期保留为兜底。
    ④ **`Idempotency-Key` 接 HTTP**：create / decide / withdraw 三个写端点。
    同键同请求 → 返回首次响应、业务只执行一次；同键不同请求 → `409 IDEMPOTENCY_KEY_REUSED`；
    上次未写完 → `409 IDEMPOTENCY_IN_PROGRESS`；无库带 key → `501 IDEMPOTENCY_NOT_IMPLEMENTED`。
    ★ 响应缓存不在业务事务内；业务本身已由 `PointRecord.idempotencyKey=approval:<id>`
    ＋ 行锁 ＋ 条件 UPDATE 保证只执行一次。
    ⑤ 用例：离线 `approvals-http` 组 H（create/decide 重放、同键不同请求、非法 key）；
    真库新增 `approvals-closing-db.dbtest.ts`（6 组：加分执行 / 三种 autoReason /
    add_wish / request_redeem / expireDue / 幂等键 / I2）。
    ⑥ 真跑基线（2026-10-18）：`npm test` → **14 文件 / 261 条**；
    `npm run test:db` → **5 文件 / 75 条**；`npm run ci` → **`CI_EXIT=0`（15 步）**。
    ⑦ 仍不粉饰：设备凭据仍不可验证（生产 503）；会话刷新 / PIN 切换未做；
    规则 / 习惯 / 心愿 / 邀请等**其它业务模块端点**仍未建（不在 W3 范围）；
    加分的「每天 3 条 / 同因去重」仍属 §6 dispatcher（单笔 ≤50 已落实）。
    交接单：[`12-w3c-handoff.md`](./12-w3c-handoff.md)。


**W4-A 进展（2026-10-18）：只读后端 `GET /home` / `GET /records` —— 双端可以不只靠种子了**

    ① **两个只读端点**（`ReadController`，与 `/approvals` 同一 Guard 顺序
    `DeviceSessionGuard → MembershipGuard → PermissionsGuard`）：
    `GET /home` 消费矩阵 `view_child_points`，`GET /records` 消费 `view_records`（两角色均 ALLOW）。
    `childId` **只来自 `req.kpChildId`**（会话）。`/records` 的查询 DTO 只白名单
    `category` / `limit`，传 `childId` 等未知键一律 `400`；`/home` 不接受查询参数，传了也不采信。
    ② **端口 + 适配器**：`ReadPort` / `PrismaReadRepository`；无库装配绑
    `NotImplementedReadRepository`（`loadHome` / `listRecords` 都 501，**绝不返回空快照**）。
    `ReadModule.register()` 沿用 `LedgerModule` 的做法：有库才 import `PrismaModule`。
    ③ **口径（容易读错的三条）**：
    · `goodHabitCount` = 表扬流水中 `source != correction` 且 `reversedBy: none` —— 冲正后要**回落**；
    · `rewardCount` = `Wish.redeemed: true` 的条数（A5：手动加分不算兑换）；软删的已兑换心愿
      仍计入累计，但不进首页 `wishes` 列表；
    · 规则 `points` 在库里恒为正，mapper 按 `direction == penalty` 输出**负分**（A1）。
    ④ **`/records`**：`orderBy (createdAt desc, id desc)`；`limit` 默认 50、范围 1–200；
    适配器 `take = limit + 1` 判 `hasMore`；`category` 只接受 `praise / exchange / adjust`。
    **孩子不存在或已软删时两个端点都 404 `CHILD_NOT_FOUND`**（`listRecords` 先查 `Child` 行，
    不返回「还没有任何记录」的空页）。
    ⑤ **三层证据**（缺一层就有假绿）：
    · `backend/test/read-http.test.ts` —— 真 HTTP、假端口：屏障/拒绝/入参封闭/映射；
    · `backend/test/read-wiring.test.ts` —— 真装配、假 Prisma：`where` / `take` / `orderBy` 到底交了什么；
    · `backend/test-db/read-db.dbtest.ts` —— 真库 + 真 `AppModule` + 真 `fetch`：软删、冲正、
      跨孩子、分页都以最终 JSON 为准。
    ⑥ **真库抓到离线用例抓不到的 bug（值得记住）**：`/records` 起初只按 `childId` 查流水，
    对一个 `status=deleted` 的孩子返回 **200 + 空数组**，而 `/home` 对同一孩子返回 404 ——
    两个端点互相矛盾。修法是把「孩子仍 active」的检查放进 `listRecords`（端口返回 `null`），
    service 统一翻成 404；并在装配用例里加了一条「找不到孩子就**不查**流水」的反回退断言。
    ⑦ 真跑基线（2026-10-18）：`npm test` → **16 文件 / 286 条**；
    `npm run test:db` → **6 文件 / 91 条**；`npm run ci` → **`CI_EXIT=0`（15 步）**；`npm run build` → 0。
    本阶段**没有新增迁移**（读的字段 W0 schema 已有）。
    ⑧ 仍不粉饰：规则 / 习惯 / 心愿 / 邀请的**写端点未建**；双端 `AppStore` 仍用内存种子
    （W4-B 起才逐个替换）；设备凭据仍不可验证（生产 503）。
    交接单：[`13-w4a-handoff.md`](./13-w4a-handoff.md)。


**W4-B 进展（2026-10-19）：记录页键集分页 + Flutter 只读接入**

    ① **`GET /records` 真的能翻页了**：入参加 `cursor`，响应加 `nextCursor`；
    游标是 `base64url("<ISO-8601>|<id>")`，客户端**原样回传**，服务端严格解码。
    非法游标一律 `400 INVALID_RECORD_CURSOR`，**绝不静默退回第一页**。
    ② **键集而非 offset**：排序仍 `(createdAt desc, id desc)`，下一页谓词是
    `createdAt < c OR (createdAt = c AND id < c.id)`；`nextCursor` 取自**本页最后一行**
    （不是 `limit + 1` 多取的探针行），因此两页不重不漏。
    ③ **Flutter 读层**：`read_api.dart`（两个 GET、身份头、游标透传）、
    `read_dto.dart`（严格解析，`hasMore ⇔ nextCursor` 双端自洽）、`read_mapper.dart`
    （服务端字段 → 现有 UI 模型）。`AppStore.loadMoreRecords()` 追加并按 `id` 去重；
    加载更多失败保留已加载页，重试用同一游标。
    ④ **UI 三态不粉饰**：live 模式顶部 `ReadStatusBanner` 区分「首次读取 / 失败（空数据）/
    失败（有旧数据）/ 只读成功」；记录页首屏 spinner、页尾「加载更多 / 重试 / 没有更多了」，
    短列表也可下拉刷新（`AlwaysScrollableScrollPhysics`）。
    ⑤ **只读拦截**：live 模式下打卡、撤销、记一笔、兑换、新增心愿、改名、回收站、
    新建/编辑规则、恢复演示数据全部先提示只读，不修改本地状态。
    ⑥ **一个真实坑**：首屏刷新不能写在 `didChangeDependencies` 的同步路径里 ——
    `refreshFromServer()` 会同步 `notifyListeners()`，触发 `markNeedsBuild during build`；
    改为 `addPostFrameCallback` ＋ `_loadStarted` 只触发一次。
    ⑦ 真跑基线（2026-10-19）：`npm run ci` → **`CI_EXIT=0`（15 步）**；
    `npm test` → **17 文件 / 302 条**；`flutter analyze` → **0 issue**；
    `flutter test` → **50 条**（`test/read_api_test.dart` 9 条）。本阶段**没有新增迁移**。
    ⑧ 仍不粉饰：写端点未建（live 只读）；小程序端尚未消费游标；`test:db` 本轮未复跑。
    交接单：[`14-w4b-handoff.md`](./14-w4b-handoff.md)。


**W4-C 进展（2026-10-19）：小程序只读接入（`GET /home` / `GET /records`）**

    ① **配置闸门**：`config/index.ts` 用 Taro `env` 白名单注入
    `TARO_APP_KP_API_BASE_URL` / `TARO_APP_KP_DEVICE_ID` / `TARO_APP_KP_CHILD_ID`；
    三项缺一即继续用本地预览（不抛错、不白屏），非 `http(s)` 的 baseUrl 直接被拒绝。
    值在编译期注入，改 `.env.local` 后必须重新 `build:weapp`；`.env.local` 不入库。
    ② **只读层与 Flutter 同构**：`read_api.ts`（两个 GET ＋ 两个身份头 ＋ 游标原样回传）、
    `read_dto.ts`（严格解析，不做 `?? 0` / `?? ''` 兜底，`hasMore ⇔ nextCursor` 自洽）、
    `read_mapper.ts`、`read_api_errors.ts`；`store.ts` 增加 `refreshFromServer()` /
    `loadMoreRecords()` / `setRecordFilter()` / `ensureInitialRead()`，`readEpoch` 丢弃过期响应。
    ③ **记录页口径**：live 模式只渲染 `visibleRecords`，**不做本地二次过滤**
    （服务端已按 `category` 过滤，再过滤会漏掉后续页）；切分类清空列表并从第一页重取，
    不复用旧游标；页尾「加载更多 / 重试 / 没有更多了」，失败保留已加载页。
    ④ **一个双端同款竞态（本轮修复）**：首屏尚未成功（`usingPreview === true`）时切分类，
    若只重取 records，在途的 `/home` 仍会按旧分类生成列表并在晚到时覆盖新分类。
    现在该分支改为整页 `refreshFromServer()`；Taro 与 Flutter 同步修，并各有一条回归用例。
    ⑤ **UI 不粉饰**：`ReadStatusBanner` 四态（首次读取 / 失败且无数据 / 失败但有旧数据 / 只读成功）；
    首页接入 `usePullDownRefresh` ＋ `enablePullDownRefresh`，记录页列表使用 `ScrollView` refresher；
    live 模式打卡、撤销、记一笔、兑换、心愿增删、改名、回收站、规则新建/编辑、恢复演示数据
    全部先提示只读，不调用写方法。
    ⑥ 真跑基线（2026-10-19）：`tsc --noEmit` → **0**；`npm run build:weapp` → **0**；
    `.tmp_test/run.js` → **37/37 ALL PASS**；`flutter analyze` → **0 issue**；
    `flutter test` → **51 条**（`test/read_api_test.dart` 10 条）。本阶段未改后端、无新增迁移。
    ⑦ 仍不粉饰：写端点未建（live 只读）；未做真机/真后端联调（只验证构建与离线用例）；
    记录页不做自动加载下一页；后端 `test:db` 本轮未复跑。
    交接单：[`15-w4c-handoff.md`](./15-w4c-handoff.md)。


**W4-D 进展（2026-10-19）：打卡 / 撤销写入（`POST /records/check-in` / `:id/reverse`）**

    ① **两条真写入口**：`check_in_habit`（guardian / child）与 `undo_check_in`
    （guardian ALLOW / child DENY）；`childId` 只来自会话头，DTO 只有 `habitId`
    或可选 `note`，多传 `childId` / `points` 等未知键一律 400。
    ② **单事务 8 步**：锁孩子余额行 → 读库钟求业务日 → 验 habit（跨孩子/已删除 404）
    → 验规则版本（active、currentVersion、direction=reward、分值与 habit 一致）
    → 数「本业务日仍有效的打卡」→ 内核构造草稿 → `appendDraftInTx()` → 同事务审计。
    任一步失败全回滚；不会留下「分加了但审计没有」的中间态。
    ③ **共用写入内核**：`ledger.append.ts` 统一做行锁、库钟、严格递增 `createdAt`
    与余额 CAS；`PrismaLedgerRepository.append()` 也改为复用，避免第二份实现。
    ④ **业务日**：默认 `Asia/Shanghai`，`KP_TIMEZONE` 可覆盖；库里 `clock_timestamp()`
    决定 `[start,end)`，边界左闭右开；被冲正的原记录**不占名额**，撤销后可以再打一次。
    ⑤ **撤销 append-only**：新写 `category=adjust`、`source=correction`、
    `reversesRecordId=原id` 的负数行，原行一字未改（I5）；业务幂等键 `undo:<id>`
    ＋ 库层唯一约束防并发双冲；第二次撤销 409 `ALREADY_REVERSED` / `RECORD_ALREADY_REVERSED`。
    ⑥ **幂等语义**：无 key 双击 = 两笔（产品语义）；同 key 同体返回首次响应；
    同 key 不同体 409 `IDEMPOTENCY_KEY_REUSED`；业务 409 不缓存，修正后可重试。
    ⑦ **真库抓到的三个坑**：`timestamptz` 直接写 naive 列会整体 +8h（必须 `AT TIME ZONE 'UTC'`）；
    seed 里提前插入「明天 00:00」会让后续打卡全被严格递增推到明天（边界行必须最后插）；
    规则习惯的快照来自**版本行**而非 habit 标题（I4 对账）。
    ⑧ **一并修闸门**：W4-C 的 `async main()` 触发 D12 守卫（汇总嵌套），已拆出
    `.tmp_test/run-w4c.mjs` 由 `run.js` 同步等待；E18 守卫放宽为「构造函数任意参数」，
    仍守「构造即空态」。
    ⑨ 真跑基线（2026-10-19）：`npm run ci` → **0**；`npm test` → **21 文件 / 353 条**；
    `npm run test:db` → **7 文件 / 109 条**；小程序 `tsc --noEmit` → **0**；
    `.tmp_test/run.js` → **37/37**；`flutter analyze` → **0 issue**；`flutter test` → **51/51**。
    无新增迁移。
    ⑩ 仍不粉饰：前端 live 写入口仍拦（W5）；习惯 CRUD / 心愿 / 规则 / 邀请未建；
    未做并发压测与真机联调。
    交接单：[`16-w4d-handoff.md`](./16-w4d-handoff.md)。


**W4-E 进展（2026-10-19）：双端 live 打卡 / 撤销写入口**

    ① **只放开两条**：首页打卡 `POST /records/check-in`、长按撤销
    `POST /records/:id/reverse`；记一笔 / 心愿 / 规则 / 档案仍走只读拦截。
    ② **独立写传输层**：新增 `WriteTransport` / `TaroWriteTransport`，只读
    `ReadTransport` 一行未改；写路径不自动重试，重试语义交给幂等键。
    ③ **live 无写客户端必须拒绝**：`isCheckInReadOnly = isLiveMode && writeApi == null`，
    绝不退回本地假写；预览模式仍走原本地 `checkIn()`。
    ④ **先落地、再刷新**：解析 201 `{record, executedRecordId}` → 映射进列表并取
    `balanceAfter` → `refreshFromServer()` 校正；读失败不会被误报成写失败。
    ⑤ **契约强校验**：`executedRecordId` 必须等于 `record.id`（撤销时是冲正记录）；
    读取层解析错误统一归一成 `WriteApiException.malformed`。
    ⑥ **业务码优先**：409 区分每日上限 / 积分不足 / 重复撤销 / 非打卡记录；
    404 区分习惯与流水，不再冒充「孩子档案不存在」；重试只对网络 / 超时 / 5xx 为真。
    ⑦ **双击串行**：`writeInFlight` 拦住第二次点击；每次用户动作生成一个幂等键，
    自动重试不会变两笔，但无 key 的两次点击语义仍由后端决定。
    ⑧ **撤销目标兜底**：当前记录页可能被分类过滤，找不到时单独取一页**不分类**
    的流水（200 条）定位 —— 冲正记录是 `adjust`，只看 `praise` 会误判为未冲正。
    ⑨ 真跑基线（2026-10-19）：`flutter analyze` → **0 issue**；`flutter test` → **65/65**；
    小程序 `tsc --noEmit` → **0**；`.tmp_test/run.js` → **48/48**（W4-E 11 条）；
    `backend npm run ci` → **0**（含 353 条测试与全部闸门）。无新增迁移。
    ⑩ 仍不粉饰：习惯 CRUD / 心愿 / 规则 / 邀请 / 记一笔仍未接后端；
    未做真机联调与高并发压测。
    交接单：[`17-w4e-handoff.md`](./17-w4e-handoff.md)。


**W5-A 进展（2026-10-20）：规则写端点 + 双端接线**

    ① **四条路由**：`POST /point-rules`、`PATCH /point-rules/:id`、
    `DELETE /point-rules/:id`、`POST /point-rules/:id/habits`，挂在 `/point-rules` 下 ——
    「加入习惯」是规则的派生动作，`ruleId` 在路径里，不可能漏传。
    ② **三道屏障 + 幂等**：设备会话 → 成员 → 权限；孩子一律 403；
    四个入口都接 `Idempotency-Key`，双击保存 / 删除不会多出版本行或审计。
    ③ **乐观锁**：`PATCH` 必须带 `expectedVersion`（= 界面上看到的版本），不一致 409
    `RULE_VERSION_CONFLICT`；客户端保留原内容并提示刷新，**不静默覆盖**别人刚改的规则。
    ④ **DELETE 无 body**：不声明 `Content-Type`（空 JSON 会被严格后端拒）；
    回包 `{ruleId}` 必须等于被删的那条，否则按 `malformed` 显式失败。
    ⑤ **分值带符号**：客户端原样发 `points`（负 = 扣分），服务端落库拆成正数 + `direction`；
    任一端再取反一次，扣分就会静默变加分。
    ⑥ **同一套映射**：`mapRule` / `mapHabit` 从 `mapHome` 抽出，GET 与写回包共用；
    映射异常统一归一成 `WriteApiException.malformed`，页面只处理一种错误。
    ⑦ **先落地再刷新**：写成功先把回包落进列表再 `refreshFromServer()`；
    删除额外**先**把本地镜像标 `deleted`，刷新失败也不会留下「删过却还在列表里」。
    ⑧ **live 缺写客户端必须拒绝**：`isRuleWriteReadOnly` 时四个入口只提示、不改内存。
    ⑨ 真跑基线（2026-10-20）：`backend npm test` → **382/382**；`npm run test:db` → **127/127**；
    `npm run ci` → **0**；小程序 `tsc --noEmit` → **0**；`.tmp_test/run.js` → **60/60**（W5-A 12 条）；
    `flutter analyze` → **0 issue**；`flutter test` → **75/75**。无新增迁移。
    ⑩ 仍不粉饰：习惯 CRUD / 心愿 / 档案 / 邀请 / 记一笔仍未接后端；未做真机联调与压测。
    交接单：[`18-w5a-handoff.md`](./18-w5a-handoff.md)。


**W5-B 进展（2026-10-20）：记一笔写端点 + 双端接线**

    ① **一条路由**：`POST /records/adjust`（`201`），名字沿用 `01` §3 / `02` §6 的动作名
    `adjust_points` 与 `/records` + 动作的既有形状，不另造 `/points/adjust`。
    ② **三道屏障 + 幂等**：设备会话 → 成员 → 权限矩阵；`adjust_points` 对孩子 DENY（403），
    孩子要加分必须走 `request_points_bonus` 审批；带 `Idempotency-Key` 重放只执行一次。
    ③ **余额由服务端锁内决定**：客户端**不**用本地 `points` 预判够不够扣，
    不足则 409 `INSUFFICIENT_POINTS` → 两端统一文案「这次操作会把余额扣成负数，没有保存」。
    ④ **请求体集合封闭**：`childId` 来自会话、`source` 由角色派生、`balanceAfter` 由账本算，
    客户端多传任一字段都是 400 —— 不许客户端决定「给谁加分」或「加完剩多少」。
    ⑤ **0 分三层拒**：`PointsStepper(min: 1)` / 两端 `submitQuickNote()` / 服务端 `@NotEquals(0)`。
    ⑥ **live 不预置本地流水**：`id` 与 `balanceAfter` 只认回包，先落地再 `refreshFromServer()`，
    否则刷新后会出现两条同内容流水（一条本地 id、一条服务端 id）。
    ⑦ **弹层 `saving` 态**：按钮变「保存中…」，失败不关弹层（家长可改数字重试）；
    并发第二击由 store 的 `writeInFlight` 拦住，返回「上一次操作正在保存中」。
    ⑧ 真跑基线（2026-10-20）：`backend npm test` → **404/404**；`npm run test:db` → **136/136**；
    `npm run ci` → **0**；小程序 `tsc --noEmit` → **0**；`.tmp_test/run.js` → **72/72**（W5-B 12 条）；
    `flutter analyze` → **0 issue**；`flutter test` → **83/83**。无新增迁移。
    ⑨ 仍不粉饰：心愿兑换 / 习惯 CRUD / 档案 / 邀请仍未接后端；孩子端没有「申请加分」入口；
    未做真机联调与压测。
    交接单：[`19-w5b-handoff.md`](./19-w5b-handoff.md)。


**W5-C 进展（2026-10-20）：心愿兑换走审批 + 双端接线**

    ① **没有新路由**：`redeem` 在矩阵里对两个角色都是 `REQUIRE_APPROVAL` ⇒ 唯一正确入口是
    `POST /approvals`（`action='redeem'`，`targetId=wishId`）。客户端不另造 `/wishes/:id/redeem`，
    也不替服务端判断"我能不能直接扣"。
    ② **请求体最小**：只发 `action + targetId`。`costSnapshot` 由服务端按当时的 `Wish.cost` 快照
    （申请时的价格，不是批准时的）；`autoApprove` 不发 —— 孩子发它是 400 `SELF_APPROVAL_NOT_ALLOWED`，
    家长也不该被这个界面代勾（9.27 的二次确认是有意的防误触）。
    ③ **`pending` 不是成功**：`submitRedeemWish()` 只在 `approved` 返回 `null`；
    `pending` 返回「已提交给家长确认：批准后才会扣 N 分…」，`rejected` / `withdrawn` /
    `invalidated`（带 `autoReason` 的具体原因）/ **未知状态**（不猜，让人刷新）各有文案。
    ④ **`approved` 只刷快照**：不本地减分 —— `balanceAfter` 由服务端锁内算，客户端余额可能已过期。
    ⑤ **`status` 保持字符串**：服务端将来加状态时降级成"未知，请刷新"，而不是解析崩溃。
    ⑥ **409 `WISH_ALREADY_REDEEMED` 说「没有提交」**：此时服务端没建审批行，
    写"提交失败"会让人去审批页找一条不存在的申请。
    ⑦ **本地心愿只用于拼文案**：列表里找不到该 id 也照样发请求（列表可能已过期），
    有没有、能不能兑换由服务端回答（404 / 409）。
    ⑧ **点「兑换」先弹确认，取消就一次请求都不发**：文案由 `redeemConfirmText()` 给 ——
    live 说「提交给家长确认 / 批准后才会扣 N 分 / 现在还没有扣」（按钮写**提交申请**），
    预览说「立即扣除」（按钮写**确认兑换**）。同一个「确定」按钮会让用户按下去才知道是申请还是扣分。
    顺手修掉一个真缺陷：心愿页原来用 `isReadOnly`（＝ `isLiveMode`）做兑换拦截，
    **live 模式点兑换只会弹「只读模式」**，审批请求永远发不出去；改用 `isWishWriteReadOnly`，
    并补一条 widget 用例从界面点下去钉住（取消 0 次请求 / 确认 1 次 `POST /approvals`）。
    ⑨ 真跑基线（2026-10-20）：`backend npm test` → **434/434**；`npm run test:db` → **137/137**
    （`approvals-db` 新增 1 条 409）；小程序 `tsc --noEmit` → **0**；`.tmp_test/run.js` →
    **91/91**（W5-C 19 条）；`flutter analyze` → **0 issue**；`flutter test` → **105/105**。无新增迁移。
    ⑩ 仍不粉饰：**家长审批页双端都没有**（`pending` 只能靠后端 `decide` 或手动刷新推进）；
    `redeem` vs `request_redeem`（guardian=ALLOW）的动作选择仍待产品口径（确认弹层已就位，
    改口径时只需换文案与动作）；`pending` 之后没有撤销入口；
    首页「记一笔」/ 我的页仍用旧口径 `isReadOnly` 挡（`adjust_points` 是 guardian ALLOW /
    child DENY，孩子被挡住是"歪打正着"，但文案说的是「还没接后端」——待换成真话）；
    习惯 CRUD / 档案 / 邀请未接后端；未做真机联调与压测。
    交接单：[`20-w5c-handoff.md`](./20-w5c-handoff.md)。


**W5-E 进展（2026-10-21）：档案改名 `PATCH /child` + 双端「我的」页真写**

    ① **一条路由、一个字段**：`PATCH /child`（单数、路径无 id），body 只有 `name`。
    孩子身份只来自会话（`x-kp-device-id` + `x-kp-child-id`）；body 里出现 `childId` / `points`
    一律 400 —— 客户端不许指定「改谁」，也不许顺手改积分。
    ② **不加 `Idempotency-Key`，因为 PATCH 由构造幂等**：同名改名在**锁内**短路，
    回 200 但不写 UPDATE、不写 `child.rename` 审计。重试不会产生第二份副作用，
    也不会在审计里留下两条一模一样的「A→A」。
    ③ **单事务 + `SELECT … FOR UPDATE`**：先读后写就是 TOCTOU（两位家长同时改，
    第二次的 before 会读到已被覆盖的值，审计变成 `B→C` 而真实轨迹是 `A→B→C`）。
    锁内一次做完：锁行（顺带确认 `status='active'`）→ 比名字 → UPDATE → 写审计快照。
    `P2025 → 404 CHILD_NOT_FOUND`、`P2002 → 409 CHILD_NAME_CONFLICT`，其余 500（不伪装业务拒绝）。
    ④ **16 个字符只有一处判据**：DTO 的 `MaxLength(32)` 是 **UTF-16 粗上限**（16 个 emoji = 32 unit，
    正好不被误伤）；真正的判定在 service 按**码点**（`Array.from(name).length`），
    错误码只有 `CHILD_NAME_EMPTY` / `CHILD_NAME_TOO_LONG`。双端输入框不判长度、更不截断。
    ⑤ **写后不重拉 `/home`**：PATCH 回包 `{ childId, name }` 在锁内产生 ⇒ 权威值；
    再拉一次可能用滞后快照把新名字盖回去。用例钉住「改名后 `fetchHome` 次数不变」。
    （W4-E / W5-B 的「先落地再刷新」不冲突：那两条要的是回包里没有的余额与流水。）
    ⑥ **`isProfileWriteReadOnly` 取代全局 `isReadOnly`**：后者等于「live 模式」，
    拿它挡昵称会让 live 永远点不动 —— 与 W5-C 修 `isWishWriteReadOnly` 同一个病。
    live 但没有写客户端时返回只读文案且**本地档案不动**（没保存就先改＝假成功）。
    ⑦ 顺手修掉两个真缺陷：Flutter 弹窗原来用 `TextEditingController` 并在 `dispose()` 后
    仍被回调引用（保存即崩），改为 `TextFormField(initialValue)`；小程序原来
    `slice(0, 16)` **静默改写用户输入**（输入 20 字「保存成功」，库里是前 16 字），
    现在直接发原值，超长由服务端拒绝并翻成中文。
    ⑧ 状态条与只读文案也改成现在的事实：可写分支由「打卡与撤销会实时保存」改为
    「打卡 / 记一笔 / 兑换 / 昵称均会实时保存」；`readOnlyWriteMessage` 不再说
    「兑换 / 档案还没接后端」（旧事实），改成「写客户端未就绪或尚未接后端」；
    `profileReadOnlyWriteMessage` 同理。前缀 `只读模式：` 保留（用例靠它识别）。
    ⑨ 真跑基线（2026-10-21）：`backend npm test` → **456/456**（26 文件，新增
    `child-http.test.ts` 13 条）；`flutter analyze` → **0 issue**；`flutter test` → **132/132**
    （新增 10 条）；小程序 `tsc --noEmit` → **0**、`build:weapp` → **0**；
    `.tmp_test/run.js` → **91/91**（老用例无回归）、`run-w5e.mjs` → **10/10**、w4c/w4e/w5a/w5b/w5c/w5d
    全部 `ALL PASS`。无新增迁移（`AuditLog.action` 是 `String`）。
    ⑩ ★ **一个假红陷阱**：`npx tsx test/child-http.test.ts` 会 **13 条全 500**
    （`Cannot read properties of undefined (reading 'renameChild')`）—— tsx(esbuild) 不支持
    `emitDecoratorMetadata`，Nest 注入拿不到类型。用例必须走 `npm test`（tsc 先编译）。
    ⑪ 仍不粉饰：只有昵称可改（头像 / 生日 / `childId` 不行，孩子端永远 403）；
    `PrismaChildrenRepository` 的行锁只有端口替身用例，**没有真库并发对照**；
    回收站恢复 / 彻底删除、恢复演示数据仍只读（**W5-F 起前两项已落地，见下**）；小程序 `showModal({editable})` 依赖基础库
    2.17.1 且无降级 UI；改名不通知其它设备；未做真机联调。
    交接单：[`22-w5e-handoff.md`](./22-w5e-handoff.md)。

**W5-F 进展（2026-10-21）：回收站 —— 删除改成软删 + 双端回收站**

    ① **删除只改状态位**（`status='deleted'` + `deletedAt`），主体留在库里：流水通过
    `ruleId` / `wishId` / `habitId` 回指，物理删除会让「这 +1 分按什么规则给的」永久断链。
    `DELETE /habits/:id` 与已有的规则 / 心愿删除同口径，进回收站 90 天可恢复。
    ② **90 天只有一个事实、一份判定**：`GET /trash` 只下发 `deletedAt`，不下发 `expiresAt`
    也不下发 `expired` —— 保留期是纯函数（`isTrashExpired`），双端各一份已测试实现。
    服务端再算一遍就等于两个 90 天常量。配套两条：过期条目**仍然列出**（标红、只允许彻底删除），
    到期**不会自动清理**（到期 ≠ 必须删，物理删除永远是显式动作）。
    ③ **恢复由构造幂等、彻底删除不是**：`status='active'` 时恢复直接回同一 `{kind,id}` 且
    不写第二条审计；彻底删除重复调用得 404（这一项真的不在了，这就是正确答案）。
    所以两条路由都**不加** `Idempotency-Key` —— 加了只会多出「缓存说成功、库里已没有」的中间态。
    ④ **彻底删除两道闸**：`status != 'deleted'` ⇒ 409 `TRASH_ITEM_NOT_DELETED`；
    还有流水指着它 ⇒ 409 `TRASH_ITEM_REFERENCED`（附条数）。后者必须显式 `count` ——
    `ruleId` / `wishId` 根本没有外键，`habitId` 的 `SetNull` 只会静默置空。
    `PointRuleVersion` 是 `onDelete: Restrict`，顺序必须是「审计 → 版本行 → 主体」，
    而且审计要在 `delete()` **之前**写（删完就没有 before 了），`after` 只能写 `Prisma.JsonNull`。
    ⑤ **恢复习惯要先恢复规则**：父规则还在回收站 ⇒ 409 `TRASH_PARENT_RULE_DELETED`。
    否则会恢复出一个「看着能打卡、一点就 `HABIT_RULE_GONE`」的假可用状态。
    ⑥ **孩子能看、不能改**：`view_trash` guardian/child 都 ALLOW，`restore_trash_item` /
    `purge_trash_item` / `delete_habit` 孩子 DENY。「我删掉的卡不见了」是 C9 的原始抱怨，
    看见回收站能消除恐惧；但恢复 / 彻底删除是不可逆的配置变更，仍归监护人。
    ⑦ **读失败绝不清空列表**：空列表在这个界面上等于「已经全部彻底删除」。读失败只置
    `trashError` 并保留旧条目。小程序这里的分支**只看 `readApi !== null`，不看 `usingPreview`**
    —— 后者会被「首页读失败」连带翻成 true，让回收站悄悄退化成本地镜像（看起来正常、实际少条目），
    已由 `run-w5f.mjs` 钉死。
    ⑧ **未知 `kind` 一律响亮失败**：服务端 400 `TRASH_KIND_INVALID`（不是 404：地址拼错了，
    不能回答「已经没了」）；小程序 `mapTrash()` 抛 `malformed`（跳过一行＝暗示被彻底删除）；
    写路径先过白名单，未知名**一个请求都不发**。回包 `{kind,id}` 必须与请求一致，否则 `malformed`。
    ⑨ **批量清理说真话**：`TrashPurgeOutcome { purged, failed, error }` —— 逐条调，
    第 3 条失败时前 2 条已经真删了，只报「失败」会让家长以为一条都没清。
    ⑩ 真跑基线（2026-10-21）：`backend npm test` → **477/477**（27 文件，新增
    `trash-http.test.ts` 16 条 / 3 组）；`npm run build` → 0；`contracts:emit` → **29 个动作**；
    `flutter analyze` → **0 issue**；`flutter test` → **149/149**；小程序 `tsc --noEmit` → **0**、
    `build:weapp` → **0**、`run.js` → **ALL PASS**（含 5 个子 runner）、`run-w5f.mjs` → **19/19**，
    w4c/w4e/w5a/w5b/w5c/w5d/w5e 全部 `ALL PASS`。新增迁移只做一件事：
    `ActionType` 加 4 个枚举值（三张表的 `status` / `deletedAt` 在 W0 就有）。
    ⑪ 仍不粉饰：到期**不自动清理**（没有后台任务）；`lockChildBalance()` 之后的 count→delete
    只有端口替身用例、**没有真库并发对照**；回收站不分页（无上限保护）；孩子端按钮不按角色隐藏
    （客户端先拦 + 服务端 403 兜底）；没有撤销删除（只能去回收站恢复）；跨设备不同步；
    批量清理的二次确认用 `showModal`，老基础库无降级 UI；未做真机联调。
    交接单：[`23-w5f-handoff.md`](./23-w5f-handoff.md)。

**W5-G 进展（2026-10-22）：邀请码 —— 一个家庭怎么把第二个人拉进来**

    ① **`accept` 是全项目唯一一条「只有身份屏障」的路由**：它的被授权人按定义还**不是**成员，
    若也要求成员位，这条路由对真正的被邀请人永远 403。判据换成「持有家长签发的码」——
    屏障一由**码本身**替代（guardian 生成、有次数上限、有有效期、可吊销，且占位是库层面原子的）。
    代价必须说清：**它解决不了「全新设备的第一次加入」**，那需要登录链路（L2 / `code2session`）。
    ② **占位是一条条件 `UPDATE … RETURNING`**（`usedCount < maxUses` / `expiresAt > now()` / `revoked = false`），
    端口上**没有 `findByCode()`** —— `02 §8` 的「不得先查后改」成了结构性保证：想写 TOCTOU 得先改端口签名。
    与 `02 §8` 示例的差异：示例是 snake_case，而 schema 没 `@map`，列名是 camelCase 且必须带引号。
    ③ **占位 / 成员位 / 设备会话 / 审计同一事务**：`ALREADY_MEMBER`、`DEVICE_SESSION_CONFLICT` 等都发生在
    占位成功之后，抛错整笔回滚 ⇒ 用户什么都没得到，就**不许烧掉一次名额**（真库组 D 钉住 `usedCount` 仍为 0）。
    ④ **撞码重试必须每次开新事务**：PostgreSQL 事务一报错就 aborted，同事务里重试是假的
    （第二次只会收到 `current transaction is aborted`）。重试 5 次仍撞 ⇒ 409 `INVITE_CODE_GENERATION_FAILED`。
    ⑤ **四种不可用对客户端是同一句话**（不存在 / 用完 / 过期 / 吊销 ⇒ 409 `INVITE_CODE_UNAVAILABLE`）：
    区分它们只会把 `accept` 变成「哪些码存在」的探测器，而用户能做的动作完全一样。
    ⑥ **形状错是 400，不可用是 409**：7 位、含 `O` 这类是**输入**问题，说「码已失效」会让人去找家长重发；
    规范化只做无歧义转换（去空白/连字符、转大写），**不猜 `O→0`**（字母表里本来就没有 `O`）。
    ⑦ **`ALREADY_MEMBER` 不烧名额、不改角色**：角色只能由家长在成员管理里改，否则一张 `guardian` 码
    就是自助升级凭证。并发下 `@@unique(childId,userId)` 是最终裁判（`P2002` ⇒ 409 而非 500）。
    ⑧ **曾被移出的人用新码回来复用同一行**（`status='active'`、`joinedAt` 更新、`role` 以新码为准，id 不变）；
    这台设备上已有**别人**的会话 ⇒ 409 `DEVICE_SESSION_CONFLICT`，**不静默覆盖**（共享平板在家里很常见）。
    ⑨ **审计里不写码**，只记 `inviteCodeId`：码是凭据，写进审计等于复制到一个读取面更宽的表。
    四条路由都**不加** `Idempotency-Key`：create 本来就该每次生成新码、revoke 构造幂等、accept 的次数上限即判据。
    ⑩ **会话 TTL 30 天，不是 `02 §7` 的 5 分钟**（已知偏差）：5 分钟的前提是 PIN 校验切换角色，而那条写路径
    至今没有端点 —— 照发 5 分钟会让刚加入的共同监护人悄悄掉回 child 且**无法提回**。回包如实给 `sessionExpiresAt`。
    另：`viewer` **不是**可邀请角色（矩阵里没有列 ⇒ 加入后什么都做不了）；`GET /invites` 也要 `invite_member`
    （列表回的是**码本身**，看得见就能加入，所以不该有 `view_invites`）。
    ⑪ 真跑基线（2026-10-22）：`backend npm test` → **519/519**（29 文件，新增 `invite-code.test.ts` 15 条 +
    `invites-http.test.ts` 27 条）；`npm run test:db` → **155/155**（10 文件，新增 `invites-db.dbtest.ts`
    18 条 / 7 组，含 **10 并发 vs `maxUses=3` ⇒ 恰好 3 成功 + 7×409、`usedCount` 恒为 3**）；`typecheck` /
    `typecheck:tests` / `build` → 0；`contracts:emit` → **29 个动作（无变化）**；**新增迁移 0 条**。
    演示脚本 `npm run seed:demo` 连跑两次幂等，真 HTTP 冒烟 `GET /invites` 200 → accept 200 →
    再 accept 409 `ALREADY_MEMBER` → `usedCount=1`。
    ⑫ 仍不粉饰：双端**没有邀请码 UI**（四个端点只有 curl 能用）；没有成员管理端点（改角色 / 移出）——
    **此条已由 W5-H 补齐，见下**；
    `accept` **没有速率限制**（全项目还没有 throttler）；列表不分页；`usedByUserId` 只记**最后一个**人
    （`maxUses>1` 时查不出「谁用过」）；`AuditLog.targetId` 不是外键；PIN 会话语义未落地；未做真机联调。
    交接单：[`24-w5g-handoff.md`](./24-w5g-handoff.md)。

**W5-H（成员管理，2026-10-22 已收口 · 服务端）**

    ① 三条路由：`GET /members`（`view_members`）、`PATCH /members/:id`（`change_member_role`）、
    `DELETE /members/:id`（`remove_member`），全部**三道屏障**。**孩子能看列表、不能改不能删**：
    他本来就看得见「家里有谁」（选择器里能切到的就是他认识的），藏起来只会让界面出现「一个匿名家长」；
    列表只含 `displayName` / `role` / `status` / `joinedAt` / `removedAt` / `isSelf`，**不含手机号、`openId`、PIN**。
    ② ★ **最后一位家长的保护不能「先查后写」**：那是集合事实（`count(*)`），两个家长同时把对方降级，
    双方都读到 2 ⇒ 双双成功、家里 0 位家长。单条条件 `UPDATE … WHERE (SELECT count(*)…) > 1` 也不够：
    READ COMMITTED 下两条语句各看自己的语句快照。**做法是先 `SELECT … ORDER BY id FOR UPDATE` 锁住
    这个孩子的全部成员位，再计数、再写**；第二笔事务等第一笔提交后在已提交的数据上重新计数
    （EPQ 重检会丢掉已不满足条件的行）⇒ 多出来的那笔得到 409 `LAST_GUARDIAN_PROTECTED`。
    锁粒度是「一个孩子的成员位」（家庭个位数行），都按 id 升序 ⇒ 不死锁；条件 UPDATE 的 count 子查询
    **保留作第二道保险**（将来锁被重构掉时仍能挡住一部分）。
    ③ **降级 = 同一事务收回会话**：`ChildMember.role` 改了而 `DeviceSession.activeRole` 没改，
    等于降级只写了个字段。适配器在事务里把 `(childId, userId)` 上 `activeRole='guardian'` 的会话改成
    `child`（**只动这个孩子**）；**升级不碰会话**（模式没切换，本来就该是 child）。
    ④ **读路径再收一次**：`clampRoleToMembership()` ⇒ 矩阵查表用的角色 = **min(会话角色, 成员位角色)**。
    写路径「记得同步」不该是唯一保障（手工改库 / 未来批量脚本 / 迁移都可能留下一张 guardian 的票）。
    它不是提权：guardian 会话 + child 成员位 ⇒ child，viewer ⇒ viewer（矩阵一律 DENY）。
    ⑤ **两条写路由都禁止作用于自己**（403 `CANNOT_MODIFY_SELF`）。自我降级 = 一次误触就把自己锁在门外，
    而**没有家长能救回来**（能救的人也被你降掉了）；「退出家庭」是另一个产品决定（要定流水归属与数据迁移），
    不该由 `DELETE /members/:id` 顺手实现。正是这两条拒绝让「最后一位家长」保护真正成立。
    ⑥ **都不加 `Idempotency-Key`，也不加 `expectedVersion`**：`PATCH` 目标角色相同 ⇒ 200 且不写审计；
    `DELETE` 已移出 ⇒ 200、`removedAt` 保持第一次的值、不写第二条审计。版本号只能防「基于旧视图的覆盖」，
    而这里真正危险的并发是**两个家长同时把对方降级**，他们看到的是同一个版本（对策是 ② 的锁）。
    ⑦ **移出不删会话**：删了只能回 401 `SESSION_NOT_FOUND`，把「你已被移出」伪装成「你没登录」，
    用户会去重登、重登后还是什么都没有。会话留着，屏障一回 403 `MEMBER_REMOVED`。
    ⑧ **线格式只下发事实不下发结论**：给 `role` / `status` / `isSelf`，**不给** `canChangeRole` / `canRemove` /
    `actions[]` —— 结论由服务端屏障二现场判定。`isSelf` 是唯一「服务端算、客户端不该算」的字段
    （客户端不知道自己的 userId）。`DELETE` 回 `{memberId, status:'removed', removedAt}` 而不是 204，
    与 `{id, revoked}` / `ruleId` 同一手法：回包要与请求验明正身。
    ⑨ **审计快照只含 `role` / `status`**（`member.role_change` / `member.remove`），
    `pinHash` / `restrictions` / `openId` 一律不进审计（审计表读取面宽得多）。
    ⑩ **`viewer` 不能作为 `PATCH` 的目标角色**（`@IsIn(['child','guardian'])`）：降成 viewer = 让他看得见、
    什么都做不了（矩阵无列 ⇒ 一律 DENY），那不是降权而是制造死账号。`viewer` 目前只有历史数据里可能存在。
    ⑪ 真跑基线（2026-10-22）：`backend npm test` → **544/544**（30 文件，新增 25 条）；
    `npm run test:db` → **173/173**（11 文件，新增 `members-db.dbtest.ts` **18 条 / 5 组**，含
    **3 家长环形降级 ⇒ 恰好 2 成功 + 1×409、库里恒剩 1 位家长**）；`typecheck` / `typecheck:tests` /
    `build` → 0；`contracts:emit` → **31 个动作**（新增 `view_members` / `change_member_role`）；
    `honesty:probe` 4/4、`defects:check` 19/19；**新增迁移 1 条**（`20261022090000_member_actions`，
    只加 `ActionType` 两个枚举值，无 DDL 动表）。
    ⑫ ★ **本轮最值得记住的坑**：`members-db.dbtest.ts` 的 `after()` 少了一个 `})`，18 条用例全被关进
    回调里 ⇒ Node 把**文件本身**记成一条 `✔`，`test:db` 报 156 全绿（守卫 ②「tests ≥ 文件数」照样满足）。
    已在 `scripts/run-tests.mjs` 加**守卫 ④**：出现**顶格**的 `<…>.test.js (…ms)` 行 ⇒ 红并点名文件；
    并把它**常设证伪**进 `npm run test:canfail` 的 C / C2 两组（现场写夹具、要求非 0 退出码且点名，
    `finally` 里删除；夹具里的 `it` 必须通过，否则红在 Node 自己而不是守卫上）。**守卫必须能变红，否则它只是装饰。**
    ⑬ 仍不粉饰：双端**没有成员管理 UI**（三条端点只有 curl 能调）；「退出家庭」不存在；
    `ChildMember` 没有 `updatedAt`（「什么时候改的角色」只能查审计）；列表不分页、不筛 `removed`；
    `viewer` 无法创建；PIN / 5 分钟会话刷新未落地（故「降级即收票」是唯一降权手段）；未做真机联调。
    交接单：[`25-w5h-handoff.md`](./25-w5h-handoff.md)。



**W5-J（「我的申请」＋撤回，2026-10-23 已收口 · 双端）**

    ① 两条路由：`GET /approvals/mine`（`view_own_approvals`，guardian / child 双 ALLOW）与
    `POST /approvals/:id/withdraw`（`withdraw_request`，W3-B 已有）。前者**不是**收件箱的 query 变体：
    收件箱按 `childId` 全量收口、孩子 403；我的申请按 `requesterUserId = 会话 actor` 收口，
    query 里根本没有 `requesterUserId` 字段 —— 改参数看不到别人提了什么。
    ② **`summary === null` 的待处理行必须能撤回**：家长侧坏 payload 只禁批准不禁拒绝，
    申请人侧若再禁撤回，这条行就没人能收尾（孩子看不到收件箱）。`canWithdrawApproval()`
    只判 `pending + 未过期`，**不读 payload**。
    ③ **撤回不是否决**：只有申请人本人能做，家长撤别人的申请得 403 `NOT_REQUESTER`，
    文案让他改用「拒绝」（那条会留下判定人与时间）。`POST` **无请求体**，申请人只来自会话。
    ④ **不碰余额 / 流水 / 首页**：`pending` 尚未执行，撤回只改状态。收件箱**仅在已加载时**
    刷新（`approvalReadStatus !== idle`），409 同理 —— 孩子的设备请求 `GET /approvals` 必然 403，
    撤回成功后凭空多发一次只会把成功画成失败。
    ⑤ **回包验明正身**：`status !== 'withdrawn'` 视为契约漂移，返回可展示警告而不假报成功
    （与 `ruleId` / `executedRecordId` / `invite.id` 同一手法）。
    ⑥ **两个列表不共用 store 切片**：`fetchMyApprovals()` 只返回页对象，不写 `approvals` /
    `approvalError` / `approvalReadStatus`。共用会让两边的游标与错误互相污染，也会把
    收件箱从 `idle` 推到 `ready` 而误触发 403。
    ⑦ **空态五分**：错误行 + 重试 / 正在加载 / 从未成功加载 / 预览模式 / 真的没有。
    把 403 或断网画成「还没有提交过申请」是反复记过的坑。
    ⑧ **键集分页**沿用 W4 的 `limit + 1`；客户端额外按 id 去重（快速点两次「加载更多」）。
    ⑨ **小坑**：幂等键头是 `idempotency-key`（小写；测试里写 `Idempotency-Key` 会拿到 `undefined`）；
    `WriteApiException.fromHttp` 要**已解码的 Map**，传 JSON 字符串会丢 `code`，
    403 会退化成通用文案；「收件箱已加载」只能看状态值，不能看 `approvals.length`（空列表也是已加载）。
    ⑩ 真跑基线（2026-10-23）：`backend npm test` → **553/553**（W5-I 544，本阶段 +9）；
    `typecheck` / `typecheck:tests` → 0；`flutter analyze` → 0；`flutter test` 两文件 → **127/127**；
    小程序 `tsc --noEmit` / `build:weapp` / `build:h5` → 0；`node .tmp_test/run-w5j.mjs` → **14/14**；
    **先 `npm run build` 再** `contracts:emit` → **32 个动作**（新增 `view_own_approvals`；
    直接 emit 会读陈旧的 `dist/` 得 31 —— 脚本要的是编译产物）；**新增迁移 1 条**
    （`20261023090000_own_approval_action`，只 `ALTER TYPE … ADD VALUE`）。
    ⑪ 仍不粉饰：**没有推送 / 角标**（申请人要打开面板才知道状态变了）；**没有申请详情页**
    （看不到判定人与时间）；我的申请**没有筛选 chip**（UI 固定拉全部）；**真库 `test:db` 本轮未复跑**；
    无真机截图；Flutter 侧无 widget 测试。成员管理 UI（W5-H）与 `POST /invites/accept`（等 L2）仍未建。
    交接单：[`27-w5j-handoff.md`](./27-w5j-handoff.md)。

**W5-K（2026-10-23）审批结论有了推送「端口」，但没有任何真实渠道。**
`ApprovalsService.decide()` 在**账本事务提交之后**调用 `NotificationsService.notifyApprovalStatusChanged()`：
它带 **1s 超时**、**永不抛错**，因此推送故障不会把一次已成立的批准变成 5xx（`01` §4 / `02` §9.23）。
只推**人做的决定**（`approved` / `rejected`），收件人恒为 `requesterUserId`；**自批 / 撤回 / 过期 / 失效不推**。
消息只带 `approvalId` / `childId` / `action` / `status` / `decidedByUserId` / `occurredAt`，
**不带金额或心愿标题** —— 第三方通道会保留内容。默认 `NoopPushAdapter` 如实返回
`provider_not_configured`（**不假装送达**），所以「审批 200」**不等于**「孩子已收到」。
真实 APNs / FCM / 微信订阅消息、`DeviceToken` 上报端点、重试 / outbox 都未建，接入清单见
[`28-w5k-handoff.md`](./28-w5k-handoff.md) §5.1；**站内通知中心已落地（W5-L）**——
`GET /notifications` + `PATCH /notifications/:id/read`、双端「消息」面板与未读角标，
但它**不是推送**（仍要用户打开 App，且无 outbox），见同文 §5.2。
真跑基线：`backend npm test` → **565/565**（W5-J 553，本阶段 **+12**）；
`typecheck` / `typecheck:tests` → 0；`flutter analyze` → 0；`flutter test` 两文件 → **127/127**（客户端未改）；
小程序 `tsc --noEmit` → 0；**无迁移**。交接单：[`28-w5k-handoff.md`](./28-w5k-handoff.md)。
（W5-L 补齐站内通知后：`npm test` → **576/576**、`npm run test:db` → **189/189**、
`flutter test` → **199/199**，明细见 §5.2。）

**W5-M（2026-10-23）提交即通知家长 —— 家长不再靠轮询。**
`POST /approvals` 落成 `pending` 之后（事务外），`NotificationsService.notifyApprovalSubmitted()`
用 `listActiveGuardianUserIds(childId)`（`ChildMember{ role:'guardian', status:'active' }`）
展开收件人，**排除提交人**，每人一条站内 `approval.submitted` + 一条推送（W5-K 端口）。
站内先写、推送后发，任一步失败只记日志，接口仍 **202**；自批 / 自动通过不发
（那时没有「等你确认」）。`payload` 只有 `{ approvalId, action, submittedByUserId }`，
不带金额 / 标题 / 理由。客户端把 `approval.submitted` 的胶囊改成**「去审批」**
（Flutter 关面板后由 `HomeShell` 切审批 tab；小程序 `switchTab(2,3)`），
`approved` / `rejected` 仍走「查看申请」→「我的申请」——两者都带 `approvalId`，
只凭 payload 分不出该去哪。证据：`notifications.test.ts` 6 条 +
`approvals-http.test.ts` 组 H + 真库 `notifications-db.dbtest.ts` 组 E（+3）+ Flutter +1；
真跑：`npm test` → **586/586**、`test:db` → **192/192**、`flutter test` → **200/200**、
`flutter analyze` / 小程序 `tsc --noEmit` → 0。边界：没有 outbox、推送仍是 no-op、
非 active 家长位收不到、删除 / 撤回 / 过期不补发。明细见
[`28-w5k-handoff.md`](./28-w5k-handoff.md) §5.3。


**W6-A（2026-10-24）`DeviceToken` 表不再空转：有了写入路径，`PUSH_PORT` 也第一次真的会发 HTTP。**
两条新路由 `POST /device-tokens`（登记 / 刷新）与 `POST /device-tokens/revoke`（注销），
身份**只来自会话**（userId / childId 都不在请求体里，多传一个键就 400），
新动作 `manage_device_tokens` 对 guardian / child **双 ALLOW**（孩子的设备收不到推送才是缺陷）。
`token` 被当成凭据：**响应不回显**、注销走请求体（没有 `/:token` 路由，路径段会进访问日志）、
`GET /device-tokens/<token>` 就是 404。同一个 token 换账号注册 ⇒ **409**
（共享平板换人登录不能劫持前一个账号的推送），注销别人的 ⇒ **404**（与站内通知同一口径，
不给探测口），重复注销幂等靠**条件 `updateMany`**（并发两笔回同一个 `revokedAt`），
单用户 active token **LRU 上限 10**（网关每次要收全部 token，不设上限就是放大器）。
装配侧 `PUSH_PORT` 从 `useClass: NoopPushAdapter` 改成 `useFactory: createPushAdapter(...)`：
`PUSH_WEBHOOK_URL` 合法 ⇒ `WebhookPushAdapter`（真 `POST`，`410` 时**只下线本次发送的 token**，
5xx / 401 一个都不动），没配 ⇒ no-op（**默认世界不变**），配错 ⇒ no-op 但打 **error**。
证据：离线 32 ＋ 真 HTTP 20 ＋ 真库 14；`npm test` → **638/638**、`npm run test:db` → **206/206**、
矩阵 **35** 动作、`contracts:emit` 已重新生成。
**顺手补上一个闸门**：PRD §7 的表格从 W5-H 起就停在 29 个动作（代码早已 35），而十几轮 CI 全绿 ——
因为没有任何检查读过文档。现在 `honesty:probe` 多了检查 **E**（PRD §7 ↔ 矩阵逐行动作/判定对账），
`test:canfail` 多了检查 **D**（拿一份故意写错的夹具 PRD，必须让探针变红并点名），
PRD §7 已同步至 **40 动作**（v1.1 从 29 → 35；v1.6 / W7-A 再 +2：`view_consent` / `manage_consent`；
v1.7 / W7-C 再 +1：`export_family_data`；v1.8 / W7-D 再 +2：`view_family_deletion` / `manage_family_deletion`）。
**边界**：没有 APNs / FCM / 微信凭据，没有网关实现，没有客户端上报（线上表仍空），
没有 outbox / 重试，**真机推送一次都没发生过**。明细见
[`29-w6a-handoff.md`](./29-w6a-handoff.md) §5。


**W6-B（2026-10-24）推送失败不再「发一次就没了」：多了一张 `PushRetryJob` 与一个后台 worker。**
`PUSH_PORT`（业务：发一次 + **失败即入队**）与 `PUSH_DELIVERY_PORT`（worker：只发一次）被拆成
**两个令牌** —— 否则每次重试失败都会再入一次队，「谁负责重试」变成两个地方。
失败分两类：`provider_error`（渠道坏了）**消耗** `attempts`，按 30s→1m→2m→4m→8m→16m
（封顶 30m）退避，用满 6 次 ⇒ `dead`；`no_device_token` / `provider_not_configured`
（结构缺失：装好 App / 配上网关就有了）**不消耗**次数，固定 5m 重试直到 TTL ⇒ `expired` ——
若也按 6 次判死，配个网关的工夫就把队列清空了。
领取是单条 `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING`（多实例不重发），
`sending` 超 `claimTimeout` 可回收（崩溃自愈，代价是极端下**可能重复发一次**）。
**真库抓到一个离线用例永远抓不到的 bug**：`RETURNING` 的行序在 Postgres 里未定义，
「拖得最久的最先发」只在某些执行计划下成立 —— 已在应用侧按 `nextAttemptAt` 重排。
证据：离线 **36** ＋ 真库 **14**（并发不重叠 / 回收 / 条件结算 / 唯一约束**不改写原行**）；
`npm test` → **664/664**、`npm run test:db` → **220/220**、矩阵仍 **35** 动作（无迁移外的新动作）。
**边界**：这**不是真 outbox** —— 请求路径仍先同步发一次，入队在业务事务之外，
「事务已提交、入队前崩溃」那条缝隙还在；没有厂商凭据 / 网关 / 客户端上报（线上表仍空），
没有 retention、没有外接告警，**真机推送仍一次都没发生过**。明细见
[`30-w6b-handoff.md`](./30-w6b-handoff.md) §5 / §6。


**W6-C（2026-10-24）审批提醒改成真 outbox：入队与审批同生共死，请求路径一次推送都不发。**
旧顺序是「审批事务提交 → 同步试发一次 → 失败才入队」，进程若在「提交」与「入队」之间退出，
这条提醒**永久丢失**（队列里连一行都没有）。现在 `createPending` / `decide` 在**同一个事务**里
写 `Notification` + `PushRetryJob` 两行，`PushRetryWorker` 成为唯一发送者。
这不违反 `01` §4：进事务的只有同一个 Postgres 里的两行本地数据，**不调用任何第三方**；
outbox 写失败 ⇒ 审批整体回滚（不会「批了但没人知道」），外部推送失败 ⇒ 只影响 `attempts` / `status`。
收件人解析搬进 outbox：`approval.submitted` 发给这个孩子的 active guardian 并**排除提交人**，
`status_changed` 固定发申请人；去重键先查后写、`skipDuplicates` 兜竞态（**极小窗口仍可能多一条站内通知**，
当前没有对账任务）。`PUSH_PORT` 不再套「失败即入队」装饰器（`useExisting: PUSH_DELIVERY_PORT`），
`NotificationsService` 收敛为只读（`list` / `markRead`），`ApprovalsService` 不再认识通知层。
证据：离线 8 ＋ HTTP 组 G/H（请求路径零推送 / 零通知写入）＋ 真库 3（同事务两行 / 真实监护人解析 /
注入抛错时审批回滚）；`npm test` → **653/653**、`npm run test:db` → **223/223**、矩阵仍 **35** 动作。
**边界**：仍无 L3 凭据 / 网关 / 客户端 token 上报，队列里的行最终会因结构性失败在 TTL 后 `expired`，
**真机推送一次都没发生过**；没有对账、没有 retention、没有外接告警。明细见
[`31-w6c-handoff.md`](./31-w6c-handoff.md) §5。


**W6-D（2026-10-24）W6 里「不需要厂商凭据」的最后两件事落地：对账会喊、队列表会瘦。**
对账端口只有一个 `snapshot(now)` —— **没有写方法**，所以「机器自动补发」连 API 都不存在，
这是刻意的：缺口可能是「通知写了、任务被删」，也可能是「通知是脏数据」，
自动补发等于把一次数据异常变成一次手机弹窗（人工处置见 `32` §4 的 runbook）。
匹配键是三层：`recipientUserId` ＋ `payload.approvalId` ＋ 事件语义
（`submitted`⇔`submitted`；`approved`/`rejected`⇔`status_changed` 且 `payload.status` 必须相符）。
**少了收件人条件，同一 approvalId 的两组行会互相作证，对账恒为 0** —— 真库 C1 专门守这一条。
W6-C 承认过的那个极小竞态（并发下多一条站内通知、任务只有一条）在「配对存在性」看来
是健康的，所以另有一条分组计数 `duplicateNotifications`（n 条计 n−1，分组键与去重键同构）。
`dead` / `expired` / `pending` 只是状态分布，**不算漂移** —— 否则「没配网关」会让告警永远为真。
保留清理只删三个终态：`sent` 7 天、`expired` 7 天、`dead` **30 天（它是证据）**，
`pending` / `sending` 永不删；时间字段统一 `updatedAt`（三终态唯一的终结时刻），
严格 `<` 边界（恰好等于截止线的行保留），分批 `DELETE … WHERE id IN (SELECT … LIMIT n)`
（`deleteMany` 没有 limit），三个状态各自 try/catch 继续但**一轮只要有失败仍抛错**，
适配器在发 SQL 前还会用运行期白名单再验一次状态（`pending` / `sending` 直接抛）。
两个无库实现都是 501，**不**返回全零快照 / 0 条删除 —— 那会被读成「一切正常 / 清理完成」。
证据：离线 **40** ＋ 真库 **17**（含真实 `LIMIT`、1ms 边界、`updatedAt` 口径、收件人隔离）；
`npm test` → **693/693**、`npm run test:db` → **240/240**、矩阵仍 **35** 动作。
**边界**：仍无 L3 凭据 / 网关 / 客户端 token 上报，**真机推送一次都没发生过**；
告警只写日志、没有外部通道；保留清理无归档（删掉的 `dead` 就再也查不到）；
对账无时间窗口也无分布式锁。明细见 [`32-w6d-handoff.md`](./32-w6d-handoff.md) §5。

**W6-E（2026-10-25）客户端第一次真的会写 `DeviceToken`：推送失败从启动路径上被隔离出去。**
Flutter 启动时若后端已配置，就 fire-and-forget 上报一次；**没配推送 token 是正常状态**，
配置错误只打日志，请求失败 / 超时 / 409 全部归一成 `PushTokenResult`，**不 `await`、不抛错**。
接口刻意独立于 `WriteApi`：推送失败不得改变打卡 / 登录 / 首页刷新，也不该让一堆
`implements WriteApi` 的测试替身被迫加方法。`PushTokenRegistrar` 做四件事 ——
单飞（并发拿到**同一个 Future**，只发一次）、同 `(platform, token)` 去重、
**409 `DEVICE_TOKEN_OWNED_BY_OTHER` 本次进程内不重试**（重试永远是 409，换 token 才解除）、
注销 404 按「已注销」处理；连 `PushTokenSource.platform` 这种外部 getter 抛错也在
`report()` 内兜住，由用例钉死。`KP_PUSH_TOKEN` **只允许调试构建**：发布包里写死一个 token，
所有安装会抢同一个地址（后端 409，新用户永远收不到推送）。日志、结果与 `ArgumentError`
**都不含 token**；SDK 异常只打 `runtimeType` —— 最初打 `$error` 时测试放过了，
但真实 SDK 的异常串常把 token 一起带出来。
证据：新增 **40** 条用例（API 16 ＋ 上报器 24），`flutter analyze` 无问题、`flutter test` **240/240**。
**边界**：W6-E 当时没有真实 FCM / APNs SDK、没有权限申请、没有生命周期重报、没有退出登录注销、
没有跨启动去重、**没有真机 / 真后端证据**；小程序因缺微信登录（拿不到可信 `openid`）
**刻意不做**，不造假的 `weapp` token 来源。明细见 [`33-w6e-handoff.md`](./33-w6e-handoff.md) §5。
（其中“生命周期重报 / 退出登录注销入口”已由下一阶段 **W6-F** 补上。）

**W6-F（2026-10-25）推送 token 从「启动报一次」变成「进程级运行时」。**
W6-E 的 registrar 用完即关，真实 SDK 在运行中轮换 token 时没有任何补报机会。
W6-F 新增 `PushTokenRuntime` 长期持有它：`start()` 绕过冷却立即报；
App 回到前台（**只认 `resumed`**）调用 `reportIfDue()`，默认 **5 分钟冷却**，
窗口内一个请求都不发；失败也记录尝试时刻，避免断网时每次切前台都等 10 秒超时；
`revoke()` **先置停用再注销**，并发 resume 不会把 token 登记回去（退出登录后不能仍收推送）；
`dispose()` 有在途请求时等它结束再关 HttpClient，且只关一次。
`PushTokenLifecycle` 是唯一 Flutter 绑定胶水（`addObserver` / 只过滤 `resumed`），
策略全在纯 Dart runtime 里：13 条运行时用例不需要 widget binding 就能证伪，
另 3 条只验证 observer 接线。证据：新增 **16** 条，`flutter analyze` 无问题、`flutter test` **256/256**。
**边界**：仍无真实 FCM / APNs SDK、无 token refresh 流（轮换要等下一次 resume）、
无登录流程可调 `revoke()`、无跨启动去重、**无真机 / 真后端证据**；
小程序仍因缺微信登录刻意不做。明细见 [`34-w6f-handoff.md`](./34-w6f-handoff.md) §5。

**W6-G（2026-10-25）推送链路第一次被一条用例从头跑到尾。**
W6-A ~ W6-F 各自证明了一段（token 能登记、任务能入队、worker 会结算、队列能对账、客户端会上报），
但没有任何一条用例把它们串起来。W6-G 新增 `test-db/push-delivery-e2e-db.dbtest.ts`：
真 `AppModule` 起 HTTP 服务 → 真审批写同事务 outbox → 真 `PushRetryWorker.tick()` 领件 →
真 `WebhookPushAdapter` 查真 `DeviceToken` → POST 到本进程的 `node:http` 网关 → 回写任务。
网关只扮演「我们自己的推送网关」这一端，因此**不需要 L2 / L3 凭据**，但适配器本身没有替身。
只覆盖两个 provider：`PUSH_DELIVERY_PORT`（生产适配器 + 本地 URL）与
`PUSH_RETRY_CONFIG.batchSize=1`（共享库选行隔离）；适配器 `timeoutMs=800` 必须小于
worker 的 1000ms 兜底。网关三种回应钉死三条结算分支：200 ⇒ `sent` + `providerMessageId`；
500 ⇒ `pending` + `attempts=1` + 30s 退避；410 ⇒ 同样重试且库里 token `active=false`。
最要紧的两条：**500 之后审批仍 `approved`、心愿仍落库**（推送失败不回滚业务），
**没有 token 时网关 0 次调用且 `attempts` 仍 0**（结构性失败不烧 24h 的重试预算）。
共享实验库仍不 DELETE：只把被测任务的 `nextAttemptAt` 拨到 2000 年，保证它是
`ORDER BY nextAttemptAt ASC` 的第一条。证据：`test:db` **246/246**（本套件 **6** 条）、
`npm test` **693/693**，矩阵仍 **35** 动作。**边界**：本地网关不是 APNs / FCM，
token 由测试直接登记（没有客户端参与），`tick()` 由测试手动调（没验 15s 调度 / 重启 / 多实例），
**真机推送仍然一次都没发生过**。明细见 [`35-w6g-handoff.md`](./35-w6g-handoff.md) §5。

**上一轮（自查发现）**

| # | 缺陷 | 说明 |
|---|---|---|
| 1 | **`05` §2 基线算术错误** | 原写「基线 9.5 周」，但表格逐项相加 = **10.5 周**。P1「不压缩」决策曾基于该错误数字 |
| 2 | **`05` §6 悬空编号 `L6`** | 表格只有一行 `L6`，**L1–L5 从未定义**；`04` 与 `05` 的 R4 都引用了一个不存在的登记表 → 已补全为 **L1–L6** 六项真实阻塞项（每项附仓库内证据） |

**本轮 W0（**照着文档实现时才会暴露**的 6 处，详见 `06` §2）**

| # | 缺陷 | 若不修正的后果 |
|---|---|---|
| 3 | `@nestjs/cli` **不存在 12.1.2**（最新 **12.0.8**） | `npm install` **直接失败** |
| 4 | NestJS 12 要求 **TypeScript ≥ 6**（`01` §1 写 5.4） | `npm install` 因 ERESOLVE **失败** |
| 5 | **Prisma 7 破坏性变更**：`datasource.url` 不再支持 | `prisma validate` **直接报错**，schema 无法开始 |
| 6 | `01` §5「新增 11 + 改造 5」**与事实不符** | 误以为要写 `ALTER TABLE`；实际**根本没有库可 ALTER**，应一次建 **18 表** |
| 7 | **`REVOKE` 对表所有者无效** → I5 变空承诺 | 用例 9.14 永远无法通过，而 I5 在文档里**长期"看起来成立"**（又一处假绿） |
| 8 | `01` §3「接 API 不改 UI」对**图标字段**不成立 | Taro 用名字、Flutter 用 `IconData`，必须新增映射（决策 D9） |

> 这 6 处的共同点：**文档写的是"应该是什么"，没有验证"实际能不能成立"** —— 与 D12 同类。
> 它们全部由 W0 的实际执行（`npm install` / `prisma validate` / `tsc`）暴露出来，
> 而不是由评审发现的。

**本轮 W0 收尾：连上真实数据库后才暴露的 9 处（详见 `06` §10）**

> 编号说明：`06` §10.2 内编号为 **7–15**（承接其 §2 的 1–6）；下表为本文档的**全局编号 9–17**。

| # | 缺陷 | 若不修正的后果 |
|---|---|---|
| 9 | `prisma.config.ts` 的 seed 指向**不存在的** `prisma/seed/rule-templates.ts` | `prisma db seed` **直接失败**，引导第⑤步拿不到模板 |
| 10 | 迁移使用 `DATABASE_URL`，与 D7「迁移走所有者」冲突 | 应用角色无 DDL，迁移**建不了表** |
| 11 | `.env` 两条连接串**同值** → D7 只是文档承诺 | **I5 形同虚设**（应用以所有者身份连库） |
| 12 | `scripts/**`、`prisma/**` **不在任何 tsconfig 的 include 中** | 工具代码**零类型检查**；启用后立刻抓出真实类型错误 |
| 13 | **Prisma 7 的 `migrate dev` 不会自动跑 seed** | 模板库**静默为空**（不报错 —— 最难发现的一种） |
| 14 | tsx 按 CJS 编译 → **顶层 await 报错** | seed 脚本**一行都跑不了** |
| 15 | `main.ts` **从未加载 `.env`** | `npm start` 抛「DATABASE_URL 未设置」，即使 `.env` 就在旁边 |
| 16 | **`class-validator` / `class-transformer` 不在依赖里** | `ValidationPipe` 抛错，**应用根本起不来** |
| 17 | `@prisma/client@7` 无 postinstall 钩子 | 全新克隆未 `generate` 时 `tsc` 找不到类型 |

> 这一批与 3–8 的共同点**更值得警惕**：它们不是"文档写错了"，
> 而是 **"文档写的都对，但没有任何东西会把错误喊出来"**。
> `migrate dev` 不跑 seed 不报错；`npm start` 起不来却被归因为"环境没装库" ——
> **沉默的失败比失败的报错危险得多。**

**本轮 B4（2026-10-14，实测暴露 1 处 —— 这一处是**文档自己写反了**）**

| # | 缺陷 | 若不修正的后果 |
|---|---|---|
| 18 | 本文「测试框架」节（B1 写下）断言 **「`tsx`：带装饰器的契约能加载、且元数据真的生效」** | 成立的部分**只有**「离线自检能跑」（`validateRestrictions()` 直接调 `plainToInstance` ＋ `validate`，约束由装饰器自身注册，**不需要** `emitDecoratorMetadata`）。一旦外推到 **Nest 的 HTTP 路径**，`ValidationPipe` 会**静默整体失效**（实测多余键返回 **201**），而测试照样全绿。已改为「先 `tsc` 真编译再跑产物」 |

> 它与 3–17 的性质不同：**不是「没验证」，而是「验证了一半就外推」**。
> 两个都叫「装饰器元数据」，但一个是 class-validator 自己的约束注册，另一个是 TypeScript 的
> `design:paramtypes` —— **同名不同物**，恰好是最难自查的一类。

### CI 步骤

**后端 —— 已落地为一条命令**（`backend/`）：
```
npm run ci
= prisma:validate → typecheck → typecheck:tests → typecheck:tools → honesty:probe
  → defects:check → templates:check → icons:check → relation:check → restrictions:check
  → test → test:canfail → test:canfail:db → build → contracts:emit          （共 15 步）

npm run ci:db            # 要**活库**；刻意**不在** `ci` 里（无库 CI 不许为了它变成「跳过」或「必红」）
= db:verify → test:db → test:canfail:db
```
> **勘误（2026-10-15 补齐）**：上面这一行原写于 W0（9 步），此后 D-a 加 `relation:check`、D-b 加 `restrictions:check`、
> 阶段 B1 加 `typecheck:tests` / `test` / `test:canfail` —— 只有待办条目被更新，**这行代码块没跟上**。
> 现已按 `backend/package.json` 的 `ci` 脚本**逐字重抄**。凡是"链式命令写在文档里"的地方，都会这样漂移 ——
> 所以真实基线**以 `npm run ci` 的输出为准**，不以本行为准。
> **再勘误（2026-10-15，W2-B）**：同一行**又**漂了一次 —— 本轮加 `test:canfail:db`（**14 → 15 步**），
> 并把真库侧单独定成 `ci:db`。分界理由是**能不能没有数据库**：
> `test:canfail:db` 只证明"守卫会拦人"、**不连库**（用的是打不通的假连接串），所以它能待在无库的 `ci` 里；
> `test:db` 会**写入真实流水**，必须留在 `ci:db`。

其中 `honesty:probe` 自带 4 项检查（A/B 是**注入式诚实性对照**，C/D 是结构性守卫）：

- **D12 回归守卫**：扫描测试运行器的花括号嵌套深度，确认汇总与 `process.exitCode`
  **不在任何回调内部**（该探针已用夹具 `__fixtures__/d12-misnested-runner.js`
  证明**能失败** —— 否则它自己就会变成下一处假绿）
- **ActionType 契约漂移守卫**：`permission-matrix.ts` 与 Prisma `enum ActionType` 必须逐一对应
- **图标名跨端契约守卫**（`npm run icons:check` → `tools/icon-names-check.mjs`，**阶段 C5 新增，修 D9**）：
  Taro `ICONS` ／ Flutter `appIcons` ／ 后端 `ICON_NAMES` 三份**手抄**名单必须**逐字相等**
  （Flutter 与后端都无法 import 小程序的 TS），另查「数据层不得存字形、调用处不得写死名字、
  渲染点各只一处、兜底与写入口白名单都被接上」共 7 项。已用 **12 例注入式证伪**（含 2 例 fail-closed）证明每项都能单独变红。
  手抄名单会漂移，而漂移的表现是「某个图标在某一端悄悄变成占位」—— 三端的编译器都不会说一句话。

另有 **缺陷台账对账守卫**（`npm run defects:check` → `tools/defect-status.mjs`，**2026-10-12 新增**）：
`03` §0 的 19 条状态声明逐条拿到代码里验证 —— 「已修」却找不到修复痕迹、或「未修」其实早已修好，都判红
（**后者正是那 8 条失实的病**）。**证据只取代码、注释不算**：否则注释里那句「原先 `xxx` 如何错」
会让两侧同时被骗（本工具首跑就因此误报 2 条：A1 / A5）。已用 **7 份被篡改的台账副本**证明能变红
（谎称已修 / 谎称未修 / 删行 / 伪造新增行 / 改表头列名），并以「调换列顺序仍正确」证明它**按表头定位列**、不写死列号。
**C1 又加了 7 个反例重验一遍**（谎称未修 / 谎称半修 / 删行 / 伪造新增行 / 改表头列名 ＋ **2 处代码回退**：
把首启改回注入 seed、把守卫常量改回字面恒真）—— 7/7 全部变红，还原后重回全绿（`tools/_scratch/c1-tamper.mjs`，可复跑）。
> 反例本身也要证伪：第一版「伪造新增行」反例隔了空行，被解析器按"表格已结束"正确忽略 —— **绿的是我的反例，不是守卫**；
> 改成紧贴末行后才复现。写反例时踩的坑，恰好说明"绿"必须能被解释。

**测试框架（阶段 B1 新增，2026-10-14）—— 用 Node 内置 runner，**零新增依赖**：

```
npm run test             # = node scripts/run-tests.mjs（遍历 test/**/*.test.ts → tsc 真编译 → 跑**产物**）
npm run typecheck:tests  # = tsc --noEmit -p tsconfig.test.json（转译器**不做类型检查**，必须单独 typecheck）
npm run test:canfail     # = node scripts/test-can-fail.mjs（证明「测试真的会红」；无需数据库）
npm run test:db          # = node scripts/run-db-tests.mjs（**要活库**：test-db/**/*.dbtest.ts；三道守卫见下）
npm run test:canfail:db  # = node scripts/test-can-fail-db.mjs（证明真库入口的三道守卫**真的会拦**；无需数据库）
npm run ci:db            # = db:verify → test:db → test:canfail:db（真库侧的完整验收）
```

选型依据是**实测**（Node v26.10.0，2026-10-14），不是偏好：

| 方案 | 实测结果 |
|---|---|
| 原生 `node --test`（Node 26 类型剥离） | ❌ 连模块都解析不了（`ERR_MODULE_NOT_FOUND`：本仓库是 CJS ＋ 无扩展名导入） |
| jest / vitest | 需新增依赖；且 TS **6.0.3** 很新，`ts-jest` 一类存在版本兼容风险 |
| **`node:test` ＋ 既有 `tsx`** | ⚠️ **只对「不碰 Nest 容器」的代码成立** —— 本行原写「元数据真的生效」，**已被 B4 实测证伪**（见下） |
| **`node:test` ＋ 先 `tsc` 真编译、再跑产物**（**B4 起采用**） | ✅ 装饰器与 `emitDecoratorMetadata` 与生产**同一套**；仍是零新增依赖（用仓库自带 `typescript`） |

**★ B4 更新（2026-10-14）：为什么入口必须「先真编译」** —— 三件事都是实测（Node v26.10.0）：

1. **tsx 对不在 `tsconfig.include` 内的文件，连装饰器都不转译**：同一份带 `@Controller()` / `@Body()`
   的文件放 `backend/` 根 → `Parameter decorators only work when experimental decorators are enabled`；
   放进 `src/`（include 内）→ 能跑。**同一文件、两种命运。**
2. **挪进 include 之后更危险**：`ValidationPipe` **静默整体失效** —— `{action:'redeem', foo:1}`（多余键）
   与 `{action:'nope'}`（非法枚举）**都返回 201**。根因：esbuild **不产出 `emitDecoratorMetadata`**，
   Nest 拿不到 `design:paramtypes` ⇒ 判不出「这个参数要不要校验」⇒ 整体跳过且**不报错**。
   注意它的失败形态：**不会红，只会什么都不做。**
3. 故 `run-tests.mjs` 现在是 `tsc -p tsconfig.test.build.json`（`src` ＋ `test` → `.tmp_test_build/`，
   **每次先 rm 重建**，绝不复用旧产物 —— 同本文件「完整流水线」里 `run.js` 那条的理由），再在**产物**上跑；
   并新增守卫：**源码 `*.test.ts` 数 == 编译产物 `*.test.js` 数**（少一个即红并点名），
   防「文件静默没编译出来 ⇒ 静默没跑」（与 D12 同类）。
   > 代价：`npm test` 每次多一次全量 `tsc`（本机约 2 秒量级）—— 换来「测的就是要上线的东西」。

**两个 fail-closed 守卫**（都是因为实测发现「绿得不诚实」才加的）：

1. **0 用例不算通过**：实测 `node --import tsx --test <空目录>`（以及只含 `*.spec.ts` 的目录）
   输出 `ℹ tests 0` 而**退出码 0** —— 「一个用例都没跑」看起来是绿的。故 `run-tests.mjs` **自己遍历文件**
   （不依赖 Node 的发现规则，这也正是测试文件必须命名 `*.test.ts` 的原因），并强制
   `用例数 ≥ 1` **且** `用例数 ≥ 文件数`（有文件一个用例都没贡献 ⇒ 红）；解析不出汇总行也判红。
2. **证明「测试会红」**：`test:canfail` 用夹具 `scripts/__fixtures__/always-red-runner.fixture.ts`
   要求 runner 退出码非 0 **且点名夹具里的两条失败用例**（防「红在别的理由上」—— D-a 阶段踩过）；
   再把入口指向空目录 `scripts/__fixtures__/empty-test-dir/`，要求它**退出码非 0**。
   `--test-concurrency=1` 是**刻意**的：共享状态（数据库 / 构建产物）不许并发 —— W2 的库不变量用例必须串行。
3. **真库套件单独一个入口**（W2-B 新增）：`npm run test:db` → `scripts/run-db-tests.mjs` 跑
   `test-db/**/*.dbtest.ts`。**为什么不跟离线用例放一起、也没有 `skip` 分支**：
   `npm run ci` 是**无库**跑的，混进来之后 CI 只能在「跳过（假绿）」与「必红（噪音）」里二选一 ——
   而本仓库的纪律是「**没验证 ≠ 通过了**」，所以缺 `DATABASE_URL` 时**退出码 1** 并说明
   「这一整套不变量**一条都没被验证**」，绝不打印成绿色。三道守卫全 fail-closed：
   ① `NODE_ENV=production` 直接拒（套件会**写入**流水，而 `PointRecord` 的 `DELETE` 被 REVOKE（I5）
   ⇒ 写进去**删不掉**）；② 缺 `DATABASE_URL` 红；③ 套件目录里 0 个 `*.dbtest.ts` 红。
   它们**不是"写完就算"**：`npm run test:canfail:db`（`scripts/test-can-fail-db.mjs`，**不连库**）
   逐条证明这三道守卫**真的会拦**，且都拦在**写入之前**（判据是运行横幅没出现，而不是"退出码非 0"就完事；
   后者可能是红在别的毛病上），另带一条**正向控制**：守卫全过时必须真的把手交给 runner（横幅必须出现），
   而没有活库时整体退出码仍须 ≠ 0。**没有这条正向控制，前面全绿也可能是「入口永远红」—— 那种守卫一样没用。**
   `KP_TEST_SUFFIX` / `KP_DB_TEST_DIR` 两个覆盖变量的**唯一**用途，就是让上面的证伪能把入口指向**空目录**。

> **实测基线（2026-10-15，W2-C 收口时复跑；W2-B 时的数字括注在同一行里；不是推断）**：`npm run ci` → `CI_EXIT=0`（**15 步**全绿，末尾
> `contracts:emit` 输出「已生成 contracts/permission-matrix.json（25 个动作）」且生成物 **`git status` 无 diff** ⇒ 幂等）；
> `npm run test` → **11 个用例文件 / 211 个用例全部通过**（W2-C 之后；跑的是 `.tmp_test_build/` 里的产物。
> W2-B 时是 **10 / 203**、W1-C 之后是 **9 / 144**、W1-B 是 **7 / 98**、W1-A 时是 **5 / 68**）；
> `npm run test:canfail` → **4/4 ALL PASS**（`CANFAIL_EXIT=0`），其附注行**当场复现**了第 ① 条守卫的依据：
> runner 自己对空目录是「退出码=0，用例数=0」；
> **真库侧**：`npm run test:db` → **`DB_EXIT=0`，1 个用例文件 / 17 个用例全部通过**
> （`ℹ suites 10 / pass 17 / fail 0`；W2-C 加组 J 之前是 `9 / 16`）；`npm run test:canfail:db` → **11 项 ALL PASS**（`CFDB_EXIT=0`）。
> 各阶段自己的**证伪**另跑五处：`tools/_scratch/w1a-canfail.mjs` → **6 条 ALL PASS**、
> `tools/_scratch/w1b-canfail.mjs` → **6 条 ALL PASS**、`tools/_scratch/w1c-canfail.mjs` → **6 条 ALL PASS**
> （见上面第 16／17／18 条）、`tools/_scratch/w2a-canfail.mjs` → **5 条 ALL PASS**（内核／尺子）、
> `tools/_scratch/w2b-canfail.mjs` → **5 条 ALL PASS**（装配分叉；见第 19 条的 W2-C 段）、
> `tools/_scratch/w2d-canfail.mjs` → **10 条 ALL PASS**（离线 ①–⑧ ＋ 真库 ⑨–⑩；见第 19 条的 W2-D 段）
> —— 每条都「退出码≠0 ＋ 点名预期用例/断言 ＋ `sha256` 复原」。
> **W2-D 档（2026-10-16 复跑；2026-10-17 补 P2 后再复跑；数字全部来自当次真实输出，不是推断）**：
> `npm test` → **14 个用例文件 / 241 个用例全部通过**（`ℹ suites 44`；W2-C 时是 11 / 211）；
> 真库侧 `npm run test:db` → **3 个用例文件 / 40 个用例全部通过**（`ℹ suites 20`；W2-D 首跑时 2 / 28、W2-C 时 1 / 17）；
> `npm run ci` → **`CI_EXIT=0`（15 步，步数未变）**；`npm run typecheck:tests` → **`exit=0`**；
> **真库 × 真 HTTP 探针** `node tools/_scratch/w2d-live-probe.mjs` → **12/12**（`PROBE_EXIT=0`；夹具自清、残留计数 0）；
> `npm run ci:db` → 上一轮 **`CIDB_EXIT=0`**（本轮未复跑：`db:verify` 会向账本写实验行且**删不掉**，
> 本轮只复跑其中的 `test:db` 与两条新证伪 ⑪⑫）。
> 另：**编译不过就不许跑测试**这条守卫**在三轮里各被真实触发过一次** —— W1-A 是一个"看起来无害"的变异
> （`if (false && …)`）因破坏类型收窄报 `TS18048`；W1-B 是在 guard 的判定分支上加 `&& verdict.code !== …`
> 破坏了 `verdict` 的类型收窄（`DENY` 分支没有 `.row`）报 `TS2339`；W1-C 又踩了同一条：
> `if (false && row.childId !== requestedChildId)` 把 `row` 的非空收窄短路掉，报 **`TS18047`**。
> 三次 runner 都直接拒绝执行（这正是我们要的行为：宁可红在编译，也不要红在"跑了一个不是要上线的产物"）。
> ★ 四次踩的是**同一类**教训：写证伪变异时**先确认它能编译**，否则"没点名"会被误读成脚本坏了（见第 17／18 条）。
> W2-C 换了个形态（不是类型收窄，是"代码不见了"）：把真适配器从分叉里**删掉**是最自然的变异，
> 但那会让它的 `import` 变成**未使用** ⇒ 撞 `noUnusedLocals` ⇒ 编译不过 ⇒ runner 拒绝跑 ⇒ 又一次"没点名"。
> 改用**两条分支对调**（两个 `import` 都仍在用）就立刻变红。
> 经验：**变异要挑那条"既编译得过、又正是要防的形态"** —— 二者缺一，证伪就变成了自欺。
> **W2-D 又记了两种新形态（都不是"编译不过"，所以前面那套守卫拦不住）**：
> ① **能编译、也红，但红在错的理由上** —— 把"单键 `findFirst({ where: { deviceId } })`"这条 ❌ 写法
> 放进**离线**变异里，替身**没有** `findFirst` ⇒ 撞 `... is not a function`：退出码非 0 却**没点名**
> （这一半只能交给真库的 ⑨）；真库 ⑨ 原先又红在一条**没有消息**的 `assert.equal` 上 —— 同样"没点名"。
> ⇒ 两条新纪律：**变异要挑"这个世界拦得住"的形态**；**断言必须带人话**（"红在错的理由上"与"没红"
> 在退出码上**看不出区别**，只有断言文本能区分）。
> ② **看时间才红**（假绿的证伪版）—— ⑥ 号变异第一版用 `Date.now()` 判断过期，被夹具的**固定时钟**
> `NOW`（2026-10-16T09:00Z）放过：实测退出码 **0**；把变异改成**写死同一个时钟**才变红。
> ⇒ **证伪脚本自己也需要确定性**（这比"变异写错"更隐蔽：它只在特定时刻、特定夹具下才暴露）。
> ★ 合并成一句：**变异要"编译得过 ＋ 正是要防的形态 ＋ 断言点得出名 ＋ 不依赖跑的时刻"**，四者缺一即自欺。

**完整流水线**（命令已就绪；**尚未接入 CI 平台** —— 选定平台后写成 workflow 文件即可）：

```
1. 前端 Taro:    npx tsc --noEmit -p tsconfig.json          # 类型检查（不产出）
                  npx tsc src/data/{store,seed,types}.ts src/utils/color.ts \
                      --outDir .tmp_test/dist --module commonjs --target es2017 \
                      --strictNullChecks --esModuleInterop --skipLibCheck   # run.js 要 require 的产物
                  node .tmp_test/run.js
2. 前端 Flutter: flutter analyze && flutter test
3. 后端:         cd backend && npm run ci
```

⚠️ **两处诚实标注（都不掩盖）**：
1. **第 1–2 步尚未接进 `npm run ci`** —— CI 平台未定（见待办 3），且前端产物不入库。
   补偿：`defects:check` 已把 C1 的**代码形态**与**回归用例是否还在**一并纳入对账 ——
   Taro 侧守卫必须由 `demoResetAllowed()` 派生；Flutter 侧 `allowDemoReset` 必须是可常量折叠的 `!_isReleaseBuild`，
   并由测试钉住「与判据 `demoResetAllowed()` 等价」；两侧构造函数都必须走空态初始化。
   于是「修复被回退」或「用例被删」，后端 CI 都会红（已用 2 个代码回退反例验证）。
2. **`run.js` 跑的是 `dist/` 产物，不是 `.ts` 源码** —— 产物陈旧就会"用旧代码考满分"。
   所以第 1 步的编译**必须现跑**（本条流水线如此写）；C1 收尾时删掉 `.tmp_test/dist` 全量重编复跑，
   16/16 与源码一致后才敢签字。

**一条不会失败的测试器等于没有测试器** —— D12 正是如此被瞒过很久的。
同理：**一个永远不会失败的检查项、一句永远不报错的 `REVOKE`、一个从不生效的权限收回，
都只是"看起来在做安全"**。这是本项目的头号教训。
## Git 记录规范（2026-10-12 建仓起生效）

仓库：`main` 单主线。**每个小步一个提交**，禁止把互不相干的改动混成一坨。

### 提交信息格式

```
<type>(<scope>): <一句话说清「改了什么」>

背景/为什么：
- …（缺陷编号 / 决策编号 / 文档章节）
验证证据：
- <命令> → <结果与退出码>
```

| type | 用途 |
|---|---|
| `fix` | 修缺陷（**必须附「能失败」的反向对照**） |
| `feat` | 新功能 |
| `docs` | 只改文档 |
| `test` | 只加/改测试 |
| `refactor` | 行为不变的重构（证据＝改前改后测试结果一致） |
| `chore` | 依赖、脚本、构建、仓库卫生 |
| `build` | CI / 构建配置 |

### 四条硬约束

1. **没有证据不算完成**：`fix` 类提交必须能贴出「改之前红、改之后绿」的两次真实输出；
   只写「已修复」的提交一律退回。
2. **共享状态操作顺序执行**：涉及数据库迁移、`git` 索引、构建产物的命令**不许并发**
   （曾因并发执行导致误报）。
3. **数据库链固定顺序**：`migrate dev → seed → 900_ledger_revoke.sql → db:verify`；
   `reset` 之后必须重跑后三步（`seed` 与 `REVOKE` **都不会自动补** —— 缺陷 13）。
4. **fail-closed 守卫优先**：凡有「必须满足否则不许继续」的前置条件
   （如真实 `.env` 不得进索引），写成命令里的守卫并 `exit 1`，而不是靠人记得。

### 入库 / 不入库

| 入库 | 不入库（`.gitignore` 已覆盖） |
|---|---|
| `docs/`、`contracts/`、双端源码、迁移 SQL、`package-lock.json`、`pubspec.lock` | `node_modules/`、`dist/`、`build/`、`.dart_tool/`、`.swc/`、`*.log`、`*.iml`、`.idea/` |
| `.env.example`（模板） | **`.env`（含真实口令，绝不入库）** |
| 手写验证脚本（`run.js` / `h5_*.js`） | 它们的产物：截图 `*.png`、`chrome-profile/`、探针日志 |
| 仓库级守卫脚本（`tools/defect-status.mjs`） | 一次性脚手架（补丁脚本 / 闸门日志 / 守门人证伪自测副本）放 **`tools/_scratch/`**：在仓库树内、可检索可复查，由根锚定规则 `/tools/_scratch/` 关在版本库外（工作区保持干净）。**不要**再放 `.git/` 里 —— 那是 git 内部目录，越界使用且重建即丢失 |

### 行尾策略（`.gitattributes`）

仓库内文本一律 **LF** 存储与检出；`*.bat` / `*.cmd` 保留 CRLF；二进制显式标记防止转换。
目的：Windows / Linux 混用时不再出现「整文件级 diff」的假变更。

### ⚠️ 建仓时拆掉的第一颗炸弹（记录在案，防止复发）

`kids_points_mp/.gitignore` 原第 9 行是 `.tmp_test/`（**整目录**忽略）。
但该目录里混着两类东西：产物（`dist/`、`chrome-profile/`、截图、日志）与
**手写验证脚本**（`run.js`、`h5_probe.js`、`h5_serve.js`、`h5_compat_check.js`）。
照原样建仓，这 **4 个脚本会静默消失** —— 不报错、不提示，正是本项目最忌讳的失败形态。

已改为只忽略产物（4 条精确规则），4 个脚本随首次提交 `35c0d62` 全部入库。
根 `.gitignore` 亦加了防复发注释：**gitignore 模式不区分层级**，
在根目录写 `.tmp_test/` 会再次命中该子目录。
