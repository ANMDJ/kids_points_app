#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# ensure-kids-sites.sh —— 把 kids 的公网入口恢复成目标状态（自愈入口，2026-11-10）
#
# 用法（服务器上）：
#   sudo bash /srv/kids-points/deploy/ensure-kids-sites.sh
#
# 做三件事，全部幂等：
#   ① `install-kids-caddy.sh --bootstrap-import`
#        → 装 /etc/caddy/conf.d/20-kids.caddyfile（`kids.littlewish.top` 443 自动证书
#          + `/app/version` 走 API + `/app/*` 走 /srv/kids-points/app），
#          缺 `import /etc/caddy/conf.d/*.caddyfile` 时补上那一行。
#   ② 过渡期旧入口：主文件里没有 `handle_path /k/*` 时补回（小程序开发入口）
#      —— 由 `ensure-kids-route.sh` 负责（它是应急脚本，只做这件事）。
#   ③ 探针：新域名 / 旧入口 / hub 三条一起打，非 200 就 exit 1。
#
# 为什么需要它：
#   cline-hub 发版会**整份覆盖** `/etc/caddy/Caddyfile`（2026-11-02、2026-11-05 两次
#   事故），覆盖后 `import conf.d` 与 `/k/*` 一起消失 ⇒ kids 全站 404 / TLS internal
#   error，而 `deploy-kids-api-1` 仍然 `(healthy)`。watchdog（每 5 分钟）在容器
#   healthy 时用它做公网探针，不通就调本脚本恢复，冷却 600 秒。
#
# 退出码：0 主入口 200；1 主入口仍不通（看 /var/lib/caddy/kids.log 与备份）。
# ════════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDY_FILE=/etc/caddy/Caddyfile
PRIMARY="https://kids.littlewish.top/health"
LEGACY_IP="http://82.157.153.22/k/health"
HUB="https://hub.littlewish.top/api/v1/health"

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || true; }

if [[ "${EUID}" -ne 0 ]]; then
  echo '[fatal] 需要 root：sudo bash deploy/ensure-kids-sites.sh' >&2
  exit 1
fi

# ① 新域名分片（含 import 引导）
if ! bash "$HERE/install-kids-caddy.sh" --bootstrap-import; then
  echo '[fatal] 20-kids 分片安装失败（详见上面的输出）' >&2
  exit 1
fi

# ② 过渡期旧入口 /k（小程序开发用；正式做法是改用 https://kids.littlewish.top）
if ! grep -q 'handle_path /k/\*' "$CADDY_FILE"; then
  echo '[info] 主文件缺 /k/*，补回过渡期入口'
  bash "$HERE/ensure-kids-route.sh" || echo '[warn] /k 恢复失败（App 新域名不受影响）' >&2
else
  echo '[info] /k/* 已存在'
fi

# ③ 三条探针
p=$(code "$PRIMARY")
k=$(code "$LEGACY_IP")
h=$(code "$HUB")
echo "[probe] kids=$p  legacy_k=$k  hub=$h"
if [[ "$p" = "200" ]]; then
  echo '[ok] https://kids.littlewish.top 已就绪'
  exit 0
fi
echo '[fatal] 新域名仍不通：看 `ls /etc/caddy/conf.d/`、`journalctl -u caddy -n 50`、' >&2
echo '        `/var/lib/caddy/kids.log`、`curl -s https://kids.littlewish.top/app/version`' >&2
exit 1
