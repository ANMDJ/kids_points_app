/// 写端点（W4-E：打卡 / 撤销）的**失败分类**。
///
/// 与只读错误分开，是因为同一个 HTTP 状态码在两边的语义不同：
///   404 在只读里是「孩子不存在」，在写里更常见的是 `HABIT_NOT_FOUND` /
///   `RECORD_NOT_FOUND`；409 在只读里不会出现，在写里却是**主要**的业务拒绝
///   （已达每日上限、积分不足、已经撤销过）。
///
/// 页面只展示 [userMessage]，不按状态码另编文案 —— 这样后端新增业务码时，
/// 客户端不会把「今天已经完成 2 次」说成「网络错误」。
enum WriteFailureKind {
  /// 401：设备头缺失 / 会话不存在 / 已过期
  unauthenticated,

  /// 403：会话有效，但角色或成员关系不允许这次写
  forbidden,

  /// 404：习惯 / 流水 / 孩子不存在（或跨孩子，后端故意同样回答）
  notFound,

  /// 400：请求形状不被接受（含多传字段）
  badRequest,

  /// 409：业务拒绝（每日上限、积分不足、重复撤销……）
  conflict,

  /// 503：身份/成员依赖未就绪
  unavailable,

  /// 其它 5xx
  server,

  /// 连不上 / 连接被拒 / DNS 失败
  network,

  /// 超时
  timeout,

  /// 2xx 但 JSON 形状不符合契约
  malformed,
}

/// 写端点的统一异常：**永远**带一个可直接展示的中文说明。
class WriteApiException implements Exception {
  WriteApiException(
    this.kind,
    this.userMessage, {
    this.statusCode,
    this.code,
    this.detail,
  });

  factory WriteApiException.malformed(String path, {String? detail}) =>
      WriteApiException(
        WriteFailureKind.malformed,
        '服务器返回的写入结果不符合约定（字段 `$path`）。请确认客户端与服务端版本一致。',
        code: 'MALFORMED_RESPONSE',
        detail: detail,
      );

  factory WriteApiException.network(Object error) => WriteApiException(
        WriteFailureKind.network,
        '连不上服务器，这次操作没有保存。请检查网络后重试。',
        code: 'NETWORK_ERROR',
        detail: error.toString(),
      );

  factory WriteApiException.timeout(Duration timeout) => WriteApiException(
        WriteFailureKind.timeout,
        '请求超时（${timeout.inSeconds} 秒），这次操作可能未保存。请刷新确认后再试。',
        code: 'TIMEOUT',
      );

  /// 把 `!2xx` 响应翻译成异常。
  ///
  /// 业务码优先于状态码：`HABIT_DAILY_LIMIT_REACHED` 比「HTTP 409」对用户有用。
  /// 但解析失败时**绝不丢状态码**（诊断需要它）。
  factory WriteApiException.fromHttp({
    required int statusCode,
    required Object? body,
  }) {
    String? code;
    String? detail;
    if (body is Map) {
      final Object? rawCode = body['code'];
      if (rawCode is String && rawCode.isNotEmpty) code = rawCode;
      final Object? rawMessage = body['message'] ?? body['error'];
      if (rawMessage is String) {
        detail = rawMessage;
      } else if (rawMessage is List) {
        detail = rawMessage.whereType<String>().join('；');
      }
    }

    WriteApiException fail(WriteFailureKind kind, String message) =>
        WriteApiException(
          kind,
          message,
          statusCode: statusCode,
          code: code,
          detail: detail,
        );

    if (statusCode == 401) {
      return fail(
        WriteFailureKind.unauthenticated,
        '设备身份无效或会话不存在（401），这次操作没有保存。请重新配对设备后再试。',
      );
    }
    if (statusCode == 403) {
      return fail(
        WriteFailureKind.forbidden,
        '当前账号没有执行这个操作的权限（403），这次操作没有保存。',
      );
    }
    if (statusCode == 404) {
      if (code == 'HABIT_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这个习惯不存在或已被删除，无法打卡。',
        );
      }
      if (code == 'RECORD_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这条打卡记录不存在或已被删除，无法撤销。',
        );
      }
      if (code == 'RULE_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这条规则不存在或已被删除（可能已在别的设备上删掉了）。',
        );
      }
      return fail(
        WriteFailureKind.notFound,
        '要操作的数据不存在或已被删除（404），这次操作没有保存。',
      );
    }
    if (statusCode == 400) {
      return fail(
        WriteFailureKind.badRequest,
        '请求参数不被服务端接受（400），这次操作没有保存。',
      );
    }
    if (statusCode == 409) {
      switch (code) {
        case 'HABIT_DAILY_LIMIT_REACHED':
          return fail(
            WriteFailureKind.conflict,
            '这个习惯今天的次数已经用完啦，明天继续加油～',
          );
        case 'INSUFFICIENT_POINTS':
          return fail(
            WriteFailureKind.conflict,
            '积分不足，无法撤销这笔打卡（撤销不能把余额扣成负数）。',
          );
        case 'ALREADY_REVERSED':
          return fail(
            WriteFailureKind.conflict,
            '这笔打卡已经撤销过了，不需要重复撤销。',
          );
        case 'NOT_A_HABIT_CHECK_IN':
        case 'CANNOT_REVERSE_REVERSAL':
          return fail(
            WriteFailureKind.conflict,
            '这笔记录不是可撤销的打卡记录。',
          );
        case 'HABIT_POINTS_INVALID':
          return fail(
            WriteFailureKind.conflict,
            '这个习惯的分值配置不正确，暂时不能打卡。',
          );
        case 'RULE_VERSION_CONFLICT':
          return fail(
            WriteFailureKind.conflict,
            '这条规则刚被其他人改动过，请刷新后再改（不会覆盖别人的修改）。',
          );
        case 'RULE_IS_PENALTY':
          return fail(
            WriteFailureKind.conflict,
            '这是扣分规则，不能加入今天的习惯。',
          );
        case 'HABIT_ALREADY_EXISTS':
          return fail(
            WriteFailureKind.conflict,
            '这个习惯已经在今天的习惯里了。',
          );
      }
      return fail(
        WriteFailureKind.conflict,
        '当前状态不允许这个操作（409），这次操作没有保存。',
      );
    }
    if (statusCode == 503) {
      return fail(
        WriteFailureKind.unavailable,
        '服务端身份校验未就绪（503），这次操作没有保存。请稍后重试。',
      );
    }
    return fail(
      statusCode >= 500 ? WriteFailureKind.server : WriteFailureKind.badRequest,
      '服务端返回 HTTP $statusCode，这次操作没有保存。请稍后重试。',
    );
  }

  final WriteFailureKind kind;
  final String userMessage;
  final int? statusCode;
  final String? code;
  final String? detail;

  /// 重试**可能**有用：网络、超时、5xx。
  /// 409 是明确的业务拒绝，原样重试只会再被拒一次。
  bool get isRetryable =>
      kind == WriteFailureKind.network ||
      kind == WriteFailureKind.timeout ||
      kind == WriteFailureKind.server ||
      kind == WriteFailureKind.unavailable;

  @override
  String toString() {
    final String status = statusCode == null ? '' : ' http=$statusCode';
    final String serverCode = code == null ? '' : ' code=$code';
    final String extra = detail == null ? '' : ' detail=$detail';
    return 'WriteApiException(${kind.name}$status$serverCode): $userMessage$extra';
  }
}
