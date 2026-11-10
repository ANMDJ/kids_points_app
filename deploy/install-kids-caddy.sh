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
#
# ── 参数（2026-11-10 新增 `--bootstrap-import`）────────────────────────────
#   --bootstrap-import
#       主文件缺 `import /etc/caddy/conf.d/*.caddyfile` 时，自动**追加这一行**
#       （先备份 → validate → 失败整份还原）。
#       为什么需要：2026-11-10 实测这台机器上 conf.d 结构**从没装过**
#       （`/etc/caddy/conf.d` 不存在），Caddyfile 还是单文件；
#       不追加 import 的话本分片永远不会被加载，`kids.littlewish.top`
#       会一直停在 TLS `internal error`。只追加一行，不重写任何站点，
#       主文件与 00 / 10 / 90 的归属不变（见 AGENTS.md §3）。
#       幂等：已有 import 时该开关是 no-op。
# ════════════════════════════════════════════════════════════════════════
set -euo pipefail

BOOTSTRAP_IMPORT=0
for _arg in "$@"; do
  case "$_arg" in
    --bootstrap-import) BOOTSTRAP_IMPORT=1 ;;
    -h|--help)
      echo "用法: sudo bash deploy/install-kids-caddy.sh [--bootstrap-import]"
      exit 0
      ;;
    *)
      echo "[fatal] 未知参数：$_arg（可用：--bootstrap-import）" >&2
      exit 2
      ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDY_FILE=/etc/caddy/Caddyfile
CONF_DIR=/etc/caddy/conf.d
FRAGMENT="$CONF_DIR/20-kids.caddyfile"
APP_DIR=/srv/kids-points/app
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$CONF_DIR/20-kids.caddyfile.bak-$STAMP"
MAIN_BACKUP=''

if [[ "${EUID}" -ne 0 ]]; then
  echo '[fatal] 需要 root：sudo bash deploy/install-kids-caddy.sh' >&2
  exit 1
fi

if [[ ! -f "$CADDY_FILE" ]]; then
  echo "[fatal] 找不到 $CADDY_FILE" >&2
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

# ── 主文件里的 `import conf.d`（本分片能否被加载的唯一前提）──────────────────
# 只补这一行；00 / 10 / 90 与站点内容一概不动（归属见 AGENTS.md §3）。
IMPORT_RE='import /etc/caddy/conf\.d/\*\.caddyfile'
if grep -qE "$IMPORT_RE" "$CADDY_FILE"; then
  echo '[info] 主文件已有 import conf.d'
elif (( BOOTSTRAP_IMPORT == 1 )); then
  MAIN_BACKUP="$CADDY_FILE.bak-$STAMP"
  cp -a "$CADDY_FILE" "$MAIN_BACKUP"
  printf '\n# ── kids 分片入口（install-kids-caddy.sh --bootstrap-import，2026-11-10）──\n# ★ 这一行由 kids_points 仓库追加：它只 import conf.d，不重写任何站点。\n#   cline-hub 发版覆盖主文件后，本行与 20-kids 一起消失 —— 重跑\n#   `sudo bash deploy/ensure-kids-sites.sh` 即可恢复（watchdog 也会自动跑）。\nimport /etc/caddy/conf.d/*.caddyfile\n' >> "$CADDY_FILE"
  echo "[bootstrap] 已追加 import conf.d（主文件备份 $MAIN_BACKUP）"
else
  echo '[fatal] /etc/caddy/Caddyfile 还没有 import conf.d，本分片不会生效。' >&2
  echo '        两种修法（选一）：' >&2
  echo '        ① 本仓库自愈：sudo bash deploy/install-kids-caddy.sh --bootstrap-import' >&2
  echo '        ② 由 cline-hub 装「主文件 + conf.d」结构后再重跑本脚本' >&2
  if [[ -f "$BACKUP" ]]; then cp -a "$BACKUP" "$FRAGMENT"; else rm -f "$FRAGMENT"; fi
  exit 1
fi

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
  if [[ -n "$MAIN_BACKUP" && -f "$MAIN_BACKUP" ]]; then
    cp -a "$MAIN_BACKUP" "$CADDY_FILE"
    echo "[fatal] 主文件也已还原（$MAIN_BACKUP）" >&2
  fi
  exit 1
fi

systemctl reload caddy
echo '[ok] 20-kids.caddyfile 已安装并 reload'
echo '     确认 DNS：dig +short kids.littlewish.top  => 82.157.153.22'
echo '     验收：curl -sI https://kids.littlewish.top/health'
echo '           curl -s  https://kids.littlewish.top/app/version'
echo '           curl -sI https://kids.littlewish.top/app/kids-points-app.apk'
