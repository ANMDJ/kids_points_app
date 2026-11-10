#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# install-kids-caddy.sh —— 安装 kids.littlewish.top 的 Caddy 分片（方案 A）
#
# 用法（服务器上，仓库目录 /srv/kids-points）：
#   cd /srv/kids-points
#   git pull
#   sudo bash deploy/install-kids-caddy.sh
#
# 前置：cline-hub 已经安装「主文件 + conf.d」结构（主文件里有
#       `import /etc/caddy/conf.d/*.caddyfile`）。没装就先执行：
#   cd /srv/cline-hub && sudo bash deploy/install-caddy-conf.sh --with-legacy
#   （--with-legacy 用于过渡期保留旧 8443 / IP 入口；旧客户端退场后去掉）
#
# 本脚本只写：
#   /etc/caddy/conf.d/20-kids.caddyfile
#   /srv/kids-points/app/（APK 静态目录，属主 caddy）
#   /var/lib/caddy/kids.log（不存在时）
#
# 幂等：可重复执行；改前备份，validate 失败自动还原。
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDY_FILE=/etc/caddy/Caddyfile
CONF_DIR=/etc/caddy/conf.d
FRAGMENT="$CONF_DIR/20-kids.caddyfile"
APP_DIR=/srv/kids-points/app
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$CONF_DIR/20-kids.caddyfile.bak-$STAMP"

if [[ "${EUID}" -ne 0 ]]; then
  echo '[fatal] 需要 root：sudo bash deploy/install-kids-caddy.sh' >&2
  exit 1
fi

if [[ ! -f "$CADDY_FILE" ]] || ! grep -q 'import /etc/caddy/conf.d/\*\.caddyfile' "$CADDY_FILE"; then
  echo '[fatal] /etc/caddy/Caddyfile 还没有 import conf.d；请先安装 cline-hub 的主配置：' >&2
  echo '        cd /srv/cline-hub && sudo bash deploy/install-caddy-conf.sh --with-legacy' >&2
  exit 1
fi

if [[ ! -f "$HERE/conf.d/20-kids.caddyfile" ]]; then
  echo "[fatal] 缺少 $HERE/conf.d/20-kids.caddyfile" >&2
  exit 1
fi

install -d -m 755 "$CONF_DIR"
if [[ -f "$FRAGMENT" ]]; then
  cp -a "$FRAGMENT" "$BACKUP"
  echo "[backup] $BACKUP"
fi

install -m 644 -o root -g root "$HERE/conf.d/20-kids.caddyfile" "$FRAGMENT"

# APK 目录：由 caddy 用户读取（file_server 以 caddy 身份运行）
install -d -o caddy -g caddy -m 755 "$APP_DIR"

# 过渡期：把旧目录里的 Kids APK 复制过来（复制而非移动，旧 8443 地址仍可用）
shopt -s nullglob
old_apks=(/var/www/cline-hub/app/kids-points-*.apk)
if (( ${#old_apks[@]} > 0 )); then
  cp -a "${old_apks[@]}" "$APP_DIR/"
  chown caddy:caddy "$APP_DIR"/kids-points-*.apk
  chmod 644 "$APP_DIR"/kids-points-*.apk
  echo "[apk] 已从 /var/www/cline-hub/app 复制 ${#old_apks[@]} 个 Kids APK 到 $APP_DIR"
else
  echo "[apk] 旧目录没有 Kids APK；发布时用 deploy/publish-kids-apk.sh 上传"
fi
shopt -u nullglob

# 日志文件必须存在且属主为 caddy；已存在时不要截断。
if [[ ! -e /var/lib/caddy/kids.log ]]; then
  install -o caddy -g caddy -m 640 /dev/null /var/lib/caddy/kids.log
fi

if ! caddy validate --config "$CADDY_FILE" --adapter caddyfile; then
  echo '[fatal] caddy validate 失败，正在还原' >&2
  if [[ -f "$BACKUP" ]]; then
    cp -a "$BACKUP" "$FRAGMENT"
  else
    rm -f "$FRAGMENT"
  fi
  exit 1
fi

systemctl reload caddy
echo '[ok] 20-kids.caddyfile 已安装并 reload'
echo '     确认 DNS：dig +short kids.littlewish.top  => 82.157.153.22'
echo '     验收：curl -sI https://kids.littlewish.top/health'
echo '           curl -s  https://kids.littlewish.top/app/version'
echo '           curl -sI https://kids.littlewish.top/app/kids-points-app.apk'
