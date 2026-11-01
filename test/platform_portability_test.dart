import 'package:flutter_test/flutter_test.dart';

import 'package:kids_points_app/data/device_token_api.dart';
import 'package:kids_points_app/data/http_transport.dart';
import 'package:kids_points_app/data/operating_system.dart';
import 'package:kids_points_app/data/push_token_registration.dart';
import 'package:kids_points_app/data/token_store.dart';

/// W10-A：平台条件导入的**三处接缝**（token 存储 / 操作系统名 / HTTP 传输层）。
///
/// ── 为什么这些用例要在两个平台上都跑 ───────────────────────────────────────
///   Web 支持没有第二套业务代码，只有 `if (dart.library.js_interop)` 在编译期
///   换实现：`token_store_default.dart` / `operating_system.dart` /
///   `http_transport.dart`。条件导入的失败方式是**静默选错文件** ——
///   VM 上一切正常，浏览器里一启动就崩（`dart:io` 不可用）。
///   ⇒ 这里只断言"接缝的另一侧是可用的"，不绑定具体实现类名：
///     · `flutter test`                     → `FileTokenStore` + `IoReadTransport`；
///     · `flutter test --platform chrome`   → `LocalStorageTokenStore` + XHR。
///   两边断言一字不差，任何一侧选错实现都会红。
///
/// ★ 本文件**不得** import `dart:io`：那样 `--platform chrome` 直接编不过，
///   这几条用例就永远证明不了"Web 能用"。
void main() {
  /// 合法 token：`kps_` + 精确 43 位 base64url（与后端 `TOKEN_BODY_LENGTH` 同口径）。
  const String validToken =
      'kps_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

  group('token 形状（与后端逐字一致）', () {
    test('43 位 base64url 才合法；少一位 / 多一位 / 带填充都不行', () {
      expect(isValidToken(validToken), isTrue);
      expect(isValidToken('kps_'), isFalse, reason: '只有前缀');
      expect(isValidToken(validToken.substring(0, 46)), isFalse, reason: '少一位');
      expect(isValidToken('${validToken}A'), isFalse, reason: '多一位');
      expect(isValidToken('${validToken.substring(0, 46)}+'), isFalse,
          reason: 'base64url 没有 `+`');
      expect(isValidToken('KP_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'),
          isFalse,
          reason: '前缀大小写不同就是另一个值');
    });
  });

  group('默认 token 存储：这一平台上真的能读回来', () {
    late TokenStore store;

    setUp(() => store = createDefaultTokenStore());
    tearDown(() => store.clear());

    test('写入 → 读回 → 清除（读不回来就是"存了等于没存"）', () async {
      await store.clear();
      expect(await store.read(), isNull, reason: '起点必须是干净的');

      await store.write(validToken);
      expect(await store.read(), validToken);

      await store.clear();
      expect(await store.read(), isNull);
    });

    test('坏形状写不进去：抛 ArgumentError，而不是静默成功', () async {
      await expectLater(
        store.write('not-a-kp-token'),
        throwsA(isA<ArgumentError>()),
      );
      expect(await store.read(), isNull, reason: '拒写之后存储里不能留下东西');
    });

    test('AuthTokenHolder：adopt 之后换一个 holder 仍然读得到（模拟重启）',
        () async {
      await store.clear();
      final AuthTokenHolder first = AuthTokenHolder(store: store);
      await first.adopt(validToken);
      expect(first.hasToken, isTrue);
      first.dispose();

      // 新 holder 复用同一份存储 = 进程重启后 `restore()` 的路径。
      final AuthTokenHolder second = AuthTokenHolder(store: store);
      addTearDown(second.dispose);
      expect(await second.restore(), validToken);
      expect(second.signedIn.value, isTrue);
    });

    test('AuthTokenHolder：存储里有坏值 ⇒ 当成没登录（不带着坏 token 去请求）',
        () async {
      await store.clear();
      // 绕过 `write` 的形状校验，直接往存储里塞垃圾：模拟被别的东西写坏。
      final MemoryTokenStore broken = MemoryTokenStore('kps_short');
      final AuthTokenHolder holder = AuthTokenHolder(store: broken);
      addTearDown(holder.dispose);

      expect(await holder.restore(), isNull);
      expect(holder.hasToken, isFalse);
      expect(holder.signedIn.value, isFalse);
    });
  });

  group('默认 HTTP 传输层：连不上时抛 Exception（不是 Error、不是裸崩）', () {
    // 65500 不在 Chrome 的受限端口表里 —— 否则测到的是 `ERR_UNSAFE_PORT`，
    // 而不是"服务器没起来"这条真实路径。
    final Uri unreachable = Uri.parse('http://127.0.0.1:65500/health');
    const Duration shortTimeout = Duration(seconds: 2);

    test('只读传输层', () async {
      final ReadTransport transport = createReadTransport(
        connectionTimeout: shortTimeout,
      );
      addTearDown(transport.close);

      await expectLater(
        transport.send(unreachable, const <String, String>{
          kAcceptHeader: 'application/json',
        }),
        throwsA(isA<Exception>()),
      );
    });

    test('写传输层', () async {
      final WriteTransport transport = createWriteTransport(
        connectionTimeout: shortTimeout,
      );
      addTearDown(transport.close);

      await expectLater(
        transport.send(
          unreachable,
          const <String, String>{
            kAcceptHeader: 'application/json',
            kContentTypeHeader: 'application/json; charset=utf-8',
          },
          '{"ping":true}',
        ),
        throwsA(isA<Exception>()),
      );
    });
  });

  group('操作系统名', () {
    test('非空', () {
      expect(currentOperatingSystem().trim(), isNotEmpty);
    });

    test('推送平台只认 android / ios：web 不许冒充（否则会登记一条假地址）', () {
      // 纯映射用例：与运行平台无关，但钉住"浏览器上的 web 不能被猜成 android"。
      expect(pushPlatformForOperatingSystem('web'), isNull);
      expect(pushPlatformForOperatingSystem(''), isNull);

      final String? mapped =
          pushPlatformForOperatingSystem(currentOperatingSystem());
      expect(
        mapped == null ||
            mapped == kPushPlatformAndroid ||
            mapped == kPushPlatformIos,
        isTrue,
        reason: '映射结果只能是这两个平台或明确拒绝（实际：$mapped）',
      );
    });
  });
}
