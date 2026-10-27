/*
  W7-C（2026-10-27）：权限矩阵新增 1 个动作。

  · `export_family_data` —— `GET /export`（家长导出整份家庭数据：
    档案 / 成员 / 规则与版本 / 习惯 / 心愿 / 流水 / 审批 / 同意记录 / 审计）。

  为什么不能复用 `view_child_points` / `view_records`：那两个动作是**逐屏读取**
  （孩子也 ALLOW），而这里一次返回全家所有流水与成员信息 —— 把它挂到孩子
  也能用的读动作上，等于让「看一眼自己的分」顺带等于「批量带走全家数据」。

  为什么它不是写动作：导出不改变任何一行；且撤回同意后仍必须可用
  （`contracts/consent-policy.ts` 的豁免集合，04 §5 的可携带承诺）。

  ⚠ `ALTER TYPE … ADD VALUE` 不可回滚，且不能与“使用该新值”的 DML 放在同一事务里。
  本迁移只做添加；真正写入该值的代码在应用层。
  IF NOT EXISTS 让本迁移可以安全地重复应用。
*/

-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE IF NOT EXISTS 'export_family_data';
