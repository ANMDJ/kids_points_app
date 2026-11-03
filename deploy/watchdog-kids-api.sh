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
#
# 退出码：0 正常/已重启；1 环境不对（找不到容器）；2 重启失败。
set -uo pipefail

CONTAINER="${KP_API_CONTAINER:-deploy-kids-api-1}"
STREAK_LIMIT="${KP_WATCHDOG_STREAK:-3}"
STATE="${KP_WATCHDOG_STATE:-/var/lib/kids-watchdog.streak}"
LOG="${KP_WATCHDOG_LOG:-/var/log/kids-watchdog.log}"
INTERNAL="${KP_API_INTERNAL:-http://127.0.0.1:3000}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

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
