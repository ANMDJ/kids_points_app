import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/data/read_mapper.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/models/family_deletion.dart';
import 'package:kids_points_app/screens/sheets/family_deletion_sheet.dart';

/// W7-D：家庭数据删除（`/family-deletion`）。
///
/// 这些用例钉住的是**家长能看出来的事**：
///   ① 「正在删除」必须说得出**还剩几天 / 能不能撤销**（服务端给，客户端不猜）；
///   ② 「已删除」必须带**执行摘要**；没有摘要的「已删除」等于「删了什么不知道」；
///   ③ 形状自相矛盾（none 带申请时间、executed 带 canCancel）一律 `malformed`；
///   ④ 申请请求体**只有** `{"confirmed":true}` —— 孩子 / 冷却期 / 操作人都由服务端决定；
///   ⑤ 读失败**不清空**上一次的状态（否则一次断网会把「将于 X 日删除」说成「从未申请」）。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  Map<String, Object?> summaryJson({
    int keptRecords = 4,
    int keptBalance = 7,
    Map<String, int>? redacted,
  }) =>
      <String, Object?>{
        'coolingDays': 7,
        'redacted': redacted ??
            <String, int>{
              'child': 1,
              'members': 2,
              'rules': 1,
              'ruleVersions': 1,
              'habits': 1,
              'wishes': 1,
              'records': 4,
              'approvals': 1,
              'consents': 1,
              'notifications': 2,
            },
        'kept': <String, Object?>{
          'records': keptRecords,
          'pointsBalance': keptBalance,
        },
        'note': '账本流水与余额按 02 §5.7 I5 保留；描述性文本与身份痕迹已匿名化。',
      };

  Map<String, Object?> deletionJson({
    String status = 'none',
    bool canCancel = false,
    int? daysRemaining,
    bool withSummary = false,
    bool withRequest = false,
  }) {
    final bool hasRequest = withRequest || status != 'none';
    return <String, Object?>{
      'childId': 'child-1',
      'status': status,
      'requestedAt': hasRequest ? '2026-10-27T01:00:00.000Z' : null,
      'scheduledFor': hasRequest ? '2026-11-03T01:00:00.000Z' : null,
      'cancelledAt':
          status == 'cancelled' ? '2026-10-28T01:00:00.000Z' : null,
      'executedAt':
          status == 'executed' ? '2026-11-03T01:00:00.000Z' : null,
      'daysRemaining': daysRemaining,
      'canCancel': canCancel,
      'summary': withSummary ? summaryJson() : null,
    };
  }

  group('FamilyDeletionStateDto：形状自相矛盾一律 malformed', () {
    test('pending：带申请时间、执行时刻、剩余天数，且可撤销', () {
      final FamilyDeletionStateDto dto = FamilyDeletionStateDto.fromJson(
        deletionJson(
          status: 'pending',
          canCancel: true,
          daysRemaining: 7,
        ),
      );

      expect(dto.status, 'pending');
      expect(dto.daysRemaining, 7);
      expect(dto.canCancel, isTrue);
      expect(dto.summary, isNull);
    });

    test('pending 缺 daysRemaining ⇒ malformed（客户端不按本地时钟猜）', () {
      expect(
        () => FamilyDeletionStateDto.fromJson(
          deletionJson(status: 'pending', canCancel: true),
        ),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.kind,
          'kind',
          ReadFailureKind.malformed,
        )),
      );
    });

    test('pending 但 canCancel=false ⇒ malformed（这两件事必须同时成立）', () {
      expect(
        () => FamilyDeletionStateDto.fromJson(
          deletionJson(status: 'pending', daysRemaining: 7),
        ),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('executed 缺 summary ⇒ malformed（「删了什么」无从回答）', () {
      expect(
        () => FamilyDeletionStateDto.fromJson(deletionJson(status: 'executed')),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.detail ?? '',
          'detail',
          contains('摘要'),
        )),
      );
    });

    test('none 带 summary / 带申请时间 ⇒ malformed（别人的历史拼进来了）', () {
      expect(
        () => FamilyDeletionStateDto.fromJson(
          deletionJson(status: 'none', withSummary: true),
        ),
        throwsA(isA<ReadApiException>()),
      );
      expect(
        () => FamilyDeletionStateDto.fromJson(
          deletionJson(status: 'none', withRequest: true),
        ),
        throwsA(isA<ReadApiException>()),
      );
    });

    test('未知状态 ⇒ malformed（绝不默认成 none）', () {
      expect(
        () => FamilyDeletionStateDto.fromJson(deletionJson(status: 'deleting')),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.kind,
          'kind',
          ReadFailureKind.malformed,
        )),
      );
    });

    test('摘要缺一类行数 / 冷却期非正数 ⇒ malformed', () {
      final Map<String, Object?> missing = deletionJson(
        status: 'executed',
        withSummary: true,
      );
      final Map<String, Object?> summary =
          missing['summary']! as Map<String, Object?>;
      final Map<String, int> redacted =
          Map<String, int>.from(summary['redacted']! as Map);
      redacted.remove('records');
      summary['redacted'] = redacted;
      expect(
        () => FamilyDeletionStateDto.fromJson(missing),
        throwsA(isA<ReadApiException>()),
      );

      final Map<String, Object?> zeroCooling = deletionJson(
        status: 'executed',
        withSummary: true,
      );
      final Map<String, Object?> zeroSummary =
          zeroCooling['summary']! as Map<String, Object?>;
      zeroSummary['coolingDays'] = 0;
      expect(
        () => FamilyDeletionStateDto.fromJson(zeroCooling),
        throwsA(isA<ReadApiException>()),
      );
    });
  });

  group('FamilyDeletion：界面口径（状态 / 截止日 / 摘要）', () {
    test('pending：截止日取 scheduledFor，剩余天数用服务端给的 7', () {
      final FamilyDeletion state = mapFamilyDeletion(
        FamilyDeletionStateDto.fromJson(
          deletionJson(status: 'pending', canCancel: true, daysRemaining: 7),
        ),
      );

      final DateTime local = state.scheduledFor!.toLocal();
      String two(int value) => value.toString().padLeft(2, '0');
      expect(
        state.deadlineText,
        '将于 ${local.year}-${two(local.month)}-${two(local.day)} 删除',
      );
      expect(state.remainingText, '还有 7 天可以撤销');
      expect(state.statusLabel, '已申请删除');
      expect(state.canCancel, isTrue);
    });

    test('剩余 0 天说的是「即将执行」，不是「已删除」', () {
      final FamilyDeletion state = mapFamilyDeletion(
        FamilyDeletionStateDto.fromJson(
          deletionJson(status: 'pending', canCancel: true, daysRemaining: 0),
        ),
      );
      expect(state.remainingText, '即将执行（等待后台任务）');
    });

    test('executed：摘要只列出真的动过的行，账本条数与余额原样显示', () {
      final FamilyDeletion state = mapFamilyDeletion(
        FamilyDeletionStateDto.fromJson(
          deletionJson(status: 'executed', withSummary: true),
        ),
      );

      expect(state.status, FamilyDeletionStatus.executed);
      expect(state.canCancel, isFalse);
      expect(state.statusLabel, '已删除');
      expect(state.deadlineText, contains('已于'));
      final FamilyDeletionSummary summary = state.summary!;
      expect(summary.changedRows.length, 10);
      expect(summary.changedRows.first.key, 'child');
      expect(summary.labelFor('ruleVersions'), '规则版本');
      expect(summary.labelFor('mystery'), 'mystery');
      expect(summary.keptText, '保留 4 条流水与余额 7 分');
    });

    test('全 0 的摘要不画一排 0（changedRows 为空）', () {
      final FamilyDeletion state = mapFamilyDeletion(
        FamilyDeletionStateDto.fromJson(
          <String, Object?>{
            ...deletionJson(status: 'executed', withSummary: true),
            'summary': summaryJson(
              redacted: <String, int>{
                'child': 0,
                'members': 0,
                'rules': 0,
                'ruleVersions': 0,
                'habits': 0,
                'wishes': 0,
                'records': 0,
                'approvals': 0,
                'consents': 0,
                'notifications': 0,
              },
            ),
          },
        ),
      );
      expect(state.summary!.changedRows, isEmpty);
    });
  });

  group('AppStore.loadFamilyDeletion：失败保留旧状态、预览模式不发请求', () {
    test('预览模式直接进入 ready 空态（不编一个「未申请」）', () async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);

      await store.loadFamilyDeletion();

      expect(store.isLiveMode, isFalse);
      expect(store.familyDeletion, isNull);
      expect(store.deletionReadStatus, ReadStatus.ready);
      expect(store.deletionError, isNull);
      expect(store.isDeletionBusy, isFalse);
    });

    test('成功时存下服务端状态', () async {
      final _DeletionTransport transport = _DeletionTransport(
        readBody: jsonEncode(
          deletionJson(status: 'pending', canCancel: true, daysRemaining: 6),
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.loadFamilyDeletion();

      expect(transport.readCalls, 1);
      expect(store.deletionReadStatus, ReadStatus.ready);
      expect(store.deletionError, isNull);
      expect(store.familyDeletion!.status, FamilyDeletionStatus.pending);
      expect(store.familyDeletion!.daysRemaining, 6);
    });

    test('403 照实报错，且**不清空**上一次的状态', () async {
      final _DeletionTransport transport = _DeletionTransport(
        readBody: jsonEncode(
          deletionJson(status: 'pending', canCancel: true, daysRemaining: 7),
        ),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.loadFamilyDeletion();
      final DateTime? firstScheduledFor = store.familyDeletion!.scheduledFor;

      transport.readStatus = 403;
      transport.readBody = '{"code":"FORBIDDEN","message":"缺少权限"}';
      await store.loadFamilyDeletion();

      expect(store.deletionReadStatus, ReadStatus.error);
      expect(store.deletionError!.kind, ReadFailureKind.forbidden);
      expect(store.deletionError!.statusCode, 403);
      expect(
        store.familyDeletion!.scheduledFor,
        firstScheduledFor,
        reason: '失败不能把「将于 X 日删除」说成「从未申请」',
      );
    });
  });

  group('AppStore 写入口：申请带 confirmed:true、撤销无 body', () {
    test('申请：POST /family-deletion + {"confirmed":true}，成功后存 pending', () async {
      final _DeletionWriteTransport write = _DeletionWriteTransport(
        body: jsonEncode(
          deletionJson(status: 'pending', canCancel: true, daysRemaining: 7),
        ),
      );
      final AppStore store = AppStore(readApi: ReadApiClient(config: config, transport: _DeletionTransport()), writeApi: WriteApiClient(config: config, transport: write));
      addTearDown(store.dispose);

      final String? error = await store.requestFamilyDeletion();

      expect(error, isNull);
      expect(write.calls.length, 1);
      expect(write.calls.single.method, 'POST');
      expect(write.calls.single.path, '/api/family-deletion');
      expect(write.calls.single.body, '{"confirmed":true}');
      expect(store.familyDeletion!.status, FamilyDeletionStatus.pending);
      expect(store.isDeletionBusy, isFalse);
    });

    test('申请回包不是 pending ⇒ 报「不符合约定」，绝不显示成已申请', () async {
      final _DeletionWriteTransport write = _DeletionWriteTransport(
        body: jsonEncode(deletionJson(status: 'none')),
      );
      final AppStore store = AppStore(readApi: ReadApiClient(config: config, transport: _DeletionTransport()), writeApi: WriteApiClient(config: config, transport: write));
      addTearDown(store.dispose);

      final String? error = await store.requestFamilyDeletion();

      expect(error, isNotNull);
      expect(error, contains('不符合约定'));
      expect(store.familyDeletion, isNull);
    });

    test('撤销：POST /family-deletion/cancel，不带 body，成功后存 cancelled', () async {
      final _DeletionWriteTransport write = _DeletionWriteTransport(
        body: jsonEncode(deletionJson(status: 'cancelled')),
      );
      final AppStore store = AppStore(readApi: ReadApiClient(config: config, transport: _DeletionTransport()), writeApi: WriteApiClient(config: config, transport: write));
      addTearDown(store.dispose);

      final String? error = await store.cancelFamilyDeletion();

      expect(error, isNull);
      expect(write.calls.single.path, '/api/family-deletion/cancel');
      expect(write.calls.single.body, isEmpty);
      expect(store.familyDeletion!.status, FamilyDeletionStatus.cancelled);
    });

    test('预览模式不发请求（也就不会假装删了）', () async {
      final _DeletionWriteTransport write = _DeletionWriteTransport(
        body: jsonEncode(deletionJson(status: 'pending')),
      );
      final AppStore store = AppStore();
      addTearDown(store.dispose);

      expect(await store.requestFamilyDeletion(), contains('预览模式'));
      expect(write.calls, isEmpty);
    });
  });

  group('FamilyDeletionSheet：预览模式只说明「不会执行删除」', () {
    testWidgets('预览模式不给申请按钮', (WidgetTester tester) async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (BuildContext context) => Scaffold(
              body: FamilyDeletionSheet(
                store: store,
                messenger: ScaffoldMessenger.of(context),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('预览模式没有真实的家庭数据'), findsOneWidget);
      expect(find.text('申请删除…'), findsNothing);
    });
  });
}

/// 只实现 `GET /family-deletion` 的读传输（其余路径直接失败）。
class _DeletionTransport implements ReadTransport {
  _DeletionTransport({this.readBody = '{}'});

  String readBody;
  int readStatus = 200;
  int readCalls = 0;

  @override
  Future<ReadHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
  ) async {
    if (uri.path.endsWith('/family-deletion')) {
      readCalls += 1;
      expect(headers[kDeviceIdHeader], 'device-1');
      expect(headers[kChildIdHeader], 'child-1');
      return ReadHttpResponse(statusCode: readStatus, body: readBody);
    }
    throw UnimplementedError('删除测试不该请求 ${uri.path}');
  }

  @override
  void close() {}
}

class _WriteCall {
  _WriteCall(this.method, this.path, this.body);

  final String method;
  final String path;
  final String body;
}

/// 只实现删除两条写入口的写传输（记录调用，回包可注入）。
class _DeletionWriteTransport implements WriteTransport {
  _DeletionWriteTransport({required this.body});

  String body;
  int status = 200;
  final List<_WriteCall> calls = <_WriteCall>[];

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    calls.add(_WriteCall(method, uri.path, body));
    return WriteHttpResponse(statusCode: status, body: this.body);
  }

  @override
  void close() {}
}
