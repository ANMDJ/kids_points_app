# W7-C 交接单 · 家庭数据导出（`GET /export`，2026-10-27）

> 这一轮兑现的是 `02` §9.20 / `04` §5 的**「可携带」**：家长随时能把这一个孩子的
> 全部数据**打成一份文件带走**。在此之前，那些数据只存在于库里和逐屏接口里 ——
> 那是「能看」，不是「能带走」。

## 1. 一句话结论

| 层 | 状态 |
|---|---|
| 后端 `GET /export` | ✅ 新动作 `export_family_data`（**guardian ALLOW / child DENY**）＋ 迁移 `20261027090000_export_action`；**不挂 `ConsentGuard`**（撤回同意后仍可用） |
| Flutter | ✅ `fetchExport` / `FamilyExportDto` / `FamilyExport` / `AppStore.loadExport` / 「我的 → 导出家庭数据」面板 |
| 小程序 | ✅ `fetchExport` / `FamilyExportDto` / `mapFamilyExport` / `loadExport` / `ExportSheet` / 「我的」入口 |
| 真库 | ✅ `test-db/export-db.dbtest.ts` **19/19 通过**（`npm run test:db` 19 文件 / 265 用例全绿，`npm run ci:db` EXIT=0）；顺带修掉 W7-A 遗留的「真库夹具无同意行」回归 |

## 2. 契约与权限

- 路由：`GET /export`，`@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`
  与 `/home` 同序；`@RequireAction('export_family_data')`。
- **不复用 `view_records`**：那个孩子也能用。一次导出包含全家成员与全部流水，
  挂在孩子可用的读动作上等于让「看一眼自己的分」顺带变成「批量带走全家数据」。
- `childId` **只来自会话**（`RequestWithActor`），query 里的 `childId` 不作数 ——
  否则等于让客户端指定「导谁家」。
- `contracts/consent-policy.ts` 把 `export_family_data` 放进**豁免集合**：
  导出不改变任何一行，而且撤回同意后**必须**仍然可用。归进写侧会让
  「撤回」变成「数据被扣住」。清单规模因此变成 **24 写 / 14 豁免 = 38 动作**。
- 响应头：`Content-Disposition: attachment; filename="family-export-<childId>-<YYYY-MM-DD>.json"`
  （**纯 ASCII**：中文昵称进文件名需要 RFC 5987 编码，跨平台容易乱码）＋
  `Cache-Control: no-store`（这份文件含全家信息，绝不能被中间层缓存）。
- 无库装配 ⇒ **501 `EXPORT_MODEL_NOT_IMPLEMENTED`**，绝不返回空文档冒充成功 ——
  一份空文件会被家长当成「孩子没有数据」。

## 3. 文件形状（`schemaVersion = 1`）

```
{ schemaVersion, generator, generatedAt,
  child: { id, name, pointsBalance },
  summary: { counts: {…9 段…}, totals: {records, approvals, auditLogs},
             truncated, truncatedSections },
  members, rules, ruleVersions, habits, wishes,
  records, approvals, consents, auditLogs }
```

- `summary.counts` 是**本文件实际包含**的条数（九段齐全，0 也写出来）；
  `summary.totals` 只含三张会截断的大表（流水 / 审批 / 审计）。
- 单次上限 `EXPORT_LIMITS`：`records 50000`、`approvals 5000`、`auditLogs 5000`、
  `small 2000`。**不做成环境变量** —— 调大等于调大单次请求的内存峰值。
- 任一段被截断 ⇒ `truncated: true` 且 `truncatedSections` 列出段名。
  客户端把这条当成**硬约束**校验：`truncated` 与 `truncatedSections` 不自洽的文件
  一律按坏响应处理（`MALFORMED_RESPONSE`），不允许「说不清哪段缺了」的文件混过去。

## 4. 后端实现

| 文件 | 职责 |
|---|---|
| `src/export/export.controller.ts` | 路由 / Guard / 动作 / 两个响应头 |
| `src/export/export.service.ts` | 调端口取快照 → `buildExportDocument()` |
| `src/export/export.document.ts` | 纯函数：快照 → 文档（版本号、段顺序、`summary` 计算） |
| `src/export/export.repository.ts` | `EXPORT_REPOSITORY` 令牌 / `EXPORT_LIMITS` / 端口类型 |
| `src/export/export.prisma.repository.ts` | 真库实现：九段查询 + 每段 `take: limit + 1` 判截断 |
| `src/export/export.module.ts` | `register({ hasDatabase })`：有库真查、无库 501 |

`take(limit)` 的用意：三张大表先 `count()` 再按上限取行 —— `count` 让文件能诚实写出
「共 N 条，本文件含 M 条」（`summary.totals` 与 `counts` 的差就是缺的部分）；
小集合取 `limit + 1` 条判定是否截断，不额外计数（它们正常只有几十行）。

## 5. 客户端（两端同构，各自独立实现）

共同的三条硬规则：

1. **只解析文件头 + 摘要**（child / schemaVersion / counts / totals / truncated…），
   **从不**把九段正文拆成模型再拼回去。后端加字段时客户端不需要跟着改三处。
2. **复制的是服务端原文**：`fetchExport` 同时保留原始文本与解析结果，`rawJson`
   逐字存进 store，复制按钮直接写剪贴板 —— 不是「按本地模型重新序列化」。
3. **失败不清空上一次的文件**：403 照实显示「没有权限」，不画成「没有数据」；
   预览模式直接进入 ready 空态（不编一份假 JSON，否则家长会以为真备份过了）。
   刷新失败而手里还有旧文件时，面板**同时**给出错误卡片与「下面是上一次成功生成的文件
   （生成时间）」—— 只显示旧文件会让家长以为刚生成过，只显示错误又会让刚复制过的文件消失。

两端都有的细节：

- **先 `refreshMembers()` 再拉导出**：角色只能从 `GET /members` 的 `isSelf` 行得知；
  孩子点进来**不发**导出请求（明知 403 的探测既慢又会把权限问题画成加载失败），
  只显示「请让家里的家长操作」。
- **单飞**：`isExportBusy` 期间再点只返回，不产生「两份生成时间不同的文件」。
- 未知 `schemaVersion`（> 1）**照样能复制**，但面板提示「这份文件来自更新的服务端，
  当前界面可能认不全」—— 不假装懂。
- 面板写明「导出不受同意状态限制：即使撤回了监护人同意，也仍然可以导出」。
- 小程序 `store.resetExport()` 在重置 / 切身份时清空 —— 否则新账号还能复制到
  上一个家庭的文件。

## 6. 证据（可复现）

| 命令 | 结果 |
|---|---|
| `cd backend && npm test` | **43 文件 / 780 条全绿**（新增 `export-http` 9 条 ＋ `export-wiring` 23 条） |
| `cd backend && npm run typecheck && npm run typecheck:tests` | EXIT=0 |
| `cd backend && npm run honesty:probe` | 5 项全 PASS（§7 表格 38 行 == 矩阵 38 动作） |
| `flutter analyze --no-pub` | 0 issue |
| `flutter test --no-pub` | **296/296**（新增 `test/export_test.dart` 22 条） |
| `cd backend && npm run ci` | **CI_EXIT=0**（11 步全 PASS；`contracts:emit` 已重新生成 38 个动作） |
| `kids_points_mp && npx tsc --noEmit` | EXIT=0 |
| `kids_points_mp && npm run build:weapp` | EXIT=0 |
| `kids_points_mp && node .tmp_test/run.js` | **91 PASS / ALL PASS**（数据层旧用例） |
| `kids_points_mp && node .tmp_test/run-w7c.mjs` | **12/12 PASS**（本轮新建：DTO 形状与截断自洽 2 ／ 映射不重算 `counts` 1 ／ 真 `ReadApiClient` 的原文保留·对象退化·错误归一 3 ／ `loadExport` 成功·单飞·失败保留·坏文件·预览空态·重置清空 6） |
| `cd backend && npm run test:db` | **19 文件 / 265 用例全 PASS**（`export-db.dbtest.ts` **19/19**：九段与库行一一对应、软删仍在、无 openId / pinHash / ipHash / idempotencyKey、跨孩子零串入、撤回后导出 200 而写入 403） |
| `cd backend && npm run ci:db` | **CIDB_EXIT=0**（`db:verify` ＋ 真库用例 ＋ `test:canfail:db` 11 项全 PASS） |

### 6.1 顺带修掉的回归：真库套件的夹具从来没有「同意」行（W7-A 遗留）

`npm run test:db` 第一次真跑起来时红得很整齐：records / rules / habits / approvals×4 /
notifications / push-e2e 的写用例**全部**停在同一个 403 上 ——
`{"code":"CONSENT_REQUIRED","details":{"status":"none","action":"adjust_points"}}`。

根因不在 W7-C：W7-A 把 `ConsentGuard` 接到了 24 个写动作上（`none` **同样拦**，
不自动补假同意），而真库套件的 `seed()` 只造 `Child` / `User` / `ChildMember` /
`DeviceSession`，**一次都没造过 `GuardianConsent`** —— 闸门按设计拦下，套件们却还在
按「W7-A 之前」的假设跑。W7-A 那一轮手上没有库（CI 是无库的），所以这个断层一直没被看见。

处理：新增 `test-db/support/consent-fixture.ts` 的
`grantConsentFor(prisma, [[childId, guardianUserId], …])`，在 9 个套件的 `seed()` 里
**显式**给「会走写路径」的孩子授一次 granted（`consentVersion` 取 `2026-10-draft`，
与 `CONSENT_TEXT_VERSION` 对齐）。三处口径要看清：

- `records` 的 `gone`、`rules` 的 `other` **也授**：「已删孩子 ⇒ 404」「跨孩子 ⇒ 404」
  是租户隔离的断言，缺同意会把 404 换成 403，等于用闸门盖住了泄漏检查。
- 「屏障一必须 403」的角色（孩子本人、非成员、`removed` 成员）**不授** ——
  那份 403 必须来自权限 / 成员屏障，不能被「同意」顺手改成 200 或改成同一种 403。
- `export-db` **不用**这个夹具：它自己写撤回行，好让「撤回后导出仍 200、写入 403」
  两件事同时成立。

`test/export_test.dart` 钉住的四件事：完整性字段自洽、`rawJson` 逐字保留、
`loadExport` 的单飞 / 失败保留 / 预览模式、以及面板在
家长 / 孩子 / 截断 / 403 四种状态下的**文案与请求次数**。

## 7. 边界（没做的事，不粉饰）

- **真库侧只覆盖「没截断」的形状**：`export-db` 断的是 `truncated === false`、`truncatedSections === []`
  （真库里造 5 万条流水不现实）。于是「截断真的发生时 `totals` 与 `counts` 的差」
  目前只有 `export-wiring` 的**假仓库**证据；真 SQL 的 `count()` ＋ `take(limit)` 路径
  没有被真实截断触发过。
- **大文件的内存峰值没有实测**：上限（5 万流水）是按「一次同步序列化」估的，没在真机压力下量过。
- **`02` §9.20 的「删除」仍未实现** —— 可携带做了，可删除没做。
- **小程序侧只有数据层的运行时用例，UI 层仍只有编译证据**：`fetchExport` /
  `mapFamilyExport` / `loadExport` 由 `.tmp_test/run-w7c.mjs` **12/12** 覆盖（截断自洽、
  `rawJson` 逐字、403 / 501 / 网络错误归一、单飞、失败保留旧文件、预览空态、重置清空）；
  但 `ExportSheet.tsx` 的渲染分支（孩子视角 / 截断提示 / 「上一次生成的文件」横幅）
  仍只有 `tsc` ＋ `build:weapp` 两条编译证据 —— Node 里没有 React 运行时可跑，
  这一点与 Flutter 侧不同：`test/export_test.dart` 连面板文案与请求次数一起钉了 22 条。
- **复制提示里的「文件大小」是真实 UTF-8 字节数**（`rawJson.length` 是 UTF-16 码元数，
  含中文昵称 / 规则标题的文件会被说小三分之一以上）。Flutter 侧由 `export_test.dart`
  的复制用例钉住「提示里的大小 == `utf8.encode(rawJson).length`」；小程序侧
  `utf8ByteLength()` 是同一公式，但**没有**运行时断言（它是 `.tsx` 里的模块内私有函数，
  Node 侧取不到）。
- 没有 ZIP / CSV 打包、没有后台任务与进度推送：一次请求同步生成，大流量家庭会等待几秒；
  上限已按内存峰值取舍。
- 没有限流 / 审计「谁导出过」的独立事件（导出只读，不改任何一行）。
- 客户端没有「保存到相册 / 文件系统」：Flutter 写剪贴板，小程序写剪贴板
  （`setClipboardData`）—— 落盘交给用户的系统能力。

## 8. 下一步

1. 真库造一次「截断」场景（把 `EXPORT_LIMITS` 用依赖注入换小，或直接灌 5 万零 1 条流水），
   把 `totals` / `counts` / `truncatedSections` 的三者差额也钉在真 SQL 上。
2. W7-D：数据删除（与导出共用「全家数据」口径，但**删除需要二次确认 + 冷却期**）。
3. 若真实家庭规模逼近上限：先加「分段下载 / 游标续传」，再考虑调大 `EXPORT_LIMITS`。
