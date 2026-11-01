import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_scope.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/date_code_api.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/main.dart';
import 'package:kids_points_app/screens/date_code_gate.dart';

/// W9-C：**启动闸门**（输今天的 6 位码才能进 App）。
///
/// 这些用例钉住的是「闸门到底拦不拦得住」：
///   ① 没注入客户端（预览 / 测试夹具）⇒ 不拦，直接进；
///   ② 注入了但没验证 ⇒ 只有锁屏，首页一个字都看不到；
///   ③ 码对了 ⇒ 进 App；码错了 ⇒ 留在锁屏并说明规则；
///   ④ 少一位 ⇒ **不发请求**（不能表现成「请求失败」）；
///   ⑤ 网络失败 ⇒ **仍然锁着**（与引导闸门相反：引导遇到「不知道」必须放行，
///      入口闸门遇到「不知道」必须拦着 —— 见 `date_code_gate.dart` 文件头）；
///   ⑥ 429 ⇒ 说明「还要等多久」，且期间不再发请求；
///   ⑦ 容差内的昨天的码 ⇒ 也放行（这是后端 ±1 天的既定行为）；
///   ⑧ 「立即锁定入口」把本地放行状态清回锁着（重开 App 一样的路径）。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> verdictJson({
    bool valid = true,
    int? dayOffset = 0,
    String? acceptedUntil = '2026-10-30T16:00:00.000Z',
    String serverDate = '2026-10-29',
    int weekDay = 4,
  }) =>
      <String, Object?>{
        'valid': valid,
        'serverDate': serverDate,
        'weekDay': weekDay,
        'dayOffset': dayOffset,
        'acceptedUntil': acceptedUntil,
      };

  /// 只有 `dateCodeApi` 的 store（闸门用例不关心读 / 写）。
  AppStore storeWith(DateCodeApiClient api) => AppStore(dateCodeApi: api);

  Future<void> pumpGate(WidgetTester tester, AppStore store) async {
    await tester.pumpWidget(
      AppScope(
        store: store,
        child: const MaterialApp(
          home: DateCodeGate(child: Text('首页')),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  group('闸门开合', () {
    testWidgets('没注入验证码客户端 ⇒ 直接进首页（预览 / 测试夹具）',
        (WidgetTester tester) async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);

      await pumpGate(tester, store);

      expect(find.text('首页'), findsOneWidget);
      expect(find.text('请输入今天的验证码'), findsNothing);
    });

    testWidgets('注入了但没验证 ⇒ 只有锁屏，首页不可见',
        (WidgetTester tester) async {
      final AppStore store = storeWith(
        DateCodeApiClient(
          config: config,
          transport: _FakeDateCodeTransport(verdictJson()),
        ),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);

      expect(find.text('请输入今天的验证码'), findsOneWidget);
      expect(find.text('今天的码 = 月日 4 位 ＋ 星期 2 位'), findsOneWidget);
      expect(find.text('首页'), findsNothing);
      // 界面必须自己说清「这不是登录」
      expect(find.textContaining('不是登录'), findsOneWidget);
    });

    testWidgets('码对了 ⇒ 进首页，请求体只有 code',
        (WidgetTester tester) async {
      final _FakeDateCodeTransport transport =
          _FakeDateCodeTransport(verdictJson());
      final AppStore store = storeWith(
        DateCodeApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      await tester.enterText(find.byType(TextField), '102904');
      await tester.pump();
      await tester.tap(find.text('进入'));
      await tester.pumpAndSettle();

      expect(find.text('首页'), findsOneWidget);
      expect(find.text('请输入今天的验证码'), findsNothing);
      expect(store.isDateCodeGateUnlocked, isTrue);
      expect(transport.paths, <String>['/api/auth/date-code']);
      expect(jsonDecode(transport.lastBody), <String, Object?>{'code': '102904'});
    });

    testWidgets('码不对（200 valid:false）⇒ 留在锁屏并说明规则',
        (WidgetTester tester) async {
      final AppStore store = storeWith(
        DateCodeApiClient(
          config: config,
          transport: _FakeDateCodeTransport(
            verdictJson(valid: false, dayOffset: null, acceptedUntil: null),
          ),
        ),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      await tester.enterText(find.byType(TextField), '000000');
      await tester.pump();
      await tester.tap(find.text('进入'));
      await tester.pumpAndSettle();

      expect(find.text('首页'), findsNothing);
      expect(find.textContaining('验证码不对'), findsOneWidget);
      expect(store.isDateCodeGateUnlocked, isFalse);
    });

    testWidgets('容差内的昨天的码（dayOffset:-1）⇒ 也放行',
        (WidgetTester tester) async {
      final AppStore store = storeWith(
        DateCodeApiClient(
          config: config,
          transport: _FakeDateCodeTransport(verdictJson(dayOffset: -1)),
        ),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      await tester.enterText(find.byType(TextField), '102803');
      await tester.pump();
      await tester.tap(find.text('进入'));
      await tester.pumpAndSettle();

      expect(find.text('首页'), findsOneWidget);
      expect(store.lastDateCodeVerdict?.dayOffset, -1);
    });
  });

  group('拦得住：形状错 / 网络失败 / 限流', () {
    testWidgets('不足 6 位 ⇒ 按钮禁用，点了也不发请求',
        (WidgetTester tester) async {
      final _FakeDateCodeTransport transport =
          _FakeDateCodeTransport(verdictJson());
      final AppStore store = storeWith(
        DateCodeApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      await tester.enterText(find.byType(TextField), '1029');
      await tester.pump();

      expect(find.text('还差 2 位'), findsOneWidget);

      await tester.tap(find.text('进入'));
      await tester.pumpAndSettle();

      expect(transport.callCount, 0);
      expect(find.text('首页'), findsNothing);
    });

    testWidgets('★ 网络失败 ⇒ 仍然锁着（「不知道」不能当「通过」）',
        (WidgetTester tester) async {
      final AppStore store = storeWith(
        DateCodeApiClient(
          config: config,
          transport: _FakeDateCodeTransport(
            verdictJson(),
            throwOnSend: const SocketException('network down'),
          ),
        ),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      await tester.enterText(find.byType(TextField), '102904');
      await tester.pump();
      await tester.tap(find.text('进入'));
      await tester.pumpAndSettle();

      expect(find.text('首页'), findsNothing);
      expect(find.text('请输入今天的验证码'), findsOneWidget);
      expect(store.isDateCodeGateUnlocked, isFalse);
      expect(store.dateCodeError, isNotNull);
    });

    testWidgets('429 ⇒ 说清还要等多久，且期间不再发请求',
        (WidgetTester tester) async {
      final _FakeDateCodeTransport transport = _FakeDateCodeTransport(
        <String, Object?>{
          'code': 'DATE_CODE_RATE_LIMITED',
          'retryAfterSeconds': 45,
        },
        statusCode: 429,
      );
      final AppStore store = storeWith(
        DateCodeApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      await tester.enterText(find.byType(TextField), '102904');
      await tester.pump();
      await tester.tap(find.text('进入'));
      // 429 之后界面上有每秒倒计时，不 pumpAndSettle（它会一直等）
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.textContaining('试得太频繁了'), findsOneWidget);
      expect(store.dateCodeRetrySecondsAt(DateTime.now()), greaterThan(0));
      expect(transport.callCount, 1);

      // 冷却期内再点一次「进入」：按钮不可用 ⇒ 一个请求都不该多发
      await tester.tap(find.text('进入'));
      await tester.pump();
      expect(transport.callCount, 1);
      expect(find.text('首页'), findsNothing);
    });
  });

  group('整个 App：冷启动先锁屏（`main.dart` 的组装）', () {
    testWidgets('PointsApp ＋ 验证码客户端 ⇒ 首页只在输码后才出现',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final _FakeDateCodeTransport transport =
          _FakeDateCodeTransport(verdictJson());
      final AppStore store = storeWith(
        DateCodeApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();

      expect(find.text('请输入今天的验证码'), findsOneWidget);
      expect(find.text('今天的习惯'), findsNothing);

      await tester.enterText(find.byType(TextField), '102904');
      await tester.pump();
      await tester.tap(find.text('进入'));
      await tester.pumpAndSettle();

      expect(find.text('今天的习惯'), findsOneWidget);
      expect(find.text('请输入今天的验证码'), findsNothing);
    });
  });

  group('AppStore：放行 / 重新锁定', () {
    test('空串与 5 位 ⇒ 本地拒，不发请求', () async {
      final _FakeDateCodeTransport transport =
          _FakeDateCodeTransport(verdictJson());
      final AppStore store = storeWith(
        DateCodeApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      expect(await store.verifyDateCodeGate('   '), '请输入 6 位验证码。');
      expect(
        await store.verifyDateCodeGate('10290'),
        contains('6 位数字'),
      );
      expect(transport.callCount, 0);
    });

    test('放行后再问一次 ⇒ 直接成功，不再发请求', () async {
      final _FakeDateCodeTransport transport =
          _FakeDateCodeTransport(verdictJson());
      final AppStore store = storeWith(
        DateCodeApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      expect(await store.verifyDateCodeGate('102904'), isNull);
      expect(store.isDateCodeGateUnlocked, isTrue);
      expect(transport.callCount, 1);

      expect(await store.verifyDateCodeGate('102904'), isNull);
      expect(transport.callCount, 1);
    });

    test('lockDateCodeGate() ⇒ 立刻回到锁着（并可再次验证）', () async {
      final _FakeDateCodeTransport transport =
          _FakeDateCodeTransport(verdictJson());
      final AppStore store = storeWith(
        DateCodeApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.verifyDateCodeGate('102904');
      expect(store.isDateCodeGateUnlocked, isTrue);

      store.lockDateCodeGate();

      expect(store.isDateCodeGateUnlocked, isFalse);
      expect(store.lastDateCodeVerdict, isNull);
      expect(store.dateCodeError, isNull);

      await store.verifyDateCodeGate('102904');
      expect(transport.callCount, 2);
      expect(store.isDateCodeGateUnlocked, isTrue);
    });
  });
}

/// `WriteTransport` 的假实现：记录方法 / 路径 / 头 / 请求体，回包由构造参数决定。
class _FakeDateCodeTransport implements WriteTransport {
  _FakeDateCodeTransport(
    this.body, {
    this.statusCode = 200,
    this.throwOnSend,
  });

  final Map<String, Object?> body;
  final int statusCode;

  /// 非 null ⇒ 发请求时抛它（模拟断网 / DNS 失败）。
  final IOException? throwOnSend;

  final List<String> methods = <String>[];
  final List<String> paths = <String>[];
  String lastBody = '';
  Map<String, String> lastHeaders = <String, String>{};

  int get callCount => paths.length;

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    methods.add(method);
    paths.add(uri.path);
    lastBody = body;
    lastHeaders = headers;
    final IOException? failure = throwOnSend;
    if (failure != null) throw failure;
    return WriteHttpResponse(statusCode: statusCode, body: jsonEncode(this.body));
  }

  @override
  void close() {}
}
