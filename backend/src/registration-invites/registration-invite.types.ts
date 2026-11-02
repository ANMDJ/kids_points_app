/**
 * 网站注册邀请码的**线格式**与**端口行**（W12，2026-11-02）
 *
 * 与 `invites.types.ts` 同一条纪律：服务端只下发事实
 * （`code` / `expiresAt` / `dailyLimit` / `remainingToday`），
 * 不下发「还剩几个小时过期」这类**结论** —— 结论只由界面按绝对时刻现算。
 */

/** `POST /public/registration-invites` 的回包。 */
export interface CreateRegistrationInviteView {
  /** 展示形：`ABCD-EFGH`。注册时裸码与连字符写法都接受（服务端归一化）。 */
  code: string
  /** 绝对到期时刻（ISO）。 */
  expiresAt: string
  /** 码绑定的手机号（脱敏）。 */
  phoneMasked: string
  /** 码绑定的邮箱（脱敏）。 */
  emailMasked: string
  /** 当前生效的每日上限（来自配置，便于页面如实展示）。 */
  dailyLimit: number
  /** 这个业务日还剩多少张（含本次之前）。 */
  remainingToday: number
}

/** 仓储创建成功后的行（时间仍是 `Date`，服务层再转 ISO）。 */
export interface CreatedRegistrationInviteRow {
  code: string
  expiresAt: Date
  remainingToday: number
}

/** 创建入参。码由适配器用密码学随机生成并换码重试，调用方不指定。 */
export interface CreateRegistrationInviteInput {
  /** 已规范化（`normalizePhone`）。 */
  phone: string
  /** 已规范化（`normalizeEmail`，全小写）。 */
  email: string
  expiresAt: Date
  /** `YYYY-MM-DD`（`KP_TIMEZONE` 的业务日）。 */
  day: string
  /** 当前生效的每日上限。 */
  dailyLimit: number
  /** 来源 IP 的 HMAC；没有盐时 `null`。 */
  issuedIpHash: string | null
}

/**
 * 创建结果。
 *
 * `quota_exhausted` 是**正常业务结局**（不是异常）：仓储返回它，
 * 服务层负责翻成 429 并给出「明天几点再来」。
 */
export type CreateRegistrationInviteResult =
  | { kind: 'created'; row: CreatedRegistrationInviteRow }
  | { kind: 'quota_exhausted'; issued: number }

/** 注册时用来**路由**的码行（只读；不参与授权判定）。 */
export interface RegistrationInviteLookup {
  phone: string
  email: string
  expiresAt: Date
  usedAt: Date | null
  revoked: boolean
}

/** 占码成功后的行（`RETURNING`）。 */
export interface ClaimedRegistrationInviteRow {
  id: string
}

/** 当日额度的只读快照（`GET /public/registration-invites/quota`）。 */
export interface RegistrationInviteQuotaSnapshot {
  dailyLimit: number
  issued: number
  remainingToday: number
}

