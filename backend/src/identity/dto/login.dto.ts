import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /auth/login` 的请求体（W9-A，2026-10-29 / `40` §8.1）。
 *
 * ── 为什么只有一个字段，且**没有** deviceId / role / userId ────────────────────
 *   身份**只**来自微信签发的一次性 `code`（`<code2session>` 换 openId）。
 *   设备标识走**请求头** `x-kp-device-id`（它只进审计，不是凭据），
 *   角色与 userId 由服务端会话行给出 —— 放进 body 就是给了客户端一条提权入口。
 *   集合封闭（`forbidNonWhitelisted`）保证 `{ code, userId:'u-dad' }` ⇒ 400。
 *
 * ── 上限 128 的依据 ─────────────────────────────────────────────────────────
 *   微信的 `js_code` 是 32 字符左右；128 只防超长 payload（DoS 的第一步是
 *   让服务端把一段 1MB 的字符串转发给微信）。真正的有效性由微信判定（40029）。
 */
export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  code!: string
}
