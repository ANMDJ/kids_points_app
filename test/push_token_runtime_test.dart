import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/device_token_api.dart';
import 'package:kids_points_app/data/push_token_lifecycle.dart';
import 'package:kids_points_app/data/push_token_registration.dart';
import 'package:kids_points_app/data/push_token_runtime.dart';

/// W6-F：推送 token 运行时与 Flutter 生命周期接线。
///
/// 守门人目标：
///   · `start()` 立即上报；并发 `start()` 拿到同一个 Future（单飞）；
///   · 恢复前台时按冷却窗口重报，窗口内**一个请求都不发**；
///   · 失败也记录尝试时刻（避免每次切前台都打网络），冷却后允许重试；
///   · `revoke()` 先停用再注销，之后 resume 绝不把 token 登记回去；
///   · `dispose()` 只释放一次，且在途请求结束后才关 HttpClient；
///   · 生命周期只认 `resumed`，暂停 / 后台不碰网络。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('PushTokenRuntime：启动与单飞', () {
    test('start 立即上报，并记录尝试时刻', () async {
      final DateTime now = DateTime.utc(2026, 10, 25, 10);
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRuntime runtime = _runtime(api: api, now: () => now);

      final PushTokenResult result = await runtime.start();

      expect(result.status, PushTokenStatus.registered);
      expect(api.registerCalls, 1);
      expect(runtime.lastAttemptAt, now);
      expect(runtime.isStarted, isTrue);
      expect(runtime.isStopped, isFalse);
    });

    test('并发 start 返回同一个 Future，底层只发一次', () async {
      final Completer<DeviceTokenDto> pending = Completer<DeviceTokenDto>();
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRegister = ((String platform, String token) => pending.future);
      final PushTokenRuntime runtime = _runtime(api: api);

      final Future<PushTokenResult> first = runtime.start();
      final Future<PushTokenResult> second = runtime.start();

      expect(identical(first, second), isTrue);
      await pumpEventQueue();
      expect(api.registerCalls, 1);

      pending.complete(_dto());
      await first;
      await second;
      expect(api.registerCalls, 1);
    });

    test('未 start 时 resume 什么都不做（不偷偷发请求）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRuntime runtime = _runtime(api: api);

      final PushTokenResult? result = await runtime.reportIfDue();

      expect(result, isNull);
      expect(api.registerCalls, 0);
    });
  });

  group('PushTokenRuntime：冷却窗口与 token 轮换', () {
    test('冷却窗口内 resume 不发请求，窗口过后才重报', () async {
      DateTime now = DateTime.utc(2026, 10, 25, 10);
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final _FakeSource source = _FakeSource('fcm-token-123456');
      final PushTokenRuntime runtime = _runtime(
        api: api,
        source: source,
        now: () => now,
      );

      await runtime.start();
      source.token = 'fcm-token-654321';

      now = now.add(const Duration(minutes: 1));
      expect(await runtime.reportIfDue(), isNull);
      expect(api.registerCalls, 1);

      now = now.add(const Duration(minutes: 4));
      final PushTokenResult? result = await runtime.reportIfDue();

      expect(result?.status, PushTokenStatus.registered);
      expect(api.registerCalls, 2);
      expect(api.lastToken, 'fcm-token-654321');
    });

    test('失败也消耗冷却窗口，窗口过后允许重试', () async {
      DateTime now = DateTime.utc(2026, 10, 25, 10);
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      int attempts = 0;
      api.onRegister = ((String platform, String token) async {
        attempts += 1;
        if (attempts == 1) throw Exception('connection refused');
        return _dto(platform: platform);
      });
      final PushTokenRuntime runtime = _runtime(api: api, now: () => now);

      final PushTokenResult first = await runtime.start();
      expect(first.status, PushTokenStatus.failed);

      now = now.add(const Duration(minutes: 1));
      expect(await runtime.reportIfDue(), isNull);
      expect(api.registerCalls, 1);

      now = now.add(const Duration(minutes: 4));
      final PushTokenResult? retry = await runtime.reportIfDue();
      expect(retry?.status, PushTokenStatus.registered);
      expect(api.registerCalls, 2);
    });

    test('时钟被回拨不会把用户永久锁在冷却里', () async {
      DateTime now = DateTime.utc(2026, 10, 25, 10);
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final _FakeSource source = _FakeSource('fcm-token-123456');
      final PushTokenRuntime runtime =
          _runtime(api: api, source: source, now: () => now);

      await runtime.start();
      await pumpEventQueue();
      source.token = 'fcm-token-654321';
      now = now.subtract(const Duration(hours: 1));
      final PushTokenResult? result = await runtime.reportIfDue();

      expect(result?.status, PushTokenStatus.registered);
      expect(api.registerCalls, 2);
    });
  });

  group('PushTokenRuntime：注销与停用', () {
    test('revoke 注销成功，之后 resume 绝不再登记', () async {
      DateTime now = DateTime.utc(2026, 10, 25, 10);
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final _FakeSource source = _FakeSource('fcm-token-123456');
      final PushTokenRuntime runtime = _runtime(
        api: api,
        source: source,
        now: () => now,
      );

      await runtime.start();
      final PushTokenResult revoked = await runtime.revoke();

      expect(revoked.status, PushTokenStatus.revoked);
      expect(api.revokeCalls, 1);
      expect(runtime.isStopped, isTrue);

      source.token = 'fcm-token-654321';
      now = now.add(const Duration(hours: 2));
      expect(await runtime.reportIfDue(), isNull);
      expect(api.registerCalls, 1);
      expect(api.revokeCalls, 1);
    });

    test('revoke 会等在途上报结束，再注销真正登记的 token', () async {
      final Completer<DeviceTokenDto> pending = Completer<DeviceTokenDto>();
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRegister = ((String platform, String token) => pending.future);
      final PushTokenRuntime runtime = _runtime(api: api);

      final Future<PushTokenResult> report = runtime.start();
      final Future<PushTokenResult> revoke = runtime.revoke();

      expect(api.revokeCalls, 0, reason: '在途上报结束前不应注销');
      pending.complete(_dto());
      await report;
      final PushTokenResult result = await revoke;

      expect(result.status, PushTokenStatus.revoked);
      expect(api.revokeCalls, 1);
      expect(api.lastRevokedToken, 'fcm-token-123456');
    });

    test('注销后再次 start 可重新登记（未来登录流程用）', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRuntime runtime = _runtime(api: api);

      await runtime.start();
      await runtime.revoke();
      expect(runtime.isStopped, isTrue);

      final PushTokenResult result = await runtime.start();

      expect(result.status, PushTokenStatus.registered);
      expect(runtime.isStopped, isFalse);
      expect(api.registerCalls, 2);
    });
  });

  group('PushTokenRuntime：释放与异常兜底', () {
    test('dispose 释放 API，之后 start / resume / revoke 都不发请求', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRuntime runtime = _runtime(api: api);

      await runtime.start();
      runtime.dispose();

      expect(runtime.isDisposed, isTrue);
      expect(api.closeCalls, 1);

      expect((await runtime.start()).status, PushTokenStatus.idle);
      expect(await runtime.reportIfDue(), isNull);
      expect((await runtime.revoke()).status, PushTokenStatus.idle);
      expect(api.registerCalls, 1);
      expect(api.revokeCalls, 0);
    });

    test('dispose 幂等：重复调用只 close 一次', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRuntime runtime = _runtime(api: api);

      runtime.dispose();
      runtime.dispose();

      expect(api.closeCalls, 1);
    });

    test('在途上报时 dispose：等请求结束再 close', () async {
      final Completer<DeviceTokenDto> pending = Completer<DeviceTokenDto>();
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi()
        ..onRegister = ((String platform, String token) => pending.future);
      final PushTokenRuntime runtime = _runtime(api: api);

      final Future<PushTokenResult> report = runtime.start();
      runtime.dispose();
      expect(api.closeCalls, 0, reason: '在途请求还没结束，不能先关 HttpClient');

      pending.complete(_dto());
      await report;
      await pumpEventQueue();

      expect(api.closeCalls, 1);
    });

    test('registrar 破坏“永不抛错”契约时，runtime 兜住且日志无 token', () async {
      final List<String> logs = <String>[];
      final _ThrowingRegistrar registrar = _ThrowingRegistrar(
        api: _FakeDeviceTokenApi(),
        source: _FakeSource('fcm-token-123456'),
      );
      final PushTokenRuntime runtime = PushTokenRuntime(
        registrar: registrar,
        log: logs.add,
      );

      final PushTokenResult result = await runtime.start();

      expect(result.status, PushTokenStatus.failed);
      expect(result.message, contains('不影响打卡'));
      expect(result.message, isNot(contains('fcm-token-123456')));
      expect(logs.join('\n'), contains('StateError'));
      expect(logs.join('\n'), isNot(contains('fcm-token-123456')));
      expect(logs.join('\n'), isNot(contains('boom token')));
    });
  });

  group('PushTokenLifecycle：只认 resumed', () {
    test('start 接上 observer 并立即上报；暂停不报，恢复才报', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final _FakeSource source = _FakeSource('fcm-token-123456');
      final PushTokenRuntime runtime = PushTokenRuntime(
        registrar: PushTokenRegistrar(api: api, source: source),
        minReportInterval: Duration.zero,
      );
      final PushTokenLifecycle lifecycle = PushTokenLifecycle(
        runtime: runtime,
        binding: TestWidgetsFlutterBinding.instance,
      );

      lifecycle.start();
      await pumpEventQueue();
      expect(lifecycle.isAttached, isTrue);
      expect(api.registerCalls, 1);

      source.token = 'fcm-token-654321';
      TestWidgetsFlutterBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await pumpEventQueue();
      expect(api.registerCalls, 1);

      TestWidgetsFlutterBinding.instance
          .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await pumpEventQueue();
      expect(api.registerCalls, 2);
      expect(api.lastToken, 'fcm-token-654321');

      lifecycle.dispose();
      expect(lifecycle.isAttached, isFalse);
      expect(api.closeCalls, 1);
    });

    test('重复 start 不会重复接 observer / 重复上报', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRuntime runtime = PushTokenRuntime(
        registrar: PushTokenRegistrar(
          api: api,
          source: _FakeSource('fcm-token-123456'),
        ),
      );
      final PushTokenLifecycle lifecycle = PushTokenLifecycle(
        runtime: runtime,
        binding: TestWidgetsFlutterBinding.instance,
      );

      lifecycle.start();
      lifecycle.start();
      await pumpEventQueue();

      expect(api.registerCalls, 1);

      lifecycle.dispose();
    });

    test('退出登录 revoke 后，resume 不会重新登记', () async {
      final _FakeDeviceTokenApi api = _FakeDeviceTokenApi();
      final PushTokenRuntime runtime = PushTokenRuntime(
        registrar: PushTokenRegistrar(
          api: api,
          source: _FakeSource('fcm-token-123456'),
        ),
        minReportInterval: Duration.zero,
      );
      final PushTokenLifecycle lifecycle = PushTokenLifecycle(
        runtime: runtime,
        binding: TestWidgetsFlutterBinding.instance,
      );

      lifecycle.start();
      await pumpEventQueue();
      final PushTokenResult revoked = await lifecycle.revoke();

      expect(revoked.status, PushTokenStatus.revoked);
      lifecycle.didChangeAppLifecycleState(AppLifecycleState.resumed);
      await pumpEventQueue();
      expect(api.registerCalls, 1);
      expect(api.revokeCalls, 1);

      lifecycle.dispose();
    });
  });
}

PushTokenRuntime _runtime({
  required _FakeDeviceTokenApi api,
  _FakeSource? source,
  DateTime Function()? now,
}) {
  return PushTokenRuntime(
    registrar: PushTokenRegistrar(
      api: api,
      source: source ?? _FakeSource('fcm-token-123456'),
    ),
    clock: now,
  );
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
    lastSeenAt: DateTime.utc(2026, 10, 25, 8),
    createdAt: DateTime.utc(2026, 10, 20, 8),
    revokedAt: revokedAt,
  );
}

class _FakeSource implements PushTokenSource {
  _FakeSource(this.token);

  String? token;
  final String platform = 'android';
  int calls = 0;

  @override
  Future<String?> currentToken() async {
    calls += 1;
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

class _ThrowingRegistrar extends PushTokenRegistrar {
  _ThrowingRegistrar({required super.api, required super.source});

  @override
  Future<PushTokenResult> report() async {
    throw StateError('boom token fcm-token-123456');
  }

  @override
  Future<PushTokenResult> revoke() async {
    throw StateError('boom token fcm-token-123456');
  }
}
