import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/data/read_mapper.dart';
import 'package:kids_points_app/main.dart';
import 'package:kids_points_app/models/consent.dart';
import 'package:kids_points_app/models/point_record.dart';
import 'package:kids_points_app/models/trash.dart';

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

  group('通知 DTO / ReadApiClient.fetchNotifications（W5-L）', () {
    Map<String, Object?> notificationJson({
      String id = 'n-1',
      String type = 'approval.approved',
      String title = '申请通过了',
      String body = '「去动物园」已经通过',
      Object? payload = const <String, Object?>{'approvalId': 'ap-1'},
      String? readAt,
      String createdAt = '2026-10-23T02:00:00.000Z',
    }) =>
        <String, Object?>{
          'id': id,
          'type': type,
          'title': title,
          'body': body,
          'payload': payload,
          'readAt': readAt,
          'createdAt': createdAt,
        };

    String notificationsPageJson({
      List<Map<String, Object?>> items = const <Map<String, Object?>>[],
      bool hasMore = false,
      String? nextCursor,
      int unreadCount = 0,
    }) =>
        jsonEncode(<String, Object?>{
          'items': items,
          'hasMore': hasMore,
          'nextCursor': nextCursor,
          'unreadCount': unreadCount,
        });

    test('GET /notifications：limit 必带、cursor 原样回传、带两个身份头', () async {
      final List<Uri> calls = <Uri>[];
      final _FakeTransport transport = _FakeTransport((Uri uri) async {
        calls.add(uri);
        return ReadHttpResponse(
          statusCode: 200,
          body: notificationsPageJson(),
        );
      });
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      await client.fetchNotifications();
      await client.fetchNotifications(limit: 5, cursor: 'CUR/1+2=');

      expect(calls[0].path, '/api/notifications');
      expect(calls[0].queryParameters['limit'], '20');
      expect(calls[0].queryParameters.containsKey('cursor'), isFalse);
      expect(calls[1].queryParameters['limit'], '5');
      expect(calls[1].queryParameters['cursor'], 'CUR/1+2=');
      // 收件人恒为会话本人：请求里没有「看谁的」这种参数。
      expect(calls[1].queryParameters.containsKey('recipientUserId'), isFalse);
      expect(transport.headers[0][kDeviceIdHeader], 'device-1');
      expect(transport.headers[0][kChildIdHeader], 'child-1');
    });

    test('limit 越界在发请求前就拒绝（与后端 1–100 同口径）', () async {
      final _FakeTransport transport = _FakeTransport(
        (Uri uri) async => ReadHttpResponse(statusCode: 200, body: '{}'),
      );
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      expect(() => client.fetchNotifications(limit: 0), throwsArgumentError);
      expect(() => client.fetchNotifications(limit: 101), throwsArgumentError);
      expect(transport.headers, isEmpty);
    });

    test('未读只由 readAt==null 推导；读不懂的 payload 不影响这行被列出', () async {
      final _FakeTransport transport = _FakeTransport(
        (Uri uri) async => ReadHttpResponse(
          statusCode: 200,
          body: notificationsPageJson(
            unreadCount: 1,
            items: <Map<String, Object?>>[
              notificationJson(),
              notificationJson(
                id: 'n-2',
                type: 'approval.rejected',
                readAt: '2026-10-23T03:00:00.000Z',
                // 服务端加新字段 / 结构变化时不能把整行吞掉。
                payload: 'not-an-object',
              ),
              // 未知 type 也要列出来（老客户端不认类型，但标题正文可读）。
              notificationJson(id: 'n-3', type: 'system.announcement'),
            ],
          ),
        ),
      );
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      final NotificationsPageDto page = await client.fetchNotifications();

      expect(page.unreadCount, 1);
      expect(page.items.map((NotificationDto item) => item.id),
          <String>['n-1', 'n-2', 'n-3']);
      expect(page.items[0].isUnread, isTrue);
      expect(page.items[0].approvalId, 'ap-1');
      expect(page.items[1].isUnread, isFalse);
      expect(page.items[1].readAt, DateTime.utc(2026, 10, 23, 3));
      expect(page.items[1].payload, isNull);
      expect(page.items[1].approvalId, isNull);
      expect(page.items[0].createdAt.isUtc, isTrue);
    });

    test('hasMore 无游标 / 未读数为负 ⇒ malformed（不猜成 0 / 空页）', () {
      expect(
        () => NotificationsPageDto.fromJson(<String, Object?>{
          'items': <Object?>[],
          'hasMore': true,
          'nextCursor': null,
          'unreadCount': 0,
        }),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.kind,
          'kind',
          ReadFailureKind.malformed,
        )),
      );
      expect(
        () => NotificationsPageDto.fromJson(<String, Object?>{
          'items': <Object?>[],
          'hasMore': false,
          'nextCursor': null,
          'unreadCount': -1,
        }),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.userMessage,
          'userMessage',
          contains('unreadCount'),
        )),
      );
    });
  });


  group('ReadApiClient.fetchTrash / mapTrash：回收站（W5-F）', () {
    String trashJson(List<Map<String, Object?>> items) =>
        jsonEncode(<String, Object?>{'items': items});

    test('GET /trash：解析三类条目，并把 deletedAt 原样交给展示层', () async {
      final List<Uri> calls = <Uri>[];
      final _FakeTransport transport = _FakeTransport((Uri uri) async {
        calls.add(uri);
        return ReadHttpResponse(
          statusCode: 200,
          body: trashJson(<Map<String, Object?>>[
            <String, Object?>{
              'kind': 'point_rule',
              'id': 'rule-1',
              'title': '按时睡觉',
              'deletedAt': '2026-10-20T08:00:00.000Z',
            },
            <String, Object?>{
              'kind': 'wish',
              'id': 'wish-1',
              'title': '去动物园',
              'deletedAt': '2026-10-21T08:00:00.000Z',
            },
            <String, Object?>{
              'kind': 'habit',
              'id': 'habit-1',
              'title': '每天练琴',
              'deletedAt': '2026-10-19T08:00:00.000Z',
            },
          ]),
        );
      });
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      final TrashListDto dto = await client.fetchTrash();

      expect(calls.single.path, '/api/trash');
      expect(
        dto.items.map((TrashItemDto item) => item.kind),
        <String>['point_rule', 'wish', 'habit'],
      );
      expect(dto.items.first.deletedAt.isUtc, isTrue);

      final List<TrashItem> rows = mapTrash(
        dto,
        now: DateTime.utc(2026, 10, 21, 12),
      );
      expect(rows.map((TrashItem row) => row.kind), <TrashKind>[
        TrashKind.pointRule,
        TrashKind.wish,
        TrashKind.habit,
      ]);
      // 服务端不下发 expiresAt：过期与否由客户端用同一份 90 天常量现算。
      expect(rows.every((TrashItem row) => row.expired), isFalse);
      expect(rows.first.retentionText(now: DateTime.utc(2026, 10, 21, 12)),
          '还能恢复 89 天');
    });

    test('未知 kind ⇒ malformed，不能默默丢掉一行', () async {
      final List<TrashItemDto> items = <TrashItemDto>[
        TrashItemDto(
          kind: 'record',
          id: 'record-1',
          title: '打卡',
          deletedAt: DateTime.utc(2026, 10, 20),
        ),
      ];
      expect(
        () => mapTrash(TrashListDto(items: items),
            now: DateTime.utc(2026, 10, 21)),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.detail ?? '',
          'detail',
          contains('未知回收站类型'),
        )),
      );
    });

    test('缺少 items / deletedAt 不合规 ⇒ malformed（不猜 now）', () async {
      Future<TrashListDto> fetch(String body) {
        final ReadApiClient client = ReadApiClient(
          config: config,
          transport: _FakeTransport(
            (Uri uri) async => ReadHttpResponse(statusCode: 200, body: body),
          ),
        );
        return client.fetchTrash();
      }

      await expectLater(
        fetch(jsonEncode(<String, Object?>{'items': <Object?>[]})),
        completes,
      );
      await expectLater(
        fetch(jsonEncode(<String, Object?>{'rows': <Object?>[]})),
        throwsA(isA<ReadApiException>()),
      );
      await expectLater(
        fetch(trashJson(<Map<String, Object?>>[
          <String, Object?>{'kind': 'wish', 'id': 'wish-1', 'title': 'x'},
        ])),
        throwsA(isA<ReadApiException>()),
      );
      await expectLater(
        fetch(trashJson(<Map<String, Object?>>[
          <String, Object?>{
            'kind': 'wish',
            'id': 'wish-1',
            'title': 'x',
            'deletedAt': 'not-a-date',
          },
        ])),
        throwsA(isA<ReadApiException>()),
      );
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
    // 2026-11-10（用户第 8 条）：成功态不再画「数据来自服务器…」横条 ——
    // 抬头栏只留给真正需要看的状态（读取失败 / 首次加载中）。
    expect(find.textContaining('数据来自服务器'), findsNothing);
    expect(find.text('当前可用积分'), findsOneWidget);

    // live 但**没注入写客户端**：「记一笔」必须明确拒绝，而不是打开一个只改内存的表单。
    // ★ 2026-11-03：文案改用 `adjustReadOnlyWriteMessage`。原来的判据是
    // `isReadOnly`（live ⇒ true），导致注入了写客户端的家庭也被这句拦住。
    final Finder quickNote = find.text('记一笔');
    await tester.scrollUntilVisible(
      quickNote,
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(quickNote);
    await tester.pump();
    expect(find.text(store.adjustReadOnlyWriteMessage), findsOneWidget);
  });

  // ============================================ W7-B：监护人同意
  group('监护人同意（W7-B）：ConsentStateDto / mapConsent / GET /consent', () {
    Map<String, Object?> consentJson({
      String childId = 'child-1',
      String status = 'granted',
      String? consentVersion = '2026-10-27-draft',
      String? grantedAt = '2026-10-27T01:30:00.000Z',
      String? withdrawnAt,
    }) =>
        <String, Object?>{
          'childId': childId,
          'status': status,
          'consentVersion': consentVersion,
          'grantedAt': grantedAt,
          'withdrawnAt': withdrawnAt,
        };

    test('GET /consent：路径 + 两个身份头；版本与时间原样落地', () async {
      final List<Uri> calls = <Uri>[];
      final _FakeTransport transport = _FakeTransport((Uri uri) async {
        calls.add(uri);
        return ReadHttpResponse(
          statusCode: 200,
          body: jsonEncode(consentJson()),
        );
      });
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      final GuardianConsent consent =
          mapConsent(await client.fetchConsent());

      expect(calls.single.path, '/api/consent');
      expect(transport.headers.single[kDeviceIdHeader], 'device-1');
      expect(transport.headers.single[kChildIdHeader], 'child-1');
      expect(consent.childId, 'child-1');
      expect(consent.status, GuardianConsentStatus.granted);
      expect(consent.isGranted, isTrue);
      expect(consent.statusLabel, '已同意');
      expect(consent.consentVersion, '2026-10-27-draft');
      expect(consent.versionLabel, '2026-10-27-draft');
      expect(consent.isDraftVersion, isTrue, reason: '*-draft 是法务占位文本');
      expect(consent.grantedAt, DateTime.utc(2026, 10, 27, 1, 30));
      expect(consent.withdrawnAt, isNull);
      expect(consent.withdrawnText, isNull, reason: '没撤回就不要编一个撤回时间');
    });

    test('形状校验：granted 缺版本/时间、withdrawn 缺时间、none 带时间 ⇒ malformed',
        () async {
      Future<ReadApiException> failWith(Map<String, Object?> body) async {
        try {
          ConsentStateDto.fromJson(body);
          fail('必须抛出 malformed');
        } on ReadApiException catch (error) {
          return error;
        }
      }

      final ReadApiException noVersion = await failWith(
        consentJson(consentVersion: '   '),
      );
      expect(noVersion.kind, ReadFailureKind.malformed);
      expect(noVersion.detail, contains('协议版本'));

      final ReadApiException noGrantedAt =
          await failWith(consentJson(grantedAt: null));
      expect(noGrantedAt.kind, ReadFailureKind.malformed);
      expect(noGrantedAt.detail, contains('同意时间'));

      final ReadApiException withdrawnNoTime = await failWith(
        consentJson(status: 'withdrawn', grantedAt: null),
      );
      expect(withdrawnNoTime.kind, ReadFailureKind.malformed);
      expect(withdrawnNoTime.detail, contains('撤回时间'));

      final ReadApiException noneWithTime = await failWith(
        consentJson(status: 'none'),
      );
      expect(noneWithTime.kind, ReadFailureKind.malformed);
      expect(noneWithTime.detail, contains('必须为 null'));
    });

    test('未知 status 交给 mapConsent 抛（不能猜成「未同意」）', () async {
      final ConsentStateDto dto = ConsentStateDto.fromJson(
        consentJson(status: 'pending', consentVersion: null, grantedAt: null),
      );

      expect(
        () => mapConsent(dto),
        throwsA(
          isA<ReadApiException>()
              .having((ReadApiException e) => e.kind, 'kind',
                  ReadFailureKind.malformed)
              .having((ReadApiException e) => e.detail, 'detail',
                  contains('未知同意状态：pending')),
        ),
      );
    });

    test('withdrawn / none 是两件不同的事实，文案不共用', () async {
      final GuardianConsent withdrawn = mapConsent(
        ConsentStateDto.fromJson(
          consentJson(
            status: 'withdrawn',
            grantedAt: '2026-10-27T01:30:00.000Z',
            withdrawnAt: '2026-10-27T03:05:00.000Z',
          ),
        ),
      );
      expect(withdrawn.isWithdrawn, isTrue);
      expect(withdrawn.isNeverGranted, isFalse);
      expect(withdrawn.statusLabel, '已撤回');
      expect(withdrawn.withdrawnText, isNotNull);
      expect(withdrawn.grantedText, isNotNull, reason: '撤回前的同意时间仍然是有据可查的事实');

      final GuardianConsent never = mapConsent(
        ConsentStateDto.fromJson(
          consentJson(status: 'none', consentVersion: null, grantedAt: null),
        ),
      );
      expect(never.isNeverGranted, isTrue);
      expect(never.statusLabel, '未同意');
      expect(never.versionLabel, '—', reason: '空版本号不能留白，看起来像加载失败');
      expect(never.grantedText, isNull);
    });

    test('403：孩子视角拉同意状态翻成 forbidden，不冒充网络错误', () async {
      final _FakeTransport transport = _FakeTransport(
        (Uri uri) async => ReadHttpResponse(
          statusCode: 403,
          body: jsonEncode(<String, Object?>{
            'statusCode': 403,
            'code': 'FORBIDDEN',
            'message': 'Forbidden',
          }),
        ),
      );
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      try {
        await client.fetchConsent();
        fail('403 必须抛出 ReadApiException');
      } on ReadApiException catch (error) {
        expect(error.kind, ReadFailureKind.forbidden);
        expect(error.statusCode, 403);
        expect(error.userMessage, contains('没有查看'));
      }
    });
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
