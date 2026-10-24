import { IsIn, IsString, Length, Matches } from 'class-validator'

import { DEVICE_PLATFORMS, type DevicePlatformName } from '../device-tokens.types'

/**
 * `POST /device-tokens` 的请求体（W6-A，2026-10-24）。
 *
 * ── 集合封闭 ────────────────────────────────────────────────────────────────
 *   只有 `platform` + `token`。`userId` / `childId` / `active` / `id` **一个都不收**：
 *   前两个来自会话（客户端不许声明自己的上下文），后两个由库给。
 *   `app.setup.ts` 的 `forbidNonWhitelisted` 会把多传的键变成 400。
 *
 * ── 为什么 `token` 不放在路径 / query 里 ────────────────────────────────────
 *   它是**可直接用来推送的凭据**：放在 URL 里会进 access log、浏览器历史、
 *   反向代理日志。所以注销也走 POST body（`POST /device-tokens/revoke`），
 *   不用 `DELETE /device-tokens/:token`。
 *
 * ── 为什么 `@IsIn` 而不是 `@IsEnum(DevicePlatform)` ─────────────────────────
 *   枚举来自 Prisma 生成物；DTO 依赖它会让离线用例也要 `prisma generate` 后的类型
 *   （类型擦除后其实无所谓，但运行期导入会真的 `require('@prisma/client')`）。
 *   `DEVICE_PLATFORMS` 是同一份事实的 TS 形态，且有编译期 + 用例双重对账（见 types 文件头）。
 */
export class RegisterDeviceTokenDto {
  @IsIn([...DEVICE_PLATFORMS])
  platform!: DevicePlatformName

  /** 8–512：太短必是伪造 / 传错，太长是无意义放大（网关也要收得住）。 */
  @IsString()
  @Length(8, 512)
  @Matches(/^\S+$/, { message: 'token 不能包含空白字符（请先 trim 再上报）' })
  token!: string
}

/**
 * `POST /device-tokens/revoke` 的请求体。
 *
 * 与注册同一套约束：同一个值在「写」与「删」两条路上被接受的范围必须一致，
 * 否则会出现「注册得进去、注销不掉」的 token（只能等网关回 410）。
 */
export class RevokeDeviceTokenDto {
  @IsString()
  @Length(8, 512)
  @Matches(/^\S+$/, { message: 'token 不能包含空白字符（请先 trim 再上报）' })
  token!: string
}
