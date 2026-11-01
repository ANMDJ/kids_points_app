# 41 · W9-C 交接单：固定规则「日期 ＋ 星期」6 位验证码（2026-10-29）

> 前置：W9-A / W9-B 把**小程序**的登录链路打通（`40-login-and-session-design.md`），
> 而 Flutter 端仍靠 `--dart-define=KP_DEVICE_ID/KP_CHILD_ID` 冒充身份 —— `lib/` 里
> 一行 login 代码都没有。
> 本轮按「**后端先走固定逻辑的验证码，前端正常请求**」落地：规则固定为
> 「日期 ＋ 星期」，判定在**服务端**（服务器时钟），客户端只发一个普通 POST。

---

## 1. 本轮交付（一句话版）

| 层 | 交付 |
|---|---|
| 后端 | `identity/date-verification-code.ts`（纯函数：算码 / 校验 / 容差 / 到期）＋ `POST /auth/date-code`（`@Public`）＋ `dto/verify-date-code.dto.ts`；限流复用 `LoginRateLimiter` |
| Flutter | `lib/data/date_code_dto.dart`（严格解析 ＋ 三类自相矛盾检查）／`lib/data/date_code_api.dart`（普通 POST 客户端、本地 6 位预检、429 带 `retryAfterSeconds`）／`lib/screens/date_code_gate.dart`（**启动闸门**：输码才进 App） |
| 测试 | 后端 `test/date-code.test.ts` **16 条**（规则 4 ／ 容差 6 ／ HTTP 接线 6）；Flutter `test/date_code_test.dart` **14 条** ＋ `test/date_code_gate_test.dart` **12 条**（闸门开合 5 ／ 拦得住 3 ／ 整个 App 冒烟 1 ／ store 3） |
| 文档 | 本文件；`public.decorator.ts` 的「匿名路由」判据从两处扩到三处（并写明理由） |

**没有改数据库、没有改登录与会话**：`POST /auth/date-code` 不写任何表，
`hasDatabase: false` 下照样 200（用例里就是这么起的 app）。

---

## 2. 规则（唯一一份实现）

```
6 位 = MMDD + WW      WW = ISO 星期（周一 01 … 周日 07）
2026-10-29（周四） ⇒  1029 + 04  ⇒  102904
```

| 判据 | 取值 | 为什么 |
|---|---|---|
| 时区 | `Asia/Shanghai` | 孩子的"今天"是家里墙上的日历；UTC 日会在北京 00:30 给出**昨天**的码 |
| 容差 | 前后各 1 天（`DATE_CODE_TOLERANCE_DAYS = 1`） | 时钟差几十秒是常态（23:59 输次日码 / 00:00 刚过提交）；代价是每个码的有效窗口 24h → 48h，见 §5 |
| 到期 | `acceptedUntil` ＝ 命中日 24:00 ＋ 1 天 | 窗口 `[day.start − 1d, day.end + 1d)` 的右端 |
| 墙钟实现 | 复用 `habits/business-day.ts` 的 `businessDayOf()` | 「哪一天」只能有一个定义，否则跨零点两处会互相矛盾 |

---

## 3. 端点契约

```
POST /auth/date-code          （@Public，HTTP 200）
  req   { "code": "102904" }          ← 只有这一个字段；多传 userId 等 ⇒ 400
  200   { "valid": true,
          "serverDate": "2026-10-29",
          "weekDay": 4,               ← 1..7
          "dayOffset": 0,             ← -1 昨天 / 0 今天 / 1 明天；未命中 null
          "acceptedUntil": "2026-10-30T16:00:00.000Z" }   ← 未命中 null
```

| 情形 | 状态码 | 为什么不能换 |
|---|---|---|
| 码不对 | **200 `{valid:false}`** | 它是**校验结果**，不是认证失败。回 401 会让客户端以为"要重新登录"，而调用它的界面此刻可能根本没有会话 |
| 形状错（非 6 位） | 400 | 「少打一位」与「算错了」必须是两句不同的话 |
| 多余键 | 400 | 集合封闭，与全仓库同一口径 |
| 超限 | 429 `DATE_CODE_RATE_LIMITED` | 与登录**共用** `LoginRateLimiter`（同一来源共享 20/分 IP ＋ 10/分设备）；多开一份额度 = 总额放大 2 倍 |

---

## 4. 四个关键判断（都是「看起来可以偷懒，其实不能」的地方）

### 4.1 判定必须在服务端
码本身可推导 —— 客户端自己判等于没判：孩子把手机时间往前拨一天，界面就放行。
放在服务端 ⇒ 用的是**服务器时钟**，而且规则只有一份实现（不漂移）。

### 4.2 `@Public()` 的判据只能是「响应里没有凭据」
`public.decorator.ts` 原本写「全仓库只应有两处」。本轮加第三处时没有放宽判据，
而是把判据写实：**响应里没有任何凭据**（不签发 token、不返回用户数据、不建会话）。
「客户端现在还没登录」不是理由 —— 那条理由会让每一条新路由都想匿名。

### 4.3 码不对回 200，不回 401
见 §3。这条同时决定了 Flutter 侧的接口形状：`verify()` 正常返回 DTO，
`valid=false` **不是异常**（只有形状矛盾才 `malformed`）。

### 4.4 Flutter 不重算规则
客户端只做两件事：本地拦非 6 位（不发请求）＋ 把 `code` POST 上去。
自己算会带来两个后果：手机时间被改 ⇒ 家长按手机算的码永远“错”；规则改了要改两处。

---

## 5. ★ 它是什么、不是什么（这一段必须跟代码一起传播）

**是**：一道「别让孩子随手点进家长界面 / 别误触」的**软门锁**，判定在服务端，
所以改手机系统时间绕不过去。

**不是**认证凭据。`MMDD + 星期` 是**公开可推导**的：任何拿到日历的人 30 秒就能算出
今天的码，认识字的孩子也算得出。因此它**不能**用于：登录、绑定设备、
「证明你是这个家的人」。那些场景要的是服务端**随机、一次性、有 TTL、有限流**的
凭据（`40` §11）。

由此得到两条硬约束：

1. 响应里**永远**不出现 token / userId / 会话状态。一旦有人加，它就必须改回
   `AuthGuard` —— 那等于用可推导的码签发凭据；
2. 容差 ±1 天把有效窗口拉到 48 小时。这是**用可用性换安全**的取舍，且几乎不改变
   威胁模型（码本来就是公开信息）；但它是可调常量，觉得宽就把它调成 0 ——
   代价是跨零点会误伤家长。

---

## 6. 没做的（下一步需要一个决定）

| 项 | 状态 | 卡在哪 |
|---|---|---|
| Flutter 启动闸门（6 位码输入页） | **已做**（2026-10-29 追加，见 §8） | 决策：做成「进门先输码」的启动页（D 方案）。它是**本机软锁**，不签发凭据 —— 见 §5 与 §8.2 |
| 验证通过后**签发 token**（真登录） | **未做** | 缺**身份锚点**：码是全球同一份，无法回答"这个码对应哪一家"。可行路径只有三条：① 请求里再带 `childId` 当**选择器**（凭据仍是码，弱）；② 小程序已登录会话 claim（`40` §10.2 C，需 `POST /auth/pair` + `claim` + 轮询）；③ 走微信开放平台（1–2 周审核）。**在选定之前不动 token 链路** |
| Flutter token 持久化 | **未做** | `pubspec.yaml` 目前只有 `flutter` sdk，没有 `shared_preferences` / `flutter_secure_storage`（`40` §14 Q5 已把这件事推后） |
| Flutter 四个客户端的鉴权头 | **未做** | `read_api` / `write_api` / `onboarding_api` / `parent_mode_api` 都还没有 `Authorization` 支持（≈ 小程序 W9-A 那一轮的等价工作量） |

> 结论：本轮交付的是**可用的后端校验 + 可用的客户端调用**，
> 不是"Flutter 能登录了"。把它当 W9-A 在 Flutter 侧的地基，比当成品更准确。

---

## 7. 现场验证记录（2026-10-29，`npm run build` 后 `node dist/main.js`）

服务器当天：`serverDate=2026-10-29`、`weekDay=4`（周四）⇒ 码 `102904`。

| 请求 | 响应 |
|---|---|
| `{"code":"102904"}`（今天的码） | `200 {"serverDate":"2026-10-29","weekDay":4,"valid":true,"dayOffset":0,"acceptedUntil":"2026-10-30T16:00:00.000Z"}` |
| `{"code":"102803"}`（昨天，容差内） | `200 {…,"valid":true,"dayOffset":-1,"acceptedUntil":"2026-10-29T16:00:00.000Z"}` |
| `{"code":"000000"}`（算错） | `200 {…,"valid":false,"dayOffset":null,"acceptedUntil":null}` |
| `{"code":"10290"}`（少一位） | `400` |
| `{"code":"102904","userId":"u"}`（多余键） | `400` |

自动化：`npm test` ⇒ **56 个文件 / 1055 条全绿**（含本轮 16 条）；
`flutter test test/date_code_test.dart` ⇒ **14 条全绿**；`flutter analyze` 三个文件 0 issue。

---

## 8. Flutter 启动闸门（2026-10-29 追加，D 方案）

### 8.1 落了什么

| 位置 | 内容 |
|---|---|
| `lib/screens/date_code_gate.dart` | `DateCodeGate`：挂在 `home` 最外层。没注入客户端 / 已放行 ⇒ 直接显示 `child`；否则整页锁屏（规则卡 ＋ 6 位输入 ＋ 「进入」） |
| `lib/main.dart` | 注入 `dateCodeApi`（仅 `configured` 时）；`home: DateCodeGate(child: OnboardingGate(child: HomeShell()))` —— **验证在前（谁能用这台手机），引导在后（家长要完成的事）** |
| `lib/data/app_store.dart` | `verifyDateCodeGate(code)`（本地预检 → POST → **只在校验通过时**置 `_dateCodeUnlockedAt`）、`lockDateCodeGate()`、`dateCodeRetrySecondsAt(now)`、`dateCodeError`、`lastDateCodeVerdict` |
| `lib/screens/profile_screen.dart` | 放行后「我的」页多一行「立即锁定入口」：不必重启 App 就能验证闸门（只清本地内存，不发请求） |
| `lib/widgets/form_fields.dart` | `SoftTextField` 新增**可选**参数 `textAlign` / `autofocus` / `inputFormatters` / `enabled` / `style` / `onSubmitted`（默认值不变 ⇒ 其余 4 处调用零改动） |

### 8.2 界面写的三句实话

1. 规则**明写**在锁屏上（`今天的码 = 月日 4 位 ＋ 星期 2 位`，周一 01 … 周日 07，含例子）。码本来就可推导，藏规则只会让家长在门外干着急；
2. 底部固定一句：**「这是本机的入口校验，不是登录：它不会识别你是谁，也不会授予或收回任何账号权限。重启 App 需要重新输入。」**
3. 放行状态**只活在内存**（`_dateCodeUnlockedAt`），不写 `shared_preferences`：把这个码持久化成「已登录」＝ 把门钥匙存在手机里（§5 的第 1 条硬约束）。

### 8.3 两种闸门的**方向相反**（这一条别照抄）

| | `OnboardingGate`（W8-B） | `DateCodeGate`（W9-C） |
|---|---|---|
| 拿不到状态（网络 / 超时 / 5xx） | **放行** —— 否则一次超时就把应用锁死在引导里 | **继续锁着** —— 它存在的意义就是拦住；「不知道」不能当「通过」 |
| 没注入客户端 | 放行（预览 / 测试夹具） | 放行（同上：没有客户端就没有判定者） |
| 钉住它的用例 | `test/onboarding_test.dart` | `test/date_code_gate_test.dart` 的「★ 网络失败 ⇒ 仍然锁着」 |

### 8.4 已知边界（都是取舍，不是 bug）

- **屏内没有「忘记码」出口**：有意的 —— 唯一的求助信息是「今天几号、星期几」，而锁屏已经把规则写在脸上了；
- **±1 天容差 ⇒ 昨天的码也能进**（后端既定行为：2026-10-29 当天 `102803` 与 `102904` 都放行）。界面不额外提示「你输的是昨天的码」，这个差别不影响任何后续动作；
- **它挡不住家长、也不是认证**：真正的门仍是 `POST /auth/parent-mode` 的 PIN（W8-C）；要让「输码」变成登录，必须先解决 §6 的身份锚点。

### 8.5 证据

`flutter test test/date_code_gate_test.dart` ⇒ **12 条全绿**（含一条 `PointsApp` 冒烟：冷启动先锁屏、输码后才看到首页）；
`flutter test` ⇒ **398 条全绿**（原 386 ＋ 本轮 12）；`flutter analyze` ⇒ **0 issue**。


