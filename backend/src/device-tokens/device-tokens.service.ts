import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'

import type { Actor } from '../permissions/actor'
import {
  DEVICE_TOKENS_REPOSITORY,
  type DeviceTokensPort
} from './device-tokens.repository'
import type {
  DeviceTokenDto,
  DeviceTokenRow
} from './device-tokens.types'
import type { RegisterDeviceTokenDto, RevokeDeviceTokenDto } from './dto/register-device-token.dto'

/**
 * 设备推送 token 的**业务层**（W6-A，2026-10-24）。
 *
 * 只做三件事：
 *   ① 把端口行映射成 HTTP 契约（`Date` → ISO 串）；
 *   ② 把端口的 `owned_by_other` / `not_found` 翻成 **409 / 404**（带机器码）；
 *   ③ 把「谁」写死成会话 actor —— **没有任何一个方法接受客户端传来的 userId**。
 *
 * ── 为什么冲突是 409 而不是 400 ─────────────────────────────────────────────
 *   请求本身没写错（形状合法、token 也真实存在），错的是**当前状态**：
 *   这个 token 已经属于另一个账号。400 会让客户端去改请求体（改成什么都不会成功），
 *   409 + `DEVICE_TOKEN_OWNED_BY_OTHER` 才指向正确的处置：
 *   **先让前一个账号注销，或换一个 token**。
 *
 * ── 为什么注销「不是我的」回 404 ─────────────────────────────────────────────
 *   409 会确认「这个 token 存在，只是不属于你」—— 那就成了一个探测口。
 *   与 `PATCH /notifications/:id/read` 同一条口径：**不是我的 = 不存在**。
 */
@Injectable()
export class DeviceTokensService {
  constructor(
    @Inject(DEVICE_TOKENS_REPOSITORY) private readonly repository: DeviceTokensPort
  ) {}

  async register(
    dto: RegisterDeviceTokenDto,
    actor: Actor,
    childId: string
  ): Promise<DeviceTokenDto> {
    const result = await this.repository.register({
      userId: actor.userId,
      childId,
      platform: dto.platform,
      // DTO 已拒绝空白字符；trim 只是防御（例如将来 DTO 放宽）。
      token: dto.token.trim()
    })
    if (result.kind === 'owned_by_other') {
      throw new ConflictException({
        code: 'DEVICE_TOKEN_OWNED_BY_OTHER',
        message:
          '这个推送 token 已绑定到另一个账号。共享设备请先在原账号里注销，或使用新的 token。'
      })
    }
    return toDto(result.row)
  }

  async revoke(dto: RevokeDeviceTokenDto, actor: Actor): Promise<DeviceTokenDto> {
    const result = await this.repository.revoke({
      userId: actor.userId,
      token: dto.token.trim()
    })
    if (result.kind === 'not_found') {
      // 幂等边界：**已注销**（active=false）仍回 200，见 ports 的实现（条件 UPDATE）。
      throw new NotFoundException({
        code: 'DEVICE_TOKEN_NOT_FOUND',
        message: '这个推送 token 不在本账号下（可能已注销，或属于另一个账号）。'
      })
    }
    return toDto(result.row)
  }
}

/** 端口行 → 线格式：时间一律 ISO 串；**不含 `token`**（见 types 文件头 ①）。 */
function toDto(row: DeviceTokenRow): DeviceTokenDto {
  return {
    id: row.id,
    platform: row.platform,
    active: row.active,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString()
  }
}
