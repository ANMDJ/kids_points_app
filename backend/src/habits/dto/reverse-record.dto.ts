import { IsOptional, IsString, MaxLength } from 'class-validator'

/**
 * `POST /records/:id/reverse` 的请求体（撤销打卡，W4-D）。
 *
 * ★ 撤销的**对象**在路径里；身体里只有可选备注。金额/方向由原记录决定，
 *   客户端传什么都不参与计算（多传键 ⇒ 400）。
 */
export class ReverseRecordDto {
  /** 撤销备注（可空）。空串按"不写备注"处理，不落一个空字符串冒充用户输入。 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string
}
