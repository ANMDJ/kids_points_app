#!/bin/sh
# ════════════════════════════════════════════════════════════════════════
# kids-api 容器入口（P2，2026-11-04）—— 迁移随启动
#
# ── 为什么要在启动时跑迁移 ──────────────────────────────────────────────
#   在此之前，`prisma migrate deploy` 是**手工链**（`deploy/README.md` §2 五步链）：
#   改完 schema 忘了跑，进程照样起来，然后每个请求都在一个缺列的表上报错 ——
#   而那是最难解释的一类故障（「昨天还好好的」）。2026-11-03 就踩过一次：
#   镜像里带着 `kid_mode` 代码、库里没有 `kidModeUntil` 列。
#
# ── 为什么是「失败就不启动」而不是「先起来再说」 ────────────────────────────
#   带着旧 schema 接流量的后果是**写坏数据**（新列缺失时 Prisma 直接抛错，
#   而某些路径会退化成部分写入）。宁可让容器 exit 1 被 compose 重启、让 healthcheck
#   一直是 unhealthy、让 watchdog 喊人 —— 也不要悄悄降级。
#
# ── `migrate deploy` 为什么可以每次启动都跑 ────────────────────────────────
#   它是幂等的：已应用的迁移记录在 `_prisma_migrations` 里，重复执行是 no-op。
#   绝不能在入口用 `migrate dev`（会尝试生成新迁移 / 需要 shadow DB）。
#
# ── 逃生开关 ────────────────────────────────────────────────────────────
#   `PRISMA_MIGRATE_ON_START=0` ⇒ 跳过（只在"库正在恢复、我要先把服务拉起来看日志"
#   这类人工排障时用）。默认值是 **1**：fail-closed 的默认必须是不跳过。
# ════════════════════════════════════════════════════════════════════════
set -eu

if [ "${PRISMA_MIGRATE_ON_START:-1}" = "1" ]; then
  echo "[entrypoint] prisma migrate deploy（幂等；失败则不启动服务）"
  if ! npx --no-install prisma migrate deploy; then
    echo "[entrypoint] 迁移失败：拒绝带着旧 schema 接流量（进程退出，交由 compose/watchdog 处理）" >&2
    exit 1
  fi
  echo "[entrypoint] 迁移完成"
else
  echo "[entrypoint] 已按 PRISMA_MIGRATE_ON_START=0 跳过迁移" >&2
fi

exec "$@"
