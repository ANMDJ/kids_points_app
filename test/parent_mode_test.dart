import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_scope.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/parent_mode_api.dart';
import 'package:kids_points_app/data/parent_mode_dto.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/screens/sheets/parent_mode_sheet.dart';

/// W8-C：家长模式 ＋ 家长 PIN（Flutter 侧）。
///
/// 这些用例钉住的是**家长能看出来的事**：
///   ① 形状自相矛盾的回包一律 `malformed`（不猜默认值）；
///   ② 剩余时间从**绝对时刻**现算，不是本地计数器；
///   ③ 三类失败分开说：格式错（不计次）/ 值不对（剩 N 次）/ 锁定（等多久）；
///   ④ 「退出」不需要 PIN，且幂等；
///   ⑤ 设 PIN 的 `currentPin` 是**三态**：null = 首次设置、有值 = 修改、
///      空串 = 客户端 bug。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  /// `GET /auth/parent-mode` 的回包。默认是「孩子模式、有 PIN、一次都没错」。
  ///
  /// `modeSource` 缺省按剩余时间派生（≤300 ⇒ `pin`，否则 ⇒ `session`），与后端
  /// `parentModeSourceOf()` 同一口径；要构造矛盾形状时显式传。
  Map<String, Object?> modeJson({
    String activeRole = 'child',
    bool? parentMode,
    String? modeSource,
    String? expiresAt,
    int remainingSeconds = 0,
    bool pinConfigured = true,
    int remainingAttempts = 5,
    String? lockedUntil,
  }) {
    final bool active = parentMode ?? (activeRole == 'guardian');
    return <String, Object?>{
      'activeRole': activeRole,
      'parentMode': active,
      'modeSource': modeSource ??
          (active ? (remainingSeconds <= 300 ? 'pin' : 'session') : null),
      'parentModeExpiresAt': expiresAt,
      'remainingSeconds': remainingSeconds,
      'pinConfigured': pinConfigured,
      'remainingAttempts': remainingAttempts,
      'lockedUntil': lockedUntil,
    };
  }

  Map<String, Object?> pinJson({
    bool pinConfigured = true,
    bool changed = false,
    String? pinSetAt = '2026-10-27T09:00:00.000Z',
    int remainingAttempts = 5,
  }) =>
      <String, Object?>{
        'pinConfigured': pinConfigured,
        'changed': changed,
        'pinSetAt': pinSetAt,
        'remainingAttempts': remainingAttempts,
      };

  group('ParentModeDto：形状自相矛盾一律 malformed', () {
    test('孩子模式快照：角色 / 次数 / PIN 配置都保留', () {
      final ParentModeDto dto = ParentModeDto.fromJson(
        modeJson(pinConfigured: false),
        r'$',
      );

      expect(dto.activeRole, 'child');
      expect(dto.parentMode, isFalse);
      expect(dto.parentModeExpiresAt, isNull);
      expect(dto.remainingSeconds, 0);
      expect(dto.pinConfigured, isFalse);
      expect(dto.remainingAttempts, 5);
      expect(dto.lockedUntil, isNull);
    });

    test('家长模式快照：到期时刻是绝对时间，UTC 后缀被正确解析', () {
      final ParentModeDto dto = ParentModeDto.fromJson(
        modeJson(
          activeRole: 'guardian',
          expiresAt: '2026-10-27T09:05:00.000Z',
          remainingSeconds: 300,
        ),
        r'$',
      );

      expect(dto.parentMode, isTrue);
      expect(dto.parentModeExpiresAt, isNotNull);
      expect(dto.parentModeExpiresAt!.isUtc, isTrue);
      expect(dto.parentModeExpiresAt, DateTime.utc(2026, 10, 27, 9, 5));
    });

    test('parentMode 与 activeRole 不一致 ⇒ malformed', () {
      expect(
        () => ParentModeDto.fromJson(
          modeJson(
            activeRole: 'child',
            parentMode: true,
            expiresAt: '2026-10-27T09:05:00.000Z',
          ),
          r'$',
        ),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('在家长模式却没有到期时刻 ⇒ malformed（倒计时无从算起）', () {
      expect(
        () => ParentModeDto.fromJson(
          modeJson(activeRole: 'guardian', remainingSeconds: 120),
          r'$',
        ),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('不在家长模式却给了到期时刻 ⇒ malformed', () {
      expect(
        () => ParentModeDto.fromJson(
          modeJson(expiresAt: '2026-10-27T09:05:00.000Z'),
          r'$',
        ),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('remainingSeconds 必须与来源对得上：pin ⇒ 1..300', () {
      // 0 说明已经到期（服务端会给 `parentMode:false`）；301 却自称 pin ⇒ 来源标错。
      for (final int bad in <int>[0, 301]) {
        expect(
          () => ParentModeDto.fromJson(
            modeJson(
              activeRole: 'guardian',
              modeSource: 'pin',
              expiresAt: '2026-10-27T09:05:00.000Z',
              remainingSeconds: bad,
            ),
            r'$',
          ),
          throwsA(isA<ReadApiException>()),
          reason: 'pin + $bad 秒应当被拒',
        );
      }
      // 边界值 300 合法（就是 TTL 常量本身）。
      expect(
        ParentModeDto.fromJson(
          modeJson(
            activeRole: 'guardian',
            expiresAt: '2026-10-27T09:05:00.000Z',
            remainingSeconds: 300,
          ),
          r'$',
        ).remainingSeconds,
        300,
      );
    });

    test('★ session 来源：30 天的剩余时间是合法的（W8-C 验收回归）', () {
      // 邀请码加入的家长设备：会话 30 天，且会话自带 guardian ⇒ 2 592 000 秒。
      // 早期版本按「≤300」硬卡 —— 家长本机一打开面板就是"数据格式不符合预期"，
      // 而且修好校验之前界面会把 30 天画成 `43200:00`。
      final ParentModeDto dto = ParentModeDto.fromJson(
        modeJson(
          activeRole: 'guardian',
          expiresAt: '2026-11-26T09:00:00.000Z',
          remainingSeconds: 2592000,
        ),
        r'$',
      );
      expect(dto.modeSource, 'session');
      expect(dto.parentMode, isTrue);
      expect(dto.remainingSeconds, 2592000);
    });

    test('session 的剩余时间必须在 (300, 一年] 内', () {
      // ≤300 却自称 session ⇒ 来源标错；40 000 000（毫秒当秒）⇒ 单位错。
      for (final int bad in <int>[300, 120, 40000000]) {
        expect(
          () => ParentModeDto.fromJson(
            modeJson(
              activeRole: 'guardian',
              modeSource: 'session',
              expiresAt: '2026-11-26T09:00:00.000Z',
              remainingSeconds: bad,
            ),
            r'$',
          ),
          throwsA(isA<ReadApiException>()),
          reason: 'session + $bad 秒应当被拒',
        );
      }
    });

    test('modeSource 与 parentMode 必须同真同假、且只认 pin / session', () {
      // 不在家长模式却给了来源。
      expect(
        () => ParentModeDto.fromJson(modeJson(modeSource: 'session'), r'$'),
        throwsA(isA<ReadApiException>()),
      );
      // 在家长模式却**缺**来源 ⇒ 界面无从选择"倒计时"还是"已登录"。
      final Map<String, Object?> missing = modeJson(
        activeRole: 'guardian',
        expiresAt: '2026-10-27T09:05:00.000Z',
        remainingSeconds: 120,
      )..remove('modeSource');
      expect(
        () => ParentModeDto.fromJson(missing, r'$'),
        throwsA(isA<ReadApiException>()),
      );
      // 未知来源（将来新增的第三种）必须显式支持，不能当成 pin 处理。
      expect(
        () => ParentModeDto.fromJson(
          modeJson(
            activeRole: 'guardian',
            modeSource: 'inherit',
            expiresAt: '2026-10-27T09:05:00.000Z',
            remainingSeconds: 120,
          ),
          r'$',
        ),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('锁定与会话次数必须一致（锁定 ⇒ 0 次；未锁 ⇒ 1..5 次）', () {
      expect(
        () => ParentModeDto.fromJson(
          modeJson(
            remainingAttempts: 3,
            lockedUntil: '2026-10-27T09:15:00.000Z',
          ),
          r'$',
        ),
        throwsA(isA<ReadApiException>()),
      );
      expect(
        () => ParentModeDto.fromJson(modeJson(remainingAttempts: 0), r'$'),
        throwsA(isA<ReadApiException>()),
      );
      final ParentModeDto locked = ParentModeDto.fromJson(
        modeJson(
          remainingAttempts: 0,
          lockedUntil: '2026-10-27T09:15:00.000Z',
        ),
        r'$',
      );
      expect(locked.remainingAttempts, 0);
      expect(locked.lockedUntil, DateTime.utc(2026, 10, 27, 9, 15));
    });

    test('未知角色 ⇒ malformed（新角色必须同时更新客户端）', () {
      expect(
        () => ParentModeDto.fromJson(modeJson(activeRole: 'admin'), r'$'),
        throwsA(isA<ReadApiException>()),
      );
    });
  });

  group('ParentPinDto：设置成功必然 pinConfigured=true', () {
    test('首次设置：changed=false', () {
      final ParentPinDto dto = ParentPinDto.fromJson(pinJson(), r'$');
      expect(dto.pinConfigured, isTrue);
      expect(dto.changed, isFalse);
      expect(dto.pinSetAt, DateTime.utc(2026, 10, 27, 9));
      expect(dto.remainingAttempts, 5);
    });

    test('修改：changed=true（界面要说“已修改”，不是“已设置”）', () {
      expect(
        ParentPinDto.fromJson(pinJson(changed: true, remainingAttempts: 4), r'$')
            .changed,
        isTrue,
      );
    });

    test('pinConfigured=false ⇒ malformed（写丢了）', () {
      expect(
        () => ParentPinDto.fromJson(pinJson(pinConfigured: false), r'$'),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('remainingAttempts 越界 ⇒ malformed', () {
      expect(
        () => ParentPinDto.fromJson(pinJson(remainingAttempts: 6), r'$'),
        throwsA(isA<ReadApiException>()),
      );
    });
  });

  group('ParentModeApiClient：四条路由的方法 / 请求体 / 错误映射', () {
    test('fetch 用 GET、不发请求体；enter 用 POST + {pin}', () async {
      final _FakeTransport transport = _FakeTransport(
        (String method, Uri uri, String body) => WriteHttpResponse(
          statusCode: 200,
          body: jsonEncode(modeJson()),
        ),
      );
      final ParentModeApiClient api = ParentModeApiClient(
        config: config,
        transport: transport,
      );

      await api.fetch();
      expect(transport.methods, <String>['GET']);
      expect(transport.paths.single, endsWith('/auth/parent-mode'));
      expect(transport.lastBody, isEmpty);
      expect(transport.lastHeaders[kDeviceIdHeader], 'device-1');
      expect(transport.lastHeaders[kChildIdHeader], 'child-1');

      await api.enter(' 1234 ');
      expect(transport.methods, <String>['GET', 'POST']);
      // 前后空格被 trim，明文 PIN 只出现在请求体里。
      expect(jsonDecode(transport.lastBody), <String, Object?>{'pin': '1234'});
    });

    test('exit 用 DELETE，没有请求体（不需要 PIN）', () async {
      final _FakeTransport transport = _FakeTransport(
        (String method, Uri uri, String body) => WriteHttpResponse(
          statusCode: 200,
          body: jsonEncode(modeJson()),
        ),
      );
      final ParentModeApiClient api = ParentModeApiClient(
        config: config,
        transport: transport,
      );

      await api.exit();

      expect(transport.methods, <String>['DELETE']);
      expect(transport.lastBody, isEmpty);
    });

    test('setPin 首次设置不传 currentPin；修改时两个都传', () async {
      final _FakeTransport transport = _FakeTransport(
        (String method, Uri uri, String body) => WriteHttpResponse(
          statusCode: 200,
          body: jsonEncode(pinJson()),
        ),
      );
      final ParentModeApiClient api = ParentModeApiClient(
        config: config,
        transport: transport,
      );

      await api.setPin(pin: '1234');
      expect(
        jsonDecode(transport.lastBody),
        <String, Object?>{'pin': '1234'},
      );
      expect(transport.paths.single, endsWith('/auth/parent-pin'));

      await api.setPin(pin: '4321', currentPin: '1234');
      expect(
        jsonDecode(transport.lastBody),
        <String, Object?>{'pin': '4321', 'currentPin': '1234'},
      );
    });

    test('429 ⇒ ParentPinLockException，带秒数且文案不是“网络错误”', () async {
      final _FakeTransport transport = _FakeTransport(
        (String method, Uri uri, String body) => WriteHttpResponse(
          statusCode: 429,
          body: jsonEncode(<String, Object?>{
            'code': 'PARENT_PIN_LOCKED',
            'retryAfterSeconds': 899,
          }),
        ),
      );
      final ParentModeApiClient api = ParentModeApiClient(
        config: config,
        transport: transport,
      );

      await expectLater(
        api.enter('1234'),
        throwsA(
          isA<ParentPinLockException>()
              .having((ParentPinLockException e) => e.retryAfterSeconds,
                  'retryAfterSeconds', 899)
              .having((ParentPinLockException e) => e.userMessage, 'userMessage',
                  contains('14 分 59 秒')),
        ),
      );
    });

    test('403 ⇒ WriteApiException.forbidden，服务端文案原样交出', () async {
      final _FakeTransport transport = _FakeTransport(
        (String method, Uri uri, String body) => WriteHttpResponse(
          statusCode: 403,
          body: jsonEncode(<String, Object?>{
            'code': 'PARENT_PIN_INVALID',
            'message': '家长 PIN 不正确，还剩 4 次机会。',
          }),
        ),
      );
      final ParentModeApiClient api = ParentModeApiClient(
        config: config,
        transport: transport,
      );

      await expectLater(
        api.enter('9999'),
        throwsA(
          isA<WriteApiException>()
              .having((WriteApiException e) => e.kind, 'kind',
                  WriteFailureKind.forbidden)
              .having((WriteApiException e) => e.code, 'code',
                  'PARENT_PIN_INVALID'),
        ),
      );
    });

    test('格式不对在本地就拒，一个请求都不发', () async {
      final _FakeTransport transport = _FakeTransport(
        (String method, Uri uri, String body) =>
            throw StateError('不应该发请求'),
      );
      final ParentModeApiClient api = ParentModeApiClient(
        config: config,
        transport: transport,
      );

      await expectLater(api.enter('12'), throwsA(isA<ArgumentError>()));
      await expectLater(
        api.setPin(pin: '1234', currentPin: '  '),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.methods, isEmpty);
    });

    test('humanizeSeconds：秒 / 整分 / 分+秒', () {
      expect(ParentModeApiClient.humanizeSeconds(0), '0 秒');
      expect(ParentModeApiClient.humanizeSeconds(59), '59 秒');
      expect(ParentModeApiClient.humanizeSeconds(60), '1 分钟');
      expect(ParentModeApiClient.humanizeSeconds(899), '14 分 59 秒');
      // 负数按 0 处理（服务端时钟比客户端快时可能出现）。
      expect(ParentModeApiClient.humanizeSeconds(-5), '0 秒');
    });
  });

  group('AppStore：家长模式快照 / 进入 / 退出 / 设 PIN', () {
    test('refresh 成功后按绝对到期时刻现算剩余秒数', () async {
      final DateTime expires = DateTime.now().add(const Duration(seconds: 120));
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(
          modeJson(
            activeRole: 'guardian',
            expiresAt: expires.toUtc().toIso8601String(),
            remainingSeconds: 120,
          ),
          r'$',
        ),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      await store.refreshParentMode();

      expect(store.hasParentMode, isTrue);
      expect(store.parentModeReadStatus, ReadStatus.ready);
      expect(store.isParentMode, isTrue);
      // 现算：不是把 120 当成计数器直接返回。
      expect(
        store.parentModeRemainingSeconds(DateTime.now()),
        inInclusiveRange(118, 120),
      );
      expect(api.fetchCalls, 1);
    });

    test('★ 登录会话自带的家长权限：快照可读、且 store 标成 session（不出倒计时）',
        () async {
      // 邀请码加入的家长设备：30 天会话 + `modeSource: 'session'`。
      // 这一条钉住"面板不该画倒计时"的依据 —— `isParentModeSessionBacked`。
      final DateTime expires = DateTime.now().add(const Duration(days: 30));
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(
          modeJson(
            activeRole: 'guardian',
            modeSource: 'session',
            expiresAt: expires.toUtc().toIso8601String(),
            remainingSeconds: 30 * 24 * 60 * 60,
            pinConfigured: false,
          ),
          r'$',
        ),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      await store.refreshParentMode();

      expect(store.parentModeReadStatus, ReadStatus.ready);
      expect(store.isParentMode, isTrue);
      expect(store.isParentModeSessionBacked, isTrue);
      expect(store.isParentModePinBacked, isFalse);
      // 「还没设 PIN」与「在家长模式」是两件独立的事：两者可以同时成立。
      expect(store.isParentPinConfigured, isFalse);
      // 剩余秒数仍然是真的（≈30 天），只是界面不该把它当倒计时展示。
      expect(store.parentModeRemainingSeconds(DateTime.now()), greaterThan(300));
    });

    test('refresh 失败保留上一次快照（倒计时不能突然变空）', () async {
      final DateTime expires = DateTime.now().add(const Duration(seconds: 200));
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(
          modeJson(
            activeRole: 'guardian',
            expiresAt: expires.toUtc().toIso8601String(),
            remainingSeconds: 200,
          ),
          r'$',
        ),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      await store.refreshParentMode();
      api.fetchError = WriteApiException.timeout(const Duration(seconds: 15));
      await store.refreshParentMode();

      expect(store.parentModeReadStatus, ReadStatus.error);
      expect(store.parentModeError, isNotNull);
      expect(store.isParentMode, isTrue);
      expect(store.parentModeRemainingSeconds(DateTime.now()), greaterThan(0));
    });

    test('enterParentMode：pin 去空格后提交，成功后只更新快照', () async {
      final DateTime expires = DateTime.now().add(const Duration(seconds: 300));
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(modeJson(), r'$'),
        enterValue: ParentModeDto.fromJson(
          modeJson(
            activeRole: 'guardian',
            expiresAt: expires.toUtc().toIso8601String(),
            remainingSeconds: 300,
          ),
          r'$',
        ),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      final String? error = await store.enterParentMode(' 1234 ');

      expect(error, isNull);
      expect(api.lastPin, '1234');
      expect(store.isParentMode, isTrue);
      expect(store.isParentModeBusy, isFalse);
      expect(store.parentPinLockSecondsAt(DateTime.now()), 0);
      // 不整体刷新首页：只发过一次 enter。
      expect(api.fetchCalls, 0);
    });

    test('enterParentMode：403 后重新对齐快照，剩余次数递减', () async {
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(modeJson(remainingAttempts: 4), r'$'),
        enterError: WriteApiException(
          WriteFailureKind.forbidden,
          '家长 PIN 不正确，还剩 4 次机会。',
          statusCode: 403,
          code: 'PARENT_PIN_INVALID',
        ),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      final String? error = await store.enterParentMode('9999');

      expect(error, contains('还剩 4 次'));
      expect(store.isParentMode, isFalse);
      expect(store.parentPinRemainingAttempts, 4);
      expect(api.fetchCalls, 1);
    });

    test('enterParentMode：429 锁定时间既进快照也进本地兜底', () async {
      final DateTime lockedUntil =
          DateTime.now().add(const Duration(seconds: 900));
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(
          modeJson(
            remainingAttempts: 0,
            lockedUntil: lockedUntil.toUtc().toIso8601String(),
          ),
          r'$',
        ),
        enterError: ParentPinLockException(
          retryAfterSeconds: 900,
          userMessage: '家长 PIN 已连续输错，暂时锁定。请 15 分钟后再试。',
        ),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      final String? error = await store.enterParentMode('1234');

      expect(error, contains('锁定'));
      expect(store.isParentPinLockedAt(DateTime.now()), isTrue);
      expect(
        store.parentPinLockSecondsAt(DateTime.now()),
        inInclusiveRange(895, 900),
      );
      expect(store.parentPinRemainingAttempts, 0);
    });

    test('enterParentMode：格式错本地就拒，不发请求（不计次）', () async {
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(modeJson(), r'$'),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      expect(await store.enterParentMode(''), '请输入家长 PIN。');
      expect(await store.enterParentMode('12'), isNotNull);
      expect(api.enterCalls, 0);
    });

    test('exitParentMode：不需要 PIN，退出后回到孩子模式', () async {
      final _FakeParentModeApi api = _FakeParentModeApi(
        exitValue: ParentModeDto.fromJson(modeJson(), r'$'),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      final String? error = await store.exitParentMode();

      expect(error, isNull);
      expect(api.exitCalls, 1);
      expect(store.isParentMode, isFalse);
    });

    test('setParentPin：首次设置 currentPin 为 null，changed=false', () async {
      final _FakeParentModeApi api = _FakeParentModeApi(
        pinValue: ParentPinDto.fromJson(pinJson(), r'$'),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      final String? error = await store.setParentPin(pin: '1234');

      expect(error, isNull);
      expect(api.setPinCalls, 1);
      expect(api.lastCurrentPin, isNull);
      expect(store.lastParentPinResult!.changed, isFalse);
      expect(store.isParentPinConfigured, isTrue);
      expect(store.parentPinRemainingAttempts, 5);
      expect(store.isParentPinBusy, isFalse);
    });

    test('setParentPin：改 PIN 必须带当前 PIN（空串本地就拒）', () async {
      final _FakeParentModeApi api = _FakeParentModeApi(
        pinValue: ParentPinDto.fromJson(pinJson(changed: true), r'$'),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      expect(
        await store.setParentPin(pin: '4321', currentPin: '  '),
        '请输入当前家长 PIN。',
      );
      expect(api.setPinCalls, 0);

      expect(
        await store.setParentPin(pin: '4321', currentPin: ' 1234 '),
        isNull,
      );
      expect(api.lastCurrentPin, '1234');
      expect(store.lastParentPinResult!.changed, isTrue);
    });

    test('没有注入客户端：入口隐藏，调用给出明确失败文案', () async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);

      expect(store.hasParentMode, isFalse);
      expect(await store.enterParentMode('1234'), contains('没有接入后端'));
      expect(await store.setParentPin(pin: '1234'), contains('没有接入后端'));
      expect(await store.exitParentMode(), contains('没有接入后端'));
      await store.refreshParentMode();
      expect(store.parentModeReadStatus, ReadStatus.ready);
      expect(store.isParentMode, isFalse);
    });

    test('dispose 会关闭底层客户端', () {
      final _FakeParentModeApi api = _FakeParentModeApi();
      final AppStore store = AppStore(parentModeApi: api);

      store.dispose();

      expect(api.closed, isTrue);
    });
  });

  // `43` §8 D7（2026-11-03）：引导期跳过 PIN 的存量账号在 5 分钟窗口过期后，
  // 「没有 PIN ⇒ 进不了家长模式 ⇒ 也没权限设 PIN」。面板原来写的是
  // 「请先用家长账号进入一次家长模式」—— 一句做不到的话。这里钉两件事：
  //   ① 文案说清「退出登录 → 用手机号/密码重登」这条路；
  //   ② 那个出口真的可点，并且调用的是闸门那一份 `signOut`。
  group('ParentModeSheet：没有 PIN 时的出口必须可执行（D7）', () {
    testWidgets('不在家长模式 + 没有 PIN ⇒ 显示原因与「退出登录」按钮，点了就退出', (
      WidgetTester tester,
    ) async {
      final _FakeParentModeApi api = _FakeParentModeApi(
        fetchValue: ParentModeDto.fromJson(
          // `remainingAttempts` 未锁定时只能是 1–5（DTO 会判 malformed），用默认 5。
          modeJson(pinConfigured: false),
          r'$',
        ),
      );
      final AppStore store = AppStore(parentModeApi: api);
      addTearDown(store.dispose);

      int signOuts = 0;
      await tester.pumpWidget(
        AppScope(
          store: store,
          child: MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (BuildContext context) => ParentModeSheet(
                  store: store,
                  messenger: ScaffoldMessenger.of(context),
                  signOut: () async {
                    signOuts++;
                  },
                ),
              ),
            ),
          ),
        ),
      );
      // 首帧的 postFrame 回调发起 `refreshParentMode`；快照落地后**不会**自动重绘 ——
      // 这个面板读的是传进来的 `store`（不走 `AppScope.of`），靠自己每秒的 ticker
      // `setState` 才刷新。所以这里要推 1 秒，而不是多 pump 几次。
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(api.fetchCalls, 1);
      expect(
        find.textContaining('引导期的 5 分钟家长权限已经到期'),
        findsOneWidget,
      );
      expect(find.text('退出登录，用手机号/密码重新登录'), findsOneWidget);

      await tester.tap(find.text('退出登录，用手机号/密码重新登录'));
      await tester.pump();
      expect(signOuts, 1);

      // 卸掉组件 ⇒ 面板里每秒重绘的 Timer 被取消（测试结束不允许残留 timer）。
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });
}

/// `WriteTransport` 的假实现：记录方法 / 路径 / 请求体，回包由回调决定。
class _FakeTransport implements WriteTransport {
  _FakeTransport(this.respond);

  final WriteHttpResponse Function(String method, Uri uri, String body) respond;
  final List<String> methods = <String>[];
  final List<String> paths = <String>[];
  String lastBody = '';
  Map<String, String> lastHeaders = <String, String>{};

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
    return respond(method, uri, body);
  }

  @override
  void close() {}
}

/// `ParentModeApi` 的假实现：四条路由各自可配置回包 / 异常。
class _FakeParentModeApi implements ParentModeApi {
  _FakeParentModeApi({
    this.fetchValue,
    this.enterValue,
    this.exitValue,
    this.pinValue,
    this.enterError,
  });

  ParentModeDto? fetchValue;
  ParentModeDto? enterValue;
  ParentModeDto? exitValue;
  ParentPinDto? pinValue;
  Object? fetchError;
  Object? enterError;
  Object? exitError;
  Object? setPinError;

  int fetchCalls = 0;
  int enterCalls = 0;
  int exitCalls = 0;
  int setPinCalls = 0;
  String? lastPin;
  String? lastCurrentPin;
  bool closed = false;

  @override
  Future<ParentModeDto> fetch() async {
    fetchCalls++;
    if (fetchError != null) throw fetchError!;
    return fetchValue!;
  }

  @override
  Future<ParentModeDto> enter(String pin) async {
    enterCalls++;
    lastPin = pin;
    if (enterError != null) throw enterError!;
    return enterValue!;
  }

  @override
  Future<ParentModeDto> exit() async {
    exitCalls++;
    if (exitError != null) throw exitError!;
    return exitValue!;
  }

  @override
  Future<ParentPinDto> setPin({
    required String pin,
    String? currentPin,
  }) async {
    setPinCalls++;
    lastPin = pin;
    lastCurrentPin = currentPin;
    if (setPinError != null) throw setPinError!;
    return pinValue!;
  }

  @override
  void close() => closed = true;
}

