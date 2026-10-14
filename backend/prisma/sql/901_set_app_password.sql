-- ══════════════════════════════════════════════════════════════════════════
--  901_set_app_password.sql —— 应用角色口令的**部署注入**（阶段 B2）
--
--  为什么必须单独一个文件：
--    900 里原本硬编码了占位口令（change-me-before-production）。占位口令的
--    真实危害不是"它弱"，而是**它会被原样带上生产** —— 写在版本库里的口令，
--    无论多复杂，都不是秘密。所以口令在仓库里**一处都不存在**：
--    900 只建角色（**不设口令**），口令由本脚本在部署时从环境变量注入。
--
--  用法（口令经环境变量 → psql 变量；仓库里没有任何默认值）：
--      APP_DB_PASSWORD='<强口令>' \
--        psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
--             -v app_password="$APP_DB_PASSWORD" \
--             -f prisma/sql/901_set_app_password.sql
--    Windows PowerShell：
--      $env:APP_DB_PASSWORD='<强口令>'
--      psql $env:MIGRATION_DATABASE_URL -v ON_ERROR_STOP=1 -v app_password=$env:APP_DB_PASSWORD -f prisma/sql/901_set_app_password.sql
--
--  ★★ 两条实测结论（**不是推断**；2026-10-14 在 psql 18.6 上实测，见 docs/design/README.md 待办 7②）：
--     ① `\quit 1` **不支持退出码**（psql 警告「忽略多余的参数 "1"」，退出码仍是 0）
--        —— 所以守卫**不能**靠 `\quit` 来失败；
--     ② 脚本内的 `RAISE EXCEPTION` 在**不带** `-v ON_ERROR_STOP=1` 时，psql 的
--        退出码仍然是 **0**（错误只有一行文字，脚本调用者与 CI 全都看不见）。
--        这正是 D12「假绿」的同一形状：检查"执行了"，但没人知道它失败。
--        因此本链条**所有** psql 调用都必须带 `-v ON_ERROR_STOP=1`。
--     于是守卫写成：变量缺失 → 在 `\else` 分支 RAISE，由 ON_ERROR_STOP 把退出码变成 3。
--
--  幂等：`ALTER ROLE ... PASSWORD` 可重复执行（覆盖旧口令）。
--  前置：`900_ledger_revoke.sql` 已跑过（角色 kids_points_app 已存在）。
-- ══════════════════════════════════════════════════════════════════════════

-- ① fail-closed 守卫：口令必须由调用方注入，脚本内不设任何默认值
\if :{?app_password}
\else
  DO $$
  BEGIN
    RAISE EXCEPTION
      'APP_PASSWORD_NOT_INJECTED：缺少 -v app_password=<口令>。口令必须由部署注入（阶段 B2），脚本内不设默认口令。';
  END
  $$;
\endif

-- ② 强制 SCRAM：避免服务端 password_encryption = md5 时落下一个弱摘要
SET password_encryption = 'scram-sha-256';

-- ③ 落库（覆盖旧口令）。`:'app_password'` 由 psql 做**安全的字面量转义**，
--    不需要（也不允许）在 JS/SQL 里手工拼串。
ALTER ROLE kids_points_app WITH LOGIN PASSWORD :'app_password';

-- ④ 注意：执行到这里**并没有**证明"口令真的换了" —— 那需要两条外部证据：
--      ① 用**旧口令**连接 → 必须失败（SQLSTATE 28P01）
--      ② 用**新口令**跑 `npm run db:verify` → 全绿（含 P1–P3 三条口令判据）
--    证据链与实测记录见 docs/design/README.md「待办 7②」与 06-w0-report.md §10.6。
