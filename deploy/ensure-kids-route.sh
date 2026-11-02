#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# ensure-kids-route.sh —— 把 `/kids/*` 反代插进 hub.littlewish.top:8443 站点
#
# 用法（在服务器上）：
#   sudo bash /srv/kids-points/deploy/ensure-kids-route.sh
#
# 为什么需要它（2026-11-02）：
#   2026-11-02 上午 cline-console 的部署把 `@kids path /k/*`（IP 站点）整段
#   移除了；kids API 因此没有公网入口。App 需要一个**证书系统可信**的地址，
#   所以在已有的 8443 站点里加一条 `handle_path /kids/*`。
#
# 幂等：已存在就什么都不做。改前自动备份；`caddy validate` 失败则还原。
# ────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDY="${CADDY:-/etc/caddy/Caddyfile}"
SNIPPET="$HERE/caddy-kids-8443.snippet"

if [[ ! -f "$SNIPPET" ]]; then
  echo "[fatal] 缺少片段文件：$SNIPPET" >&2
  exit 1
fi

if grep -q 'handle_path /kids/\*' "$CADDY"; then
  echo '[info] 已存在 /kids/*，检查位置并归一化'
fi

BACKUP="$CADDY.bak-$(date +%Y%m%d-%H%M%S)"
cp "$CADDY" "$BACKUP"
echo "[backup] $BACKUP"

python3 - "$CADDY" "$SNIPPET" <<'PY'
import sys
from pathlib import Path

caddy = Path(sys.argv[1])
snippet = Path(sys.argv[2]).read_text(encoding='utf-8')
text = caddy.read_text(encoding='utf-8')

ANCHOR = '\t# SSE 必须实时下发'
SITE = 'hub.littlewish.top:8443 {'
BLOCK_START = '\t# ── 积分小管家 API'

# ① 如果之前插错过位置（443 站点里也有一段同样的注释），先摘掉旧块。
start = text.find(BLOCK_START)
if start != -1:
    end = text.find(ANCHOR, start)
    if end == -1:
        raise SystemExit('[fatal] 旧块之后找不到 SSE 锚点，拒绝继续')
    text = text[:start] + text[end:]

# ② 插到 8443 站点块内、catch-all 反代之前。
site = text.find(SITE)
if site == -1:
    raise SystemExit('[fatal] 找不到 hub.littlewish.top:8443 站点块')
anchor = text.find(ANCHOR, site)
if anchor == -1:
    raise SystemExit('[fatal] 8443 站点里找不到 SSE 锚点，拒绝凭猜改配置')
text = text[:anchor] + snippet + text[anchor:]

caddy.write_text(text, encoding='utf-8')
PY

if ! caddy validate --config "$CADDY"; then
  echo '[fatal] caddy validate 失败，已还原' >&2
  cp "$BACKUP" "$CADDY"
  exit 1
fi

systemctl reload caddy
echo '[ok] 已插入 /kids/* 并 reload caddy'
