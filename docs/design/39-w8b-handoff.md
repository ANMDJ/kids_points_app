# 39 · W8-B 交接单：首启引导双端 UI（2026-10-27）

> 前置：W8-A（提交 `93bb7f9`）已落地**后端**三端点与模板库，但双端一行 UI 都没有 ——
> `Child.onboardedAt` 没人读，新用户启动看到的是**空首页**而不是引导。
> 本轮补的就是这条缺口：**Flutter + 小程序各一套七步流程**、启动闸门、以及
> 「采纳模板 → 首页真的能打卡」的最后一步（把 `PointRule` 变成 `Habit`）。

---

## 1. 本轮交付（一句话版）

| 层 | 交付 |
|---|---|
| Flutter | `lib/screens/onboarding_screen.dart`（七步）＋ `onboarding_gate.dart`（启动闸门）＋ `models/onboarding.dart` / `data/onboarding_{dto,api,mapper}.dart`；`AppStore` 新增引导切片；`main.dart` 注入客户端；「我的」页留重试 / 继续入口 |
| 小程序 | `pages/onboarding/**`（七步 + 样式 + 页面配置）＋ `data/onboarding.ts`（常量 / DTO / 客户端）＋ `store.ts` 引导切片；**首页**在 `needsOnboarding` 时 `redirectTo`；「我的」页留入口 |
| 跨端闸门 | 新 `npm run onboarding:check`（`tools/onboarding-options-check.mjs`）：4 学段 / 6 关注点在后端契约、Flutter、小程序三处**逐字同序** |
| 测试 | Flutter `test/onboarding_test.dart` **23 条**；小程序 `run-w8b.mjs` **14 条** |

**没有改后端**：三个端点的语义、矩阵（41 动作）、`ConsentGuard` 豁免清单都没动。
本轮只在客户端消费它们。

---

## 2. 七步 ↔ 端点对照（两张表必须一起读）

| 步 | 界面动作 | 服务端写入 | 失败时界面 |
|---|---|---|---|
| ① 欢迎 | 勾选「我是该儿童的监护人…」 | `POST /consent`（仅当尚未同意） | 留在第①步并显示原因；**未勾选不发请求** |
| ② 昵称 | 填昵称 | `PATCH /child`（`rename_child`） | 留在第②步；空 / 超 20 字本地先拦 |
| ③ 学段 | 四选一，可取消 | `PATCH /onboarding/profile` `{ageBand}` / `{ageBand:null}` | 留在第③步，**不改本地快照** |
| ④ 关注点 | 六选多，可全不选 | `PATCH /onboarding/profile` `{focusAreas}` / `{focusAreas:[]}` | 同上 |
| ⑤ 选约定 | 勾模板卡片（**服务端顺序**） | 无请求（先攒选择） | 一条都不选 ⇒ 文案拦下，**不发请求** |
| ⑥ PIN | 4–6 位数字 / 留空跳过 | `POST /onboarding/complete`（与⑤合并提交） | 格式错本地拦；服务端错留在第⑥步 |
| ⑦ 完成 | 「开始打卡」 | 无（回首页 + 刷新快照） | — |

> **⑥ 为什么不是独立端点**：`complete` 的请求体里 `parentPin` 是可选的（W8-A 契约），
> 拆成「先完成、再设 PIN」会造出一个「已完成但没设 PIN」的中间态，
> 而那个中间态没有任何界面能可靠地回来补。

---

## 3. 五个关键判断（都是「看起来可以偷懒，其实不能」的地方）

### 3.1 「不知道」不等于「未引导」

`needsOnboarding` **只在** `GET /onboarding` 成功且 `onboarded === false` 时为真。
`idle` / `loading` / `error` 一律 false：

- 把「不知道」当「未引导」⇒ 一次超时 / 一次 501 就把用户推进一场**发不出请求**的引导；
- 把「不知道」当「已引导」⇒ 新用户看不到引导（就是 W8-A 之前的现状）。

因此**拉失败时放行到首页**（Flutter 闸门 / 小程序首页同一判据），并在「我的」页留
「重试读取引导状态」。这是**有意的降级**：宁可漏拦一次，也不要把应用锁死。

### 3.2 孩子 / 只读成员被 403 时也必须放行

`view_onboarding` 在矩阵里对 child 是 DENY。孩子设备启动必然 403 ——
如果闸门把 403 当成「未引导」，孩子会看到一个只有「请让家长操作」的死页面，
那比不引导更糟。所以：**引导只能由家长完成，孩子设备直接进首页**（其数据由家长那边的引导产生）。

### 3.3 第①步的同意必须在**采集之前**

`04` §5：第②步起就在采集昵称。所以 `OnboardingScreen` 第①步不许绕过，
后端 `ConsentGuard` 也会在 `complete` 处兜底（`403 CONSENT_REQUIRED`）——
但那时家长已经填了昵称、选了 N 条约定，**太晚了**。前端必须先拦。

> 「同意状态读不到」也不预勾：把没确认过的同意画成已勾选，是这个页面最不该犯的错。

### 3.4 `complete` 只建规则，首页要的是习惯 —— 所以要逐条补

`04` §3：采纳模板 = 复制成 `PointRule` + `PointRuleVersion v1`（**复制而非引用**）。
但首页打卡用的是 `Habit`，`04` §6 4.3 要求「首页出现 3 个习惯」。
W8-A 的 `complete` **不建习惯**（它不该顺手做第二件事），因此客户端在完成后用
**既有**端点 `POST /point-rules/:id/habits` 逐条补：

- **扣分约定不加**（A1：扣分不能变成孩子主动打卡加分）；
- `409 HABIT_ALREADY_EXISTS` 视为成功（重试 / 另一台设备刚加过）；
- 单条失败**不回滚引导**：把已成功的规则说成没成功才是更大的谎，
  失败项进第⑦步的「这些约定没有加入今天的习惯：…」。

### 3.5 PIN 的「空串」不是「跳过」

后端 `CompleteOnboardingDto` 用 `@Matches(/^\d{4,6}$/)` 拒绝空串 —— 那是**客户端 bug**
（输入框被清空却仍提交了字段）。双端都只在**非空**时把 `parentPin` 放进请求体；
Flutter 客户端还会在本地对空串抛 `ArgumentError`，小程序侧同样在 `complete()` 里拦。

---

## 4. 落地清单（文件级）

| 文件 | 作用 |
|---|---|
| `lib/models/onboarding.dart` | 学段 / 关注点常量、`RuleTemplate` / `OnboardingView` / `OnboardingResult`、昵称与 PIN 校验 |
| `lib/data/onboarding_dto.dart` | 三端点线格式的**严格**解析（形状矛盾 ⇒ malformed） |
| `lib/data/onboarding_api.dart` | `OnboardingApi` + 客户端（GET/PATCH/POST，复用 `WriteTransport`） |
| `lib/data/onboarding_mapper.dart` | DTO → UI 模型（**不重排**模板） |
| `lib/data/app_store.dart` | 引导切片：快照 / 状态 / 错误 / 单飞 / 草稿 / 完成 / 加习惯 |
| `lib/screens/onboarding_screen.dart` | 七步 UI 与推进逻辑 |
| `lib/screens/onboarding_gate.dart` | 启动闸门（加载态 / 放行 / 进引导） |
| `lib/screens/profile_screen.dart` | 「继续首次引导」/「重试读取引导状态」入口 |
| `lib/main.dart` | 注入 `OnboardingApiClient`，`home: OnboardingGate(child: HomeShell())` |
| `kids_points_mp/src/data/onboarding.ts` | 小程序常量 / DTO / 客户端 |
| `kids_points_mp/src/data/store.ts` | 与 Flutter 同构的引导切片 |
| `kids_points_mp/src/pages/onboarding/**` | 七步页面 + 样式 + 配置 |
| `kids_points_mp/src/pages/home/index.tsx` | `needsOnboarding` ⇒ `redirectTo` 引导页 |
| `kids_points_mp/src/pages/profile/index.tsx` | 重试 / 继续入口 |
| `tools/onboarding-options-check.mjs` | 三处选项契约闸门 |

---

## 5. 闸门：`npm run onboarding:check`

`tools/onboarding-options-check.mjs` 只做一件事：**把三份手抄的选项集合钉在一起**。

检查项：

1. 三份文件可读、能解析出**非空**数组（文件缺失 / 正则匹配不到 ⇒ 红，fail-closed）；
2. 学段**线值**集合与顺序三处逐字一致、无重复；
3. 关注点集合与顺序三处逐字一致、无重复；
4. Flutter `wireName` 的 `case` 分支数 == `return` 数（某个分支忘写线值 ⇒ 红，
   否则「集合相等」本身不可信）。

**为什么顺序也要一致**：`04` §2 第⑤步的排序链是「学段 → 关注点命中数 → sortWeight → slug」，
双端展示的选项顺序不同会让同一份模板在两端排出不同卡片顺序，而**没有任何编译错误**。

证伪（本轮实跑过，逐条变红）：

| 篡改 | 结果（实跑输出） |
|---|---|
| Flutter `return 'primary_high'` → `'primaryHigh'` | `✗ FAILED` · `学段 第 3 项不一致：后端 AGE_BANDS="primary_high"，Flutter wireName="primaryHigh"` |
| 小程序 `FOCUS_AREA_OPTIONS` 删掉「情绪管理」 | `✗ FAILED` · `关注点 数量不一致：后端 FOCUS_AREAS 6 个，小程序 FOCUS_AREA_OPTIONS 5 个` ＋ `第 5 项不一致：…"情绪管理"…"家务"` |
| 后端契约路径指向不存在的文件 | `✗ FAILED` · `后端契约 文件不存在：…` ＋ 两条「找不到起点」 |

三次都用 `KP_ONBOARDING_BACKEND` / `KP_ONBOARDING_FLUTTER` / `KP_ONBOARDING_TARO`
指向临时副本跑出，仓库里的源文件**没被改动**（临时目录跑完即删）。
退出码三次都是 `1` —— 闸门不是靠打印文字变红的，是靠 `process.exit(1)`。

---

## 6. 证据（可复跑）

| 命令 | 结果 |
|---|---|
| `flutter analyze` | **No issues found** |
| `flutter test` | **338/338**（原 315 ＋ 新增 `onboarding_test.dart` **23**） |
| `npx tsc --noEmit`（`kids_points_mp/`） | **EXIT=0** |
| `npx taro build --type weapp` | **EXIT=0**（Compiled successfully，仅 Sass `@import` 弃用告警） |
| `npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w8b.mjs` | **14/14 PASS** |
| `node tools/onboarding-options-check.mjs` | **PASS**（4 学段 / 6 关注点）＋ 3 例证伪全红 |
| `npm run ci`（`backend/`） | **CI_EXIT=0**（16 步，含新增 `onboarding:check`；`npm test` 50 文件 / 910 条） |

**Flutter 23 条的覆盖面**（`test/onboarding_test.dart`）：

- DTO：`onboarded` 与 `onboardedAt` 矛盾、未知学段 / 关注点、重复 slug、空模板库、
  坏分值 / 坏方向、空 `rules` —— 一律 `malformed`；
- 客户端：GET 不带 `Content-Type`、PATCH 的 `ageBand:null`、关注点保序去重、
  slug 去重、跳过 PIN 时**没有** `parentPin`、409 / 501 保留业务码；
- store：`idle` / 失败不要求引导、草稿合并不丢模板、完成后奖励加习惯 / 扣分不加、
  409 重拉后放行；
- 闸门组件：`onboarded:false` 进引导、未勾选同意留在第①步、`onboarded:true` 直接进首页、
  500 放行首页；
- 纯函数：昵称 / PIN 校验、模板文案由结构字段派生。

**小程序 14 条**（`run-w8b.mjs`）：常量对账、DTO 六种坏形状、客户端四种请求形状、
409 / 501 业务码、store 五种状态转换。

---

## 7. 本轮真踩过的坑（都是「看起来写完就好了」）

1. **大文件分块插入会切到别的函数中间**。`onboarding_screen.dart` 用「按行号插入」
   两次把 `_stepAgeBand` / `_buildTemplateCard` 切成两段，`flutter analyze`
   报的是「`class` can't be used as identifier」这种离现场很远的错。
   → 教训：插入后**立刻**读回插入点前后 10 行，不要攒到最后一起 analyze。

2. **`canManageConsent` 依赖成员列表，而启动时成员列表还没拉**。
   最初的第①步用 `store.canManageConsent` 判「是不是家长」，结果**永远为 false**
   （成员列表只在打开成员面板 / 同意面板时才拉）。
   → 改为**无条件** `refreshConsent()`：403 就是「不是家长」，200 就顺便拿到状态 ——
   一次请求同时完成「探测角色」和「读状态」，比先拉一份成员列表便宜且诚实。

3. **`GET` 复用 `WriteTransport` 时要显式扩展方法联合**。
   小程序 `WriteMethod` 原本只有 `POST|PATCH|DELETE`，加 `GET` 之前类型层根本表达不出
   「引导要读」。扩展后必须保证 `GET` **不带** `Content-Type`（严格后端会拒绝空 JSON 体），
   两端都用测试钉住了这条。

4. **「完成引导」和「首页出现习惯」是两件事**。W8-A 的 `complete` 只建 `PointRule`；
   若客户端不补 `Habit`，家长走完七步会看到一个**空首页** —— 这正是引导要解决的问题本身。
   补的时机必须在 `complete` 成功之后（否则模板还没复制），且**逐条**（单条失败不拖垮整单）。

5. **`POST /onboarding/complete` 非幂等**：重复调用是 409。
   双端都在 409 时**重拉状态**而不是原地重试 —— 另一台设备可能已经完成了，
   重试只会再吃一个 409，把用户卡在引导里。

---

## 8. 仍未做（按重要性排序）

| # | 事项 | 为什么没做 / 影响 |
|---|---|---|
| 1 | 「切家长模式」的 PIN 校验端点 | 引导只**写入** `scrypt$…` 哈希，没有验证入口 ⇒ PIN 目前只是「记录在案」，`02` §7 的权限提升仍未收口 |
| 2 | 真机 / 真后端走查七步 | 双端证据目前是**编译 + 单测 + 假传输层**；没有一次「真 HTTP × 真库」的引导 E2E（W8-A 有真库 API 级用例，但没有 UI 参与） |
| 3 | 小程序「非首页入口」的闸门 | 目前只在首页 `redirectTo`；若将来从分享卡片直接进「审批 / 心愿」，那条路径不经过首页 |
| 4 | 并发两次 `complete` 压测 | 靠后端 `SELECT … FOR UPDATE` 设计；真库未压测（W8-A 遗留） |
| 5 | 法务文本 | 仍是占位版本（`2026-10-draft`），第①步明确写出「正式上线前会替换并重新征求同意」 |
| 6 | 第⑤步的「6–12 条」内容量 | 模板库仍是 18 条（`preschool` 1 条 / `junior_high` 0 条）；`junior_high` 家庭会看到很薄的列表（`04` §4 的 R4 风险） |
| 7 | 排序的模糊匹配 | 「命中数」只按字符串相等计数；改名 / 同义词不算命中 |

---

## 9. 下一步建议（W8-C 候选）

1. **`POST /auth/parent-mode`（PIN 校验）** —— 让 `pinSetAt` 真正变成保护，
   这是 `02` §7 与 `04` §2 第⑥步共同的收口点；顺带把「每次都要输 PIN」的跳过说明落实。
2. **引导 E2E**：`test-db/onboarding-e2e-db.dbtest.ts` 用真 HTTP 走完
   ①→⑦（含 `POST /consent` 与 `add habit`），断言首页 `habits[]` 非空。
3. **W9 联调清单**：把「真机七步走查」列入验收（`04` §6 4.9 的 90 秒可用性测试也在这里）。

