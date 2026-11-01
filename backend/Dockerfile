# syntax=docker/dockerfile:1
# ════════════════════════════════════════════════════════════════════════
# kids_points_api 生产镜像 —— 多阶段（2026-11-01）
#
# ── 为什么保留全部依赖（含 devDependencies）────────────────────────────
#   同一镜像既要当「运行进程」（node dist/main.js），也要当「迁移/播种 CLI」
#   （npx prisma migrate deploy / npm run seed / node scripts/verify-db.mjs）。
#   seed 用 tsx、verify 用 node —— 都在 devDependencies 里。镜像大一点没关系：
#   磁盘 89G，换「只在一份镜像上跑完整部署链」的确定性。
#
# ── 运行时硬限（compose 已带）───────────────────────────────────────────
#   mem_limit: 400m   —— Node/Prisma 不裸奔，超限由 cgroup 收割而非拖垮宿主机
#   cpus: 1.5         —— 2 核机器留半核给 PG/Caddy/hub
# ────────────────────────────────────────────────────────────────────────

FROM node:24-bookworm-slim AS base

# ── openssl 必须显式安装（2026-11-01 实测）─────────────────────────────
#   bookworm-slim 不带 openssl / libssl3；缺了 Prisma 会打印
#     "failed to detect the libssl/openssl version ... Defaulting to openssl-1.1.x"
#   于是生成 debian-openssl-1.1.x 引擎，运行期找不到 libssl.so.1.1 直接崩。
#
# ★ 必须换镜像源：在本机实测 deb.debian.org 拉 8.7MB 的 Packages 索引会卡住
#   （6 分钟零进展），换成腾讯云镜像源后秒级完成。
RUN sed -i 's#http://deb.debian.org/debian#http://mirrors.cloud.tencent.com/debian#g' \
        /etc/apt/sources.list.d/debian.sources \
 && apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── 构建层：装全量依赖 + 编译 ────────────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json ./
# --ignore-scripts：package.json 的 postinstall 会跑 `prisma generate`，而此刻
# prisma/ 还没 COPY 进来 ⇒ `schema.prisma: file not found`。改为 COPY 之后显式跑。
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# prisma.config.ts 是 `process.env.MIGRATION_DATABASE_URL ?? env('DATABASE_URL')`，
# 而 config 在加载时 eager 求值 ⇒ 构建期没变量会抛 PrismaConfigEnvError。
# 给占位串让 ?? 短路生效（generate 只读 schema，不连库）。
RUN MIGRATION_DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" npx prisma generate
RUN npm run build

# ── 运行层：只拷产物 + 依赖 + 部署链所需脚本 ────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
# src 必须带上：seed 用 tsx 直接跑 TS 源码，templates.data.ts 会 import ../../src/contracts/onboarding
COPY --from=build /app/src ./src
COPY --from=build /app/nest-cli.json /app/tsconfig.json /app/prisma.config.ts ./
EXPOSE 3000
# 默认行为 = 跑服务；部署时用 docker compose run --rm ... 覆盖成 CLI 命令
CMD ["node", "dist/main.js"]
