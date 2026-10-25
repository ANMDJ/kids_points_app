import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/data/read_mapper.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/data/write_dto.dart';
import 'package:kids_points_app/main.dart';
import 'package:kids_points_app/models/approval.dart';

/// W5-D：家长审批收件箱。
///
/// 这一组测试只钉三件事 —— 其它都可以商量，这三件不行：
///   ① **看不懂的 payload 不能变成一次「批准」**：`summary: null` /
///      未知 `kind` 都必须显示成「内容无法识别」并挡住批准（拒绝仍然可用）；
///   ② **游标只回传，不自己造**：第二页用的 `cursor` 必须是服务端给的那一个；
///   ③ **409 不是失败就算了**：并发 / 过期 / 前提变化之后必须重拉列表，
///      否则界面会一直挂着一条点不动的申请。
/// `GET /home` 的最小合法回包（live 模式首页刷新会用到）。
const String _homeJson = '{"child":{"id":"child-1","name":"小明",'
    '"pointsBalance":7},"goodHabitCount":0,"rewardCount":0,'
    '"habits":[],"rules":[],"wishes":[]}';

/// `GET /records` 的空页（首页壳子会自动拉一次）。
const String _emptyRecordsJson =
    '{"records":[],"limit":50,"hasMore":false,"nextCursor":null}';

void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> approvalJson({
    String id = 'ap-1',
    String action = 'redeem',
    String status = 'pending',
    Object? summary = const <String, Object?>{
      'kind': 'redeem',
      'wishId': 'wish-1',
      'title': '乐高',
      'cost': 100,
    },
    String createdAt = '2026-10-20T08:00:00.000Z',
    // 用一个**远期**时间：这条默认值昨天是“未来”，今天就成了“已过期”，
    // 批准按钮会静默禁用，用例跟着日期变红。需要过期的用例显式传 expiresAt。
    String expiresAt = '2099-01-01T00:00:00.000Z',
    String? autoReason,
  }) =>
      <String, Object?>{
        'id': id,
        'action': action,
        'status': status,
        'requesterUserId': 'user-child',
        'decidedByUserId': null,
        'executedRecordId': null,
        'autoReason': autoReason,
        'createdAt': createdAt,
        'decidedAt': null,
        'expiresAt': expiresAt,
        'summary': summary,
      };

  String pageJson({
    required List<Object?> items,
    bool hasMore = false,
    String? nextCursor,
  }) =>
      jsonEncode(<String, Object?>{
        'items': items,
        'hasMore': hasMore,
        'nextCursor': nextCursor,
      });

  group('ApprovalsPageDto：看不懂的内容降级，不许抛整页', () {
    test('summary=null 是合法响应：行仍然解析出来，只是不能批准', () {
      final ApprovalsPageDto page = ApprovalsPageDto.fromJson(
        jsonDecode(pageJson(items: <Object?>[approvalJson(summary: null)])),
      );
      final ApprovalInboxItem item = mapApprovalInboxItem(page.items.single);
      expect(item.id, 'ap-1');
      expect(item.summary, isNull);
      expect(item.canApproveAt(DateTime.utc(2026, 10, 21)), isFalse);
      expect(item.canRejectAt(DateTime.utc(2026, 10, 21)), isTrue,
          reason: '坏数据那一行也必须能被拒绝，否则永久卡在收件箱里');
      expect(item.canWithdrawAt(DateTime.utc(2026, 10, 21)), isTrue,
          reason: '申请人知道自己提了什么；坏 payload 不能把撤回也挡住');
      expect(item.approveBlockedReasonAt(DateTime.utc(2026, 10, 21)),
          contains('内容无法识别'));
    });

    test('未知 kind（服务端比客户端新）⇒ summary 为 null，不抛异常', () {
      final ApprovalInboxItemDto dto = ApprovalInboxItemDto.fromJson(
        approvalJson(summary: <String, Object?>{'kind': 'future_kind'}),
        r'$',
      );
      expect(dto.summary, isNull);
      expect(mapApprovalInboxItem(dto).summary, isNull);
    });

    test('已知 kind 字段漂移（redeem 缺 cost）⇒ malformed，而不是猜 0 分', () {
      expect(
        () => ApprovalInboxItemDto.fromJson(
          approvalJson(summary: <String, Object?>{
            'kind': 'redeem',
            'wishId': 'wish-1',
            'title': '乐高',
          }),
          r'$',
        ),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.userMessage,
          'userMessage',
          contains('cost'),
        )),
      );
    });

    test('三种 kind 都能映射成结构化摘要（金额 / 标题原样进模型）', () {
      final ApprovalInboxItem redeem = mapApprovalInboxItem(
          ApprovalInboxItemDto.fromJson(approvalJson(), r'$'));
      expect(redeem.summary, isA<RedeemSummary>());
      expect((redeem.summary! as RedeemSummary).cost, 100);
      expect(redeem.summary!.detail, contains('乐高'));

      final ApprovalInboxItem bonus = mapApprovalInboxItem(
        ApprovalInboxItemDto.fromJson(
          approvalJson(
              action: 'request_points_bonus',
              summary: <String, Object?>{
                'kind': 'bonus',
                'amount': 5,
                'reason': '帮妈妈拎菜',
                'ruleId': null,
                'habitId': null,
                'basisTitle': '做家务',
              }),
          r'$',
        ),
      );
      expect(bonus.summary, isA<BonusSummary>());
      expect(bonus.summary!.detail, contains('+5 分'));
      expect(bonus.summary!.detail, contains('帮妈妈拎菜'));

      final ApprovalInboxItem addWish = mapApprovalInboxItem(
        ApprovalInboxItemDto.fromJson(
          approvalJson(action: 'add_wish', summary: const <String, Object?>{
            'kind': 'add_wish',
            'title': '去露营',
            'cost': 60,
            'emoji': '⛺',
          }),
          r'$',
        ),
      );
      expect(addWish.summary, isA<AddWishSummary>());
      expect(addWish.summary!.detail, contains('去露营'));
      expect(addWish.summary!.headline, '新增心愿');
    });

    test('hasMore 与 nextCursor 必须自洽（否则提前停 / 对着 null 死循环）', () {
      expect(
        () => ApprovalsPageDto.fromJson(<String, Object?>{
          'items': <Object?>[],
          'hasMore': true,
          'nextCursor': null,
        }),
        throwsA(isA<ReadApiException>()),
      );
      expect(
        () => ApprovalsPageDto.fromJson(<String, Object?>{
          'items': <Object?>[],
          'hasMore': false,
          'nextCursor': 'CUR-1',
        }),
        throwsA(isA<ReadApiException>()),
      );
    });
  });

  group('ReadApiClient.fetchApprovals：游标原样回传，过滤词先自检', () {
    test('第一页不带 cursor；第二页带服务端给的 cursor，并带两个身份头', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          '': pageJson(
              items: <Object?>[approvalJson()],
              hasMore: true,
              nextCursor: 'CUR/1+2='),
          'CUR/1+2=': pageJson(items: <Object?>[approvalJson(id: 'ap-2')]),
        },
      );
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      final ApprovalsPageDto first = await client.fetchApprovals();
      await client.fetchApprovals(cursor: first.nextCursor);

      expect(transport.queries.first['status'], 'pending');
      expect(transport.queries.first['limit'], '20');
      expect(transport.queries.first.containsKey('cursor'), isFalse);
      expect(transport.queries[1]['cursor'], 'CUR/1+2=');
      expect(transport.headers.first[kDeviceIdHeader], 'device-1');
      expect(transport.headers.first[kChildIdHeader], 'child-1');
    });

    test('未知 status / limit 越界在发请求前就拒绝（与后端 DTO 同口径）', () {
      final ReadApiClient client = ReadApiClient(
        config: config,
        transport: _ApprovalsTransport(),
      );
      expect(
          () => client.fetchApprovals(status: 'pinding'), throwsArgumentError);
      expect(() => client.fetchApprovals(limit: 0), throwsArgumentError);
      expect(() => client.fetchApprovals(limit: 101), throwsArgumentError);
    });
  });

  group('ReadApiClient.fetchMyApprovals（W5-J）：路径与收件箱分开', () {
    test('默认 status=all，打到 /approvals/mine，身份头照旧', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        myApprovals: <String, String>{
          '': pageJson(
            items: <Object?>[approvalJson(status: 'pending')],
            hasMore: true,
            nextCursor: 'CUR/1+2=',
          ),
          'CUR/1+2=': pageJson(items: <Object?>[approvalJson(id: 'ap-2')]),
        },
      );
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      final ApprovalsPageDto first = await client.fetchMyApprovals();
      await client.fetchMyApprovals(cursor: first.nextCursor);

      expect(transport.paths, <String>['mine', 'mine']);
      expect(transport.queries.first['status'], 'all',
          reason: '「我的申请」默认看全部状态；只看待处理会把已通过的藏起来');
      expect(transport.queries.first['limit'], '20');
      expect(transport.queries[1]['cursor'], 'CUR/1+2=');
      expect(transport.headers.first[kDeviceIdHeader], 'device-1');
      expect(transport.headers.first[kChildIdHeader], 'child-1');
      expect(first.hasMore, isTrue);
    });

    test('筛选词 / limit 用同一套自检，非法值一个请求都不发', () {
      final _ApprovalsTransport transport = _ApprovalsTransport();
      final ReadApiClient client =
          ReadApiClient(config: config, transport: transport);

      expect(
        () => client.fetchMyApprovals(status: 'pinding'),
        throwsArgumentError,
      );
      expect(() => client.fetchMyApprovals(limit: 0), throwsArgumentError);
      expect(() => client.fetchMyApprovals(limit: 101), throwsArgumentError);
      expect(transport.paths, isEmpty);
    });
  });

  group('AppStore.fetchMyApprovals（W5-J）：面板自己持有列表', () {
    test('不写全局收件箱状态，也不拉首页', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        myApprovals: <String, String>{
          'all|': pageJson(
            items: <Object?>[approvalJson(id: 'ap-mine', status: 'withdrawn')],
          ),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      final ApprovalsPage page = await store.fetchMyApprovals();

      expect(page.items.single.id, 'ap-mine');
      expect(page.items.single.status, 'withdrawn');
      expect(store.approvals, isEmpty, reason: '收件箱与「我的申请」是两套数据，不能互相覆盖');
      expect(store.approvalReadStatus, ReadStatus.idle);
      expect(transport.homeCalls, 0);
      expect(transport.paths, <String>['mine']);
    });

    test('预览模式不编数据：返回空页而不是抛错', () async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);

      final ApprovalsPage page = await store.fetchMyApprovals();

      expect(page.items, isEmpty);
      expect(page.hasMore, isFalse);
      expect(page.nextCursor, isNull);
    });
  });

  group('AppStore.withdrawApproval（W5-J）', () {
    ApprovalDto withdrawnDto() => ApprovalDto(
          id: 'ap-1',
          action: 'redeem',
          status: 'withdrawn',
          executedRecordId: null,
          autoReason: null,
        );

    test('只读 / 预览模式在本地拦下，不发请求', () async {
      final _FakeWithdrawApi api = _FakeWithdrawApi(result: withdrawnDto());
      final AppStore preview = AppStore(writeApi: api);
      addTearDown(preview.dispose);

      expect(await preview.withdrawApproval('ap-1'), contains('预览模式'));
      expect(api.calls, 0);

      final AppStore readOnly = AppStore(
        readApi: ReadApiClient(
          config: config,
          transport: _ApprovalsTransport(),
        ),
        writeApi: null,
      );
      addTearDown(readOnly.dispose);
      expect(await readOnly.withdrawApproval('ap-1'), contains('只读模式'));
      expect(api.calls, 0);
    });

    test('成功：带幂等键、不拉首页；收件箱没打开过就不去碰它', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport();
      final _FakeWithdrawApi api = _FakeWithdrawApi(result: withdrawnDto());
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      expect(await store.withdrawApproval('  ap-1  '), isNull);

      expect(api.calls, 1);
      expect(api.lastId, 'ap-1');
      expect(api.lastIdempotencyKey, isNotNull);
      expect(api.lastIdempotencyKey, isNotEmpty);
      expect(transport.homeCalls, 0, reason: '撤回不动积分，不该重拉首页');
      expect(transport.paths, isEmpty, reason: '孩子调收件箱必然 403；没打开过就不要为了同步去撞');
    });

    test('成功且收件箱已加载：顺手同步一次（家长撤回自己那条）', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          'pending|': pageJson(items: <Object?>[approvalJson()]),
          '': pageJson(items: <Object?>[]),
        },
      );
      final _FakeWithdrawApi api = _FakeWithdrawApi(result: withdrawnDto());
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      await store.refreshApprovals();
      final int before = transport.paths.length;
      expect(await store.withdrawApproval('ap-1'), isNull);

      expect(transport.paths.length, before + 1);
      expect(transport.paths.last, 'inbox');
    });

    test('409 原样上报并重拉；403 NOT_REQUESTER 不重拉', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          'pending|': pageJson(items: <Object?>[approvalJson()]),
          '': pageJson(items: <Object?>[approvalJson(status: 'approved')]),
        },
      );
      final _FakeWithdrawApi api = _FakeWithdrawApi(
        error: WriteApiException.fromHttp(
          statusCode: 409,
          body: <String, Object?>{
            'code': 'ALREADY_DECIDED',
            'message': '已处理',
          },
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      await store.refreshApprovals();
      final int before = transport.paths.length;
      final String? message = await store.withdrawApproval('ap-1');

      expect(message, contains('已经被处理'));
      expect(transport.paths.length, before + 1);

      api.error = WriteApiException.fromHttp(
        statusCode: 403,
        body: <String, Object?>{
          'code': 'NOT_REQUESTER',
          'message': '不是申请人',
        },
      );
      final int afterConflict = transport.paths.length;
      final String? forbidden = await store.withdrawApproval('ap-1');

      expect(forbidden, contains('不是你提交的申请'));
      expect(transport.paths.length, afterConflict,
          reason: '403 不是「列表过时」，没有理由重拉');
    });

    test('回包状态不是 withdrawn ⇒ 当失败上报（契约漂移不许静默成功）', () async {
      final _FakeWithdrawApi api = _FakeWithdrawApi(
        result: ApprovalDto(
          id: 'ap-1',
          action: 'redeem',
          status: 'pending',
          executedRecordId: null,
          autoReason: null,
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(
          config: config,
          transport: _ApprovalsTransport(),
        ),
        writeApi: api,
      );
      addTearDown(store.dispose);

      final String? message = await store.withdrawApproval('ap-1');

      expect(message, contains('与这次撤回不一致'));
    });
  });

  group('AppStore：收件箱加载 / 过滤 / 翻页', () {
    test('refresh 只拉审批，不碰首页；loadMore 用第一页的游标', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          '': pageJson(
            items: <Object?>[approvalJson(), approvalJson(id: 'ap-2')],
            hasMore: true,
            nextCursor: 'CUR-1',
          ),
          'pending|CUR-1': pageJson(items: <Object?>[approvalJson(id: 'ap-3')]),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshApprovals();

      expect(store.approvalReadStatus, ReadStatus.ready);
      expect(store.approvals.map((ApprovalInboxItem i) => i.id),
          <String>['ap-1', 'ap-2']);
      expect(store.pendingApprovalCount, 2);
      expect(store.hasMoreApprovals, isTrue);
      expect(transport.homeCalls, 0, reason: '审批不该顺手拉首页');

      await store.loadMoreApprovals();

      expect(store.approvals.map((ApprovalInboxItem i) => i.id),
          <String>['ap-1', 'ap-2', 'ap-3']);
      expect(store.hasMoreApprovals, isFalse);
      expect(transport.cursors, <String?>[null, 'CUR-1']);

      // 到底后再点不会多发一次请求。
      final int calls = transport.cursors.length;
      await store.loadMoreApprovals();
      expect(transport.cursors.length, calls);
    });

    test('403 如实暴露：不是「暂无待审批」，也不污染首页的错误', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{},
        approvalsStatus: 403,
        approvalsBody:
            '{"code":"FORBIDDEN","message":"缺少动作权限 review_approvals"}',
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshFromServer();
      expect(store.readStatus, ReadStatus.ready);

      await store.refreshApprovals();

      expect(store.approvalReadStatus, ReadStatus.error);
      expect(store.approvalError?.kind, ReadFailureKind.forbidden);
      expect(store.approvals, isEmpty);
      expect(store.readStatus, ReadStatus.ready, reason: '收件箱 403 不许把首页变成错误态');
    });

    test('切过滤：重新要第一页（带 status），不复用旧游标', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          '': pageJson(
            items: <Object?>[approvalJson()],
            hasMore: true,
            nextCursor: 'CUR-1',
          ),
          'approved|': pageJson(items: <Object?>[
            approvalJson(id: 'ap-9', status: 'approved'),
          ]),
        },
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.refreshApprovals();
      await store.setApprovalStatusFilter('approved');

      expect(store.approvalStatusFilter, 'approved');
      expect(transport.statuses, <String>['pending', 'approved']);
      expect(transport.cursors, <String?>[null, null]);
      expect(store.approvals.single.id, 'ap-9');
      expect(store.hasMoreApprovals, isFalse);

      // 未登记的过滤词直接忽略（不发请求、不改状态）。
      await store.setApprovalStatusFilter('pinding');
      expect(store.approvalStatusFilter, 'approved');
      expect(transport.statuses.length, 2);
    });

    test('预览模式：进入 ready 空态，不编造申请', () async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);
      await store.refreshApprovals();
      expect(store.approvalReadStatus, ReadStatus.ready);
      expect(store.approvals, isEmpty);
      expect(store.canDecideApprovals, isFalse);
    });
  });

  group('AppStore.decideApproval：能判死的先拒，冲突后重拉', () {
    ApprovalInboxItem pendingItem({
      DateTime? expiresAt,
      ApprovalSummary? summary = const RedeemSummary(
        wishId: 'wish-1',
        title: '乐高',
        cost: 100,
      ),
    }) {
      return ApprovalInboxItem(
        id: 'ap-1',
        action: 'redeem',
        status: 'pending',
        requesterUserId: 'user-child',
        decidedByUserId: null,
        executedRecordId: null,
        autoReason: null,
        createdAt: DateTime.utc(2026, 10, 20, 8),
        decidedAt: null,
        expiresAt: expiresAt ?? DateTime.utc(2026, 10, 23, 8),
        summary: summary,
      );
    }

    test('拒绝：只发 rejected，成功后重拉列表', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          '': pageJson(items: <Object?>[approvalJson()]),
        },
      );
      final _FakeDecideApi api = _FakeDecideApi(
        result: ApprovalDto(
          id: 'ap-1',
          action: 'redeem',
          status: 'rejected',
          executedRecordId: null,
          autoReason: null,
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);
      await store.refreshApprovals();
      final int before = transport.cursors.length;

      final String? error = await store.decideApproval(
        pendingItem(),
        approve: false,
        now: DateTime.utc(2026, 10, 21),
      );

      expect(error, isNull);
      expect(api.calls, 1);
      expect(api.lastApprove, isFalse);
      expect(api.lastId, 'ap-1');
      expect(api.lastIdempotencyKey, isNotNull, reason: '重试同一操作不该变成第二次判定');
      expect(transport.cursors.length, before + 1,
          reason: '判定成功后必须重拉，否则列表还显示「待处理」');
    });

    test('409（已处理过）：原样返回文案，并强制重拉列表', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          '': pageJson(items: <Object?>[approvalJson()]),
          'pending|CUR-1': pageJson(items: <Object?>[]),
        },
      );
      final _FakeDecideApi api = _FakeDecideApi(
        error: WriteApiException(
          WriteFailureKind.conflict,
          '这条申请已经处理过了，请刷新列表。',
          statusCode: 409,
          code: 'ALREADY_DECIDED',
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);
      await store.refreshApprovals();
      final int before = transport.cursors.length;

      final String? error = await store.decideApproval(
        pendingItem(),
        approve: true,
        now: DateTime.utc(2026, 10, 21),
      );

      expect(error, contains('已经处理过'));
      expect(transport.cursors.length, before + 1,
          reason: '409 之后本地那条已经过时，不刷新会一直点不动');
      expect(store.decidingApprovalId, isNull, reason: '失败也要释放忙状态');
    });

    test('本地能判死的不发请求：内容读不懂 / 已过期 / 预览模式', () async {
      final _ApprovalsTransport transport = _ApprovalsTransport();
      final _FakeDecideApi api = _FakeDecideApi(
        result: ApprovalDto(
          id: 'ap-1',
          action: 'redeem',
          status: 'approved',
          executedRecordId: null,
          autoReason: null,
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      final String? unknown = await store.decideApproval(
        pendingItem(summary: null),
        approve: true,
        now: DateTime.utc(2026, 10, 21),
      );
      expect(unknown, contains('内容无法识别'));

      final String? expired = await store.decideApproval(
        pendingItem(expiresAt: DateTime.utc(2026, 10, 21)),
        approve: false,
        now: DateTime.utc(2026, 10, 21, 0, 0, 1),
      );
      expect(expired, contains('72 小时'));

      expect(api.calls, 0, reason: '发出去只会换一个 409，没必要');

      final AppStore preview = AppStore();
      addTearDown(preview.dispose);
      final String? noBackend = await preview.decideApproval(
        pendingItem(),
        approve: false,
      );
      expect(noBackend, contains('预览模式'));
    });

    test('确认文案说清后果：批准扣分 / 加分，拒绝不改任何数据', () {
      expect(
        approvalConfirmText(approve: true, item: pendingItem()),
        contains('100'),
      );
      expect(
        approvalConfirmText(
          approve: true,
          item: pendingItem(
            summary: const BonusSummary(amount: 5, reason: '拎菜'),
          ),
        ),
        contains('5 分'),
      );
      expect(
        approvalConfirmText(approve: false, item: pendingItem()),
        contains('不会生效'),
      );
    });
  });

  group('ApprovalsScreen：界面冒烟', () {
    testWidgets('切到审批 tab 才拉第一页；批准先弹确认，取消不发请求', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvals: <String, String>{
          '': pageJson(items: <Object?>[
            approvalJson(),
            approvalJson(id: 'ap-2', summary: null),
          ]),
        },
      );
      final _FakeDecideApi api = _FakeDecideApi(
        result: ApprovalDto(
          id: 'ap-1',
          action: 'redeem',
          status: 'approved',
          executedRecordId: null,
          autoReason: null,
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: api,
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();

      expect(transport.cursors, isEmpty, reason: '没切过去就不该请求审批');

      await tester.tap(find.text('审批'));
      await tester.pumpAndSettle();

      expect(transport.statuses, <String>['pending']);
      expect(find.text('家长审批'), findsOneWidget);
      expect(find.text('兑换心愿'), findsOneWidget);
      expect(find.text('内容无法识别'), findsOneWidget);

      await tester.tap(find.text('批准').first);
      await tester.pumpAndSettle();
      expect(find.text('批准这次申请'), findsOneWidget);
      expect(find.textContaining('100'), findsWidgets);

      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(api.calls, 0, reason: '取消就是什么都不做');
    });

    testWidgets('403：说「没有权限」，不说「没有待审批」', (WidgetTester tester) async {
      final _ApprovalsTransport transport = _ApprovalsTransport(
        approvalsStatus: 403,
        approvalsBody:
            '{"code":"FORBIDDEN","message":"缺少动作权限 review_approvals"}',
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();
      await tester.tap(find.text('审批'));
      await tester.pumpAndSettle();

      expect(find.textContaining('没有批准申请的权限'), findsOneWidget);
      expect(find.textContaining('没有符合条件的申请'), findsNothing);
      expect(find.text('重试'), findsOneWidget);
    });
  });
}

/// `GET /approvals` + `/home` + `/records`。
///
/// 键是 `status|cursor`（`cursors` 单独记录游标序列，便于断言「原样回传」）。
class _ApprovalsTransport implements ReadTransport {
  _ApprovalsTransport({
    Map<String, String>? approvals,
    Map<String, String>? myApprovals,
    this.approvalsStatus = 200,
    this.approvalsBody = '{"items":[],"hasMore":false,"nextCursor":null}',
  })  : approvals = approvals ?? <String, String>{},
        myApprovals = myApprovals ?? <String, String>{};

  final Map<String, String> approvals;
  final Map<String, String> myApprovals;
  final int approvalsStatus;
  final String approvalsBody;

  final List<Map<String, String>> queries = <Map<String, String>>[];
  final List<String?> cursors = <String?>[];
  final List<String> statuses = <String>[];
  final List<Map<String, String>> headers = <Map<String, String>>[];

  /// 审批读请求打到了哪个端点（`inbox` = `/approvals`，`mine` = `/approvals/mine`）。
  final List<String> paths = <String>[];
  int homeCalls = 0;

  @override
  Future<ReadHttpResponse> send(
    Uri uri,
    Map<String, String> requestHeaders,
  ) async {
    if (uri.path.endsWith('/home')) {
      homeCalls += 1;
      return ReadHttpResponse(statusCode: 200, body: _homeJson);
    }
    if (uri.path.endsWith('/records')) {
      return ReadHttpResponse(statusCode: 200, body: _emptyRecordsJson);
    }
    final bool isMine = uri.path.endsWith('/approvals/mine');
    if (!isMine && !uri.path.endsWith('/approvals')) {
      return ReadHttpResponse(statusCode: 404, body: '{"code":"NOT_FOUND"}');
    }

    paths.add(isMine ? 'mine' : 'inbox');
    headers.add(requestHeaders);
    queries.add(uri.queryParameters);
    final String status = uri.queryParameters['status'] ?? 'pending';
    final String? cursor = uri.queryParameters['cursor'];
    statuses.add(status);
    cursors.add(cursor);

    if (approvalsStatus != 200) {
      return ReadHttpResponse(statusCode: approvalsStatus, body: approvalsBody);
    }
    final Map<String, String> pages = isMine ? myApprovals : approvals;
    final String? body = pages['$status|${cursor ?? ''}'] ?? pages[''];
    if (body == null) {
      return ReadHttpResponse(statusCode: 200, body: approvalsBody);
    }
    return ReadHttpResponse(statusCode: 200, body: body);
  }

  @override
  void close() {}
}

/// 只实现 [WriteApi.withdrawApproval]，其余方法调用即失败（W5-J）。
class _FakeWithdrawApi implements WriteApi {
  _FakeWithdrawApi({this.result, this.error});

  ApprovalDto? result;
  Object? error;
  int calls = 0;
  String? lastId;
  String? lastIdempotencyKey;

  @override
  Future<ApprovalDto> withdrawApproval(
    String approvalId, {
    String? idempotencyKey,
  }) async {
    calls += 1;
    lastId = approvalId;
    lastIdempotencyKey = idempotencyKey;
    if (error != null) throw error!;
    return result!;
  }

  @override
  void close() {}

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('撤回测试不该调用 ${invocation.memberName}');
}

/// 只实现 [WriteApi.decideApproval]，其余方法调用即失败
/// —— 收件箱之外一个写端点都不该被触发。
class _FakeDecideApi implements WriteApi {
  _FakeDecideApi({this.result, this.error});

  final ApprovalDto? result;
  final Object? error;
  int calls = 0;
  String? lastId;
  bool? lastApprove;
  String? lastIdempotencyKey;

  @override
  Future<ApprovalDto> decideApproval(
    String approvalId, {
    required bool approve,
    String? idempotencyKey,
  }) async {
    calls += 1;
    lastId = approvalId;
    lastApprove = approve;
    lastIdempotencyKey = idempotencyKey;
    if (error != null) throw error!;
    return result!;
  }

  @override
  void close() {}

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('收件箱测试不该调用 ${invocation.memberName}');
}
