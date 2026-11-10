# 54 · PIN 5 分钟窗口 · 顶部倒计时 · 多孩子切换 · 习惯进度（2026-11-10）

> 用户一次提了 13 条，逐条回答「为什么这样 / 改在哪 / 哪条没做」。
> 上游口径：`02` §7（家长模式 / PIN）、`51`（孩子模式窗口）、`52`（本机 PIN 锁）、
> `53`（PIN 重置 / requestId）。**本文件不重新定义产品，只记录这一轮怎么落地。**

---

## 1. 逐条对照

| # | 用户原话 | 结论 / 改动 | 证据（文件） |
|---|---|---|---|
| 1 | 登录后首次打开 App，输 PIN 进家长模式，**为什么没有 5 分钟倒计时**？应该有吗？ | **旧实现是「只校验、不提权」**：解锁走 `POST /auth/parent-pin/verify`，不写 `expiresAt`；而登录会话本身是 30 天家长身份（`modeSource=session`）⇒ 服务端没有 5 分钟可倒计时。**现按你的模型改**：解锁走 `POST /auth/parent-mode`（`expiresAt = now + 5 分钟`），并在设完 PIN 后立刻开一个窗口 | `lib/data/app_store.dart#unlockAppWithPin` / `#setParentPin`；`test/pin_guard_test.dart`「输对 ⇒ 进首页并开 5 分钟家长窗口」 |
| 2 | 倒计时放屏幕上，建议顶部抬头栏 | 新增 `ParentModeBanner`，挂在 `HomeShell` 的四个 tab 之上（每秒重绘、从**绝对时刻**现算） | `lib/widgets/parent_mode_banner.dart`、`lib/screens/home_shell.dart` |
| 3 | 不是允许多个孩子吗？如何切换 | App 从「永远取 `children.first`」改成「我的 → 切换孩子」可换（`GET /auth/session` → `POST /auth/child-session` → `adoptChild` → 清页面缓存但**保持解锁**） | `lib/screens/child_switch_{actions,screen}.dart`、`lib/screens/account_gate.dart#_switchChild`、`lib/screens/profile_screen.dart` |
| 4 | PIN 输入页面有点小，做大一点并适配手机 | 数字键按可用宽度算尺寸（72–96 宽、56–76 高，原来写死 76×56）；圆点 14 → 17 | `lib/widgets/pin_pad.dart` |
| 5 | 数字布局往下放，符合人体工程学 | 锁屏改成「上说明 / 下键盘」两段：键盘贴屏幕底部，说明区独立可滚（小屏不会把键盘顶出屏幕） | `lib/screens/pin_guard.dart` |
| 6 | PIN 能否手机上存一份？一定要联网校验吗 | **刻意不存**：库里只有 `scrypt$…`，客户端存任何校验值都等于把「对不对」搬到客户端（改包 / root 即可绕过）；断网时当前策略是**放行**（软锁不 brick，`52` §4）。要做「离线可解锁」必须同时接受这两个代价 ⇒ **B 类，等你裁定** | 本轮未改；见 §3 |
| 7 | 忘记 PIN 时，可以选择联网重置 | 锁屏 / 「修改 PIN」页都加了入口：账号密码 + 新 PIN 两遍 → `POST /auth/parent-pin/reset`；锁屏进来成功后用新 PIN 直接解锁 | `lib/screens/parent_pin_reset_screen.dart`、`lib/data/parent_mode_api.dart#resetPin`、`lib/data/app_store.dart#resetParentPin` |
| 8 | 删除「数据来自服务器」提示；正式版是否一直存在 | **是**（`readStatus=ready` 就画，正式版天天有）。已删：现在只在**读取失败 / 首次加载中**才出现横条（App + 小程序） | `lib/widgets/read_status_banner.dart`、`kids_points_mp/src/components/ReadStatusBanner/index.tsx`；`test/read_api_test.dart` / `test/write_api_test.dart` 改为 `findsNothing` |
| 9 | 4 个 tab 顶部标题太空 | 首页 18→10、心愿单标题栏 56→46、审批 56→46、我的 22→8（dp） | `home_screen.dart` / `wishlist_screen.dart` / `approvals_screen.dart` / `profile_screen.dart` |
| 10 | 能完成两次的任务：已完成 / 未完成分开显示，在哪显示 | **首页「今天的习惯」**：未完成在上、`已完成` 分组在下；副标题常显进度 `今日已完成 1/2 次`（`0/2→1/2→2/2`） | `lib/models/habit.dart#progressTextOf`、`lib/screens/home_screen.dart`、`lib/widgets/habit_tile.dart`；小程序同构 `types.ts` / `HabitTile` / `pages/home` |
| 11 | 近两天内通过的愿望可以撤回 | **本轮未做**：需要新端点（退分 + 心愿复位 + 审计）与三条产品口径 ⇒ 见 §3「未做」 | — |
| 12 | 已撤销的打卡状态为什么没变化 | 根因与第 10 条同一个：`checked` 只在**达上限**时才变，`1/2` 撤销后卡片看起来没变。现在副标题常显 `N/M`，撤销提示也带「（今日已完成 N/M）」 | `lib/screens/home_screen.dart#_tile`、`kids_points_mp/src/pages/home/index.tsx#handleUndo` |
| 13 | 锁屏 PIN 页与「设置 → 家长模式」PIN 页逻辑要统一 | 两处都按「已开启 ⇒ 显示剩余 / 再输一次重置 5 分钟；未开启 ⇒ 输 PIN 开 5 分钟；孩子模式 ⇒ 先收回」；**同一个 PIN**。锁屏副标题会写出这次输 PIN 会发生什么 | `lib/screens/pin_guard.dart`（`subtitle` 三分支）、`lib/screens/sheets/parent_mode_sheet.dart`（原本就有倒计时，未改口径） |

---

## 2. 关键设计：为什么 5 分钟窗口现在「看得见」了

```
输 PIN ──► POST /auth/parent-mode ──► DeviceSession.activeRole=guardian
                                    └─ expiresAt = now + 5 分钟
                                          │
              ParentModeBanner（顶部，每秒重绘）◄── GET /auth/parent-mode 的绝对时刻
```

- 倒计时**只**从 `parentModeExpiresAt` 现算（本地自减在后台挂起 / 改系统时间后会撒谎）。
- 顶部状态条的五种文案：孩子模式进行中 / 孩子模式到点 / 家长模式剩余 `mm:ss` /
  家长模式已结束（`pin` 来源且剩余 0）/ 家长身份（登录会话，没有倒计时）。

- **窗口到期不强制锁屏**：正在填表 / 看记录时突然被锁会丢操作。到期后抬头栏立刻
  变成「家长模式已结束 · 输入 PIN 再开 5 分钟」，点一下就回到锁屏式键盘。
  离开 App（`paused` / `hidden`）仍然立刻上锁 —— 这是 `52` 的原口径。

---

## 3. 没做 / 只能等你的（每条都带卡点类别，口径见 `50`）

| 事项 | 卡点 | 说明（要什么才能开工） |
|---|---|---|
| **第 11 条：近两天内「已通过」的愿望可撤回** | **B（产品裁定）＋ C（我能做）** | 需要先定三件事：① 撤回是「退分 + 心愿恢复为未兑换」还是「只退分」？② 谁有权（只有家长 / 申请的孩子也能）？③ 「两天」按审批通过时间（`ApprovalRequest.decidedAt`）还是兑换流水时间？<br>确定后要动：`POST /wishes/:id/revoke-redemption`（新端点，权限复用 `undo_check_in`）＋ 事务内写冲正流水（`reversesRecordId=executedRecordId`）＋ `Wish.redeemed=false` ＋ 审计；App / 小程序各一个入口 + 用例。**当前代码里没有任何「撤回已通过审批」的路径**：`POST /approvals/:id/withdraw` 只把 `pending → withdrawn`（`backend/src/approvals/approvals.controller.ts`）。 |
| **第 6 条：PIN 在手机上存一份 / 离线解锁** | **B（安全权衡）** | 本地只可能存「派生校验值」。代价：① 改包 / root 后可离线爆破（4–6 位数字，空间只有 10⁴–10⁶）；② 与当前「断网放行」的策略叠加，会让锁屏在断网时**看起来能用**而实际没有服务端事实。要做需要明确接受这两条，并规定「本地连续错 N 次就强制联网」。 |
| App 的「输入 PIN 就开 5 分钟」改变了 30 天会话的语义 | **B（已按你的第 1 / 13 条执行，可回退）** | 以家长身份登录的设备，以前解锁**不**动 `expiresAt`（30 天）；现在每次解锁都写 `now + 5 分钟` ⇒ 5 分钟后 `effectiveRole` 回落 `child`，家长专属动作需要再输 PIN。如果你更想保留「家长设备 30 天免验证」，把 `unlockAppWithPin` 改回 `verifyPin` 即可（一行），倒计时状态条会自动消失。 |
| 小程序侧「顶部倒计时 / 多孩子切换 / 忘记 PIN」 | **C（能排期）** | 本轮只同步了小程序的两条低风险改动（去掉常驻横幅、习惯进度 + 分组）。倒计时状态条、切换孩子页、PIN 重置页都要在 Taro 侧各写一份；本轮未排。 |
| 真机验收（PIN 键盘手感、后台往返、切孩子后的首页重建） | **D（真机）** | 本环境无 Android 设备 / 无 GUI。 |

---

## 4. 本轮验证（命令实跑）

| 判据 | 命令 | 结果 |
|---|---|---|
| App 静态 | `flutter --no-version-check analyze --no-pub` | **No issues found**（末次实跑 `ran in 21.8s`，日志 `.tmp_analyze_1110f.log`；中途抓到自己两处真 bug 后修掉再跑） |
| App 用例 | `flutter test` | **510 全通过**（原 509 ＋ `pin_guard_test` 新增「孩子模式到点 ⇒ 输 PIN 走结束孩子模式」1 条；`read_api_test` / `write_api_test` 的「数据来自服务器」断言改为 `findsNothing`） |
| 小程序类型 | `cd kids_points_mp && npx tsc --noEmit -p tsconfig.json` | **EXIT=0**（无输出） |
| 小程序用例 | `cd kids_points_mp && npm test` | **20 个 `run-*.mjs` 全部通过**（`ALL PASS`） |
| 后端 | — | **本轮零改动**（`/auth/parent-mode`、`/auth/parent-pin/reset`、`/auth/child-session` 都是既有端点） |
| 真机 | — | **未做**（D 类；本环境无 Android 设备 / 无 GUI） |

### 4.1 本轮实跑抓到的两个自身缺陷（都已修）

1. **降级路径被在途标记挡住**：解锁走 `enter` 失败（404 / 成员位降级）后要退回
   `checkParentPin`，而后者第一行就判 `_appLockBusy` —— 没有先放开就永远回
   「正在校验，请稍候…」，用户被卡在锁屏。用例 `pin_guard_test` 的 404 那条当场变红。
2. **弹层里的键盘把「退出登录」挤出屏幕**：`PinPad` 整体变大后，
   `ParentModeSheet` 的出口按钮落到了可视区外（`parent_mode_test` 的 D7 用例 tap 打空）。
   已加 `PinPad(compact: true)` 给弹层（锁屏 / 设置页仍是放大版）。


