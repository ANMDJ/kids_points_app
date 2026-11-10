# RELEASE.md —— 发版手册（后端镜像 ＋ App APK）

> **这份文件的用途**：把「后端发版」与「App 发版」写成可以照抄、也可以直接翻译成脚本的步骤。
> 2026-11-10 首次成文，**下面每条命令都是当天在这台机器上真跑过的**（包括踩到的坑）。
>
> - 一次性前置 / 拓扑 / 已知坑的完整版：`deploy/README.md`
> - 域名与 Caddy 分片归属：`deploy/DOMAIN-PLAN-A.md`、`AGENTS.md` §3
> - 未开发事项：`docs/design/43-open-work-backlog.md` §0

---

## 0. 一页速查

| 阶段 | 做什么 | 判据（必须看到） |
|---|---|---|
| ① 前置 | `sudo /usr/local/bin/kids-backup.sh --verify` | `OK 恢复演练 … PointRecord=N（与线上一致）` |
| ② 回滚点 | `docker tag kids-api:0.1.0 kids-api:prev-YYYYMMDD` | `docker images` 里有两行 `kids-api` |
| ③ 后端 | 打包 → scp → 覆盖 → `docker compose build` | `Image kids-api:0.1.0 Built` |
| ④ 后端 | `docker compose up -d`（entrypoint 自动 `migrate deploy`） | 容器 `(healthy)`，日志有 `Nest application successfully started` |
| ⑤ 后端 | 重跑 `900_ledger_revoke.sql` → `verify-db` | `ALL PASS` |
| ⑥ App | 三处版本号 → `flutter analyze` / `test` → `build apk` | `flutter test` 全绿；APK 生成 |
| ⑦ App | `scp` → `publish-kids-apk.sh` → `update-app-env.py` → `up -d --force-recreate` | `/app/version` 返回新版本 |
| ⑧ 验收 | 7 条探针（§6） | 全 200 / 字段正确 |
| ⑨ 收尾 | 提交代码（§7 git）＋ 更新 `43` §0 | 推送成功 |

> ★ **入口只有 HTTPS 443**：`https://kids.littlewish.top`。
> `hub.littlewish.top:8443/kids` 与 `82.157.153.22/k` 只是旧客户端 / 小程序的过渡入口，
> **新包一律打 kids 子域**，不要再往 8443 上发。

---

## 1. 变量约定（后面所有命令都用这几个）

```bash
# 在 Linux / macOS / Git Bash 里
export KP_HOST=ubuntu@82.157.153.22
export KP_KEY=~/.ssh/kids.pem                 # 默认 key 会被拒（publickey）
export KP_SSH="ssh -i $KP_KEY $KP_HOST"
export KP_SRV=/srv/kids-points
export KP_DOMAIN=https://kids.littlewish.top  # ★ 正式入口，443 自动证书
```

PowerShell 里：

```powershell
$KP_KEY = "$HOME\.ssh\kids.pem"
$KP_HOST = "ubuntu@82.157.153.22"
$KP_DOMAIN = "https://kids.littlewish.top"
```

---

## 2. 一次性前置（只确认，不必每次做）

| 项 | 确认命令 | 期望 |
|---|---|---|
| DNS | `nslookup kids.littlewish.top` | `82.157.153.22` |
| Caddy 分片 | `ssh … 'ls /etc/caddy/conf.d/'` | `20-kids.caddyfile` |
| 主文件 import | `ssh … 'grep import /etc/caddy/Caddyfile'` | `import /etc/caddy/conf.d/*.caddyfile` |
| APK 目录 | `ssh … 'ls -ld /srv/kids-points/app'` | 存在，属主 `caddy` |
| 后端目录 | `ssh … 'ls /srv/kids-points/backend'` | `Dockerfile` `src` `prisma` … |
| pg 网络附加 | `ssh … 'sudo docker network inspect deploy_default --format "{{range .Containers}}{{.Name}} {{end}}"'` | 含 `pg18` |
| watchdog | `ssh … 'sudo crontab -l \| grep kids-watchdog'` | `*/5 * * * * /usr/local/bin/kids-watchdog.sh` |
| 备份 cron | `ssh … 'sudo crontab -l \| grep kids-backup'` | `17 3 * * * …` |

**缺 Caddy 分片 / 缺 import 的修法（幂等，自带备份与 `caddy validate`）：**

```bash
$KP_SSH 'sudo bash /srv/kids-points/deploy/ensure-kids-sites.sh'
# 期望：[ok] 20-kids.caddyfile 已安装并 reload + [probe] kids=200
```

> 为什么需要 `--bootstrap-import`：2026-11-10 实测这台机器的 `/etc/caddy/conf.d`
> **根本不存在**（只有单文件 Caddyfile），不补那一行 `import` 的话分片永远不生效，
> `https://kids.littlewish.top` 会一直停在 TLS `tlsv1 alert internal error`。
> 补 import 只**追加一行**，不重写任何站点；`00/10/90` 仍归 cline-hub。

---

## 3. 第 0 步：发布前的三个绿灯

```bash
# ① 本地：静态检查 ＋ 单测（App）
flutter analyze            # 期望 No issues found
flutter test               # 期望 All tests passed!（当前 518+ 条）

# ② 本地：后端类型检查（改过后端才需要完整 npm test）
cd backend && npm run typecheck && npm run typecheck:tests

# ③ 线上：先备份再动手（★ 顺序不能反）
$KP_SSH 'sudo /usr/local/bin/kids-backup.sh --verify'
# 期望：OK 备份完成 …  /  OK 恢复演练：restore_test 恢复出 24 张表，PointRecord=N（与线上一致）

# ④ 线上：留回滚点（镜像名固定是 kids-api:0.1.0，不 tag 就找不回旧镜像）
$KP_SSH 'sudo docker tag kids-api:0.1.0 kids-api:prev-20261110'
```

> `kids-backup.sh` 的源码就是 `deploy/backup-kids-db.sh`；改了它要重新
> `sudo install -m 755 deploy/backup-kids-db.sh /usr/local/bin/kids-backup.sh`。

---

## 4. 后端发版（唯一正确的顺序）

> 服务器上 `/srv/kids-points/backend` 是**代码副本**（不是 git 仓库），发版 = 覆盖副本 + 重建镜像。
> 镜像名固定 `kids-api:0.1.0`，`compose.yaml` 是 build + image 同名，所以**必须先 tag 回滚点**（§3 ④）。

### 4.1 打包并上传（在仓库根目录）

```bash
# 排除依赖 / 产物 / 测试 / 日志：镜像里用不到，传上去只会变慢
tar -czf .tmp_release/backend.tar.gz \
  --exclude=node_modules --exclude=dist --exclude=test --exclude=test-db \
  --exclude='.tmp_*' --exclude='*.tsbuildinfo' --exclude='*.log' \
  backend

scp -i "$KP_KEY" .tmp_release/backend.tar.gz "$KP_HOST:/tmp/kids-deploy/"
```

期望：`.tmp_release/backend.tar.gz` ≈ **600 KB**（2026-11-10 实测 615,765 字节；
打进 `backend/dist` 时会变成几十 MB —— 那是参数写错了）。

> PowerShell 里 `C:\Windows\System32\tar.exe` 可能 `Access is denied`，用 Git 自带的那份：
> `& 'C:\Program Files\Git\usr\bin\tar.exe' -czf .tmp_release/backend.tar.gz … backend`

### 4.2 覆盖线上副本（整目录替换）

```bash
$KP_SSH 'sudo rm -rf /srv/kids-points/backend && \
         sudo tar -xzf /tmp/kids-deploy/backend.tar.gz -C /srv/kids-points && \
         sudo chown -R root:root /srv/kids-points/backend && \
         ls /srv/kids-points/backend'
```

期望：列出 `Dockerfile` `docker-entrypoint.sh` `src` `prisma` `scripts` `package-lock.json` …

> ★ **必须去 CRLF（2026-11-10 踩到）**：仓库工作区里的 `backend/docker-entrypoint.sh` 在 Windows 上
> 可能是 CRLF 字节（`.gitattributes` 声明了 `eol=lf`，git 索引里是 LF，所以 `git status` **看不出来**）。
> 打进 tar 后镜像里的 shebang 变成 `#!/bin/sh\r` ⇒ 容器直接
> `exec /app/docker-entrypoint.sh: no such file or directory`，且**无限重启**。
> 解包后固定跑一次：

```bash
$KP_SSH 'sudo find /srv/kids-points/backend -type f \( -name "*.sh" -o -name "*.sql" \) \
         -exec sed -i -e s/[[:cntrl:]]$// {} +; \
         sudo head -c 10 /srv/kids-points/backend/docker-entrypoint.sh | od -c | head -1'
# 期望：0000000   #   !   /   b   i   n   /   s   h  \n      ← 必须是 \n，不是 \r \n
```

> ★ **为什么「删＋解包」而不是 `cp -r`**：仓库里删掉的文件不会自己消失，
> `cp -r` 会把它们继续编译进镜像（历史上删过 `date_code` 那一批）。
> ★ `deploy/` 里的脚本或 `compose.yaml` 有改动时同样要同步过去，并且**去 CRLF**（§9 坑 1）。

### 4.3 构建镜像（3–5 分钟，必须后台跑 + 轮询）

```bash
$KP_SSH 'cd /srv/kids-points/deploy && sudo nohup docker compose build > /tmp/kids-build.log 2>&1 &'
sleep 45; $KP_SSH 'tail -3 /tmp/kids-build.log'
```

期望末尾：`Image kids-api:0.1.0 Built`（或 `exporting layers done` 之后进程结束）。
命中缓存的依赖层时全程约 40 秒；冷构建 3–5 分钟（`npm ci` 占大头）。

### 4.4 起服务（迁移随启动，不需要手工 `migrate deploy`）

```bash
$KP_SSH 'cd /srv/kids-points/deploy && sudo nohup docker compose up -d > /tmp/kids-up.log 2>&1 &'
sleep 25; $KP_SSH 'sudo docker ps --filter name=deploy-kids-api-1 --format "{{.Status}}"; tail -5 /tmp/kids-up.log'
```

期望：`Up 20 seconds (healthy)`。

`sudo docker logs --tail 40 deploy-kids-api-1` 里应依次出现：

```
[entrypoint] prisma migrate deploy（幂等；失败则不启动服务）
[entrypoint] 迁移完成
PrismaService 数据库已连接
Nest application successfully started
```

> ★ **迁移失败 = 容器 `exit 1` 且不接流量**（`backend/docker-entrypoint.sh` 的 fail-closed 设计）。
> 看到容器反复重启时那是**正确行为**，别用 `PRISMA_MIGRATE_ON_START=0` 糊过去。

### 4.5 收权 + 12 项判据（★ 顺序不能换）

```bash
# ① 账本表收权：新增表之后必须重跑（GRANT 只覆盖执行那一刻已存在的表）
$KP_SSH 'cd /srv/kids-points/deploy && \
  cat ../backend/prisma/sql/900_ledger_revoke.sql | \
  sudo docker exec -i pg18 psql -U postgres -d kids_points -v ON_ERROR_STOP=1 -f -'

# ② 12 项判据（★ 必须 ALL PASS）
$KP_SSH 'cd /srv/kids-points/deploy && sudo docker compose run --rm kids-api node scripts/verify-db.mjs'
```

> 2026-11-03 真实事故：新迁移建了表但没重跑 `900` ⇒ 发码接口直接 **500**
> （`42501 permission denied`），而迁移与容器都显示成功。`900` 幂等，**每次发版都重跑**。

### 4.6 后端探针

```bash
curl -s "$KP_DOMAIN/health"         # {"status":"ok","service":"kids-api",...}
curl -s "$KP_DOMAIN/health/ready"   # {"status":"ok","checks":{"database":{"status":"up"}}}
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$KP_DOMAIN/approvals/abc"   # 401 ⇒ 新端点已在
```

> `/health` **不查库**（只看进程活着）；`/health/ready` 才 `SELECT 1`。
> `ready` 返回 503 时**先看 pg18**，重启 kids-api 救不了库。

---


## 5. App 发版（APK ＋ 自更新元信息）

> 三处版本号：`pubspec.yaml`、`lib/app_version.dart`、线上 `kids.env` 的 `APP_LATEST_*`。
> 前两处由 `test/app_version_test.dart` **双向钉住**（改一处忘另一处会红）；
> 第三处由 `deploy/update-app-env.py` 写入。

### 5.1 升版本号（改两处，跑一次 analyze + test）

```bash
# pubspec.yaml        version: 1.0.7+8
# lib/app_version.dart  kAppVersion = '1.0.7' / kAppBuildNumber = 8
flutter analyze    # No issues found
flutter test       # All tests passed!（含 app_version_test 的「三处同步」用例）
```

> 为什么不能只改一处：用户装了两个「同版本」但行为不同的包是最难查的一类问题，
> 所以测试会直接读 `pubspec.yaml` 与常量做逐字比对。

### 5.2 构建正式包（★ 必须带新域名）

```bash
flutter build apk --release \
  --dart-define=KP_API_BASE_URL=https://kids.littlewish.top
```

- 产物：`build/app/outputs/flutter-apk/app-release.apk`（约 **50 MB**）。
- ★ **漏了 `--dart-define` 会打到「预览模式」包**：`ReadApiConfig.hasBaseUrl=false` ⇒
  App 直接放行到首页 + 本地空态，**一个请求都不发也不报错**（README「连线上后端」一节写的就是这个坑）。
- ★ **不要再打 8443**（`https://hub.littlewish.top:8443/kids`）。那是旧包的过渡入口。

### 5.3 上传并发布（服务器上落两个文件）

```bash
scp -i "$KP_KEY" build/app/outputs/flutter-apk/app-release.apk \
  "$KP_HOST:/tmp/kids-points-1.0.7.apk"

$KP_SSH 'sudo bash /srv/kids-points/deploy/publish-kids-apk.sh /tmp/kids-points-1.0.7.apk 1.0.7'
```

产出（属主 `caddy`，`file_server` 能读）：

```
/srv/kids-points/app/kids-points-1.0.7.apk   # 版本化，便于回滚 / 对比
/srv/kids-points/app/kids-points-app.apk     # 稳定地址（/app/version 返回它）
```

核对字节数一致（scp 断流会得到半个包，但 HTTP 仍是 200）：

```bash
$KP_SSH 'ls -l /srv/kids-points/app/kids-points-1.0.7.apk'
curl -sI "$KP_DOMAIN/app/kids-points-1.0.7.apk" | findstr /i content-length   # PowerShell
curl -sI "$KP_DOMAIN/app/kids-points-1.0.7.apk" | grep -i content-length      # bash
```

> ★ **两个文件都要核对，尤其是稳定地址 `kids-points-app.apk`**：
> 2026-11-10 实测过一个「`/app/version` 报 1.0.7、下载下来却是 1.0.6」的坑 ——
> `install-kids-caddy.sh` 里「从旧目录补 APK」那段用 `cp -a` 把稳定地址覆盖回了旧包
> （已修为只补缺、不覆盖，见 §9 坑 11）。判据只有一个：
> `curl -sI …/kids-points-app.apk` 的 `content-length` **逐字等于**本地 APK 字节数。

### 5.4 写入自更新元信息（★ 必须 `--force-recreate`）

```bash
# 说明文本先落成文件：中文引号 / 分号走 ssh 命令行会被改写
cat > /tmp/release_notes.txt <<'EOF'
1.0.7：修复 …；新增 …
EOF
scp -i "$KP_KEY" /tmp/release_notes.txt "$KP_HOST:/tmp/"
scp -i "$KP_KEY" deploy/update-app-env.py "$KP_HOST:/tmp/"

$KP_SSH 'sudo python3 /tmp/update-app-env.py 1.0.7 8 @/tmp/release_notes.txt'
$KP_SSH 'cd /srv/kids-points/deploy && sudo docker compose up -d --force-recreate kids-api'
```

`update-app-env.py` 写入的五个字段（自动备份 `kids.env.bak-<时间戳>`）：

```dotenv
APP_LATEST_VERSION="1.0.7"
APP_LATEST_BUILD="8"
APP_DOWNLOAD_URL="https://kids.littlewish.top/app/kids-points-app.apk"
APP_PUBLISHED_AT="<UTC 时间>"
APP_RELEASE_NOTES="…"
```

> ★ **只 `up -d` 不够**：`kids.env` 是 `env_file`，只改文件内容时 compose 不保证重建容器，
> 会出现「APK 已经是新包，`/app/version` 还报旧版本」⇒ 旧包用户永远看不到更新提示。

### 5.5 验收（三条，缺一不可）

```bash
curl -s "$KP_DOMAIN/app/version"     # latestVersion=1.0.7 / latestBuild=8 / downloadUrl=新域名
curl -s -o /dev/null -w '%{http_code}\n' "$KP_DOMAIN/app/kids-points-app.apk"   # 200
curl -s -o /dev/null -w '%{http_code}\n' "$KP_DOMAIN/app/version"               # 200（不是 404）
```

> `/app/version` 是 **API**，必须排在 `/app/*` 静态规则之前（`20-kids.caddyfile` 里的
> `@app_version` handle）；顺序反了就会 404，而 APK 下载仍然是 200 —— 很容易被漏看。

---

## 6. 发布后验收清单（照抄）

| # | 命令 | 期望 |
|---|---|---|
| 1 | `curl -s $KP_DOMAIN/health` | `200` + `"status":"ok"` |
| 2 | `curl -s $KP_DOMAIN/health/ready` | `200` + `database.status=up` |
| 3 | `curl -s $KP_DOMAIN/app/version` | `200` + 新版本号 + `downloadUrl=https://kids.littlewish.top/app/kids-points-app.apk` |
| 4 | `curl -sI $KP_DOMAIN/app/kids-points-app.apk` | `200` + `content-length` ≈ 包大小 |
| 5 | `curl -s -o /dev/null -w '%{http_code}' -X POST $KP_DOMAIN/approvals/x` | `401`（新端点存在） |
| 6 | `curl -s -o /dev/null -w '%{http_code}' https://hub.littlewish.top/api/v1/health` | `200`（**别挤掉 hub**） |
| 7 | `$KP_SSH 'sudo docker ps'` | `deploy-kids-api-1` 为 `(healthy)` |
| 8 | `$KP_SSH 'sudo tail -5 /var/log/kids-watchdog.log'` | 没有 `FAIL` / `WARN` 新增行 |
| 9 | 真机装新包（D 类） | 能登录、能记一笔、PIN 锁正常 |

> 1–8 全部可自动化；第 9 条只能人工（当前环境无 Android 设备）。
> 也可以直接跑 `deploy/smoke-8443.sh` 里已经沉淀的那几条历史探针（它测的是旧入口）。

---


## 7. 回滚

| 层 | 回滚动作 | 备注 |
|---|---|---|
| **APK / 自更新信息** | 用旧版本号重跑 §5.4：`sudo python3 /tmp/update-app-env.py 1.0.6 7 @/tmp/old_notes.txt` → `up -d --force-recreate kids-api` | 旧包文件 `kids-points-1.0.6.apk` 还在 `/srv/kids-points/app/`（版本化文件就是为此保留） |
| **后端镜像** | `sudo docker tag kids-api:prev-20261110 kids-api:0.1.0 && cd /srv/kids-points/deploy && sudo docker compose up -d --force-recreate kids-api` | 前提是发布前 tag 过（§3 ④）；否则只能回滚代码后重建 |
| **后端代码** | 把上一版 tar 解包覆盖 → `build` → `up -d` | tar 建议留在 `/tmp/kids-deploy/backend-<版本>.tar.gz` |
| **数据库** | **没有 down 迁移**（Prisma 只有 forward）。误删/写坏时用 `deploy/backup-kids-db.sh` 的产物恢复 | 恢复演练见 §3 ③；备份在同机 `/srv/backup/kids`，**离机备份仍未做**（43 §0） |
| **Caddy** | `sudo cp /etc/caddy/conf.d/20-kids.caddyfile.bak-<时间戳> /etc/caddy/conf.d/20-kids.caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy` | ⚠️ `reload`，**不要** `restart`（会断 hub 的 SSE） |
| **路由被 hub 覆盖** | `sudo bash /srv/kids-points/deploy/ensure-kids-sites.sh` | watchdog 每 5 分钟也会自动跑（600s 冷却） |

> ★ 回滚后端**不能**靠「把 kids.env 改回去」——它不含代码；
> ★ 回滚 App **不会**让已装新包的用户退回：客户端只比 `latestVersion/Build`，
> 所以回滚线上版本号会让「新包用户」看到「有新版本」（实际是旧包）——
> 真要回滚就同时把 `APP_MINIMUM_*` 一起调低，并在说明里写清楚。

---

## 8. 自动化配方（给脚本 / CI 用）

把 §3–§6 拆成 9 个幂等步骤，每步都有**可判定的成功信号**，任何一步非 0 就停：

```text
S1  preflight   : ssh 连通 + sudo 免密 + DNS 指向 82.157.153.22 + /etc/caddy/conf.d/20-kids.caddyfile 存在
S2  backup      : kids-backup.sh --verify        → 输出含 "OK 恢复演练"
S3  rollback-tag: docker tag kids-api:0.1.0 kids-api:prev-<YYYYMMDD-HHMM>
S4  sync-code   : tar+scp+解包+chown             → 远端 ls 有 docker-entrypoint.sh
S5  build       : docker compose build（后台）    → 日志含 "Image kids-api:0.1.0 Built"
S6  up          : docker compose up -d（后台）    → docker ps 含 "(healthy)"
S7  db          : 900 sql + verify-db.mjs         → 输出含 "ALL PASS"
S8  apk         : flutter build → scp → publish → update-app-env → up --force-recreate
S9  verify      : §6 的 1–8 条                    → 全 200 / 字段匹配
```

要点（这几条错了自动化会在最难受的地方失败）：

1. **一切耗时命令都要后台化**：`build` / `test` / `flutter build apk` 都 1–5 分钟，
   前台等必然超时。远端用 `nohup … > /tmp/xxx.log 2>&1 &` + 轮询，
   本地用 `Start-Process` / `&` 之类，然后用「日志里出现哪个字符串」判断完成，
   **不要**用 `sleep` 的固定秒数当判据。
2. **判据用「字符串」不用「退出码」**：`docker compose build` 失败时退出码可能被管道吃掉；
   日志里 `Image kids-api:0.1.0 Built` 只在成功时出现。
3. **版本号四处一致**：`pubspec.yaml`、`lib/app_version.dart`、`kids.env` 的
   `APP_LATEST_VERSION/BUILD`、APK 文件名 `kids-points-<version>.apk`。
4. **`kids.env` 改完必须 `--force-recreate`**，否则 `/app/version` 可能是缓存的旧值。
5. **不要碰 `/etc/caddy/Caddyfile` 里的其他站点**；只在缺 `import` 时调
   `install-kids-caddy.sh --bootstrap-import`（它自己会备份 + validate + 失败还原）。
6. **失败即停**：`set -euo pipefail` + 每步显式判据；发一半的镜像比发旧镜像更糟。
7. 需要人给的东西（拿不到就让流水线在 S1 红掉，别静默跳过）：
   `kids.pem` 私钥、`ubuntu` 的 sudo 免密、Android 签名 keystore（当前用 debug/默认签名，
   商店正式签名仍在 43 §0 的 A 类里）。

> 想把 S1–S9 做成一条命令时，建议先写成 `deploy/release-local.sh`（本机运行、ssh 到线上），
> 再用 cron / 手动触发；**本仓库目前还没有这个脚本**（43 §0 里有记）。

---

## 9. 发版专属的坑（按踩到的顺序）

| # | 现象 | 原因 | 解法 |
|---|---|---|---|
| 1 | 远端脚本报 `set: pipefail\r: invalid option name` / `$'\r': command not found` | Windows 侧文件是 CRLF，`scp` **不做**换行转换 | `sudo sed -i -e s/[[:cntrl:]]$// <脚本>`（`-e` 后面别包引号，PowerShell 会吃引号） |
| 2 | PowerShell 里远程命令 `grep -E "a|b"` 变成 `b: command not found` | PowerShell 把参数里的双引号剥掉，远端把 `\|` 当管道 | 远程命令**只用单引号**，或用 `a; b; c` 串；复杂的就写成脚本 scp 过去执行 |
| 3 | 工具里单条命令 30 秒就超时 | 执行器有硬超时 | 长命令 `nohup`/`Start-Process` 后台化 + 轮询日志（§8 要点 1） |
| 4 | `ssh` 报 `Permission denied (publickey)` | 默认 key 不对 | 必须 `-i ~/.ssh/kids.pem` |
| 5 | `git push` 报 `Failed to connect to 127.0.0.1 port 7897` | 本机 `http.proxy` 指向的代理没起 | `git -c http.proxy= -c https.proxy= push` |
| 6 | `kids-backup.sh` 明明 dump 里有表却报 FAIL | `set -o pipefail` + `grep -q` ⇒ gunzip 收 SIGPIPE 返回 141 | 已修（改 `grep -c`，2026-11-10），改完要重装到 `/usr/local/bin/` |
| 7 | `https://kids.littlewish.top` TLS `internal error`、`curl` 返回 `000` | Caddy 里没有这个站点（分片没装 / 主文件没 `import`） | `sudo bash deploy/ensure-kids-sites.sh` |
| 8 | `/app/version` 404 但 APK 下载正常 | `handle_path /app/*` 排在了 `@app_version` 前面 | 顺序必须是 `@app_version` → `/app/*` → catch-all（见 `20-kids.caddyfile`） |
| 9 | App 装上去一片空、零请求 | 构建漏了 `--dart-define=KP_API_BASE_URL` | 重打包（§5.2）；`test/app_version_test` 抓不到这个，只能在构建命令里保证 |
| 10 | hub 发版后 kids 全 404 | cline-hub 整份覆盖 `/etc/caddy/Caddyfile` | watchdog（`ensure-kids-sites.sh`）自愈；手工同命令 |
| 11 | `/app/version` 报 `1.0.7`，但下载下来的包还是旧版（`content-length` 是旧的） | `install-kids-caddy.sh` 早期版本用 `cp -a` 把 `/var/www/cline-hub/app/kids-points-app.apk`（旧包）**覆盖**了 `/srv/kids-points/app/kids-points-app.apk` | 已修（改「只补缺、不覆盖」，2026-11-10）；验收必须比 `content-length` 与本地 APK 字节数**逐字相等**（§6 第 4 条） |

---

## 10. 2026-11-10 这次发版的实测记录（可作对照）

| 项 | 值 |
|---|---|
| 后端 | `33727e7`（P1-3：`GET /approvals/:id`）覆盖到 `/srv/kids-points/backend`，镜像重建，容器 `(healthy)`，`verify-db` **ALL PASS** |
| App | `1.0.7+8`，`--dart-define=KP_API_BASE_URL=https://kids.littlewish.top` |
| 入口 | `https://kids.littlewish.top`（443，Caddy 自动证书，2026-11-10 首次签发成功） |
| Caddy | 首次装 `conf.d/20-kids.caddyfile` + 主文件追加 `import /etc/caddy/conf.d/*.caddyfile`（备份 `Caddyfile.bak-20261110-161124`） |
| 备份 | `kids-backup.sh --verify`：24 张表、`PointRecord=25`、临时库已删 |
| 回滚点 | `kids-api:prev-20261110` |
| 顺手修的第 3 个 bug | `install-kids-caddy.sh` 的 `cp -a` 会把旧目录的 `kids-points-app.apk` 覆盖到稳定地址（`/app/version` 报 1.0.7、下载却是 1.0.6）；改成「只补缺、不覆盖」后重跑自愈脚本，`content-length` 仍为 **53,153,622** |

