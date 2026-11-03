#!/usr/bin/env bash
# deploy/smoke-8443.sh —— 8443 入口验收（2026-11-01）
#
# 在**服务器上**或任意能出网的机器上跑：
#   bash deploy/smoke-8443.sh
#   HOST=www.littlewish.top PORT=8443 bash deploy/smoke-8443.sh   # 换域名/端口
#
# ★ 为什么默认是 www 而不是 kids（2026-11-01 实测）：
#   kids.littlewish.top 的 ACME 自动签发**失败**（LE 多视角验证里有节点被备案页劫持、
#   TLS-ALPN 的 443 被 reset；ZeroSSL 也未成）。改用腾讯云手动 DV 证书后，
#   它的 SAN 只有 littlewish.top + www.littlewish.top，而 www 已解析到本机 —— 故用 www。
#
# 它按「先便宜后昂贵」的顺序检查，任何一项红了都会打印原因和下一步。
# ★ 判据与 deploy/README.md 第 5 节完全一致，不另立一套。
#   匿名探针：`GET /health`（存活，**不查库**）+ `GET /health/ready`（就绪，查库）。
#   ★ 2026-11-03 之前这里写的是「这个项目没有 /health」—— 那是当时的**事实**，
#     不是长期约定；P0-5 落地后改用它（`backend/src/health/`）。

set -uo pipefail

HOST="${HOST:-www.littlewish.top}"
PORT="${PORT:-8443}"
BASE="https://${HOST}:${PORT}"
IP_BASE="${IP_BASE:-http://82.157.153.22}"
TIMEOUT="${TIMEOUT:-10}"

pass=0
fail=0

ok()   { pass=$((pass + 1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  \033[31m✘\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      → %s\n' "$2"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 取 HTTP 状态码（连不上时 curl 返回 000）
code_of() { curl -s -o /dev/null -m "$TIMEOUT" -w '%{http_code}' "$@" 2>/dev/null || echo 000; }

head_ "1) DNS 解析"
# 三种探测方式依次回退：Linux 有 getent/dig，Windows(Git Bash) 只有 nslookup
resolved=""
if command -v getent >/dev/null 2>&1; then
  resolved=$(getent hosts "$HOST" 2>/dev/null | awk '{print $1}' | head -1)
fi
if [ -z "$resolved" ] && command -v dig >/dev/null 2>&1; then
  resolved=$(dig +short "$HOST" A 2>/dev/null | grep -E '^[0-9]+\.' | head -1)
fi
if [ -z "$resolved" ] && command -v nslookup >/dev/null 2>&1; then
  resolved=$(nslookup "$HOST" 2>/dev/null | awk '/^Address: /{print $2}' | tail -1)
fi
if [ -n "$resolved" ]; then
  ok "$HOST → $resolved"
else
  bad "$HOST 解析不到" "先加 A 记录指向 82.157.153.22（证书按域名签，解析不了就签不出）"
fi

head_ "2) TCP 8443 可达"
if (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null; then
  ok "TCP ${HOST}:${PORT} 可连"
  exec 3<&- 2>/dev/null || true
else
  bad "TCP ${HOST}:${PORT} 连不上" "腾讯云安全组放行 TCP ${PORT}；并确认 Caddy 已 reload"
fi

head_ "3) TLS 证书"
cert=$(echo | timeout "$TIMEOUT" openssl s_client -servername "$HOST" -connect "${HOST}:${PORT}" 2>/dev/null \
        | openssl x509 -noout -subject -issuer -dates 2>/dev/null)
if [ -n "$cert" ]; then
  ok "证书已下发"
  printf '%s\n' "$cert" | sed 's/^/      /'
  # 过期检查：notAfter 早于今天 ⇒ 红
  if printf '%s\n' "$cert" | grep -q 'notAfter'; then
    end=$(printf '%s\n' "$cert" | sed -n 's/^notAfter=//p')
    if [ -n "$end" ] && [ "$(date -d "$end" +%s 2>/dev/null || echo 0)" -lt "$(date +%s)" ]; then
      bad "证书已过期（$end）" "这是**手动**证书（腾讯云 DV），去腾讯云重新签发、覆盖 /etc/caddy/certs/littlewish.top.{crt,key}，再 reload"
    fi
  fi
else
  bad "TLS 握手失败 / 拿不到证书" "查 /etc/caddy/certs/littlewish.top.{crt,key} 是否存在、属主 root:caddy 640；再 caddy validate + reload"
fi

head_ "4) 公网链路 + 微信凭据（★ 核心判据）"
body=$(curl -s -m "$TIMEOUT" -X POST "${BASE}/auth/login" \
        -H 'Content-Type: application/json' -d '{"code":"smoke"}' 2>/dev/null)
st=$(code_of -X POST "${BASE}/auth/login" -H 'Content-Type: application/json' -d '{"code":"smoke"}')
case "$st" in
  401)
    if printf '%s' "$body" | grep -q 'WECHAT_CODE_INVALID'; then
      ok "401 + WECHAT_CODE_INVALID ⇒ Caddy→Node→微信 整条链路通、AppSecret 正确"
    else
      ok "401（未带 WECHAT_CODE_INVALID，可能是限流/其他拒绝）"
      printf '      body: %s\n' "$body"
    fi
    ;;
  429) bad "429 限流（20 次/60s）" "等一分钟再跑，或从别的 IP 跑" ;;
  404) bad "404 ⇒ Caddy 没匹配到这个站点" "检查 Caddyfile 里主机名/端口写法，caddy validate 后 reload" ;;
  000) bad "连不上（超时/TLS 被拒）" "回到第 2、3 项" ;;
  *)   bad "意外状态码 $st" "body: $body" ;;
esac

head_ "5) 认证门（不带 token 必须 401）"
st=$(code_of "${BASE}/auth/session")
[ "$st" = "401" ] && ok "GET /auth/session ⇒ 401" || bad "GET /auth/session ⇒ $st（期望 401）" "AuthGuard 没生效，别上线"

head_ "6) 老的 /k 入口仍然可用（小程序还在用，别被 8443 挤掉）"
st=$(code_of -X POST "${IP_BASE}/k/auth/login" -H 'Content-Type: application/json' -d '{"code":"smoke"}')
[ "$st" = "401" ] && ok "${IP_BASE}/k/auth/login ⇒ 401（路由仍在）" \
  || bad "${IP_BASE}/k/auth/login ⇒ $st" "第 4 节的 @kids 段是不是被误删了？"

head_ "7) hub 未受影响"
st=$(code_of "${IP_BASE}/")
[ "$st" = "200" ] && ok "${IP_BASE}/ ⇒ 200（hub 正常）" \
  || bad "${IP_BASE}/ ⇒ $st" "hub 挂了 —— 立刻回滚 Caddyfile：cp 备份回来 + systemctl reload caddy"

head_ "8) 探活（P0-5：存活不查库 / 就绪才查库）"
body=$(curl -s -m "$TIMEOUT" "${BASE}/health" 2>/dev/null)
st=$(code_of "${BASE}/health")
if [ "$st" = "200" ] && printf '%s' "$body" | grep -q '"status":"ok"'; then
  ok "GET /health ⇒ 200 status=ok（进程活着，且没有查库）"
else
  bad "GET /health ⇒ $st" "线上还是旧镜像？重建后重试（README 第 1 节）。注意它是**不查库**的存活探针"
fi
st=$(code_of "${BASE}/health/ready")
case "$st" in
  200) ok "GET /health/ready ⇒ 200（数据库能应答）" ;;
  503) bad "GET /health/ready ⇒ 503（库不可用 / 未配置）" \
        "先 docker logs pg18 看库；★ 不要重启 kids-api —— 重启救不了库。detail 在响应体的 checks.database.detail" ;;
  *)   bad "GET /health/ready ⇒ $st" "404 ⇒ 镜像里没有 P0-5 的 health 模块；000 ⇒ 回到第 2、3 项" ;;
esac

head_ "结果"
printf '  通过 %d 项，失败 %d 项\n' "$pass" "$fail"
if [ "$fail" -eq 0 ]; then
  printf '\n  \033[32m全绿。客户端配置：\033[0m\n'
  printf '    --dart-define=KP_API_BASE_URL=%s\n' "$BASE"
  exit 0
fi
printf '\n  \033[31m有 %d 项没过，先别改客户端。\033[0m\n' "$fail"
exit 1
