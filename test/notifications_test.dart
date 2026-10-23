import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/data/write_dto.dart';
import 'package:kids_points_app/main.dart';

/// W5-L：站内通知中心（`GET /notifications` + `PATCH /notifications/:id/read`）。
///
/// 这几组用例钉住的是**用户能看出来的事**：
///   ① 未读只由 `readAt == null` 推导，数量只认服务端下发的整份 `unreadCount`；
///   ② 读失败**不清空**列表、不把红点清零（「没有未读」是最会骗人的一种失败）；
///   ③ 打开面板才拉列表；标记已读只改那一行，不重排整页。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

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

  String notificationsPage({
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

  String homeJson() => jsonEncode(<String, Object?>{
        'child': <String, Object?>{
          'id': 'child-1',
          'name': '小明',
          'pointsBalance': 0,
        },
        'goodHabitCount': 0,
        'rewardCount': 0,
        'habits': <Object?>[],
        'rules': <Object?>[],
        'wishes': <Object?>[],
      });


  group('NotificationDto：审批类消息该去哪里（W5-M）', () {
    test('approval.submitted 是「等你处理」，结论是「看结果」，未知类型不冒充审批', () {
      final NotificationDto submitted = NotificationDto.fromJson(
          notificationJson(type: 'approval.submitted'), 'item');
      final NotificationDto approved = NotificationDto.fromJson(
          notificationJson(type: 'approval.approved'), 'item');
      final NotificationDto other = NotificationDto.fromJson(
          notificationJson(id: 'n-9', type: 'system.announcement'), 'item');

      // 三者都带同一个 `approvalId` —— 只靠 payload 分不出该去哪个页面。
      expect(submitted.approvalId, 'ap-1');
      expect(approved.approvalId, 'ap-1');
      expect(submitted.isApprovalSubmitted, isTrue);
      expect(approved.isApprovalSubmitted, isFalse,
          reason: '结论点进去要去「我的申请」看结果，不是「审批」页');
      expect(other.isApprovalSubmitted, isFalse);
    });
  });

  group('AppStore：消息列表（W5-L）', () {
    test('第一页 20 条起步、未读数用服务端值；加载更多带游标并按 id 去重', () async {
      final _NotificationsTransport transport = _NotificationsTransport(
        pages: <String, String>{
          '': notificationsPage(
            items: <Map<String, Object?>>[
              notificationJson(),
              notificationJson(
                id: 'n-2',
                type: 'approval.rejected',
                readAt: '2026-10-23T03:00:00.000Z',
              ),
            ],
            hasMore: true,
            nextCursor: 'cur-1',
            unreadCount: 3,
          ),
          'cur-1': notificationsPage(
            // 两次请求之间又写入了新通知：键集分页会把 n-2 再送一次。
            items: <Map<String, Object?>>[
              notificationJson(id: 'n-2'),
              notificationJson(id: 'n-3', type: 'system.announcement'),
            ],
            unreadCount: 4,
          ),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshNotifications();

      expect(store.notificationsReadStatus, ReadStatus.ready);
      expect(store.notificationsError, isNull);
      expect(store.notifications.map((NotificationDto n) => n.id),
          <String>['n-1', 'n-2']);
      expect(store.unreadNotificationCount, 3, reason: '整份未读数，不是本页求和');
      expect(store.notificationsHasMore, isTrue);
      expect(transport.limits, <int>[20]);
      expect(transport.cursors, <String?>[null]);

      await store.loadMoreNotifications();

      expect(store.notifications.map((NotificationDto n) => n.id),
          <String>['n-1', 'n-2', 'n-3']);
      expect(transport.cursors, <String?>[null, 'cur-1']);
      expect(store.notificationsHasMore, isFalse);
      // 去重保留第一页那一行（本地状态更新过的那份），不把旧快照盖回来。
      expect(store.notifications[1].isUnread, isFalse);
      expect(store.unreadNotificationCount, 4);
    });

    test('刷新失败：保留已加载的行与未读数，错误交给面板自己说', () async {
      final _NotificationsTransport transport = _NotificationsTransport(
        pages: <String, String>{
          '': notificationsPage(
            items: <Map<String, Object?>>[notificationJson()],
            unreadCount: 2,
          ),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshNotifications();
      expect(store.unreadNotificationCount, 2);

      transport.failure = ReadApiException(
        ReadFailureKind.forbidden,
        '当前身份不能查看消息。',
      );
      await store.refreshNotifications();

      expect(store.notificationsReadStatus, ReadStatus.error);
      expect(store.notificationsError?.userMessage, contains('不能查看'));
      expect(store.notifications, hasLength(1), reason: '断网 / 403 不等于「消息没了」');
      expect(store.unreadNotificationCount, 2, reason: '失败不能把红点清零');
    });

    test('红点单查只取 1 条；失败保持上一次的值', () async {
      final _NotificationsTransport transport = _NotificationsTransport(
        pages: <String, String>{
          '': notificationsPage(unreadCount: 4),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshUnreadNotificationCount();

      expect(transport.limits, <int>[1]);
      expect(store.unreadNotificationCount, 4);
      expect(store.notifications, isEmpty, reason: '红点单查不覆盖列表内容');

      transport.failure = ReadApiException.network('模拟断网');
      await store.refreshUnreadNotificationCount();

      expect(store.unreadNotificationCount, 4,
          reason: '取不到就说「没有未读」是红点消失最常见的骗法');
      expect(store.notificationsError, isNull,
          reason: '红点失败是静默的，不污染列表错误');
    });
  });

  group('AppStore：标记已读（PATCH /notifications/:id/read）', () {
    test('成功：只把那一行改成已读、未读数减一，不重拉整页', () async {
      final _NotificationsTransport transport = _NotificationsTransport(
        pages: <String, String>{
          '': notificationsPage(
            items: <Map<String, Object?>>[
              notificationJson(),
              notificationJson(id: 'n-2', payload: null),
            ],
            unreadCount: 2,
          ),
        },
      );
      final _FakeWriteApi api = _FakeWriteApi()
        ..markResult = NotificationReadDto(
          id: 'n-1',
          readAt: DateTime.utc(2026, 10, 23, 5),
        );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      await store.refreshNotifications();
      final String? error =
          await store.markNotificationRead(store.notifications.first);

      expect(error, isNull);
      expect(api.markCalls, 1);
      expect(api.lastId, 'n-1');
      expect(store.notifications.first.isUnread, isFalse);
      expect(store.notifications.first.readAt, DateTime.utc(2026, 10, 23, 5),
          reason: '用服务端回包的时间，不用本机时钟');
      expect(store.unreadNotificationCount, 1);
      expect(transport.cursors, <String?>[null], reason: '不重拉列表');
      expect(store.busyNotificationId, isNull);
    });

    test('已经读过的再点一次：本地就返回，不发请求', () async {
      final _NotificationsTransport transport = _NotificationsTransport(
        pages: <String, String>{
          '': notificationsPage(
            items: <Map<String, Object?>>[
              notificationJson(readAt: '2026-10-23T03:00:00.000Z'),
            ],
            unreadCount: 0,
          ),
        },
      );
      final _FakeWriteApi api = _FakeWriteApi();
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      await store.refreshNotifications();

      expect(
          await store.markNotificationRead(store.notifications.first), isNull);
      expect(api.markCalls, 0);
      expect(transport.cursors, <String?>[null]);
    });

    test('404：回报原因并重拉列表（这一行已经不在了）', () async {
      final _NotificationsTransport transport = _NotificationsTransport(
        pages: <String, String>{
          '': notificationsPage(
            items: <Map<String, Object?>>[notificationJson()],
            unreadCount: 1,
          ),
        },
      );
      final _FakeWriteApi api = _FakeWriteApi()
        ..markError = WriteApiException(
          WriteFailureKind.notFound,
          '要操作的数据不存在或已被删除（404），这次操作没有保存。',
          code: 'NOTIFICATION_NOT_FOUND',
        );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      await store.refreshNotifications();
      final String? error =
          await store.markNotificationRead(store.notifications.first);

      expect(error, contains('不存在'));
      expect(transport.cursors, <String?>[null, null],
          reason: '404 后刷新，避免留一条点不动的行');
      expect(store.busyNotificationId, isNull);
    });

    test('预览模式直接给空态；live 但无写客户端时给阅读模式文案', () async {
      final AppStore preview = AppStore();
      addTearDown(preview.dispose);
      await preview.refreshNotifications();

      expect(preview.notificationsReadStatus, ReadStatus.ready);
      expect(preview.notifications, isEmpty);
      expect(preview.isNotificationWriteReadOnly, isFalse,
          reason: '预览模式没有真实通知，连「只读写入」都谈不上');

      final _NotificationsTransport transport = _NotificationsTransport(
        pages: <String, String>{
          '': notificationsPage(
            items: <Map<String, Object?>>[notificationJson()],
            unreadCount: 1,
          ),
        },
      );
      final AppStore readOnly = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(readOnly.dispose);
      await readOnly.refreshNotifications();

      expect(readOnly.isNotificationWriteReadOnly, isTrue);
      expect(
        await readOnly.markNotificationRead(readOnly.notifications.first),
        readOnly.notificationReadOnlyWriteMessage,
      );
      expect(readOnly.notifications.first.isUnread, isTrue);
      expect(transport.cursors, <String?>[null], reason: '只读模式发不出 PATCH');
    });
  });

  group('NotificationSheet：界面（W5-L）', () {
    testWidgets('切到「我的」才查红点；打开面板才拉列表；点一行标记已读',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final _NotificationsTransport transport = _NotificationsTransport(
        home: homeJson(),
        pages: <String, String>{
          '': notificationsPage(
            items: <Map<String, Object?>>[
              notificationJson(),
              notificationJson(
                id: 'n-2',
                type: 'system.announcement',
                title: '本周回顾',
                body: '这周攒了 12 颗星',
                payload: null,
                readAt: '2026-10-23T03:00:00.000Z',
              ),
            ],
            unreadCount: 1,
          ),
        },
      );
      final _FakeWriteApi api = _FakeWriteApi()
        ..markResult = NotificationReadDto(
          id: 'n-1',
          readAt: DateTime.utc(2026, 10, 23, 6),
        );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();
      expect(transport.limits, isEmpty, reason: '启动时不该为红点发请求');

      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();
      expect(transport.limits, <int>[1], reason: '切到「我的」只查红点，不拉整页');

      await tester.ensureVisible(find.text('消息'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('消息'));
      await tester.pumpAndSettle();

      expect(transport.limits, <int>[1, 20]);
      expect(find.text('消息（1 条未读）'), findsOneWidget);
      expect(find.text('申请通过了'), findsOneWidget);
      expect(find.text('本周回顾'), findsOneWidget);
      // 只有审批类消息带「查看申请」，普通消息不做无意义跳转。
      expect(find.text('查看申请'), findsOneWidget);

      await tester.tap(find.text('申请通过了'));
      await tester.pumpAndSettle();

      expect(api.markCalls, 1);
      expect(api.lastId, 'n-1');
      expect(store.notifications.first.isUnread, isFalse);
      expect(find.text('消息'), findsWidgets, reason: '未读清零后标题回到「消息」');
    });

    testWidgets('读取失败：说「消息列表没能加载」并给重试，不说「还没有消息」',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final _NotificationsTransport transport = _NotificationsTransport(
        home: homeJson(),
        pages: <String, String>{'': notificationsPage(unreadCount: 0)},
      )..failure = ReadApiException(
          ReadFailureKind.forbidden,
          '当前身份不能查看消息。',
        );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();
      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('消息'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('消息'));
      await tester.pumpAndSettle();

      expect(find.textContaining('消息加载失败'), findsOneWidget);
      expect(find.textContaining('不能查看消息'), findsOneWidget);
      expect(find.text('消息列表没能加载'), findsOneWidget);
      expect(find.text('还没有消息'), findsNothing);
      expect(find.text('重试'), findsOneWidget);
    });
  });
}

/// 只响应 `/notifications`（+ `/home`），并记录 limit / cursor 序列。
class _NotificationsTransport implements ReadTransport {
  _NotificationsTransport({
    required this.pages,
    this.home = '{"child":{"id":"child-1","name":"小明","pointsBalance":0},'
        '"goodHabitCount":0,"rewardCount":0,"habits":[],"rules":[],"wishes":[]}',
  });

  /// key 是 `cursor ?? ''`。
  final Map<String, String> pages;
  final String home;
  final List<int> limits = <int>[];
  final List<String?> cursors = <String?>[];

  /// 非 null 时 `/notifications` 直接抛这个异常（模拟 403 / 断网）。
  ReadApiException? failure;

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    if (uri.path.endsWith('/home')) {
      return ReadHttpResponse(statusCode: 200, body: home);
    }
    if (!uri.path.endsWith('/notifications')) {
      // 首页顺带拉的流水：空页即可，本文件不关心。
      return ReadHttpResponse(
        statusCode: 200,
        body: '{"records":[],"limit":50,"hasMore":false,"nextCursor":null}',
      );
    }
    limits.add(int.parse(uri.queryParameters['limit'] ?? '0'));
    final String? cursor = uri.queryParameters['cursor'];
    cursors.add(cursor);
    final ReadApiException? failure = this.failure;
    if (failure != null) throw failure;
    return ReadHttpResponse(
      statusCode: 200,
      body: pages[cursor ?? ''] ?? pages['']!,
    );
  }

  @override
  void close() {}
}

/// 只实现 [WriteApi.markNotificationRead]，其余写端点调用即失败。
class _FakeWriteApi implements WriteApi {
  int markCalls = 0;
  String? lastId;
  NotificationReadDto? markResult;
  Object? markError;

  @override
  Future<NotificationReadDto> markNotificationRead(String notificationId) async {
    markCalls += 1;
    lastId = notificationId;
    if (markError != null) throw markError!;
    return markResult!;
  }

  @override
  void close() {}

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('通知测试不该调用 ${invocation.memberName}');
}

