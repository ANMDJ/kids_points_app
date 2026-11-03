# deploy/ —— 生产部署（2C/4G 腾讯云 · 82.157.153.22）

本次首次上线：**2026-11-01**。下面每一条都是当天在真机上跑过、失败过、修好后的复述，
不是设想。改这里之前先读「已知坑」那一节。

```
/srv/kids-points/
├── backend/            # 代码（backend/ 整个目录，含 .dockerignore）
├── deploy/             # 本目录（compose.yaml）
├── kids.env            # 17 个环境变量，权限 600（不是 backend/.env）
└── .secrets/           # app-pw / 各种口令（600）
```

---

## 0. 拓扑（★ 最容易踩的一条）

| 容器 | 网络 | 端口 |
|---|---|---|
| `pg18`（PostgreSQL 18.6） | `bridge` 172.17.0.2 **+ `deploy_default` 172.18.0.2** | 仅 `127.0.0.1:5432` |
| `deploy-kids-api-1` | `deploy_default` | 仅 `127.0.0.1:3000` |
| Caddy（宿主 systemd） | 宿主网络 | 80 / 443 |

**为什么 kids.env 里的 host 写 `pg18` 而不是 `127.0.0.1`：**

容器里的 `127.0.0.1` 是**容器自己**。pg18 只把 5432 发布到**宿主的回环**，
所以从 kids-api 容器连 `127.0.0.1:5432` 必然 `P1001: Can't reach database server`。

正解是让两个容器落在同一个自定义网络里，用**容器名**互访：

```bash
# 一次性、幂等；pg18 的配置与端口映射都不动，不重启
sudo docker network connect deploy_default pg18
```

⚠️ **这个附加是运行时的**。以下两种操作会丢掉它，之后 `docker compose up` 会起来但连不上库：

- `docker compose down`（删掉 `deploy_default` 网络）后再 `up`
- pg18 容器被**重建**（`docker compose up --force-recreate` 之类）

症状：容器 `Up`，日志刷 `P1001`。修法就是**再跑一次上面那条命令**。
（把 pg18 的定义搬进本 compose 是最彻底的解法，但那要动 hub 那边的编排，暂不做。）

---

## 1. 构建镜像

```bash
cd /srv/kids-points/deploy
sudo docker compose build          # 产物 kids-api:0.1.0（912MB / 压缩 198MB）
```

首次构建在此处**失败过三次**，前因后果见「已知坑」第 1~3 条。当前 Dockerfile 已修好，
冷构建约 3~5 分钟（`npm ci` 占大头），改代码后热构建约 40 秒（依赖层命中缓存）。

---

## 2. 迁移链（★ 顺序不能换）

每一段都带 `ON_ERROR_STOP=1`，任何一步红了就停，不要往下走。

```bash
cd /srv/kids-points/deploy

# ① 建表（17 个迁移，走 MIGRATION_DATABASE_URL = 所有者 kids_migrator）
sudo docker compose run --rm kids-api npx prisma migrate deploy

# ② 播种规则模板（同一镜像里的 tsx，直连 TS 源码）
sudo docker compose run --rm kids-api npm run seed

# ③ 账本表收权（I5：应用角色不得 UPDATE/DELETE 已记账的行）
cat ../backend/prisma/sql/900_ledger_revoke.sql \
  | sudo docker exec -i pg18 psql -U postgres -d kids_points -v ON_ERROR_STOP=1 -f -

# ④ 给应用角色设口令（口令从 .secrets/app-pw 读，不进 shell history）
cat ../backend/prisma/sql/901_set_app_password.sql \
  | sudo docker exec -i pg18 psql -U postgres -d kids_points -v ON_ERROR_STOP=1 \
      -v app_password="$(sudo cat /srv/kids-points/.secrets/app-pw)" -f -

# ⑤ 12 项判据（★ 必须看到 ALL PASS，否则不许上线）
sudo docker compose run --rm kids-api node scripts/verify-db.mjs
```

**为什么 ③④ 不走容器：** 它们要以 `postgres` 超级用户身份跑，而 kids-api 的连接串用的是
`kids_points_app`（应用）与 `kids_migrator`（所有者）——都不该有建角色/授权的权限。

**2026-11-01 实测结果：** 迁移 16/16 全绿；seed `新增 18 条（reward 16 / penalty 2）`；
verify-db **12 项 ALL PASS → "I5 在真实库上生效"**。

**★ 2026-11-03 补（W12 上线当天踩到，别再踩）：③ 必须跟着 ① 重跑。**

- `GRANT ... ON ALL TABLES` 只覆盖**执行那一刻已存在**的表。新迁移建的表若不再跑一遍 900，
  应用读它就 `42501 permission denied for table ...` —— W12 的 `RegistrationInviteQuota`
  正是这样让 `GET /public/registration-invites/quota` 直接 **500** 的（容器和迁移都"成功"）。
- 根因：`ALTER DEFAULT PRIVILEGES`（不带 `FOR ROLE`）只对**执行者自己**（postgres）建的表生效；
  而本项目的表全部由 `MIGRATION_DATABASE_URL` 的角色 **`kids_migrator`** 创建。
  900 已补一条 `ALTER DEFAULT PRIVILEGES FOR ROLE kids_migrator ...`（②b）；
  即便如此，**重跑 900 仍然是幂等且最便宜的那道保险**。
- 判据：迁移之后 `verify-db` 必须仍是 **ALL PASS**（它现在也覆盖了「应用角色能读新表」）。
- 2026-11-03 实测：迁移 17/17（新增 `20261102090000_registration_invite`）→ 重跑 900 →
  `quota` 从 **500** 变 **200**，`verify-db` 12 项 **ALL PASS**。

---

## 3. 起服务

```bash
sudo docker compose up -d
sudo docker logs --tail 30 deploy-kids-api-1
```

期望日志尾部同时出现：`PrismaService 数据库已连接` + `Nest application successfully started`
+ **五个**后台 worker（审批过期 / 推送重试 / 通知对账 / 队列保留清理 / **家庭数据删除**）。

实测资源：`kids-api 111MiB / 400MiB`、`pg18 74.5MiB`（2C4G 余量充足）。

---

## 4. Caddy：IP + `/k` 前缀（备案未过期间的唯一入口）

`/etc/caddy/Caddyfile` 的 `http://82.157.153.22 { ... }` 块内，**紧挨 `@site` 之前**：

```caddyfile
	@kids path /k/*
	route @kids {
		header Cache-Control "no-store"
		uri strip_prefix /k
		reverse_proxy 127.0.0.1:3000 {
			header_up X-Forwarded-For {remote_host}
		}
	}

	@site not path /_h/* /k/*
```

两条都是**踩过才知道**的：

- **必须排在 `@site` 前面，且 `@site` 要排除 `/k/*`。** 原来的 `@site` 是
  `not path /_h/*`，`/k/auth/login` 会命中它 → 交给 `file_server` → 返回 404
  （看起来像"后端没起来"，其实请求根本没到 Node）。
- **`header_up X-Forwarded-For {remote_host}` 不能省。** Caddy 默认**追加**客户端
  传来的 XFF，而后端 `clientIpOf()` 取的是**第一跳** —— 不覆盖就等于让调用方
  自己挑限流桶。覆盖后实测：客户端带 `X-Forwarded-For: 9.9.9.9` 也照样计入真实 IP。

> **现状（2026-11-01 深夜复核）**：线上 `http://82.157.153.22 { }` 块里**已经没有** `@site`
> （静态站是裸 `file_server`），所以只要 `route @kids` 在就够 —— `route` 的 directive
> 顺序本来就在 `file_server` 之前，属于 terminal handler，不会往下掉。
>
> ⚠️ **这段曾经丢过一次**：hub 搬到 8443 那次改 Caddyfile 时，`@kids` 整段被误删
> （对比 4 个备份可证实：`bak-20261101-203609` / `bak-20261101-8443` 里有，当前文件当时没有）。
> 2026-11-01 23:39 已从备份取回并重新验证。
> **排查口诀**：`/k/auth/login` 返回 404、而 `http://82.157.153.22/` 仍是 200 ⇒ 就是这段没了。

改完必须：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile    # 期望 "Valid configuration"
sudo systemctl reload caddy                          # ★ reload 不是 restart：restart 会切断 hub 的 SSE
```

### 4.1 网站「邀请码获取」（W12）**不需要新增 Caddy 规则**

`GET /invite` 与其它 API 由**同一个 Node 进程**提供，所以：

| 入口 | 是否可用 | 原因 |
| --- | --- | --- |
| `https://www.littlewish.top:8443/invite` | ✅ | 8443 站点整站 `reverse_proxy 127.0.0.1:3000` |
| `http://82.157.153.22/k/invite` | ✅ | `route @kids` 先 `strip_prefix /k` 再反代 |
| `http://82.157.153.22/invite`（裸域名、不带 `/k`） | ❌ | 那个位置是 hub 的 `file_server`，不是本项目的 Node |

若产品要求它出现在**裸域名**上，需要改 hub 那段 Caddy（属于 hub 仓库/运维，不在本仓库）：
在 `http://82.157.153.22 {}` 块里给 `/invite` 与 `/public/*` 加 `reverse_proxy 127.0.0.1:3000`，
并且 **`@site` 也要排除它们**（否则仍会被 `file_server` 抢走 —— 与 `/k` 当年同一个坑）。
本仓库**没有**改那一段，因为改坏会同时影响 hub 首页与 `/_h/*`。

> 页面里的接口地址是**相对**的（`public/registration-invites`），所以它跟着页面所在前缀走：
> `/k/invite` 会请求 `/k/public/...`。不要把它改成 `/public/...`。

---

## 5. 冒烟（每次发布照抄）

```bash
# ① 公网链路 + 微信凭据（这一步同时证明 Caddy 路由、端口映射、AppID/AppSecret 三件事）
curl -s -X POST http://82.157.153.22/k/auth/login \
  -H 'Content-Type: application/json' -d '{"code":"smoke"}'
# 期望 401 + {"code":"WECHAT_CODE_INVALID", "...errcode=40029..."}
#   errcode=40029 ⇒ 微信受理了请求（只是 code 是假的）⇒ 凭据正确
#   errcode=40125 ⇒ AppSecret 错
#   非 JSON / 404 ⇒ Caddy 路由没生效（回去看第 4 节）

# ② 认证门（不带 token 必须 401）
curl -s -o /dev/null -w '%{http_code}\n' http://82.157.153.22/k/auth/session   # 401

# ③ 限流（20 次/60s per IP）
for i in $(seq 1 25); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST http://82.157.153.22/k/auth/login \
    -H 'Content-Type: application/json' -d '{"code":"rl"}'
done; echo
# 期望前 19~20 个 401，其后 429
# 429 响应体带 {"code":"LOGIN_RATE_LIMITED","scope":"ip","retryAfterSeconds":N}

# ④ hub 未受影响
curl -s -o /dev/null -w '%{http_code}\n' http://82.157.153.22/                 # 200

# ⑤ 网站「邀请码获取」（W12）—— 页面 + 额度 + 发码
curl -s -o /dev/null -w '%{http_code}\n' http://82.157.153.22/k/invite       # 200
curl -s -o /dev/null -w '%{http_code}\n' https://www.littlewish.top:8443/invite  # 200
curl -s http://82.157.153.22/k/public/registration-invites/quota
# 期望 200 + {"dailyLimit":50,"remainingToday":N,"resetsAt":"...","timeZone":"Asia/Shanghai"}
#   ★ 发码（POST）会**真的消耗一个名额**，冒烟时不要连点；看到 201 即链路通
curl -s -X POST http://82.157.153.22/k/public/registration-invites \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800138000","email":"smoke@example.com"}'
# 期望 201 + {"code":"ABCD-EFGH",...}；429 表示当天 50 个已发完（不是故障）

# ⑥ 探活（P0-5，2026-11-03 起）
curl -s http://82.157.153.22/k/health
# 期望 200 + {"status":"ok","service":"kids-api","uptimeSeconds":N}
#   ★ 这条**不查库**：用它判断"进程还活着"，不要用它判断"能不能办事"
curl -s -o /dev/null -w '%{http_code}\n' http://82.157.153.22/k/health/ready   # 200
curl -s http://82.157.153.22/k/health/ready
# 期望 200 + {"status":"ok","checks":{"database":{"status":"up","latencyMs":N}}}
#   503 + {"status":"degraded","checks":{"database":{"status":"down",...}}}
#       ⇒ **先看 pg18**，不要重启 kids-api（重启救不了库）
#   503 + status:"unconfigured" ⇒ 这个进程没有 DATABASE_URL（跑的是无库镜像）
```

**★ 探活判据（别再用 `POST /auth/login` 当探针）** —— 2026-11-03 之前
`GET /health` 不存在，只能拿登录端点旁证，而它会真的去调微信 `code2session`
（吃调用额度、污染限流器）。现在的两条端点：

| 端点 | 查库 | 红了你该做什么 |
|---|---|---|
| `GET /k/health` | 否 | 重建镜像 / 看进程（`docker ps`、`docker logs`） |
| `GET /k/health/ready` | `SELECT 1` | 看 pg18 与 `database.detail`；**不要**重启 API |

容器假死（进程活着、HTTP 不应答）由 compose 的 `healthcheck` 标成 `unhealthy`；
**让它真的被重启**要装 watchdog（`deploy/watchdog-kids-api.sh`，见 §8 P0②）。

---

## 6. 切域名（两条路，互不依赖）

### 6.1 Flutter App：走 `www.littlewish.top:8443`（腾讯云手动证书），**不需要 ICP 备案**

自建 App 对域名只要求「证书能被系统信任」，**没有备案前置条件**。备案是**小程序侧**
的要求（微信后台「服务器域名」会校验备案号），App 不走那一套。
8443 的真正价值是**绕开未备案域名在 80/443 上可能被运营商/云厂商拦截**的问题。

**为什么是 `www` 而不是 `kids` —— 2026-11-01 实测结论（★ 别再试 ACME 了）**

`kids.littlewish.top` 的自动签发**三条路都失败了**：

| 尝试 | 结果 |
| --- | --- |
| LE HTTP-01（多视角） | 美国节点 `23.178.112.213` 拿到 200（challenge 正常送达），**亚太节点 `43.174.225.201` 拿到的是 DNSPod 备案拦截页**，LE 报 `Error reading HTTP response body: reader size limit exceeded`；多视角只要一个失败就整体失败 |
| LE TLS-ALPN-01 | 443 直接 `82.157.153.22: Connection reset by peer`（国内方向的 443 被 SNI 规则 reset） |
| ZeroSSL HTTP-01 | Caddy 自动 fallback；单点验证器 `91.199.212.132` 确实拿到 200，但仍未签成 |

于是改用**腾讯云手动签发的 DV 证书**。它的 SAN 是 `littlewish.top` + `www.littlewish.top`，
**不含 `*.littlewish.top`**；`www` 已解析到 `82.157.153.22`（主域 `littlewish.top` 还没有 A 记录）。
所以**唯一能通过系统证书校验的入口是 `https://www.littlewish.top:8443`**。

> 📌 证书在 `/etc/caddy/certs/littlewish.top.{crt,key}`，属主 `root:caddy`、权限 `640`。
> **2027-01-29 到期，不会自动续期**。到期前去腾讯云重新签发 → 覆盖这两个文件 → `systemctl reload caddy`。
> 想彻底自动化只有两条路：① 拿到 `kids.littlewish.top` 的证书；② 给 Caddy 重编译加 DNSPod 插件走 DNS-01。

**配置以 `deploy/caddy-kids.caddyfile` 为准**（两段完整参考，自带位置说明 + 排错速查）：

| 段 | 放哪儿 | 谁在用 |
| --- | --- | --- |
| ① `@kids path /k/*` | hub 的 `http://82.157.153.22 { … }` 块**内部** | 小程序 |
| ② `www.littlewish.top:8443` | Caddyfile **末尾**（独立站点，块外） | Flutter App |

```bash
sudo caddy validate --config /etc/caddy/Caddyfile    # 必须 "Valid configuration"
sudo systemctl reload caddy                          # ★ reload 不是 restart
bash deploy/smoke-8443.sh                            # 7 项全绿再动客户端
```

> ⚠️ `reload` **失败时会继续跑旧配置**，很容易误判成"改了没生效"。`caddy validate`
> 通过不等于 reload 成功 —— 一定再看一眼 `systemctl reload` 的输出。

它的核心只有这几行：

```caddyfile
www.littlewish.top:8443 {
	# ★ 关键行：手动证书，不走 ACME
	tls /etc/caddy/certs/littlewish.top.crt /etc/caddy/certs/littlewish.top.key
	encode zstd gzip
	header Cache-Control "no-store"
	reverse_proxy 127.0.0.1:3000 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
	}
}
```

三条硬约束：

- **端口写在站点地址里**，不要用全局 `{ https_port 8443 }` —— 那会把 hub 所有站点的
  HTTPS 端口一起改掉，hub 当场全挂。
- **必须写主机名**，不要只写 `:8443`（那是 catch-all，会抢走按 IP 进来的流量）。
- 它与第 4 节的 `@kids path /k/*` **不冲突**：一个按「域名+端口」进、一个按路径进，
  两组匹配集不重叠。`/k` 那条**先留着** —— 小程序备案没过，还在用它。

**验收：`bash deploy/smoke-8443.sh`**（7 项，全绿再动客户端）

覆盖 DNS 解析 → TCP 8443 → TLS 证书有效期 → 链路+微信凭据（`401` 且
`WECHAT_CODE_INVALID`）→ 认证门 → **老的 `/k` 仍在** → **hub 未受影响**。
跑完会直接打印客户端该用的 `--dart-define=KP_API_BASE_URL=…`。

```bash
curl -s -X POST https://www.littlewish.top:8443/auth/login \
  -H 'Content-Type: application/json' -d '{"code":"smoke"}'
# 手动验的话：期望 401 + WECHAT_CODE_INVALID，判据与第 5 节 ① 完全一致
```

> ✅ **前后端都不需要跟着改地址**：`backend/src` 里**零处**硬编码 host
> （`grep -rn 'localhost:3000\|82.157.153.22' src/` = 0 命中）。
> `.env.example:50` 的 `PUBLIC_BASE_URL` 是 `L4 阻塞项`预留的**死配置**
> （`src/` 零引用），切域名时**不用填**，填了也不生效 —— 别被它骗。

> ⚠️ **不要再去给 `kids.littlewish.top` 配 ACME**：已经在真机上试遍了（LE HTTP-01 多视角 /
> LE TLS-ALPN-01 / ZeroSSL HTTP-01，见本节上表），全部失败，原因是**验证节点被备案拦截页劫持**
> 与**443 对国内方向 reset**，不是配置写错。继续重试只会白耗 CA 的 rate limit。
> 想用 `kids` 子域，只能另想办法拿证书（腾讯云给 `kids` 单独签一张，或加 DNSPod 插件走 DNS-01）。


### 6.2 小程序：必须等备案

1. DNS 加 `kids.littlewish.top A 82.157.153.22`
2. **先给 `kids.littlewish.top` 弄到证书**（★ 不是放开注释那么简单）
   —— 备案下来后 `kids` 的 ACME 才有机会过（备案拦截页消失、443 可能也放行），
   在**真机验证 ACME 能签成之前**，请按 6.1 的方式固定一张手动证书：
   ```caddyfile
   kids.littlewish.top {
       tls /etc/caddy/certs/kids.littlewish.top.crt /etc/caddy/certs/kids.littlewish.top.key
       reverse_proxy 127.0.0.1:3000
   }
   ```
3. `caddy validate` → `systemctl reload caddy`
4. **同时删掉第 4 节的 `@kids` 路由**（有了域名就不需要 `/k` 前缀了），
   并把 `www.littlewish.top:8443` 站点一并删掉（App 直接改用 `https://kids.littlewish.top`）
5. 小程序 `kids_points_mp/.env.local`：
   `TARO_APP_KP_API_BASE_URL=https://kids.littlewish.top`（去掉 `/k`）
6. 重新构建小程序并上传体验版

> ⚠️ 提醒：备案通过**只解决微信的域名校验**，不等于 ACME 就能签成 ——
> 2026-11-01 实测中 LE 的亚太验证节点拿到的是**备案拦截页**，
> 备案完成后这一条才可能消失。届时先跑
> `bash deploy/smoke-8443.sh HOST=kids.littlewish.top PORT=443` 验证再切。

### 6.3 线上必须先 seed 演示家庭 + 账号（★ 否则 App 登录后一路 401）

第 2 节只 seed 了**规则模板**（18 条 reward/penalty），没有家庭、没有设备会话、
没有登录账号。而 `x-kp-device-id` / `x-kp-child-id` 是**选择器**，服务端会拿它去
查 `DeviceSession` 行并对齐 `userId`（`device-session.guard.ts`）——查不到就是 401。
所以现在用 App 登录，**登录本身会成功，之后每个请求都失败**。

```bash
cd /srv/kids-points/deploy
sudo docker compose run --rm kids-api npm run seed:demo      # 家庭 + 2 条设备会话
sudo docker compose run --rm kids-api npm run seed:account   # 13800138000 / demo12345
```

产出（`prisma/seed/demo-family.ts:47-51`）：

| 项 | 值 |
| --- | --- |
| `childId` | `demo-child`（小明 · 12 分） |
| 家长 `userId` | `demo-guardian` / 设备 `demo-device-guardian` |
| 登录 | `13800138000` / `demo12345` |

⚠️ 会话有 `expiresAt`（`SESSION_TTL_MS`）。过期后不必重跑 seed ——
登录后调 `POST /auth/child-session` 补一行即可（`identity.controller.ts:183`）。

---

### 6.2 App 自更新：`/kids` 反代与 APK 静态目录（2026-11-02，W10-B）

**两件事，一个站点（`hub.littlewish.top:8443`）：**

| 路径 | 去向 | 用途 |
|---|---|---|
| `/kids/*` | `handle_path` 剥前缀 → `127.0.0.1:3000` | Flutter App 的 API（baseUrl = `https://hub.littlewish.top:8443/kids`） |
| `/app/*` | `handle_path` 剥前缀 → `file_server`，root `/var/www/cline-hub/app` | APK 静态下载（App 自更新） |

> ⚠️ **为什么不是 `/k`**：2026-11-02 上午 cline-console 的部署把 IP 站点的
> `@kids path /k/*` 整段移除了，kids API 曾短时间没有公网入口。
> 现在 App 走 8443 的 `/kids`（证书系统可信，不需要明文例外）；
> 小程序的 `http://82.157.153.22/k` 若要恢复，需要把 `@kids` 段加回 IP 站点。

**插入/修复路由（幂等，自动备份 + `caddy validate`）：**

```bash
scp deploy/ensure-kids-route.sh deploy/caddy-kids-8443.snippet ubuntu@82.157.153.22:/tmp/
ssh ubuntu@82.157.153.22 \
  'sudo cp /tmp/ensure-kids-route.sh /tmp/caddy-kids-8443.snippet /srv/kids-points/deploy/ && \
   sudo sed -i "s/\r$//" /srv/kids-points/deploy/ensure-kids-route.sh /srv/kids-points/deploy/caddy-kids-8443.snippet && \
   sudo bash /srv/kids-points/deploy/ensure-kids-route.sh'
```

> `sed -i 's/\r$//'` 不是可选项：仓库 `.gitattributes` 把脚本标成 `eol=lf`，
> 但 **scp 不做换行转换**，带 CRLF 的脚本会报 `set: pipefail`（已知坑见 §6 第 6 条）。

**发布 APK：**

```bash
# 本机构建（不需要任何设备/孩子 id）
flutter build apk --release \
  --dart-define=KP_API_BASE_URL=https://hub.littlewish.top:8443/kids

scp build/app/outputs/flutter-apk/app-release.apk \
  ubuntu@82.157.153.22:/tmp/kids-points-1.0.3.apk
ssh ubuntu@82.157.153.22 \
  'sudo install -o caddy -g caddy -m 644 /tmp/kids-points-1.0.3.apk /var/www/cline-hub/app/ && \
   sudo cp /var/www/cline-hub/app/kids-points-1.0.3.apk /var/www/cline-hub/app/kids-points-app.apk'
```

- `kids-points-app.apk` 是**稳定地址**（`GET /app/version` 默认返回它）；
- 版本化的 `kids-points-X.Y.Z.apk` 保留，便于回滚 / 对比；
- 上传后核对：`curl -sI https://hub.littlewish.top:8443/app/kids-points-1.0.3.apk` 应为 `200` + `content-length` ≈ 包大小。

**版本信息（`/srv/kids-points/kids.env`，改完 `docker compose up -d`）：**

```dotenv
APP_LATEST_VERSION="1.0.3"
APP_LATEST_BUILD="4"
APP_MINIMUM_VERSION="1.0.0"
APP_MINIMUM_BUILD="1"
APP_DOWNLOAD_URL="https://hub.littlewish.top:8443/app/kids-points-app.apk"
APP_RELEASE_NOTES="新增网站「邀请码获取」页（每天限量）；小程序新增邀请码注册页；注册页说明与错误提示同步更新。"
APP_PUBLISHED_AT=""
```

**四条探针：**

```bash
curl -s -o /dev/null -w 'kids=%{http_code}\n' https://hub.littlewish.top:8443/kids/app/version   # 200
curl -s https://hub.littlewish.top:8443/kids/app/version | head -c 200                            # JSON
curl -s -o /dev/null -w 'apk=%{http_code}\n'  https://hub.littlewish.top:8443/app/kids-points-app.apk  # 200
curl -s -o /dev/null -w 'hub=%{http_code}\n'  https://hub.littlewish.top:8443/api/v1/health      # 200（别挤掉 hub）
```


## 7. 已知坑（按踩到的顺序）

### 1) `npm ci` 在 `prisma generate` 处失败：`schema.prisma: file not found`

`package.json` 的 `postinstall` 会跑 `prisma generate`，而 `npm ci` 发生在
`COPY . .` **之前** —— 那时镜像里还没有 `prisma/`。

**修法：** `RUN npm ci --ignore-scripts --no-audit --no-fund`，把 generate 移到 COPY 之后显式跑。

### 2) `prisma generate` 抛 `PrismaConfigEnvError`

`prisma.config.ts` 是 `process.env.MIGRATION_DATABASE_URL ?? env('DATABASE_URL')`，
而 Prisma 在**加载 config 时**就 eager 求值 —— 构建期没有任何 env，于是报错。

**修法：** 给**第一个**键一个占位串就够（`??` 短路，不会去碰第二个）：

```dockerfile
RUN MIGRATION_DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" npx prisma generate
```

generate 只读 `schema.prisma`，**不连库**，所以占位串无害。

### 3) `apt-get update` 卡死 6 分钟 + `No system certificates available`

`node:24-bookworm-slim` 里 **没有 CA 证书**，也**没有 openssl**。两件事叠在一起：

- 直连 `deb.debian.org` 拉 8.7MB 的 `Packages` 索引，在腾讯云上长时间零进展；
- 换 `https://mirrors.cloud.tencent.com` 又因缺 CA 证书报
  `Certificate verification failed ... [IP: 169.254.0.3 443]`
  （该域名在腾讯云内网解析到链路本地地址，走的是内网源）。

**修法：换源时用 `http://`（内网源，无中间人风险），并顺手装 openssl：**

```dockerfile
RUN sed -i 's#http://deb.debian.org/debian#http://mirrors.cloud.tencent.com/debian#g' \
        /etc/apt/sources.list.d/debian.sources \
 && apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
```

**为什么 openssl 非装不可：** 没有它，Prisma 会警告
`failed to detect the libssl/openssl version ... Defaulting to openssl-1.1.x`
并生成 1.1.x 的 query engine；而运行环境里只有 libssl 3 —— 启动即崩。

### 4) `npm run seed` 报 `Cannot find module '../../src/contracts/onboarding'`

`prisma/seed/templates.data.ts` 用 tsx **直接跑 TS 源码**，并 import 了 `src/` 下的
契约常量。运行时镜像当初只 COPY 了 `dist/`。

**修法：** 运行层加 `COPY --from=build /app/src ./src`。

### 5) 数据库连不上（见第 0 节）

`kids.env` 里写 `127.0.0.1` 是容器自己的回环。改成 `pg18` + `docker network connect`。

### 6) Windows 侧脚本上传后报 `set: pipefail\r`

从 Windows 传上去的 `.sh` / 配置带 CRLF，在 Linux 上每一行末尾都多一个 `\r`。
**上传前一律 `sed 's/\r$//'` 归一化**（本仓库 `backend/Dockerfile` 也是这么处理的）。

---

## 8. 上线后仍缺的（2026-11-01 体检）

> 判据：**服务已经在跑**，所以这里只记「跑起来之后才会暴露」的事，不重复
> `docs/design/README.md` 的待办账本（那是功能开发顺序）。每条都标证据位置 —— 别凭印象改。
> 分档只看一件事：**出事时你会不会正好发现**。

### P0 · 出事时才发现就晚了

#### ① 数据库备份 ＋ 一次恢复演练

> ✅ **已完成（2026-11-03）**。脚本 `deploy/backup-kids-db.sh`（已装到
> `/usr/local/bin/kids-backup.sh`），root crontab：`17 3 * * *`（保留 14 天）。
>
> 2026-11-03 实测（真库，非演练环境）：
>
> ```
> OK 备份完成 /srv/backup/kids/kids_points_2026-11-03_1226.sql.gz（10000 字节，保留 14 天）
> OK 恢复演练：restore_test 恢复出 24 张表，PointRecord=0（与线上一致）
> OK 临时库 restore_test 已删除
> ```
>
> 脚本里三条 fail-closed 判据（缺一条这套备份就是假的）：`gunzip -t` 之外还要
> **在 dump 里找到账本表**（连错库时 gzip 依然"完整"）、**恢复后行数与线上逐字相等**
> （0 对 0 也算，但必须比）。`--verify` 用临时库 `restore_test`，用完即删，不碰线上库。

**当时的诊断（保留不改，历史可追溯）**：`pg18` 是宿主机上的独立容器，数据卷在它自己名下；全仓 `pg_dump` **0 命中**，`deploy/` 里也没有备份脚本。也就是说：误删一条、`docker volume rm`、磁盘坏块 —— 任何一种都等于**家庭账本全丢**。

**仍未做（诚实标注）**：

- [ ] **备份离开本机**：现在还在 `/srv/backup/kids`（同一块盘）。磁盘坏 / 整机丢时
      备份一起没 —— 要对象存储（COS）的密钥，脚本里不凭空造。
- [ ] **备份失败告警**：cron 只写 `/var/log/kids-backup.log`，失败不会主动通知人
      （与 P0② 的外部告警通道是同一个缺口）。

最小可用做法（每天 03:10 全量、保留 14 天）：

```bash
sudo mkdir -p /srv/backup/kids && sudo tee /usr/local/bin/kids-backup.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%F_%H%M)
OUT=/srv/backup/kids/kids_points_$STAMP.sql.gz
docker exec pg18 pg_dump -U postgres -d kids_points --no-owner | gzip -9 > "$OUT"
gunzip -t "$OUT"                    # 压缩流完整性（★ 不等于能恢复，见下）
find /srv/backup/kids -name 'kids_points_*.sql.gz' -mtime +14 -delete
SH
sudo chmod +x /usr/local/bin/kids-backup.sh
( crontab -l 2>/dev/null; echo "10 3 * * * /usr/local/bin/kids-backup.sh >> /var/log/kids-backup.log 2>&1" ) | crontab -
```

⚠️ 三件事缺一条，这套备份就是假的：

1. **`gunzip -t` 只证明 gzip 没坏，不证明能恢复。** 上线第一周必须**真恢复一次**到临时库：
   `psql -c 'CREATE DATABASE restore_test'` → `gunzip -c … | psql -d restore_test` →
   `select count(*) from "PointRecord";` 与原库对数 → `DROP DATABASE restore_test`。
2. **备份要离开这台机器**（COS / 对象存储）。同盘同机 = 磁盘坏时备份一起没。
3. 上面 `docker exec` **假设容器内 `postgres` 是本地 trust/peer**。若 PG 配了口令，
   改成 `docker exec -e PGPASSWORD="$(sudo cat /srv/kids-points/.secrets/pg-pw)" pg18 …`，
   并确认该文件 600、不在仓库里。

#### ② 探活 / 告警 / 卡死自愈

> 🟡 **代码侧已完成（2026-11-03，P0-5）**，运维侧还剩两步，见本小节末尾。
> 证据：`backend/src/health/`（`GET /health` 存活 + `GET /health/ready` 就绪，
> `backend/test/health.test.ts` **9 条**用例钉住「存活不查库 / 三态可区分 / 硬超时 /
> 脱敏」）；`deploy/compose.yaml` 的 `healthcheck`（30s 一轮，打 `/health`）；
> `deploy/smoke-8443.sh` 第 8 项；`deploy/watchdog-kids-api.sh`（连续 3 次
> unhealthy 才重启，重启前把 `/health/ready` 的 body 抄进日志）。

**当时的诊断（保留不改，历史可追溯）**：

- `GET /health` **不存在**（`backend/src/identity/public.decorator.ts` 里只有一句
  "若将来加健康检查"的注释）。
- `compose.yaml` 只有 `restart: unless-stopped` —— **它只管进程退出**。
  Prisma 连接池卡死、事件循环堵塞时进程还活着，`restart` 永不触发，用户侧是"一直转圈"。
- 没有 uptime 监控：挂了没人知道，用户也不会来告诉你。

**现在怎么用**：

```bash
# 存活（不查库）：200 status=ok ⇒ 进程能处理 HTTP
curl -s http://127.0.0.1:3000/health
# 就绪（SELECT 1）：200 up / 503 down / 503 unconfigured
curl -s http://127.0.0.1:3000/health/ready

# 装 watchdog（把「unhealthy」翻译成一次重启；compose 自己不会做这件事）
sudo install -m 755 deploy/watchdog-kids-api.sh /usr/local/bin/kids-watchdog.sh
( crontab -l 2>/dev/null; \
  echo "*/5 * * * * /usr/local/bin/kids-watchdog.sh >/dev/null 2>&1" ) | crontab -
sudo tail -f /var/log/kids-watchdog.log
```

★ 三条判据（别搞反，搞反会制造事故）：

1. **compose `healthcheck` 只打 `/health`**。拿 `/health/ready` 当 healthcheck，
   库一慢 API 就被判 unhealthy —— 重启救不了库，只是把「只读降级」也停掉。
2. **`restart: unless-stopped` 不会因为 unhealthy 重启**。它只认进程退出；
   「卡死自愈」靠的是上面那个 watchdog（连续 3 次才动手，抖动不放大）。
3. 日志文件 `/var/lib/kids-watchdog.streak` 是**状态**，不是垃圾：删了等于把
   「已经连续 unhealthy 2 次」清零，卡死会一直等到下一次才够 3 次。

**仍未做（诚实标注）**：

- [ ] **外部告警通道**（企微机器人 / Server酱 / 邮件）—— 需要你给一个 webhook，
      仓库里不能凭空造一个；watchdog 目前只写日志，`unhealthy` 不会主动通知人。
- [ ] **uptime 监控**（进程 down 也要告警）—— 需要外部服务（UptimeRobot 之类）
      或一台不同机房的探针；watchdog 跑在本机，整机挂了它一起挂。
- [x] watchdog 的 cron **已安装（2026-11-03）**：root crontab
      `*/5 * * * * /usr/local/bin/kids-watchdog.sh >/dev/null 2>&1`；
      容器 `Up … (healthy)` 实测（新镜像带 healthcheck 后 19 秒转 healthy）。

#### ③ pg18 的网络附加是手工的，重启即失效

> ✅ **已自愈（2026-11-03）**：`deploy/ensure-kids-pg-network.sh`
> → `/usr/local/bin/kids-pg-network.sh`，root crontab `*/10 * * * *`。
> 幂等：网络在就什么都不做；不在就 `docker network connect deploy_default pg18`
> 并写 `/var/log/kids-pg-network.log`。**不重启任何容器**（重启 API 治不了网络，
> 还会抹掉连接池里的现场）。2026-11-03 实跑 `run_exit=0`（当前已连接，静默退出）。

第 0 节已写清，但失败模式值得再强调：pg18 重启 / 被重建 / `compose down` 之后，
`kids-api` 会 **`Up` 着刷 `P1001`**，看起来像代码坏了，实际是网络没了。
以前唯一的缓解是"人记得再跑一次"；现在上面那个 cron 每 10 分钟兜一次。

- **判据**：`GET /k/health/ready` → `503` + `checks.database.status: "down"` 就是这种情形
  （存活探针仍然 200 —— 这正是两条探针分开的价值）。
- **彻底解法（仍未做）**：把 pg18 搬进本 compose（第 0 节说过"要动 hub 编排，暂不做"）——
  搬进来之后 `depends_on: condition: service_healthy` 才有意义。

#### ④ 法务文本仍是占位版本，而且页面自己写着"占位"

证据是用户能直接看到的两句：

- `kids_points_mp/src/pages/login/index.tsx:168`
- `kids_points_mp/src/pages/onboarding/index.tsx:354`

> 「协议文本仍是占位版本，正式上线前会替换并重新征求同意。」

后端把这套做完了：`ConsentGuard`（第四道屏障）、`GET/POST /consent`、
`POST /consent/withdraw`，`consentVersion` 由服务端定（客户端不能自报）——
而且 8 个页面里**没有协议全文页**（`kids_points_mp/src/pages/` 只有 home / wishlist /
approvals / profile / record / rule / onboarding / login；`grep -rn 隐私政策 kids_points_mp/src`
⇒ **0 命中**）—— 协议只在上面两处以**不可点击的纯文本**出现。

**只缺文本本身**（L5）。它不影响服务跑，但**审核会直接卡在这里**：
儿童个人信息类目没有模糊空间，且《用户隐私保护指引》必须与小程序内协议逐条对齐。

### P1 · 功能闭环断着（用户会发现，但不会报错）

#### ⑤ 邀请码能生成，**却没人能用它加入**

`POST /invites/accept` 有端点、有真库用例（`backend/test-db/invites-db.dbtest.ts`）、
有事务保证（占位 + 成员位 + 会话 + 审计同事务），但：

- `kids_points_mp/src` 里 **`acceptInvite` 出现 0 次**；
- `sheets/InviteSheet.tsx` 的自述就是"生成 / 复制 / 吊销"三件事。

`26-w5i-handoff.md` §5 当时把它归因为"等登录链路（L2）"。**那个阻塞理由已经不成立了**：
登录已落地（`POST /auth/login`，W9-A/B）＋ 账号密码登录（`42-account-login-design.md`）。

后果很具体：家长生成一个码发给亲戚，亲戚打开小程序**没有地方输入它**。
`42` §9 也写了「开放注册的前置是邀请码并入家庭」—— 两条一起卡着。

#### ⑥ 推送一条都发不出去（`PUSH_WEBHOOK_URL` 为空）

`.env.example` 已写明"不配 ⇒ 绑 `NoopPushAdapter`，如实返回 `provider_not_configured`
（**不是故障**）"。取舍清楚，但产品语义上：**孩子提交兑换 → 家长收不到任何提醒**，
只能自己反复打开"审批"tab。**五个** worker 照跑，`retention` 会把 `no_device_token` 的行清掉，
所以**现象是安静的**，日志里不会刷错。

#### ⑦ 回收站 90 天到期**不自动清理**

`docs/design/README.md` 记的口径是"到期不自动清理，过期条目仍列出（标红、只能彻底删除）"。
这是刻意取舍，但它是**只增不减的表**：`PushRetryJob` / `Notification` 有 retention worker，
软删行与 append-only 流水**没有**。单家庭量小，但需要一个"能查出来"的巡检口径，
否则第一次发现会是"磁盘满 + 写库失败"。

#### ⑧ Flutter 侧剩下的（`42` §9，都是取舍不是漏）

- 开放注册（前置同 ⑤）；
- **`TOKEN_EXPIRED` 不静默重登**，token 落在 `Directory.systemTemp` ——
  清缓存 / 系统清临时目录就要重登。这是"不把密码存设备"的代价；
- 解绑标识、真机走查、`P2002 ⇒ 409` 的真库用例。

### P2 · 工程面（不咬人，但会让下次事故变慢）

| 项 | 现状证据 | 说明 |
|---|---|---|
| **没有 CI 平台** | 全仓 `runs-on:` **0 命中**，也无 `.github/workflows`；`docs/design/README.md` 待办 3 明写"仍待你定 CI 平台" | `npm run ci`（**16 步**，2026-11-01 实测计数）与 `npm run ci:db` 都已就绪，只缺 runner。当前所有验证都是**手工跑 + 人肉看输出** |
| **无 requestId / 无全局异常过滤器** | `@Catch(` / `useGlobalFilters` / `APP_FILTER` 全仓 **0 命中** | 线上 500 时日志里只有堆栈，**没有请求标识**，用户截图对不上任何一条日志。Nest 默认日志是纯文本，无 JSON / 无级别分流 |
| **除登录外没有限流** | `login-rate-limiter.ts` 只挂在 `/auth/login`（其文件头已自述"只是减速带"） | 写端点靠业务规则兜（每日 3 条 / 单笔 ±50）。⚠️ 标准 Caddy **没有** `rate_limit` 指令（要 `caddy-ratelimit` 插件重编译），所以"在反代加限流"不是改一行配置的事 |
| **单实例假设** | **5 个** worker 直接 `setInterval`（`main.ts` 的 5 处 `app.get(...).start()`），无分布式锁；限流是进程内存 | 现在单实例没问题。**但"再加一台机器"会立刻让审批扫描 / 推送重试 / 删除 worker 重复执行**（`push-retry` 有 claim 超时可缓解，审批扫描没有） |
| **迁移不随启动执行** | `compose.yaml` 的 `CMD` 是 `node dist/main.js` | 发版忘了 `prisma migrate deploy` ⇒ 新代码查不存在的列 ⇒ 500。§2 是手工链，靠"记得"。可考虑 entrypoint 先跑 `migrate deploy`（幂等），代价是迁移坏了会进重启循环 —— 必须配 `set -e` + 告警，让它在**第一轮**就喊出来 |
| **镜像 912MB** | §1 | 磁盘 89G 不急。`node_modules` 含 devDependencies 是**有意为之**（seed 要 tsx、verify 要 node scripts，见 Dockerfile 头注释），**别随手改成 `--omit=dev`** |
| **`KP_TIMEZONE` 未进 `.env.example`** | 已补（2026-11-01 本次体检） | 默认 `Asia/Shanghai` 所以一直安全；但改时区的人此前看不到这个开关，也不知道拼错会**启动即抛 `RangeError`**（刻意 fail-closed） |
| ~~**`deploy/` 整个目录没入库**~~ ✅ **已修（2026-11-01 23:5x）** | `git ls-files deploy/` 现在列出 6 个文件 | 首次入库：`compose.yaml` / 本文档 / `server-prep.sh` / `caddy-kids.caddyfile` / `smoke-8443.sh` / `www-8443.snippet`。零口令风险：`MIGRATOR_PW` 由 `openssl rand -hex 24` **运行时生成**，`kids.env` 与 `.secrets/` 都在仓库外 |

---

## 9. 下次动生产前的三条规矩

1. **迁移链是五步，不是一步**（§2）。`migrate deploy` 之后漏了 `900` 或 `901`，
   应用会以"能连上、但写不了账本"的方式活着 —— 比连不上更难查（`db:verify` 就是为这个存在的）。
2. **改 `Caddyfile` 一律 `caddy validate` → `systemctl reload caddy`**，不要 `restart`
   （hub 的 SSE 会断）。`/k/*` 与 `@site` 的先后顺序见 §4，改完必须重跑 §5 的四条探针。
3. **改完 `backend/` 就重建**：`docker compose build && docker compose up -d`，
   然后看日志尾部是不是 `数据库已连接` + `Nest application successfully started`
   + **五个** worker；（改动了 `prisma/` 还要回到 §2 整条链）。

