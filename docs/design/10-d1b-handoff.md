# 阶段 D-a 交接单 · `D1b` 监护关系 `relation` 升枚举（`RelationKind`）

> ## ✅ 已收口（2026-10-13）
>
> 本单与 D-a 的实现**同批完成**（不像 `07` / `08` 是"动手前先写"的提案单）；
> 第一节起是**当时的前提与判断**，收口证据全部可复跑。
>
> | 闸门 | 结果 |
> |---|---|
> | `cd backend && npm run ci` | ✅ **`CI_EXIT=0`（10 步）** —— 新增第 8 步 `relation:check` |
> | `node tools/relation-kind-check.mjs` | ✅ **`ALL PASS` 5/5**（三处取值逐字相等、迁移保数据、文档已改口） |
> | `npx prisma migrate deploy`（走**所有者**连接串） | ✅ 应用 `20261013143300_relation_kind_enum` |
> | `npx prisma migrate status` | ✅ `Database schema is up to date!`（2 个迁移） |
> | 迁移链：`npm run seed` → `900_ledger_revoke.sql` → `npm run db:verify` | ✅ 18 条模板 / REVOKE 到位 / **`ALL PASS`（I5 仍生效）** |
> | **真实库**反向探针（`relation='sister'`） | ✅ 被枚举拒绝：`对于枚举"RelationKind"的输入值无效` |
> | **真实库**正向对照（`relation='father'`） | ✅ 只因**外键**失败（证明上面那条的拒绝理由确实是枚举） |
> | 前端未改动，仍复跑 | ✅ `run.js` **27/27**；`flutter analyze` **0 issue**；`flutter test` **41/41** |
>
> **证伪：15 例全绿** —— 5 项检查 × 9 个反例（每例"红且**只**点名自己"）＋ 3 个控制例
> ＋「真文件 sha256 逐字节未变」＋「清理副本后重跑回绿」。逐条见 §4。
>
> **三次自我纠正**都发生在**自测脚本 / 闸门脚本**里，不在产品代码里（与 C5 §4 同源）。

> **给**：接手 `D3b`（阶段 D-b）或 `04` 首启引导的下一个会话。
> **一句话状态**：`RelationKind` 的取值**三处手抄**已被闸门钉住；D-a **没动任何前端代码**
> （前端此刻不写 `relation`），所以闸门 ④ 是"防将来"的，不是"防现在"的 —— 别把它的绿灯读成"写入路径已验收"。

## 1. 这一步在修什么

| | |
|---|---|
| 决策号 | **`D1b`**（`06` §3.1，W0 逐条裁定时**本轮新立**，不是原 D1–D10 里的一条） |
| 原文 | `UserChildRelation.relation`：自由字符串 → 枚举，**升级为 `RelationKind`** |
| 当时状态 | `relation String`（`schema.prisma`）—— 建库那一次就是这么建的 |
| 落地阶段 | **D-a**：「1 enum + 1 字段 + 迁移」 |

`String` 的病灶**不是"类型不好看"**，而是它把两类错误一起放行了：

1. **写错没人拦**：`'fathre'` / `'Father'` / `'dad'` 全能写进库，而查询侧只会拿 `'father'` 去比。
2. **两端各写各的**：客户端与服务端都会写这一列时，取值集合就成了**口头约定**。

这跟 **D9**（图标名三份手抄、三端编译器都不比对）是**同构**的：真相存在于多处、却没有一处能报警。

## 2. 三处手抄，与一个只有本步才有的坑

**取值：`father / mother / grandparent / other`**（来源：原 schema 里那行注释 `/// 关系描述：father / mother / grandparent / other`；
C5 的教训是"取值一旦手抄就必须钉住"，故这次把它变成**可执行契约**）。

| # | 位置 | 谁在读它 |
|---|---|---|
| ① | `schema.prisma` 的 `enum RelationKind` | Prisma → 生成迁移、生成客户端类型 |
| ② | 同文件 `UserChildRelation.relation` 的**注释** | 人（下一个写 API 的人） |
| ③ | 迁移 SQL 的 `CREATE TYPE "RelationKind" AS ENUM (...)` | **数据库**（真正的强制点） |

**没有加第四份**：`02` §1 只画了关系图，本轮**故意不在 `02` 补一张取值清单** ——
每多抄一份就多一个漂移面，而闸门只比对这三处。要改取值，改 ① 并同步 ②③。

**坑（本步独有）**：`String` → 枚举时，Prisma 默认生成的是

```sql
ALTER TABLE "UserChildRelation" DROP COLUMN "relation",
ADD COLUMN     "relation" "RelationKind" NOT NULL;
```

它**自带警告**：*No cast exists, the column would be dropped and recreated, which cannot be done if
there is data*。也就是说：**只要表里有数据，这一列就被清空，而且整个过程不报错**
（本机此刻 0 行，所以"看起来没事"）。因此手工改成：

```sql
ALTER TABLE "UserChildRelation"
  ALTER COLUMN "relation" TYPE "RelationKind"
  USING "relation"::"RelationKind";
```

① 保留既有取值；② 若库里存在不在枚举里的值，迁移**当场失败**而不是把列抹掉 —— **fail-closed**：
宁可迁移不过，也不要静默丢数据。闸门 ③ 钉住的就是这条（不许 `DROP COLUMN` / `ADD COLUMN`）。

## 3. 落地清单（文件级）

| 文件 | 改了什么 |
|---|---|
| `backend/prisma/schema.prisma` | 新增 `enum RelationKind`（4 值，带"三处手抄"说明）；`UserChildRelation.relation` 由 `String` → `RelationKind`（注释成为第 ② 份清单） |
| `backend/prisma/migrations/20261013143300_relation_kind_enum/migration.sql` | `CREATE TYPE` ＋ **`USING` 保数据转型**（在 Prisma 生成结果上手工改了一处，文件头写明了原因） |
| `tools/relation-kind-check.mjs` | **新守门人**（5 项检查，见 §4），`fail-closed` |
| `backend/package.json` | 新增 `relation:check`；`ci` 接成**第 8 步**（`icons:check` 之后） |
| `docs/design/06-w0-report.md` | §3.1 的 `D1b` 行由「⏳ 阶段 D-a」改口为「✅ 已落地（阶段 D-a，2026-10-13）」并点名 `RelationKind` |
| `docs/design/README.md` | 索引加本单；待办第 5 条的"待落地"只留 `D3b`；进度加第 11 条 |

**未改**：`lib/**`、`kids_points_mp/**`、`test/**` —— 前端此刻不写 `relation`（`grep` 命中 0 处），
所以这一步**不动前端是对的**，而不是"漏了前端"。

## 4. 证伪（15 例，全绿）

闸门 5 项检查，**每一项都有一个"必须变红、且只红它自己"的反例**：

| 检查 | 反例 | 结果 |
|---|---|---|
| ① 三处取值逐字相等 | A 枚举多一项 `sibling`；B 注释写成 `grandma`；C 迁移 `CREATE TYPE` 多一项 `guardian` | ✅ 各红且**只**点名 ① |
| ② 字段必须是 `RelationKind` | `relation  RelationKind` → `relation  String` | ✅ 只点名 ② |
| ③ 迁移必须保数据 | D 改回 Prisma 默认 `DROP+ADD`；E 只删 `USING` 子句 | ✅ 各只点名 ③ |
| ④ 字面量必须落在枚举内 | A 被扫目录里写 `relation: 'sister'` | ✅ 只点名 ④ |
| ⑤ 文档必须已改口 | D 退回「⏳ 待落地」；E 整行不再点名 `RelationKind` | ✅ 各只点名 ⑤ |

**3 个控制例**（没有它们，"变红"无法排除"路径指错了 / 解析器坏了"）：
0 真文件全绿 ／ 1 覆盖路径指向**合法副本**全绿 ／ 2 `schema` 指到不存在的文件 → **取源阶段红**（fail-closed）。
**2 个收尾**：真文件 `sha256` 前后一致（篡改只发生在副本上）；清理副本后重跑回绿。

### 三条自我纠正（都在自测/闸门脚本里，不在产品代码里）

1. **闸门首跑红在了错的理由上 —— 它把自己的"解释性注释"当成了证据。**
   迁移文件头部那段"Prisma 原文是 `DROP COLUMN …`"的注释，被检查 ③ 的正则读成了
   "迁移里真的在删列"。这与本仓库的「**证据只取代码，注释不算**」是**同一条规矩**，
   于是补了 `stripSqlComments()`（只取可执行语句）。**代价提醒**：迁移文件里引用坏形态时，
   必须依赖注释剥离 —— 这条已在函数注释里写明。
2. **副本残留让"红"出现在别的检查上。** 首版只在部分用例里重建副本，于是 ③-E 删掉的 `USING`
   残留到了 ④-A / ⑤-D，"逐条点名"整个失效（输出是"红的是 ③,④"）。加 `reset()` 后复现。
   —— 与 C5 §4 第 1 条（闸门副本重复，改了 A 却看 B）是**同一类**：**测试脚手架自己的状态**。
3. **两处"控制例缺失"导致的假红/假绿**：
   ① ④ 的扫描根在用例期间是**空目录** → 触发它自己的 fail-closed（"一个文件都没有即红"），
   于是每一例都多一个 ④ —— 改成 `reset()` 先写一个**合法**样例，用例只改一个变量；
   ② ⑤-E 写的是 `row.replace('RelationKind', …)`，**只换第一处**，行内其余出现仍满足"点名"，于是**红不了**。
   改为全局替换后才复现。

> 三条与本仓库的头号教训同源（README：「绿的是我的反例，不是守卫」）：
> **测试基础设施自己的 bug，最会伪装成"通过"**。

## 5. 遗留（别把已修当已够）

- **`D3b` 仍未落地**：`ChildMember.restrictions` 还是裸 `Json`（`schema.prisma`），
  → **阶段 D-b**：类型 ＋ 类型守卫 ＋ 单测（`06` §3.1）。
- **`04` 首启引导仍是空白** —— 别把"首启空态"当成"引导已完成"（C1 只做了空态）。
- **工具/文件职责地图**（用户指示，尚未做）：`tools/**` 每个脚本做什么、在哪跑、产物在哪。
- **闸门 ④ 目前"无字面量可查"**：仓库里 `relation` 字面量 **0 处**（后端 API 未开工）。
  它是**防将来**的：等写入路径落地，它才会真正开始工作 —— 这一点写在这里，免得后人以为它已经"验过什么"。
- **数据库链照旧**：本次**没有** `migrate reset`，但仍照规矩跑了一遍
  `seed → 900_ledger_revoke.sql → db:verify`（`reset` 之后这三步**必须**重跑，见 `06` §10.3）。

## 6. 下一会话怎么复跑

```bash
# ① 静态闸门（不需要库）
cd backend && npm run ci          # 期望 CI_EXIT=0（10 步；第 8 步 = relation:check）

# ② 单跑本阶段的守门人
node tools/relation-kind-check.mjs        # 期望 ALL PASS 5/5

# ③ 证伪（一次性的，放 _scratch，不入库）
node tools/_scratch/d1b-falsify.mjs       # 期望 15 例全 PASS

# ④ 数据库侧（需要活库 + 两条连接串）
npx prisma migrate status                 # 期望 Database schema is up to date!
npm run seed                              # 期望 库内合计 18 条
"/d/Program Files/PostgreSQL/18/bin/psql.exe" "$(grep -m1 '^MIGRATION_DATABASE_URL=' .env | cut -d= -f2- | tr -d '\"' | sed 's/?.*$//')" -f prisma/sql/900_ledger_revoke.sql
npm run db:verify                         # 期望 ALL PASS —— I5 在真实库上生效

# ⑤ 前端（本步未改，复跑只为确认没被波及）
cd kids_points_mp && npx tsc --noEmit -p tsconfig.json   # exit 0
#（现编产物后）node .tmp_test/run.js                     # 期望 ALL PASS 27/27
flutter analyze && flutter test                          # 期望 0 issue / 41/41
```

