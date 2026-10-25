import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/device_token_api.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';

/// W6-E：`POST /device-tokens` / `POST /device-tokens/revoke` 的客户端契约。
///
/// 这些用例钉住：
///   ① 路径 / body / 身份头**逐字节**正确，且**没有** `Idempotency-Key`
///      （后端两条路由是构造幂等，重放缓存只会制造假成功）；
///   ② 409 `DEVICE_TOKEN_OWNED_BY_OTHER` / 404 `DEVICE_TOKEN_NOT_FOUND`
///      必须把**机器码**保住 —— 上报器靠它决定「永不重试」还是「按已注销处理」；
///   ③ 回包严格解析：`active` 与 `revokedAt` 一旦不自洽就失败，不猜。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> tokenJson({
    String id = 'token-row-1',
    String platform = 'android',
    bool active = true,
    String? revokedAt,
  }) {
    return <String, Object?>{
      'id': id,
      'platform': platform,
      'active': active,
      'lastSeenAt': '2026-10-24T08:00:00.000Z',
      'createdAt': '2026-10-20T08:00:00.000Z',
      'revokedAt': revokedAt,
    };
  }

  group('DeviceTokenDto 严格解析', () {
    test('注册回包：时间解析、active=true、revokedAt 必须为 null', () {
      final DeviceTokenDto dto = DeviceTokenDto.fromJson(tokenJson());

      expect(dto.id, 'token-row-1');
      expect(dto.platform, kPushPlatformAndroid);
      expect(dto.active, isTrue);
      expect(dto.revokedAt, isNull);
      expect(
          dto.lastSeenAt.toUtc().toIso8601String(), '2026-10-24T08:00:00.000Z');
    });

    test('已注销行：active=false 且 revokedAt 有值', () {
      final DeviceTokenDto dto = DeviceTokenDto.fromJson(tokenJson(
        active: false,
        revokedAt: '2026-10-25T09:30:00.000Z',
      ));

      expect(dto.active, isFalse);
      expect(
          dto.revokedAt?.toUtc().toIso8601String(), '2026-10-25T09:30:00.000Z');
    });

    test('未知平台直接失败（与后端 DEVICE_PLATFORMS 对账）', () {
      expect(
        () => DeviceTokenDto.fromJson(tokenJson(platform: 'harmony')),
        throwsA(isA<Exception>()),
      );
    });

    test('active=true 却带 revokedAt ⇒ 契约漂移，不猜', () {
      expect(
        () => DeviceTokenDto.fromJson(
          tokenJson(revokedAt: '2026-10-25T09:30:00.000Z'),
        ),
        throwsA(isA<Exception>()),
      );
    });

    test('active=false 却没有 revokedAt ⇒ 契约漂移', () {
      expect(
        () => DeviceTokenDto.fromJson(tokenJson(active: false)),
        throwsA(isA<Exception>()),
      );
    });
  });

  group('注册请求', () {
    test('POST /device-tokens：路径 / body / 身份头正确，且不带幂等键', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => _jsonResponse(200, tokenJson()),
      );
      final DeviceTokenApiClient api =
          DeviceTokenApiClient(config: config, transport: transport);

      final DeviceTokenDto dto =
          await api.register(platform: 'android', token: 'fcm-token-123456');

      expect(dto.platform, 'android');
      expect(transport.calls, hasLength(1));
      final Call call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.toString(), 'http://127.0.0.1:3999/api/device-tokens');
      expect(call.headers[kDeviceIdHeader], 'device-1');
      expect(call.headers[kChildIdHeader], 'child-1');
      expect(call.headers[HttpHeaders.contentTypeHeader],
          'application/json; charset=utf-8');
      expect(call.headers.containsKey('idempotency-key'), isFalse);
      expect(jsonDecode(call.body), <String, Object?>{
        'platform': 'android',
        'token': 'fcm-token-123456',
      });
    });

    test('平台与 token 的首尾空白先 trim 再发（后端 DTO 会拒空白）', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => _jsonResponse(200, tokenJson(platform: 'ios')),
      );
      final DeviceTokenApiClient api =
          DeviceTokenApiClient(config: config, transport: transport);

      await api.register(platform: ' ios ', token: '  apns-token-123456  ');

      expect(jsonDecode(transport.calls.single.body), <String, Object?>{
        'platform': 'ios',
        'token': 'apns-token-123456',
      });
    });

    test('非法平台 / 过短 token / 含空白 token ⇒ 本地拒绝，一个请求都不发', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => _jsonResponse(200, tokenJson()),
      );
      final DeviceTokenApiClient api =
          DeviceTokenApiClient(config: config, transport: transport);

      await expectLater(
        api.register(platform: 'web', token: 'fcm-token-123456'),
        throwsArgumentError,
      );
      await expectLater(
        api.register(platform: 'android', token: 'short'),
        throwsArgumentError,
      );
      await expectLater(
        api.register(platform: 'android', token: 'fcm token 123456'),
        throwsA(
          isA<ArgumentError>().having(
            (ArgumentError error) => error.toString(),
            'message',
            isNot(contains('fcm token 123456')),
          ),
        ),
        reason: '异常对象一旦被上层日志打印，不能把 token 带出去',
      );
      expect(transport.calls, isEmpty);
    });

    test('后端配置不完整 ⇒ CLIENT_NOT_CONFIGURED，绝不发一个必 401 的请求', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => _jsonResponse(200, tokenJson()),
      );
      final DeviceTokenApiClient api = DeviceTokenApiClient(
        config: const ReadApiConfig(
          baseUrl: 'http://127.0.0.1:3999/api',
          deviceId: 'device-1',
          childId: '',
        ),
        transport: transport,
      );

      await expectLater(
        api.register(platform: 'android', token: 'fcm-token-123456'),
        throwsA(
          isA<WriteApiException>()
              .having((WriteApiException e) => e.code, 'code',
                  'CLIENT_NOT_CONFIGURED')
              .having(
                  (WriteApiException e) => e.statusCode, 'statusCode', isNull),
        ),
      );
      expect(transport.calls, isEmpty);
    });
  });

  group('DTO 时间', () {
    test('不是 ISO-8601 ⇒ 失败（不把坏时间当 now）', () {
      final Map<String, Object?> json = tokenJson();
      json['lastSeenAt'] = '昨天';
      expect(
        () => DeviceTokenDto.fromJson(json),
        throwsA(isA<Exception>()),
      );
    });
  });

  group('服务端拒绝', () {
    test('409 OWNED_BY_OTHER ⇒ conflict + 保留机器码', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => _jsonResponse(409, <String, Object?>{
          'code': 'DEVICE_TOKEN_OWNED_BY_OTHER',
          'message': '这个推送 token 已绑定到另一个账号。',
        }),
      );
      final DeviceTokenApiClient api =
          DeviceTokenApiClient(config: config, transport: transport);

      await expectLater(
        api.register(platform: 'android', token: 'fcm-token-123456'),
        throwsA(
          isA<WriteApiException>()
              .having((WriteApiException e) => e.kind, 'kind',
                  WriteFailureKind.conflict)
              .having((WriteApiException e) => e.code, 'code',
                  'DEVICE_TOKEN_OWNED_BY_OTHER')
              .having((WriteApiException e) => e.statusCode, 'statusCode', 409),
        ),
      );
    });

    test('404 NOT_FOUND ⇒ notFound + 保留机器码（上报器按已注销处理）', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => _jsonResponse(404, <String, Object?>{
          'code': 'DEVICE_TOKEN_NOT_FOUND',
          'message': '这个推送 token 不在本账号下。',
        }),
      );
      final DeviceTokenApiClient api =
          DeviceTokenApiClient(config: config, transport: transport);

      await expectLater(
        api.revoke(token: 'fcm-token-123456'),
        throwsA(
          isA<WriteApiException>()
              .having((WriteApiException e) => e.kind, 'kind',
                  WriteFailureKind.notFound)
              .having((WriteApiException e) => e.code, 'code',
                  'DEVICE_TOKEN_NOT_FOUND')
              .having((WriteApiException e) => e.statusCode, 'statusCode', 404),
        ),
      );
    });

    test('200 但 body 不是 JSON / 形状不对 ⇒ malformed，不伪造成功', () async {
      for (final String body in <String>[
        '',
        'not-json',
        jsonEncode(<String, Object?>{'id': 'x'}),
        // 回包里出现 token 本身并不能救命：缺字段仍然是坏回包。
        jsonEncode(<String, Object?>{'token': 'fcm-token-123456'}),
      ]) {
        final _RecordingTransport transport = _RecordingTransport(
          (Call call) async => WriteHttpResponse(statusCode: 200, body: body),
        );
        final DeviceTokenApiClient api =
            DeviceTokenApiClient(config: config, transport: transport);

        await expectLater(
          api.register(platform: 'android', token: 'fcm-token-123456'),
          throwsA(
            isA<WriteApiException>().having((WriteApiException e) => e.kind,
                'kind', WriteFailureKind.malformed),
          ),
          reason: 'body=$body',
        );
      }
    });
  });

  group('网络异常', () {
    test('超时 ⇒ timeout（默认 10 秒可注入缩短）', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) => Future<WriteHttpResponse>.delayed(
          const Duration(milliseconds: 80),
          () => _jsonResponse(200, tokenJson()),
        ),
      );
      final DeviceTokenApiClient api = DeviceTokenApiClient(
        config: config,
        transport: transport,
        timeout: const Duration(milliseconds: 10),
      );

      await expectLater(
        api.register(platform: 'android', token: 'fcm-token-123456'),
        throwsA(
          isA<WriteApiException>()
              .having((WriteApiException e) => e.kind, 'kind',
                  WriteFailureKind.timeout)
              .having((WriteApiException e) => e.code, 'code', 'TIMEOUT'),
        ),
      );
    });

    test('SocketException ⇒ network（不是 malformed）', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => throw const SocketException('connection refused'),
      );
      final DeviceTokenApiClient api =
          DeviceTokenApiClient(config: config, transport: transport);

      await expectLater(
        api.register(platform: 'android', token: 'fcm-token-123456'),
        throwsA(
          isA<WriteApiException>()
              .having((WriteApiException e) => e.kind, 'kind',
                  WriteFailureKind.network)
              .having((WriteApiException e) => e.code, 'code', 'NETWORK_ERROR'),
        ),
      );
    });
  });

  group('注销请求', () {
    test('POST /device-tokens/revoke：token 只在 body 里（不进 URL）', () async {
      final _RecordingTransport transport = _RecordingTransport(
        (Call call) async => _jsonResponse(
          200,
          tokenJson(active: false, revokedAt: '2026-10-25T09:30:00.000Z'),
        ),
      );
      final DeviceTokenApiClient api =
          DeviceTokenApiClient(config: config, transport: transport);

      final DeviceTokenDto dto = await api.revoke(token: 'fcm-token-123456');

      expect(dto.active, isFalse);
      final Call call = transport.calls.single;
      expect(call.uri.toString(),
          'http://127.0.0.1:3999/api/device-tokens/revoke');
      expect(call.uri.toString(), isNot(contains('fcm-token')));
      expect(jsonDecode(call.body),
          <String, Object?>{'token': 'fcm-token-123456'});
    });
  });
}

WriteHttpResponse _jsonResponse(int statusCode, Object? body) =>
    WriteHttpResponse(statusCode: statusCode, body: jsonEncode(body));

class Call {
  Call(this.method, this.uri, this.headers, this.body);

  final String method;
  final Uri uri;
  final Map<String, String> headers;
  final String body;
}

class _RecordingTransport implements WriteTransport {
  _RecordingTransport(this.handler);

  final Future<WriteHttpResponse> Function(Call call) handler;
  final List<Call> calls = <Call>[];

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) {
    final Call call =
        Call(method, uri, Map<String, String>.from(headers), body);
    calls.add(call);
    return handler(call);
  }

  @override
  void close() {}
}
