import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/session_scope.dart';

/// W10-B / P0-1：运行期身份（设备 id / 孩子 id）的用例。
///
/// ── 这里钉的四件事 ─────────────────────────────────────────────────────────
///   ① 设备 id 首启生成、**跨进程复用**（同一个 store 的第二个 scope 拿到同一个值）；
///   ② 存储里的坏值 ⇒ 重新生成，绝不把非法字符送进 HTTP 头；
///   ③ 换账号**只清孩子**、不清设备（后端会话行键含 deviceId）；
///   ④ 没有 childId 时业务客户端**一个请求都不发**（验收判据）。
void main() {
  group('设备 id 生成与形状', () {
    test('kp-dev- + 24 位十六进制，且通过后端字符集校验', () {
      final String id = generateDeviceId(Random(7));
      expect(id.startsWith(kGeneratedDeviceIdPrefix), isTrue);
      expect(id.length, kGeneratedDeviceIdPrefix.length + 24);
      expect(isValidDeviceId(id), isTrue);
      expect(RegExp(r'^[A-Za-z0-9._:-]+$').hasMatch(id), isTrue);
    });

    test('★ 中文 / 空格 / 超长都拒（HTTP 头按 latin-1 传输）', () {
      expect(isValidDeviceId('dev-中文'), isFalse);
      expect(isValidDeviceId('dev 1'), isFalse);
      expect(isValidDeviceId(''), isFalse);
      expect(isValidDeviceId('a' * (128 + 1)), isFalse);
      expect(isValidDeviceId('a' * 128), isTrue);
    });
  });

  group('SessionScope.restore：持久化与复用', () {
    test('首次生成并写回；同一 store 的第二个 scope 复用同一个设备 id', () async {
      final MemorySessionStore store = MemorySessionStore();
      final SessionScope first =
          SessionScope(store: store, random: Random(1), initialDeviceId: null);
      await first.restore();
      final String? device = first.deviceId;
      expect(device, isNotNull);
      expect(isValidDeviceId(device!), isTrue);

      final SessionScope second =
          SessionScope(store: store, random: Random(999));
      await second.restore();
      expect(second.deviceId, device);
      expect(second.childId, isNull);
    });

    test('存储里是坏值 ⇒ 丢弃并重新生成（不抛）', () async {
      final MemorySessionStore store = MemorySessionStore(
        const SessionSnapshot(deviceId: 'dev 坏'),
      );
      final SessionScope scope = SessionScope(store: store, random: Random(3));
      await scope.restore();
      expect(scope.deviceId, isNotNull);
      expect(scope.deviceId, isNot('dev 坏'));
      expect(isValidDeviceId(scope.deviceId!), isTrue);
    });
  });

  group('SessionScope：账号切换与孩子上下文', () {
    test('beginAccount 清孩子但保留设备 id', () async {
      final MemorySessionStore store = MemorySessionStore(
        const SessionSnapshot(
          deviceId: 'kp-dev-aaaaaaaaaaaaaaaaaaaaaaaa',
          childId: 'child-old',
          role: 'guardian',
        ),
      );
      final SessionScope scope = SessionScope(store: store);
      await scope.restore();
      expect(scope.childId, 'child-old');

      await scope.beginAccount();
      expect(scope.deviceId, 'kp-dev-aaaaaaaaaaaaaaaaaaaaaaaa');
      expect(scope.childId, isNull);
      expect(scope.role, isNull);
      final SessionSnapshot? saved = await store.read();
      expect(saved?.childId, isNull);
    });

    test('adoptChild 立即持久化；clearChild 只清孩子', () async {
      final MemorySessionStore store = MemorySessionStore();
      final SessionScope scope = SessionScope(store: store, random: Random(5));
      await scope.restore();
      await scope.adoptChild(childId: 'child-1', role: 'guardian');

      final SessionSnapshot? saved = await store.read();
      expect(saved?.childId, 'child-1');
      expect(saved?.role, 'guardian');
      expect(saved?.deviceId, scope.deviceId);

      await scope.clearChild();
      expect(scope.childId, isNull);
      expect(scope.deviceId, isNotNull);
    });
  });

  group('ReadApiConfig：身份是运行期动态取值', () {
    test('登录前 hasBaseUrl=true 但 validationError 指出没有孩子', () async {
      final SessionScope scope =
          SessionScope(store: MemorySessionStore(), random: Random(11));
      await scope.restore();
      final ReadApiConfig config = ReadApiConfig(
        baseUrl: 'http://127.0.0.1:3000',
        session: scope,
      );

      expect(config.hasBaseUrl, isTrue);
      expect(config.isConfigured, isFalse);
      expect(config.transportValidationError, isNull);
      expect(config.validationError, contains('还没有进入任何一个孩子'));

      await scope.adoptChild(childId: 'child-1', role: 'guardian');
      expect(config.childId, 'child-1');
      expect(config.isConfigured, isTrue);
      expect(config.validationError, isNull);
    });

    test('★ 没有 childId ⇒ 业务客户端不发请求（哪怕 baseUrl 配好了）', () async {
      final SessionScope scope =
          SessionScope(store: MemorySessionStore(), random: Random(13));
      await scope.restore();
      final _CountingTransport transport = _CountingTransport();
      final ReadApiClient client = ReadApiClient(
        config: ReadApiConfig(
          baseUrl: 'http://127.0.0.1:3000',
          session: scope,
        ),
        transport: transport,
      );

      await expectLater(
        client.fetchHome(),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.code,
          'code',
          'CLIENT_NOT_CONFIGURED',
        )),
      );
      expect(transport.calls, 0, reason: '没有孩子上下文时不该发任何请求');
    });
  });
}

class _CountingTransport implements ReadTransport {
  int calls = 0;

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    calls += 1;
    return ReadHttpResponse(statusCode: 200, body: '{}');
  }

  @override
  void close() {}
}
