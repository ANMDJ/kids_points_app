/*
  W6-D（2026-10-24）：推送队列保留清理所需的索引 `(status, updatedAt)`。

  ── 为什么需要它 ──────────────────────────────────────────────────────────
  W6-C 之后每条审批提醒都会在 `PushRetryJob` 留一行；终态行由
  `PushRetryRetentionWorker` 定期删除。删除语句是：

    DELETE FROM "PushRetryJob"
    WHERE "id" IN (
      SELECT "id" FROM "PushRetryJob"
      WHERE "status" = $1::"PushRetryStatus" AND "updatedAt" < $2
      ORDER BY "updatedAt" ASC LIMIT $3
    )

  已有索引是 `(status, nextAttemptAt)`：它只能把「某状态的全部行」取出来再排序，
  数据量上来后每轮清理都会变成一次大排序。`(status, updatedAt)` 让子查询
  直接按顺序取前 n 个 id，代价与「实际删除量」成正比，而不是与表大小成正比。

  ── 为什么这不影响领件 ────────────────────────────────────────────────────
  `claimDue` 用的是 `(status, nextAttemptAt)`，本索引不替代它；两条路径各自
  有索引，互不干扰。多一个索引会让每次 INSERT 略贵 —— 相对「清理变慢后
  DELETE 长时间持锁」，这个代价是值得的。

  ⚠ 权限：`ALTER DEFAULT PRIVILEGES`（`prisma/sql/900_ledger_revoke.sql`）已覆盖
  本表的 CRUD，索引由迁移属主创建，无需额外授权。
*/

-- CreateIndex
CREATE INDEX "PushRetryJob_status_updatedAt_idx" ON "PushRetryJob"("status", "updatedAt");
