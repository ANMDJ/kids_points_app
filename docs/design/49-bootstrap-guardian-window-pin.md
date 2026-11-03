# 49 · 引导第⑥步 PIN 改必填 ＋ 家长模式面板的可执行出口（D7，2026-11-03）

> 起因：2026-11-03 复核「用**网站码**注册的家庭，家长权限只有 5 分钟」时发现的死锁 ——
> 引导第⑥步允许**跳过 PIN**，而跳过者 5 分钟窗口一到期就既进不了家长模式、
> 也没有权限在本机补设 PIN。产品口径登记在 [`43`](./43-open-work-backlog.md) §8 **D7**，
> 用户 2026-11-03 回复「听你的建议，按你的计划开发」⇒ 按 D7 的**默认建议**落地。
>
> 本文只回答三件事：**卡在哪（证据）** / **改成什么（文件级）** / **怎么验证与还剩什么**。

---

## 1. 一句话结论

**引导第⑥步的 PIN 从「可跳过」改成「必填」**（双端同构），
**存量「已跳过 PIN」的账号**在家长模式面板里拿到一条**真的能点**的出口
（「退出登录 → 用手机号/密码重新登录」）。
权限矩阵、后端端点形状**一个都没动**。

---

## 2. 死锁是怎么形成的（全部可复核）

| # | 事实 | 证据 |
|---|---|---|
| ① | 用网站码注册 ⇒ `membership: null` ⇒ 走 `POST /children` 建孩子 | `48-public-invite-acquisition.md` §4 |
| ② | `POST /children` 只发 **5 分钟**家长窗口 | `backend/src/identity/identity.service.ts:791`（`parentModeUntil = now + PARENT_MODE_TTL_MS`）＋ `identity.prisma.repository.ts:321-330`（`activeRole='guardian'`、`expiresAt=parentModeUntil`） |
| ③ | 窗口到期后**回落 `child`**（不是 401） | `backend/src/device-session/session.gate.ts:117-131` |
| ④ | 设 PIN 要 `manage_parent_pin`，矩阵里 `child` 是 **DENY** | `backend/src/contracts/permission-matrix.ts:119` |
| ⑤ | 进家长模式要 **PIN**，而面板里没有 PIN 就进不去 | `lib/screens/sheets/parent_mode_sheet.dart` 的 `_enter()`（本地就 `validateParentPin` 拦下） |
| ⑥ | 旧文案让家长「请先用家长账号进入一次家长模式」—— ②③④⑤ 合起来**做不到** | 改前：`parent_mode_sheet.dart` 的 `_statusRows()`；`kids_points_mp/src/sheets/ParentModeSheet.tsx` 的 `statusRows()` |

另一条**不受影响**的路径（这是为什么问题只在网站码这一路出现）：
用**家庭邀请码（guardian）**注册 ⇒ `identity/invite-registration.prisma.repository.ts:108-124`
写 **30 天**家长会话，压根不用 PIN 也能进家长模式。

---

## 3. 裁定：为什么是「必填」而不是「改文案」

D7 给了两条路，默认建议是第一条：

1. **引导第⑥步 PIN 改必填** ⇒ 新账号不会再走到死锁；代价是引导多一次必填。
2. 保留可跳过，只把「5 分钟后需重新用手机号/密码登录才能设置」写进文案 ⇒
   把一次**必做**的设置推迟到「家长还记得密码」的时刻，成功率只会更低。

选 1，并且**顺手补上 2 的出口** —— 因为库里已经存在「跳过 PIN」的存量账号
（含当前测试家庭的账号），只改引导对它们毫无帮助。

**没有**选的第三条路：给「无 PIN 且已回落」的账号开一条免 PIN 的补设通道。
那等于让拿到解锁手机的孩子也能设 PIN（`manage_parent_pin` 的 DENY 就是为这个），
直接推翻 `02` §7 的权限矩阵。

---

## 4. 落地清单（文件级）

### 4.1 App（Flutter）

| 文件 | 改动 |
|---|---|
| `lib/models/onboarding.dart` | 新增 `validateRequiredParentPin()`：空串 ⇒ 一句**说清原因**的文案（「引导期的家长权限只有 5 分钟…」），其余委托格式判据。**没有**改 `validateParentPin()`（空串=没填），因为面板与旧客户端还依赖它 |
| `lib/screens/onboarding_screen.dart` | `_complete()` 改走必填判据、`parentPin: pin` 恒传；`_buildFooter()` 的 `case 5` 固定「完成引导」（不再随输入框变成「跳过并完成」）；`_stepPin()` 的 `hintText` 改「4–6 位数字」、说明改成「必须设置 + 为什么」；删除第⑦步的「本次没有设置家长 PIN」分支与 `_pinSet` 字段（已成死代码） |
| `lib/screens/sheets/parent_mode_sheet.dart` | `showParentModeSheet()` 从 `SessionActions`（`findAncestorWidgetOfExactType`，不在页面注册重建依赖）**借** `signOut`（不另写一份退出实现）；`ParentModeSheet` 新增可选 `signOut`；`_statusRows()` 的死锁文案改成「…只能这样补：退出登录 → 用申请时的手机号/密码重新登录 → 再回到这里设置」；`_childModeRows()` 在该状态下画「退出登录，用手机号/密码重新登录」；新增 `_signOutAndReLogin()`（**先 pop 面板再退**：退出后闸门会整棵换成登录页） |

### 4.2 小程序（Taro）

| 文件 | 改动 |
|---|---|
| `kids_points_mp/src/pages/onboarding/index.tsx` | `footerLabel` 的 `step === 5` 固定「完成引导」；`step === 5` 分支：空串 ⇒ 本地拦住（零请求）＋ 同一条原因文案，格式错 ⇒ 单独一句；`parentPin` 恒传；`hint` 改「4–6 位数字」、说明同构；删除第⑦步的 `!pinSet` 警告块与 `pinSet` 状态（死代码） |
| `kids_points_mp/src/sheets/ParentModeSheet.tsx` | 死锁文案改成可执行版本（指向「我的」页的**退出登录**）。**没加**面板内按钮：小程序的退出走 `profile` 的二次确认（`pages/profile/index.tsx#handleLogout`），在面板里直接登出会绕过那道确认 |

### 4.3 后端（**只改注释，不改行为**）

| 文件 | 改动 |
|---|---|
| `backend/src/onboarding/dto/complete-onboarding.dto.ts` | `parentPin` 的注释：双端新客户端必填；**服务端仍接受省略**，只为旧版本装机客户端保留 |
| `backend/src/onboarding/onboarding.repository.ts` | `parentPinHash: null` 的含义同步为「旧版本客户端跳过」 |
| `backend/src/onboarding/onboarding.service.ts` | 第⑥步的注释同上（「可跳过」→「对旧客户端保留」） |

> 为什么不把服务端也改必填：`POST /onboarding/complete` 是**非幂等**的，
> 老装机包（1.0.4 及以前）会传省略。改成必填只会让这些用户卡在第⑥步，
> 而我们拿不到任何好处 —— 新客户端在本地就拦住了。

### 4.4 文档

`04-onboarding-and-templates.md`（第⑥步流程图、「每一步都可跳过吗」、验收表 4.7）、
`43-open-work-backlog.md`（§0 快照 + §8 D7）、`docs/design/README.md`（本文件索引）、
`AGENTS.md`（变更记录）。

---

## 5. 验证（本轮实跑）

| 命令 | 结果 |
|---|---|
| `flutter analyze` | **No issues found**（19.8s） |
| `flutter test` | **500 条全通过**（`test/onboarding_test.dart` 新增 2 条：必填判据 / 空串文案；`test/parent_mode_test.dart` 新增 1 条 **widget** 用例：无 PIN + 非家长模式 ⇒ 文案出现、「退出登录」按钮可点且真的调用 `signOut`） |
| `cd kids_points_mp && ./node_modules/.bin/tsc --noEmit -p tsconfig.json` | **EXIT=0**（无输出） |
| `cd backend && npm run typecheck` | **0 error** |

**widget 用例抓到的既有行为**（不是本轮引入，但值得记住）：
`ParentModeSheet` 用的是**传进来的 store**，不走 `AppScope.of`，所以
`refreshParentMode()` 落地后**不会**自动重绘 —— 要等它自己每秒的 ticker `setState`。
表现是「打开面板后最多 1 秒才出现状态行」；用例里用 `pump(Duration(seconds: 1))` 复现。

---

## 6. 仍未做 / 边界

1. **真机验收**：新账号（网站码 → 建孩子 → 引导）在第⑥步留空点「完成引导」，
   必须看到本地红字且**零请求**；小程序同一屏同理。本环境无 GUI（见 `43` §9）。
2. **存量账号的完整路径没走一遍**：需要在真机上确认「面板 → 退出登录 → 手机号/密码登录
   → 家长模式面板显示『这台设备已经有家长权限，但这个账号还没有家长 PIN』→ 设置成功」。
3. **邀请加入的家长也被要求设 PIN**：这是「统一必填」的代价。如果产品希望
   「用家庭邀请码加入的家长可跳过」，需要加来源判据（`modeSource === 'session'`）——
   本轮**有意没做**，因为判据一多就会出现「同一屏两种规则」。
4. **小程序的发布**：`dist/` 构建物需在微信开发者工具里上传（`43` §0「发布边界」），
   本环境无法扫码。
5. **App 侧新版本尚未打包装机**：本轮只改源码；要让修复到达用户手里，仍要
   `flutter build apk --release` ＋ 上传（流程见 `43` §0.1）。
