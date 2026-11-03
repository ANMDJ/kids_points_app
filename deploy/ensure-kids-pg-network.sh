#!/usr/bin/env bash
# deploy/ensure-kids-pg-network.sh —— 把 pg18 重新接回 compose 网络（P0-7，2026-11-03）
#
# ── 它补的是哪一个坑 ──────────────────────────────────────────────────────────
#   `kids.env` 里 `DATABASE_URL` 的 host 是 `pg18`，而 pg18 是**宿主机上独立**
#   的容器（不归本 compose 管）。它能被 `pg18` 这个名字解析到，靠的是一条
#   **运行时**附加：`docker network connect deploy_default pg18`。
#   这条附加不属于任何 compose 文件 —— 以下任意一件事都会把它弄丢：
#     · `docker compose down`（删掉网络再重建）
#     · pg18 被重建 / 升级
#     · 宿主机重启后 compose 先起、pg18 后起
#   丢了之后的现象非常有误导性：`kids-api` 容器 **Up**、健康检查可能还绿
#   （存活探针不查库），但每个业务请求都刷 `P1001: Can't reach database server`。
#   以前唯一的缓解是「人记得再跑一次」（`deploy/README.md` 第 0 节）。
#
# ── 判据 ────────────────────────────────────────────────────────────────────
#   只做一件幂等的事：**看网络在不在，不在就接上**。不重启任何容器
#   （重启 API 治不了网络，还会把连接池里的现场抹掉）。
#
# 用法（服务器上）：
#   sudo install -m 755 deploy/ensure-kids-pg-network.sh /usr/local/bin/kids-pg-network.sh
#   ( crontab -l 2>/dev/null; \
#     echo "*/10 * * * * /usr/local/bin/kids-pg-network.sh >/dev/null 2>&1" ) | crontab -
#
# 环境变量：KP_PG_CONTAINER（默认 pg18）· KP_COMPOSE_NETWORK（默认 deploy_default）
#           KP_NETWORK_LOG（默认 /var/log/kids-pg-network.log）
set -uo pipefail

CONTAINER="${KP_PG_CONTAINER:-pg18}"
NETWORK="${KP_COMPOSE_NETWORK:-deploy_default}"
LOG="${KP_NETWORK_LOG:-/var/log/kids-pg-network.log}"

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

if ! $DOCKER inspect "$CONTAINER" >/dev/null 2>&1; then
  log "FAIL 找不到容器 $CONTAINER"
  exit 1
fi

# `{{json .NetworkSettings.Networks}}` 输出里出现 "deploy_default" 即已连接。
if $DOCKER inspect -f '{{json .NetworkSettings.Networks}}' "$CONTAINER" | grep -q "\"${NETWORK}\""; then
  exit 0
fi

log "WARN $CONTAINER 不在 $NETWORK 上（DATABASE_URL 会 P1001），正在重新附加"
if $DOCKER network connect "$NETWORK" "$CONTAINER" >>"$LOG" 2>&1; then
  log "OK 已把 $CONTAINER 接回 $NETWORK"
  exit 0
fi

log "FAIL 附加失败（网络不存在？先 docker compose up -d 让 compose 建网）"
exit 2
