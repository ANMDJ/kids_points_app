import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/main.dart';
import 'package:kids_points_app/models/point_record.dart';

/// W4-B：`GET /records` 的游标分页 —— 客户端只做两件事：
///   ① 把 `nextCursor` **原样**回传（不自己拼时间戳 / offset）；
///   ② 失败时**保留**已加载的页，不把错误显示成「没有更多」。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> record(String id, String createdAt) => <String, Object?>{
        'id': id,
        'title': '记录 $id',
        'points': 1,
        'createdAt': createdAt,
        'category': 'praise',
        'source': 'child_self',
        'operatorRole': null,
        'note': '',
        'habitId': null,
        'ruleId': null,
        'ruleVersion': null,
        'wishId': null,
        'reversesRecordId': null,
        'reversedAt': null,
        'balanceAfter': 1,
      };

  final String homeJson = jsonEncode(<String, Object?>{
    'child': <String, Object?>{
      'id': 'child-1',
      'name': '小明',
      'pointsBalance': 7,
    },
    'goodHabitCount': 2,
    'rewardCount': 1,
    'habits': <Object?>[],
    'rules': <Object?>[],
    'wishes': <Object?>[],
  });

  String pageJson({
    required List<Object?> records,
    required bool hasMore,
    String? nextCursor,
    int limit = 50,
  }) =>
      jsonEncode(<String, Object?>{
        'records': records,
        'limit': limit,
        'hasMore': hasMore,
        'nextCursor': nextCursor,
      });

  group('RecordsPageDto：hasMore 与 nextCursor 必须自洽', () {
    test('hasMore=true 但没有游标 ⇒ malformed（否则客户端无法取下一页）', () {
      expect(
        () => RecordsPageDto.fromJson(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': true,
          'nextCursor': null,
        }),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.kind,
          'kind',
          ReadFailureKind.malformed,
        )),
      );
    });

    test('hasMore=false 却给了游标 ⇒ malformed（否则会出现「还有下一页」的假象）', () {
      expect(
        () => RecordsPageDto.fromJson(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': 'abc',
        }),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('nextCursor 类型不对 ⇒ malformed（不把数字猜成字符串）', () {
      expect(
        () => RecordsPageDto.fromJson(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': 123,
        }),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.userMessage,
          'userMessage',
          contains('nextCursor'),
        )),
      );
    });
  });

  group('ReadApiClient.fetchRecords：游标原样回传', () {
    test('第一页不带 cursor；第二页带服务端给的 cursor，并带两个身份头', () async {
      final List<Uri> calls = <Uri>[];
      final _FakeTransport transport = _FakeTransport((Uri uri) async {
        calls.add(uri);
        return ReadHttpResponse(
          statusCode: 200,
          body: pageJson(
            records: <Object?>[],
            hasMore: false,
            nextCursor: null,
          ),
        );
      });
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      await client.fetchRecords(limit: 20);
      await client.fetchRecords(limit: 20, cursor: 'CUR/1+2=');

      expect(calls[0].queryParameters.containsKey('cursor'), isFalse);
      expect(calls[1].queryParameters['cursor'], 'CUR/1+2=');
      expect(calls[1].queryParameters['limit'], '20');
      expect(transport.headers[0][kDeviceIdHeader], 'device-1');
      expect(transport.headers[0][kChildIdHeader], 'child-1');
      expect(
          transport.headers[0][HttpHeaders.acceptHeader], 'application/json');
    });

    test('limit 越界在发请求前就拒绝（与后端 1–200 同口径）', () {
      final ReadApiClient client = ReadApiClient(
        config: config,
        transport: _FakeTransport(
            (Uri uri) async => ReadHttpResponse(statusCode: 200, body: '{}')),
      );
      expect(() => client.fetchRecords(limit: 0), throwsArgumentError);
      expect(() => client.fetchRecords(limit: 201), throwsArgumentError);
    });
  });

  group('AppStore：keyset 加载更多', () {
    test('第二页用第一页的 nextCursor 请求；不重复、不遗漏；到底后停止', () async {
      final _ScriptedTransport transport = _ScriptedTransport(
        homeJson: homeJson,
        pages: <String, String>{
          '': pageJson(
            records: <Object?>[
              record('r1', '2026-10-19T10:00:00.000Z'),
              record('r2', '2026-10-19T09:00:00.000Z'),
            ],
            hasMore: true,
            nextCursor: 'CUR-1',
          ),
          'CUR-1': pageJson(
            records: <Object?>[record('r3', '2026-10-19T08:00:00.000Z')],
            hasMore: false,
            nextCursor: null,
          ),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshFromServer();

      expect(store.isLiveMode, isTrue);
      expect(store.isReadOnly, isTrue);
      expect(store.readStatus, ReadStatus.ready);
      expect(store.points, 7);
      expect(store.profile.name, '小明');
      expect(store.records.map((PointRecord r) => r.id), <String>['r1', 'r2']);
      expect(store.hasMoreRecords, isTrue);

      await store.loadMoreRecords();

      expect(store.records.map((PointRecord r) => r.id),
          <String>['r1', 'r2', 'r3']);
      expect(store.hasMoreRecords, isFalse);
      expect(store.readStatus, ReadStatus.ready);
      expect(transport.recordCursors, <String?>[null, 'CUR-1']);

      // 到底后再点「加载更多」不会发第三次请求，也不会把上一页再拼一次。
      final int calls = transport.recordCursors.length;
      await store.loadMoreRecords();
      expect(transport.recordCursors.length, calls);
      expect(store.records.length, 3);
    });

    test('加载更多失败：保留已加载的页并暴露错误；重试仍用同一个游标', () async {
      final _ScriptedTransport transport = _ScriptedTransport(
        homeJson: homeJson,
        pages: <String, String>{
          '': pageJson(
            records: <Object?>[record('r1', '2026-10-19T10:00:00.000Z')],
            hasMore: true,
            nextCursor: 'CUR-1',
          ),
          'CUR-1': pageJson(
            records: <Object?>[record('r2', '2026-10-19T09:00:00.000Z')],
            hasMore: false,
            nextCursor: null,
          ),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshFromServer();
      expect(store.records.length, 1);

      // 第一页成功之后再让下一页断网：错误必须发生在「追加」这一步。
      transport.failNextRecords = true;
      await store.loadMoreRecords();

      expect(store.readStatus, ReadStatus.error);
      expect(store.readError?.kind, ReadFailureKind.network);
      expect(store.records.map((PointRecord r) => r.id), <String>['r1']);
      expect(store.hasMoreRecords, isTrue);
      expect(store.usingPreview, isFalse);

      await store.loadMoreRecords();

      expect(store.readStatus, ReadStatus.ready);
      expect(store.records.map((PointRecord r) => r.id), <String>['r1', 'r2']);
      expect(store.hasMoreRecords, isFalse);
      expect(transport.recordCursors, <String?>[null, 'CUR-1', 'CUR-1']);
    });

    test('切换分类：重新从服务端取第一页（带 category），不复用旧游标', () async {
      final _ScriptedTransport transport = _ScriptedTransport(
        homeJson: homeJson,
        pages: <String, String>{
          '': pageJson(
            records: <Object?>[record('r1', '2026-10-19T10:00:00.000Z')],
            hasMore: true,
            nextCursor: 'CUR-1',
          ),
          'praise': pageJson(
            records: <Object?>[record('r9', '2026-10-18T10:00:00.000Z')],
            hasMore: false,
            nextCursor: null,
          ),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshFromServer();
      await store.setRecordFilter(RecordCategory.praise);

      expect(store.recordFilter, RecordCategory.praise);
      expect(store.records.map((PointRecord r) => r.id), <String>['r9']);
      expect(store.hasMoreRecords, isFalse);
      expect(transport.categories, <String?>[null, 'praise']);
      expect(transport.recordCursors, <String?>[null, null]);
    });
    test('首屏未完成时切分类：旧分类响应作废，按新分类取第一页', () async {
      final Completer<void> gate = Completer<void>();
      final _ScriptedTransport transport = _ScriptedTransport(
        homeJson: homeJson,
        firstHomeGate: gate,
        pages: <String, String>{
          '': pageJson(
            records: <Object?>[
              record('r1', '2026-10-19T10:00:00.000Z'),
              record('r2', '2026-10-19T09:00:00.000Z'),
              record('r3', '2026-10-19T08:00:00.000Z'),
            ],
            hasMore: false,
            nextCursor: null,
          ),
          'praise': pageJson(
            records: <Object?>[record('r9', '2026-10-18T10:00:00.000Z')],
            hasMore: false,
            nextCursor: null,
          ),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      final Future<void> initial = store.refreshFromServer();
      await store.setRecordFilter(RecordCategory.praise);

      expect(store.recordFilter, RecordCategory.praise);
      expect(store.usingPreview, isFalse);
      expect(store.records.map((PointRecord r) => r.id), <String>['r9'],
          reason: '新分类的第一页应立即可见');

      gate.complete();
      await initial;

      expect(store.records.map((PointRecord r) => r.id), <String>['r9'],
          reason: '旧分类的响应回来晚了一步，也不许覆盖新分类列表');
      expect(store.readStatus, ReadStatus.ready);
      expect(transport.categories, <String?>[null, 'praise']);
    });
  });

  testWidgets('live 模式：首帧后自动拉取，并显示「只读模式」而不是空态', (WidgetTester tester) async {
    final _ScriptedTransport transport = _ScriptedTransport(
      homeJson: homeJson,
      pages: <String, String>{
        '': pageJson(
          records: <Object?>[],
          hasMore: false,
          nextCursor: null,
        ),
      },
    );
    final AppStore store = AppStore(
      readApi: ReadApiClient(config: config, transport: transport),
    );
    addTearDown(store.dispose);

    await tester.pumpWidget(PointsApp(store: store));
    await tester.pumpAndSettle();

    expect(store.readStatus, ReadStatus.ready);
    expect(find.text('只读模式 · 数据来自服务器（写入接口尚未接入）'), findsOneWidget);
    expect(find.text('当前可用积分'), findsOneWidget);

    // live 模式点「记一笔」：必须明确拒绝，而不是打开一个只改内存的表单。
    final Finder quickNote = find.text('记一笔');
    await tester.scrollUntilVisible(
      quickNote,
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(quickNote);
    await tester.pump();
    expect(find.text(store.readOnlyWriteMessage), findsOneWidget);
  });
}

/// 按 `cursor` / `category` 选脚本响应的假传输层。
class _ScriptedTransport implements ReadTransport {
  _ScriptedTransport({
    required this.homeJson,
    required this.pages,
    this.firstHomeGate,
  });

  final String homeJson;

  /// key：`''` = 第一页；其余为 cursor 或分类名（见 `send`）。
  final Map<String, String> pages;

  /// 只挂起**第一次** `/home`，用于复现「首屏未完成就切分类」的竞态。
  final Completer<void>? firstHomeGate;
  int _homeCalls = 0;

  final List<String?> recordCursors = <String?>[];
  final List<String?> categories = <String?>[];
  bool failNextRecords = false;

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    if (uri.path.endsWith('/home')) {
      _homeCalls += 1;
      if (_homeCalls == 1 && firstHomeGate != null) {
        await firstHomeGate!.future;
      }
      return ReadHttpResponse(statusCode: 200, body: homeJson);
    }
    if (!uri.path.endsWith('/records')) {
      return ReadHttpResponse(statusCode: 404, body: '{"code":"NOT_FOUND"}');
    }

    final String? cursor = uri.queryParameters['cursor'];
    final String? category = uri.queryParameters['category'];
    recordCursors.add(cursor);
    categories.add(category);

    if (failNextRecords) {
      failNextRecords = false;
      throw const SocketException('模拟断网');
    }

    final String key = cursor ?? category ?? '';
    final String? body = pages[key] ?? pages[category ?? ''] ?? pages[''];
    if (body == null) {
      return ReadHttpResponse(statusCode: 404, body: '{"code":"NOT_FOUND"}');
    }
    return ReadHttpResponse(statusCode: 200, body: body);
  }

  @override
  void close() {}
}

class _FakeTransport implements ReadTransport {
  _FakeTransport(this.handler);

  final Future<ReadHttpResponse> Function(Uri uri) handler;
  final List<Map<String, String>> headers = <Map<String, String>>[];

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> requestHeaders) {
    headers.add(requestHeaders);
    return handler(uri);
  }

  @override
  void close() {}
}
