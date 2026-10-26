import { BadRequestException, Inject, Injectable } from '@nestjs/common'

import { hashPii } from './hash-pii'
import type { ConsentOperator, ConsentPort, ConsentState } from './consent.repository'
import { CONSENT_REPOSITORY } from './consent.repository'
import type { GrantConsentDto } from './dto/grant-consent.dto'

/**
 * 同意文本版本 —— **服务端**的单一事实源（W7-A）。
 *
 * ⚠ `2026-10-draft` 是**占位版本**：`04` §5 的协议文本尚未定稿（L5 决策）。
 *   定稿后必须改成真实版本号（例如 `2026-11-01`），并同步到前端文案。
 *   版本号参与幂等判定（同版本重复授予不写审计，见 `PrismaConsentRepository`），
 *   所以**绝不能**用它承载"每次部署递增"这类与技术无关的含义。
 *
 * 可用 `CONSENT_TEXT_VERSION` 环境变量覆盖：灰度（部分家庭看到新文本）时，
 * 这种覆盖必须在**同一时间点全量切换**，否则两份文本会同时生效。
 */
export const CONSENT_TEXT_VERSION = '2026-10-draft'
export const CONSENT_TEXT_VERSION_ENV = 'CONSENT_TEXT_VERSION'

/** 读当前生效的协议版本（唯一读取点；repository 只接收结果）。 */
export function consentTextVersion(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[CONSENT_TEXT_VERSION_ENV]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : CONSENT_TEXT_VERSION
}

/** 请求里的留痕原料 —— **原文**只活在这个函数调用里，落库的是哈希。 */
export interface ConsentPii {
  ip?: string
  userAgent?: string
}

/**
 * 同意链路的**业务层**（W7-A，2026-10-26）。
 *
 * 只做三件事：
 *   ① 显式同意的判定（`accepted === true`，否则 400 且不写库）；
 *   ② 把「服务端版本 + 哈希后的 IP/UA」交给端口；
 *   ③ 把端口状态原样映射成 HTTP 契约（字段名与 `ConsentState` 同形，
 *      时间统一 ISO 字符串 —— `Date` 不泄漏到 HTTP 层）。
 *
 * ★ 不在这里判断「该不该拦写入」：那是 `ConsentGuard` 的职责（一份清单）。
 *   本服务只负责**记录事实**与**读出事实**。
 * ★ 不在这里做幂等：幂等需要"读最新状态 + 写"在同一临界区，
 *   只能由持库的适配器在行锁内完成（见 `consent.prisma.repository.ts`）。
 */
@Injectable()
export class ConsentService {
  constructor(@Inject(CONSENT_REPOSITORY) private readonly repository: ConsentPort) {}

  async read(childId: string): Promise<ConsentState> {
    return await this.repository.readState(childId)
  }

  /** 授予同意。重复授予同一版本 ⇒ 幂等（回当前状态，不新增审计）。 */
  async grant(
    childId: string,
    dto: GrantConsentDto,
    operator: ConsentOperator,
    pii: ConsentPii
  ): Promise<ConsentState> {
    if (dto.accepted !== true) {
      throw new BadRequestException({
        code: 'CONSENT_NOT_ACCEPTED',
        message:
          '请求体 accepted 必须为 true：同意必须有明确的肯定表示，' +
          '缺省或 false 都不会被记录成同意。'
      })
    }

    return await this.repository.recordGrant({
      childId,
      consentVersion: consentTextVersion(),
      operator,
      ipHash: hashPii(pii.ip),
      userAgentHash: hashPii(pii.userAgent)
    })
  }

  /** 撤回同意。已撤回 ⇒ 幂等；从未授予 ⇒ 409（由适配器判定）。 */
  async withdraw(
    childId: string,
    operator: ConsentOperator,
    pii: ConsentPii
  ): Promise<ConsentState> {
    return await this.repository.recordWithdrawal({
      childId,
      operator,
      ipHash: hashPii(pii.ip),
      userAgentHash: hashPii(pii.userAgent)
    })
  }
}
