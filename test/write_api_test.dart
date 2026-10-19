import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/data/write_dto.dart';
import 'package:kids_points_app/main.dart';
import 'package:kids_points_app/models/point_rule.dart';

/// W4-E：写端点（打卡 / 撤销）的客户端与 store 行为。
///
/// 这些用例钉住四件事：
///   ① POST 的路径 / body / 身份头 / 幂等头；
///   ② 409 业务码翻成可展示的中文（不能退化成「HTTP 409」）；
///   ③ 201 DTO 的 `executedRecordId` 必须与 `record.id` 一致；
///   ④ live 模式**真的发请求**，失败时内存数据不变、双击不会重复提交。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> recordJson({
    String id = 'record-1',
    String title = '认真刷牙',
    int points = 1,
    String category = 'praise',
    String source = 'guardian',
    String? habitId = 'habit-1',
    String? reversesRecordId,
    int balanceAfter = 11,
    String? createdAt,
  }) {
    return <String, Object?>{
      'id': id,
      'title': title,
      'points': points,
      'category': category,
      'source': source,
      'operatorRole': 'guardian',
      'note': '',
      'habitId': habitId,
      'ruleId': null,
      'ruleVersion': null,
      'wishId': null,
      'reversesRecordId': reversesRecordId,
      'reversedAt': null,
      'balanceAfter': balanceAfter,
      'createdAt': createdAt ?? DateTime.now().toUtc().toIso8601String(),
    };
  }

  String writtenJson({
    String id = 'record-1',
    String? executedRecordId,
    String category = 'praise',
    String source = 'guardian',
    int points = 1,
    String? reversesRecordId,
    int balanceAfter = 11,
  }) {
    return jsonEncode(<String, Object?>{
      'record': recordJson(
        id: id,
        category: category,
        source: source,
        points: points,
        reversesRecordId: reversesRecordId,
        balanceAfter: balanceAfter,
      ),
      'executedRecordId': executedRecordId ?? id,
    });
  }

  Map<String, Object?> ruleJson({
    String id = 'rule-1',
    String title = '每天练琴',
    String condition = '认真练习不断开',
    int points = 2,
    String direction = 'reward',
    String icon = 'book',
    String color = '#7fbf55',
    int dailyLimit = 1,
    int currentVersion = 1,
  }) {
    return <String, Object?>{
      'id': id,
      'title': title,
      'condition': condition,
      'points': points,
      'direction': direction,
      'icon': icon,
      'color': color,
      'dailyLimit': dailyLimit,
      'currentVersion': currentVersion,
    };
  }

  Map<String, Object?> habitJson({
    String id = 'habit-9',
    String title = '每天练琴',
    String? ruleId = 'rule-1',
  }) {
    return <String, Object?>{
      'id': id,
      'title': title,
      'points': 2,
      'icon': 'book',
      'color': '#7fbf55',
      'condition': '认真练习不断开',
      'dailyLimit': 1,
      'ruleId': ruleId,
    };
  }

  group('WriteApiClient：请求形状', () {
    test('打卡 POST /records/check-in：habitId + 身份头 + 幂等键', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(statusCode: 201, body: writtenJson());
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final WrittenRecordDto result =
          await client.checkIn('habit-1', idempotencyKey: 'key-1');

      expect(result.record.id, 'record-1');
      expect(result.executedRecordId, 'record-1');
      expect(transport.calls, hasLength(1));
      final _WriteCall call = transport.calls.single;
      expect(call.uri.path, '/api/records/check-in');
      expect(jsonDecode(call.body), <String, Object?>{'habitId': 'habit-1'});
      expect(call.headers[kDeviceIdHeader], 'device-1');
      expect(call.headers[kChildIdHeader], 'child-1');
      expect(call.headers['idempotency-key'], 'key-1');
      expect(call.headers['content-type'], contains('application/json'));
    });

    test('撤销 POST /records/:id/reverse：备注去空白，空备注不落空串', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: writtenJson(
              id: 'correction-1',
              category: 'adjust',
              source: 'correction',
              points: -1,
              reversesRecordId: 'record-1',
              balanceAfter: 10,
            ),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await client.reverse('record-1', note: '  认真刷牙  ');
      await client.reverse('record-1', note: '   ');

      expect(transport.calls[0].uri.path, '/api/records/record-1/reverse');
      expect(jsonDecode(transport.calls[0].body),
          <String, Object?>{'note': '认真刷牙'});
      expect(jsonDecode(transport.calls[1].body), <String, Object?>{});
    });

    test('未配置时不发请求，直接给可执行说明', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          fail('配置不完整时不得发请求');
        },
      );
      final WriteApiClient client = WriteApiClient(
        config: const ReadApiConfig(
          baseUrl: '',
          deviceId: 'device-1',
          childId: 'child-1',
        ),
        transport: transport,
      );

      await expectLater(
        client.checkIn('habit-1'),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.code,
          'code',
          'CLIENT_NOT_CONFIGURED',
        )),
      );
      expect(transport.calls, isEmpty);
    });
  });

  group('规则写端点（W5-A）：方法 / 路径 / 带符号分值', () {
    test('新建 POST /point-rules：扣分原样发 -3（客户端不取反）', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: jsonEncode(
              ruleJson(points: -3, direction: 'penalty', title: '打人'),
            ),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final RuleDto rule = await client.createRule(
        title: ' 打人 ',
        condition: '  ',
        dailyLimit: 2,
        points: -3,
        icon: 'book',
        color: '#7fbf55',
        idempotencyKey: 'key-rule',
      );

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/point-rules');
      expect(jsonDecode(call.body), <String, Object?>{
        'title': '打人',
        'condition': '',
        'dailyLimit': 2,
        'points': -3,
        'icon': 'book',
        'color': '#7fbf55',
      });
      expect(call.headers['idempotency-key'], 'key-rule');
      expect(call.headers['content-type'], contains('application/json'));
      expect(rule.points, -3);
      expect(rule.direction, 'penalty');
      expect(rule.currentVersion, 1);
    });

    test('编辑 PATCH /point-rules/:id：expectedVersion 随请求发出', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(ruleJson(currentVersion: 3)),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final RuleDto rule = await client.updateRule(
        'rule-1',
        title: '每天练琴',
        condition: '认真练习',
        dailyLimit: 2,
        points: 2,
        expectedVersion: 2,
      );

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'PATCH');
      expect(call.uri.path, '/api/point-rules/rule-1');
      expect(
        (jsonDecode(call.body) as Map<String, Object?>)['expectedVersion'],
        2,
        reason: '乐观锁靠它：客户端只能声明「我改的是第几版」',
      );
      expect(rule.currentVersion, 3);
    });

    test('删除 DELETE /point-rules/:id：无请求体，回包 ruleId 必须一致', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'ruleId': 'rule-1'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      expect(await client.deleteRule('rule-1'), 'rule-1');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'DELETE');
      expect(call.uri.path, '/api/point-rules/rule-1');
      expect(call.body, isEmpty, reason: 'DELETE 不带 body（幂等哈希按 null 算）');

      final _FakeWriteTransport drifted = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'ruleId': 'other'}),
          );
        },
      );
      final WriteApiClient other = WriteApiClient(
        config: config,
        transport: drifted,
      );
      await expectLater(
        other.deleteRule('rule-1'),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.kind,
          'kind',
          WriteFailureKind.malformed,
        )),
      );
    });

    test('加入习惯 POST /point-rules/:id/habits：解析 HabitDto，保留 ruleId', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: jsonEncode(habitJson()),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final HabitDto habit = await client.addHabitFromRule('rule-1');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/point-rules/rule-1/habits');
      expect(call.body, isEmpty, reason: '目标规则已在路径里，不需要 body');
      expect(habit.id, 'habit-9');
      expect(habit.ruleId, 'rule-1');
    });

    test('回包缺字段 ⇒ malformed，不把坏数据塞进 UI', () async {
      final Map<String, Object?> broken = ruleJson()
        ..remove('currentVersion');
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: jsonEncode(broken),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.createRule(
          title: '练琴',
          condition: '',
          dailyLimit: 1,
          points: 1,
          icon: 'book',
          color: '#7fbf55',
        ),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.kind,
          'kind',
          WriteFailureKind.malformed,
        )),
      );
    });
  });

  group('WriteApiException：业务码优先于状态码', () {
    test('409 每日上限 → conflict + 面向用户的文案', () {
      final WriteApiException error = WriteApiException.fromHttp(
        statusCode: 409,
        body: <String, Object?>{
          'code': 'HABIT_DAILY_LIMIT_REACHED',
          'message': 'already reached',
        },
      );
      expect(error.kind, WriteFailureKind.conflict);
      expect(error.code, 'HABIT_DAILY_LIMIT_REACHED');
      expect(error.userMessage, contains('次数已经用完'));
      expect(error.isRetryable, isFalse, reason: '409 原样重试只会再被拒一次');
    });

    test('404 区分习惯 / 流水，不冒充「孩子档案不存在」', () {
      final WriteApiException habit = WriteApiException.fromHttp(
        statusCode: 404,
        body: <String, Object?>{'code': 'HABIT_NOT_FOUND'},
      );
      final WriteApiException record = WriteApiException.fromHttp(
        statusCode: 404,
        body: <String, Object?>{'code': 'RECORD_NOT_FOUND'},
      );
      expect(habit.kind, WriteFailureKind.notFound);
      expect(habit.userMessage, contains('习惯'));
      expect(record.userMessage, contains('打卡记录'));
    });
  });

  group('WrittenRecordDto：解析失败必须显式', () {
    test('executedRecordId 与 record.id 不一致 ⇒ malformed', () {
      expect(
        () => WrittenRecordDto.fromJson(
          jsonDecode(writtenJson(executedRecordId: 'other')),
        ),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.kind,
          'kind',
          WriteFailureKind.malformed,
        )),
      );
    });

    test('缺 executedRecordId ⇒ malformed', () {
      final Map<String, Object?> raw =
          jsonDecode(writtenJson()) as Map<String, Object?>;
      raw.remove('executedRecordId');
      expect(
        () => WrittenRecordDto.fromJson(raw),
        throwsA(isA<WriteApiException>()),
      );
    });
  });

  group('AppStore live 写入口', () {
    late _ScriptedReadTransport readTransport;
    late _FakeWriteApi writeApi;

    String homeJson({
      int points = 11,
      List<Object?>? rules,
      List<Object?>? habits,
    }) =>
        jsonEncode(<String, Object?>{
          'child': <String, Object?>{
            'id': 'child-1',
            'name': '小明',
            'pointsBalance': points,
          },
          'goodHabitCount': 1,
          'rewardCount': 0,
          'habits': habits ??
              <Object?>[
                <String, Object?>{
                  'id': 'habit-1',
                  'title': '认真刷牙',
                  'points': 1,
                  'icon': 'spray',
                  'color': '#7fbf55',
                  'condition': '早晚各一次',
                  'dailyLimit': 2,
                  'ruleId': null,
                },
              ],
          'rules': rules ?? <Object?>[],
          'wishes': <Object?>[],
        });

    String pageJson(List<Object?> records) => jsonEncode(<String, Object?>{
          'records': records,
          'limit': 50,
          'hasMore': false,
          'nextCursor': null,
        });

    setUp(() {
      readTransport = _ScriptedReadTransport(
        homeJson: homeJson(),
        pageJson: pageJson(<Object?>[]),
      );
      writeApi = _FakeWriteApi();
    });

    AppStore buildStore() {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
        writeApi: writeApi,
      );
      addTearDown(store.dispose);
      return store;
    }

    test('打卡成功：真实 POST + 幂等键，随后用服务端快照刷新', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      writeApi.checkInResult = WrittenRecordDto.fromJson(
        jsonDecode(writtenJson()),
      );
      readTransport.pageJson = pageJson(<Object?>[
        recordJson(id: 'record-1', balanceAfter: 11),
      ]);

      final String? message = await store.submitCheckIn(store.habits.single);

      expect(message, isNull);
      expect(writeApi.checkInCalls, 1);
      expect(writeApi.lastHabitId, 'habit-1');
      expect(writeApi.lastIdempotencyKey, isNotNull);
      expect(store.records.single.id, 'record-1');
      expect(store.points, 11);
    });

    test('服务端拒绝：返回可读原因，内存余额与流水不变', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final int beforePoints = store.points;
      final int beforeRecords = store.records.length;
      writeApi.checkInError =
          WriteApiException(WriteFailureKind.conflict, '这个习惯今天的次数已经用完啦');

      final String? message = await store.submitCheckIn(store.habits.single);

      expect(message, '这个习惯今天的次数已经用完啦');
      expect(store.points, beforePoints);
      expect(store.records.length, beforeRecords);
    });

    test('双击串行：第二次直接返回“正在保存”，只发一次请求', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final Completer<WrittenRecordDto> gate = Completer<WrittenRecordDto>();
      writeApi.checkInGate = gate;

      final Future<String?> first = store.submitCheckIn(store.habits.single);
      final String? second = await store.submitCheckIn(store.habits.single);

      expect(second, contains('正在保存'));
      expect(writeApi.checkInCalls, 1);

      gate.complete(WrittenRecordDto.fromJson(jsonDecode(writtenJson())));
      expect(await first, isNull);
    });

    test('撤销：用今天未冲正的记录 id 发 POST，成功返回 null', () async {
      final AppStore store = buildStore();
      final String today = DateTime.now().toUtc().toIso8601String();
      readTransport.pageJson = pageJson(<Object?>[
        recordJson(id: 'record-1', createdAt: today),
      ]);
      await store.refreshFromServer();
      writeApi.reverseResult = WrittenRecordDto.fromJson(
        jsonDecode(writtenJson(
          id: 'correction-1',
          category: 'adjust',
          source: 'correction',
          points: -1,
          reversesRecordId: 'record-1',
          balanceAfter: 10,
        )),
      );

      final String? message =
          await store.submitUndoCheckIn(store.habits.single);

      expect(message, isNull);
      expect(writeApi.reverseCalls, 1);
      expect(writeApi.lastRecordId, 'record-1');
      expect(writeApi.lastNote, '认真刷牙');
    });

    test('撤销：当前页没有目标时，单独取不分类流水定位', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      readTransport.pageJson = pageJson(<Object?>[
        recordJson(id: 'record-1'),
      ]);
      writeApi.reverseResult = WrittenRecordDto.fromJson(
        jsonDecode(writtenJson(
          id: 'correction-1',
          category: 'adjust',
          source: 'correction',
          points: -1,
          reversesRecordId: 'record-1',
          balanceAfter: 10,
        )),
      );

      final String? message =
          await store.submitUndoCheckIn(store.habits.single);

      expect(message, isNull);
      expect(writeApi.lastRecordId, 'record-1');
      final Uri lookup = readTransport.recordCalls
          .firstWhere((Uri uri) => uri.queryParameters['limit'] == '200');
      expect(lookup.queryParameters.containsKey('category'), isFalse,
          reason: '必须同时看到 praise 与 adjust（冲正）才能判断是否已撤销');
    });

    test('live 但没注入写客户端：拒绝写，不偷偷改内存', () async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
      );
      addTearDown(store.dispose);
      await store.refreshFromServer();
      final int beforePoints = store.points;

      final String? message = await store.submitCheckIn(store.habits.single);

      expect(store.isCheckInReadOnly, isTrue);
      expect(message, contains('没有接上后端'));
      expect(store.points, beforePoints);
    });

    test('规则新建：live 下走 POST，扣分不被二次取反', () async {
      readTransport.homeJson = homeJson(
        rules: <Object?>[
          ruleJson(points: -3, direction: 'penalty', title: '打人'),
        ],
      );
      final AppStore store = buildStore();
      await store.refreshFromServer();
      expect(store.isRuleWriteReadOnly, isFalse);
      writeApi.createRuleResult = RuleDto.fromJson(
        ruleJson(points: -3, direction: 'penalty', title: '打人'),
        r'$',
      );

      final String? message = await store.submitAddRule(
        title: '打人',
        condition: '',
        dailyLimit: 2,
        points: -3,
        iconName: 'book',
        color: const Color(0xFF7FBF55),
      );

      expect(message, isNull);
      expect(writeApi.createRuleCalls, 1);
      expect(writeApi.lastPoints, -3);
      expect(writeApi.lastColor, '#7fbf55');
      expect(store.rules.single.id, 'rule-1');
      expect(store.rules.single.points, -3,
          reason: '服务端回包已带符号，客户端只能转换一次');
    });

    test('规则编辑：expectedVersion 取界面版本，成功后本地跟到新版本', () async {
      readTransport.homeJson = homeJson(rules: <Object?>[ruleJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final PointRule rule = store.rules.single;
      writeApi.updateRuleResult = RuleDto.fromJson(
        ruleJson(title: '每天练琴 20 分钟', currentVersion: 2),
        r'$',
      );
      readTransport.homeJson = homeJson(
        rules: <Object?>[
          ruleJson(title: '每天练琴 20 分钟', currentVersion: 2),
        ],
      );

      final String? message = await store.submitUpdateRule(
        rule,
        title: '每天练琴 20 分钟',
        condition: '认真练习不断开',
        dailyLimit: 1,
        points: 2,
      );

      expect(message, isNull);
      expect(writeApi.lastExpectedVersion, 1);
      expect(writeApi.lastRuleId, 'rule-1');
      expect(store.rules.single.currentVersion, 2);
    });

    test('规则编辑冲突：409 文案交给界面，本地版本不动', () async {
      readTransport.homeJson = homeJson(rules: <Object?>[ruleJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      writeApi.ruleError = WriteApiException(
        WriteFailureKind.conflict,
        '这条规则刚被别人改过，请刷新后再改',
        code: 'RULE_VERSION_CONFLICT',
      );

      final String? message = await store.submitUpdateRule(
        store.rules.single,
        title: '每天练琴',
        condition: '认真练习不断开',
        dailyLimit: 1,
        points: 2,
      );

      expect(message, contains('刚被别人改过'));
      expect(store.rules.single.currentVersion, 1);
    });

    test('规则删除：调 DELETE /point-rules/:id，本地不再出现在规则页', () async {
      readTransport.homeJson = homeJson(rules: <Object?>[ruleJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      readTransport.homeJson = homeJson(); // 服务端视角：已经软删

      final String? message = await store.submitRemoveRule(store.rules.single);

      expect(message, isNull);
      expect(writeApi.deleteRuleCalls, 1);
      expect(writeApi.lastRuleId, 'rule-1');
      expect(store.rules, isEmpty);
    });

    test('加入今天的习惯：POST 生成，习惯记得来自哪条规则', () async {
      readTransport.homeJson = homeJson(rules: <Object?>[ruleJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      writeApi.addHabitResult = HabitDto.fromJson(habitJson(), r'$');
      readTransport.homeJson = homeJson(
        rules: <Object?>[ruleJson()],
        habits: <Object?>[habitJson()],
      );

      final String? message =
          await store.submitAddHabitFromRule(store.rules.single);

      expect(message, isNull);
      expect(writeApi.addHabitCalls, 1);
      expect(writeApi.lastRuleId, 'rule-1');
      expect(store.habits.single.ruleId, 'rule-1');
    });
  });

  testWidgets('live 首页：点习惯会调用写端点，不再显示只读拦截', (WidgetTester tester) async {
    final _ScriptedReadTransport readTransport = _ScriptedReadTransport(
      homeJson: jsonEncode(<String, Object?>{
        'child': <String, Object?>{
          'id': 'child-1',
          'name': '小明',
          'pointsBalance': 10,
        },
        'goodHabitCount': 0,
        'rewardCount': 0,
        'habits': <Object?>[
          <String, Object?>{
            'id': 'habit-1',
            'title': '认真刷牙',
            'points': 1,
            'icon': 'spray',
            'color': '#7fbf55',
            'condition': '早晚各一次',
            'dailyLimit': 2,
            'ruleId': null,
          },
        ],
        'rules': <Object?>[],
        'wishes': <Object?>[],
      }),
      pageJson: jsonEncode(<String, Object?>{
        'records': <Object?>[],
        'limit': 50,
        'hasMore': false,
        'nextCursor': null,
      }),
    );
    final _FakeWriteApi writeApi = _FakeWriteApi()
      ..checkInResult = WrittenRecordDto.fromJson(jsonDecode(writtenJson()));
    final AppStore store = AppStore(
      readApi: ReadApiClient(config: config, transport: readTransport),
      writeApi: writeApi,
    );
    addTearDown(store.dispose);

    await tester.pumpWidget(PointsApp(store: store));
    await tester.pumpAndSettle();
    expect(find.text('数据来自服务器 · 打卡与撤销会实时保存'), findsOneWidget);

    await tester.tap(find.text('认真刷牙'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(writeApi.checkInCalls, 1, reason: 'live 模式必须真的写服务端');
    expect(find.textContaining('太棒了'), findsOneWidget);
  });
}

class _WriteCall {
  _WriteCall(this.method, this.uri, this.headers, this.body);

  final String method;
  final Uri uri;
  final Map<String, String> headers;
  final String body;
}

class _FakeWriteTransport implements WriteTransport {
  _FakeWriteTransport(this.handler);

  final Future<WriteHttpResponse> Function(
    Uri uri,
    Map<String, String> headers,
    String body,
  ) handler;
  final List<_WriteCall> calls = <_WriteCall>[];

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) {
    calls.add(_WriteCall(method, uri, Map<String, String>.from(headers), body));
    return handler(uri, headers, body);
  }

  @override
  void close() {}
}

class _FakeWriteApi implements WriteApi {
  int checkInCalls = 0;
  int reverseCalls = 0;
  int createRuleCalls = 0;
  int updateRuleCalls = 0;
  int deleteRuleCalls = 0;
  int addHabitCalls = 0;
  String? lastHabitId;
  String? lastIdempotencyKey;
  String? lastRecordId;
  String? lastNote;
  String? lastRuleId;
  String? lastTitle;
  String? lastCondition;
  String? lastIcon;
  String? lastColor;
  int? lastDailyLimit;
  int? lastPoints;
  int? lastExpectedVersion;
  WrittenRecordDto? checkInResult;
  WrittenRecordDto? reverseResult;
  RuleDto? createRuleResult;
  RuleDto? updateRuleResult;
  HabitDto? addHabitResult;
  String? deleteRuleResult;
  Object? checkInError;
  Object? ruleError;
  Completer<WrittenRecordDto>? checkInGate;

  @override
  Future<WrittenRecordDto> checkIn(
    String habitId, {
    String? idempotencyKey,
  }) async {
    checkInCalls += 1;
    lastHabitId = habitId;
    lastIdempotencyKey = idempotencyKey;
    if (checkInGate != null) return checkInGate!.future;
    if (checkInError != null) throw checkInError!;
    return checkInResult!;
  }

  @override
  Future<WrittenRecordDto> reverse(
    String recordId, {
    String? idempotencyKey,
    String? note,
  }) async {
    reverseCalls += 1;
    lastRecordId = recordId;
    lastNote = note;
    return reverseResult!;
  }

  @override
  Future<RuleDto> createRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String icon,
    required String color,
    String? idempotencyKey,
  }) async {
    createRuleCalls += 1;
    lastTitle = title;
    lastCondition = condition;
    lastDailyLimit = dailyLimit;
    lastPoints = points;
    lastIcon = icon;
    lastColor = color;
    lastIdempotencyKey = idempotencyKey;
    if (ruleError != null) throw ruleError!;
    return createRuleResult!;
  }

  @override
  Future<RuleDto> updateRule(
    String ruleId, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required int expectedVersion,
    String? idempotencyKey,
  }) async {
    updateRuleCalls += 1;
    lastRuleId = ruleId;
    lastTitle = title;
    lastPoints = points;
    lastExpectedVersion = expectedVersion;
    lastIdempotencyKey = idempotencyKey;
    if (ruleError != null) throw ruleError!;
    return updateRuleResult!;
  }

  @override
  Future<String> deleteRule(
    String ruleId, {
    String? idempotencyKey,
  }) async {
    deleteRuleCalls += 1;
    lastRuleId = ruleId;
    lastIdempotencyKey = idempotencyKey;
    if (ruleError != null) throw ruleError!;
    return deleteRuleResult ?? ruleId;
  }

  @override
  Future<HabitDto> addHabitFromRule(
    String ruleId, {
    String? idempotencyKey,
  }) async {
    addHabitCalls += 1;
    lastRuleId = ruleId;
    lastIdempotencyKey = idempotencyKey;
    if (ruleError != null) throw ruleError!;
    return addHabitResult!;
  }

  @override
  void close() {}
}

class _ScriptedReadTransport implements ReadTransport {
  _ScriptedReadTransport({required this.homeJson, required this.pageJson});

  /// 可变：写入口成功后 `AppStore` 会重新拉 `/home`，
  /// 测试里直接在提交前把它改成「服务端此刻的样子」。
  String homeJson;
  String pageJson;
  final List<Uri> recordCalls = <Uri>[];

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    if (uri.path.endsWith('/home')) {
      return ReadHttpResponse(statusCode: 200, body: homeJson);
    }
    recordCalls.add(uri);
    return ReadHttpResponse(statusCode: 200, body: pageJson);
  }

  @override
  void close() {}
}
