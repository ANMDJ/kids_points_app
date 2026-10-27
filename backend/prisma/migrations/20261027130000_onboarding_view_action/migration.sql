/*
  W8-A（2026-10-27）：权限矩阵新增 1 个动作 —— 首启引导的**读**。

  · `view_onboarding` —— `GET /onboarding`（读状态 + 已排序的模板卡片）

  为什么不能复用 `apply_onboarding`：
    ① 语义不同 —— 那个动作是「把引导结果写进去」（草稿 / 完成），
       而这条只是「打开引导页看一眼」。合并会让「允许完成」顺带等于「允许读」，
       矩阵上就再也分不出「谁能看引导」。
    ② **同意闸门的口径不同** —— `view_onboarding` 必须在未同意时也可用：
       引导第①步就是「监护人同意」，页要先能打开、能显示这一步的内容；
       若它也受闸门管，用户会看到 403 空页面，而唯一能解除的按钮都渲染不出来。
       `apply_onboarding` 则必须受管（第②步起采集昵称，04 §5 要求同意先于采集）。
       两个动作才能在 `contracts/consent-policy.ts` 里一个进豁免、一个进写侧。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且不能与“使用该新值”的 DML 放在同一事务里。
  本迁移只做添加；真正写入该值的代码在应用层。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'view_onboarding';
