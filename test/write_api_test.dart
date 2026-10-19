import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/data/write_dto.dart';
import 'package:kids_points_app/main.dart';

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

    String homeJson({int points = 11}) => jsonEncode(<String, Object?>{
          'child': <String, Object?>{
            'id': 'child-1',
            'name': '小明',
            'pointsBalance': points,
          },
          'goodHabitCount': 1,
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
  _WriteCall(this.uri, this.headers, this.body);

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
    String body,
  ) {
    calls.add(_WriteCall(uri, Map<String, String>.from(headers), body));
    return handler(uri, headers, body);
  }

  @override
  void close() {}
}

class _FakeWriteApi implements WriteApi {
  int checkInCalls = 0;
  int reverseCalls = 0;
  String? lastHabitId;
  String? lastIdempotencyKey;
  String? lastRecordId;
  String? lastNote;
  WrittenRecordDto? checkInResult;
  WrittenRecordDto? reverseResult;
  Object? checkInError;
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
  void close() {}
}

class _ScriptedReadTransport implements ReadTransport {
  _ScriptedReadTransport({required this.homeJson, required this.pageJson});

  final String homeJson;
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
