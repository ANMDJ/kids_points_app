import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_scope.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/onboarding_api.dart';
import 'package:kids_points_app/data/onboarding_dto.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/models/onboarding.dart';
import 'package:kids_points_app/screens/onboarding_gate.dart';

/// W8-B：首启引导（双端 UI 的 Flutter 侧）。
///
/// 这些用例钉住的是**家长能看出来的事**：
///   ① 第①步的同意必须真的落到服务端，未勾选不能继续（`04` §5）；
///   ② 第③④步「跳过」与「清空」是两种意图（`null` vs 未传、`[]` vs 未传）；
///   ③ 第⑤步一条都不选就**不发请求**（`04` §6 4.2）；
///   ④ 完成引导后：规则回包逐条落库、奖励类约定加入今日习惯、扣分约定**不加**；
///   ⑤ `onboarded: false` 才进引导；403 / 网络错误放行到首页（不能把应用锁死）；
///   ⑥ 形状自相矛盾的回包一律 `malformed`，绝不画成「已完成」。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> templateJson({
    String slug = 'tidy-desk',
    String title = '自己收书包',
    int dailyLimit = 1,
    int points = 2,
    String direction = 'reward',
    String ageBand = 'primary_low',
    List<String> focusAreas = const <String>['生活习惯'],
  }) =>
      <String, Object?>{
        'slug': slug,
        'title': title,
        'condition': '睡前自己收好书包',
        'dailyLimit': dailyLimit,
        'points': points,
        'direction': direction,
        'icon': 'backpack',
        'color': '#e9834b',
        'ageBand': ageBand,
        'focusAreas': focusAreas,
        'sortWeight': 10,
      };

  Map<String, Object?> viewJson({
    bool onboarded = false,
    String? ageBand,
    List<String> focusAreas = const <String>[],
    List<Object?>? templates,
  }) =>
      <String, Object?>{
        'childId': 'child-1',
        'onboarded': onboarded,
        'onboardedAt': onboarded ? '2026-10-27T09:00:00.000Z' : null,
        'ageBand': ageBand,
        'focusAreas': focusAreas,
        'templates': templates ??
            <Object?>[
              templateJson(),
              templateJson(
                slug: 'homework-timer',
                title: '番茄钟写作业',
                dailyLimit: 2,
                points: 3,
                focusAreas: <String>['作业专注'],
              ),
            ],
      };

  Map<String, Object?> resultJson({List<Object?>? rules}) => <String, Object?>{
        'childId': 'child-1',
        'onboardedAt': '2026-10-27T09:00:00.000Z',
        'rules': rules ??
            <Object?>[
              <String, Object?>{
                'ruleId': 'rule-1',
                'title': '自己收书包',
                'condition': '睡前自己收好书包',
                'dailyLimit': 1,
                'points': 2,
                'direction': 'reward',
                'icon': 'backpack',
                'color': '#e9834b',
                'currentVersion': 1,
              },
            ],
      };

  group('OnboardingViewDto：形状自相矛盾一律 malformed', () {
    test('合法回包：模板逐个解析，学段与关注点保留', () {
      final OnboardingViewDto dto = OnboardingViewDto.fromJson(viewJson(
        ageBand: 'primary_low',
        focusAreas: <String>['生活习惯'],
      ));

      expect(dto.onboarded, isFalse);
      expect(dto.onboardedAt, isNull);
      expect(dto.ageBandValue, AgeBand.primaryLow);
      expect(dto.focusAreas, <String>['生活习惯']);
      expect(dto.templates.length, 2);
      expect(dto.templates.first.slug, 'tidy-desk');
      expect(dto.templates.first.isPenalty, isFalse);
      expect(dto.templates.first.ageBand, 'primary_low');
    });

    test('onboarded=true 但 onboardedAt=null ⇒ malformed', () {
      final Map<String, Object?> json = viewJson()
        ..['onboarded'] = true
        ..['onboardedAt'] = null;
      expect(
        () => OnboardingViewDto.fromJson(json),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('未知学段 / 未知关注点 ⇒ malformed（不静默兜底）', () {
      expect(
        () => OnboardingViewDto.fromJson(viewJson(ageBand: 'college')),
        throwsA(isA<ReadApiException>()),
      );
      expect(
        () =>
            OnboardingViewDto.fromJson(viewJson(focusAreas: <String>['打游戏'])),
        throwsA(isA<ReadApiException>()),
      );
      expect(
        () => OnboardingViewDto.fromJson(viewJson(templates: <Object?>[
          templateJson(ageBand: 'college'),
        ])),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('模板 slug 重复 / 模板库为空 ⇒ malformed', () {
      expect(
        () => OnboardingViewDto.fromJson(viewJson(templates: <Object?>[
          templateJson(),
          templateJson(),
        ])),
        throwsA(isA<ReadApiException>()),
        reason: '重复 slug 会让「采纳这几条」产生歧义',
      );
      expect(
        () => OnboardingViewDto.fromJson(viewJson(templates: <Object?>[])),
        throwsA(isA<ReadApiException>()),
        reason: '空模板库意味着第⑤步无法继续，不能在界面上画成「没有可选项」',
      );
    });

    test('模板分值为 0 或负 / 方向未知 / 每天次数越界 ⇒ malformed', () {
      for (final Map<String, Object?> bad in <Map<String, Object?>>[
        templateJson(points: 0),
        templateJson(points: -2),
        templateJson(direction: 'bonus'),
        templateJson(dailyLimit: 0),
        templateJson(dailyLimit: 11),
      ]) {
        expect(
          () => OnboardingViewDto.fromJson(viewJson(templates: <Object?>[bad])),
          throwsA(isA<ReadApiException>()),
          reason: '坏模板：$bad',
        );
      }
    });

    test('完成回包：空 rules ⇒ malformed（不能显示「已完成」）', () {
      expect(
        () => OnboardingResultDto.fromJson(resultJson(rules: <Object?>[])),
        throwsA(isA<ReadApiException>()),
      );
      final OnboardingResultDto ok = OnboardingResultDto.fromJson(resultJson());
      expect(ok.rules.single.ruleId, 'rule-1');
      expect(ok.rules.single.isPenalty, isFalse);
      expect(ok.onboardedAt.toUtc().toIso8601String(),
          '2026-10-27T09:00:00.000Z');
    });
  });


  group('OnboardingApiClient：请求方法 / 请求体 / 错误归一', () {
    test('fetch 走 GET，且不带 Content-Type；回包解析成模板列表', () async {
      final _FakeOnboardingTransport transport =
          _FakeOnboardingTransport(viewBody: jsonEncode(viewJson()));
      final OnboardingApiClient api =
          OnboardingApiClient(config: config, transport: transport);
      addTearDown(api.close);

      final OnboardingViewDto dto = await api.fetch();

      expect(transport.calls, <String>['GET /api/onboarding']);
      expect(transport.lastHeaders.containsKey('content-type'), isFalse);
      expect(dto.templates.length, 2);
    });

    test('saveProfile：清空学段发的是 ageBand:null，而不是省略字段', () async {
      final _FakeOnboardingTransport transport = _FakeOnboardingTransport(
        stateBody: jsonEncode(<String, Object?>{
          'childId': 'child-1',
          'onboarded': false,
          'onboardedAt': null,
          'ageBand': null,
          'focusAreas': <String>[],
        }),
      );
      final OnboardingApiClient api =
          OnboardingApiClient(config: config, transport: transport);
      addTearDown(api.close);

      await api.saveProfile(clearAgeBand: true);

      expect(transport.calls, <String>['PATCH /api/onboarding/profile']);
      expect(transport.lastBody.containsKey('ageBand'), isTrue);
      expect(transport.lastBody['ageBand'], isNull);
      expect(transport.lastBody.containsKey('focusAreas'), isFalse);
    });

    test('saveProfile：关注点保序去重；未知关注点本地拒绝', () async {
      final _FakeOnboardingTransport transport = _FakeOnboardingTransport(
        stateBody: jsonEncode(<String, Object?>{
          'childId': 'child-1',
          'onboarded': false,
          'onboardedAt': null,
          'ageBand': 'primary_low',
          'focusAreas': <String>['阅读', '家务'],
        }),
      );
      final OnboardingApiClient api =
          OnboardingApiClient(config: config, transport: transport);
      addTearDown(api.close);

      await api.saveProfile(focusAreas: <String>['阅读', '家务', '阅读']);
      expect(transport.lastBody['focusAreas'], <String>['阅读', '家务']);

      await expectLater(
        api.saveProfile(focusAreas: <String>['打游戏']),
        throwsArgumentError,
      );
      expect(transport.calls.length, 1, reason: '本地拒绝时不该发请求');
    });

    test('complete：slug 去重、跳过 PIN 时**没有** parentPin 字段', () async {
      final _FakeOnboardingTransport transport = _FakeOnboardingTransport(
        completeBody: jsonEncode(resultJson()),
      );
      final OnboardingApiClient api =
          OnboardingApiClient(config: config, transport: transport);
      addTearDown(api.close);

      await api.complete(
        templateSlugs: <String>['tidy-desk', 'tidy-desk'],
      );

      expect(transport.calls, <String>['POST /api/onboarding/complete']);
      expect(transport.lastBody['templateSlugs'], <String>['tidy-desk']);
      expect(transport.lastBody.containsKey('parentPin'), isFalse);
    });

    test('complete：一条都不选 / 空串 PIN 都在本地拒绝', () async {
      final _FakeOnboardingTransport transport =
          _FakeOnboardingTransport(completeBody: jsonEncode(resultJson()));
      final OnboardingApiClient api =
          OnboardingApiClient(config: config, transport: transport);
      addTearDown(api.close);

      await expectLater(
        api.complete(templateSlugs: <String>[]),
        throwsArgumentError,
      );
      await expectLater(
        api.complete(templateSlugs: <String>['tidy-desk'], parentPin: ''),
        throwsArgumentError,
      );
      await expectLater(
        api.complete(templateSlugs: <String>['tidy-desk'], parentPin: '12'),
        throwsArgumentError,
      );
      expect(transport.calls, isEmpty);
    });

    test('409 / 501 归一成 WriteApiException，并保留业务码', () async {
      final _FakeOnboardingTransport transport = _FakeOnboardingTransport(
        completeStatus: 409,
        completeBody: jsonEncode(<String, Object?>{
          'code': 'ONBOARDING_ALREADY_COMPLETED',
          'message': '这个孩子的引导已经完成过了。',
        }),
      );
      final OnboardingApiClient api =
          OnboardingApiClient(config: config, transport: transport);
      addTearDown(api.close);

      await expectLater(
        api.complete(templateSlugs: <String>['tidy-desk']),
        throwsA(isA<WriteApiException>()
            .having((WriteApiException e) => e.kind, 'kind',
                WriteFailureKind.conflict)
            .having((WriteApiException e) => e.code, 'code',
                'ONBOARDING_ALREADY_COMPLETED')),
      );

      transport.completeStatus = 501;
      transport.completeBody = jsonEncode(<String, Object?>{
        'code': 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED',
        'message': '当前装配没有数据库连接。',
      });
      await expectLater(
        api.complete(templateSlugs: <String>['tidy-desk']),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.code,
          'code',
          'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED',
        )),
      );
    });
  });


  group('AppStore 引导切片：只有「明确未完成」才要求引导', () {
    test('idle / 读取失败都不要求引导；拿到 onboarded:false 才要求', () async {
      final _FakeOnboardingTransport transport =
          _FakeOnboardingTransport(viewBody: jsonEncode(viewJson()));
      final AppStore store = AppStore(
        onboardingApi: OnboardingApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      expect(store.needsOnboarding, isFalse, reason: '还不知道 ≠ 未引导');
      await store.refreshOnboarding();
      expect(store.needsOnboarding, isTrue);
      expect(store.onboarding!.templates.length, 2);

      transport.viewStatus = 403;
      transport.viewBody =
          jsonEncode(<String, Object?>{'code': 'FORBIDDEN', 'message': '没有权限'});
      await store.refreshOnboarding();
      expect(
        store.needsOnboarding,
        isTrue,
        reason: '失败不清空上一次成功快照（不能把已完成说成未引导）',
      );
      expect(store.onboardingError, isNotNull);
      expect(store.onboardingReadStatus, ReadStatus.error);
    });

    test('保存草稿：只改学段时关注点不丢，模板列表也不丢', () async {
      final _FakeOnboardingTransport transport = _FakeOnboardingTransport(
        viewBody: jsonEncode(viewJson(focusAreas: <String>['阅读'])),
        stateBody: jsonEncode(<String, Object?>{
          'childId': 'child-1',
          'onboarded': false,
          'onboardedAt': null,
          'ageBand': 'primary_high',
          'focusAreas': <String>['阅读'],
        }),
      );
      final AppStore store = AppStore(
        onboardingApi: OnboardingApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshOnboarding();
      final String? error =
          await store.saveOnboardingDraft(ageBand: AgeBand.primaryHigh);

      expect(error, isNull);
      expect(store.onboarding!.ageBand, AgeBand.primaryHigh);
      expect(store.onboarding!.focusAreas, <String>['阅读']);
      expect(store.onboarding!.templates.length, 2);
    });
  });


  group('AppStore.completeOnboarding：规则 / 习惯 / 幂等冲突', () {
    test('奖励约定加入今日习惯，扣分约定只列进「需手动」', () async {
      final _FakeOnboardingTransport onboarding = _FakeOnboardingTransport(
        viewBody: jsonEncode(viewJson()),
        completeBody: jsonEncode(resultJson(rules: <Object?>[
          <String, Object?>{
            'ruleId': 'rule-1',
            'title': '自己收书包',
            'condition': '睡前自己收好书包',
            'dailyLimit': 1,
            'points': 2,
            'direction': 'reward',
            'icon': 'backpack',
            'color': '#e9834b',
            'currentVersion': 1,
          },
          <String, Object?>{
            'ruleId': 'rule-2',
            'title': '顶嘴',
            'condition': '对家人大喊大叫',
            'dailyLimit': 1,
            'points': 1,
            'direction': 'penalty',
            'icon': 'spray',
            'color': '#e9834b',
            'currentVersion': 1,
          },
        ])),
      );
      final _FakeWriteTransport write = _FakeWriteTransport();
      final AppStore store = AppStore(
        writeApi: WriteApiClient(config: config, transport: write),
        onboardingApi:
            OnboardingApiClient(config: config, transport: onboarding),
      );
      addTearDown(store.dispose);

      await store.refreshOnboarding();
      final String? error = await store.completeOnboarding(
        templateSlugs: <String>['tidy-desk', 'talk-back'],
        ageBand: AgeBand.primaryLow,
        focusAreas: <String>['生活习惯'],
        parentPin: '2468',
      );

      expect(error, isNull);
      expect(store.needsOnboarding, isFalse);
      expect(store.lastOnboardingResult!.rules.length, 2);
      expect(store.lastOnboardingHabitCount, 1);
      expect(store.lastOnboardingManualTitles, <String>['顶嘴']);
      expect(store.habits.length, 1);
      expect(
        write.calls,
        <String>['POST /api/point-rules/rule-1/habits'],
        reason: '扣分规则不能变成孩子主动打卡的习惯（A1）',
      );
      expect(onboarding.lastBody['parentPin'], '2468');
      expect(onboarding.lastBody['templateSlugs'],
          <String>['tidy-desk', 'talk-back']);
    });

    test('409（另一台设备已完成）：重拉状态并放行', () async {
      final _FakeOnboardingTransport onboarding = _FakeOnboardingTransport(
        viewBody: jsonEncode(viewJson()),
        completeStatus: 409,
        completeBody: jsonEncode(<String, Object?>{
          'code': 'ONBOARDING_ALREADY_COMPLETED',
          'message': '这个孩子的引导已经完成过了。',
        }),
      );
      final AppStore store = AppStore(
        onboardingApi:
            OnboardingApiClient(config: config, transport: onboarding),
      );
      addTearDown(store.dispose);

      await store.refreshOnboarding();
      onboarding.viewBody = jsonEncode(viewJson(onboarded: true));
      final String? error =
          await store.completeOnboarding(templateSlugs: <String>['tidy-desk']);

      expect(error, isNotNull);
      expect(store.needsOnboarding, isFalse);
      expect(
        onboarding.calls
            .where((String call) => call == 'GET /api/onboarding')
            .length,
        2,
      );
    });
  });


  group('OnboardingGate：闸门', () {
    Future<void> pumpGate(WidgetTester tester, AppStore store) async {
      await tester.pumpWidget(
        AppScope(
          store: store,
          child: const MaterialApp(
            home: OnboardingGate(child: Text('首页')),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('onboarded=false ⇒ 进引导；勾选同意后才到第②步',
        (WidgetTester tester) async {
      final _FakeOnboardingTransport onboarding =
          _FakeOnboardingTransport(viewBody: jsonEncode(viewJson()));
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: _FakeReadTransport()),
        writeApi:
            WriteApiClient(config: config, transport: _FakeWriteTransport()),
        onboardingApi:
            OnboardingApiClient(config: config, transport: onboarding),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);

      expect(find.text('把约定变成看得见的成长'), findsOneWidget);
      expect(find.text('首页'), findsNothing);
      expect(find.text('第 1 / 7 步'), findsOneWidget);

      await tester.tap(find.text('我是该儿童的监护人，并同意为其创建积分账本'));
      await tester.pump();
      await tester.tap(find.text('同意并开始'));
      await tester.pumpAndSettle();

      expect(find.text('孩子昵称'), findsOneWidget);
      expect(find.text('第 2 / 7 步'), findsOneWidget);
    });

    testWidgets('未勾选同意：留在第①步并说明原因', (WidgetTester tester) async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: _FakeReadTransport()),
        writeApi:
            WriteApiClient(config: config, transport: _FakeWriteTransport()),
        onboardingApi: OnboardingApiClient(
          config: config,
          transport: _FakeOnboardingTransport(viewBody: jsonEncode(viewJson())),
        ),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      await tester.tap(find.text('同意并开始'));
      await tester.pumpAndSettle();

      expect(find.textContaining('请先勾选'), findsOneWidget);
      expect(find.text('第 1 / 7 步'), findsOneWidget);
    });

    testWidgets('onboarded=true ⇒ 直接进首页', (WidgetTester tester) async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: _FakeReadTransport()),
        onboardingApi: OnboardingApiClient(
          config: config,
          transport: _FakeOnboardingTransport(
            viewBody: jsonEncode(viewJson(onboarded: true)),
          ),
        ),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      expect(find.text('首页'), findsOneWidget);
    });

    testWidgets('读取引导状态 500 ⇒ 放行首页（不能把应用锁死）',
        (WidgetTester tester) async {
      final _FakeOnboardingTransport onboarding = _FakeOnboardingTransport(
        viewStatus: 500,
        viewBody: jsonEncode(<String, Object?>{'code': 'INTERNAL'}),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: _FakeReadTransport()),
        onboardingApi:
            OnboardingApiClient(config: config, transport: onboarding),
      );
      addTearDown(store.dispose);

      await pumpGate(tester, store);
      expect(find.text('首页'), findsOneWidget);
      expect(store.onboardingError, isNotNull);
    });
  });

  group('步骤校验（纯函数）', () {
    test('昵称：空白与超长都被拒，返回可显示的文案', () {
      expect(validateChildName('  '), isNotNull);
      expect(validateChildName('一二三四五六七八九十一二三四五六七八九十一'), isNotNull);
      expect(validateChildName('小满'), isNull);
    });

    test('PIN：留空 = 跳过；4–6 位数字通过；其它被拒', () {
      expect(validateParentPin(''), isNull);
      expect(validateParentPin('1234'), isNull);
      expect(validateParentPin('123456'), isNull);
      expect(validateParentPin('123'), isNotNull);
      expect(validateParentPin('1234567'), isNotNull);
      expect(validateParentPin('12a4'), isNotNull);
    });

    // 2026-11-03 / `43` §8 D7：引导第⑥步改成必填，但**不改**上面那条判据 ——
    // 家长模式面板与旧客户端的「省略」路径都还依赖「空串 = 没填」。
    test('引导第⑥步：PIN 必填，空串不再等于「跳过」', () {
      expect(validateRequiredParentPin(''), isNotNull);
      expect(validateRequiredParentPin('   '), isNotNull);
      expect(validateRequiredParentPin('123'), isNotNull);
      expect(validateRequiredParentPin('1234567'), isNotNull);
      expect(validateRequiredParentPin('12a4'), isNotNull);
      expect(validateRequiredParentPin('1234'), isNull);
      expect(validateRequiredParentPin('123456'), isNull);
    });

    test('引导第⑥步：空串的文案要说清「为什么不能跳过」（不是一句「请填写」）', () {
      final String? empty = validateRequiredParentPin('');
      expect(empty, contains('5 分钟'));
      expect(empty, contains('家长模式'));
      // 两条判据互不影响：面板里「空输入」仍然是「没填」，不是「格式错」。
      expect(validateParentPin(''), isNull);
    });

    test('模板文案由结构字段派生（不再拼字符串反解析）', () {
      const RuleTemplate template = RuleTemplate(
        slug: 'tidy-desk',
        title: '自己收书包',
        condition: '睡前自己收好书包',
        dailyLimit: 1,
        points: 2,
        isPenalty: false,
        icon: 'backpack',
        color: '#e9834b',
        ageBand: AgeBand.primaryLow,
        focusAreas: <String>['生活习惯'],
        sortWeight: 10,
      );
      expect(template.pointsText, '+2');
      expect(template.frequencyText, '每天最多 1 次');
      expect(template.focusText, '生活习惯');

      const RuleTemplate penalty = RuleTemplate(
        slug: 'talk-back',
        title: '顶嘴',
        condition: '对家人大喊大叫',
        dailyLimit: 1,
        points: 1,
        isPenalty: true,
        icon: 'spray',
        color: '#e9834b',
        ageBand: AgeBand.primaryLow,
        focusAreas: <String>[],
        sortWeight: 0,
      );
      expect(penalty.pointsText, '−1');
      expect(penalty.focusText, '通用');
    });
  });
}


// ------------------------------------------------------------------ 测试替身

/// `GET /onboarding` / `PATCH profile` / `POST complete` 的假传输层。
class _FakeOnboardingTransport implements WriteTransport {
  _FakeOnboardingTransport({
    this.viewBody = '{}',
    this.viewStatus = 200,
    String? stateBody,
    this.completeBody = '{}',
    this.completeStatus = 200,
  }) : stateBody = stateBody ??
            jsonEncode(<String, Object?>{
              'childId': 'child-1',
              'onboarded': false,
              'onboardedAt': null,
              'ageBand': null,
              'focusAreas': <String>[],
            });

  String viewBody;
  int viewStatus;
  String stateBody;
  String completeBody;
  int completeStatus;

  final List<String> calls = <String>[];
  Map<String, Object?> lastBody = <String, Object?>{};
  Map<String, String> lastHeaders = <String, String>{};

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    calls.add('$method ${uri.path}');
    lastHeaders = headers;
    lastBody = body.trim().isEmpty
        ? <String, Object?>{}
        : (jsonDecode(body) as Map<String, Object?>);

    if (uri.path.endsWith('/onboarding/complete')) {
      return WriteHttpResponse(statusCode: completeStatus, body: completeBody);
    }
    if (uri.path.endsWith('/onboarding/profile')) {
      return WriteHttpResponse(statusCode: 200, body: stateBody);
    }
    if (uri.path.endsWith('/onboarding')) {
      return WriteHttpResponse(statusCode: viewStatus, body: viewBody);
    }
    return WriteHttpResponse(
      statusCode: 404,
      body: jsonEncode(<String, Object?>{'code': 'NOT_FOUND'}),
    );
  }

  @override
  void close() {}
}

/// `GET /consent` 的假传输层（引导第①步要读同意状态）。
class _FakeReadTransport implements ReadTransport {
  @override
  Future<ReadHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
  ) async {
    if (uri.path.endsWith('/consent')) {
      return ReadHttpResponse(
        statusCode: 200,
        body: jsonEncode(<String, Object?>{
          'childId': 'child-1',
          'status': 'none',
          'consentVersion': null,
          'grantedAt': null,
          'withdrawnAt': null,
        }),
      );
    }
    return ReadHttpResponse(statusCode: 200, body: '{}');
  }

  @override
  void close() {}
}

/// `POST /consent` 与 `POST /point-rules/:id/habits` 的假传输层。
class _FakeWriteTransport implements WriteTransport {
  final List<String> calls = <String>[];

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    calls.add('$method ${uri.path}');

    if (uri.path.endsWith('/consent')) {
      return WriteHttpResponse(
        statusCode: 200,
        body: jsonEncode(<String, Object?>{
          'childId': 'child-1',
          'status': 'granted',
          'consentVersion': '2026-10-draft',
          'grantedAt': '2026-10-27T08:00:00.000Z',
          'withdrawnAt': null,
        }),
      );
    }
    if (uri.path.endsWith('/habits')) {
      final String ruleId = uri.pathSegments[uri.pathSegments.length - 2];
      return WriteHttpResponse(
        statusCode: 200,
        body: jsonEncode(<String, Object?>{
          'id': 'habit-$ruleId',
          'title': '自己收书包',
          'points': 2,
          'icon': 'backpack',
          'color': '#e9834b',
          'condition': '睡前自己收好书包',
          'dailyLimit': 1,
          'ruleId': ruleId,
        }),
      );
    }
    return WriteHttpResponse(
      statusCode: 404,
      body: jsonEncode(<String, Object?>{'code': 'NOT_FOUND'}),
    );
  }

  @override
  void close() {}
}

