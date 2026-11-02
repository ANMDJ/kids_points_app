import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /public/registration-invites` 的请求体（W12，2026-11-02）。
 *
 * ── 为什么两个字段都必填 ────────────────────────────────────────────────────
 *   码绑定的就是这一对标识：注册时必须用其中**任意一个**（`phone` 或
 *   `email`）才能使用它。只收手机号会让「邮箱用户」没有第二个可核对的凭据，
 *   只收邮箱同理 —— 两者都收，才能覆盖 App 与小程序两种注册习惯。
 *
 * ── 为什么这里不校验格式 ────────────────────────────────────────────────────
 *   手机号/邮箱的规范化与校验只有一份（`account-identifier.ts`）。
 *   DTO 只拦「不是字符串 / 太长」，格式判定在 service —— 否则
 *   「网站说要 11 位、注册页说别输空格」会变成两份规则。
 */
export class CreateRegistrationInviteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  phone!: string

  @IsString()
  @MinLength(1)
  @MaxLength(254)
  email!: string
}
