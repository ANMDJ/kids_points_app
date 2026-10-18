/// 只读 API 的**失败分类** —— 页面据此决定「能重试 / 该改配置 / 别重试」。
///
/// ★ 与后端契约一一对应（`backend/src/read/read.controller.ts` 的注释）：
///   401 没身份、403 非成员、404 孩子不存在或已删、400 形状不对、
///   501 没接数据库、503 身份校验未就绪、5xx 其它服务端问题。
///   客户端的职责是**如实显示**，不是把 501 说成「暂无记录」（那正是 D3 那类假象）。
enum ReadFailureKind {
  /// 401：设备头缺失 / 会话不存在 / 已过期
  unauthenticated,

  /// 403：会话有效，但不是这个孩子的成员
  forbidden,

  /// 404：孩子不存在或已软删
  childNotFound,

  /// 400：查询参数不被接受（含 `INVALID_RECORD_CURSOR`）
  badRequest,

  /// 501：后端没有数据库，只读端点诚实拒绝
  notImplemented,

  /// 503：身份/成员依赖未就绪
  unavailable,

  /// 其它 5xx
  server,

  /// 连不上 / 连接被拒 / DNS 失败
  network,

  /// 超时
  timeout,

  /// 200 但 JSON 形状不符合契约
  malformed,
}

/// 只读 API 的统一异常。**永远带得上**一个可展示的中文说明，
/// 页面不需要（也不允许）自己按状态码另编一套文案。
class ReadApiException implements Exception {
  ReadApiException(
    this.kind,
    this.userMessage, {
    this.statusCode,
    this.code,
    this.detail,
  });

  /// 200 但形状不对：由 DTO / 映射层抛出，`path` 指出哪个字段坏了。
  factory ReadApiException.malformed(String path, {String? detail}) =>
      ReadApiException(
        ReadFailureKind.malformed,
        '服务器返回的数据不符合约定（字段 `$path`）。请确认客户端与服务端版本一致。',
        code: 'MALFORMED_RESPONSE',
        detail: detail,
      );

  factory ReadApiException.network(Object error) => ReadApiException(
        ReadFailureKind.network,
        '连不上服务器。请检查网络，或确认 KP_API_BASE_URL 指向正在运行的后端。',
        code: 'NETWORK_ERROR',
        detail: error.toString(),
      );

  factory ReadApiException.timeout(Duration timeout) => ReadApiException(
        ReadFailureKind.timeout,
        '请求超时（${timeout.inSeconds} 秒）。请稍后重试。',
        code: 'TIMEOUT',
      );

  /// 把 `!2xx` 的响应翻译成异常。错误体尽量解析，但**绝不**因解析失败而丢状态码。
  factory ReadApiException.fromHttp({
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

    if (statusCode == 401) {
      return ReadApiException(
        ReadFailureKind.unauthenticated,
        '设备身份无效或会话不存在（401）。请重新配对设备后再试。',
        statusCode: statusCode,
        code: code,
        detail: detail,
      );
    }
    if (statusCode == 403) {
      return ReadApiException(
        ReadFailureKind.forbidden,
        '当前账号没有查看这个孩子数据的权限（403）。',
        statusCode: statusCode,
        code: code,
        detail: detail,
      );
    }
    if (statusCode == 404) {
      return ReadApiException(
        ReadFailureKind.childNotFound,
        '孩子档案不存在或已被删除（404）。',
        statusCode: statusCode,
        code: code,
        detail: detail,
      );
    }
    if (statusCode == 400) {
      return ReadApiException(
        ReadFailureKind.badRequest,
        '请求参数不被服务端接受（400）。',
        statusCode: statusCode,
        code: code,
        detail: detail,
      );
    }
    if (statusCode == 501) {
      return ReadApiException(
        ReadFailureKind.notImplemented,
        '服务端还没有接数据库，只读查询暂不可用（501）。这不是「没有记录」。',
        statusCode: statusCode,
        code: code,
        detail: detail,
      );
    }
    if (statusCode == 503) {
      return ReadApiException(
        ReadFailureKind.unavailable,
        '服务端身份校验未就绪（503）。请稍后重试。',
        statusCode: statusCode,
        code: code,
        detail: detail,
      );
    }
    return ReadApiException(
      statusCode >= 500 ? ReadFailureKind.server : ReadFailureKind.badRequest,
      '服务端返回 HTTP $statusCode。请稍后重试。',
      statusCode: statusCode,
      code: code,
      detail: detail,
    );
  }

  final ReadFailureKind kind;

  /// 给人看的中文说明（页面直接显示）。
  final String userMessage;

  /// HTTP 状态码；网络 / 解析失败时为 null。
  final int? statusCode;

  /// 后端错误码（如 `INVALID_RECORD_CURSOR`）；网络 / 解析失败时为本地码。
  final String? code;

  /// 服务端原始说明，仅用于诊断，不当作主文案。
  final String? detail;

  /// 一次性重试**可能**有用：网络、超时、5xx（含 501 配好库之后）。
  bool get isRetryable =>
      kind == ReadFailureKind.network ||
      kind == ReadFailureKind.timeout ||
      kind == ReadFailureKind.server ||
      kind == ReadFailureKind.unavailable ||
      kind == ReadFailureKind.notImplemented;

  @override
  String toString() {
    final String status = statusCode == null ? '' : ' http=$statusCode';
    final String serverCode = code == null ? '' : ' code=$code';
    final String extra = detail == null ? '' : ' detail=$detail';
    return 'ReadApiException(${kind.name}$status$serverCode): $userMessage$extra';
  }
}
