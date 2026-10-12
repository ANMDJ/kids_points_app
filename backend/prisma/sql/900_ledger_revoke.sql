-- ══════════════════════════════════════════════════════════════════════════
--  900_ledger_revoke.sql —— 账本不可变性的**数据库层**强制（02 §5.7 I5）
--
--  验收目标（02 §9.14）：直连 DB 执行 `UPDATE "PointRecord"` 必须**报权限错误**。
--
-- ★★ 必须先解决的坑（文档没写破）：
--    在 PostgreSQL 中，**表的所有者永远拥有全部权限，REVOKE 对所有者无效**。
--    因此 `REVOKE UPDATE ON "PointRecord" FROM PUBLIC` 是**空操作** ——
--    只要应用用「建表用户」连接，02 §9.14 就**永远无法通过**，而 I5 会变成一句空话。
--    正确做法：应用使用**非所有者角色**连接（本脚本创建 kids_points_app）。
--    —— 见 docs/design/06-w0-report.md §3「待确认决策 D7」。
--
--  执行前提：`prisma migrate deploy` 已建表，且以**所有者/超级用户**身份执行：
--      psql "$MIGRATION_DATABASE_URL" -f prisma/sql/900_ledger_revoke.sql
--
--  执行后，应用的 DATABASE_URL 应改用 kids_points_app 角色；
--  迁移仍使用 MIGRATION_DATABASE_URL（所有者）。
-- ══════════════════════════════════════════════════════════════════════════

-- ① 应用角色（幂等创建）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kids_points_app') THEN
    -- ⚠ 生产环境请改用密钥管理注入，不要把这个占位密码带上去
    CREATE ROLE kids_points_app LOGIN PASSWORD 'change-me-before-production';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO kids_points_app;

-- ② 先给全部表正常 CRUD（含未来新建的表）
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kids_points_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kids_points_app;

-- ③ 再**逐张收回**追加式表的 UPDATE / DELETE
--    （顺序不能反：② 会覆盖 ③，所以必须先授后撤）
REVOKE UPDATE, DELETE ON "PointRecord"      FROM kids_points_app;
REVOKE UPDATE, DELETE ON "PointRuleVersion" FROM kids_points_app;
REVOKE UPDATE, DELETE ON "AuditLog"         FROM kids_points_app;

-- ④ 自检：权限若不符合预期就**让迁移失败**，而不是留一句空承诺
--    一个无法失败的检查等于没有检查（D12 / D13 的同类教训）。
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(t, ', ')
    INTO offending
    FROM unnest(ARRAY['PointRecord', 'PointRuleVersion', 'AuditLog']) AS t
   WHERE has_table_privilege('kids_points_app', format('public.%I', t), 'UPDATE')
      OR has_table_privilege('kids_points_app', format('public.%I', t), 'DELETE');

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      '账本不可变性未生效：角色 kids_points_app 仍可 UPDATE/DELETE 表 %（I5 将失效）',
      offending;
  END IF;

  IF NOT has_table_privilege('kids_points_app', 'public."PointRecord"', 'INSERT') THEN
    RAISE EXCEPTION 'kids_points_app 无法 INSERT "PointRecord" —— 账本将完全写不进去';
  END IF;
END
$$;
