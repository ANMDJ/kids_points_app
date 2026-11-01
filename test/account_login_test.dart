import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kids_points_app/data/auth_api.dart';
import 'package:kids_points_app/data/auth_dto.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/token_store.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/screens/account_gate.dart';
import 'package:kids_points_app/screens/login_screen.dart';

/// W9-D：App 账号登录的客户端用例（2026-10-30 / `docs/design/42-account-login-design.md`）。
///
/// ── 这里钉的五件事 ─────────────────────────────────────────────────────────
///   ① token 形状（`kps_` + 43 位 base64url）与后端**逐字一致**——
///      差一位，客户端就会把一个必然 401 的值写进文件；
///   ② **坏文件 = 没有 token**（不是"带着坏值去请求"）；
///   ③ 闸门的三态：没配后端 ⇒ 放行 / 有 token ⇒ 放行 / 无 token ⇒ 登录页；
///   ④ 登录失败时**停在登录页**并显示服务端那句话（不假装成功）；
///   ⑤ `AccountInfo` 的自相矛盾（三个字段全空）必须 `malformed`。
/// 合法的 token：`kps_` + **精确 43 位** base64url（26 小写 + 17 大写）。
/// ★ 43 这个数字与后端 `TOKEN_BODY_LENGTH` 是同一口径；写长了会静默变成"形状错"。
const String _validToken =
    'kps_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

const ReadApiConfig _configured = ReadApiConfig(
  baseUrl: 'http://127.0.0.1:3000',
  deviceId: 'dev-1',
  childId: 'child-1',
);

const ReadApiConfig _unconfigured = ReadApiConfig(
  baseUrl: '',
  deviceId: '',
  childId: '',
);

/// `AuthApi` 的替身：只记录入参，按需成功/失败。
class _FakeAuthApi implements AuthApi {
  _FakeAuthApi({this.failure, this.holder});

  /// 非 null ⇒ 登录抛 [WriteApiException]（模拟 401 密码错）。
  final String? failure;

  /// ★ 真实的 `AuthApiClient` 在登录成功后会 `holder.adopt(token)`；
  ///   替身必须照做，否则"token 已写进 holder"这条断言测的是替身的缺陷。
  final AuthTokenHolder? holder;

  String? seenIdentifier;
  String? seenPassword;
  int calls = 0;

  @override
  Future<AuthLoginResult> loginAccount({
    required String identifier,
    required String password,
  }) async {
    calls += 1;
    seenIdentifier = identifier;
    seenPassword = password;
    final String? message = failure;
    if (message != null) {
      throw WriteApiException(
        WriteFailureKind.unauthenticated,
        message,
        statusCode: 401,
        code: 'ACCOUNT_INVALID_CREDENTIALS',
      );
    }
    // 与真实客户端同一动作（`AuthApiClient.loginAccount` 成功后会 `holder.adopt()`）。
    await holder?.adopt(_validToken);
    return AuthLoginResult(
      token: _validToken,
      expiresAt: DateTime.now().add(const Duration(days: 7)),
      userId: 'u-1',
      displayName: null,
      childId: null,
      role: null,
    );
  }
  @override
  Future<AccountInfo> updateAccount({
    String? phone,
    String? email,
    String? password,
    String? currentPassword,
  }) async {
    return AccountInfo(phone: phone, email: email, hasPassword: password != null);
  }

  @override
  Future<void> logout() async {}

  @override
  void close() {}
}

void main() {
  group('token 形状（与后端 auth-session.gate.ts 同一口径）', () {
    test('kps_ + 43 位 base64url 才算合法', () {
      expect(isValidToken(_validToken), isTrue);
      expect(isValidToken('kps_${'a' * 43}'), isTrue);
    });

    test('★ 前缀 / 长度 / 字符集任一不符都拒（差一位就会写出一个必然 401 的值）', () {
      expect(isValidToken(''), isFalse);
      expect(isValidToken('kps_'), isFalse);
      expect(isValidToken('kps_${'a' * 42}'), isFalse);
      expect(isValidToken('kps_${'a' * 44}'), isFalse);
      expect(isValidToken('kps_${'a' * 42}!'), isFalse);
      expect(isValidToken('skp_${'a' * 43}'), isFalse);
      expect(isValidToken('Bearer kps_${'a' * 43}'), isFalse);
    });
  });

  group('AuthTokenHolder', () {
    test('从存储恢复；坏文件当成"没有 token"而不是带着坏值去请求', () async {
      final AuthTokenHolder good =
          AuthTokenHolder(store: MemoryTokenStore(_validToken));
      expect(await good.restore(), _validToken);
      expect(good.hasToken, isTrue);
      good.dispose();

      final AuthTokenHolder broken =
          AuthTokenHolder(store: MemoryTokenStore('not-a-token'));
      expect(await broken.restore(), isNull);
      expect(broken.hasToken, isFalse);
      broken.dispose();
    });

    test('adopt 之后 signedIn 变 true；clear 之后变 false（闸门靠它切页）', () async {
      final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
      final List<bool> seen = <bool>[];
      holder.signedIn.addListener(() => seen.add(holder.signedIn.value));

      await holder.adopt(_validToken);
      expect(holder.token, _validToken);
      expect(seen, <bool>[true]);

      await holder.clear();
      expect(holder.token, isNull);
      expect(seen, <bool>[true, false]);
      holder.dispose();
    });

    test('★ adopt 一个形状不对的 token ⇒ ArgumentError（不静默写盘）', () async {
      final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
      await expectLater(holder.adopt('oops'), throwsArgumentError);
      expect(holder.hasToken, isFalse);
      holder.dispose();
    });

    test('内存里的 token 优先于磁盘（restore 幂等，不覆盖新 token）', () async {
      final MemoryTokenStore store = MemoryTokenStore(_validToken);
      final AuthTokenHolder holder = AuthTokenHolder(store: store);
      await holder.adopt('kps_${'b' * 43}');
      expect(await holder.restore(), 'kps_${'b' * 43}');
      holder.dispose();
    });
  });

  group('AuthLoginResult 解析', () {
    test('正常回包 ⇒ 字段齐全', () {
      final AuthLoginResult result = AuthLoginResult.fromJson(<String, Object?>{
        'token': _validToken,
        'expiresAt': '2026-11-06T00:00:00.000Z',
        'user': <String, Object?>{'id': 'u-1', 'displayName': '爸爸'},
        'membership': <String, Object?>{'childId': 'c-1', 'role': 'guardian'},
      }, r'$');
      expect(result.token, _validToken);
      expect(result.userId, 'u-1');
      expect(result.displayName, '爸爸');
      expect(result.childId, 'c-1');
      expect(result.role, 'guardian');
    });

    test('`membership: null` ⇒ childId 为 null（这个人还没有孩子）', () {
      final AuthLoginResult result = AuthLoginResult.fromJson(<String, Object?>{
        'token': _validToken,
        'expiresAt': '2026-11-06T00:00:00.000Z',
        'user': <String, Object?>{'id': 'u-1', 'displayName': null},
        'membership': null,
      }, r'$');
      expect(result.childId, isNull);
      expect(result.role, isNull);
    });

    test('★ token 形状坏 ⇒ malformed（不是"先登录着再说"）', () {
      expect(
        () => AuthLoginResult.fromJson(<String, Object?>{
          'token': 'kps_short',
          'expiresAt': '2026-11-06T00:00:00.000Z',
          'user': <String, Object?>{'id': 'u-1', 'displayName': null},
          'membership': null,
        }, r'$'),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('★ `membership` 整个缺失 ⇒ malformed（不能当成"没有孩子"）', () {
      expect(
        () => AuthLoginResult.fromJson(<String, Object?>{
          'token': _validToken,
          'expiresAt': '2026-11-06T00:00:00.000Z',
          'user': <String, Object?>{'id': 'u-1', 'displayName': null},
        }, r'$'),
        throwsA(isA<ReadApiException>()),
      );
    });
  });

  group('AccountInfo 解析', () {
    test('手机号 + 密码 ⇒ 正常，掩码只露前三后四', () {
      final AccountInfo info = AccountInfo.fromJson(<String, Object?>{
        'phone': '13800138000',
        'email': null,
        'hasPassword': true,
      }, r'$');
      expect(info.maskedPhone, '138****8000');
      expect(info.hasPassword, isTrue);
    });

    test('★ 三个字段全空 ⇒ malformed（这个账号根本登不进来）', () {
      expect(
        () => AccountInfo.fromJson(<String, Object?>{
          'phone': null,
          'email': null,
          'hasPassword': false,
        }, r'$'),
        throwsA(isA<ReadApiException>()),
      );
    });
  });

  // ═══════════════ 闸门三态 ═══════════════
  //
  // ★ 全程**不用** `pumpAndSettle()`：`_Phase.checking` 画的是
  //   `CircularProgressIndicator`（无限动画），settle 会一直等到超时。
  //   两次 `pump()` 足够让 `initState` 里的 future 与随后的 `setState` 各跑一帧。
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 20));
  }

  group('AccountGate 三态', () {
    testWidgets('★ 没配后端 ⇒ 直接放行（预览模式不该被登录页挡住）', (WidgetTester tester) async {
      final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
      addTearDown(holder.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AccountGate(
          holder: holder,
          authApi: null,
          config: _unconfigured,
          child: const Text('HOME'),
        ),
      ));
      await settle(tester);

      expect(find.text('HOME'), findsOneWidget);
      expect(find.byType(LoginScreen), findsNothing);
    });

    testWidgets('已存着 token ⇒ 放行', (WidgetTester tester) async {
      final AuthTokenHolder holder =
          AuthTokenHolder(store: MemoryTokenStore(_validToken));
      addTearDown(holder.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AccountGate(
          holder: holder,
          authApi: _FakeAuthApi(),
          config: _configured,
          child: const Text('HOME'),
        ),
      ));
      await settle(tester);

      expect(find.text('HOME'), findsOneWidget);
    });

    testWidgets('★ 没有 token ⇒ 登录页（不是白屏，也不是直接进 App）', (WidgetTester tester) async {
      final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
      addTearDown(holder.dispose);

      await tester.pumpWidget(MaterialApp(
        home: AccountGate(
          holder: holder,
          authApi: _FakeAuthApi(),
          config: _configured,
          child: const Text('HOME'),
        ),
      ));
      await settle(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.text('HOME'), findsNothing);
    });

    testWidgets('★ 登录失败 ⇒ 留在登录页并显示服务端那句话', (WidgetTester tester) async {
      final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
      addTearDown(holder.dispose);
      const String message = '手机号/邮箱或密码不正确。';

      await tester.pumpWidget(MaterialApp(
        home: AccountGate(
          holder: holder,
          authApi: _FakeAuthApi(failure: message),
          config: _configured,
          child: const Text('HOME'),
        ),
      ));
      await settle(tester);

      await tester.enterText(find.byType(TextField).at(0), '13800138000');
      await tester.enterText(find.byType(TextField).at(1), 'wrong-password');
      // 测试窗口默认 800×600，按钮可能落在折叠线以下 —— 不先滚到可见处，
      // `tap` 会点在空白上而**不报错**（只是 warnIfMissed），断言就会莫名其妙地失败。
      await tester.ensureVisible(find.text('登录'));
      await tester.tap(find.text('登录'));
      await settle(tester);

      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.text(message), findsOneWidget);
      expect(holder.hasToken, isFalse);
      expect(find.text('HOME'), findsNothing);
    });

    testWidgets('★ 登录成功 ⇒ 进 App，且 token 已写进 holder', (WidgetTester tester) async {
      final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
      addTearDown(holder.dispose);
      final _FakeAuthApi api = _FakeAuthApi(holder: holder);

      await tester.pumpWidget(MaterialApp(
        home: AccountGate(
          holder: holder,
          authApi: api,
          config: _configured,
          child: const Text('HOME'),
        ),
      ));
      await settle(tester);

      await tester.enterText(find.byType(TextField).at(0), ' 13800138000 ');
      await tester.enterText(find.byType(TextField).at(1), 'jiazhang2026');
      await tester.ensureVisible(find.text('登录'));
      await tester.tap(find.text('登录'));
      await settle(tester);

      expect(find.text('HOME'), findsOneWidget);
      expect(holder.token, _validToken);
      // 送出去的是 **trim 过** 的标识（后端还会再规范化一次，两处都不该有空格）
      expect(api.seenIdentifier, '13800138000');
    });
  });
}
