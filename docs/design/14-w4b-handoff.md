# 阶段 W4-B 交接单 · 记录页键集分页（`GET /records?cursor=`）

> ## ✅ 已收口（2026-10-19）
>
> | 闸门 | 结果 |
> |---|---|
> | `cd backend && npm run ci` | ✅ **`CI_EXIT=0`（15 步）** |
> | `cd backend && npm test` | ✅ **17 个文件 / 302 条全部通过** |
> | `flutter analyze` | ✅ **No issues found** |
> | `flutter test` | ✅ **50 条全部通过**（含 `test/read_api_test.dart` 9 条） |
> | `flutter test test/read_api_test.dart` | ✅ **9/9** |
> | 数据库 | **本阶段没有新增迁移**：游标不落库，索引沿用 W4-A |
>
> **给**：接手小程序端分页 / 写端点（W4-C 起）的下一个会话。
>
> **一句话状态**：`GET /records` 从「只会返回最近 50 条」变成**真的能翻页**；
> Flutter 记录页的「加载更多」发的是服务端签发的 `nextCursor`，不再假装到底。
> **但写端点仍未建**，live 模式仍是只读；小程序端尚未接这套游标。

## 1. 这一步在补什么

W4-A 的 `/records` 响应里已经有 `hasMore`，但查询参数只有 `category` / `limit`：

```
客户端：hasMore = true，然后呢？
```

没有游标，客户端只有两条路：永远只显示最近 50 条，或把 `limit` 拉到 200 封顶后
假装读完了。两者都是「把失败装成正常」——明明还有数据，UI 却显示「没有更多了」。

W4-B 补的是**取下一页的能力**，不是一个新的数据源：

| 变化 | W4-A | W4-B |
|---|---|---|
| `GET /records` 入参 | `category` / `limit` | ＋ `cursor` |
| 响应 | `records` / `limit` / `hasMore` | ＋ `nextCursor` |
| `hasMore=true` 时客户端 | 无从下手 | `?cursor=<nextCursor>` 取下一页 |
| 非法游标 | （不存在） | `400 INVALID_RECORD_CURSOR`，**不退回第一页** |

## 2. 代码落点

### 2.1 后端

| 文件 | 职责 |
|---|---|
| `backend/src/read/read.cursor.ts`（新） | `base64url("<ISO-8601>\|<id>")` 的编码 / **严格**解码；非法 ⇒ 400 |
| `backend/src/read/dto/list-records.query.ts` | ＋ `cursor`（非空字符串、≤256）；语义校验仍留给 service |
| `backend/src/read/read.controller.ts` | 把 `query.cursor` 原样交给 service |
| `backend/src/read/read.service.ts` | 先解码游标，再调端口；孩子不存在 ⇒ 与 `/home` 同一个 404 |
| `backend/src/read/read.repository.ts` | `ListRecordsInput.before?: RecordCursor` |
| `backend/src/read/read.prisma.repository.ts` | 键集谓词：`createdAt < c` **OR** `(createdAt = c AND id < c.id)` |
| `backend/src/read/read.mapper.ts` | 用**本页最后一行**生成 `nextCursor`；`hasMore=false` ⇒ `null` |

### 2.2 Flutter

| 文件 | 职责 |
|---|---|
| `lib/data/read_api_errors.dart`（新） | `ReadApiException`：网络 / 状态码 / `malformed` 三分 |
| `lib/data/read_dto.dart`（新） | 线格式解析；`hasMore ⇔ nextCursor` 自洽校验 |
| `lib/data/read_api.dart`（新） | `ReadApiClient`：两个读端点、身份头、游标透传 |
| `lib/data/read_mapper.dart`（新） | DTO → 现有 UI 模型（字段改名只在这一次转换里发生） |
| `lib/data/app_store.dart` | `ReadStatus`、`readOnly`、`visibleRecords`、`refreshFromServer()`、`loadMoreRecords()`、`setRecordFilter()` |
| `lib/main.dart` | `ReadApiConfig.fromEnvironment()` 配置齐全时才注入客户端 |
| `lib/screens/home_shell.dart` | live 模式首帧后自动刷新一次；顶部 `ReadStatusBanner` |
| `lib/widgets/read_status_banner.dart`（新） | 失败 / 首次加载 / 只读成功三态；失败时区分「空数据」与「有旧数据」 |
| `lib/screens/points_record_screen.dart` | 分类切换、首屏 spinner、页尾「加载更多 / 重试 / 没有更多了」 |
| `lib/screens/home_screen.dart`、`wishlist_screen.dart` | live 模式的写入口给固定提示，不假装成功 |
| `lib/screens/profile_screen.dart` | 改名 / 回收站 / 恢复演示数据同样先拦只读 |
| `lib/screens/points_rule_screen.dart` | 新建 / 编辑规则入口先拦只读（否则会打开只改内存的表单） |

## 3. 游标契约（要点）

### 3.1 格式

```
cursor = base64url("<createdAt.toISOString()>|<recordId>")
```

- **不落库、不签名**：它不是权限凭据。能改游标的人最多移动读取窗口；
  `childId` 始终来自会话，跨孩子读取不可能靠改游标实现。
- 客户端**原样回传** `nextCursor`，不要自己拼日期。服务端编码用 `toISOString()`
  （毫秒 + `Z`），客户端若用本地时区或丢掉毫秒，往返比对就会失败 ⇒ 400。

### 3.2 键集而非 offset

账本是**只增**的：翻页期间新记一笔，`OFFSET 50` 会让上一页最后一条再出现一次
（或漏掉一条）。游标钉在「本页最后一行的 `(createdAt, id)`」上，下一页严格早于它：

```
createdAt < cursor.createdAt
  OR (createdAt = cursor.createdAt AND id < cursor.id)
```

排序固定 `(createdAt desc, id desc)`。**两个条件缺一不可**：只比时间会漏掉
同一毫秒内的剩余行；`id` 是同一毫秒的稳定次序。

### 3.3 响应

```
{ records: [...], limit: 50, hasMore: true, nextCursor: "MjAyNi0xMC0x..." }
```

- `nextCursor` 指向**本页最后一行**，不是多取的那条探针行 —— 否则两页会重叠。
- `hasMore=false` ⇒ `nextCursor = null`；服务端 mapper 与客户端 DTO **两侧**都校验
  这个等价关系，任何一侧出现「有 hasMore 没游标」都视为契约损坏。
- `limit` 是本次实际请求的上限，不是本页条数；客户端不靠「本页满不满」猜是否到底。

## 4. 客户端行为

| 场景 | 行为 |
|---|---|
| 进入 live 模式 | 首帧后自动 `refreshFromServer()`（`addPostFrameCallback`，只触发一次） |
| 下拉刷新 | 重新取 `/home` ＋ 当前分类的第一页（**丢弃旧游标**） |
| 「加载更多」 | 用 `nextCursor` 请求下一页；按 `id` 去重后追加 |
| 加载更多失败 | **保留已加载页**，页尾显示重试；重试仍用同一个游标（不跳页） |
| 切换分类 | 清空列表、回到第一页、不带旧游标 |
| 首次加载失败 | 显示错误 + 重试；不显示「还没有记录」 |
| live 模式下写操作 | 打卡 / 撤销 / 记一笔 / 兑换 / 新增心愿一律提示只读，不修改本地状态 |
| 未配置后端 | `readApi == null`，完全走原预览路径，不发任何请求 |

### 4.1 为什么首帧刷新要延后一帧

`didChangeDependencies` 仍在 build 阶段，而 `refreshFromServer()` 会**同步**
`notifyListeners()`。直接调用会触发 `markNeedsBuild() called during build`。
因此首屏加载用 `WidgetsBinding.instance.addPostFrameCallback` 调度；
`_loadStarted` 保证切 tab / store 通知导致的重复 `didChangeDependencies` 不会重复发请求。

## 5. 屏障与状态码

与 W4-A 完全一致（Guard 顺序、权限动作都没动），只多一条入参错误：

| 情形 | 结果 |
|---|---|
| 缺身份头 / 会话不存在 / 不是成员 | `401` / `403`，端口**零调用** |
| 孩子已软删 | `404 CHILD_NOT_FOUND`（两个端点同一个形状） |
| `?limit=0` / `?limit=201` / 未知分类 / 未知键 | `400`，**不查库** |
| `cursor` 不是规范 base64url / ISO 串不可往返 / id 为空或超长 | `400 INVALID_RECORD_CURSOR`，**不查库、不退回第一页** |
| 无库装配 | `501 READ_MODEL_NOT_IMPLEMENTED` |

非法游标必须 400：静默当「没传」会让客户端「加载更多」无限重复第一页，
表现为页面卡在同一批记录上——比一个明确的 400 难查得多。

## 6. 用例（能失败的那种）

| 文件 | 覆盖 |
|---|---|
| `backend/test/read-cursor.test.ts`（新） | 编解码往返；空串 / 超长 / 非规范 base64 / 缺分隔符 / 空 id / 含 `\|` 的 id / 非法 ISO / 非 ISO 写法 ⇒ 400 |
| `backend/test/read-http.test.ts` | `cursor` 透传；非法游标 400 且端口零调用；`nextCursor` 与 `hasMore` 自洽 |
| `backend/test/read-wiring.test.ts` | 适配器收到 `before` 时生成 `OR` 键集谓词；`take = limit + 1`；孩子不存在时 `pointRecord.findMany` **调用次数为 0** |
| `backend/test-db/read-db.dbtest.ts` | 真库两页拼接：无重复、无遗漏、到底 `hasMore=false` |
| `test/read_api_test.dart`（重建） | DTO 自洽三态；游标透传 + 身份头 + limit 边界；AppStore 两页不重不漏、到底停止、失败重试同游标、切分类重取第一页；live 首帧自动刷新 + 只读提示 |

> `test-db` 本轮**没有复跑**（需要活库）；上表它的状态来自 W4-A 的 91/91 基线，
> 本阶段只改了 `/records` 的查询谓词，改动点已由离线 wiring 用例覆盖。

## 7. 本阶段真实踩到的坑

1. **只有 `hasMore` 没有游标 = 假分页**：UI 能显示「还有更多」，却无法取回。
   验收标准不是「接口返回了 hasMore」，而是「第二页真的接在第一页后面」。
2. **游标必须指向本页最后一行**：若指向 `take = limit + 1` 多取的探针行，
   下一页会从探针行之后开始，永久漏掉探针行本身；若指向第一行，则整页重复。
3. **同一毫秒必须有 `id` 兜底**：只比 `createdAt` 会在同毫秒多行时漏数据，
   离线假 Prisma 很容易造不出这个场景，因此真库用例要故意写同毫秒记录。
4. **base64 解码是宽容的**：Node 会忽略多余字符、接受缺 padding 的变体。
   必须做「解码后再编码 === 原串」的往返校验，否则垃圾串会被解成某个日期，
   翻页从错误位置开始且**不会报错**。
5. **非法游标不能退回第一页**：这是最容易写的「友好兜底」，实际表现是
   「加载更多」反复追加同一页（有 id 去重时则表现为按钮永远没反应）。
6. **`didChangeDependencies` 里同步 notify 会炸 build**：首屏刷新必须延到
   post-frame；`_loadStarted` 防重复，而不是靠 `Future` 是否完成来猜。
7. **测试夹具与生产构造签名会漂移**：`defect-status.mjs` 的 E18 断言原本写死
   `AppStore()` 空参；W4-B 给构造函数加了可选注入参数后，CI 的对账步骤误报。
   已改为匹配「任意参数列表」，守的仍然是「构造即空态」这条事实。
8. **并发跑 `npm run ci` 与 `npm test` 会互删 `.tmp_test_build`**：
   本轮真实出现过 `MODULE_NOT_FOUND` 的假红。要复跑就**串行**跑。

## 8. 仍未落地（接手必须知道）

| 项 | 状态 | 影响 |
|---|---|---|
| 规则 / 习惯 / 心愿 / 邀请**写端点** | ❌ 未建 | live 模式只能读；写操作统一提示只读 |
| 小程序端 `kids_points_mp/src/data/store.ts` 接游标 | ❌ 未做 | 小程序记录页仍是一次性列表 / 本地数据 |
| 设备凭据生产验证 | ❌ 仍 503 | 生产环境无法建立会话，只读也拿不到数据 |
| 会话刷新 / PIN 切换 / 15 分钟锁 | ❌ 未做 | 长会话与家长切换不可用 |
| `/home` 快照缓存 / ETag | ❌ 刻意不做 | 每次刷新多几次查询，换「永不显示旧战绩」 |
| 未读数 / 增量同步 | ❌ 未设计 | 记录页只能下拉重取第一页感知新数据 |

## 9. 复跑与排障

```bash
cd backend
npm run ci          # 15 步，不需要数据库；期望 CI_EXIT=0
npm test            # 17 文件 / 302 条（不要与 ci 并发跑）
npm run build       # nest build

flutter analyze     # 期望 No issues found
flutter test        # 50 条
flutter test test/read_api_test.dart
```

- **第二页和第一页重复**：先看游标是不是从「多取的探针行」生成的；
  再看客户端是否在追加前按 `id` 去重。
- **第二页漏了同毫秒的行**：适配器谓词少了 `OR (createdAt = c AND id < c.id)`。
- **`400 INVALID_RECORD_CURSOR` 但游标看起来正常**：客户端是否 URL 编码了两次 /
  截断了 base64url 的 `-` `_`；是否自己拼了本地时区日期。
- **永远 `hasMore=false`**：`take` 是否真的 `limit + 1`；mapper 是否在
  `hasMore=true` 时仍返回了 `null`。
- **首屏白屏且控制台有 `markNeedsBuild during build`**：首屏刷新又被挪回
  `didChangeDependencies` 同步调用了。
- **`npm test` 突然 `MODULE_NOT_FOUND`**：先确认没有另一个 `npm run ci` /
  `npm test` 同时在跑（它们共用 `.tmp_test_build`）。

## 10. 签字

- 后端：`backend/src/read/{read.cursor.ts,dto/list-records.query.ts,read.controller.ts,read.service.ts,read.repository.ts,read.prisma.repository.ts,read.mapper.ts}`
- Flutter：`lib/data/{read_api_errors.dart,read_dto.dart,read_api.dart,read_mapper.dart,app_store.dart}`、
  `lib/{main.dart,screens/home_shell.dart,screens/home_screen.dart,screens/points_record_screen.dart,screens/wishlist_screen.dart}`、
  `lib/widgets/read_status_banner.dart`
- 用例：`backend/test/{read-cursor.test.ts,read-http.test.ts,read-wiring.test.ts}`、
  `backend/test-db/read-db.dbtest.ts`、`test/read_api_test.dart`
- 证据：`npm run ci` → `CI_EXIT=0`；`npm test` → 302/302；`flutter analyze` → 0 issue；
  `flutter test` → 50/50
- 未新增迁移；未修改权限矩阵；未放宽任何既有闸门。

