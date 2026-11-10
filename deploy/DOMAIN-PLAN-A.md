# 域名方案 A 迁移 runbook（2026-11-10 定稿）

> 决策：**每个产品一个二级域名，各自由 Caddy 自动签发并自动续期证书**。
> Kids 的 APK 下载地址**不再挂在 hub 域名下**，改为
> `https://kids.littlewish.top/app/kids-points-app.apk`。
>
> 本文是服务器侧的唯一操作口径；历史文档里的 8443 / `www` / IP `/k`
> 只作为「备案前绕行方案」保留，不再是目标状态。

---

## 0. 目标状态

| 域名 | 端口 | 去向 | 证书 |
|---|---|---|---|
| `littlewish.top`、`www.littlewish.top` | 443 | `/var/www/cline-hub` 静态落地页 | Caddy 自动 |
| `hub.littlewish.top` | 443 | `127.0.0.1:3100`；`/app/*` → `/var/www/cline-hub/app`（仅 ClineHub 自己的 APK） | Caddy 自动 |
| `kids.littlewish.top` | 443 | `127.0.0.1:3000`；`/app/version` 走 API；`/app/*` → `/srv/kids-points/app`（Kids APK） | Caddy 自动 |
| `ntfy.littlewish.top`（可选） | 443 | `127.0.0.1:2586` | Caddy 自动 |

过渡期额外保留（旧客户端退场后删除）：

| 入口 | 去向 | 谁在用 |
|---|---|---|
| `http://82.157.153.22/k/*` | `127.0.0.1:3000` | 旧版微信小程序 |
| `https://hub.littlewish.top:8443/kids/*` | `127.0.0.1:3000` | 旧版 Kids App（`KP_API_BASE_URL=…:8443/kids`） |
| `https://hub.littlewish.top:8443/app/*` | `/var/www/cline-hub/app` | 旧 APK 下载地址 |

---

## 1. 为什么 Kids 的下载地址必须换

原方案把两个产品的 APK 都放在 `hub.littlewish.top:8443/app/`。问题：

1. **产品耦合**：Kids 的安装包归 Hub 域名管，Hub 发版/证书/安全策略都会波及 Kids；
2. **地址语义错误**：用户看到的是 Hub 的域名，不是「积分小管家」；
3. **8443 迟早要关**：旧地址会随过渡期结束失效，不如现在就把稳定地址定在 Kids 自己的域上；
4. **证书**：Kids 子域现在能自动签，没必要再借 Hub 的证书与端口。

新稳定地址：

```text
https://kids.littlewish.top/app/kids-points-app.apk
```

版本化文件仍保留：`/app/kids-points-<version>.apk`，便于回滚与对比。

---

## 2. 仓库里的文件地图

cline-hub（Hub 发版负责）：

```text
deploy/Caddyfile                         主文件：global + import conf.d
deploy/conf.d/00-site.caddyfile          落地页（littlewish.top / www）
deploy/conf.d/10-hub.caddyfile           Hub 443（含 Hub 自己的 /app/*）
deploy/conf.d/90-legacy.caddyfile        过渡期 IP /k 与 hub:8443/kids
deploy/install-caddy-conf.sh             安装主文件 + 00/10（--with-legacy 时加 90）
```

kids_points_app（Kids 仓库负责）：

```text
deploy/conf.d/20-kids.caddyfile          kids.littlewish.top（自动证书 + APK 静态）
deploy/install-kids-caddy.sh             只安装 20-kids 分片
deploy/publish-kids-apk.sh               发布 APK 到 /srv/kids-points/app
```

★ **关键**：Hub 发版只覆盖 `00/10/90`，**不会删除 `20-kids.caddyfile`**。
这正是对 2026-11-02 / 11-05「Hub 发版抹掉 Kids 路由」的根治。

### 2.1 归属一览（含对方项目，2026-11-10）

同一台机器、同一个 Caddy，**谁的分片谁装**：

| 资源 | 归属 | 说明 |
|---|---|---|
| `conf.d/00-site.caddyfile` | cline-hub | `littlewish.top` / `www` → `/var/www/cline-hub` 落地页 |
| `conf.d/10-hub.caddyfile` | cline-hub | `hub.littlewish.top` → `127.0.0.1:3100`；`/app/*` → `/var/www/cline-hub/app`（Hub APK） |
| `conf.d/20-kids.caddyfile` | **kids_points_app** | `kids.littlewish.top` → `127.0.0.1:3000`；`/app/*` → `/srv/kids-points/app`（Kids APK） |
| `conf.d/30-ntfy.caddyfile` | cline-hub（手工） | 可选；仓库里只有 `.example` |
| `conf.d/90-legacy.caddyfile` | cline-hub（`--with-legacy`） | 过渡期 `IP/k/*`、`hub:8443/kids/*`、旧 APK |
| `/etc/caddy/Caddyfile` | cline-hub | 只有 global + `import conf.d/*.caddyfile` |
| `/srv/kids-points`、`/srv/kids-points/app`、`:3000`、`/var/lib/caddy/kids.log` | **kids_points_app** | 代码 / `kids.env` / APK / API / 日志 |
| `/srv/cline-hub`、`/var/www/cline-hub`、`:3100` | cline-hub | Hub 代码 / 落地页 / Hub APK / API |
| `127.0.0.1:5432`（`pg18`） | 共用 | 两个库；网络附加见 `deploy/README.md` §0 |

发版互不影响契约：

1. Kids 发版只跑 `deploy/install-kids-caddy.sh`（写 `20-kids`）与 `deploy/publish-kids-apk.sh`
   （写 `/srv/kids-points/app`），**不碰**主文件与 `00/10/90`。
2. hub 发版只跑 `deploy/install-caddy-conf.sh`（写主文件 + `00/10`，`--with-legacy` 时写 `90`），
   **不删** `20-kids`；但它也**不会恢复**被手工删掉的 `20-kids` —— 那要我们自己重跑脚本。
3. 需要新路径前缀：加在自己的 `20-kids` 里，不要动 `10-hub`（同主机名两处定义 ⇒ `caddy validate` 失败，
   reload 不生效还会被误判成「改了没生效」）。
4. 任何一边动过 Caddy 后，两边一起验（§6 的四项验收 ＋ `hub/api/v1/health` 200）。
5. 过渡期结束删 `90-legacy` 的前提见 §9；删之前先确认旧版 App / 小程序都已退场。

---

## 3. 迁移前检查（只读）

```bash
# DNS：四条都必须返回 82.157.153.22
dig +short littlewish.top
dig +short www.littlewish.top
dig +short hub.littlewish.top
dig +short kids.littlewish.top

# 443 不再被备案拦截（应直接是 Caddy 的响应，不是 302 到 dnspod）
curl -sI http://hub.littlewish.top | head -1
curl -sI https://hub.littlewish.top/api/v1/health | head -1

# 现有证书状态
echo | openssl s_client -connect hub.littlewish.top:443 \
  -servername hub.littlewish.top 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

- 备案接入商必须是**腾讯云**；若备案在别家，先做「接入备案」。
- 腾讯云防火墙放行 `22/80/443`；8443 在过渡期继续放行。
- `kids` / `www` / `@` 没有 A 记录就先加，否则 Caddy 会反复重试 ACME。

## 4. 第一步：安装 Hub 侧「主文件 + conf.d」

```bash
cd /srv/cline-hub
# 迁移期：带 --with-legacy，保留旧 8443 / IP 入口
sudo bash deploy/install-caddy-conf.sh --with-legacy
```

脚本行为：

1. 备份 `/etc/caddy/Caddyfile` 与 `/etc/caddy/conf.d/*.caddyfile` 到
   `/etc/caddy/backup-conf.d-<时间戳>/`；
2. 写入主文件与 `00-site` / `10-hub`；带 `--with-legacy` 时再写 `90-legacy`；
3. 预建日志文件（属主 `caddy`，不会截断已有日志）；
4. `caddy validate` 通过才 `systemctl reload caddy`，失败自动还原。

验收（此时 Kids 的 20 分片还没装，属正常）：

```bash
curl -s https://hub.littlewish.top/api/v1/health
curl -sI https://littlewish.top | head -1
curl -sI https://www.littlewish.top | head -1
```

## 5. 第二步：安装 Kids 分片

```bash
cd /srv/kids-points
# 把本仓库 deploy/ 同步到服务器后：
sudo bash deploy/install-kids-caddy.sh
```

脚本行为：

1. 检查主 Caddyfile 是否已经 `import /etc/caddy/conf.d/*.caddyfile`，没有就拒绝执行；
2. 备份旧的 `20-kids.caddyfile`（若有）；
3. 写入 `20-kids.caddyfile`；
4. 创建 `/srv/kids-points/app/`（属主 `caddy`），并把旧目录
   `/var/www/cline-hub/app/kids-points-*.apk` **复制**过来（不移动，过渡期旧地址仍可下载）；
5. `caddy validate` → `systemctl reload caddy`。

## 6. 第三步：验证自动证书（关键闸门）

```bash
# 证书签发者应是 Let's Encrypt / ZeroSSL，SAN 含 kids.littlewish.top
echo | openssl s_client -connect kids.littlewish.top:443 \
  -servername kids.littlewish.top 2>/dev/null \
  | openssl x509 -noout -issuer -dates -ext subjectAltName

curl -sI https://kids.littlewish.top/health
curl -s  https://kids.littlewish.top/app/version
curl -sI https://kids.littlewish.top/app/kids-points-app.apk
```

期望：证书有效期约 90 天；`/health` 200；`/app/version` 返回 JSON；
APK 200 且 `content-length` 与包大小一致。

> 若证书签不下来：先 `dig` 确认 DNS，再看 `journalctl -u caddy -n 100 --no-pager`。
> **不要反复 reload 重试**（会消耗 CA 速率限制）。过渡期入口仍在，业务不会断。

## 7. 第四步：把 `APP_DOWNLOAD_URL` 指到新地址

`update-app-env.py` 与 `backend/.env.example` 的默认值已经改为新地址。
服务器上现有 `kids.env` 手动改一次（以后发版脚本会自动写新值）：

```bash
sudo sed -i 's|^APP_DOWNLOAD_URL=.*|APP_DOWNLOAD_URL="https://kids.littlewish.top/app/kids-points-app.apk"|' \
  /srv/kids-points/kids.env

cd /srv/kids-points/deploy
sudo docker compose up -d --force-recreate kids-api

# 期望返回的 downloadUrl 已是 kids 子域
curl -s https://kids.littlewish.top/app/version
```

## 8. 第五步：客户端切换（服务端验收通过后再动）

**Kids Flutter App**

```bash
flutter build apk --release \
  --dart-define=KP_API_BASE_URL=https://kids.littlewish.top

scp build/app/outputs/flutter-apk/app-release.apk \
  ubuntu@82.157.153.22:/tmp/kids-points-1.0.7.apk

ssh ubuntu@82.157.153.22 \
  'sudo bash /srv/kids-points/deploy/publish-kids-apk.sh /tmp/kids-points-1.0.7.apk 1.0.7'
```

版本号仍要三处同步：`pubspec.yaml`、`lib/app_version.dart`、`kids.env`
（用 `deploy/update-app-env.py`）。

**微信小程序**

1. `kids_points_mp/.env.local`：`TARO_APP_KP_API_BASE_URL=https://kids.littlewish.top`（去掉 `/k`）；
2. 重新构建、上传体验版；
3. 微信后台「开发管理 → 服务器域名 → request 合法域名」加入 `https://kids.littlewish.top`；
4. 小程序本身也需要**小程序备案**，否则审核/发布会被卡。

**ClineHub**

1. `bridge/config.json` 的 `hubUrl` 改为 `https://hub.littlewish.top`；
2. App 里的 Hub 地址同步改；
3. `HUB_SMOKE_BASE=https://hub.littlewish.top node scripts/smoke.mjs`，应 20/20（含 SSE）；
4. 迁移完成后**轮换 Hub token**（备案拦截期曾走明文 IP 入口）。

## 9. 第六步：过渡期结束后的清理

满足以下三条后再做：

- 新版 Kids App（baseUrl 为 kids 子域）已覆盖在用设备；可用 `APP_MINIMUM_BUILD` 强制升级；
- 新版小程序已发布，且微信后台只留 `https://kids.littlewish.top`；
- ClineHub bridge / App 全部使用 `https://hub.littlewish.top`。

```bash
# 1) 删除过渡期分片（IP /k + hub:8443/kids）
sudo rm -f /etc/caddy/conf.d/90-legacy.caddyfile

# 2) 校验并 reload；之后安装一律**不带** --with-legacy，避免它复活
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy

# 3) 关闭腾讯云安全组的 8443；确认 80 仍放行（ACME 与 301 需要）

# 4) 旧 APK 副本可删（确认没有旧客户端再访问）
sudo rm -f /var/www/cline-hub/app/kids-points-*.apk
```

## 10. 回滚

- 每一步都有备份：`/etc/caddy/backup-conf.d-<时间戳>/` 与 `20-kids.caddyfile.bak-<时间戳>`。
- 回滚只需把备份文件还原到 `/etc/caddy/` 对应位置，`caddy validate` → `reload`。
- **过渡期内不要先删 `90-legacy.caddyfile`**：旧 App / 小程序仍靠它。
- 若 `kids` 自动证书失败，保持 `20-kids.caddyfile` 不生效（删掉或改名），
  继续用 8443；等排查完再启用，不要反复重试 ACME。

## 11. 排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `caddy validate` 报 `import` 找不到文件 | `conf.d` 为空或主文件路径不对 | 先跑 `install-caddy-conf.sh`；确认目录是 `/etc/caddy/conf.d` |
| reload 后站点全 502 | 旧 Caddyfile 里站点与新分片重复定义 | 只保留主文件 + conf.d，别再把旧站点段贴回主文件 |
| `kids` 证书签不出 | DNS 未生效 / 80 被挡 / 备案接入商不对 | `dig`、腾讯云防火墙、接入备案；看 `journalctl -u caddy` |
| `/app/version` 返回 404 | `/app/*` 静态规则排在 API 前面 | 保持 `@app_version` 的 `handle` 在 `handle_path /app/*` 之前 |
| APK 403 / 404 | 文件权限或目录不对 | 文件属主 `caddy`、权限 644；目录 `/srv/kids-points/app` |
| 小程序提示域名不合法 | 未加入 request 合法域名 / 小程序未备案 | 微信后台加域名并完成小程序备案 |
| Hub 发版后 Kids 又 404 | 有人又把旧单文件 Caddyfile 覆盖回去了 | 重新跑 `install-caddy-conf.sh` + `install-kids-caddy.sh`；确认主文件是 import 版本 |

