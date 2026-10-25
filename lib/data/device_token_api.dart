import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'read_api_errors.dart';
import 'read_dto.dart';
import 'write_api.dart'
    show IoWriteTransport, WriteHttpResponse, WriteTransport;
import 'write_api_errors.dart';

/// 推送 token 的平台集合 —— 与后端 `DEVICE_PLATFORMS`
/// （`backend/src/device-tokens/device-tokens.types.ts`）以及 Prisma
/// `enum DevicePlatform` **逐一对应**。
///
/// 为什么在这里再抄一份：客户端的 DTO 需要在校验前就知道合法集合，
/// 不能依赖后端把错误留到 HTTP 409 / 400 才说。服务端两份由
/// `backend/test/device-tokens.test.ts` 对账；客户端这一端不引入 Prisma / Taro，
/// 因此由本文件用例对账（`test/device_token_api_test.dart`）。
const Set<String> kDeviceTokenPlatforms = <String>{
  'ios',
  'android',
  'weapp',
};

/// 微信小程序（订阅消息 / 网关侧可寻址 token）。
const String kPushPlatformWeapp = 'weapp';
const String kPushPlatformIos = 'ios';
const String kPushPlatformAndroid = 'android';

/// `POST /device-tokens` / `POST /device-tokens/revoke` 的响应（W6-A）。
///
/// **后端刻意不回显 `token`**：它是可直接用来推送的凭据，回显只会让它出现在
/// 日志 / 截图 / 崩溃上报里。因此这里也没有 `token` 字段 —— 如果有人以为
/// “响应里应该带 token”而加回来，用例会先红。
class DeviceTokenDto {
  DeviceTokenDto({
    required this.id,
    required this.platform,
    required this.active,
    required this.lastSeenAt,
    required this.createdAt,
    required this.revokedAt,
  });

  factory DeviceTokenDto.fromJson(Object? raw, [String path = r'$']) {
    final Map<String, Object?> json = readObject(raw, path);
    final String platform = readString(json, 'platform', '$path.platform');
    if (!kDeviceTokenPlatforms.contains(platform)) {
      throw ReadApiException.malformed(
        '$path.platform',
        detail: '未知平台 `$platform`（允许 ${kDeviceTokenPlatforms.join(' / ')}）',
      );
    }

    final bool active = readBool(json, 'active', '$path.active');
    final DateTime? revokedAt =
        readOptionalDate(json, 'revokedAt', '$path.revokedAt');

    // 后端契约：`active=false` 时 `revokedAt` 必有值，注册回包恒为 null。
    // 两边不一致说明状态已经漂移，宁可显式失败，也不要在界面上猜。
    if (active && revokedAt != null) {
      throw ReadApiException.malformed(
        '$path.revokedAt',
        detail: 'active=true 但 revokedAt 非空',
      );
    }
    if (!active && revokedAt == null) {
      throw ReadApiException.malformed(
        '$path.revokedAt',
        detail: 'active=false 但 revokedAt 为空',
      );
    }

    return DeviceTokenDto(
      id: readString(json, 'id', '$path.id'),
      platform: platform,
      active: active,
      lastSeenAt: readDate(json, 'lastSeenAt', '$path.lastSeenAt'),
      createdAt: readDate(json, 'createdAt', '$path.createdAt'),
      revokedAt: revokedAt,
    );
  }

  final String id;
  final String platform;
  final bool active;
  final DateTime lastSeenAt;
  final DateTime createdAt;
  final DateTime? revokedAt;
}

/// 设备推送 token 的两条写入口（W6-E）。
///
/// 单独一个接口，**不塞进 `WriteApi`**：
///   ① `WriteApi` 的每个方法都代表一次“家庭业务写入”，失败会改变页面数据；
///      token 上报失败只影响推送，**不得**影响打卡 / 登录 / 首页刷新；
///   ② 现有测试里有多个 `implements WriteApi` 的替身，往接口里加方法会让它们
///      全部编译失败，而它们与推送毫无关系；
///   ③ 推送 token 的生命周期（前台启动时上报、注销时撤销）与业务写入不同，
///      混在一起后，“谁在什么时候重试”会变得无法回答。
abstract class DeviceTokenApi {
  /// 登记 / 刷新。构造幂等：同一 token 重复上报只刷新 `lastSeenAt`。
  Future<DeviceTokenDto> register({
    required String platform,
    required String token,
  });

  /// 注销。构造幂等：已注销仍 200；不是本账号的 token 回 404。
  Future<DeviceTokenDto> revoke({required String token});

  void close() {}
}

/// `POST /device-tokens` / `POST /device-tokens/revoke` 的 HTTP 客户端。
///
/// 身份头与只读端完全一致（设备 id + 孩子 id）；真正的授权仍由后端三道屏障
/// 判定。**没有 `Idempotency-Key`**：后端两条路由都是构造幂等，重放一个缓存结果
/// 只会引入“缓存说成功、库里没有”的中间态（见 `device-tokens.controller.ts`）。
class DeviceTokenApiClient implements DeviceTokenApi {
  DeviceTokenApiClient({
    required this.config,
    WriteTransport? transport,
    this.timeout = const Duration(seconds: 10),
  }) : _transport = transport ?? IoWriteTransport(connectionTimeout: timeout);

  final ReadApiConfig config;
  final Duration timeout;
  final WriteTransport _transport;

  @override
  Future<DeviceTokenDto> register({
    required String platform,
    required String token,
  }) async {
    final String name = platform.trim();
    if (!kDeviceTokenPlatforms.contains(name)) {
      throw ArgumentError.value(
        platform,
        'platform',
        '必须是 ${kDeviceTokenPlatforms.join(' / ')} 之一',
      );
    }
    final String value = _requireToken(token);
    final Object? decoded = await _send(
      '/device-tokens',
      <String, Object?>{'platform': name, 'token': value},
    );
    return _parse(decoded);
  }

  @override
  Future<DeviceTokenDto> revoke({required String token}) async {
    final String value = _requireToken(token);
    final Object? decoded = await _send(
      '/device-tokens/revoke',
      <String, Object?>{'token': value},
    );
    return _parse(decoded);
  }

  @override
  void close() => _transport.close();

  /// 与后端 DTO 同口径：8–512、不含空白。**先 trim 再判** ——
  /// 复制粘贴常带首尾空格，把空格发过去只会换回一个 400。
  String _requireToken(String token) {
    final String value = token.trim();
    if (value.length < 8 || value.length > 512) {
      // 不把 token 放进异常（`ArgumentError.value` 会把它带进 message）：
      // 这个对象一旦被上层日志打印，token 就进了日志。
      throw ArgumentError('token 长度必须在 8–512 之间（后端 DTO 同口径）');
    }
    if (RegExp(r'\s').hasMatch(value)) {
      throw ArgumentError('token 不能包含空白字符');
    }
    return value;
  }

  DeviceTokenDto _parse(Object? decoded) {
    try {
      return DeviceTokenDto.fromJson(decoded);
    } on ReadApiException catch (error) {
      // 页面只处理写异常一种类型；读 DTO 的严格解析失败在这里归一。
      throw WriteApiException.malformed(
        r'$',
        detail: error.detail ?? error.userMessage,
      );
    }
  }

  Future<Object?> _send(String path, Map<String, Object?> body) async {
    final String? configError = config.validationError;
    if (configError != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final Uri uri = config.uri(path);
    final Map<String, String> headers = <String, String>{
      HttpHeaders.acceptHeader: 'application/json',
      HttpHeaders.contentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
    };

    final WriteHttpResponse response;
    try {
      response = await _transport
          .send(uri, headers, jsonEncode(body))
          .timeout(timeout);
    } on TimeoutException {
      throw WriteApiException.timeout(timeout);
    } on IOException catch (error) {
      throw WriteApiException.network(error);
    }

    Object? decoded;
    if (response.body.trim().isNotEmpty) {
      try {
        decoded = jsonDecode(response.body);
      } on FormatException {
        decoded = null;
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw WriteApiException.fromHttp(
        statusCode: response.statusCode,
        body: decoded,
      );
    }
    if (decoded == null) {
      throw WriteApiException.malformed(
        r'$',
        detail: 'HTTP ${response.statusCode} 但响应体为空',
      );
    }
    return decoded;
  }
}
