# 阶段 C3 交接单 · E16（心愿配色 → 稳定枚举 `WishCoverStyle`）

> **写于** 2026-10-12 深夜（本机）；**给**：接手 C3 的下一个会话。
> **一句话状态**：C3 的**代码 ＋ 测试已全部落地**，**7 道闸门里 5 道已绿**，
> **唯独"台账与文档还没改口"** —— 所以守门人**此刻故意是红的**，这是**期望中的中间态，不是事故**。
> 剩下的事：改 `03` 6 处 ＋ README 1 处 → 重跑守门人/`npm run ci` → 证伪自测 6 例 → 一处提交。**预计 30 分钟。**

> **✅ 2026-10-12 已收口**（提交 `90e9ce7`，14 个文件；`07` 首次入库）：台账 6 处与 README **均已改口**、
> `node tools/defect-status.mjs` **`ALL PASS`（18 条）**、`backend npm run ci` **8 步全绿**、**证伪 6 例**（造假必红、还原必绿；
> 其中 ③ 的**实测勘误**见 §4.3 与 §5 第 9 条：真正拦住回退的是**守门人**，不是那条听上去很像的断言）。
> 下面的 §0 / §4 描述的是**收口前**的中间态（守门人当时**故意**报 `FAILED 1 项`），**留档不改写** ——
> 请按「已完成」读，**别再照 §4 干活**。**下一阶段 C4 的交接见 [`08-c4-handoff.md`](./08-c4-handoff.md)。**

## 0. 接手第一步（3 分钟自检，世界没变再往下做）

```bash
cd C:/Users/a9653/.cline/data/workspaces/chat/kids_points_app
node tools/defect-status.mjs                                  # 期望：FAILED 1 项（E16）—— 与本文一致才继续
cd kids_points_mp && npx tsc --noEmit -p tsconfig.json       # 期望：无输出、EXIT=0
git status --short                                             # 期望：15 个 M ＋ 1 个未跟踪（?? docs/design/07-c3-handoff.md）；其中 package.json / package-lock.json 与本轮无关（见 §5 第 6 条），提交时别带
```

若上面的期望**不成立**（例如守门人已经 ALL PASS 或工作区多出文件），先弄清楚差异再动手 —— 本仓库最忌讳的就是"照旧前提干活"。

## 1. 这一步在修什么（不是为了让代码好看）

`backgroundIndex: number` 的值来自 **插入时的列表长度**（`wishes.length % 4`）。
"列表长度"描述的是**位置**，不是心愿的**身份** —— 删掉中间一条，既有心愿与新心愿的配色就会重排/撞色。
修法：配色升为**结构枚举**，取值只能从 `A|B|C|D` 里来，与后端 `backend/prisma/schema.prisma` 的
`enum WishCoverStyle { A B C D }`（`Wish.coverStyle @default(A)`，W0 已就绪）**一一对应**。
取值来源二选一：**有空档先补空档**；四色占满时 **id → 哈希** 稳定映射（同一个 id 永远同一个色）。

## 2. 已落地清单（文件 + 行号，可 grep 复核）

| 端 | 文件 | 内容 |
|---|---|---|
| Taro | `kids_points_mp/src/data/types.ts` | `:59` `export type WishCoverStyle = 'A'｜'B'｜'C'｜'D'`、`:62 wishCoverStyles`、`:68 wishCoverHash()`、`:82 pickCoverStyle()`、`:101 Wish.coverStyle` |
| Taro | `kids_points_mp/src/data/store.ts:394` | `addWish` → `coverStyle: pickCoverStyle(this.wishes.map(i => i.coverStyle), id)` |
| Taro | `kids_points_mp/src/components/WishCard/index.tsx:13` / `:37` | `WISH_GRADIENTS: Record<WishCoverStyle, [string, string]>`（**编译期穷尽**）；取色 `WISH_GRADIENTS[wish.coverStyle]` |
| Taro | `kids_points_mp/src/data/seed.ts:66/74/82/90` | 4 条演示心愿 `coverStyle: 'A'..'D'` |
| Flutter | `lib/models/wish.dart` | `:7 enum WishCoverStyle { a, b, c, d }`、`:10 wishCoverStyles`、`:19 wishCoverHash()`、`:31 pickCoverStyle()`、`:60 final WishCoverStyle coverStyle` |
| Flutter | `lib/widgets/wish_card.dart:11` / `:37` | `wishGradientOf(...) => switch (style)`（**Dart 3 switch 表达式穷尽**） |
| Flutter | `lib/data/app_store.dart:356` | `addWish` → `coverStyle: pickCoverStyle(wishes.map(...).toList(), id)` |
| Flutter | `lib/data/seed_data.dart:77/84/91/98` | 4 条演示心愿 `WishCoverStyle.a..d` |

**跨端同源**：`hash = (hash * 31 + charCode) % 1000003`（JS `charCodeAt` ≡ Dart `codeUnitAt`，ASCII 同值）。
两端各写一条钉死断言：`wishCoverHash('wish-9') === 355514` → `% 4 = 2` → `'C'` / `WishCoverStyle.c`。
**改一端不改另一端就必红** —— 这是"同源"唯一有用的形态。

**回归用例（都先验证过"能失败"再让它变绿）**

- `kids_points_mp/.tmp_test/run.js:319`｜`check('E16：心愿配色是稳定枚举 —— 删项不漂移、有空档先补空档')`
  断言链：种子配色恰为 `A,B,C,D` → 删中间 `B` → 剩余配色**一个都不许变** → 新增心愿**补回 B** →
  满档时同 id 同色 → 任意 id 都落在枚举内 → 哈希 = 355514。→ **19 → 20 项 `ALL PASS`**
- `test/app_test.dart:439`｜`group('心愿配色稳定枚举（修 E16）')` 共 **3 条**（删项不换色＋补空档 / 跨端同源哈希 / 卡片取色由枚举决定且两值不同）
  → `flutter test` **29 → 32**（`+32: All tests passed!`）

**守门人**：`tools/defect-status.mjs:268` E16 验证器 `unfixed → fixed`，并新增路径常量 `T_CARD` / `F_WISH` / `F_CARD`。
四类断言：① 枚举结构存在；② **反回退**（两端 `wishes.length % 4` **归零**、`backgroundIndex` 字段/写法归零、两端 seed 不出现）；
③ 取色**编译期穷尽**（`Record<…>` / `switch` 表达式）；④ 回归用例存在 ＋ **哈希钉死**。

## 3. 七道闸门实测（本机 2026-10-12 23:2x；日志在 `tools/_scratch/`，**不入库**）

| # | 命令（工作目录） | 结果 | 日志 |
|---|---|---|---|
| 1 | `npx tsc --noEmit -p tsconfig.json`（`kids_points_mp/`） | ✅ `TSC_EXIT=0` | `c3-tsc.log` |
| 2 | 现编 dist：`npx tsc src/data/store.ts src/data/seed.ts src/data/types.ts src/utils/color.ts --outDir .tmp_test/dist --module commonjs --target es2017 --strictNullChecks --esModuleInterop --skipLibCheck`（`kids_points_mp/`） | ✅ `EXIT=0` | — |
| 3 | `node .tmp_test/run.js`（`kids_points_mp/`） | ✅ **20/20 `ALL PASS`** | — |
| 4 | `flutter analyze`（仓库根） | ✅ **`No issues found! (ran in 53.1s)`** | `c3-analyze.log` |
| 5 | `flutter test`（仓库根） | ✅ **`+32: All tests passed!`** | `c3-test.log` |
| 6 | `npm run ci`（`backend/`） | ❌ **`BACKEND_EXIT=1`**：前 4 步（`prisma:validate` / `typecheck` / `typecheck:tools` / **`honesty:probe` 4/4**）全绿，**第 5 步 `defects:check` 报 `FAILED 1 项`（E16 台账未改口）→ fail-fast，后 3 步 `templates:check` / `build` / `contracts:emit` 尚未跑** | `c3-backend.log` |
| 7 | `node tools/defect-status.mjs`（仓库根） | ❌ **`FAILED 1 项`**：`E16 台账=❌ 未修，代码只符合「✅ 已修」` | — |

> ⚠️ 第 6/7 步的**红是这道闸门正常工作的证据**：它抓的正是「**改了代码、没改台账**」。
> 也正因为 `ci` 是 `&&` 串联的，**改口后必须重跑整条 `npm run ci`**（后 3 步还没被执行过）。

## 4. 剩余的活（照顺序做）

### 4.1 改口 6 处 ＋ README 1 处（`docs/design/03-existing-defects.md`，**CRLF 文件**，见 §5 第 1 条）

| 行 | 现状 | 改成 |
|---|---|---|
| `:42` | `E16 … ❌ **未修** ｜ store.ts:321、app_store.dart:296：wishes.length % 4` | `✅ **已修**` ＋ 证据列换成 §2 的行号（枚举 `types.ts:59` / `wish.dart:7`；取色 `WishCard/index.tsx:13` / `wish_card.dart:11`；补空档＋哈希 `store.ts:394` / `app_store.dart:356`；两端下标归零） |
| `:47` | `**合计：✅ 已修 14 · ❌ 未修 4（C9 / C10 / C11 / E16）**` | `**合计：✅ 已修 15 · ❌ 未修 3（C9 / C10 / C11）**` |
| `:53` 段 | C2 注记里的 `FAILED 4 项`（C2 当时的真实事实） | **保留原文**，其后追加一句：`> **2026-10-12 阶段 C3**：E16 改口的同一刻又被同一条闸门拦下 —— backend 的 defects:check 报 FAILED 1 项（台账「未修」vs 代码「已修」）。` |
| `:448` §E16 | `**修复**：配色改为稳定枚举 WishCoverStyle（如 A｜B｜C｜D），或由 wishId 哈希稳定映射。` | 换成 `**现状（2026-10-12 阶段 C3 已落地）**` 段落（结构照 §E15/§E17 的现状段）：枚举契约（与后端 `enum WishCoverStyle` 一一对应）＋ 补空档/满档哈希 ＋ 两端取色编译期穷尽 ＋ 回归用例位置与 355514 钉死断言 |
| `:75` | `C3  E16                        （WishCoverStyle 稳定枚举替换数组下标）` | `C3 ✅ E16                        （已落地：WishCoverStyle 稳定枚举替换数组下标）` |
| `:548` | `…❌ **E16 未动**（下一阶段 C3）` | `…✅ **E16 已收口**（C3：稳定枚举 ＋ 补空档/哈希；两端 wishes.length % 4 归零）` |
| `docs/design/README.md` | 索引表只有 `01`–`06`；「当前落地进度」停在 C2（19/19、29/29） | ✅ **本次交接已顺手补上**：索引表加 `07-c3-handoff.md`（状态 🚧 C3 进行中）＋ 进度节加 C3 一条 bullet（`run.js 20/20`、`flutter test 32/32`、`flutter analyze 0 issue`、`tsc --noEmit EXIT=0`，并注明"E16 台账改口 ＋ 证伪自测 ＋ 提交"是收尾动作）。**无需重做** |

> ⚠️ **行号已因本次交接在 §0 注记后插入 4 行交叉指引而下移**：`:75` → **`:79`**、`:448` → **`:452`**、`:548` → **`:552`**；
> `:42` / `:47` / `:53` 不受影响（插入点在它们之后）。改之前先 `grep -n 'E16\|合计：' docs/design/03-existing-defects.md` 复核一次。

### 4.2 重跑闸门（改口后）

```bash
node tools/defect-status.mjs      # 期望：ALL PASS（共对账 18 条）、EXIT=0
cd backend && npm run ci          # 期望：8 步全绿、EXIT=0（含 templates:check / build / contracts:emit）
```

### 4.3 证伪自测 6 例（**不做这一步，等于没有回归**；每例：注入反例 → 必须红 → 还原 → 必须绿）

| # | 注入什么 | 期望变红的那条闸门 |
|---|---|---|
| ① | `store.ts` 的 `coverStyle: pickCoverStyle(...)` 改回 `coverStyle: wishCoverStyles[this.wishes.length % 4]` | `run.js` E16 用例 |
| ② | `seed.ts` 4 条 `coverStyle: 'A'..'D'` 改成按下标推 | `run.js` E16 用例（"演示数据显式声明配色"）—— 实测还外加**双重**：`tsc` 报类型错（多余属性 `backgroundIndex`）＋ 守门人 E16 红 |
| ③ | `wish_card.dart` 把 `switch (style)` 换回 `wishGradients[style.index]` | **守门人**（`defect-status.mjs:286` 的 `A.lack(F_CARD, /wishGradients\[/)`）—— **最值得记的一例**（2026-10-12 实测勘误）：`flutter analyze` 绿、`app_test.dart`「卡片按稳定枚举取色」**也绿**（整包 32/32：那张表凑巧与枚举同序 → 行为等价），**断言名 ≠ 断言力**；`switch` 的编译期保障要另加枚举取值才暴露（见 §5 第 9 条） |
| ④ | 两端把 `wishCoverHash` 的 `31` 改成 `17` | 两端"哈希钉死 355514"**同时**变红（跨端同源断言真的在起作用） |
| ⑤ | 把 `tools/defect-status.mjs` 里 E16 的 `status: 'fixed'` 改回 `'unfixed'` | 守门人（台账说已修、代码找不到证据） |
| ⑥ | 台账 `:42` 改口后**再改回** `❌ **未修**` | 守门人（"声明与代码不符即红"的正向验证） |

### 4.4 提交（**一处** C3 提交）

```bash
git add kids_points_mp/src/data/types.ts kids_points_mp/src/data/store.ts \
        kids_points_mp/src/data/seed.ts kids_points_mp/src/components/WishCard/index.tsx \
        kids_points_mp/.tmp_test/run.js \
        lib/models/wish.dart lib/widgets/wish_card.dart lib/data/app_store.dart lib/data/seed_data.dart \
        test/app_test.dart tools/defect-status.mjs \
        docs/design/03-existing-defects.md docs/design/README.md docs/design/07-c3-handoff.md
# 不要 git add -A：package.json / package-lock.json 的改动与本轮无关（见 §5 第 6 条）
git commit -m "feat(c3)+docs: E16 心愿配色升为稳定枚举 WishCoverStyle —— 下标归零、双端同源哈希、守门人改口"
```

（提交前若只补了文档，`tsc` / `flutter` 无需重跑；但 `defect-status.mjs` 与 `backend npm run ci` **必须重跑**。）

## 5. 陷阱与教训（**每一条都是本轮真踩过的**，别重复付费）

1. **⚠️ `editor` 工具对本仓库 CRLF 文件的"多行整块匹配"不可靠** → 一律用 `tools/_scratch/*.mjs` 脚手架：
   **行尾归一（CRLF↔LF 按原样回写）＋"命中数必须 = 1"闸门 ＋ 写盘后 `node --check`**。
   本轮模板：`c3-impl-mp.mjs`（Taro 源码）、`c3-impl-flutter.mjs`（Flutter 源码）、`c3-tests.mjs`（两套测试）、`c3-guard2.mjs`（守门人）。
2. **在 `defect-status.mjs` 里做"整块字符串替换"会神秘失配**（引号/反斜杠/不可见字符，本轮实测命中 0 次）→
   改用**按行定位**（起点＝含 `id: 'E16'` 的行，终点＝其后第一个 `  ] },`）**一次成功**。别去调转义，换定位法更便宜。
3. **⚠️ `tools/_scratch/**/*.dart` 会被 `flutter analyze` 当库代码扫** —— 本轮因此白跑一次（`68 issues` 全来自片段文件），
   片段改名 `.dart.txt` 才干净。**脚手架里的 Dart 片段一律用 `.dart.txt` 后缀**（`analysis_options.yaml` 的 `exclude` 只有 `build/ android/ ios/`）。
4. **后台命令必须 `nohup … &` ＋ stdout/stderr 重定向 ＋ `< /dev/null`**：只写 `(cmd &)` 时，
   工具 **30s 超时会连坐杀掉子进程** —— 本轮 `flutter analyze` 就这样"跑了 12 分钟没结果"，日志停在 `Analyzing kids_points_app...`。
   判据：`ls -l` 看日志大小有没有在长。
5. **"下标归零"不靠肉眼 `grep` 下结论**：`backgroundIndex` 这几个字**合法地**还留在四处 —— `types.ts:55`、`wish.dart:4`（注释讲"原先怎么写的"）、
   `tools/defect-status.mjs:276-285`（守门人自己的反回退正则，**必须**含这个词才抓得到回退）；另有 `kids_points_mp/.tmp_test/chrome-profile/**` 的历史编译产物副本。
   判据用守门人那三类断言（`A.lack` / `A.countIs(..., 0)`），别用 `grep -r | wc -l` 自己吓自己。
6. **工作区里两个"与 C3 无关"的既存改动**：`kids_points_mp/package.json`、`kids_points_mp/package-lock.json`（`react-refresh` 相关，
   mtime 21:26 早于本轮 C3 编辑 21:41）→ **不并入 C3 提交**，提交时用显式文件清单而不是 `git add -A`。
7. 本机 `grep.exe` 偶尔留下 `grep.exe.stackdump`（未跟踪垃圾，本轮已删）；若再出现，删掉即可，**不要 `git add`**。
8. 命令位置：`run.js`、`defect-status.mjs` 都按自身路径定位产物，但**验收门命令写全路径更稳**（见 `03` 文末"验收门"）。
9. **⚠️ 断言名 ≠ 断言力**（③ 的实测勘误 —— 这才是"最值得记的一例"值钱的地方）：把 `wish_card.dart` 的 `switch (style)`
   换回 `wishGradients[style.index]`，`flutter analyze` **绿**，整包 `flutter test` **32/32 绿** ——
   配色表凑巧与枚举同序 → **行为等价**，`app_test.dart`「卡片按稳定枚举取色」三条断言全部成立。
   真正拦住它的是**守门人**：`defect-status.mjs:286` 的 `A.lack(F_CARD, /wishGradients\[/)` → `FAIL E16 / FAILED 1 项`。
   而 `switch` 的价值（编译期穷尽）要**加一个枚举取值**才暴露：`enum WishCoverStyle { a, b, c, d, e }` →
   `analyze exit=1`、`non_exhaustive_switch_expression`（指向 `wish_card.dart`）；**同样条件下下标版 `analyze` 全绿、测试也全绿**。
   教训：证伪前先问"**这条闸门真的看得见这一改动吗**"，别把"名字听上去很像"当判据 —— 本轮就靠两步对照（zero-match `--plain-name` 退出码 = 79、
   加枚举取值 A/B 对照）才没有把「假绿」记成「已证伪」。

## 6. C3 之后（队列，别丢）

- **C4** = `C9`（软删除/回收站）＋ `C10`（`updateRule` 规则编辑）＋ `C11`（`AuditLog` 变更可追溯）。
  **后端 schema 已就绪**（`deletedAt` / `PointRule.currentVersion` / `AuditLog` 表，W0 已建）→ 只剩前端改造 ＋ 守门人 3 条验证器 `unfixed → fixed` ＋ 台账改口。
  **方法照抄 C3 的顺序**：先写"能失败"的用例 → 双端同步改 → 守门人钉死 → 改口 → 证伪 → 提交。
- **C5** = `D9`（新增 `iconName` → `IconData` 映射，见 `03`）。
- **待办（用户指示，尚未做）**：产出「工具/文件职责地图」文档（`tools/**` 每个脚本负责什么、什么命令在哪个目录跑、产物在哪），
  **暂不**接 VS Code task / pre-commit 钩子。
