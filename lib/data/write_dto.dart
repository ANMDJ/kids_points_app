import 'read_dto.dart';
import 'read_api_errors.dart';
import 'write_api_errors.dart';

/// `POST /records/check-in` 与 `POST /records/:id/reverse` 的 201 响应。
///
/// 线格式：
/// ```json
/// { "record": { ...与 GET /records 的行同构... }, "executedRecordId": "..." }
/// ```
///
/// `executedRecordId` 是**本次真正写下**的那条流水（撤销时是冲正记录）。
/// 它与 `record.id` 必须一致；不一致说明服务端契约漂移，客户端宁可显式失败，
/// 也不能拿一个无法对账的 id 去更新界面。
class WrittenRecordDto {
  WrittenRecordDto({
    required this.record,
    required this.executedRecordId,
  });

  factory WrittenRecordDto.fromJson(Object? raw, [String path = r'$']) {
    final Map<String, Object?> json = readObject(raw, path);
    final RecordDto record;
    try {
      record = RecordDto.fromJson(json['record'], '$path.record');
    } on ReadApiException catch (error) {
      // 读取层的严格解析失败也必须归一到写异常，页面只处理一种错误类型。
      throw WriteApiException.malformed(
        '$path.record',
        detail: error.detail ?? error.userMessage,
      );
    }
    final Object? rawExecutedRecordId = json['executedRecordId'];
    if (rawExecutedRecordId is! String) {
      throw WriteApiException.malformed(
        '$path.executedRecordId',
        detail: '期望字符串，实际 ${rawExecutedRecordId.runtimeType}',
      );
    }
    final String executedRecordId = rawExecutedRecordId;
    if (executedRecordId.isEmpty) {
      throw WriteApiException.malformed(
        '$path.executedRecordId',
        detail: 'executedRecordId 不能为空',
      );
    }
    if (executedRecordId != record.id) {
      throw WriteApiException.malformed(
        '$path.executedRecordId',
        detail:
            'executedRecordId=$executedRecordId 与 record.id=${record.id} 不一致',
      );
    }
    return WrittenRecordDto(
      record: record,
      executedRecordId: executedRecordId,
    );
  }

  final RecordDto record;

  /// 本次真正写下的流水 id（与 [record] 的 id 相同）。
  final String executedRecordId;
}
