import { IsBoolean, IsDefined } from 'class-validator'

/**
 * `POST /consent` 的请求体（W7-A，2026-10-26）。
 *
 * ── 为什么只有一个布尔值 ────────────────────────────────────────────────────
 *   同意的**内容**（协议版本）由服务端决定（`CONSENT_TEXT_VERSION`），
 *   客户端只能回答「我是否接受」。若允许客户端自报 `consentVersion`，
 *   它能声称「已同意 v9」—— 而 v9 可能根本不存在，或条款更宽松。
 *   合规事实不能由被约束方自行填写。
 *
 * ── 为什么必须是显式的 `true` ───────────────────────────────────────────────
 *   `{}`（空 body）或漏字段时若默认放行，等于「打开页面即同意」。
 *   `@IsDefined()` 让缺字段在管道层 400；`accepted: false` 由 service 判
 *   `CONSENT_NOT_ACCEPTED` —— 两条路径都不会写库。
 *
 * ── 集合封闭 ────────────────────────────────────────────────────────────────
 *   `forbidNonWhitelisted`（`app.setup.ts`）保证传 `childId` / `consentVersion`
 *   一律 400：孩子来自会话，版本来自服务端配置，请求体没有第三个字段的位置。
 */
export class GrantConsentDto {
  @IsDefined()
  @IsBoolean()
  accepted!: boolean
}
