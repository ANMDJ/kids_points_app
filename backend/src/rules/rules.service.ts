import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import type { MemberRole, RuleDirection } from '@prisma/client'

import type { HabitDto, RuleDto } from '../read/read.mapper'
import { signedRulePoints } from '../read/read.mapper'
import {
  RULES_REPOSITORY,
  type AddHabitFromRuleInput,
  type CreateRuleInput,
  type DeleteRuleInput,
  type RulesPort,
  type UpdateRuleInput
} from './rules.repository'
import type { CreateRuleDto } from './dto/create-rule.dto'
import type { UpdateRuleDto } from './dto/update-rule.dto'

/** 请求里的操作人 —— 由 Controller 从已鉴权的会话里取，**绝不**读请求体。 */
export interface RuleOperator {
  userId: string
  role: MemberRole
}

/**
 * 规则写入的**业务层**（W5-A，2026-10-19）。
 *
 * 只做三件事：
 *   ① 把客户端契约（带符号 `points`）规范化为库内契约（正数 + direction）—— 唯一转换点；
 *   ② 防御性校验（DTO 已经挡过一遍；这里保证绕过 HTTP 直接调 service 也安全）；
 *   ③ 把行形状映射成与只读端点**同一份** `RuleDto` / `HabitDto`（客户端无需区分来源）。
 *
 * ★ 不在这里查库判断 `currentVersion` —— 那是 TOCTOU。乐观锁必须由持库的
 *   `UPDATE ... WHERE currentVersion = ?` 来兑现（见 `rules.prisma.repository.ts`）。
 */
@Injectable()
export class RulesService {
  constructor(
    @Inject(RULES_REPOSITORY) private readonly repository: RulesPort
  ) {}

  async createRule(
    childId: string,
    dto: CreateRuleDto,
    operator: RuleOperator
  ): Promise<RuleDto> {
    const title = normalizeTitle(dto.title)
    const condition = normalizeCondition(dto.condition)
    assertDailyLimit(dto.dailyLimit)
    const canonical = canonicalPoints(dto.points)

    const input: CreateRuleInput = {
      childId,
      title,
      condition,
      dailyLimit: dto.dailyLimit,
      points: canonical.points,
      direction: canonical.direction,
      icon: dto.icon,
      color: dto.color,
      operatorUserId: operator.userId,
      operatorRole: operator.role
    }
    return toRuleDto(await this.repository.createRule(input))
  }

  async updateRule(
    childId: string,
    ruleId: string,
    dto: UpdateRuleDto,
    operator: RuleOperator
  ): Promise<RuleDto> {
    const title = normalizeTitle(dto.title)
    const condition = normalizeCondition(dto.condition)
    assertDailyLimit(dto.dailyLimit)
    const canonical = canonicalPoints(dto.points)

    const input: UpdateRuleInput = {
      childId,
      ruleId,
      expectedVersion: dto.expectedVersion,
      title,
      condition,
      dailyLimit: dto.dailyLimit,
      points: canonical.points,
      direction: canonical.direction,
      operatorUserId: operator.userId,
      operatorRole: operator.role
    }
    return toRuleDto(await this.repository.updateRule(input))
  }

  async deleteRule(
    childId: string,
    ruleId: string,
    operator: RuleOperator
  ): Promise<{ ruleId: string }> {
    const input: DeleteRuleInput = {
      childId,
      ruleId,
      operatorUserId: operator.userId,
      operatorRole: operator.role
    }
    return { ruleId: await this.repository.deleteRule(input) }
  }

  async addHabitFromRule(
    childId: string,
    ruleId: string,
    operator: RuleOperator
  ): Promise<HabitDto> {
    const input: AddHabitFromRuleInput = {
      childId,
      ruleId,
      operatorUserId: operator.userId,
      operatorRole: operator.role
    }
    return toHabitDto(await this.repository.addHabitFromRule(input))
  }
}

/** 标题全空白 ⇒ 400（不能落一条"没有名字"的规则）。 */
function normalizeTitle(raw: string): string {
  const title = raw.trim()
  if (title === '') {
    throw new BadRequestException({
      code: 'RULE_TITLE_REQUIRED',
      message: '规则名称不能是空白 —— 孩子需要知道这条约定叫什么。'
    })
  }
  return title
}

/** 与双端本地实现同口径：空约定落成「家长约定」（不是空串）。 */
function normalizeCondition(raw: string): string {
  const condition = raw.trim()
  return condition === '' ? '家长约定' : condition
}

function assertDailyLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new BadRequestException({
      code: 'RULE_DAILY_LIMIT_INVALID',
      message: `每天次数只能是 1–5 之间的整数（收到 ${value}）。`
    })
  }
}

/**
 * 带符号客户端分值 → 库内（正数, direction）。
 * ★ `Math.abs` 只在这里出现一次：它不是"把扣分抹平"，而是"把符号搬进 direction"。
 *   负零 / 0 被 DTO 与这里双重拒绝 —— 0 无法决定 direction。
 */
function canonicalPoints(raw: number): { points: number; direction: RuleDirection } {
  if (!Number.isInteger(raw) || raw === 0 || raw < -10 || raw > 10) {
    throw new BadRequestException({
      code: 'RULE_POINTS_INVALID',
      message: `分值必须是 -10..-1 或 1..10 之间的整数（收到 ${raw}）—— 0 不是一条约定。`
    })
  }
  return {
    points: Math.abs(raw),
    direction: raw < 0 ? 'penalty' : 'reward'
  }
}

function toRuleDto(row: Parameters<typeof signedRulePoints>[0] & {
  id: string
  title: string
  condition: string
  dailyLimit: number
  icon: string
  color: string
  currentVersion: number
}): RuleDto {
  return {
    id: row.id,
    title: row.title,
    condition: row.condition,
    dailyLimit: row.dailyLimit,
    points: signedRulePoints(row),
    direction: row.direction,
    icon: row.icon,
    color: row.color,
    currentVersion: row.currentVersion
  }
}

function toHabitDto(row: {
  id: string
  title: string
  points: number
  condition: string
  dailyLimit: number
  icon: string
  color: string
  ruleId: string | null
}): HabitDto {
  return {
    id: row.id,
    title: row.title,
    points: row.points,
    condition: row.condition,
    dailyLimit: row.dailyLimit,
    icon: row.icon,
    color: row.color,
    ruleId: row.ruleId
  }
}
