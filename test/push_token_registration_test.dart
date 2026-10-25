import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/device_token_api.dart';
import 'package:kids_points_app/data/push_token_registration.dart';
import 'package:kids_points_app/data/write_api_errors.dart';

/// W6-E：推送 token 上报器（`PushTokenRegistrar`）与配置解析。
///
/// 这些用例是「不会因为推送把 App 弄坏」的守门人：
///   · 没 token / SDK 未就绪 ⇒ `noToken`，**不发请求、不抛错**；
///   · 网络 / 5xx / 401 ⇒ `failed`，下次启动可以再试；
///   · 409 ⇒ `ownedByOther` 且**本次进程内不重试**（重试永远是 409）；
///   · 同一个 token 成功过就不再发（但返回 `registered`，不是假装刚发过）；
///   · 单飞：并发调用只发一次，两个调用者拿到同一个 Future；
///   · 日志与结果里**永远没有 token**。
void main() {
  group('PushTokenConfig', () {
    test('没有 token ⇒ 未启用，但不是配置错误', () {
      final PushTokenConfig config = PushTokenConfig.fromEnvironment(
        token: '',
        platform: '',
        operatingSystem: 'windows',
      );

      expect(config.enabled, isFalse);
      expect(config.validationError, isNull);
      expect(config.toSource(), isNull);
    });

    test('平台可由操作系统推断：android / ios', () {
      final PushTokenConfig android = PushTokenConfig.fromEnvironment(
        token: 'fcm-token-123456',
        operatingSystem: 'android',
        allowEnvironmentToken: true,
      );
      final PushTokenConfig ios = PushTokenConfig.fromEnvironment(
        token: 'apns-token-123456',
        operatingSystem: 'ios',
        allowEnvironmentToken: true,
      );

      expect(android.platform, kPushPlatformAndroid);
      expect(android.isConfigured, isTrue);
      expect(ios.platform, kPushPlatformIos);
      expect(ios.isConfigured, isTrue);
    });

    test('小程序显式给 weapp（操作系统推断不出来）', () {
      final PushTokenConfig config = PushTokenConfig.fromEnvironment(
        token: 'wx-token-123456',
        platform: 'weapp',
        operatingSystem: 'windows',
        allowEnvironmentToken: true,
      );

      expect(config.platform, kPushPlatformWeapp);
      expect(config.isConfigured, isTrue);
    });

    test('无法推断平台 ⇒ 可执行的错误，不当成“没配置”', () {
      final PushTokenConfig config = PushTokenConfig.fromEnvironment(
        token: 'fcm-token-123456',
        platform: '',
        operatingSystem: 'windows',
        allowEnvironmentToken: true,
      );

      expect(config.enabled, isTrue);
      expect(config.validationError, contains('KP_PUSH_PLATFORM'));
      expect(config.toSource(), isNull);
    });

    test('发布构建拒绝编译期 token（避免所有安装抢同一个地址）', () {
      final PushTokenConfig config = PushTokenConfig.fromEnvironment(
        token: 'fcm-token-123456',
        platform: 'android',
        allowEnvironmentToken: false,
      );

      expect(config.enabled, isTrue);
      expect(config.validationError, contains('发布构建'));
      expect(config.toSource(), isNull);
    });

    test('token 太短 / 含空白 ⇒ 配置错误（后端 DTO 同口径）', () {
      final PushTokenConfig short = PushTokenConfig.fromEnvironment(
        token: 'short',
        platform: 'android',
        allowEnvironmentToken: true,
      );
      final PushTokenConfig spaced = PushTokenConfig.fromEnvironment(
        token: 'fcm token 123456',
        platform: 'android',
        allowEnvironmentToken: true,
      );

      expect(short.validationError, contains('8–512'));
      expect(spaced.validationError, contains('空白'));
      expect(short.isConfigured, isFalse);
      expect(spaced.isConfigured, isFalse);
    });

    test('合法配置生成来源，token 原样交给上报器', () async {
      final PushTokenConfig config = PushTokenConfig.fromEnvironment(
        token: '  fcm-token-123456  ',
        platform: 'android',
        allowEnvironmentToken: true,
      );
      final PushTokenSource? source = config.toSource();

      expect(config.token, 'fcm-token-123456');
      expect(source, isNotNull);
      expect(source!.platform, kPushPlatformAndroid);
      expect(await source.currentToken(), 'fcm-token-123456');
    });
  });

  group('PushTokenRegistrar：成功路径', () {
    test('读取 token 后登记：平台 / token 正确，结果不含 token', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final _FakeSource source =
          _FakeSource('  fcm-token-123456  ', platform: 'android');
      final List<String> logs = <String>[];
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: source,
        log: logs.add,
      );

      expect(registrar.status, PushTokenStatus.idle);
      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.registered);
      expect(result.ok, isTrue);
      expect(result.message, contains('android'));
      expect(result.message, isNot(contains('fcm-token')));
      expect(api.registerCalls, 1);
      expect(api.lastPlatform, 'android');
      expect(api.lastToken, 'fcm-token-123456');
      expect(registrar.status, PushTokenStatus.registered);
      expect(registrar.lastRegistered?.platform, 'android');
      expect(logs.join('\n'), isNot(contains('fcm-token')));
    });

    test('本次运行同 token 已成功 ⇒ 不重复请求，但仍回答 registered', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456'),
      );

      final PushTokenResult first = await registrar.report();
      final PushTokenResult second = await registrar.report();

      expect(first.status, PushTokenStatus.registered);
      expect(second.status, PushTokenStatus.registered);
      expect(second.message, contains('未重复请求'));
      expect(second.dto, same(first.dto));
      expect(api.registerCalls, 1);
    });

    test('token 轮换 ⇒ 新 token 会重新登记（去重只针对同一个值）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final _FakeSource source = _FakeSource('fcm-token-123456');
      final PushTokenRegistrar registrar =
          PushTokenRegistrar(api: api, source: source);

      await registrar.report();
      source.token = 'fcm-token-654321';
      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.registered);
      expect(api.registerCalls, 2);
      expect(api.lastToken, 'fcm-token-654321');
    });
  });

  group('PushTokenRegistrar：无 token / 失败隔离', () {
    test('SDK 还没给 token ⇒ noToken，一个请求都不发，也不抛错', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource(null),
      );

      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.noToken);
      expect(result.ok, isFalse);
      expect(result.message, contains('不影响打卡'));
      expect(api.registerCalls, 0);
      expect(registrar.status, PushTokenStatus.noToken);
    });

    test('空白 token 与 null 同义（trim 后为空）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('   '),
      );

      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.noToken);
      expect(api.registerCalls, 0);
    });

    test('token 来源抛错 ⇒ noToken + 日志（不影响启动）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final List<String> logs = <String>[];
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource(null)..error = StateError('messaging not ready'),
        log: logs.add,
      );

      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.noToken);
      expect(api.registerCalls, 0);
      expect(logs.join('\n'), contains('读取推送 token 失败'));
      expect(logs.join('\n'), isNot(contains('messaging not ready')));
    });

    test('来源平台不受支持 ⇒ failed，且不发请求', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456', platform: 'web'),
      );

      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.failed);
      expect(result.message, contains('web'));
      expect(api.registerCalls, 0);
    });

    test('来源平台 getter 抛错 ⇒ failed，而不是把启动打崩', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final List<String> logs = <String>[];
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource(
          'fcm-token-123456',
          platformError: StateError('platform unavailable'),
        ),
        log: logs.add,
      );

      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.failed);
      expect(result.message, contains('不影响打卡'));
      expect(api.registerCalls, 0);
      expect(logs.join('\n'), contains('读取推送平台失败'));
      expect(logs.join('\n'), isNot(contains('platform unavailable')));
    });

    test('409 ⇒ ownedByOther；随后同 token 不再重试，换 token 才重试', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRegister = ((String platform, String token) async {
          if (token == 'fcm-token-123456') {
            throw WriteApiException.fromHttp(
              statusCode: 409,
              body: <String, Object?>{
                'code': 'DEVICE_TOKEN_OWNED_BY_OTHER',
                'message': '这个推送 token 已绑定到另一个账号。',
              },
            );
          }
          return _dto(platform: platform);
        });
      final _FakeSource source = _FakeSource('fcm-token-123456');
      final PushTokenRegistrar registrar =
          PushTokenRegistrar(api: api, source: source);

      final PushTokenResult first = await registrar.report();
      final PushTokenResult second = await registrar.report();

      expect(first.status, PushTokenStatus.ownedByOther);
      expect(first.message, contains('另一个账号'));
      expect(second.status, PushTokenStatus.ownedByOther);
      expect(api.registerCalls, 1, reason: '409 重试永远是 409，本次进程内不再发');

      source.token = 'fcm-token-654321';
      final PushTokenResult rotated = await registrar.report();

      expect(rotated.status, PushTokenStatus.registered);
      expect(api.registerCalls, 2);
    });

    test('网络失败 ⇒ failed，但下次启动仍可重试（不缓存失败）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      int attempts = 0;
      api.onRegister = ((String platform, String token) async {
        attempts += 1;
        if (attempts == 1) {
          throw WriteApiException.network(Exception('connection refused'));
        }
        return _dto(platform: platform);
      });
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456'),
      );

      final PushTokenResult failed = await registrar.report();
      final PushTokenResult retried = await registrar.report();

      expect(failed.status, PushTokenStatus.failed);
      expect(failed.message, contains('连不上'));
      expect(retried.status, PushTokenStatus.registered);
      expect(api.registerCalls, 2);
    });

    test('401 ⇒ failed（错误信息保留 401，方便定位配对问题）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRegister = ((String platform, String token) async {
          throw WriteApiException.fromHttp(
            statusCode: 401,
            body: <String, Object?>{'code': 'UNAUTHENTICATED'},
          );
        });
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456'),
      );

      final PushTokenResult result = await registrar.report();

      expect(result.status, PushTokenStatus.failed);
      expect(result.message, contains('401'));
    });

    test('单飞：并发 report 共用一个 Future，只发一次', () async {
      final Completer<DeviceTokenDto> gate = Completer<DeviceTokenDto>();
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRegister = ((String platform, String token) => gate.future);
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456'),
      );

      final Future<PushTokenResult> first = registrar.report();
      final Future<PushTokenResult> second = registrar.report();
      expect(identical(first, second), isTrue, reason: '同一时刻只能有一个上报在途');

      gate.complete(_dto());
      final List<PushTokenResult> results =
          await Future.wait(<Future<PushTokenResult>>[first, second]);

      expect(results[0].status, PushTokenStatus.registered);
      expect(results[1].status, PushTokenStatus.registered);
      expect(api.registerCalls, 1);
    });
  });

  group('PushTokenRegistrar：注销', () {
    test('注销用“最近登记过的 token”，成功后清空缓存', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final _FakeSource source = _FakeSource('fcm-token-123456');
      final PushTokenRegistrar registrar =
          PushTokenRegistrar(api: api, source: source);

      await registrar.report();
      source.token = 'rotated-token-999999';
      final PushTokenResult result = await registrar.revoke();

      expect(result.status, PushTokenStatus.revoked);
      expect(result.ok, isTrue);
      expect(api.revokeCalls, 1);
      expect(api.lastRevokedToken, 'fcm-token-123456');
      expect(registrar.lastRegistered, isNull);
    });

    test('404 ⇒ 按已注销处理（目标已达成，不制造可重试的失败）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRevoke = ((String token) async {
          throw WriteApiException.fromHttp(
            statusCode: 404,
            body: <String, Object?>{
              'code': 'DEVICE_TOKEN_NOT_FOUND',
              'message': '这个推送 token 不在本账号下。',
            },
          );
        });
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456'),
      );

      final PushTokenResult result = await registrar.revoke();

      expect(result.status, PushTokenStatus.revoked);
      expect(result.message, contains('本来就不在本账号下'));
    });

    test('没有 token ⇒ noToken，不发请求', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource(null),
      );

      final PushTokenResult result = await registrar.revoke();

      expect(result.status, PushTokenStatus.noToken);
      expect(api.revokeCalls, 0);
    });

    test('close 透传给 API（释放 HttpClient）', () {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456'),
      );

      registrar.close();

      expect(api.closeCalls, 1);
    });
  });

  group('日志安全', () {
    test('409 的日志与结果里都不出现 token 明文', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRegister = ((String platform, String token) async {
          throw WriteApiException.fromHttp(
            statusCode: 409,
            body: <String, Object?>{
              'code': 'DEVICE_TOKEN_OWNED_BY_OTHER',
              'message': '这个推送 token 已绑定到另一个账号。',
            },
          );
        });
      final List<String> logs = <String>[];
      final PushTokenRegistrar registrar = PushTokenRegistrar(
        api: api,
        source: _FakeSource('fcm-token-123456'),
        log: logs.add,
      );

      final PushTokenResult result = await registrar.report();

      expect(logs, isNotEmpty);
      expect(logs.join('\n'), isNot(contains('fcm-token-123456')));
      expect(result.message, isNot(contains('fcm-token-123456')));
      expect(result.dto, isNull);
    });
  });
}

DeviceTokenDto _dto({
  String platform = 'android',
  bool active = true,
  DateTime? revokedAt,
}) {
  return DeviceTokenDto(
    id: 'token-row-1',
    platform: platform,
    active: active,
    lastSeenAt: DateTime.utc(2026, 10, 24, 8),
    createdAt: DateTime.utc(2026, 10, 20, 8),
    revokedAt: revokedAt,
  );
}

class _FakeSource implements PushTokenSource {
  _FakeSource(this.token, {String platform = 'android', this.platformError})
      : _platform = platform;

  String? token;
  int calls = 0;
  Object? error;
  Object? platformError;
  final String _platform;

  @override
  String get platform {
    final Object? failure = platformError;
    if (failure != null) throw failure;
    return _platform;
  }

  @override
  Future<String?> currentToken() async {
    calls += 1;
    final Object? failure = error;
    if (failure != null) throw failure;
    return token;
  }
}

class _FakeDeviceTokenApi implements DeviceTokenApi {
  Future<DeviceTokenDto> Function(String platform, String token)? onRegister;
  Future<DeviceTokenDto> Function(String token)? onRevoke;

  int registerCalls = 0;
  int revokeCalls = 0;
  int closeCalls = 0;
  String? lastPlatform;
  String? lastToken;
  String? lastRevokedToken;

  @override
  Future<DeviceTokenDto> register({
    required String platform,
    required String token,
  }) {
    registerCalls += 1;
    lastPlatform = platform;
    lastToken = token;
    final handler = onRegister;
    if (handler != null) return handler(platform, token);
    return Future<DeviceTokenDto>.value(_dto(platform: platform));
  }

  @override
  Future<DeviceTokenDto> revoke({required String token}) {
    revokeCalls += 1;
    lastRevokedToken = token;
    final handler = onRevoke;
    if (handler != null) return handler(token);
    return Future<DeviceTokenDto>.value(
      _dto(active: false, revokedAt: DateTime.utc(2026, 10, 25, 9, 30)),
    );
  }

  @override
  void close() {
    closeCalls += 1;
  }
}
