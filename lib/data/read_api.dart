import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'read_api_errors.dart';
import 'read_dto.dart';

/// 设备身份的**两个请求头** —— 与后端 Guard 的常量必须一致
/// （`backend/src/device-session/device-session.guard.ts` 的 `DEVICE_ID_HEADER` /
/// `CHILD_ID_HEADER`）。
///
/// `childId` 只是「会话要作用在哪个孩子上」，**不是**授权凭据：
/// 后端会用会话行反查，对不上就 500/403。因此客户端改这个头不会串到别人家。
const String kDeviceIdHeader = 'x-kp-device-id';
const String kChildIdHeader = 'x-kp-child-id';

/// 只读 API 的连接配置。
///
/// 配置来源**只有** `--dart-define`（不读本地存储、不读系统环境变量）：
/// 设备身份是配对流程产出的凭据，不能由用户随手在界面上填。
///
/// ```bash
/// flutter run \
///   --dart-define=KP_API_BASE_URL=http://127.0.0.1:3000 \
///   --dart-define=KP_DEVICE_ID=<seed 里的设备 id> \
///   --dart-define=KP_CHILD_ID=<孩子 id>
/// ```
class ReadApiConfig {
  const ReadApiConfig({
    required this.baseUrl,
    required this.deviceId,
    required this.childId,
  });

  /// 从编译期常量读取；未传时为空串（页面据此进入**预览数据**模式）。
  factory ReadApiConfig.fromEnvironment() => const ReadApiConfig(
        baseUrl: String.fromEnvironment('KP_API_BASE_URL'),
        deviceId: String.fromEnvironment('KP_DEVICE_ID'),
        childId: String.fromEnvironment('KP_CHILD_ID'),
      );

  final String baseUrl;
  final String deviceId;
  final String childId;

  /// 三项都齐才接后端 —— 少一项就退回预览数据，**绝不**发一个会 401 的请求
  /// 然后把 401 说成「网络错误」。
  bool get isConfigured => validationError == null;

  /// 配置不完整时的**可执行**说明；完整时为 null。
  String? get validationError {
    final String base = baseUrl.trim();
    if (base.isEmpty) {
      return '未配置 KP_API_BASE_URL：现在显示的是本地预览数据。\n'
          '接后端请用 --dart-define=KP_API_BASE_URL=http://127.0.0.1:3000。';
    }
    final Uri? parsed = Uri.tryParse(base);
    if (parsed == null ||
        !(parsed.scheme == 'http' || parsed.scheme == 'https') ||
        parsed.host.isEmpty) {
      return 'KP_API_BASE_URL 不是合法的 http(s) 地址：$base。';
    }
    if (deviceId.trim().isEmpty) {
      return '未配置 KP_DEVICE_ID：请求需要设备身份（401 之前就拦下）。';
    }
    if (childId.trim().isEmpty) {
      return '未配置 KP_CHILD_ID：请求必须指明操作哪个孩子。';
    }
    return null;
  }

  /// 拼出请求地址：`baseUrl` 的尾斜杠与 `path` 的首斜杠都不会重复。
  Uri uri(String path, [Map<String, String>? query]) {
    final Uri base = Uri.parse(baseUrl.trim());
    final String basePath = base.path.endsWith('/')
        ? base.path.substring(0, base.path.length - 1)
        : base.path;
    final String suffix = path.startsWith('/') ? path : '/$path';
    final Uri combined = base.replace(path: '$basePath$suffix');
    return combined.replace(
      queryParameters: query == null || query.isEmpty ? null : query,
    );
  }
}

/// 传输层的一行响应 —— 测试替身只需要造这个，不必起真的 HTTP 服务。
class ReadHttpResponse {
  ReadHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

/// 传输层接口（GET 专用）。默认实现是 [IoReadTransport]。
abstract class ReadTransport {
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers);

  void close() {}
}

/// 基于 `dart:io HttpClient` 的最小实现：无第三方依赖，桌面/移动都能跑。
class IoReadTransport implements ReadTransport {
  IoReadTransport({Duration connectionTimeout = const Duration(seconds: 10)})
      : _client = HttpClient()..connectionTimeout = connectionTimeout;

  final HttpClient _client;

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    final HttpClientRequest request = await _client.getUrl(uri);
    headers.forEach(request.headers.set);
    final HttpClientResponse response = await request.close();
    final String body = await utf8.decoder.bind(response).join();
    return ReadHttpResponse(statusCode: response.statusCode, body: body);
  }

  @override
  void close() => _client.close(force: true);
}

/// `GET /home` 与 `GET /records` 的客户端。
///
/// 只读：没有任何写方法 —— W4-B 的范围就是「读端先真起来」。
class ReadApiClient {
  ReadApiClient({
    required this.config,
    ReadTransport? transport,
    this.timeout = const Duration(seconds: 10),
  }) : _transport = transport ?? IoReadTransport(connectionTimeout: timeout);

  final ReadApiConfig config;
  final Duration timeout;
  final ReadTransport _transport;

  Future<HomeDto> fetchHome() async {
    return HomeDto.fromJson(await _get('/home'));
  }

  /// `GET /trash`：回收站里被软删的规则 / 心愿 / 习惯（W5-F）。
  ///
  /// 孩子也能看（矩阵 `view_trash` child ALLOW）——「我删掉的那张卡去哪了」
  /// 是他最需要自己确认的事；恢复 / 彻底删除仍然只有家长能做（服务端 403）。
  ///
  /// 不分页：后端会一次性返回整个回收站（低频、小集合）。
  Future<TrashListDto> fetchTrash() async {
    return TrashListDto.fromJson(await _get('/trash'));
  }

  /// `GET /members`：当前孩子的**活跃**成员位（W5-H）。
  ///
  /// 孩子也能看（矩阵 `view_members` child ALLOW）：列表只含昵称 / 角色 /
  /// 时间，不含手机号、`openId`、PIN。**不分页** —— 单孩子量小，被移出的人
  /// 不会出现在列表里（只能在审计里看到）。
  ///
  /// 写入口（改角色 / 移出）在 `WriteApi` 上；谁能对谁做什么由服务端判定，
  /// 响应里**没有** `canChangeRole` / `canRemove` 这类结论字段。
  Future<MemberListDto> fetchMembers() async {
    return MemberListDto.fromJson(await _get('/members'));
  }

  /// `GET /invites`：当前孩子的邀请码（W5-I，`view_invites` 仅家长 ALLOW）。
  ///
  /// 返回的是**凭据本身**（`code`），所以孩子身份请求会被服务端 403；
  /// 客户端据此不要在孩子视角里调它（见 `InviteSheet` 的角色闸门）。
  ///
  /// 列表含已用完 / 已过期 / 已吊销的行 —— 状态由界面按事实现算，
  /// 服务端不删行（否则「我上周发的码怎么没了」无法解释）。
  Future<InviteListDto> fetchInvites() async {
    return InviteListDto.fromJson(await _get('/invites'));
  }

  /// 第一页传 `cursor: null`；之后把响应里的 [RecordsPageDto.nextCursor]
  /// **原样**传回来。游标不是 offset，客户端不许自己拼。
  Future<RecordsPageDto> fetchRecords({
    String? category,
    int limit = 50,
    String? cursor,
  }) async {
    if (limit < 1 || limit > 200) {
      throw ArgumentError.value(limit, 'limit', '必须在 1–200 之间（后端 DTO 同口径）');
    }
    final Map<String, String> query = <String, String>{'limit': '$limit'};
    if (category != null) query['category'] = category;
    if (cursor != null && cursor.isNotEmpty) query['cursor'] = cursor;

    return RecordsPageDto.fromJson(await _get('/records', query));
  }

  /// `GET /approvals`：家长审批收件箱（W5-D）。
  ///
  /// [status] 只能取 `pending` / `approved` / `rejected` / `withdrawn` /
  /// `invalidated` / `expired` / `all`（后端 DTO 的枚举同口径）；**不收**客户端
  /// 自造的过滤词 —— 猜错只会拿到 400，不如在这里直接报错。
  /// 第一页传 `cursor: null`，之后把 [ApprovalsPageDto.nextCursor] 原样带回。
  Future<ApprovalsPageDto> fetchApprovals({
    String status = 'pending',
    int limit = 20,
    String? cursor,
  }) {
    return _fetchApprovalPage(
      '/approvals',
      status: status,
      limit: limit,
      cursor: cursor,
    );
  }

  /// `GET /approvals/mine`：**我提交的**申请（W5-J）。
  ///
  /// 与 [fetchApprovals] 的差别只有路径与权限语义：
  ///   · 收件箱 = 「待我批准」（`review_approvals`，孩子 403）；
  ///   · 这里 = 「我提过什么」（`view_own_approvals`，两个角色都 ALLOW）。
  /// 服务端按**会话身份**收口申请人，客户端没有任何参数可以指定「看谁的」。
  ///
  /// 筛选词 / 分页规则与收件箱完全相同（同一个后端 DTO 与游标解析器）。
  Future<ApprovalsPageDto> fetchMyApprovals({
    String status = 'all',
    int limit = 20,
    String? cursor,
  }) {
    return _fetchApprovalPage(
      '/approvals/mine',
      status: status,
      limit: limit,
      cursor: cursor,
    );
  }

  Future<ApprovalsPageDto> _fetchApprovalPage(
    String path, {
    required String status,
    required int limit,
    required String? cursor,
  }) async {
    const Set<String> allowed = <String>{
      'pending',
      'approved',
      'rejected',
      'withdrawn',
      'invalidated',
      'expired',
      'all',
    };
    if (!allowed.contains(status)) {
      throw ArgumentError.value(status, 'status', '不在后端允许的状态列表里');
    }
    if (limit < 1 || limit > 100) {
      throw ArgumentError.value(limit, 'limit', '必须在 1–100 之间（后端 DTO 同口径）');
    }
    final Map<String, String> query = <String, String>{
      'status': status,
      'limit': '$limit',
    };
    if (cursor != null && cursor.isNotEmpty) query['cursor'] = cursor;

    return ApprovalsPageDto.fromJson(await _get(path, query));
  }

  Future<Object?> _get(String path, [Map<String, String>? query]) async {
    final String? configError = config.validationError;
    if (configError != null) {
      throw ReadApiException(
        ReadFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final Uri uri = config.uri(path, query);
    final Map<String, String> headers = <String, String>{
      HttpHeaders.acceptHeader: 'application/json',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
    };

    final ReadHttpResponse response;
    try {
      response = await _transport.send(uri, headers).timeout(timeout);
    } on TimeoutException {
      throw ReadApiException.timeout(timeout);
    } on IOException catch (error) {
      throw ReadApiException.network(error);
    }

    Object? body;
    if (response.body.trim().isNotEmpty) {
      try {
        body = jsonDecode(response.body);
      } on FormatException {
        body = null;
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ReadApiException.fromHttp(
          statusCode: response.statusCode, body: body);
    }
    if (body == null) {
      throw ReadApiException.malformed(r'$',
          detail: 'HTTP ${response.statusCode} 但响应体为空');
    }
    return body;
  }

  void close() => _transport.close();
}
