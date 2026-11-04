# 53 · 本轮交付：requestId/异常过滤 · 忘记 PIN 重置 · 发码 IP 限流 · 迁移随启动（2026-11-04）

> 用户指令（2026-11-04）：「接上次会话 B 没问题，你做 C、D 都做」。
> B 类（`43` §8 D1–D6）按**默认建议**认可 ⇒ `P1-2 / P1-4 / P1-5 / P1-7 / P1-10` 从 B 转 C。
>
> 本文只记录**这一轮真正落地并跑过测试**的东西；没做的在 §6 逐条列出（带卡点类别），
> 不粉饰。任务口径仍以 [`43`](./43-open-work-backlog.md) §0 为准。

---

## 1. 一句话结论

**5 条 C 类任务落地**（后端 4 ＋ 文档 1），全部带可失败的用例或可复核的判据；**4 条 C 类仍未开工**
（`P1-2` / `P1-3` / `P1-4` / `P1-5`），原因写在 §6 —— 不是做不到，是这一轮的时间用完了。

| 项 | 状态 | 证据 |
|---|---|---|
| **P2 requestId ＋ 全局异常过滤器** | ✅ 完成 | `backend/test/request-id-http.test.ts` **9 条** |
| **P1-7 忘记家长 PIN 的重置通道** | ✅ 完成（后端；双端入口未接） | `auth-http.test.ts` 组 I **7 条** |
| **W12 网站发码 IP 限流** | ✅ 完成 | `registration-invite-http.test.ts` 新增 1 条 |
| **P2 迁移随启动** | ✅ 完成（代码；**未部署**） | `backend/docker-entrypoint.sh` ＋ Dockerfile `ENTRYPOINT` |
| **P1-10 Web 版定位** | ✅ 完成（文档） | `README.md`「Web 版定位」一节 |

---

## 2. P2 · requestId ＋ 全局异常过滤器

### 做了什么

| 文件 | 作用 |
|---|---|
| `backend/src/common/request-id.ts` | 中间件：先给请求/响应写 `x-request-id`，再交给下游 |
| `backend/src/common/all-exceptions.filter.ts` | `@Catch()`：未预期异常 ⇒ 500 信封（带 `requestId`）；`HttpException` ⇒ **原样**序列化 |
| `backend/src/app.setup.ts` | 新增 `applyHttpFoundation(app)`（中间件 ＋ 全局过滤器），`main.ts` 在 `applyCors` **之前**调用 |

### 三条硬判据（都有用例）

1. **每个响应都有 id**，合法客户端 id 原样回显；非法 / 超长 ⇒ 丢弃并重新生成
   （`[A-Za-z0-9._:-]{1,64}`）：防日志注入、防响应头溢出。
2. **4xx 报文一个字节都不改**：`{ code, message }` 原样 —— 双端 `write_api_errors`
   与 66 个后端用例文件都按这个形状断言。给 4xx 加 `requestId` 字段会让每一处断言
   变成"两份真相碰巧一样"的赌注。
3. **5xx 不回显内部原文**：异常消息里可能有 SQL / `postgresql://user:pass@…`，
   原文只进日志。`KP_EXPOSE_ERROR_DETAIL=1` 才回显（默认关，fail-closed）。

### 日志长这样

```
[3f2c…] POST /records/adjust ⇒ 数据库连接断了 …
```
`grep <id>` 一条就能把人（截图）与日志对上。

---

## 3. P1-7 · 忘记家长 PIN 的重置（`POST /auth/parent-pin/reset`）

### 为什么 W14 之后它是硬前置

孩子模式（[`51`](./51-kid-mode-window.md)）到期**不**自动回家长模式 ⇒ 设备停在 `child`，
唯一出口是家长 PIN。`POST /auth/parent-pin`（改 PIN）要求先输**旧 PIN** —
「设过但忘了」= 这台设备回不去，且没有任何界面能救。本轮补的就是那条唯一旁路。

### 契约

```
POST /auth/parent-pin/reset
权限动作：switch_role_mode（不是 manage_parent_pin）
body：{ password: string, pin: string }        # 账号密码 ＋ 新 PIN
200：{ pinConfigured:true, pinSetAt, changed, clearedFailures, wasLocked, remainingAttempts:5 }
403 CURRENT_PASSWORD_INVALID    密码不对
403 ACCOUNT_PASSWORD_NOT_SET    账号没设过密码（微信登录建的账号）
403 PARENT_PIN_REQUIRES_GUARDIAN 成员位不是家长
400 PARENT_PIN_FORMAT_INVALID   新 PIN 不是 4–6 位数字（**不占**限流额度）
429 PIN_RESET_RATE_LIMITED      每账号每分钟 5 次
```

### 四个刻意的取舍

| 取舍 | 理由 |
|---|---|
| 权限用 `switch_role_mode` | 要救的那台设备正停在 `child`，而 `manage_parent_pin` 对孩子是 DENY —— 用它等于在最需要重置时把门焊死。真正的门是「成员位 guardian ＋ 账号密码 ＋ 限流」 |
| **不**顺手把会话改回 `guardian` | 改会话就是提权；这一步只证明"你是这个账号"。用户拿新 PIN 自己走 `POST /auth/parent-mode`（各留一条审计） |
| 要求给**新** PIN，而不是清空 | 清空 = 设备进入"没有钥匙"，而 W14 之后没 PIN 的设备是另一种锁死 |
| 审计仍记 `manage_parent_pin` ＋ `after.via='account_password_reset'` | 不新造一个矩阵里没有语义的动作；区别写在 `via` 里，审计照样一眼可辨 |

### 用例（`backend/test/auth-http.test.ts` 组 I，7 条）

重置成功（新 PIN 生效 / 旧 PIN 失效 / 计数清零）· 密码错不写库 · 账号无密码 ·
新 PIN 格式错零调用 · 孩子成员位 403 · 孩子模式窗口内也能重置且**不动会话** ·
第 6 次 429。

---

## 4. W12 边界 · 网站发码 IP 限流

| 项 | 值 |
|---|---|
| 配置 | `REGISTRATION_INVITE_IP_DAILY_LIMIT`，默认 **5**，范围 1..20 |
| 判定位置 | `PrismaRegistrationInviteRepository.insertWithQuota()` —— **同一事务内** `count` ＋ 落码 |
| 与"每日发完"的区别 | 两个 code：`REGISTRATION_INVITE_IP_LIMIT`（scope=`ip`）vs `REGISTRATION_INVITE_DAILY_LIMIT`（scope=`daily`） |
| 文案 | 只说「同一个网络」＋ 已申请几个；**不**回显 IP（那是对方信息，也怕被截图） |

为什么默认 5 而不是 1：同一公网 IP 后面是一个家庭 / 一所学校 / 运营商 NAT；
限成 1 会把「一家人给两个亲戚申请」直接拒掉，而这一层要挡的是「脚本刷完 50 个名额」。

**仍未做**（`43` §0 「W12 边界」行的另外三项）：额度行不清理 · 手机号/邮箱不验证 ·
「重新申请」不吊销旧码。

---

## 5. P2 · 迁移随启动

- 新增 `backend/docker-entrypoint.sh`：`npx --no-install prisma migrate deploy`（幂等）→
  **失败则 exit 1**（不带旧 schema 接流量）→ 成功才 `exec "$@"`。
- `Dockerfile`：拷入口 ＋ `chmod +x` ＋ `ENTRYPOINT ["/app/docker-entrypoint.sh"]`，
  `CMD` 仍是 `node dist/main.js`。
- 逃生开关：`PRISMA_MIGRATE_ON_START=0`（只在"库正在恢复、先把服务拉起来看日志"时用）。

**未部署**：本机没有 docker（`where docker` 0 命中），镜像要在服务器重建才生效；
入口脚本在容器里跑，**Windows 本机没法验**。⇒ 这一条属于「代码完成、部署待做」。

---

## 6. 本轮**没做**的（照实列，带卡点）

| 条目 | 类别 | 一句话原因 |
|---|---|---|
| `P1-3` 审批详情 ＋ 通知深链 | **C** | 双端 ＋ 后端详情读取，工作量最大的一条；本轮时间用尽 |
| `P1-2` 回收站 90 天清理 worker | **C**（D4 已认可默认建议） | 需要新 worker ＋ 真库用例；未开工 |
| `P1-4` 习惯独立 CRUD | **C**（D6 已认可） | 要加 `POST/PATCH /habits` ＋ 矩阵/契约同步；未开工 |
| `P1-5` 预设头像 | **C**（D6 已认可） | 要加 `avatar` 字段 ⇒ **需要迁移**；本机无库，不敢留未应用的迁移 |
| `P1-10` Web 版定位写死 | ✅ **已完成（2026-11-04）** | 在 `README.md`「Web 版定位」一节按默认建议写死**仅内部联调、不对外发布**，并列出四个"要对外必须先补齐"的条件（缓存策略 / CSP ＋ XSS 说明 / CORS 白名单 / 进 CI ＋ 部署脚本） |
| `P1-7` 双端入口 | **C**（后端已完成） | App / 小程序还缺「忘记 PIN」入口；后端契约已就绪 |
| 推送到真机 / 真库验收 | **D** | 本机无 psql / docker / 真机；见 [`50`](./50-unfinished-reasons-and-unblock.md) §3 |

---

## 7. 本轮实跑验证

| 命令 | 结果 |
|---|---|
| `backend npm run typecheck` | **EXIT 0** |
| `backend npm run typecheck:tests` | **EXIT 0** |
| `backend npm run typecheck:tools` | **EXIT 0** |
| `backend npm test` | **1218 条 / 0 fail**（`ℹ tests 1218` / `ℹ pass 1218` / `ℹ fail 0`，日志 `backend/.tmp_tests_run7.log`） |
| `npx prisma validate` | **OK**（`schema.prisma` 只改了 `issuedIpHash` 的注释，无迁移） |
| `flutter test` / `flutter analyze` | **本轮未跑**（没有改 Dart 代码） |
| 小程序 `tsc` | **本轮未跑**（没有改 TS 客户端代码） |

> 本轮新用例在写的过程中**抓到自己两个 bug**（都是"实现与用例说法不一致"）：
> ① 429 的报文体漏了 `retryAfterSeconds`（只有文案里有，客户端拿不到）；
> ② 限流用例借用了在别的用例里已消耗额度的账号（改成专用干净账号 AUNT）。
> 这两条说明「新用例必须能在改坏实现时变红」不是形式要求。

> 诚实标注：本轮改动全部在后端 ＋ 运维脚本；前端一行未动，所以没跑前端测试。
> 下轮接 `P1-7` 双端入口 / `P1-3` 时，必须补跑 `flutter test`、`flutter analyze`、
> 小程序 `npm test`。
