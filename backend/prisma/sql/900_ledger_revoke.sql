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
--      psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/sql/900_ledger_revoke.sql
--      # ★ `-v ON_ERROR_STOP=1` 不可省：实测（psql 18.6）脚本内的 RAISE EXCEPTION
--      #   在**不带**它时 psql 退出码仍是 **0** —— 下面第 ④ 段的"让脚本失败"
--      #   就成了一句空话（D12 假绿的同一形状）。
--
--  ★ 口令不在这里（B2，2026-10-14）：本脚本**只建角色、不设口令**；
--    口令由 `901_set_app_password.sql` 在部署时从环境变量注入。
--    完整链条：migrate deploy → 900 → 901 → `npm run db:verify`。
--
--  执行后，应用的 DATABASE_URL 应改用 kids_points_app 角色；
--  迁移仍使用 MIGRATION_DATABASE_URL（所有者）。
-- ══════════════════════════════════════════════════════════════════════════

-- ① 应用角色（幂等创建；**不设口令** —— 口令属于 901，见下）
--    ★ 为什么这里不"顺手设一下口令"：900 是要**反复重跑**的运维脚本，
--      若在此处 `ALTER ROLE ... PASSWORD`，每次重跑都会把**生产口令冲掉**。
--      "只在缺失时建角色、口令交给 901 注入" 才是可重入且不破坏现状的形状。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kids_points_app') THEN
    -- 此前这里是 `LOGIN PASSWORD 'change-me-before-production'`（阶段 B2 已删除）：
    -- 占位口令的真实危害不是"弱"，而是**它会被原样带上生产**。
    CREATE ROLE kids_points_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO kids_points_app;

-- ② 先给全部表正常 CRUD（含未来新建的表）
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kids_points_app;
--   ★ 下面这条 **不够**（2026-11-03 W12 上线时实测踩到）：
--     `ALTER DEFAULT PRIVILEGES` 只对**执行者自己**新建的表生效。本脚本以 postgres 执行，
--     而迁移是以表所有者 `kids_migrator` 跑的 ⇒ kids_migrator 新建的表**不会**自动授权，
--     应用一读就 `42501 permission denied for table ...`（W12 的两张新表就是这样 500 的）。
--     所以必须再按**迁移角色**补一条默认权限，见 ②b。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kids_points_app;

-- ②b 迁移角色（kids_migrator）新建的表也要自动可读写
--     FOR ROLE kids_migrator 需要执行者是超级用户（本脚本以 postgres 执行，满足）。
--     角色由部署链创建（见 deploy/README §2 / MIGRATOR_PW）；不存在时这条会报错，
--     那正是期望的行为 —— 不要在缺少迁移角色时假装授权成功。
ALTER DEFAULT PRIVILEGES FOR ROLE kids_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kids_points_app;


-- ③ 再**逐张收回**追加式表的 UPDATE / DELETE
--    （顺序不能反：② 会覆盖 ③，所以必须先授后撤）
--    ★ 重跑是安全的：本脚本每次部署迁移后都要跑一遍（新增表的 GRANT 只有 ② 能做），
--      REVOKE / GRANT 都是幂等的，不会产生重复授权。
REVOKE UPDATE, DELETE ON "PointRecord"      FROM kids_points_app;
REVOKE UPDATE, DELETE ON "PointRuleVersion" FROM kids_points_app;
REVOKE UPDATE, DELETE ON "AuditLog"         FROM kids_points_app;

-- ③.5 **列级** UPDATE 例外（W7-D，2026-10-27）：允许匿名化，不允许改数
--     删除权（02 §9.20）要求执行时抹掉描述性文本；而 ③ 把整表 UPDATE 收走了。
--     这两条并不矛盾 —— 行的**语义**（分数、版本号、余额）必须不可变，
--     但「写了什么」（标题 / 条件 / 备注）必须能被抹掉。
--     PostgreSQL 的列级授权恰好表达这件事：
--       · 表级 UPDATE 仍然没有 ⇒ `UPDATE ... SET pointsDelta` 依旧 42501；
--       · 这三列可以写   ⇒ `UPDATE ... SET "titleSnapshot"` 可以执行。
--     ★ 不要把这里扩成「整表 UPDATE 再靠应用自觉」—— 那等于把 I5 交回给代码。
GRANT UPDATE ("titleSnapshot", "conditionSnapshot", "note")
  ON "PointRecord" TO kids_points_app;
GRANT UPDATE (title, condition, "changeNote")
  ON "PointRuleVersion" TO kids_points_app;

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

  -- W7-D：列级例外必须**恰好**存在，且不能扩到语义列。
  IF NOT has_column_privilege('kids_points_app', 'public."PointRecord"', 'titleSnapshot', 'UPDATE')
     OR NOT has_column_privilege('kids_points_app', 'public."PointRecord"', 'conditionSnapshot', 'UPDATE')
     OR NOT has_column_privilege('kids_points_app', 'public."PointRecord"', 'note', 'UPDATE') THEN
    RAISE EXCEPTION '匿名化所需的 PointRecord 列级 UPDATE 未授予 —— 删除执行会整笔回滚（02 §9.20）';
  END IF;

  IF NOT has_column_privilege('kids_points_app', 'public."PointRuleVersion"', 'title', 'UPDATE')
     OR NOT has_column_privilege('kids_points_app', 'public."PointRuleVersion"', 'condition', 'UPDATE')
     OR NOT has_column_privilege('kids_points_app', 'public."PointRuleVersion"', 'changeNote', 'UPDATE') THEN
    RAISE EXCEPTION '匿名化所需的 PointRuleVersion 列级 UPDATE 未授予 —— 删除执行会整笔回滚（02 §9.20）';
  END IF;

  IF has_column_privilege('kids_points_app', 'public."PointRecord"', 'pointsDelta', 'UPDATE')
     OR has_column_privilege('kids_points_app', 'public."PointRecord"', 'balanceAfter', 'UPDATE')
     OR has_column_privilege('kids_points_app', 'public."PointRuleVersion"', 'points', 'UPDATE') THEN
    RAISE EXCEPTION '列级授权越界：账本**语义列**可被 UPDATE（I5 失效）';
  END IF;
END
$$;
