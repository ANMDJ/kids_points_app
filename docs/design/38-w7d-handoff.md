# W7-D 交接单 · 家庭数据删除（申请 / 7 天冷却 / 就地匿名化）

> 日期：2026-10-27　｜　上游：`37-w7c-handoff.md`（家庭数据导出）
> 规格来源：`02` §9.20（可导出 + 可删除）、`04` §5（可携带 / 可删除）、PRD §7 / §15

---

## 1. 一句话结论

`02` §9.20 的「删除」半边**已落地并且有真库证据**：

```
POST /family-deletion        {confirmed:true}
  → pending（冷却 7 天，随时可撤销）
POST /family-deletion/cancel → cancelled（历史保留，可重新申请）
worker（到期）               → executed（就地匿名化 + 摘要落库）
GET  /family-deletion        → none / pending / cancelled / executed + 摘要
```

匿名化的边界是**明确的**：抹掉「写了什么」，保留「发生了什么」。
流水的 `pointsDelta` / `balanceAfter` / 余额一字未动（02 §5.7 I5），
摘要把这些事实写出来，供家长与审计核对。

---

## 2. 契约（改这里必须同时改另外两处）

| 项 | 值 | 所在 |
|---|---|---|
| 动作 | `view_family_deletion` / `manage_family_deletion` | `backend/src/contracts/permission-matrix.ts`、`prisma/schema.prisma`、PRD §7 |
| 判定 | guardian **ALLOW** / child **DENY** | 同上 |
| 同意闸门 | **豁免**（两条都不挂 `ConsentGuard`） | `backend/src/contracts/consent-policy.ts` |
| 规模 | 40 动作 = 24 写 + 16 豁免 | `test/consent-policy.test.ts` |
| 冷却期 | **7 天**（常数，不做环境变量） | `src/deletion/deletion.repository.ts` |
| 二次确认 | 请求体必须是 `{confirmed:true}`（缺 / `false` / `"true"` 都 400） | `src/deletion/deletion.service.ts` |

**为什么删除要豁免同意闸门**：删除权与「同意是否生效」无关。撤回同意之后
仍然必须能删 —— 否则「撤回」就变成「数据被扣住，既不能用也不能删」，
与 04 §5 相反。真库用例 `deletion-db.dbtest.ts` 的同意行**故意是 withdrawn**。

---

## 3. 后端实现（`backend/src/deletion/`）

| 文件 | 职责 |
|---|---|
| `deletion.repository.ts` | 端口 / DTO 状态类型 / 冷却期常数 / 无库 501 |
| `deletion.policy.ts` | 纯规则：截止时刻、剩余天数（向上取整）、状态映射、摘要解析、`redactPayload()` |
| `deletion.prisma.repository.ts` | 申请 / 撤销 / 到期执行（**同一事务**，行锁 + `SKIP LOCKED`） |
| `deletion.service.ts` | 二次确认守门 + 注入时钟 |
| `deletion.controller.ts` | `GET` / `POST` / `POST cancel`（三道屏障，无 ConsentGuard） |
| `deletion.worker.ts` | 定时扫描到期行；单飞；失败不崩进程；配置有界 |
| `dto/request-deletion.dto.ts` | 只允许 `confirmed` 一个字段 |

### 3.1 表与迁移

- `FamilyDeletionStatus`（pending / cancelled / executed）
- `FamilyDeletionRequest`：`scheduledFor`（冷却期截止）、`summary`（执行证据）、
  `requestedByUserId`（谁申请的）；**一个孩子最多一条 pending**（部分唯一索引）
- 迁移：`prisma/migrations/20261027110000_family_deletion/`
- 有库装配自动获得 CRUD（900 脚本的 `ALTER DEFAULT PRIVILEGES`）

### 3.2 执行 = 就地匿名化

| 表 | 处理 |
|---|---|
| `Child` | 昵称 → `[已删除]`，年龄段 / 兴趣清空，`status=deleted`；余额保留 |
| `ChildMember` | PIN / 锁定计数 / restrictions 清空；除**申请人**外置 `removed`（申请人保留 active 以便读收据） |
| `PointRule` | 标题 / 条件 → `[已删除]`，软删 |
| `PointRuleVersion` | 标题 / 条件 → `[已删除]`，`changeNote=null`；**分数与版本号不动** |
| `Habit` / `Wish` | 标题 / 条件抹掉，软删 |
| `PointRecord` | `titleSnapshot` / `conditionSnapshot` / `note` 抹掉；**数值与 `balanceAfter` 不动** |
| `ApprovalRequest` | payload 递归抹字符串（保留 id / 数值 / 枚举键），`decisionNote=null` |
| `Notification` | 标题 → `[已删除]`，正文清空 |
| `GuardianConsent` | `ipHash` / `userAgentHash=null`；状态与版本保留 |
| `AuditLog` | **不改**（追加式）；另写 `family.deletion_executed` 一行，`after` = 摘要 |

**边界（诚实标注）**：审计日志里可能仍有历史文本（例如 `child.rename` 的
before/after），因为 02 §5.7 要求它不可改写。执行摘要的 `note` 明确写了
「账本流水与余额保留」，但没有逐一说明审计历史 —— 这是后续若要「连审计一起
抹掉」时必须先解决的设计问题（不是遗漏，是刻意不越权改写审计）。

### 3.3 列级授权（900 脚本）

删除要抹字，但 ③ 把 `PointRecord` / `PointRuleVersion` 整表 UPDATE 收走了。
W7-D 增加**列级**例外：

```sql
GRANT UPDATE ("titleSnapshot", "conditionSnapshot", "note") ON "PointRecord" TO kids_points_app;
GRANT UPDATE (title, condition, "changeNote") ON "PointRuleVersion" TO kids_points_app;
```

自检同时钉住两侧：文本列**必须**可写；`pointsDelta` / `balanceAfter` / `points`
**必须**仍不可写。`test-db/ledger-db.dbtest.ts` 组 G 也把这条边界写成可执行事实
（原来的 `note` 断言改成 `balanceAfter`，并新增「文本列可写」断言）。

---

## 4. 证据（本机实测）

| 命令 | 结果 |
|---|---|
| `backend npm run ci` | **CI_EXIT=0**；`npm test` **47 文件 / 830 用例全绿** |
| `backend npm run db:verify` | **ALL PASS**（含新增列级自检） |
| `backend npm run test:db` | **20 文件 / 287 用例全绿**（新增 `deletion-db.dbtest.ts`） |
| `flutter analyze` | **0 issues** |
| `flutter test` | **315/315**（新增 `family_deletion_test.dart` 19 条） |
| mp `npx tsc --noEmit` | EXIT=0 |
| mp `npx taro build --type weapp` | **EXIT=0** |
| mp `node .tmp_test/run.js` | ALL PASS（既有 91 条不回退） |
| mp `node .tmp_test/run-w7d.mjs` | **17/17** |

新增后端用例文件：
`deletion-policy`（13）、`deletion-http`（14）、`deletion-wiring`（17）、`deletion-worker`（6）、
`test-db/deletion-db`（22）。

---

## 5. 客户端

两端同构、同一口径：

1. 打开面板先 `refreshMembers()` 判角色（孩子不发注定 403 的请求）；
2. `GET /family-deletion`：pending 显示截止日 + 剩余天数 + 撤销按钮；
3. 申请：先展开后果说明，再点「确认删除」（Taro 再弹一次系统确认框）；
4. executed：逐行显示「哪类数据动了几行」+「保留 N 条流水与余额 M 分」+ 服务端 note；
5. 读失败**不清空**旧状态（一次断网不该把「将于 X 日删除」说成「从未申请」）；
6. 切账号 / 恢复演示数据会清空删除状态（`resetFamilyDeletion()`）。

文件：

- Flutter：`lib/models/family_deletion.dart`、`lib/data/{read_dto,read_mapper,read_api,write_api,app_store}.dart`、
  `lib/screens/sheets/family_deletion_sheet.dart`、`lib/screens/profile_screen.dart`、`test/family_deletion_test.dart`
- 小程序：`src/data/{types,read_dto,read_mapper,read_api,write_api,store}.ts`、
  `src/sheets/FamilyDeletionSheet.tsx`、`src/sheets/sheets.scss`、`src/pages/profile/index.tsx`、`.tmp_test/run-w7d.mjs`

---

## 6. 已知限制 / 下一步

1. **执行时刻依赖 worker 在跑**：`FAMILY_DELETION_WORKER_ENABLED=false` 或进程没起时，
   pending 永远不执行；`GET` 会显示「即将执行（等待后台任务）」，不会谎称已删。
2. **审计历史不抹**（见 §3.2 边界）；若要抹，必须先解决「追加式审计」与「删除权」的冲突。
3. **只删一个孩子**的家庭数据：`POST` 的对象是会话里的 `childId`；「删除家长账号」
   （跨孩子的自然人注销）不在本轮范围。
4. **并发场景只用真库单进程验过**：`SKIP LOCKED` 的多 worker 竞争没有专门压测；
   部分唯一索引挡住了第二条 pending，但没有「两个 worker 同时抢同一行」的用例。
5. **前端入口都在「我的」页**，本轮没有做引导流程里的删除入口（L5 法务文本仍未定稿）。
