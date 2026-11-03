#!/usr/bin/env bash
# deploy/backup-kids-db.sh —— 每日全量备份 ＋（`--verify`）恢复演练（P0-4，2026-11-03）
#
# ── 它补的是最贵的一条 ────────────────────────────────────────────────────────
#   账本本身不可改（`900_ledger_revoke.sql` 连应用角色的 UPDATE/DELETE 都收走了），
#   但**没有任何一份副本能回滚到昨天**。误删一条、`docker volume rm`、磁盘坏块，
#   任何一种都等于家庭账本全丢。
#
# ── 三道判据（缺一条，这套备份就是假的）──────────────────────────────────────
#   ① `gunzip -t` 只证明压缩流没坏，**不证明能恢复** ⇒ `--verify` 真的恢复一次；
#   ② dump 里必须真的有账本表（`CREATE TABLE "PointRecord"`）——
#      连错库 / 连成空库时 gzip 依然是"完整"的；
#   ③ 恢复后的行数必须与线上一致（0 对 0 也算一致，但**必须比**）。
#
# ── 为什么用 `pg_dump` 全量而不是 WAL 归档 ────────────────────────────────────
#   当前库 9.4MB（2026-11-03 实测），全量 gzip 后不到 1MB；WAL 归档要改
#   `postgresql.conf` + 重启 pg18，收益在这个量级上是负的。等库上 1GB 再谈。
#
# ── 仍未做（诚实标注）──────────────────────────────────────────────────────────
#   备份还在**同一台机器**上（`/srv/backup/kids`）。磁盘坏 / 整机丢时备份一起没。
#   离开本机要一个对象存储（COS）的密钥 —— 那需要你给，脚本里不凭空造。
#
# 用法：
#   sudo install -m 755 deploy/backup-kids-db.sh /usr/local/bin/kids-backup.sh
#   sudo /usr/local/bin/kids-backup.sh            # 只备份
#   sudo /usr/local/bin/kids-backup.sh --verify   # 备份 + 恢复演练（临时库，用完即删）
#
# 环境变量：KP_PG_CONTAINER（默认 pg18）· KP_DB_NAME（默认 kids_points）
#           KP_BACKUP_DIR（默认 /srv/backup/kids）· KP_BACKUP_KEEP_DAYS（默认 14）
set -euo pipefail

CONTAINER="${KP_PG_CONTAINER:-pg18}"
DB="${KP_DB_NAME:-kids_points}"
DIR="${KP_BACKUP_DIR:-/srv/backup/kids}"
KEEP_DAYS="${KP_BACKUP_KEEP_DAYS:-14}"
TEST_DB="${KP_RESTORE_DB:-restore_test}"

# ubuntu 不在 docker 组（2026-11-03 实测 `permission denied ... docker.sock`）；
# root 的 crontab 里 `docker info` 能过，就用不带 sudo 的那条。
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

mkdir -p "$DIR"
STAMP="$(date +%F_%H%M)"
OUT="$DIR/${DB}_${STAMP}.sql.gz"

# `--no-owner`：恢复到一个不是 postgres 的实例时不会因为 `OWNER TO` 失败。
# 不加 `--create`：库由恢复方自己建，避免"意外重建线上库"这种误操作形状。
$DOCKER exec "$CONTAINER" pg_dump -U postgres -d "$DB" --no-owner | gzip -9 >"$OUT"

# ① 压缩流完整性
gunzip -t "$OUT"

size="$(stat -c %s "$OUT")"
if [ "$size" -lt 1024 ]; then
  echo "FAIL 备份只有 $size 字节（$OUT）—— 多半是 pg_dump 立刻失败但管道仍写入了 gzip 头" >&2
  exit 1
fi

# ② 内容自检：账本表真的在里面
if ! gunzip -c "$OUT" | grep -q 'CREATE TABLE public."PointRecord"'; then
  echo "FAIL dump 里没有 point 账本表（$OUT）—— 连错库了？" >&2
  exit 1
fi

# 轮转：只删**本脚本命名规则**下的旧文件，不碰目录里别人放的东西
find "$DIR" -maxdepth 1 -name "${DB}_*.sql.gz" -mtime +"$KEEP_DAYS" -delete

echo "OK 备份完成 $OUT（$size 字节，保留 ${KEEP_DAYS} 天）"

if [ "${1:-}" = "--verify" ]; then
  # ③ 恢复演练：临时库，用完即删。**不碰线上库**（除了只读的 count）。
  $DOCKER exec -i "$CONTAINER" psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS ${TEST_DB}" >/dev/null
  $DOCKER exec -i "$CONTAINER" psql -U postgres -d postgres -q -c "CREATE DATABASE ${TEST_DB}" >/dev/null
  gunzip -c "$OUT" | $DOCKER exec -i "$CONTAINER" psql -U postgres -d "$TEST_DB" -q -v ON_ERROR_STOP=1 >/dev/null

  restored="$($DOCKER exec "$CONTAINER" psql -U postgres -d "$TEST_DB" -tAc 'select count(*) from "PointRecord"')"
  live="$($DOCKER exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select count(*) from "PointRecord"')"
  tables="$($DOCKER exec "$CONTAINER" psql -U postgres -d "$TEST_DB" -tAc "select count(*) from information_schema.tables where table_schema = 'public'")"

  if [ "$restored" != "$live" ]; then
    echo "FAIL 恢复演练：PointRecord 恢复出 $restored 行，线上 $live 行" >&2
    exit 1
  fi

  echo "OK 恢复演练：${TEST_DB} 恢复出 ${tables} 张表，PointRecord=${restored}（与线上一致）"
  $DOCKER exec -i "$CONTAINER" psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS ${TEST_DB}" >/dev/null
  echo "OK 临时库 ${TEST_DB} 已删除"
fi
