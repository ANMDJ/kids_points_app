#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# server-prep.sh —— 积分小管家服务器一次性准备（幂等，可反复跑）
#
# 用法：sudo bash deploy/server-prep.sh
# 前提：Docker 装有 pg18 容器（本机已具备），本机无 superuser 口令也行——
#       全部经由 `docker exec pg18 psql -U postgres` 走容器内 peer 认证。
#
# 做三件事：
#   ① swap 2G（无 swap 时 Node 构建/PG 一次内存尖峰 = OOM kill，不能赌）
#   ② /srv/kids-points 目录骨架（代码放这里；.secrets 权限 700）
#   ③ 数据库 kids_points（owner kids_migrator）+ 迁移角色 kids_migrator，
#      迁移口令写入 /srv/kids-points/.secrets/migrator-pw
#
# （应用角色 kids_points_app 由 900_ledger_revoke.sql 在迁移链里创建；
#   它的口令由 901_set_app_password.sql 部署时注入 —— 仓库零口令。）
# ────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo '== [1/3] swap 2G =='
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  sysctl -p >/dev/null
  echo '[swap] 已创建 2G'
else
  echo '[swap] 已存在，跳过'
fi

echo '== [2/3] 目录骨架 =='
mkdir -p /srv/kids-points/.secrets
chmod 700 /srv/kids-points/.secrets

echo '== [3/3] 数据库：kids_points / kids_migrator =='
PGEXEC() { docker exec pg18 psql -U postgres "$@"; }

if ! PGEXEC -tAc "SELECT 1 FROM pg_roles WHERE rolname='kids_migrator'" | grep -q 1; then
  MIGRATOR_PW="$(openssl rand -hex 24)"
  PGEXEC -v ON_ERROR_STOP=1 -c "CREATE ROLE kids_migrator LOGIN PASSWORD '$MIGRATOR_PW';"
  umask 077
  printf '%s' "$MIGRATOR_PW" > /srv/kids-points/.secrets/migrator-pw
  echo '[db] kids_migrator 已创建，口令写入 .secrets/migrator-pw'
else
  echo '[db] kids_migrator 已存在，跳过'
fi

if ! PGEXEC -tAc "SELECT 1 FROM pg_database WHERE datname='kids_points'" | grep -q 1; then
  PGEXEC -v ON_ERROR_STOP=1 -c 'CREATE DATABASE kids_points OWNER kids_migrator;'
  echo '[db] kids_points 已创建'
else
  echo '[db] kids_points 已存在，跳过'
fi

# PG15+ 默认收回了 public schema 的 CREATE —— 迁移角色必须显式拿回。
PGEXEC -d kids_points -v ON_ERROR_STOP=1 -c 'GRANT CREATE ON SCHEMA public TO kids_migrator;'

echo '[done] 服务器准备完成'