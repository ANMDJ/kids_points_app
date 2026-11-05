#!/usr/bin/env bash
# deploy/watchdog-kids-api.sh —— 把「容器 Unhealthy」翻译成一次重启（P0-5，2026-11-03）
#
# ── 它补的是 compose 补不了的那一段 ────────────────────────────────────────────
#   `restart: unless-stopped` 只认**进程退出**。Prisma 连接池卡死、事件循环被
#   长事务堵住时，进程还活着、端口还听着，`restart` 永不触发 —— 用户侧就是
#   "一直转圈"，而 `docker ps` 里它写着 `Up 5 hours`。
#   加了 healthcheck 之后，`docker ps` 会变成 `Up 5 hours (unhealthy)` ——
#   **但 compose 不会因为 unhealthy 去重启任何东西**。这个脚本就是那段缺失的动作。
#
# ── 为什么必须「连续 N 次」才动手 ──────────────────────────────────────────────
#   单次 unhealthy 可能只是一次 GC / 一次慢查询（探针 timeout 5s 很容易撞上）。
#   立刻重启会把一个本可自愈的抖动放大成一次真实中断 —— 所以默认要连续
#   `KP_WATCHDOG_STREAK`（默认 3）次、且中间不许出现 healthy，才重启。
#
# ── 为什么日志里要写「重启前最后一次探针 body」────────────────────────────────
#   重启会把容器里的现场抹掉。把 `/health/ready` 的 detail 抄进日志，事后才分得清
#   「API 卡死」和「库挂了但 API 被无辜重试」——后者重启多少遍都没用。
#
# 用法（服务器上）：
#   sudo install -m 755 deploy/watchdog-kids-api.sh /usr/local/bin/kids-watchdog.sh
#   # 每 5 分钟跑一次；状态文件与日志都在 /var/lib / /var/log
#   ( crontab -l 2>/dev/null; \
#     echo "*/5 * * * * /usr/local/bin/kids-watchdog.sh >/dev/null 2>&1" ) | crontab -
#
# 环境变量：
#   KP_API_CONTAINER   容器名（默认 deploy-kids-api-1，`docker ps` 第一列）
#   KP_WATCHDOG_STREAK 连续几次 unhealthy 才重启（默认 3）
#   KP_WATCHDOG_STATE  状态文件（默认 /var/lib/kids-watchdog.streak）
#   KP_WATCHDOG_LOG    日志（默认 /var/log/kids-watchdog.log）
#   KP_API_INTERNAL    容器内探针地址（默认 http://127.0.0.1:3000，用于抄 body）
#   KP_PUBLIC_HEALTH   公网入口探针（默认 https://hub.littlewish.top:8443/kids/health）
#   KP_ROUTE_SCRIPT    路由修复脚本（默认 /srv/kids-points/deploy/ensure-kids-route.sh）
#   KP_ROUTE_STAMP     上次尝试修复的时间戳文件（默认 /var/lib/kids-watchdog.route）
#   KP_ROUTE_MIN_INTERVAL 两次自动修复之间的最小间隔秒数（默认 600）
#
# ── 公网入口体检（2026-11-05 新增，起因是一次真实故障）────────────────────────
#   2026-11-05：`deploy-kids-api-1` 是 `(healthy)`、`127.0.0.1:3000/health` 也 200，
#   但 `https://hub.littlewish.top:8443/kids/health` 与 `/k/health` 全是 **404**
#   —— cline-hub 的部署**整份覆盖**了 /etc/caddy/Caddyfile，把两条 `handle_path`
#   一起抹掉了。用户侧看到的是 App「报错说没有数据」（404 被客户端翻译成
#   "要操作的数据不存在"），而本脚本当时只查容器健康，**完全看不见这个故障**。
#   现在：容器 healthy 时再探一次公网入口；不是 200 就重跑恢复脚本（幂等）。
#   为什么限制 600 秒一次：真出别的问题时（例如有人故意把路由挪走），
#   每 5 分钟 reload 一次 Caddy 只会制造噪音，不如留一条清楚的 FAIL 日志。
#
# 退出码：0 正常/已重启；1 环境不对（找不到容器）；2 重启失败。
set -uo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CONTAINER="${KP_API_CONTAINER:-deploy-kids-api-1}"
STREAK_LIMIT="${KP_WATCHDOG_STREAK:-3}"
STATE="${KP_WATCHDOG_STATE:-/var/lib/kids-watchdog.streak}"
LOG="${KP_WATCHDOG_LOG:-/var/log/kids-watchdog.log}"
INTERNAL="${KP_API_INTERNAL:-http://127.0.0.1:3000}"
PUBLIC_HEALTH="${KP_PUBLIC_HEALTH:-https://hub.littlewish.top:8443/kids/health}"
ROUTE_SCRIPT="${KP_ROUTE_SCRIPT:-/srv/kids-points/deploy/ensure-kids-route.sh}"
ROUTE_STAMP="${KP_ROUTE_STAMP:-/var/lib/kids-watchdog.route}"
ROUTE_MIN_INTERVAL="${KP_ROUTE_MIN_INTERVAL:-600}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

# 公网入口的 HTTP 码；连不上时 curl 给 000。
public_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$PUBLIC_HEALTH" 2>/dev/null || true
}

# 容器健康但公网不通 ⇒ 九成是 Caddyfile 被别的部署覆盖过。重跑恢复脚本（幂等）。
check_public_route() {
  local code now last out
  code=$(public_code)
  if [ "$code" = "200" ]; then
    return 0
  fi
  log "WARN 公网入口 $PUBLIC_HEALTH=$code（容器健康但入口不通 ⇒ 先怀疑 Caddyfile 被覆盖）"

  if [ ! -f "$ROUTE_SCRIPT" ]; then
    log "FAIL 缺少 $ROUTE_SCRIPT，无法自动恢复（需人工补 deploy/ensure-kids-route.sh）"
    return 1
  fi

  now=$(date +%s)
  last=0
  [ -f "$ROUTE_STAMP" ] && last=$(cat "$ROUTE_STAMP" 2>/dev/null || echo 0)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -lt "$ROUTE_MIN_INTERVAL" ]; then
    log "SKIP 距上次修复 $((now - last))s < ${ROUTE_MIN_INTERVAL}s，本轮不重复 reload caddy"
    return 1
  fi
  echo "$now" >"$ROUTE_STAMP"

  if out=$(bash "$ROUTE_SCRIPT" 2>&1); then
    log "FIX 已重跑 $(basename "$ROUTE_SCRIPT")：$(printf '%s' "$out" | tr '\n' ' ' | head -c 400)"
  else
    log "FAIL $(basename "$ROUTE_SCRIPT") 失败：$(printf '%s' "$out" | tr '\n' ' ' | head -c 400)"
    return 1
  fi

  code=$(public_code)
  if [ "$code" = "200" ]; then
    log "OK 公网入口已恢复（$PUBLIC_HEALTH=200）"
    return 0
  fi
  log "FAIL 修完仍不通：$PUBLIC_HEALTH=$code（看 /var/lib/caddy/*.log 与 Caddyfile 备份）"
  return 1
}

# `sudo docker`：ubuntu 不在 docker 组（2026-11-03 实测 permission denied on
# /var/run/docker.sock）。root 的 crontab 或 sudo NOPASSWD 都行。
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

status=$($DOCKER inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)
if [ -z "$status" ]; then
  log "FAIL 找不到容器 $CONTAINER（KP_API_CONTAINER 改一下？）"
  exit 1
fi

if [ "$status" = "none" ]; then
  log "SKIP $CONTAINER 没有 healthcheck（compose.yaml 的 healthcheck 段没生效？）"
  exit 0
fi

streak=0
[ -f "$STATE" ] && streak=$(cat "$STATE" 2>/dev/null || echo 0)
case "$streak" in ''|*[!0-9]*) streak=0 ;; esac

if [ "$status" = "healthy" ]; then
  [ "$streak" -ne 0 ] && log "OK 恢复 healthy（连续 unhealthy 计数 $streak → 0）"
  echo 0 >"$STATE"
  # 容器健康 ≠ 用户能用：Caddyfile 被覆盖时容器仍是 healthy，入口却是 404。
  check_public_route || true
  exit 0
fi

streak=$((streak + 1))
echo "$streak" >"$STATE"
log "WARN $CONTAINER=$status（连续第 $streak/$STREAK_LIMIT 次）"

if [ "$streak" -lt "$STREAK_LIMIT" ]; then
  exit 0
fi

# ★ 重启前先抄现场：重启会抹掉容器内的日志上下文。
ready=$($DOCKER exec "$CONTAINER" node -e \
  "fetch('${INTERNAL}/health/ready').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log('probe error: '+e.message))" \
  2>/dev/null | head -c 800)
log "RESTART $CONTAINER 连续 $streak 次 unhealthy；ready=$ready"

if $DOCKER restart "$CONTAINER" >>"$LOG" 2>&1; then
  echo 0 >"$STATE"
  log "OK 已重启 $CONTAINER（若这是库的问题，重启后仍会 unhealthy —— 那时该看 pg18）"
  exit 0
fi

log "FAIL 重启 $CONTAINER 失败"
exit 2
