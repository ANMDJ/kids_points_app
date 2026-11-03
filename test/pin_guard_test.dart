import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_scope.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/parent_mode_api.dart';
import 'package:kids_points_app/data/parent_mode_dto.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/models/parent_mode.dart';
import 'package:kids_points_app/screens/pin_guard.dart';

/// 本机 PIN 闸门（2026-11-04，替代日期码闸门）。
///
/// 钉住的是**四个时刻 / 两道放行**（`docs/design/52-app-pin-lock.md` §3）：
///   ① 冷启动锁着；输对 PIN 才进首页，且**只校验**（`verifyPin` 1 次、
///      `enterParentMode` 0 次 —— 否则 30 天家长会话会被压成 5 分钟）；
///   ② 退到后台再回来 ⇒ 重新上锁（需求 4(b)）；
///   ③ 没设过 PIN 的**家长**设备 ⇒ 先设置（需求 4(a)）；
///   ④ 孩子模式的窗口内不锁，窗口结束后锁（否则孩子切一次应用就回不来）；
///   ⑤ 断网 / 拉不到状态 ⇒ 放行（软锁不该把 App 变成砖）；
///   ⑥ 旧服务端 404 ⇒ 退回「进入家长模式」（功能可用，代价写在文档里）。
void main() {
  group('PinGuard', () {
    Widget harness(AppStore store) => AppScope(
          store: store,
          child: const MaterialApp(
            home: PinGuard(child: Text('首页')),
          ),
        );

    /// 一台「以家长身份登录」的设备（30 天会话、已设 PIN）。
    ParentModeDto sessionBacked({bool pinConfigured = true}) {
      return ParentModeDto(
        activeRole: 'guardian',
        parentMode: true,
        modeSource: 'session',
        parentModeExpiresAt: DateTime.now().add(const Duration(days: 30)),
        remainingSeconds: 30 * 24 * 3600,
        pinConfigured: pinConfigured,
        remainingAttempts: 5,
        lockedUntil: null,
        kidMode: false,
        kidModeExpired: false,
        kidModeUntil: null,
        kidModeRemainingSeconds: 0,
      );
    }

    /// 孩子模式下 `activeRole` 必然是 child、`parentMode` 必然 false。
    ParentModeDto kidMode({
      required DateTime until,
      required bool expired,
    }) {
      return ParentModeDto(
        activeRole: 'child',
        parentMode: false,
        modeSource: null,
        parentModeExpiresAt: null,
        remainingSeconds: 0,
        pinConfigured: true,
        remainingAttempts: 5,
        lockedUntil: null,
        kidMode: !expired,
        kidModeExpired: expired,
        kidModeUntil: until,
        kidModeRemainingSeconds: expired ? 0 : 600,
      );
    }

    /// 一台「孩子自己的」设备：有 PIN 记录但成员位不是家长。
    ParentModeDto childDevice() {
      return ParentModeDto(
        activeRole: 'child',
        parentMode: false,
        modeSource: null,
        parentModeExpiresAt: null,
        remainingSeconds: 0,
        pinConfigured: false,
        remainingAttempts: 5,
        lockedUntil: null,
        kidMode: false,
        kidModeExpired: false,
        kidModeUntil: null,
        kidModeRemainingSeconds: 0,
      );
    }

    Future<AppStore> pump(WidgetTester tester, _FakeApi api) async {
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);
      await tester.pumpWidget(harness(store));
      await tester.pumpAndSettle();
      return store;
    }

    Future<void> typePin(WidgetTester tester, String pin) async {
      for (final String digit in pin.split('')) {
        await tester.tap(find.byKey(ValueKey<String>('pin-key-$digit')));
        await tester.pump();
      }
      await tester.tap(find.text('解锁'));
      await tester.pumpAndSettle();
    }

    testWidgets('冷启动：有 PIN ⇒ 锁着；输对 ⇒ 进首页（只校验，不提权）',
        (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(fetchValue: sessionBacked());
      final AppStore store = await pump(tester, api);

      expect(find.text('已锁定'), findsOneWidget);
      expect(find.text('首页'), findsNothing, reason: '锁着时不能露一眼首页');

      await typePin(tester, '1234');

      expect(find.text('首页'), findsOneWidget);
      expect(api.verifyCalls, 1);
      expect(
        api.enterCalls,
        0,
        reason: '解锁不能走「进入家长模式」：那会把 30 天会话压成 5 分钟',
      );
      expect(store.isAppUnlocked, isTrue);
    });

    testWidgets('退到后台再回来 ⇒ 重新上锁（需求 4(b)）', (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(fetchValue: sessionBacked());
      final AppStore store = await pump(tester, api);
      await typePin(tester, '1234');
      expect(find.text('首页'), findsOneWidget);
      expect(store.isAppUnlocked, isTrue);

      // ★ `paused` 期间框架**不再出帧**（`framesEnabled=false`），所以这里必须
      //   先回到 `resumed` 再 `pump` —— 这与真实使用一致：锁屏是「回来时」看到的。
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      expect(store.isAppUnlocked, isFalse, reason: '退到后台那一刻就已经上锁了');

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(find.text('已锁定'), findsOneWidget, reason: '回前台不会自动解锁');
      expect(find.text('首页'), findsNothing);
    });

    testWidgets('家长设备但没设过 PIN ⇒ 先设置（需求 4(a)）', (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(fetchValue: sessionBacked(pinConfigured: false));
      await pump(tester, api);

      expect(find.text('先设置家长 PIN'), findsOneWidget);
      expect(find.text('首页'), findsNothing);
    });

    testWidgets('孩子模式窗口内不锁；窗口结束才锁（W14 A 方案）',
        (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(
        fetchValue: kidMode(
          until: DateTime.now().add(const Duration(minutes: 10)),
          expired: false,
        ),
      );
      await pump(tester, api);

      expect(find.text('首页'), findsOneWidget, reason: '窗口内锁上，孩子切一次应用就回不来了');
      expect(find.text('已锁定'), findsNothing);
    });

    testWidgets('孩子模式已到点 ⇒ 锁屏（到点要家长 PIN 收回）', (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(
        fetchValue: kidMode(
          until: DateTime.now().subtract(const Duration(minutes: 1)),
          expired: true,
        ),
      );
      await pump(tester, api);

      expect(find.text('已锁定'), findsOneWidget);
      expect(find.textContaining('孩子模式的时间到了'), findsOneWidget);
    });

    testWidgets('孩子自己的设备（不在家长模式、没有 PIN）⇒ 不拦',
        (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(fetchValue: childDevice());
      await pump(tester, api);

      expect(find.text('首页'), findsOneWidget);
    });

    testWidgets('拉不到家长模式（断网）⇒ 放行，不把 App 锁死',
        (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(
        fetchError: WriteApiException.network(Exception('offline')),
      );
      final AppStore store = await pump(tester, api);

      expect(find.text('首页'), findsOneWidget);
      expect(store.parentMode, isNull);
    });

    testWidgets('PIN 不对 ⇒ 停在锁屏、显示服务端原文，且不算解锁',
        (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(
        fetchValue: sessionBacked(),
        verifyError: WriteApiException(
          WriteFailureKind.forbidden,
          '家长 PIN 不对（还剩 4 次尝试机会）。',
          statusCode: 403,
          code: 'PARENT_PIN_INVALID',
        ),
      );
      final AppStore store = await pump(tester, api);

      await typePin(tester, '0000');

      expect(find.text('家长 PIN 不对（还剩 4 次尝试机会）。'), findsOneWidget);
      expect(find.text('首页'), findsNothing);
      expect(store.isAppUnlocked, isFalse);
    });

    testWidgets('旧服务端（404）⇒ 退回「进入家长模式」，不让用户卡在锁屏',
        (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(
        fetchValue: sessionBacked(),
        verifyError: WriteApiException(
          WriteFailureKind.notFound,
          '服务端返回 HTTP 404。',
          statusCode: 404,
        ),
        enterValue: sessionBacked(),
      );
      final AppStore store = await pump(tester, api);

      await typePin(tester, '1234');

      expect(api.verifyCalls, 1);
      expect(api.enterCalls, 1, reason: '降级路径：用进入家长模式代替校验');
      expect(find.text('首页'), findsOneWidget);
      expect(store.isAppUnlocked, isTrue);
    });

    testWidgets('换身份（resetForIdentity）后重新拉状态，不卡在「正在准备本机锁…」',
        (WidgetTester tester) async {
      final _FakeApi api = _FakeApi(fetchValue: sessionBacked());
      final AppStore store = await pump(tester, api);
      expect(api.fetchCalls, 1);
      expect(find.text('已锁定'), findsOneWidget);

      store.resetForIdentity();
      await tester.pumpAndSettle();

      expect(api.fetchCalls, 2, reason: '换身份会把 parentMode 清空，必须再拉一次');
      expect(find.text('已锁定'), findsOneWidget);
      expect(find.text('正在准备本机锁…'), findsNothing);
    });
  });
}

/// `ParentModeApi` 的假实现：只实现本文件用到的六条。
class _FakeApi implements ParentModeApi {
  _FakeApi({
    this.fetchValue,
    this.fetchError,
    this.verifyError,
    this.enterValue,
  });

  ParentModeDto? fetchValue;
  Object? fetchError;
  Object? verifyError;
  ParentModeDto? enterValue;

  int fetchCalls = 0;
  int verifyCalls = 0;
  int enterCalls = 0;
  String? lastPin;
  bool closed = false;

  @override
  Future<ParentModeDto> fetch() async {
    fetchCalls++;
    if (fetchError != null) throw fetchError!;
    return fetchValue!;
  }

  @override
  Future<PinVerifyResult> verifyPin(String pin) async {
    verifyCalls++;
    lastPin = pin;
    if (verifyError != null) throw verifyError!;
    return const PinVerifyResult(remainingAttempts: 5);
  }

  @override
  Future<ParentModeDto> enter(String pin) async {
    enterCalls++;
    lastPin = pin;
    return enterValue!;
  }

  @override
  Future<ParentModeDto> exit() async => fetchValue!;

  @override
  Future<ParentModeDto> enterKidMode(int durationMinutes) async => fetchValue!;

  @override
  Future<ParentModeDto> exitKidMode(String pin) async => fetchValue!;

  @override
  Future<ParentPinDto> setPin({required String pin, String? currentPin}) {
    throw UnimplementedError('本文件不测设 PIN');
  }

  @override
  void close() => closed = true;
}
