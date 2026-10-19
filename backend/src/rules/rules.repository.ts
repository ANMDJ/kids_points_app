import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole, RuleDirection } from '@prisma/client'

import type { HabitRow, RuleRow } from '../read/read.repository'

/**
 * 规则写入口的**持久化端口**（W5-A，2026-10-19）。
 *
 * ── 为什么四条动作在同一个端口里 ───────────────────────────────────────────
 *   它们围绕同一组不变量：
 *     · 规则主体可软删，`PointRuleVersion` **永久保留**（02 §5.6）；
 *     · 改规则必须\"归档新版本 + 更新主体 + 同步派生习惯 + 写审计\"同一事务；
 *     · 由规则派生习惯是\"复制而非引用\"（04 §3），但必须留下 `sourceRuleId`
 *       这条来源链，打卡时才能写出 `(ruleId, ruleVersion)`。
 *   拆成四个端口会让\"版本行什么时候写\"散落到四个地方，I3 就失去了单一实现点。
 *
 * ── 判据在哪一层 ────────────────────────────────────────────────────────────
 *   · 权限：`PERMISSION_MATRIX` + `PermissionsGuard`（本端口不判角色能做什么）；
 *   · 形状 / 分值符号：DTO + `RulesService`（端口只收已规范化的 `points` 与 `direction`）；
 *   · 库层事实（规则是否 active、版本是否仍是 expectedVersion、是否已有派生习惯）：
 *     只有持库连接的人能回答，故在本端口里判。
 */

export const RULES_REPOSITORY = Symbol('RULES_REPOSITORY')

/** 新建规则：`points` 恒正，奖惩由 `direction` 表达（03 A1）。 */
export interface CreateRuleInput {
  childId: string
  title: string
  condition: string
  dailyLimit: number
  /** 恒正；DTO 的带符号值已在 service 转换。 */
  points: number
  direction: RuleDirection
  icon: string
  color: string
  operatorUserId: string
  operatorRole: MemberRole
}

/** 编辑规则：`expectedVersion` 是乐观锁。 */
export interface UpdateRuleInput {
  childId: string
  ruleId: string
  expectedVersion: number
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: RuleDirection
  operatorUserId: string
  operatorRole: MemberRole
}

export interface DeleteRuleInput {
  childId: string
  ruleId: string
  operatorUserId: string
  operatorRole: MemberRole
}

export interface AddHabitFromRuleInput {
  childId: string
  ruleId: string
  operatorUserId: string
  operatorRole: MemberRole
}

export interface RulesPort {
  /**
   * 新建规则 + `PointRuleVersion v1` + 审计（同一事务）。
   *
   * 失败语义：
   *   · 404 `CHILD_NOT_FOUND`（孩子不存在 / 已软删）；
   *   · 409 `RULE_VERSION_CONFLICT`（并发下 v1 已被别人占用）。
   */
  createRule(input: CreateRuleInput): Promise<RuleRow>

  /**
   * 编辑规则：版本 +1、更新主体、同步派生习惯、写审计（同一事务）。
   *
   * 失败语义：
   *   · 404 `RULE_NOT_FOUND`（含跨孩子 / 已软删）；
   *   · 409 `RULE_VERSION_CONFLICT`（`currentVersion !== expectedVersion`）。
   */
  updateRule(input: UpdateRuleInput): Promise<RuleRow>

  /**
   * 软删规则（`status=deleted` + `deletedAt`）。**不删版本行**。
   *
   * 幂等语义：已经删除的同一规则再删一次 ⇒ 原样返回，不再写第二条审计。
   * 失败语义：404 `RULE_NOT_FOUND`（含跨孩子）。
   */
  deleteRule(input: DeleteRuleInput): Promise<string>

  /**
   * 按规则复制出一个首页习惯（保留 `sourceRuleId`）。
   *
   * 失败语义：
   *   · 404 `RULE_NOT_FOUND`（含跨孩子 / 已软删）；
   *   · 409 `RULE_IS_PENALTY`（扣分规则不能变成可打卡习惯 —— 修 A1）；
   *   · 409 `HABIT_ALREADY_EXISTS`（同名 / 同来源的活动习惯已存在）。
   */
  addHabitFromRule(input: AddHabitFromRuleInput): Promise<HabitRow>
}

/**
 * 无库装配的默认实现：**每个方法都 501**。
 * ★ 不返回假规则、不改内存 —— 那会让"没落库"看起来像"已经建好了"。
 */
@Injectable()
export class NotImplementedRulesRepository implements RulesPort {
  async createRule(): Promise<RuleRow> {
    throw new NotImplementedException({
      code: 'RULES_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '规则写入尚未接线（无数据库装配）—— 拒绝假装成功：家长会以为规则已经生效。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }

  async updateRule(): Promise<RuleRow> {
    throw new NotImplementedException({
      code: 'RULES_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '规则编辑尚未接线（无数据库装配）—— 拒绝假装成功：页面会显示一个并未保存的新版本。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }

  async deleteRule(): Promise<string> {
    throw new NotImplementedException({
      code: 'RULES_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '规则删除尚未接线（无数据库装配）—— 拒绝假装成功：家长会以为规则已经移入回收站。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }

  async addHabitFromRule(): Promise<HabitRow> {
    throw new NotImplementedException({
      code: 'RULES_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '「加入今天的习惯」尚未接线（无数据库装配）—— 拒绝假装成功：首页会多出一个并不存在的习惯。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }
}
