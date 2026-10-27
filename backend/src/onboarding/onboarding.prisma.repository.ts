import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, type AgeBand } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type {
  CompleteOnboardingInput,
  CompleteOnboardingResult,
  CreatedRuleRow,
  OnboardingPort,
  OnboardingSnapshot,
  OnboardingState,
  SaveProfileInput
} from './onboarding.repository'
import type { RuleTemplateRow } from './onboarding.policy'

type Tx = Prisma.TransactionClient

/**
 * 引导的 **Prisma 适配器**（W8-A，2026-10-27 / `04` §2–§4）。
 *
 * ── 三个事务的形状（顺序有理由，不要重排）──────────────────────────────────
 *   读快照：读孩子 + 读 active 模板（同一个只读事务 —— 避免「状态旧、模板新」）
 *   存草稿：锁孩子 → 确认未完成引导 → 更新 ageBand / focusAreas → 写审计
 *   完成：  锁孩子 → 确认未完成 → **重新读模板（active）** → 更新孩子 →
 *           N×(PointRule + PointRuleVersion v1) → 设 PIN（可选）→ 写审计
 *
 * ── 为什么 `complete` 必须**重新读模板**，即使 service 已经读过一次 ─────────
 *   模板是平台级数据，随时可能被下架（`status=deleted`）。若直接相信 service
 *   手里的快照，会出现「采纳了一条已经被下架的模板」—— 规则复制出来的那一刻
 *   就是孤儿。事务内 `WHERE slug IN (...) AND status='active'` 才是权威判定。
 *   缺任何一条 ⇒ 404（不是静默跳过：少一条就少一条约定，家长不会知道）。
 *
 * ── 为什么规则要按**提交顺序**创建 ──────────────────────────────────────────
 *   首页习惯列表按创建时间排序。家长在引导里勾选的顺序就是他的心理顺序；
 *   若按 `sortWeight` 或字母序插入，进首页会看到「怎么和刚才排的不一样」。
 *
 * ── PIN 的边界（诚实标注）───────────────────────────────────────────────────
 *   本轮只**写入** scrypt 哈希（`pin-hash.ts`），**没有校验端点** ——
 *   `02` §7 的「切家长模式」仍未实现。因此这里的 `pinSetAt` 只是一个事实记录，
 *   不代表「PIN 保护已经生效」。审计里也只写 `pinSet: true`，绝不写哈希或长度。
 */
@Injectable()
export class PrismaOnboardingRepository implements OnboardingPort {
  constructor(private readonly prisma: PrismaService) {}

  async readSnapshot(childId: string): Promise<OnboardingSnapshot> {
    const [child, templates] = await this.prisma.$transaction([
      this.prisma.child.findFirst({
        where: { id: childId, status: 'active' },
        select: CHILD_SELECT
      }),
      this.prisma.ruleTemplate.findMany({
        where: { status: 'active' },
        select: TEMPLATE_SELECT,
        orderBy: [{ sortWeight: 'desc' }, { slug: 'asc' }]
      })
    ])

    if (child === null) throw childNotFound(childId)
    return { state: toState(child), templates: templates as RuleTemplateRow[] }
  }

  async readState(childId: string): Promise<OnboardingState> {
    const child = await this.prisma.child.findFirst({
      where: { id: childId, status: 'active' },
      select: CHILD_SELECT
    })
    if (child === null) throw childNotFound(childId)
    return toState(child)
  }

  async saveProfile(input: SaveProfileInput): Promise<OnboardingState> {
    return await this.prisma.$transaction(async (tx) => {
      const child = await this.lockChild(tx, input.childId)
      if (child === null) throw childNotFound(input.childId)
      if (child.onboardedAt !== null) throw alreadyCompleted()

      const nextFocusAreas = [...input.focusAreas]
      const unchanged =
        child.ageBand === input.ageBand && sameStrings(child.focusAreas, nextFocusAreas)

      // 草稿没变 ⇒ 不写 UPDATE、不写审计。`PATCH` 的语义是「把状态改成这个」，
      // 状态没变就没有变更可记；客户端切换步骤时重复提交不会灌满审计。
      if (unchanged) return toState(child)

      const updated = await tx.child.update({
        where: { id: child.id },
        data: { ageBand: input.ageBand, focusAreas: nextFocusAreas },
        select: CHILD_SELECT
      })

      await tx.auditLog.create({
        data: {
          childId: child.id,
          actorUserId: input.operator.userId,
          actorRole: input.operator.role,
          action: 'onboarding.profile_saved',
          targetType: 'Child',
          targetId: child.id,
          before: { ageBand: child.ageBand, focusAreas: child.focusAreas },
          after: { ageBand: updated.ageBand, focusAreas: updated.focusAreas }
        }
      })

      return toState(updated)
    })
  }

  async complete(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
    return await this.prisma.$transaction(async (tx) => {
      const child = await this.lockChild(tx, input.childId)
      if (child === null) throw childNotFound(input.childId)
      if (child.onboardedAt !== null) throw alreadyCompleted()

      // ★ 事务内重新校验模板仍 active（见文件头）。缺一条就整单拒绝。
      const templates = (await tx.ruleTemplate.findMany({
        where: { slug: { in: input.templateSlugs }, status: 'active' },
        select: TEMPLATE_SELECT
      })) as RuleTemplateRow[]

      const bySlug = new Map(templates.map((template) => [template.slug, template]))
      const missing = input.templateSlugs.filter((slug) => !bySlug.has(slug))
      if (missing.length > 0) {
        throw new NotFoundException({
          code: 'ONBOARDING_TEMPLATE_NOT_AVAILABLE',
          message:
            `这些约定已不在模板库里（可能已下架）：${missing.join('、')}。` +
            '请重新选择后再完成引导。'
        })
      }

      const now = new Date()
      const updated = await tx.child.update({
        where: { id: child.id },
        data: {
          ageBand: input.ageBand,
          focusAreas: [...input.focusAreas],
          onboardedAt: now
        },
        select: CHILD_SELECT
      })

      const rules: CreatedRuleRow[] = []
      for (const slug of input.templateSlugs) {
        const template = bySlug.get(slug)
        if (template === undefined) {
          // 上面的 missing 已挡住；这里保留是为类型收窄，不允许静默跳过。
          throw new NotFoundException({
            code: 'ONBOARDING_TEMPLATE_NOT_AVAILABLE',
            message: `模板 ${slug} 不在模板库里，拒绝生成不完整的规则集合。`
          })
        }

        const created = await tx.pointRule.create({
          data: {
            childId: child.id,
            title: template.title,
            condition: template.condition,
            dailyLimit: template.dailyLimit,
            points: template.points,
            direction: template.direction,
            icon: template.icon,
            color: template.color,
            currentVersion: 1
          }
        })

        await tx.pointRuleVersion.create({
          data: {
            ruleId: created.id,
            version: 1,
            title: created.title,
            condition: created.condition,
            dailyLimit: created.dailyLimit,
            points: created.points,
            direction: created.direction,
            changedByUserId: input.operator.userId,
            // 版本行要能回答「这条规则从哪来」—— 模板 slug 是唯一可追溯的线索。
            changeNote: `引导采纳模板：${template.slug}`
          }
        })

        rules.push(toCreatedRule(created))
      }

      if (input.parentPinHash !== null) {
        const members = await tx.childMember.updateMany({
          where: { childId: child.id, userId: input.operator.userId, status: 'active' },
          data: { pinHash: input.parentPinHash, pinSetAt: now }
        })
        if (members.count !== 1) {
          // 屏障一已保证成员位存在；走到这里说明会话里的成员位与库里不一致。
          // 不回滚为「PIN 没设但引导成功」—— 那会让用户以为 PIN 生效了。
          throw new ConflictException({
            code: 'ONBOARDING_MEMBER_NOT_ACTIVE',
            message: '当前账号在这个孩子上没有有效的成员位，无法设置家长 PIN。'
          })
        }
      }

      await tx.auditLog.create({
        data: {
          childId: child.id,
          actorUserId: input.operator.userId,
          actorRole: input.operator.role,
          action: 'onboarding.complete',
          targetType: 'Child',
          targetId: child.id,
          before: {
            onboardedAt: null,
            ageBand: child.ageBand,
            focusAreas: child.focusAreas
          },
          after: {
            onboardedAt: updated.onboardedAt?.toISOString() ?? null,
            ageBand: updated.ageBand,
            focusAreas: updated.focusAreas,
            ruleIds: rules.map((rule) => rule.ruleId),
            templateSlugs: input.templateSlugs,
            // ★ 只记「有没有设」，不记哈希、不记长度、绝不记明文。
            pinSet: input.parentPinHash !== null
          }
        }
      })

      return {
        childId: child.id,
        onboardedAt: (updated.onboardedAt ?? now).toISOString(),
        rules
      }
    })
  }

  /**
   * 锁住孩子并读出引导相关列。
   * 返回 `null` = 不存在；`status !== 'active'` 也当作不存在（跨孩子同一答案）。
   */
  private async lockChild(tx: Tx, childId: string): Promise<{
    id: string
    onboardedAt: Date | null
    ageBand: AgeBand | null
    focusAreas: string[]
    status: string
  } | null> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string
        onboardedAt: Date | null
        ageBand: AgeBand | null
        focusAreas: string[]
        status: string
      }>
    >`
      SELECT id,
             "onboardedAt",
             "ageBand",
             "focusAreas",
             status::text AS status
        FROM "Child"
       WHERE id = ${childId}
       FOR UPDATE
    `
    const row = rows[0]
    if (row === undefined || row.status !== 'active') return null
    return row
  }
}

const CHILD_SELECT = {
  id: true,
  onboardedAt: true,
  ageBand: true,
  focusAreas: true
} as const

const TEMPLATE_SELECT = {
  slug: true,
  title: true,
  condition: true,
  dailyLimit: true,
  points: true,
  direction: true,
  icon: true,
  color: true,
  ageBand: true,
  focusAreas: true,
  sortWeight: true
} as const

function toState(child: {
  id: string
  onboardedAt: Date | null
  ageBand: AgeBand | null
  focusAreas: string[]
}): OnboardingState {
  return {
    childId: child.id,
    onboarded: child.onboardedAt !== null,
    onboardedAt: child.onboardedAt === null ? null : child.onboardedAt.toISOString(),
    ageBand: child.ageBand,
    focusAreas: [...child.focusAreas]
  }
}

function toCreatedRule(row: {
  id: string
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: 'reward' | 'penalty'
  icon: string
  color: string
  currentVersion: number
}): CreatedRuleRow {
  return {
    ruleId: row.id,
    title: row.title,
    condition: row.condition,
    dailyLimit: row.dailyLimit,
    points: row.points,
    direction: row.direction,
    icon: row.icon,
    color: row.color,
    currentVersion: row.currentVersion
  }
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function childNotFound(childId: string): NotFoundException {
  return new NotFoundException({
    code: 'CHILD_NOT_FOUND',
    message: `孩子 ${childId} 不存在或已删除 —— 拒绝读写（跨孩子一律按不存在回答）。`
  })
}

function alreadyCompleted(): ConflictException {
  return new ConflictException({
    code: 'ONBOARDING_ALREADY_COMPLETED',
    message: '这个孩子已经完成首次引导，不能重复提交（重复采纳会重复生成规则）。'
  })
}


