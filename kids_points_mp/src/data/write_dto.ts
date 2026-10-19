import { RecordDto, readObject } from './read_dto'
import { ReadApiException } from './read_api_errors'
import { WriteApiException } from './write_api_errors'

/**
 * `POST /records/check-in` 与 `POST /records/:id/reverse` 的 201 响应线格式。
 *
 * `executedRecordId` 是**本次真正写下**的那条流水（撤销时是冲正记录）。
 * 它必须与 `record.id` 一致；不一致说明契约漂移，宁可显式失败，
 * 也不能拿一个无法对账的 id 去更新界面。
 */
export class WrittenRecordDto {
  constructor(
    readonly record: RecordDto,
    readonly executedRecordId: string
  ) {}

  static fromJson(raw: unknown, path = '$'): WrittenRecordDto {
    const json = readObject(raw, path)
    let record: RecordDto
    try {
      record = RecordDto.fromJson(json.record, `${path}.record`)
    } catch (error) {
      // 读取层的严格解析失败也必须归一到写异常，页面只处理一种错误类型。
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed(
          `${path}.record`,
          error.detail ?? undefined
        )
      }
      throw error
    }
    const rawExecutedRecordId = json.executedRecordId
    if (typeof rawExecutedRecordId !== 'string') {
      throw WriteApiException.malformed(
        `${path}.executedRecordId`,
        `期望字符串，实际 ${typeof rawExecutedRecordId}`
      )
    }
    const executedRecordId = rawExecutedRecordId
    if (executedRecordId === '') {
      throw WriteApiException.malformed(
        `${path}.executedRecordId`,
        'executedRecordId 不能为空'
      )
    }
    if (executedRecordId !== record.id) {
      throw WriteApiException.malformed(
        `${path}.executedRecordId`,
        `executedRecordId=${executedRecordId} 与 record.id=${record.id} 不一致`
      )
    }
    return new WrittenRecordDto(record, executedRecordId)
  }
}
