import { Injectable, NotImplementedException } from '@nestjs/common'
import type { AgeBand, MemberRole, RuleDirection } from '@prisma/client'

import type { RuleTemplateRow } from './onboarding.policy'

/**
 * 首启引导的**持久化端口**（W8-A，2026-10-27 / `04` §2–§4）。
 *
 * ── 它保护的是什么 ──────────────────────────────────────────────────────────
 *   ① `Child.onboardedAt` 是引导的**权威状态**（`04` §3）：客户端不缓存，
 *      每次启动问服务端「这个孩子做完引导没有」；
 *   ② 采纳模板 = **复制而非引用**（`04` §3）：一条 `RuleTemplate` 变成
 *      `PointRule` + `PointRuleVersion v1`，之后平台改模板**不能**影响这个家庭；
 *   ③ 「中途退出再进入」要能接着走（`04` §6 4.12）：`ageBand` / `focusAreas`
 *      在 `complete` 之前就必须能落库。
 *
 * ── 为什么 `complete` 是**一个**方法而不是三个 ───────────────────────────────
 *   更新孩子 + 复制 N 条规则 + N 条版本行 + 写审计 + 设 PIN 必须在**同一事务**里。
 *   拆成多个端口方法会让 service 自己拼事务边界；而 service 不持有 `tx`，
 *   最终只能退化成「分开调用，失败时手工补偿」—— 那正是本项目反复拒绝的形态
 *   （`01` §4 事务边界）。
 *
 * ── 无库时为什么全部 501 ────────────────────────────────────────────────────
 *   引导最容易出现的假绿是「完成引导」返回 200 但一条规则都没建 ——
 *   用户进首页看到空账本，会以为「引导没生效」，而日志里一切正常。
 *   因此无库装配下四个方法**显式 501**，绝不返回一份「看起来已经完成」的状态。
 */
export const ONBOARDING_REPOSITORY = Symbol('ONBOARDING_REPOSITORY')

/** 对外的引导状态（时间统一 ISO 8601 字符串，避免 Prisma `Date` 泄漏到 HTTP 层）。 */
export interface OnboardingState {
  childId: string
  /** `onboardedAt !== null` 的派生值 —— 客户端只判一个布尔，不用自己比较日期。 */
  onboarded: boolean
  onboardedAt: string | null
  ageBand: AgeBand | null
  focusAreas: string[]
}

/** 一次读取的完整快照：状态 + 全部可用模板（同一事务内读取）。 */
export interface OnboardingSnapshot {
  state: OnboardingState
  templates: RuleTemplateRow[]
}

/** 操作人 —— 由 Controller 从已鉴权的会话取，**绝不**读请求体。 */
export interface OnboardingOperator {
  userId: string
  role: MemberRole
}

export interface SaveProfileInput {
  /** 由身份 Guard 从会话解析 —— **绝不**取请求体。 */
  childId: string
  ageBand: AgeBand | null
  focusAreas: string[]
  operator: OnboardingOperator
}

export interface CompleteOnboardingInput {
  childId: string
  ageBand: AgeBand | null
  focusAreas: string[]
  /** 已去重、至少 1 条；实现必须**重新校验**模板仍 active（防 TOCTOU）。 */
  templateSlugs: string[]
  /** 已哈希的 PIN；`null` = 旧版本客户端跳过了第⑥步（`04` §2；新客户端必填，见 DTO 注释）。 */
  parentPinHash: string | null
  operator: OnboardingOperator
}

/** 采纳模板生成的一条规则（回包只需要「客户端能不能对上」的字段）。 */
export interface CreatedRuleRow {
  ruleId: string
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: RuleDirection
  icon: string
  color: string
  currentVersion: number
}

export interface CompleteOnboardingResult {
  childId: string
  onboardedAt: string
  rules: CreatedRuleRow[]
}

export interface OnboardingPort {
  /** 状态 + 模板，**一个事务**读 —— 避免「状态是旧的、模板是新的」这种半拍快照。 */
  readSnapshot(childId: string): Promise<OnboardingSnapshot>
  /** 仅读状态（`complete` 前合并缺省值用；不读模板，少一次全表扫描）。 */
  readState(childId: string): Promise<OnboardingState>
  saveProfile(input: SaveProfileInput): Promise<OnboardingState>
  complete(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult>
}

/**
 * 无库装配：四个方法**全部显式 501**。
 *
 * ★ 绝不返回 `{ onboarded: false }`：那会让客户端进入引导，然后在第⑦步失败，
 *   用户已经填了昵称 / 选了 6 条约定之后才被告知「没有数据库」。
 *   响亮失败发生在第一个请求，才是可修复的失败。
 */
@Injectable()
export class NotImplementedOnboardingRepository implements OnboardingPort {
  async readSnapshot(_childId: string): Promise<OnboardingSnapshot> {
    throw this.notImplemented('读取引导状态与模板库')
  }

  async readState(_childId: string): Promise<OnboardingState> {
    throw this.notImplemented('读取引导状态')
  }

  async saveProfile(_input: SaveProfileInput): Promise<OnboardingState> {
    throw this.notImplemented('保存引导中间状态')
  }

  async complete(_input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
    throw this.notImplemented('完成引导（复制模板为规则）')
  }

  private notImplemented(what: string): NotImplementedException {
    return new NotImplementedException({
      code: 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `当前装配没有数据库连接：${what}无处落库，拒绝假装成功。` +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}
