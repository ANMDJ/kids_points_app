# 阶段 W4-A 交接单 · 只读后端（`GET /home` / `GET /records`）

> ## ✅ 已收口（2026-10-18）
>
> 本单与 W4-A 的代码、用例、文档**同批提交**；下面每个数字都来自当轮真实命令输出。
>
> | 闸门 | 结果 |
> |---|---|
> | `cd backend && npm run ci` | ✅ **`CI_EXIT=0`（15 步）** |
> | `cd backend && npm test` | ✅ **16 个文件 / 286 条全部通过** |
> | `cd backend && npm run test:db` | ✅ **6 个文件 / 91 条全部通过** |
> | `cd backend && npm run build` | ✅ **`BUILD=0`** |
> | 数据库 | **本阶段没有新增迁移**：读的字段在 W0 schema 中已存在 |
>
> **给**：接手 W4-B（双端接 `GET /home` / `GET /records`）的下一个会话。
>
> **一句话状态**：客户端现在有真实的只读数据源了；**但写端点（规则 / 习惯 / 心愿 / 邀请）仍未建**，
> 双端 `AppStore` 也还没换成 HTTP。不要把本单的绿灯读成「双端已接 API」。

## 1. 这一步在补什么

W3 结束时后端只有审批的三条写端点。双端 `AppStore` 的首页、规则、心愿、记录页全部来自
`seed_data.dart` / `seed.ts` —— **一个只写不读的后端**无法支撑「双端接 API」：
客户端就算把打卡换成 HTTP，刷新后仍然读不到任何东西。

W4-A 先落**读路径**（不写任何东西，因此没有 `Idempotency-Key`、没有 202）：

| 端点 | 动作（矩阵） | 用途 |
|---|---|---|
| `GET /home` | `view_child_points` | 首页 / 规则页 / 心愿页 / 我的页共用的一份快照 |
| `GET /records` | `view_records` | 记录页：分类筛选 + 分页 |

两个动作对 `guardian` / `child` 都是 `ALLOW`，权限仍然只来自 `permission-matrix.ts`。

## 2. 代码落点

| 文件 | 职责 |
|---|---|
| `backend/src/read/read.repository.ts` | `ReadPort` ＋ 行形状 ＋ 无库 501 实现（**绝不返回空快照/空页**） |
| `backend/src/read/read.prisma.repository.ts` | 真 Prisma 适配器：软删过滤、冲正剔除、`limit + 1` |
| `backend/src/read/read.mapper.ts` | 行 → 响应契约；**唯一**做「规则分值带符号」的地方 |
| `backend/src/read/read.service.ts` | 调端口；孩子缺失 ⇒ 统一 404 `CHILD_NOT_FOUND` |
| `backend/src/read/read.controller.ts` | 三 Guard ＋ 两个 `@Get`；`childId` 只取 `req.kpChildId` |
| `backend/src/read/dto/list-records.query.ts` | `category` 封闭枚举；`limit` 1–200、默认 50 |
| `backend/src/read/read.module.ts` | `register({ hasDatabase? })`：有库 ⇒ Prisma 适配器；无库 ⇒ 501 |
| `backend/src/app.module.ts` | 注册 `ReadModule.register()`（按环境推断） |

## 3. 响应契约（要点）

### 3.1 `GET /home`

```
{ child: { id, name, pointsBalance },
  goodHabitCount, rewardCount,
  habits: [...], rules: [...], wishes: [...] }
```

- **不含展示串**：`subtitle` / `limitText` / `amountText` 一律由客户端派生（03 E17/E19）。
- 枚举保持库内拼写（`coverStyle: "A"`、`direction: "penalty"`），不在服务端驼峰化。
- `rules[].points` **带符号**：库里恒为正，`penalty` 在这里变成负数（A1）。
- 只含 `status = active` 的习惯 / 规则 / 心愿；软删项属于回收站，不是「今天的习惯」。

### 3.2 `GET /records?category=&limit=`

```
{ records: [{ id, title, points, createdAt, category, source, operatorRole,
              note, habitId, ruleId, ruleVersion, wishId,
              reversesRecordId, reversedAt, balanceAfter }],
  limit, hasMore }
```

- 排序 `(createdAt desc, id desc)`：同一毫秒的记录也有稳定次序，分页不漏行。
- `hasMore` 由适配器 `take = limit + 1` 判定，**不靠**「本页正好满」猜。
- `createdAt` / `reversedAt` 是 ISO-8601 字符串。
- 被冲正的表扬**仍在记录列表里**（账本 append-only），只是不计入 `goodHabitCount`。

> **W4-B 补充（2026-10-19）**：本节的 `hasMore` 当时没有配套游标，客户端无法取下一页。
> W4-B 已给入参加 `cursor`、响应加 `nextCursor`，并补齐键集翻页；口径以
> [`14-w4b-handoff.md`](./14-w4b-handoff.md) 为准。

## 4. 三条容易读错的口径

| 字段 | 口径 | 为什么 |
|---|---|---|
| `goodHabitCount` | `category='praise'` 且 `source != 'correction'` 且 `reversedBy: none` | 撤销打卡后战绩必须回落，否则与客户端 `checkedCountToday()` 矛盾 |
| `rewardCount` | `Wish.redeemed = true` 的条数 | A5：手动加分被算成兑换是既有缺陷；软删只影响列表，不抹掉已经发生的兑换 |
| `rules[].points` | 库内无符号，mapper 按 `direction` 加符号 | A1：直接下发会让扣分显示成 `+5` |


## 5. 屏障与状态码

Guard 顺序与 `/approvals` **逐字相同**（身份 → 资格 → 矩阵＋收紧）：

| 情形 | 结果 |
|---|---|
| 缺 `x-kp-device-id` / `x-kp-child-id` | `401 UNAUTHENTICATED`，端口**零调用** |
| 会话不存在 | `401 SESSION_NOT_FOUND`，端口**零调用** |
| 会话存在但不是该孩子成员 | `403 MEMBER_NOT_FOUND`，端口**零调用** |
| 成员位还在、`Child` 行已软删 | `404 CHILD_NOT_FOUND`（两个端点一致） |
| `?limit=0` / `?limit=201` / 未知分类 / 未知键 | `400`，且**不查库** |
| 无库装配 | `501 READ_MODEL_NOT_IMPLEMENTED` |

★ 绝不从 query / body 取 `childId`：那等于让客户端决定读谁的数据，
而权限校验的是会话里的孩子 —— 最糟的一类越权。`/records` 的 DTO 只白名单
`category` / `limit`，其它键（包括 `childId`）被 `forbidNonWhitelisted` 打成 400；
`/home` 不接受查询参数，传了也不采信。

## 6. 三层证据（缺一层就可能是假绿）

### 6.1 `backend/test/read-http.test.ts` —— 真 HTTP、假端口

| 组 | 钉住什么 |
|---|---|
| A | 默认装配（未注入端口）⇒ 两个端点都 501，**不是 200 + 0 分 / 空数组** |
| B | 缺头 / 无会话 / 非成员 ⇒ 401、403，且假端口的调用计数为 0 |
| C | `GET /home`：两角色可读；`penalty 5 ⇒ -5`；无展示串；孩子缺失 ⇒ 404 |
| D | `GET /records`：默认 limit 50；category / limit 原样交给端口；字段映射；非法入参 400 且不查库 |

### 6.2 `backend/test/read-wiring.test.ts` —— 真装配、假 Prisma

| 组 | 钉住什么 |
|---|---|
| A | `resolveReadRepositoryClass` 映射互斥；有库 import `PrismaModule`，无库**不** import；501 实现两个方法都抛 |
| B | `loadHome`：`Child` 用 `(id, status: active)`；三张配置表只查 active；计数排除 `correction` 与已冲正；`sourceRuleId → ruleId`；孩子缺失 ⇒ `null` 且不查其它表 |
| C | `listRecords`：`where` 只带 `childId`（或再加 category）；`take = limit + 1`；多取一条 ⇒ `hasMore`；孩子缺失 / 软删 ⇒ `null` 且**不查** `pointRecord` |

这一层存在的理由：离线 HTTP 用例里的假端口只能说「controller 把参数递出去了」，
不能证明 Prisma 的 `where` / `take` 写对了。真库用例又太贵、覆盖不了每个分支 ——
假 Prisma 捕获实参正好补中间那段。

### 6.3 `backend/test-db/read-db.dbtest.ts` —— 真库 + 真 `AppModule` + 真 `fetch`

| 组 | 钉住什么 |
|---|---|
| A | 有库装配绑到 `PrismaReadRepository`（不是 501） |
| B | `/home`：软删习惯/规则/心愿不出现；冲正后 `goodHabitCount` 回落；`rewardCount` 只数已兑换；扣分规则为负 |
| C | `/records`：分类过滤；分页 `limit` / `hasMore`；被冲正记录仍列出；跨孩子隔离 |
| D | 守卫：无会话 401、非成员 403、跨孩子会话 401、已软删孩子 404（**两个端点同码**） |

真库套件沿用既有约定：`dbtest-<run>` 唯一 ID、**不清理数据**（账本 DELETE 已 REVOKE、
FK 为 Restrict）、`reversedAt` 只在 INSERT 时写入。跑一次留一批行，这是账本类项目的正常代价。

## 7. 真库抓到、离线用例没抓到的 bug

**现象**：对 `status = 'deleted'` 的孩子，`GET /home` 返回 `404 CHILD_NOT_FOUND`，
`GET /records` 返回 **`200 { records: [], hasMore: false }`**。

**为什么离线用例漏了**：`read-http` 用假端口，假端口不认识「孩子已删」；
`read-wiring` 原先只验证 `listRecords` 的 `where` / `take`，没验证「先确认孩子还在」。

**为什么危险**：这不是「少一个 404」，而是**两个端点对同一事实给出相反答案**。
客户端会认为「这个孩子只是还没有记录」，继续展示 0 分首页或空白页 ——
**失败被装扮成正常**，正是本项目最忌讳的形态。

**修法**（三处一起改，缺一处就回退）：

1. `ReadPort.listRecords` 返回 `RecordPageRow | null`；
2. `PrismaReadRepository.listRecords` 先 `child.findFirst({ id, status: 'active' })`，
   查不到直接 `null`，**不查** `pointRecord`；
3. `ReadService` 用同一个 `childNotFound(childId)` 把 `null` 翻成 404 ——
   `/home` 与 `/records` 的 404 形状因此**由一处产生**。

**反回退断言**：`read-wiring` 组 C 最后一条明确要求「孩子不存在时 `pointRecord.findMany` 调用次数为 0」。
只断言返回 `null` 不够 —— 实现可以「先查一遍流水再返回 null」，那仍然是白跑一次全表扫描。


## 8. 防复发坑（本阶段真实踩到 / 验证过）

1. **「读」也会制造假象**：返回 `[]` 比返回 501 更难发现错误。无库必须 501，
   孩子不存在必须 404 —— 两者都不许用空数据兜底。
2. **端口签名是契约，不是实现细节**：`listRecords` 从 `RecordPageRow` 改成可空，
   必须同时改端口、适配器、service、两层假实现与全部调用点；`tsc` 会抓，
   但**测试里的 `assert.ok(page !== null)` 是让「可空」不外溢到断言里的关键**。
3. **`limit + 1` 只能用来判 `hasMore`**：返回前必须把多取的那条切掉，
   否则客户端会看到 51 条却被告知 `limit = 50`。
4. **冲正与软删是两种语义**：冲正记录要留在列表（append-only 账本），
   只是不再计数；软删的配置项连列表都不出现。混为一谈会同时破坏审计与首页。
5. **`rewardCount` 不是「兑换流水条数」**：`request_redeem` 被批准会写流水，
   但累计兑换必须按 `Wish.redeemed` 数 —— 否则同一次兑换在重试/补偿时被数两次。
6. **规则分值符号只在一处转换**：适配器保持库内正值，mapper 加符号。
   若适配器也加一次，客户端会收到 `--5 = 5`；若 mapper 不加，扣分显示成 `+5`（A1 回归）。
7. **不要给只读端点加快照缓存来「优化」**：本阶段没有任何缓存，客户端拿到的永远是当前账本；
   将来要加必须显式设计失效条件，否则撤销打卡后首页会长期显示旧战绩。
8. **文档里的链式命令会漂移**：本单只写「命令 → 当轮结果」，不复制 `package.json` 的步骤列表；
   真实基线以 `npm run ci` 的输出为准。

## 9. 仍未落地（交接时必须知道）

| 项 | 状态 | 影响 |
|---|---|---|
| 规则 / 习惯 / 心愿 / 邀请 **写端点** | ❌ 未建 | 双端仍不能通过 API 创建或修改这些对象 |
| 双端 `AppStore` 接 HTTP | ❌ 未做（W4-B） | 首页/记录页仍读 `seed_data.dart` / `seed.ts` |
| 设备凭据生产验证 | ❌ 仍 503 | 生产环境无法建立会话，只读端点也拿不到数据 |
| 会话刷新 / PIN 切换 / 15 分钟锁 | ❌ 未做 | 长会话与家长切换场景不可用 |
| 首页快照的缓存 / ETag | ❌ 刻意不做 | 每次刷新多几次查询，换取「永不显示旧战绩」 |
| `correction` 流水的产生入口 | ❌ 未建 | 只有种子/测试能造出冲正，真实用户还撤销不了打卡 |

## 10. W4-B 接手顺序（建议）

1. **先接 `GET /home`**：它是四个页面共用的快照，改一处就能让首页/规则/心愿/我的页同时有真实数据。
   客户端只做「DTO → 现有模型」的 mapper，不要把服务端字段改名迁就 UI。
2. **再接 `GET /records`**：先只做「全部 + 默认 50 条」，确认分页与 `hasMore` 的交互，
   再加分类标签。分类值直接用 `praise / exchange / adjust`，不要另造中文枚举。
3. **处理 401/403/404/501 四种失败**：501 只能在无库开发环境出现，
   UI 必须显示「后端未接数据库」而不是空列表；404 要能回到孩子选择页。
4. **最后才改写路径**：写端点未建之前，打卡等动作仍走本地状态；
   不要在只有读 API 的情况下假装「已全量接后端」。
5. **每接一个页面补一条能失败的用例**：至少覆盖「接口 500 / 空数据 / 真实数据」三态，
   否则又会出现「页面能开＝接好了」的假绿。

## 11. 复跑与排障

```bash
cd backend
npm run ci          # 15 步，不需要数据库；期望 CI_EXIT=0
npm test            # 16 文件 / 286 条
npm run test:db     # 6 文件 / 91 条（需要活库与已 seed 的库）
npm run build       # nest build
```

真库套件跑不动时，按既有顺序检查（**不要跳步**）：

```
migrate dev → seed → 900_ledger_revoke.sql → db:verify
```

- `501 READ_MODEL_NOT_IMPLEMENTED`：装配时 `hasDatabase=false`。检查 `.env` 是否被
  `main.ts` 第一行加载、`DATABASE_URL` 是否为空；离线用例出现 501 是**预期**。
- `404 CHILD_NOT_FOUND` 但孩子明明存在：确认 `Child.status = 'active'`；
  软删后成员位仍在是正常数据形态，不是装配错误。
- `hasMore` 永远 `false`：先看适配器是否真的 `take = limit + 1`，
  再看测试里假 Prisma 返回的行数是否够。
- `goodHabitCount` 比预期多：检查是否漏了 `reversedBy: none` 或 `source != correction`。

## 12. 签字

- 代码：`backend/src/read/**` ＋ `backend/src/app.module.ts`
- 用例：`backend/test/read-http.test.ts`、`backend/test/read-wiring.test.ts`、
  `backend/test-db/read-db.dbtest.ts`
- 证据：`npm run ci` → `CI_EXIT=0`；`npm test` → 286/286；`npm run test:db` → 91/91；`build` → 0
- 未新增迁移；未修改权限矩阵；未放宽任何既有闸门。

