# 51 · 孩子模式限时窗口（W14，2026-11-03）

> 起因：会话 `1793685029278_j6mpl` 的产品要求 ——
> 「默认进来应该是家长模式（手机家长肯定有，孩子不一定有）；孩子想加心愿要家长审批，
> 家长给孩子**开一段孩子模式**就行；时间让孩子自己输，**上限半小时**；最好引导孩子先写在纸上
> 再填，避免长时间用手机；PIN 是不是就不必要了？」
>
> 上一轮（同一会话）已给出结论并承诺落地，但因为等一个「到期行为」的产品裁定而**一行代码没写**。
> 本轮（2026-11-03）按**推荐且唯一没有安全洞**的 A 方案落地，并补齐双端 + 三线测试。

---

## 1. 产品模型：默认角色跟「身份」走，不跟「开关」走

| 设备上登录的身份 | 默认角色 | 现在的实现 |
|---|---|---|
| 监护人成员（家长自己的手机） | **家长**（不用每次输 PIN） | ✅ 已有：`POST /auth/child-session` / 邀请码加入时 `activeRole = member.role = guardian`，会话 30 天（`identity.prisma.repository.ts:380-395`） |
| 孩子成员 | **孩子** | ✅ 已有：`activeRole = child` |
| 家长把手机交给孩子 | **孩子（限时 1–30 分钟）** | ✅ **本轮新增**（`kidModeUntil`） |

★ **为什么不能把 `DeviceSession.activeRole` 的默认值改成 guardian**：
  孩子迟早会有平板/旧手机。默认 guardian = 孩子自己装 App、自己进家庭就能批自己的心愿，
  整套审批作废。`activeRole` 是「这台设备 × 这个孩子」的临时角色，不是「这个人是谁」。

---

## 2. 三态与 A 方案（本轮采纳）

`DeviceSession.kidModeUntil` 有值就降级为 `child`，**包括已经到点的情况**：

| `kidModeUntil` | 状态 | 角色 | 界面 | 出口 |
|---|---|---|---|---|
| `NULL` | `off` | 按 `activeRole/expiresAt` | 正常 | — |
| `> now` | `active` | `child` | 倒计时 + 「结束孩子模式」 | 家长 PIN |
| `<= now` | `locked` | **仍是 `child`** | 「时间到了，请输入家长 PIN」 | 家长 PIN |

**裁定 A（本轮默认，可回退）**：到期**不**自动回家长模式。

- 如果到期自动回 guardian，孩子只要等 30 分钟就自己拿回了家长权限，还能批自己的心愿 ——
  **比不做管控更糟**，因为它给了「有管控」的错觉。
- 代价：孩子模式的 PIN 从「可选项」变成「必需项」⇒ 开孩子模式时要求该成员**已经设过 PIN**
  （`409 KID_MODE_REQUIRES_PIN`），否则到点后没人能收回这台设备。
- 这与「PIN 是不是不必要了」的答案是同一个：**PIN 不是不需要，是位置从「开」挪到了「收」**。
  开的时候手机在家长手里（已是家长模式），再要一次 PIN 只是摩擦；收的时候是**提权方向**，必须证明是家长。

---

## 3. 接口契约

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/auth/parent-mode` | `switch_role_mode` | 回包新增 4 个字段（见下） |
| `POST` | `/auth/kid-mode` | `switch_role_mode` | body `{ durationMinutes: 1..30 }`；要求成员位 guardian **且当前角色是 guardian** |
| `DELETE` | `/auth/kid-mode` | `switch_role_mode` | body `{ pin }`；**到期后也走这一条**，成功即回到原窗口 |

`GET /auth/parent-mode` 的新增字段（双端 DTO 都做四类矛盾校验）：

```jsonc
{
  "kidMode": true,                 // 窗口内
  "kidModeExpired": false,         // 已到点、等 PIN 收回（与 kidMode 互斥）
  "kidModeUntil": "2026-11-03T10:15:00.000Z",
  "kidModeRemainingSeconds": 900   // 进行中 1..1800；否则 0
}
```

失败语义（与家长模式逐字一致，客户端一个分支就能接住）：

| 场景 | 状态 | code |
|---|---|---|
| 时长 0 / 31 / 非整数 / 缺字段 | `400` | 管道层校验（`@IsInt @Min(1) @Max(30)`） |
| 成员位不是家长 | `403` | `KID_MODE_REQUIRES_GUARDIAN` |
| 成员位是家长但当前不在家长模式 | `403` | `KID_MODE_REQUIRES_PARENT_MODE` |
| 没设过 PIN | `409` | `KID_MODE_REQUIRES_PIN` |
| 已经开着（或到期未收回） | `409` | `KID_MODE_ALREADY_ACTIVE` |
| 孩子模式期间用 PIN 进家长模式 | `409` | `KID_MODE_ACTIVE`（指向 `DELETE /auth/kid-mode`） |
| 收回时 PIN 格式错 | `400` | `PARENT_PIN_FORMAT_INVALID`（**不计次**） |
| 收回时 PIN 值错 | `403` | `PARENT_PIN_INVALID`（计次，剩 N 次） |
| 收回时已锁定 | `429` | `PARENT_PIN_LOCKED`（带 `retryAfterSeconds`，锁定期一次 scrypt 都不跑） |

---

## 4. 数据模型与判定优先级

```prisma
model DeviceSession {
  // ...
  activeRole   MemberRole @default(child)
  expiresAt    DateTime
  kidModeUntil DateTime?   // W14：NULL = 没开；有值即降级（含已到点）
}
```

`session.gate.ts#effectiveRole()` 的唯一顺序：

1. 角色白名单（枚举外的值 ⇒ 500，数据病不伪装成权限病）；
2. **`kidModeUntil` 有值且 `activeRole === 'guardian'` ⇒ `child`**（窗口内与已到点都一样）；
3. `activeRole === 'guardian'` 且 `expiresAt <= now` ⇒ `child`；
4. 其余原样。

★ 只降级 `guardian`：把 `viewer` 改成 `child` 是**提权**（只读成员会突然能打卡）。
★ 坏时间戳 ⇒ `SessionRowShapeError('INVALID_KID_MODE_EXPIRY')` ⇒ 500，**绝不**当成「没开」——
  那等于把家长权限还给正在用手机的孩子。

**开 / 收都不动 `activeRole` / `expiresAt`**：孩子模式是一层覆盖，收回后设备回到**原来那个**窗口
（30 天登录会话，或 5 分钟 PIN 窗口）。若开的时候把 `activeRole` 改成 child，收回时就必须猜「原来是什么」。

---

## 5. 双端交互

- 时长：**1–30 分钟，默认 15**（不是 30：默认即上限会鼓励「反正也是 30 分钟」）；快捷值
  `5 / 10 / 15 / 20 / 25 / 30`；服务端 `clampKidModeMinutes()` 再夹一次。
- 面板文案（常驻，不藏进帮助页）：
  「建议先让孩子把想做的写在纸上、想清楚，再来手机上填 —— 减少盯着屏幕的时间。」
  「到点后需要你输入家长 PIN 收回；不会自动回到家长模式。」
- App **四个 tab 的抬头栏**常驻一条状态条（2026-11-10 起是
  `lib/widgets/parent_mode_banner.dart`，它同时显示孩子模式进行中 / 已到期两种文案），
  点它进面板。**不渲染静态倒计时**——它每秒从服务端给的绝对时刻 `kidModeUntil` 现算；
  原来的首页专用 `kid_mode_banner.dart` 已删除（两行同样的字会让人以为出了两次状态）。
- 孩子模式期间能做什么：打卡、提交心愿（403 `APPROVAL_REQUIRED` → 落 `POST /approvals`，
  这条在 W13 已实现）；家长专属动作 403 / 转审批。
- 唯一出口：「结束孩子模式」+ 家长 PIN（面板里，到期与未到期同一个按钮）。

---

## 6. 改动清单（按层）

| 层 | 文件 | 说明 |
|---|---|---|
| DB | `backend/prisma/schema.prisma`、`backend/prisma/migrations/20261103120000_kid_mode/migration.sql` | `DeviceSession.kidModeUntil DateTime?`（存量行 NULL） |
| 规则内核 | `backend/src/auth/kid-mode.policy.ts` | `MIN/MAX/DEFAULT`、`clamp`、`kidModeExpiresAt`、三态、剩余秒数 |
| 身份内核 | `backend/src/device-session/session.gate.ts` | `kidModeUntil` 参与 `effectiveRole()`；新形状错误 `INVALID_KID_MODE_EXPIRY` |
| 端口 / 适配器 | `backend/src/auth/auth.repository.ts`、`auth.prisma.repository.ts` | `enterKidMode` / `exitKidMode` 两个事务 + 审计 |
| 业务 / HTTP | `backend/src/auth/auth.service.ts`、`auth.controller.ts`、`dto/*kid-mode*` | 五条顺序 + 两类 409 + 与家长模式一致的 PIN 语义 |
| App | `lib/models/kid_mode.dart`、`lib/models/parent_mode.dart`、`lib/data/parent_mode_{api,dto,mapper}.dart`、`lib/data/app_store.dart`、`lib/screens/sheets/parent_mode_sheet.dart`、`lib/widgets/parent_mode_banner.dart`（2026-11-10 取代 `kid_mode_banner.dart`）、`lib/screens/home_shell.dart` | 模型 / DTO / 客户端 / store / 面板 / 抬头栏状态条 |
| 小程序 | `kids_points_mp/src/data/parent_mode.ts`、`store.ts`、`src/sheets/ParentModeSheet.tsx`、`sheets.scss`、`package.json` | 同构；新增 `npm test`（统一入口 `run-all.mjs`） |
| 守门 | `tools/kid-mode-check.mjs` | 三端常量 + 快捷时长逐字比对；篡改副本必须 exit 1 |

---

## 7. 测试证据（2026-11-03 实测）

| 线 | 命令 | 结果 |
|---|---|---|
| 后端单测 / HTTP | `cd backend && npm test` | **1195 用例 / 66 文件全部通过**（新增 `kid-mode-policy.test.ts`、`auth-http.test.ts` 组 G、`session-gate.test.ts` 组 F） |
| 后端真库 | `cd backend && npm run test:db` | **24 个用例文件 / 373 用例全部通过**（新增 `kid-mode-db.dbtest.ts` **12 条**：装配/开/收/到期/权限五组，含「到期后仍被矩阵挡住」「收回回到 30 天窗口」「审计 via=guardian_handoff / pin_release」） |
| App | `flutter test` | **519 条全部通过**（新增 `test/parent_mode_test.dart` 的 W14 三组：DTO 矛盾形状 / store 动作 / API client 线格式） |
| App 静态 | `flutter analyze` | **No issues found**（本轮修掉了测试替身的两个 unused 参数） |
| 小程序 | `cd kids_points_mp && npm test` | **20 个 `run-*.mjs` 全部通过**（含新增 `run-w14.mjs` **14 条**）；`npm test` 以前**不存在**，是本轮补上的 |
| 三端守门 | `node tools/kid-mode-check.mjs` | **PASS**；把副本的 30 改成 45 ⇒ **exit 1**（3 处） |

---

## 8. 已知边界（不粉饰）

1. **忘记 PIN = 孩子模式收不回来**。这是 A 方案的直接代价，也让 `43` §0 的
   **P1-7「忘记家长 PIN 的重置通道」从 P1 变成硬前置**：没有重置通道时，
   唯一出路是另一位家长设备或清 App 数据（后者会连登录一起丢）。
   本轮的缓解是「没设 PIN 就不许开孩子模式」（409），把死锁挡在入口。
2. **真机走查未做**：本环境无 GUI，面板 chip、首页状态条、`DELETE` 带体在
   微信 / Android WebView 上的实际表现，仍属**验收未完成**（`43` §0「验收边界」）。
3. **旧客户端兼容**：服务端新增了 4 个字段；旧 APK / 旧小程序**忽略**它们（不会解析失败），
   但旧客户端看不到孩子模式，也不会显示「到期锁」。⇒ **先发后端，再发双端**。
4. **时长上限的三端一致由脚本保证**，但「服务端夹子」仍是权威：脚本只能证明常量相同，
   不能证明运行时真的调用了 `clampKidModeMinutes()`（那是单测 `kid-mode-policy.test.ts` 的活）。
5. **审计复用 `switch_role_mode`**（不新增 `ActionType`）：区分靠 `after.via`
   （`guardian_handoff` / `pin_release`）与 `after.durationMinutes`。这样避免一次
   `ALTER TYPE`（不可回滚）+ honesty-probe 对账表改动；代价是查审计时要看 `after`。

---

## 9. 变更记录

| 日期 | 变更 | 起因 |
|---|---|---|
| 2026-11-03 | 新增 W14：`kidModeUntil` + `POST/DELETE /auth/kid-mode` + 双端面板/状态条 + 三线测试 + `tools/kid-mode-check.mjs`；采纳 A 方案（到期锁 PIN） | 会话 `1793685029278_j6mpl` 的产品要求；上一轮只出方案未落地，用户要求「能开发就直接开发」 |

