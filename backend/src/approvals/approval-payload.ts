import { InternalServerErrorException } from '@nestjs/common'

import type { ActionType } from '../contracts/permission-matrix'

/**
 * 审批 `payload` 列的**读侧**形状与解析（W5-D 从 `approvals.prisma.repository.ts` 抽出）。
 *
 * ── 为什么要抽出来 ────────────────────────────────────────────────────────────
 *   W5-D 的收件箱列表要显示「这条申请是什么」（心愿名 / 加几分 / 新建什么心愿），
 *   而这信息**只**存在 `payload` JSON 里。列表若另写一份宽松解析（比如
 *   `(payload as any).title`），就会出现两种后果：
 *     · 库里坏数据在列表页显示成「undefined」，点批准时才 500 —— 家长以为能批；
 *     · 两处对「什么算合法」的判断漂移，列表说合法、执行说非法。
 *   故：**同一份**逐字段校验既喂执行器，也喂列表摘要；列表侧额外把异常收敛成
 *   `null`（见 `summarizeApprovalPayload`），因为「列表里有一行读不懂」不该让
 *   整个收件箱 500 —— 但**必须**显示成「内容无法识别」，不能猜。
 *
 * ★ 这里的异常是 500（`INVALID_APPROVAL_PAYLOAD`）：payload 由服务端在建请求时
 *   自己写入，形状不对是**我们的坏数据**，不是用户输入错误。
 */

/** 兑换 / 申请兑换的快照形状（`02` §4.3）。读回来时**逐字段校验**，不信任 JSON 列。 */
export interface RedeemPayload {
  wishId: string
  titleSnapshot: string
  costSnapshot: number
}

/**
 * `request_points_bonus` 的快照形状。
 *
 * ★ `ruleId` / `habitId` 至多一个（`snapshotBonusPayload` 保证）；
 *   `*TitleSnapshot` 是建请求时读到的标题 —— 批准时若对象已删，UI 仍能说清
 *   「你申请的是哪条规则/习惯的加分」。
 */
export interface BonusPayload {
  amount: number
  reason: string
  ruleId: string | null
  ruleTitleSnapshot: string | null
  habitId: string | null
  habitTitleSnapshot: string | null
}

/** `add_wish` 的快照形状（批准时才真正落 `Wish`）。 */
export interface AddWishPayload {
  title: string
  cost: number
  emoji: string
}

/** 本模块认识的 payload 联合（动作类型决定该按哪个接口解析）。 */
export type ApprovalPayload = RedeemPayload | BonusPayload | AddWishPayload

/**
 * 列表用的**结构化**摘要 —— 只带数据，不带展示串。
 *
 * ★ 与 `read.mapper` 同一口径：服务端不生成「兑换「乐高」需要 100 分」这种
 *   文案。文案要随客户端语言 / 排版变化，塞进响应就会两端口径不一致。
 *   客户端按 `kind` 自己拼（Flutter / 小程序各有一份派生函数，用例各自钉住）。
 */
export type ApprovalSummary =
  | { kind: 'redeem'; wishId: string; title: string; cost: number }
  | {
      kind: 'bonus'
      amount: number
      reason: string
      ruleId: string | null
      habitId: string | null
      basisTitle: string | null
    }
  | { kind: 'add_wish'; title: string; cost: number; emoji: string }

/**
 * 按**动作类型**解析 payload：动作决定形状，绝不允许「一个解析器猜所有形状」
 * （按字段猜形状会把「带 amount 的兑换」解析成加分申请）。
 * 任何缺字段 / 多余字段 / 类型不对 ⇒ 500 `INVALID_APPROVAL_PAYLOAD`（库里的坏数据）。
 */
export function parseApprovalPayload(action: ActionType, payload: unknown): ApprovalPayload {
  switch (action) {
    case 'redeem':
    case 'request_redeem':
      return parseRedeemPayload(payload)
    case 'request_points_bonus':
      return parseBonusPayload(payload)
    case 'add_wish':
      return parseAddWishPayload(payload)
    default:
      throw new InternalServerErrorException({
        code: 'INVALID_APPROVAL_ACTION',
        message: `动作 ${action} 没有 payload 解析器 —— 可执行名单与解析实现已经漂移。`
      })
  }
}


/**
 * 列表侧的摘要：**永不抛异常**。
 *
 * 解析失败返回 `null`，HTTP 层把它翻成 `summary: null`；客户端必须把
 * `summary === null` 显示成「内容无法识别（数据异常）」并**禁用批准按钮**
 * —— 不是因为不能批，而是因为家长看不到自己在批什么。真正的原因由
 * 执行器在 `/decide` 再报一次 500。
 *
 * ★ 未知动作也返回 `null`（而不是 500）：列表是**跨时间**的读视图，历史上
 *   可能存在已下线的动作；让整个收件箱因为一行旧数据打不开，比少一行摘要更糟。
 */
export function summarizeApprovalPayload(
  action: string,
  payload: unknown
): ApprovalSummary | null {
  try {
    const parsed = parseApprovalPayload(action as ActionType, payload)
    switch (action) {
      case 'redeem':
      case 'request_redeem': {
        const redeem = parsed as RedeemPayload
        return {
          kind: 'redeem',
          wishId: redeem.wishId,
          title: redeem.titleSnapshot,
          cost: redeem.costSnapshot
        }
      }
      case 'request_points_bonus': {
        const bonus = parsed as BonusPayload
        return {
          kind: 'bonus',
          amount: bonus.amount,
          reason: bonus.reason,
          ruleId: bonus.ruleId,
          habitId: bonus.habitId,
          // 依据标题是快照，缺失（依据已删或本就没带）时为 null —— 不拿 id 冒充标题。
          basisTitle: bonus.ruleTitleSnapshot ?? bonus.habitTitleSnapshot
        }
      }
      case 'add_wish': {
        const wish = parsed as AddWishPayload
        return { kind: 'add_wish', title: wish.title, cost: wish.cost, emoji: wish.emoji }
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** 读 `payload` 列：**逐字段**校验（枚举外的值 / 缺字段 ⇒ 500，不猜）。 */
function parseRedeemPayload(payload: unknown): RedeemPayload {
  const record = payloadRecord(payload, () => {
    throw new InternalServerErrorException({
      code: 'INVALID_APPROVAL_PAYLOAD',
      message:
        '审批 payload 形状不对（应含 wishId / titleSnapshot / costSnapshot）—— ' +
        '这是库里的坏数据，拒绝据此扣分（那会造出一笔解释不清的流水）。'
    })
  })
  const { wishId, titleSnapshot, costSnapshot } = record
  if (
    typeof wishId !== 'string' ||
    wishId === '' ||
    typeof titleSnapshot !== 'string' ||
    titleSnapshot === '' ||
    typeof costSnapshot !== 'number' ||
    !Number.isInteger(costSnapshot) ||
    costSnapshot <= 0
  ) {
    throw badRedemption()
  }
  return { wishId, titleSnapshot, costSnapshot }
}

/** 读 `request_points_bonus` 的 payload：金额 / 事由 / 至多一个依据。 */
function parseBonusPayload(payload: unknown): BonusPayload {
  const record = payloadRecord(payload, badBonus)
  const { amount, reason, ruleId, ruleTitleSnapshot, habitId, habitTitleSnapshot } = record

  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > 50 ||
    typeof reason !== 'string'
  ) {
    throw badBonus()
  }
  if (ruleId !== null && typeof ruleId !== 'string') {
    throw basicBad('ruleId 形状不对。')
  }
  if (habitId !== null && typeof habitId !== 'string') {
    throw basicBad('habitId 形状不对。')
  }
  if (ruleId !== null && habitId !== null) {
    throw basicBad('加分申请同时带 ruleId 与 habitId —— 依据不唯一，无法复查。')
  }
  if (ruleTitleSnapshot !== null && typeof ruleTitleSnapshot !== 'string') {
    throw basicBad('ruleTitleSnapshot 形状不对。')
  }
  if (habitTitleSnapshot !== null && typeof habitTitleSnapshot !== 'string') {
    throw basicBad('habitTitleSnapshot 形状不对。')
  }

  return { amount, reason, ruleId, ruleTitleSnapshot, habitId, habitTitleSnapshot }
}

/** 读 `add_wish` 的 payload：标题 / 成本 / 表情。 */
function parseAddWishPayload(payload: unknown): AddWishPayload {
  const record = payloadRecord(payload, () => {
    throw basicBad('新建心愿的 payload 不是对象 —— 拒绝据此创建心愿。')
  })
  const { title, cost, emoji } = record
  if (
    typeof title !== 'string' ||
    title.trim() === '' ||
    title.length > 100 ||
    typeof cost !== 'number' ||
    !Number.isInteger(cost) ||
    cost <= 0 ||
    cost > 100_000 ||
    typeof emoji !== 'string' ||
    emoji.trim() === '' ||
    emoji.length > 8
  ) {
    throw basicBad(
      '新建心愿的 payload 形状不对（应含 title / 正整数 cost / emoji）—— ' +
        '这是库里的坏数据，拒绝据此创建心愿。'
    )
  }
  return { title, cost, emoji }
}

type PayloadRecord = Record<string, unknown>

/** payload 必须是**普通对象**（数组 / null / 标量一律拒绝，绝不 `as any` 硬取字段）。 */
function payloadRecord(payload: unknown, bad: () => never): PayloadRecord {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return bad()
  }
  return payload as PayloadRecord
}

/** 兑换申请的坏数据出口。 */
function badRedemption(): never {
  throw new InternalServerErrorException({
    code: 'INVALID_APPROVAL_PAYLOAD',
    message:
      '审批 payload 形状不对（应含 wishId / titleSnapshot / costSnapshot）—— ' +
      '这是库里的坏数据，拒绝据此扣分（那会造出一笔解释不清的流水）。'
  })
}

/** 加分申请的坏数据出口。 */
function badBonus(): never {
  throw new InternalServerErrorException({
    code: 'INVALID_APPROVAL_PAYLOAD',
    message:
      '加分申请的 payload 形状不对（应含 1..50 的 amount 与 reason）—— ' +
      '这是库里的坏数据，拒绝据此加分。'
  })
}

/** 抛出一个 `INVALID_APPROVAL_PAYLOAD`。 */
function basicBad(message: string): never {
  throw new InternalServerErrorException({ code: 'INVALID_APPROVAL_PAYLOAD', message })
}

