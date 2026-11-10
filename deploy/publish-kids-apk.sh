#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# publish-kids-apk.sh —— 把新 APK 发布到 kids.littlewish.top 的下载目录
#
# 用法（服务器上，APK 已 scp 到 /tmp）：
#   sudo bash deploy/publish-kids-apk.sh /tmp/kids-points-1.0.7.apk 1.0.7
#
# 产出：
#   /srv/kids-points/app/kids-points-1.0.7.apk   （版本化，便于回滚）
#   /srv/kids-points/app/kids-points-app.apk     （稳定地址，/app/version 返回它）
#
# URL：
#   https://kids.littlewish.top/app/kids-points-app.apk
#
# 注意：本脚本只负责放文件；版本号还要同步
#       pubspec.yaml / lib/app_version.dart / /srv/kids-points/kids.env 三处。
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

APK="${1:?用法: publish-kids-apk.sh <apk路径> <版本号，如 1.0.7>}"
VERSION="${2:?缺少版本号}"
APP_DIR=/srv/kids-points/app

if [[ "${EUID}" -ne 0 ]]; then
  echo '[fatal] 需要 root：sudo bash deploy/publish-kids-apk.sh <apk> <version>' >&2
  exit 1
fi

if [[ ! -f "$APK" ]]; then
  echo "[fatal] 找不到 APK：$APK" >&2
  exit 1
fi

install -d -o caddy -g caddy -m 755 "$APP_DIR"
install -o caddy -g caddy -m 644 "$APK" "$APP_DIR/kids-points-$VERSION.apk"
install -o caddy -g caddy -m 644 "$APK" "$APP_DIR/kids-points-app.apk"

echo "[ok] 已发布 $APP_DIR/kids-points-$VERSION.apk"
echo "[ok] 稳定地址 $APP_DIR/kids-points-app.apk"
ls -l "$APP_DIR/kids-points-$VERSION.apk" "$APP_DIR/kids-points-app.apk"
echo '验收：curl -sI https://kids.littlewish.top/app/kids-points-app.apk | head -1'
