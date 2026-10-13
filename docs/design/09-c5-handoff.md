# 阶段 C5 交接单 · `D9` 图标字段跨端类型不一致（名字 ↔ `IconData`）

> ## ✅ 已收口（2026-10-13）
>
> 本单与 C5 的实现**同批完成**（不像 `07` / `08` 是"动手前先写"的提案单）——
> 写法照旧：下面第一节起是**当时的前提与判断**，收口证据全部可复跑。
>
> | 闸门 | 结果 |
> |---|---|
> | Taro `npx tsc --noEmit -p tsconfig.json` | ✅ `EXIT=0` |
> | 现编产物 ＋ `node .tmp_test/run.js`（`kids_points_mp/`） | ✅ **27/27 `ALL PASS`**（新增 D9 ×2） |
> | Taro `npm run build:weapp` | ✅ `EXIT=0` |
> | `flutter analyze` / `flutter test` | ✅ `No issues found!` / **41/41**（`app_test.dart` 40 ＋ `widget_test.dart` 1；本轮新增 3 条） |
> | `node tools/icon-names-check.mjs`（`npm run icons:check`） | ✅ **`ALL PASS` 7/7**（三份名单各 **29** 个名字） |
> | `node tools/defect-status.mjs` | ✅ **`ALL PASS` 19/19**（D9 由"台账无此行"补入后转绿） |
> | `cd backend && npm run ci` | ✅ **`CI_EXIT=0`（9 步）** —— 新增第 7 步 `icons:check` |
>
> **证伪：闸门 12/12 ＋ Taro 用例 3/3 ＋ Flutter 用例 3/3**（每例"红且点名 → 还原 → 回绿"，还原走 sha256 字节级比对）。
> **三次自我纠正**（都出自自测脚本，不在产品代码里）：反例与映射表值行为等价 → 假绿；闸门副本重复 → 改了 A 检查看 B；
> 备份用了 `.dart` 后缀 → `flutter analyze` 0 issue 变 303 errors。逐条见 §4。

> **给**：接手 `D1b` / `D3b` 或首启引导的下一个会话。
> **一句话状态**：`03` 台账 **19/19 全绿、队列清空**；C5 的两处**能力缩减与遗留**写在 §5，别当成"全都做完了"。

## 1. 这一步在修什么

| | |
|---|---|
| 缺陷 | **D9**：图标字段跨端类型不一致 |
| 触发点 | `06` §2 缺陷 6（W0 实跑时暴露）＋ `01` §3 那句"接 API 不改 UI"过宽 |
| 当时状态 | **从未进过 `03` 台账** —— 只在 `06` §3.1 决策登记与 `03` §0.1 第 3 条里被提到，**没有守门人** |

同一条数据，三端三种类型：

| 端 | 表示 | 事实 |
|---|---|---|
| 后端 / 库 | `String`（`'book'`） | 权威事实是**名字** |
| Taro | `IconName`（字符串联合） | 名字查表渲染，本来是对的 |
| Flutter | `IconData`（`Icons.menu_book_rounded`） | **存的是字形** —— 服务端给的名字落不进去 |

**为什么不能只加一张映射表就完事**：名字在两端各有一份**手抄清单**，后端还有第三份
（`ICON_NAMES`，后端无法 import 小程序的 TS）。手抄就会漂移，而漂移的表现是
「某个图标在某一端悄悄画成占位」—— **三端的编译器都不会说一句话**。
所以这次是"映射 ＋ 闸门"一起来的，闸门才是这条缺陷真正的解药。

## 2. 落地清单（文件级）

**Flutter（名字是唯一事实）**

| 文件 | 改动 |
|---|---|
| `lib/theme/app_icons.dart` | **新增**：`IconNames` 常量表 ＋ `appIcons` 映射表 ＋ `iconDataFor()` ＋ `fallbackIcon`（派生自 `appIcons[IconNames.unknown]`）＋ `isKnownIconName()` |
| `lib/models/{habit,point_rule,point_record}.dart` | `IconData icon` → `String iconName` |
| `lib/widgets/{rule_tile,record_tile,form_fields}.dart` | 渲染改走 `iconDataFor(名字)`（各一处）；`IconOption` 存 `name` |
| `lib/data/{app_store,seed_data}.dart` | `addRule(iconName:)` ＋ 白名单校验；seed 写名字 |
| `lib/screens/sheets/add_rule_sheet.dart` | 图标选择器**只在新建时出现**（见 §3 第 2 条） |
| `test/app_test.dart` | 新增「图标名映射（修 D9）」三条 |

**Taro**

| 文件 | 改动 |
|---|---|
| `src/components/Icon/icons.ts` | 新增 `unknown` 图案、`FALLBACK_ICON_NAME`、`getIcon()` 兜底分支、`isKnownIconName()`（查**自己的键**） |
| `src/data/store.ts` | `addRule` 白名单校验（与 Flutter 同一口径） |
| `src/sheets/AddRuleSheet.tsx` | 选择器只在新建时出现 |
| `.tmp_test/run.js` | 新增 D9 两条（写入口 ＋ 渲染兜底） |

**后端 / 闸门**

| 文件 | 改动 |
|---|---|
| `backend/prisma/seed/templates.data.ts` | `ICON_NAMES` 补 `'unknown'`（否则三份名单不再相等）＋ 契约说明 |
| `backend/package.json` | 新增 `icons:check`，并接进 `npm run ci`（第 7 步） |
| `tools/icon-names-check.mjs` | **新增**：三份名单 + 5 项结构检查（共 7 项），路径可用 `KP_ICON_*` 环境变量覆盖（只为证伪自测） |
| `tools/defect-status.mjs` | **新增 D9 验证器**（台账加行而验证器不加 → fail-closed 报红） |
| `docs/design/03-existing-defects.md` | §0 表加 D9 行（19 条）＋ §D9 章节 ＋ 修复顺序/验收门 |

## 3. 三处「与直觉不同」的判断（都留了痕）

1. **`unknown` 兜底就放在白名单里**，不另立"第四份名单"。
   否则"三份名单相等"这句话要变成"三份相等 ＋ 兜底一致"，闸门也要多一条；
   而兜底本来就必须是**画得出来的名字**。代价：`unknown` 会出现在白名单里 ——
   于是**选择器必须显式排除它**（否则家长能选到"问号"）。
2. **编辑规则时不再允许改图标**。`RuleVersion` 快照没有 icon 字段（后端契约只有
   `title` / `condition` / `dailyLimit` / `points`），允许改就会出现"版本回放时图标对不上"。
   选择把图标当作规则的**稳定属性**：新建可选、编辑只读。要改它，先给后端加契约字段。
3. **数据层存名字、渲染时才换算**（而不是存名字又存一份字形缓存）。
   缓存的后果是"两份真相 + 一个失效时机"，正是本项目反复在修的那类病。

## 4. 证伪（一个不会失败的检查等于没有检查）

| 层级 | 脚本 | 例数 | 结果 |
|---|---|---|---|
| 闸门自身 | `tools/_scratch/c5-tamper.mjs` | 12 | ✅ 全部红**且点名对应检查**；控制例断言"副本与原文件逐字节相同 + 未注入必须 ALL PASS" |
| Taro 两条新用例 | `tools/_scratch/c5-taro-falsify.mjs` | 3 | ✅ 只改**编译产物**（不动源码），还原后 sha256 一致 |
| Flutter 三条新用例 | `tools/_scratch/c5-flutter-falsify.mjs` | 3 | ✅ 改**真源码**（Flutter 测试跑源码），每例备份 ＋ 字节级还原 |

**三次自我纠正（都写进 `03` 验收门；三次都发生在自测脚本里，不是产品代码里）**：
1. **闸门脚本自己的假绿**：副本曾分成"专项检查读的那份"与"扫全 `lib` 读的那份"，
   于是"改了 A、闸门看的是 B"让第 ⑤ 例**红了也白红**。改成**每个真文件只有一份副本**后才复现。
2. **反例的假绿**：`fallbackIcon` 第一版注入写成 `Icons.help_outline_rounded` ——
   那正是映射表里 `unknown` 的值，**行为完全等价**，测试当然不红。
   **红不了的不是用例，是反例**：换成 `Icons.home` 立刻点名 `白名单兜底`。
3. **实验残留物自己制造的红**：备份写成 `tools/_scratch/c5bak/app_store.dart`，而 `flutter analyze`
   会分析包目录下**所有** `.dart` —— 副本里的相对 import 全部悬空，`0 issue` 直接变成 **`303 issues`**。
   备份改名 `*.dart.bak` 后复跑 `No issues found!`。

> 三条与本仓库的头号教训同源（README：「绿的是我的反例，不是守卫」）：
> **测试基础设施自己的 bug，最会伪装成"通过"**；而**还原能不能算数，要由"重跑全部闸门"来签字**。

## 5. 遗留（别把已修当已够）

- **编辑规则仍不能改图标**（§3 第 2 条）—— 要支持得先给 `RuleVersion` 加 icon 字段（后端 schema 变更）。
- **三份名单仍是手抄**：现在只是"漂移会被闸门抓住"。真正的一劳永逸是让后端从契约文件生成
  `ICON_NAMES`（未做：跨包跨工具链的引入成本高于收益）。
- **`03` 队列已清空，但项目没完**：`D1b`（`relation` 升枚举）→ 阶段 D-a、
  `D3b`（`restrictions` 定形校验）→ 阶段 D-b（`06` §3.1），以及 `04` 的**首启引导**仍是空白
  —— 别把"首启空态"当成"引导已完成"。
- **工具/文件职责地图**（用户指示，尚未做）：`tools/**` 每个脚本做什么、在哪跑、产物在哪。
  本轮又加了一个 `tools/icon-names-check.mjs`，这张地图更有必要了。

## 6. 复跑命令（从仓库根 / 指定目录）

```bash
# 1. 闸门（最快，先跑这个）
node tools/icon-names-check.mjs                        # 期望 ALL PASS（7/7）
node tools/defect-status.mjs                           # 期望 ALL PASS（19/19）

# 2. Taro（kids_points_mp/）
npx tsc --noEmit -p tsconfig.json
npx tsc src/data/store.ts src/data/seed.ts src/data/types.ts src/utils/color.ts \
    --outDir .tmp_test/dist --module commonjs --target es2017 \
    --strictNullChecks --esModuleInterop --skipLibCheck   # 必须现编：run.js 跑的是 dist 产物
node .tmp_test/run.js                                  # 期望 27/27 ALL PASS

# 3. Flutter（仓库根）
flutter analyze && flutter test                        # 期望 No issues found! / 41/41

# 4. 后端（backend/）
npm run ci                                             # 期望 CI_EXIT=0（9 步）

# 5. 证伪（可复跑，产物可再生，脚本在 tools/_scratch/ 不入库）
node tools/_scratch/c5-tamper.mjs
node tools/_scratch/c5-taro-falsify.mjs
node tools/_scratch/c5-flutter-falsify.mjs
```

## 7. 提交建议（按 README「Git 记录规范」：背景 ＋ 验证证据）

```bash
# C5 的后端/闸门部分
git add tools/icon-names-check.mjs tools/defect-status.mjs \
        backend/package.json backend/prisma/seed/templates.data.ts
# 前端双端
git add lib/theme/app_icons.dart lib/models/*.dart lib/data/app_store.dart lib/data/seed_data.dart \
        lib/widgets/rule_tile.dart lib/widgets/record_tile.dart lib/widgets/form_fields.dart \
        lib/screens/sheets/add_rule_sheet.dart test/app_test.dart \
        kids_points_mp/src/components/Icon/icons.ts kids_points_mp/src/data/store.ts \
        kids_points_mp/src/sheets/AddRuleSheet.tsx kids_points_mp/.tmp_test/run.js
# 文档
git add docs/design/03-existing-defects.md docs/design/06-w0-report.md \
        docs/design/README.md docs/design/09-c5-handoff.md
# 不要 git add -A：kids_points_mp/package.json、package-lock.json 与本轮无关（C4 交接单 §7 第 8 条同样提醒过）
git commit -m "fix(c5)+docs: 图标名跨端契约(修 D9) —— 数据层只存名字 + 跨端闸门 icons:check + 台账补录 D9

背景/为什么：
- D9（决策号）：一端存 IconData、一端只能存名字，服务端给的字符串落不进 Flutter 的 icon 字段；
  且名字在 Taro / Flutter / 后端各有一份手抄清单，漂移时三端编译器都不会报错。
- D9 此前从未进 03 §0 台账（只在 06 §3.1 决策登记里），本次补录为第 19 条。

验证证据：
- node tools/icon-names-check.mjs → ALL PASS（7/7，三份名单各 29 个名字），EXIT=0
- node tools/defect-status.mjs → ALL PASS（19/19，D9 补入），EXIT=0
- node .tmp_test/run.js → 27/27 ALL PASS，EXIT=0；npx tsc --noEmit -p tsconfig.json → EXIT=0
- flutter analyze → No issues found! EXIT=0；flutter test → 41/41，EXIT=0
- npm run build:weapp → EXIT=0；cd backend && npm run ci → CI_EXIT=0（9 步）
- 证伪：闸门 12/12 ＋ 新用例 Taro 3/3、Flutter 3/3（每例红且点名，sha256 字节级还原后回绿）"
```

> 若一轮要拆成多个提交（例如「闸门」「双端实现」「文档」三步），**每一步都要各自满足**
> 上面「验证证据」的要求 —— 尤其是文档改口那一步，必须附上 `defect-status.mjs` 的
> 「改口前红、补验证器后绿」两次真实输出。

## 附录 · 已核实 / 未核实（诚实标注）

**已核实（本轮实测，可复核）**：上面 §6 的每一条命令与期望输出；三份名单各 29 个名字；
`lib/models` ＋ `lib/data` 里 `IconData` / `Icons.` 出现次数为 **0**；三个渲染点 `iconDataFor(` 各 1 次。

**未核实（别当成已验证）**：
- **小程序真机 / 开发者工具里的视觉确认**：本轮只做了类型检查与构建，`unknown` 图案在
  `background-image` 里长什么样，**没有在真机上看过**。
- **历史数据兼容**：库里若已存在不在白名单里的图标名（手工改过数据），表现为"画成问号圈"——
  没有做过数据迁移，也没有统计过是否存在这类值。
