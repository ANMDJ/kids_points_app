import { Type } from 'class-transformer'
import { IsBoolean, IsEnum, IsOptional, ValidateNested } from 'class-validator'
import { RelationKind } from '@prisma/client'

/**
 * 同意块 —— **只有一个字段**（W9-A / `40` §7.3）。
 *
 * ★ 版本号不在这里：`consentVersion` 由服务端 `CONSENT_TEXT_VERSION` 给出，
 *   客户端**不能自报**（自报版本号 = 自己决定"我同意的是哪一版"）。
 * ★ 用 `class` 而不是 `interface`：嵌套对象必须能被 `ValidationPipe` 校验
 *   （`ValidateNested` 依赖 `design:paramtypes`，见 `app.setup.ts` 的说明）。
 */
export class BootstrapConsentDto {
  /**
   * 必须**字面 `true`**。
   *
   * ⚠️ `IsBoolean` 只保证"是布尔"，不保证"是 true" —— 真正的判定在
   *   `IdentityService.bootstrapChild()`（缺 / `false` 一律 400 `CONSENT_NOT_ACCEPTED`，
   *   与 W7-D 的 `{confirmed:true}` 同一口径）。放在 service 而不是 DTO，
   *   是为了让"没同意"的错误码只有一处来源。
   */
  @IsBoolean()
  accepted!: boolean
}

/**
 * `POST /children` 的请求体（W9-A，2026-10-29 / `40` §7.3）。
 *
 * ── 为什么**没有** `childName` ───────────────────────────────────────────────
 *   "同意必须早于采集昵称"（`04` §5）。一次请求里既勾选又填名字，仍然是
 *   "先采集后征求"（只是差了几十毫秒）。故本请求体只承载**同意**：
 *   服务端建一个叫 `'宝贝'` 的占位档案，真正的名字走下一步 `PATCH /child`。
 *   ⇒ 这条路由的 body 里**一个儿童个人信息都没有**。
 */
export class BootstrapChildDto {
  @ValidateNested()
  @Type(() => BootstrapConsentDto)
  consent!: BootstrapConsentDto

  /**
   * 监护关系（`father` / `mother` / `grandparent` / `other`），缺省 `other`。
   *
   * ★ 它与成员位**不是**同一件事（02 §1）：关系只是记录，权限看成员位。
   * ★ `IsEnum(RelationKind)` 与 `npm run relation:check` 同源：枚举是三处手抄的那份，
   *   多一个值会在这里静默通过校验、却在库里炸 —— 故直接复用生成的枚举。
   */
  @IsOptional()
  @IsEnum(RelationKind)
  relation?: RelationKind
}
