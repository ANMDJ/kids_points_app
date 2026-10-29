/*
  W8-C（2026-10-27）：权限矩阵新增 1 个动作 —— 家长 PIN 的设置 / 修改。

  · `manage_parent_pin` —— `POST /auth/parent-pin`（首次设置 / 用旧 PIN 改新 PIN）

  为什么不能复用 `switch_role_mode`：
    ① 方向相反 —— `switch_role_mode` 是**任何人**用 PIN 换取 5 分钟家长模式
       （孩子也必须有，否则孩子拿着手机时无法把家长叫来输 PIN）；
       `manage_parent_pin` 是"定义那把钥匙"，只能由家长做。
    ② 合并会让"我想切家长模式"顺带等于"允许改 PIN" —— 权限只能更严、不能更松
       （02 §3 屏障三的方向性约束）。
    ③ 同意闸门口径也不同：`manage_parent_pin` 在 `contracts/consent-policy.ts` 里
       是**豁免**动作（PIN 是家长自己的凭据，不是儿童数据采集；且它是
       "没 PIN ⇒ 进不了家长模式 ⇒ 无法重新同意"这条死锁的出口）。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且不能与“使用该新值”的 DML 放在同一事务里。
  本迁移只做添加；真正写入该值的代码在应用层（`auth.prisma.repository.ts`）。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'manage_parent_pin';
