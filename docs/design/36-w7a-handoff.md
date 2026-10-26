# 阶段 W7-A 交接单 · 监护人同意链路（后端）

> **给**：接手「引导第①步 UI / 法务文本 / 数据导出」的下一个会话。
> **本轮只做后端**：端点 ＋ 持久化 ＋ 「撤回后写入停止」的第四道屏障。
> 前端**没有任何**同意入口 —— 别把「后端能拒」读成「用户可以同意」。

## 1. 一句话结论

`GET /consent` / `POST /consent` / `POST /consent/withdraw` 三个端点上齐，
`ConsentGuard` 按**显式清单**（24 写 / 13 豁免，恰好划分 37 个矩阵动作）拦下撤回后的写入；
从未同意（`none`）同样拦 —— **不自动补一条假同意**。
证据：`npm run ci` → `CI_EXIT=0`（`npm test` **41 文件 / 746 条**、`honesty:probe` 5 项全 PASS）。

## 2. 做了什么

| 层 | 落点 | 关键点 |
|---|---|---|
| 契约 | `src/contracts/permission-matrix.ts`（35 → **37**）＋ 迁移 `20261026090000_consent_actions` | 新增 `view_consent` / `manage_consent`（对孩子均 `DENY`）。**不复用** `apply_onboarding`：合并会让「允许完成引导」顺带等于「代表监护人作出同意」 |
| 契约 | `src/contracts/consent-policy.ts` | 「撤回后拦哪些动作」的**唯一事实源**。两个数组**恰好划分**全部动作；未知动作 ⇒ **按写处理**（fail-closed）。`consent-policy.test.ts` 钉住划分完整性 —— 新增动作忘了分类会立刻红 |
| 持久化 | `GuardianConsent`（schema 自 W0 就有，**本轮第一次被读写**） | 授予 / 撤回都在 `$transaction` 内 `SELECT … FOR UPDATE` 锁 `Child` 行：先读最新一行再决定写什么。同版本重复授予 ⇒ **不写 UPDATE、不写审计**；重复撤回 ⇒ 幂等；从未授予却撤回 ⇒ **409 `CONSENT_NOT_GRANTED`** |
| 端点 | `src/consent/consent.controller.ts` | `POST /consent` 回 **200**（记录一条事实，不是创建可寻址资源）；协议版本由服务端 `CONSENT_TEXT_VERSION` 给出（客户端多带 `consentVersion` ⇒ 400，集合封闭）；孩子 403 |
| 屏障 | `src/consent/consent.guard.ts` | 挂在 `@UseGuards(身份, 成员, 矩阵, **同意**)` 第四位。`status !== 'granted'` ⇒ `403 CONSENT_REQUIRED` ＋ `details.status`（客户端据 `none` / `withdrawn` 区分「首次同意」与「重新同意」） |
| 最小化 | `src/consent/hash-pii.ts` | IP / UA 只存 HMAC-SHA256；**没有 `CONSENT_PII_SALT` 就存 `null`** —— 绝不退回无盐哈希或明文 |

## 3. 四个必须知道的判断

1. **豁免口是合规要求，不是仁慈。** `manage_consent` / `view_consent` / `withdraw_request` /
   `switch_role_mode` 在撤回后仍然放行。若连它们也拦，「可撤回」就变成
   「可永久锁死」—— 用户既不能重新同意，也收不回自己已提交的申请。
2. **`none` 一律 403，是故意的，且有上线代价。** 存量家庭升级后第一次写会被拒，
   直到家长在同意页勾选一次。自动补一条同意记录等于伪造合规事实（比 403 糟得多）。
3. **无库一律 501，不返回 `status: 'none'`。** 否则「没查」会被读成「查了、没同意」
   （或反过来被某处当成「没记录 ⇒ 跳过检查」）。离线用例因此**必须**注入同意替身
   （`test/support/consent-fake.ts`）—— 不注入时所有写路径都会停在闸门的 501 上。
4. **闸门按「动作」拦，不按 HTTP 方法拦。** `GET /invites`（邀请码列表）与
   `GET /approvals`（家长收件箱）复用的是写动作 `invite_member` / `review_approvals`，
   所以撤回后这两条**读**也会 403。想放行就**新增读动作**（矩阵 + 迁移 + PRD §7），
   不要在闸门里给 `GET` 开后门 —— 那会让「哪些读被豁免」变成第二份隐式清单
   （`consent-guard.test.ts` 有一条用例专门钉这个）。

## 4. 测试分布

| 文件 | 钉什么 |
|---|---|
| `test/consent-policy.test.ts` | 划分完整性（`unclassified` / `double` / `unknown` 三个都必须为空）、24+13=37、未知动作 fail-closed |
| `test/consent-guard.test.ts` | 单元分支：豁免动作**不查库**、`none` / `withdrawn` 两种 403、漏 `@RequireAction` / 缺 `kpActor` / 缺 `kpChildId` ⇒ 抛错、无库 501 原样传播 |
| `test/consent-http.test.ts` | 真 HTTP：三个端点的契约、无库 501、孩子 / viewer 403、**撤回 → 403 → 重新同意 → 200 → 再撤回 → 403** 的闭环、守卫顺序（孩子越权回 `FORBIDDEN` 而不是 `CONSENT_REQUIRED`） |
| `test/consent-pii.test.ts` | 有盐才哈希、无盐 ⇒ `null`、trim、`x-forwarded-for` 只取第一跳 |

10 个既有离线 HTTP 用例文件各加了一行同意替身（否则它们会从「本模块端口 501」
变成「闸门 501」—— 状态码一样、code 不一样）。

## 5. 未落地（不粉饰）

- **法务文本 L5 未定稿**：版本号是占位 `2026-10-draft`，上线前必须换成真实版本并同步双端文案。
- **前端入口**：引导第①步的勾选、设置页的状态展示与「撤回 / 重新同意」—— 一条都没有。
- **导出 / 删除**：`02` §9.20 的「导出可下载」仍为 ❌，本轮完全没碰。
- **真库并发用例**：`FOR UPDATE` 的并发正确性（两位家长同时撤回 / 撤授交叉）**没有 dbtest 覆盖**，
  无库 CI 验不了。补的时候直接扩 `test-db/`，不要用替身假装验过。
- **`reset_demo_data`**：双侧 `DENY`，按穷尽原则归写侧；它没有端点，也没有实现。

## 6. 给下一个会话的两条硬约束

1. **新增任何矩阵动作，必须同时改 `contracts/consent-policy.ts`** ——
   否则 `consent-policy.test.ts` 会红（这是设计出来的红，不要改用例绕过它）。
2. **不要在 service 里另写「撤回后不写」的判断**。闸门只有一处（`ConsentGuard` ＋ 两张清单）；
   在 24 个 service 里各写一次，等于有 24 个可能忘记更新的地方，而漏掉的那个看起来完全正常。
