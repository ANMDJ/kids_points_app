import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator'

/**
 * `POST /wishes` 的请求体（W5-B，2026-10-20）。
 *
 * ★ 形状 = 集合封闭（全局 `ValidationPipe` 的 `whitelist + forbidNonWhitelisted`）：
 *   多传 `childId` / `coverStyle` / `redeemed` 一律 400。
 *   - `childId` 来自会话（`x-kp-child-id` 经身份 Guard 校验），**绝不**读请求体；
 *   - `coverStyle` 由服务端按 `pickCoverStyle`（空档优先 / 哈希兜底）算 —— 03 E16：
 *     配色一旦能由客户端指定，就会出现「两个心愿同色」「删项后变色」这些老问题；
 *   - `redeemed` / 余额都不能在「新增」里出现：兑换走 `POST /approvals`（action=`redeem`）。
 *
 * 区间与 `CreateApprovalRequestDto` 的 `add_wish` 字段**逐字对齐**（同一件事的两个入口
 * 不能有两套边界，否则孩子提的申请能被批准，家长直写的却被拒）。
 */
export class CreateWishDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string

  /** 1..100000（与 `snapshotAddWish` 的 `cost` 同区间）。 */
  @IsInt()
  @Min(1)
  @Max(100_000)
  cost!: number

  /** 表情（缺省 `🎁`）；这里的上限只挡「明显不是表情」的超长串。 */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  emoji?: string
}
