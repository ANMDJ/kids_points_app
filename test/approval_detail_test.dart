import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_scope.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/data/read_mapper.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_dto.dart';
import 'package:kids_points_app/models/approval.dart';
import 'package:kids_points_app/screens/approval_detail_screen.dart';
import 'package:kids_points_app/screens/notifications_screen.dart';

/// P1-3（2026-11-10）：审批详情 ＋ 通知深链。
///
/// 这一组钉住四件事：
///   ① 详情页把**服务端下发的事实**逐项画出来（金额 / 规则快照 / 谁提的 /
///      执行流水 / 幂等键），不靠客户端猜；
///   ② 批准前必须二次确认，成功后状态以服务端回包为准（按钮消失）；
///   ③ 读失败（404 / 跨孩子）照实说明，不画成「加载中」或空内容；
///   ④ 通知里的审批胶囊打开的是**这一条**详情（不是丢进列表自己找）。
const String _homeJson = '{"child":{"id":"child-1","name":"小明",'
    '"pointsBalance":7},"goodHabitCount":0,"rewardCount":0,'
    '"habits":[],"rules":[],"wishes":[]}';

const String _emptyRecordsJson =
    '{"records":[],"limit":50,"hasMore":false,"nextCursor":null}';

const String _emptyApprovalsJson =
    '{"items":[],"hasMore":false,"nextCursor":null}';

void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> detailJson({
    String id = 'ap-1',
    String status = 'pending',
    String action = 'redeem',
    Object? summary = const <String, Object?>{
      'kind': 'redeem',
      'wishId': 'wish-1',
      'title': '乐高',
      'cost': 100,
    },
    String? requesterRole = 'child',
    String? decidedByUserId,
    String? executedRecordId,
    String? decidedAt,
    String? autoReason,
    String expiresAt = '2099-01-01T00:00:00.000Z',
  }) =>
      <String, Object?>{
        'id': id,
        'action': action,
        'status': status,
        'requesterUserId': 'user-kid',
        'requesterRole': requesterRole,
        'decidedByUserId': decidedByUserId,
        'executedRecordId': executedRecordId,
        'autoReason': autoReason,
        'createdAt': '2026-10-20T08:00:00.000Z',
        'decidedAt': decidedAt,
        'expiresAt': expiresAt,
        'summary': summary,
      };

  ApprovalInboxItem itemOf(Map<String, Object?> json) =>
      mapApprovalInboxItem(ApprovalInboxItemDto.fromJson(json, r'$'));

  group('详情 DTO / 模型：字段缺省不编造', () {
    test('requesterRole 只有详情接口带；缺省 ⇒ null 且文案兜底「家庭成员」', () {
      final ApprovalInboxItem withRole = itemOf(detailJson());
      expect(withRole.requesterRole, 'child');
      expect(withRole.requesterLabel, '孩子提交');

      final Map<String, Object?> withoutRole = detailJson()..remove('requesterRole');
      final ApprovalInboxItem plain = itemOf(withoutRole);
      expect(plain.requesterRole, isNull);
      expect(plain.requesterLabel, '家庭成员提交');

      // 不认识的旧值也不猜成「孩子」。
      expect(itemOf(detailJson(requesterRole: 'viewer')).requesterLabel, '家庭成员提交');
    });

    test('isSelfApproved 与服务端同一判据：批准人存在且等于申请人', () {
      expect(itemOf(detailJson()).isSelfApproved, isFalse);
      expect(
        itemOf(detailJson(status: 'approved', decidedByUserId: 'user-kid'))
            .isSelfApproved,
        isTrue,
      );
      expect(
        itemOf(detailJson(status: 'approved', decidedByUserId: 'user-dad'))
            .isSelfApproved,
        isFalse,
      );
    });

    test('formatApprovalTime 按本地时区展示（服务端发 UTC）', () {
      final DateTime utc = DateTime.utc(2026, 10, 20, 8, 0);
      final DateTime local = utc.toLocal();
      final String hh = local.hour.toString().padLeft(2, '0');
      final String mm = local.minute.toString().padLeft(2, '0');
      expect(
        formatApprovalTime(utc),
        '${local.month} 月 ${local.day} 日 $hh:$mm',
      );
    });
  });

  Widget harness(AppStore store, Widget child) => AppScope(
        store: store,
        child: MaterialApp(home: child),
      );

  /// 详情页是一整屏的 `ListView`：默认 800×600 的测试视口只 build 到前几张卡，
  /// 底部动作按钮与「执行结果」根本不会创建 —— 断言会误判成「没渲染」。
  /// 放大物理尺寸让整页内容都在视口里。
  void useTallViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(900, 2600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  group('ApprovalDetailScreen', () {
    testWidgets('把内容 / 金额 / 谁提的 / 执行结果 / 幂等键都画出来', (WidgetTester tester) async {
      useTallViewport(tester);
      final _DetailTransport transport = _DetailTransport(
        detail: detailJson(
          status: 'approved',
          decidedByUserId: 'user-dad',
          executedRecordId: 'rec-9',
          decidedAt: '2026-10-20T09:30:00.000Z',
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      final ApprovalInboxItem item = itemOf(transport.detail);
      await tester.pumpWidget(
        harness(
          store,
          ApprovalDetailScreen(
            approvalId: 'ap-1',
            initial: item,
            canDecide: true,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(transport.detailCalls, 1, reason: '详情页必须按 id 现取一条');
      expect(find.text('申请详情'), findsOneWidget);
      expect(find.text('兑换心愿'), findsOneWidget);
      expect(find.text('本次扣分'), findsOneWidget);
      expect(find.text('100 分'), findsOneWidget);
      expect(find.text('孩子提交'), findsOneWidget);
      expect(find.text('另一位家庭成员处理'), findsOneWidget);
      expect(find.text('rec-9'), findsOneWidget);
      expect(find.textContaining('approval:<审批 id>'), findsOneWidget);
      expect(find.text('ap-1'), findsOneWidget);
      expect(find.text('已通过'), findsNWidgets(2), reason: '抬头胶囊 + 「当前状态」各一处');
    });

    testWidgets('批准先二次确认；成功后以服务端回包为准，按钮消失', (WidgetTester tester) async {
      useTallViewport(tester);
      final _DetailTransport transport = _DetailTransport(detail: detailJson());
      final _FakeDecideApi write = _FakeDecideApi((String id, bool approve) {
        // 服务端批准后：详情再取一次就是 approved + 流水。
        transport.detail = detailJson(
          status: 'approved',
          decidedByUserId: 'user-dad',
          executedRecordId: 'rec-1',
          decidedAt: '2026-10-20T09:30:00.000Z',
        );
        return ApprovalDto(
          id: id,
          action: 'redeem',
          status: 'approved',
          executedRecordId: 'rec-1',
          autoReason: null,
        );
      });
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: write,
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(
        harness(
          store,
          ApprovalDetailScreen(
            approvalId: 'ap-1',
            initial: itemOf(transport.detail),
            canDecide: true,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('批准'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.textContaining('立即扣 100 分'), findsOneWidget, reason: '确认框要说清扣多少');
      expect(write.calls, 0, reason: '确认之前一个请求都不该发');

      await tester.tap(
        find.descendant(of: find.byType(AlertDialog), matching: find.text('批准')),
      );
      await tester.pumpAndSettle();

      expect(write.calls, 1);
      expect(write.lastId, 'ap-1');
      expect(write.lastApprove, isTrue);
      expect(find.text('已通过'), findsNWidgets(2));
      expect(find.text('批准'), findsNothing, reason: '已终态不该再给批准按钮');
      expect(transport.detailCalls, greaterThanOrEqualTo(2), reason: '成功后重新取一条');
    });

    testWidgets('读失败（404）说「这条申请不存在」，不是空白也不是转圈', (WidgetTester tester) async {
      useTallViewport(tester);
      final _DetailTransport transport = _DetailTransport(
        detail: detailJson(),
        detailStatus: 404,
        detailBody: '{"code":"APPROVAL_NOT_FOUND","message":"没有这条审批请求"}',
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(
        harness(store, const ApprovalDetailScreen(approvalId: 'ap-404')),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('不存在'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      expect(find.text('正在读取这条申请…'), findsNothing);
    });

    testWidgets('孩子入口（canWithdraw）只给撤回，不给批准', (WidgetTester tester) async {
      useTallViewport(tester);
      final _DetailTransport transport = _DetailTransport(detail: detailJson());
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: _FakeDecideApi((String id, bool approve) => ApprovalDto(
              id: id,
              action: 'redeem',
              status: approve ? 'approved' : 'rejected',
              executedRecordId: null,
              autoReason: null,
            )),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(
        harness(
          store,
          ApprovalDetailScreen(
            approvalId: 'ap-1',
            initial: itemOf(transport.detail),
            canWithdraw: true,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('撤回这条申请'), findsOneWidget);
      expect(find.text('批准'), findsNothing);
    });
  });
  group('通知深链（P1-3）', () {
    testWidgets('点「查看申请」打开的是这一条详情，而不是列表', (WidgetTester tester) async {
      useTallViewport(tester);
      final _DetailTransport transport = _DetailTransport(
        detail: detailJson(),
        notificationBody: _notificationsJson(approvalId: 'ap-1'),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(harness(store, const NotificationsScreen()));
      await tester.pumpAndSettle();

      expect(find.text('查看申请'), findsOneWidget);
      await tester.tap(find.text('查看申请'));
      await tester.pumpAndSettle();

      expect(find.text('申请详情'), findsOneWidget);
      expect(find.text('兑换心愿'), findsOneWidget);
      expect(transport.detailPaths, contains('/api/approvals/ap-1'));
    });
  });


}

/// 一条**已读**的审批结果通知：已读 ⇒ 点胶囊不会先发写请求，
/// 这样本用例只测深链本身（读请求 / 导航），不被标记已读的写路径干扰。
String _notificationsJson({required String approvalId}) =>
    jsonEncode(<String, Object?>{
      'items': <Object?>[
        <String, Object?>{
          'id': 'n-1',
          'type': 'approval.approved',
          'title': '申请通过了',
          'body': '「乐高」已经通过',
          'payload': <String, Object?>{'approvalId': approvalId},
          'readAt': '2026-10-20T09:31:00.000Z',
          'createdAt': '2026-10-20T09:30:00.000Z',
        },
      ],
      'hasMore': false,
      'nextCursor': null,
      'unreadCount': 0,
    });

/// `GET /approvals/:id` + 首页 / 流水 / 收件箱 / 通知。
///
/// `detail` 是**可变**的：批准成功后用例会把它改成 `approved`，
/// 用来验证详情页「重新取一条」而不是拿本地旧行糊过去。
class _DetailTransport implements ReadTransport {
  _DetailTransport({
    required this.detail,
    this.detailStatus = 200,
    this.detailBody,
    this.notificationBody = '{"items":[],"hasMore":false,"nextCursor":null,"unreadCount":0}',
  });

  Map<String, Object?> detail;
  int detailStatus;
  String? detailBody;
  String notificationBody;

  int detailCalls = 0;
  final List<String> detailPaths = <String>[];

  @override
  Future<ReadHttpResponse> send(
    Uri uri,
    Map<String, String> requestHeaders,
  ) async {
    final String path = uri.path;
    if (path.endsWith('/home')) {
      return ReadHttpResponse(statusCode: 200, body: _homeJson);
    }
    if (path.endsWith('/records')) {
      return ReadHttpResponse(statusCode: 200, body: _emptyRecordsJson);
    }
    if (path.endsWith('/notifications')) {
      return ReadHttpResponse(statusCode: 200, body: notificationBody);
    }
    // ★ 必须先于 `/approvals` 判断：详情路径以 `/approvals/<id>` 结尾。
    if (path.contains('/approvals/') && !path.endsWith('/approvals/mine')) {
      detailCalls += 1;
      detailPaths.add(path);
      if (detailStatus != 200) {
        return ReadHttpResponse(
          statusCode: detailStatus,
          body: detailBody ?? '{"code":"APPROVAL_NOT_FOUND"}',
        );
      }
      return ReadHttpResponse(statusCode: 200, body: jsonEncode(detail));
    }
    if (path.endsWith('/approvals')) {
      return ReadHttpResponse(statusCode: 200, body: _emptyApprovalsJson);
    }
    return ReadHttpResponse(statusCode: 404, body: '{"code":"NOT_FOUND"}');
  }

  @override
  void close() {}
}

/// 只实现 `decideApproval`，其余写方法调用即失败（本文件不该碰别的写端点）。
class _FakeDecideApi implements WriteApi {
  _FakeDecideApi(this.onDecide);

  final ApprovalDto Function(String id, bool approve) onDecide;

  int calls = 0;
  String? lastId;
  bool? lastApprove;

  @override
  Future<ApprovalDto> decideApproval(
    String approvalId, {
    required bool approve,
    String? idempotencyKey,
  }) async {
    calls += 1;
    lastId = approvalId;
    lastApprove = approve;
    return onDecide(approvalId, approve);
  }

  @override
  void close() {}

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('详情测试不该调用 ${invocation.memberName}');
}

