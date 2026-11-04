import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common'

import { clientIpOf, hashPii } from '../consent/hash-pii'
import { businessDayOf, resolveBusinessTimeZone } from '../habits/business-day'
import { identifierMessage, normalizeEmail, normalizePhone } from '../identity/account-identifier'
import { formatInviteCode } from '../invites/invite-code'
import { REGISTRATION_INVITE_REPOSITORY } from './registration-invite.repository'
import type { RegistrationInvitePort } from './registration-invite.repository'
import {
  maskEmail,
  maskPhone,
  resolveRegistrationInviteConfig
} from './registration-invite.policy'
import type {
  CreateRegistrationInviteView,
  RegistrationInviteQuotaSnapshot
} from './registration-invite.types'

/** 一天的毫秒 —— 「有效期 N 天」→ 绝对时刻只在这里换算一次。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 网站「邀请码获取」的业务层（W12，2026-11-02）。
 *
 * 它只做四件事：
 *   ① 用**同一份** `account-identifier.ts` 规范化手机号与邮箱；
 *   ② 把「N 天有效期」换算成绝对时刻（客户端只说想要多久，不说具体到哪一刻）；
 *   ③ 把每日额度翻成 HTTP 契约（用完 ⇒ 429，而不是 500 / 空回包）；
 *   ④ 回包只给脱敏后的标识（页面不需要完整手机号）。
 *
 * ★ 它**不**判断「今天还能不能发」—— 那必须与自增在同一条 SQL 里完成
 *   （`registration-invite.prisma.repository.ts` 的 `insertWithQuota`）。
 *   在服务层先读一次额度再发，等于重新引入 TOCTOU。
 */
@Injectable()
export class RegistrationInvitesService {
  constructor(
    @Inject(REGISTRATION_INVITE_REPOSITORY)
    private readonly repository: RegistrationInvitePort
  ) {}

  /**
   * `POST /public/registration-invites` —— 匿名发放一张注册邀请码。
   *
   * 匿名是**刻意**的：申请人还没有账号，这正是这个页面存在的理由。
   * 授权由「手机号 + 邮箱 + 每日额度」共同承担，见 `48` §3。
   */
  async create(
    dto: { phone: string; email: string },
    context: { headers: Record<string, string | string[] | undefined> }
  ): Promise<CreateRegistrationInviteView> {
    const phone = normalizePhone(dto.phone)
    if (phone.kind === 'invalid') {
      throw new BadRequestException({
        code: 'INVALID_PHONE',
        reason: phone.reason,
        message: identifierMessage(phone.reason)
      })
    }

    const email = normalizeEmail(dto.email)
    if (email.kind === 'invalid') {
      throw new BadRequestException({
        code: 'INVALID_EMAIL',
        reason: email.reason,
        message: identifierMessage(email.reason)
      })
    }

    const now = new Date()
    const config = resolveRegistrationInviteConfig()
    const day = businessDayOf(now, resolveBusinessTimeZone(process.env.KP_TIMEZONE))

    const result = await this.repository.createInvite({
      phone: phone.identifier.value,
      email: email.identifier.value,
      expiresAt: new Date(now.getTime() + config.ttlDays * DAY_MS),
      day: day.day,
      dailyLimit: config.dailyLimit,
      issuedIpHash: hashPii(clientIpOf(context.headers)),
      ipDailyLimit: config.ipDailyLimit,
      dayStart: day.start,
      dayEnd: day.end
    })

    if (result.kind === 'ip_limited') {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((day.end.getTime() - now.getTime()) / 1000)
      )
      // ★ 与「当天发完」用同一个 429 但**不同的 code / scope**：
      //   运维看指标时能分清「50 张发完了（正常）」与「一个 IP 在刷（该看日志）」。
      //   文案里不写具体 IP（那是对方的信息），只说"同一网络"。
      throw new HttpException(
        {
          code: 'REGISTRATION_INVITE_IP_LIMIT',
          scope: 'ip',
          ipDailyLimit: result.limit,
          used: result.used,
          retryAfterSeconds,
          message:
            `同一个网络今天已申请过 ${result.used} 个邀请码（上限 ${result.limit} 个）。` +
            `请${formatWait(retryAfterSeconds)}后再来；如果确实是不同家庭，` +
            '换一个网络（用手机流量）即可。'
        },
        HttpStatus.TOO_MANY_REQUESTS
      )
    }

    if (result.kind === 'quota_exhausted') {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((day.end.getTime() - now.getTime()) / 1000)
      )
      throw new HttpException(
        {
          code: 'REGISTRATION_INVITE_DAILY_LIMIT',
          scope: 'daily',
          dailyLimit: config.dailyLimit,
          issued: result.issued,
          retryAfterSeconds,
          message:
            `今天的邀请码已经发完了（每天最多 ${config.dailyLimit} 个，${day.timeZone} 零点重置）。` +
            `请${formatWait(retryAfterSeconds)}后再来，或联系已经在用的家长。`
        },
        HttpStatus.TOO_MANY_REQUESTS
      )
    }

    return {
      code: formatInviteCode(result.row.code),
      expiresAt: result.row.expiresAt.toISOString(),
      phoneMasked: maskPhone(phone.identifier.value),
      emailMasked: maskEmail(email.identifier.value),
      dailyLimit: config.dailyLimit,
      remainingToday: result.row.remainingToday
    }
  }

  /** `GET /public/registration-invites/quota` —— 页面在提交前展示「今天还剩 N 个」。 */
  async readQuota(): Promise<{
    dailyLimit: number
    remainingToday: number
    resetsAt: string
    timeZone: string
  }> {
    const now = new Date()
    const config = resolveRegistrationInviteConfig()
    const day = businessDayOf(now, resolveBusinessTimeZone(process.env.KP_TIMEZONE))
    const snapshot: RegistrationInviteQuotaSnapshot = await this.repository.readQuota({
      day: day.day,
      dailyLimit: config.dailyLimit
    })
    return {
      dailyLimit: snapshot.dailyLimit,
      remainingToday: snapshot.remainingToday,
      resetsAt: day.end.toISOString(),
      timeZone: day.timeZone
    }
  }
}

/** 秒 → 「x 小时」/「x 分钟」（只用于 429 文案，不参与判定）。 */
function formatWait(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.ceil(seconds / 3600)
    return `约 ${hours} 小时`
  }
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `约 ${minutes} 分钟`
}
