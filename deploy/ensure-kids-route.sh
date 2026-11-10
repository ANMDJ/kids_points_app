#!/usr/bin/env bash
# ⚠️ 历史脚本（2026-11-10 起由 conf.d 方案替代）：
#    正式配置是 deploy/conf.d/20-kids.caddyfile，安装用 deploy/install-kids-caddy.sh。
#    本脚本只保留给「还没迁移到 conf.d」的旧单文件 Caddyfile 做应急/回滚。
# ════════════════════════════════════════════════════════════════════════
# ensure-kids-route.sh —— 把两条 kids 入口插回 Caddy
#
#   ① `handle_path /kids/*` → 127.0.0.1:3000，插进 `hub.littlewish.top:8443` 站点
#      （Flutter App 的 baseUrl = `https://hub.littlewish.top:8443/kids`）
#   ② `handle_path /k/*`    → 127.0.0.1:3000，插进 `http://82.157.153.22` 站点
#      （微信小程序 `.env.local` 的 baseUrl = `http://82.157.153.22/k`）
#
# 用法（在服务器上）：
#   sudo bash /srv/kids-points/deploy/ensure-kids-route.sh
#
# 为什么需要它（2026-11-02，2026-11-05 复发一次）：
#   cline-console / cline-hub 的部署会**整份覆盖** /etc/caddy/Caddyfile，
#   把 `@kids path /k/*`（IP 站点）和 8443 站点里的 `/kids/*` 一起抹掉；
#   结果：App 与小程序第一次请求就是 404（客户端把它翻译成"数据不存在"）。
#   2026-11-05 实测：`/kids/health`、`/kids/app/version`、`/k/health` 全是 404，
#   而 `deploy-kids-api-1` 容器本身 `(healthy)`、`127.0.0.1:3000/health` 200。
#   ⇒ 每次 cline-hub 发版后都应该重跑一次本脚本（或把它挂进 watchdog）。
#
# 幂等：已存在就什么都不做。改前自动备份；`caddy validate` 失败则整份还原。
# ────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CADDY="${CADDY:-/etc/caddy/Caddyfile}"
SNIPPET="$HERE/caddy-kids-8443.snippet"
K_SNIPPET="$HERE/caddy-kids-k.snippet"

for f in "$SNIPPET" "$K_SNIPPET"; do
  if [[ ! -f "$f" ]]; then
    echo "[fatal] 缺少片段文件：$f" >&2
    exit 1
  fi
done

if grep -q 'handle_path /kids/\*' "$CADDY"; then
  echo '[info] 已存在 /kids/*，检查位置并归一化'
fi
if grep -q 'handle_path /k/\*' "$CADDY"; then
  echo '[info] 已存在 /k/*，检查位置并归一化'
fi

BACKUP="$CADDY.bak-$(date +%Y%m%d-%H%M%S)"
cp "$CADDY" "$BACKUP"
echo "[backup] $BACKUP"

python3 - "$CADDY" "$SNIPPET" "$K_SNIPPET" <<'PY'
import sys
from pathlib import Path

caddy = Path(sys.argv[1])
snippet = Path(sys.argv[2]).read_text(encoding='utf-8')
k_snippet = Path(sys.argv[3]).read_text(encoding='utf-8')
text = caddy.read_text(encoding='utf-8')

ANCHOR = '\t# SSE 必须实时下发'
SITE = 'hub.littlewish.top:8443 {'
BLOCK_START = '\t# ── 积分小管家 API'
K_BLOCK_START = '\t# ── 小程序入口'
IP_SITE = 'http://82.157.153.22 {'
IP_ANCHOR = '\troot * /var/www/cline-hub'

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

# ③ `/k/*`：摘掉旧块（若有），再插到 IP 站点的 file_server 之前。
k_start = text.find(K_BLOCK_START)
if k_start != -1:
    k_end = text.find(IP_ANCHOR, k_start)
    if k_end == -1:
        raise SystemExit('[fatal] 旧 /k 块之后找不到 root 锚点，拒绝继续')
    text = text[:k_start] + text[k_end:]

ip_site = text.find(IP_SITE)
if ip_site == -1:
    # 不 fatal：IP 站点可能被运维整段删掉，而 /kids/* 才是 App 的主路径。
    print('[warn] 找不到 http://82.157.153.22 站点，跳过 /k/*（小程序入口仍需人工确认）')
else:
    ip_anchor = text.find(IP_ANCHOR, ip_site)
    if ip_anchor == -1:
        raise SystemExit('[fatal] IP 站点里找不到 root 锚点，拒绝凭猜改配置')
    text = text[:ip_anchor] + k_snippet + text[ip_anchor:]

caddy.write_text(text, encoding='utf-8')
PY

if ! caddy validate --config "$CADDY"; then
  echo '[fatal] caddy validate 失败，已还原' >&2
  cp "$BACKUP" "$CADDY"
  exit 1
fi

systemctl reload caddy
echo '[ok] 已插入 /kids/*（8443）与 /k/*（IP 站点）并 reload caddy'
