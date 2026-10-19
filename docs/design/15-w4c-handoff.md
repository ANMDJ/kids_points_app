# 阶段 W4-C 交接单 · 小程序只读接入（`GET /home` / `GET /records`）

> ## ✅ 已收口（2026-10-19）
>
> | 闸门 | 结果 |
> |---|---|
> | `cd kids_points_mp && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | ✅ 退出码 **0** |
> | `cd kids_points_mp && npm run build:weapp` | ✅ 退出码 **0**（Compiled successfully；仅 Dart Sass `@import` 弃用警告，全仓既有） |
> | `cd kids_points_mp && node .tmp_test/run.js` | ✅ **37/37 ALL PASS**（含 W4-C 新增用例） |
> | `flutter analyze` | ✅ **No issues found** |
> | `flutter test` | ✅ **51/51**（`test/read_api_test.dart` 10 条） |
> | 后端 | **本阶段未改后端、未新增迁移**，沿用 W4-A / W4-B 的只读端点与游标 |
>
> **给**：接手写端点（W5 起）的下一个会话。
>
> **一句话状态**：小程序配齐三项 env 后，首页与记录页读的是服务端 `/home` 与 `/records`；
> 记录页的「加载更多」使用服务端签发的 `nextCursor`，切换分类会从第一页重取。
> **写端点仍未建**，live 模式全部写入口只提示只读，不改内存状态。

## 1. 这一步在补什么

W4-B 结束时，Flutter 已能消费两条只读端点，但小程序仍只读本地种子：

```
同一份后端数据 ──> Flutter 显示服务器数据
              └──> 小程序仍显示演示数据（用户看到两个版本）
```

W4-C 把小程序补到同构：**读数走网络，写操作仍留在本地预览模式；live 模式不假装写成功。**

| 变化 | W4-B 后 | W4-C 后 |
|---|---|---|
| 小程序首页余额 / 习惯 / 心愿 | 本地种子 | live 模式来自 `GET /home` |
| 小程序记录页 | 本地 `recordsOf(category)` | live 模式来自 `GET /records`，服务端按分类过滤 |
| 分页 | 无 | `nextCursor` ＋ 「加载更多」；切分类回第一页 |
| 写入（打卡 / 兑换 / 规则…） | 本地成功 | live 模式**明确拒绝**，提示只读 |
| 失败表现 | 无 | 保留旧数据 ＋ 横条说明「现在看到的是哪份数据」 |

## 2. 配置与降级

`config/index.ts` 用 Taro `env` 白名单注入三项：

| 变量 | 含义 |
|---|---|
| `TARO_APP_KP_API_BASE_URL` | 后端地址，必须是 `http://` 或 `https://` |
| `TARO_APP_KP_DEVICE_ID` | `DeviceSession.deviceId` |
| `TARO_APP_KP_CHILD_ID` | `Child.id` |

- **三项缺一即降级为本地预览**，不抛错、不白屏；预览模式不显示只读横条。
- 非 http(s) 的 baseUrl 在构造客户端时就被拒绝（防止把配置错误当成网络错误）。
- 这些值在**编译期**注入；改 `.env.local` 后必须重新 `npm run build:weapp`。
- `.env.local` 已加入 `kids_points_mp/.gitignore`；样例见 `.env.example`。

## 3. 代码落点

### 3.1 小程序只读层

| 文件 | 职责 |
|---|---|
| `src/data/read_api_errors.ts` | `ReadApiErrorKind`（network / status / malformed）＋ 面向用户的中文文案 |
| `src/data/read_dto.ts` | 严格线格式解析；不做 `?? 0` / `?? ''` 兜底；`hasMore ⇔ nextCursor` 自洽 |
| `src/data/read_mapper.ts` | DTO → 现有 UI 模型（服务端字段只在这一次转换里改名） |
| `src/data/read_api.ts` | `ReadApiClient`：两个 GET、`X-KP-Device-Id` / `X-KP-Child-Id` 身份头、游标原样回传、`limit` 发送前校验 |
| `src/data/store.ts` | `refreshFromServer()` / `loadMoreRecords()` / `setRecordFilter()` / `ensureInitialRead()`；`readEpoch` 丢弃过期响应 |

### 3.2 UI

| 文件 | 职责 |
|---|---|
| `src/components/ReadStatusBanner/*`（新） | 失败 / 首次加载 / 只读成功三态；失败时区分「首次无数据」与「已有旧数据」 |
| `src/pages/home/index.tsx` | 顶部横条；打卡 / 撤销 / 记一笔只读拦截；下拉刷新（`usePullDownRefresh`） |
| `src/pages/home/index.config.ts`（新） | `enablePullDownRefresh: true` |
| `src/pages/record/index.tsx` | 顶部分类切换、首屏 spinner、页尾「加载更多 / 重试 / 没有更多了」、列表下拉刷新 |
| `src/pages/profile/index.tsx` | 改名 / 回收站 / 恢复演示数据先拦只读 |
| `src/pages/wishlist/index.tsx` | 兑换 / 新增 / 删除先拦只读 |
| `src/pages/rule/index.tsx` | 新建 / 编辑规则先拦只读（避免打开只改内存的表单） |

`ReadStatusBanner` 用「无条件 `useStore()` ＋ `override ?? liveStore`」：测试可注入替身，
同时不违反 Hooks 调用顺序。

## 4. 行为约定（读代码时最容易踩的几条）

1. **live 模式记录页不做本地二次过滤。**
   `visibleRecords` 已是服务端按 `category` 过滤后的结果；再按分类过滤会把后续页漏掉。
2. **切分类＝整页重取，不允许复用游标。**
   `setRecordFilter()` 清空列表、`hasMore`、游标，并发起第一页请求；
   旧分类的 `loadMore` 响应由 `readEpoch` 丢弃。
3. **首屏未成功时切分类，改为整页 `refreshFromServer()`（本轮修的竞态）。**
   如果只重取 records，在途的 `/home` 仍按旧分类生成列表，晚到后会覆盖新分类。
   现在 `usingPreview === true` 时切分类直接刷新首页快照 ＋ 记录页，保证两边口径一致。
   Taro `store.ts` 与 Flutter `app_store.dart` 同步修复，并各有一条回归用例。
4. **失败保留旧数据。** `refreshFromServer()` 失败只写 `readError`，不清余额、不清列表；
   `usingPreview` 一旦为 `false` 不会回退到预览数据。
5. **首屏只拉一次。** `ensureInitialRead()` 在 `readStatus === 'idle'` 时才发请求；
   失败不会自动重试（避免断网时无限打后端），重试入口在横条。
6. **分页去重按 `id`。** 服务端键集分页理论上不重，但客户端仍做了去重兜底；
   失败后重试沿用同一游标，不跳页。
7. **只读只拦 UI 入口。** `isReadOnly` 等价于 `isLiveMode`；所有写入口统一
   `toast(store.readOnlyWriteMessage)` 后直接返回，不调用 store 的写方法。

## 5. 复跑与排障

```bash
cd kids_points_mp
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # 期望 TSC_EXIT=0
npx taro build --type weapp                                      # 或 npm run build:weapp
node .tmp_test/run.js                                            # 期望 ALL PASS（37/37）

cd ..
flutter analyze
flutter test
flutter test test/read_api_test.dart
```

- **改了 `.env.local` 没生效**：Taro 在编译期注入，重启 `build:weapp`；检查 `config/index.ts`
  的 `env` 白名单是否包含该键。
- **小程序直接回到预览数据**：三项 env 是否齐全；baseUrl 是否带 `http(s)://`；
  `process.env.*` 在编译产物里是否是空字符串。
- **模拟器请求失败**：微信开发者工具需勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」
  （本地 http）；真机需要备案域名＋合法 TLS。
- **切分类后列表闪回旧分类**：检查 `setRecordFilter()` 是否先 `++readEpoch` 再发请求；
  首屏未成功时是否走了整页刷新分支。
- **记录页少了几条**：不要恢复本地 `recordsOf(category)` 过滤；live 模式只渲染 `visibleRecords`。
- **下拉刷新不出现**：首页检查 `index.config.ts` 的 `enablePullDownRefresh`；
  记录页只有在列表分支（非空）才有内部 `ScrollView` 下拉刷新，空态重试走顶部横条。

## 6. 仍未落地 / 已知边界

| 项 | 状态 |
|---|---|
| 写端点（打卡 / 心愿 / 规则 / 邀请） | ❌ 未建；live 模式只读 |
| 小程序真机联调 | ❌ 本轮只验证 `build:weapp` 与离线用例，未连真后端跑真机 |
| 记录页自动加载下一页 | ❌ 不做；由用户点「加载更多」显式触发 |
| `/home` 缓存 / ETag / 增量同步 | ❌ 刻意不做；刷新即重算 |
| 规则页只读横条 | 不单独放；与 Flutter 一致，只拦写入口 |
| 后端 `test:db` | 本阶段未复跑（未改后端） |

## 7. 签字

- 小程序：`src/data/{read_api_errors,read_dto,read_mapper,read_api,store,types}.ts`、
  `src/components/ReadStatusBanner/*`、`src/pages/{home,record,profile,rule,wishlist}/index.tsx`、
  `src/pages/home/index.config.ts`、`config/index.ts`、`.env.example`、`.gitignore`
- Flutter（同构修复）：`lib/data/app_store.dart`、`test/read_api_test.dart`
- 回归：`kids_points_mp/.tmp_test/run.js`（37 条）
- 证据：`tsc --noEmit` → 0；`build:weapp` → 0；`run.js` → 37/37；`flutter analyze` → 0 issue；
  `flutter test` → 51/51
- 未新增迁移；未修改后端；未放宽任何既有闸门。
