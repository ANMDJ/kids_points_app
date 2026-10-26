import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole } from '@prisma/client'

/**
 * 监护人同意的**持久化端口**（W7-A，2026-10-26）。
 *
 * ── 它保护的是什么 ──────────────────────────────────────────────────────────
 *   `GuardianConsent`（`04` §5 / PRD FR-12）：同意必须在**采集之前**取得，
 *   且**可撤回**；撤回后「全链路写入停止」、读取与导出仍可用。
 *   本端口提供三件事实：**当前状态**、**授予**、**撤回**。
 *
 * ── 为什么状态只有一个读方法 ────────────────────────────────────────────────
 *   `readState()` 同时服务两个调用方：
 *     ① `GET /consent`（家长看状态）；
 *     ② `ConsentGuard`（每个写请求都要问一次「这个孩子现在有没有有效同意」）。
 *   若为 Guard 单开一个 `hasActiveConsent()`，两处就会对「什么算有效」各写一份判断 ——
 *   迟早出现「界面显示已撤回、写入却还在放行」的漂移。判定只在这里一次。
 *
 * ── 幂等由**构造**保证，不靠 Idempotency-Key ─────────────────────────────────
 *   · 同一个版本的重复授予 ⇒ 不写库、不写审计，回同一个状态；
 *   · 已撤回的重复撤回 ⇒ 同上；
 *   · 撤回一条**从未授予**的同意 ⇒ 409（不是 200）——否则会凭空造出一段
 *     「曾经同意过」的历史，而那正是审计最不该撒的谎。
 *
 * ── 无库时为什么是 501 而不是 `status: 'none'` ───────────────────────────────
 *   返回 `none` 会让写入闸门**静默放行**（`none` 与「有库但没同意」在形状上一样），
 *   于是「没查」被读成「查了、没问题」。这与 W1-B 的屏障一同一条纪律：
 *   **「没查」≠「查了没有限制」**。因此无库一律显式 501，让装配问题响亮。
 */
export const CONSENT_REPOSITORY = Symbol('CONSENT_REPOSITORY')

/** 同意状态：`none` = 这个孩子从未有过同意记录（不是"撤回"，两者审计含义不同）。 */
export type ConsentStatusValue = 'granted' | 'withdrawn' | 'none'

/** 对外的同意状态（时间统一 ISO 8601 字符串，避免 Prisma `Date` 泄漏到 HTTP 层）。 */
export interface ConsentState {
  childId: string
  status: ConsentStatusValue
  /** 授予时使用的协议版本；`none` 时为 null。 */
  consentVersion: string | null
  grantedAt: string | null
  withdrawnAt: string | null
}

/** 操作人 —— 由 Controller 从已鉴权的会话取，**绝不**读请求体。 */
export interface ConsentOperator {
  userId: string
  role: MemberRole
}

export interface RecordConsentInput {
  /** 由身份 Guard 从会话解析 —— **绝不**取请求体。 */
  childId: string
  /** 服务端配置的协议版本（客户端不能自报，见 `consent.service.ts`）。 */
  consentVersion: string
  operator: ConsentOperator
  /** 不存原始 IP / UA，只存哈希；缺盐时为 null（见 `hash-pii.ts`）。 */
  ipHash: string | null
  userAgentHash: string | null
}

export interface WithdrawConsentInput {
  childId: string
  operator: ConsentOperator
  ipHash: string | null
  userAgentHash: string | null
}

export interface ConsentPort {
  readState(childId: string): Promise<ConsentState>
  recordGrant(input: RecordConsentInput): Promise<ConsentState>
  recordWithdrawal(input: WithdrawConsentInput): Promise<ConsentState>
}

/**
 * 无库装配：三个方法**全部显式 501**。
 *
 * 绝不返回 `status: 'none'` —— 那会让 `ConsentGuard` 把「没查」当成
 * 「确实没同意」进而 403 掉所有写操作（看起来像业务拒绝，实际是装配缺失），
 * 或者反过来被某个调用方当成「没有记录 ⇒ 跳过检查」。
 * 两种误读都不可接受，故响亮失败。
 */
@Injectable()
export class NotImplementedConsentRepository implements ConsentPort {
  async readState(_childId: string): Promise<ConsentState> {
    throw this.notImplemented('读取同意状态')
  }

  async recordGrant(_input: RecordConsentInput): Promise<ConsentState> {
    throw this.notImplemented('记录监护人同意')
  }

  async recordWithdrawal(_input: WithdrawConsentInput): Promise<ConsentState> {
    throw this.notImplemented('撤回监护人同意')
  }

  private notImplemented(what: string): NotImplementedException {
    return new NotImplementedException({
      code: 'CONSENT_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `当前装配没有数据库连接：${what}无处落库，拒绝假装成功。` +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}
