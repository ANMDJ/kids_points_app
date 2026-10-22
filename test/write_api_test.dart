import 'dart:async';
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
import 'package:kids_points_app/models/habit.dart';
import 'package:kids_points_app/models/invite.dart';
import 'package:kids_points_app/models/member.dart';
import 'package:kids_points_app/models/point_record.dart';
import 'package:kids_points_app/models/point_rule.dart';
import 'package:kids_points_app/models/trash.dart';
import 'package:kids_points_app/models/wish.dart';

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
    String note = '',
  }) {
    return <String, Object?>{
      'id': id,
      'title': title,
      'points': points,
      'category': category,
      'source': source,
      'operatorRole': 'guardian',
      'note': note,
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
    String title = '认真刷牙',
    String category = 'praise',
    String source = 'guardian',
    int points = 1,
    String? reversesRecordId,
    int balanceAfter = 11,
    String? habitId = 'habit-1',
    String note = '',
  }) {
    return jsonEncode(<String, Object?>{
      'record': recordJson(
        id: id,
        title: title,
        category: category,
        source: source,
        points: points,
        reversesRecordId: reversesRecordId,
        balanceAfter: balanceAfter,
        habitId: habitId,
        note: note,
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

  /// 心愿 DTO（`POST /wishes` 的回包与 `GET /home` 的 `wishes[]` 同构）。
  Map<String, Object?> wishJson({
    String id = 'wish-1',
    String title = '去游乐园',
    int cost = 40,
    String emoji = '🎡',
    String coverStyle = 'A',
    bool redeemed = false,
  }) {
    return <String, Object?>{
      'id': id,
      'title': title,
      'cost': cost,
      'emoji': emoji,
      'coverStyle': coverStyle,
      'redeemed': redeemed,
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

    test('记一笔 POST /records/adjust：带符号分值原样发，备注去空白', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: writtenJson(
              id: 'adjust-1',
              title: '主动帮忙做家务',
              category: 'adjust',
              points: -5,
              habitId: null,
              note: '洗碗',
              balanceAfter: 6,
            ),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final WrittenRecordDto result = await client.adjust(
        title: '  主动帮忙做家务  ',
        points: -5,
        note: '  洗碗  ',
        idempotencyKey: 'adjust-key',
      );

      expect(result.record.id, 'adjust-1');
      expect(result.record.points, -5);
      expect(result.record.balanceAfter, 6);

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/records/adjust');
      expect(jsonDecode(call.body), <String, Object?>{
        'title': '主动帮忙做家务',
        'points': -5,
        'note': '洗碗',
      });
      expect(call.headers[kDeviceIdHeader], 'device-1');
      expect(call.headers[kChildIdHeader], 'child-1');
      expect(call.headers['idempotency-key'], 'adjust-key');
    });

    test('记一笔：空事由 / 0 分在本地就拒，不发请求', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          fail('非法入参不得发请求');
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.adjust(title: '   ', points: 1),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        client.adjust(title: '零分', points: 0),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.calls, isEmpty);
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
      final Map<String, Object?> broken = ruleJson()..remove('currentVersion');
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

  group('心愿写端点（W5-C）：新增 POST /wishes · 删除 DELETE /wishes/:id', () {
    test('新增 POST /wishes：标题去空白 + 不传 coverStyle（配色由服务端算）', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: jsonEncode(wishJson(title: '去游乐园')),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final WishDto wish = await client.createWish(
        title: '  去游乐园  ',
        cost: 40,
        emoji: '🎡',
        idempotencyKey: 'key-wish',
      );

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/wishes');
      expect(call.headers['x-kp-device-id'], 'device-1');
      expect(call.headers['x-kp-child-id'], 'child-1');
      expect(call.headers['idempotency-key'], 'key-wish');
      final Map<String, Object?> sent =
          jsonDecode(call.body) as Map<String, Object?>;
      expect(sent['title'], '去游乐园');
      expect(sent['cost'], 40);
      expect(sent['emoji'], '🎡');
      expect(
        sent.containsKey('coverStyle'),
        isFalse,
        reason: '配色只能由服务端按「空档优先，否则 id 哈希」决定；客户端自带一份必然对不上',
      );
      expect(wish.id, 'wish-1');
      expect(wish.coverStyle, 'A');
    });

    test('新增：空标题 / 0 分在本地就拒，一次请求都不发', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          fail('不该发出请求');
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.createWish(title: '   ', cost: 40, emoji: '🎡'),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        client.createWish(title: '去游乐园', cost: 0, emoji: '🎡'),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.calls, isEmpty);
    });

    test('删除 DELETE /wishes/:id：无请求体，回包 wishId 必须一致', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'wishId': 'wish-1'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final String deleted =
          await client.deleteWish('wish-1', idempotencyKey: 'key-del');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'DELETE');
      expect(call.uri.path, '/api/wishes/wish-1');
      expect(call.body, isEmpty, reason: '目标心愿已在路径里，不需要 body');
      expect(call.headers['idempotency-key'], 'key-del');
      expect(deleted, 'wish-1');
    });

    test('删除回包确认的是别的心愿 ⇒ malformed，不假装删对了', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'wishId': 'wish-2'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.deleteWish('wish-1'),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.kind,
          'kind',
          WriteFailureKind.malformed,
        )),
      );
    });
  });
  group('习惯删除 + 回收站写端点（W5-F）：DELETE /habits · /trash/:kind/:id', () {
    test('删除 DELETE /habits/:id：无请求体，回包 habitId 必须一致', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'habitId': 'habit-1'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final String deleted =
          await client.deleteHabit('habit-1', idempotencyKey: 'key-habit');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'DELETE');
      expect(call.uri.path, '/api/habits/habit-1');
      expect(call.body, isEmpty, reason: '目标习惯已在路径里，不需要 body');
      expect(call.headers['idempotency-key'], 'key-habit');
      expect(deleted, 'habit-1');
    });

    test('删除回包确认的是别的习惯 ⇒ malformed，不假装删对了', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'habitId': 'habit-2'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.deleteHabit('habit-1'),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.kind,
          'kind',
          WriteFailureKind.malformed,
        )),
      );
    });

    test('恢复 POST /trash/:kind/:id/restore：kind 拼进路径，回包必须指同一条', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'kind': 'wish', 'id': 'wish-1'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final TrashTargetDto target =
          await client.restoreTrashItem('wish', 'wish-1');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/trash/wish/wish-1/restore');
      expect(call.body, isEmpty, reason: '目标已在路径里（恢复幂等，不需要幂等键）');
      expect(target.kind, 'wish');
      expect(target.id, 'wish-1');
    });

    test('恢复回包指向别的一条 ⇒ malformed（界面不能以为恢复了 A）', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'kind': 'wish', 'id': 'wish-9'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.restoreTrashItem('wish', 'wish-1'),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.kind,
          'kind',
          WriteFailureKind.malformed,
        )),
      );
    });

    test('彻底删除 DELETE /trash/:kind/:id：无请求体', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body:
                jsonEncode(<String, Object?>{'kind': 'habit', 'id': 'habit-1'}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final TrashTargetDto target =
          await client.purgeTrashItem('habit', 'habit-1');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'DELETE');
      expect(call.uri.path, '/api/trash/habit/habit-1');
      expect(call.body, isEmpty);
      expect(target.id, 'habit-1');
    });

    test('未知 kind 在发请求之前就失败（不让服务端回一条可避免的 400）', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(statusCode: 200, body: '{}');
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.restoreTrashItem('record', 'record-1'),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        client.purgeTrashItem('records', 'record-1'),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.calls, isEmpty);
    });
  });

  group('兑换心愿（W5-C）：POST /approvals（action=redeem）', () {
    test('只发 action + targetId：不带 costSnapshot / autoApprove', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 202,
            body: jsonEncode(<String, Object?>{
              'id': 'approval-1',
              'action': 'redeem',
              'status': 'pending',
              'requesterUserId': 'member-1',
              'decidedByUserId': null,
              'executedRecordId': null,
              'autoReason': null,
            }),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final ApprovalDto approval = await client.requestRedeem(
        'wish-1',
        idempotencyKey: 'key-redeem',
      );

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/approvals');
      expect(call.headers['x-kp-device-id'], 'device-1');
      expect(call.headers['x-kp-child-id'], 'child-1');
      expect(call.headers['idempotency-key'], 'key-redeem');
      expect(
        jsonDecode(call.body),
        <String, Object?>{'action': 'redeem', 'targetId': 'wish-1'},
        reason: 'costSnapshot 必须由服务端按当前心愿价快照；'
            'autoApprove 是申请人自批勾选，这个界面不该代勾',
      );
      expect(approval.status, 'pending');
      expect(approval.executedRecordId, isNull);
    });

    test('空 wishId 在本地就拒，一次请求都不发', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          fail('不该发出请求');
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.requestRedeem('   '),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.calls, isEmpty);
    });

    test('回包缺 status ⇒ malformed（宁可报错也不猜审批结果）', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 202,
            body: jsonEncode(<String, Object?>{
              'id': 'approval-1',
              'action': 'redeem',
            }),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.requestRedeem('wish-1'),
        throwsA(isA<WriteApiException>().having(
          (WriteApiException e) => e.kind,
          'kind',
          WriteFailureKind.malformed,
        )),
      );
    });
  });

  group('撤回申请（W5-J）：POST /approvals/:id/withdraw（无请求体）', () {
    String withdrawnJson({String status = 'withdrawn'}) =>
        jsonEncode(<String, Object?>{
          'id': 'approval-1',
          'action': 'redeem',
          'status': status,
          'executedRecordId': null,
          'autoReason': null,
        });

    test('POST + id 去空白 + 空 body + 幂等键；绝不带 applicant 参数', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(statusCode: 200, body: withdrawnJson());
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final ApprovalDto dto = await client.withdrawApproval(
        '  approval-1  ',
        idempotencyKey: 'key-withdraw',
      );

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/approvals/approval-1/withdraw');
      expect(call.headers[kDeviceIdHeader], 'device-1');
      expect(call.headers[kChildIdHeader], 'child-1');
      expect(call.headers['idempotency-key'], 'key-withdraw');
      expect(call.body.trim(), isEmpty,
          reason: '申请人由会话决定；请求体里多一个 userId 就是越权入口');
      expect(dto.status, 'withdrawn');
      expect(dto.executedRecordId, isNull);
    });

    test('空 id 在本地就拒，一个请求都不发', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          fail('空 id 不得发请求');
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.withdrawApproval('   '),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.calls, isEmpty);
    });

    test('403 NOT_REQUESTER / 409 ALREADY_DECIDED 的原生文案', () {
      final WriteApiException forbidden = WriteApiException.fromHttp(
        statusCode: 403,
        body: <String, Object?>{
          'code': 'NOT_REQUESTER',
          'message': 'not requester',
        },
      );
      expect(forbidden.kind, WriteFailureKind.forbidden);
      expect(forbidden.userMessage, contains('不是你提交的申请'));

      final WriteApiException conflict = WriteApiException.fromHttp(
        statusCode: 409,
        body: <String, Object?>{
          'code': 'ALREADY_DECIDED',
          'message': 'already decided',
        },
      );
      expect(conflict.kind, WriteFailureKind.conflict);
      expect(conflict.userMessage, contains('已经被处理'));
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

    test('404 区分习惯 / 流水 / 心愿，不冒充「孩子档案不存在」', () {
      final WriteApiException habit = WriteApiException.fromHttp(
        statusCode: 404,
        body: <String, Object?>{'code': 'HABIT_NOT_FOUND'},
      );
      final WriteApiException record = WriteApiException.fromHttp(
        statusCode: 404,
        body: <String, Object?>{'code': 'RECORD_NOT_FOUND'},
      );
      final WriteApiException wish = WriteApiException.fromHttp(
        statusCode: 404,
        body: <String, Object?>{'code': 'WISH_NOT_FOUND'},
      );
      expect(habit.kind, WriteFailureKind.notFound);
      expect(habit.userMessage, contains('习惯'));
      expect(record.userMessage, contains('打卡记录'));
      expect(wish.userMessage, contains('心愿'));
    });

    test('403 APPROVAL_REQUIRED ⇒ 说清「需要家长确认」，且不谎称已提交审批', () {
      final WriteApiException error = WriteApiException.fromHttp(
        statusCode: 403,
        body: <String, Object?>{'code': 'APPROVAL_REQUIRED'},
      );

      expect(error.kind, WriteFailureKind.forbidden);
      expect(error.code, 'APPROVAL_REQUIRED');
      expect(error.userMessage, contains('家长确认'));
      expect(error.userMessage, contains('没有保存'));
      // 403 时并没有生成审批单：说“已提交”会让家长去审批页找不到东西。
      expect(error.userMessage.contains('已提交'), isFalse);
      expect(error.isRetryable, isFalse);
    });

    test('409 WISH_ALREADY_REDEEMED ⇒ conflict，说明「没提交」而不是「失败了」', () {
      final WriteApiException error = WriteApiException.fromHttp(
        statusCode: 409,
        body: <String, Object?>{'code': 'WISH_ALREADY_REDEEMED'},
      );

      expect(error.kind, WriteFailureKind.conflict);
      expect(error.userMessage, contains('已经兑换过'));
      expect(error.userMessage, contains('没有提交'));
      expect(error.isRetryable, isFalse, reason: '重试只会被同一个 409 挡住');
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
      List<Object?>? wishes,
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
          'wishes': wishes ?? <Object?>[],
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
      expect(store.rules.single.points, -3, reason: '服务端回包已带符号，客户端只能转换一次');
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

    // ------------------------------------------------- W5-B：记一笔
    test('记一笔：live 下走 POST /records/adjust，余额与流水以服务端为准', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final int before = store.points;
      writeApi.adjustResult = WrittenRecordDto.fromJson(
        jsonDecode(
          writtenJson(
            id: 'adjust-1',
            title: '额外奖励',
            category: 'adjust',
            points: 5,
            habitId: null,
            balanceAfter: before + 5,
          ),
        ),
      );
      readTransport.homeJson = homeJson(points: before + 5);
      readTransport.pageJson = pageJson(<Object?>[
        recordJson(
          id: 'adjust-1',
          title: '额外奖励',
          category: 'adjust',
          points: 5,
          habitId: null,
          balanceAfter: before + 5,
        ),
      ]);

      final String? message =
          await store.submitQuickNote(delta: 5, reason: '额外奖励');

      expect(message, isNull);
      expect(writeApi.adjustCalls, 1);
      expect(writeApi.lastAdjustTitle, '额外奖励');
      expect(writeApi.lastAdjustPoints, 5);
      expect(writeApi.lastIdempotencyKey, isNotNull);
      expect(store.points, before + 5);
      expect(store.records.single.id, 'adjust-1');
      expect(store.records.single.points, 5);
    });

    test('记一笔：空事由用默认文案，扣分带负号发出（客户端不取反）', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      writeApi.adjustResult = WrittenRecordDto.fromJson(
        jsonDecode(
          writtenJson(
            id: 'adjust-2',
            title: '扣除积分',
            category: 'adjust',
            points: -3,
            habitId: null,
            balanceAfter: store.points - 3,
          ),
        ),
      );

      final String? message =
          await store.submitQuickNote(delta: -3, reason: '   ');

      expect(message, isNull);
      expect(writeApi.lastAdjustTitle, '扣除积分');
      expect(writeApi.lastAdjustPoints, -3);
    });

    test('记一笔：409 积分不足 ⇒ 返回可读原因，本地余额与流水不变', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final int beforePoints = store.points;
      final int beforeRecords = store.records.length;
      writeApi.adjustError = WriteApiException.fromHttp(
        statusCode: 409,
        body: <String, Object?>{'code': 'INSUFFICIENT_POINTS'},
      );

      final String? message =
          await store.submitQuickNote(delta: -99, reason: '随便扣');

      expect(message, contains('积分不足'));
      expect(store.points, beforePoints);
      expect(store.records.length, beforeRecords);
      expect(writeApi.adjustCalls, 1);
    });

    test('记一笔：live 但没注入写客户端 ⇒ 拒绝写，不偷偷改内存', () async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
      );
      addTearDown(store.dispose);
      await store.refreshFromServer();
      final int beforePoints = store.points;
      final int beforeRecords = store.records.length;

      final String? message =
          await store.submitQuickNote(delta: 2, reason: '额外奖励');

      expect(message, contains('只读模式'));
      expect(store.points, beforePoints);
      expect(store.records.length, beforeRecords);
    });

    test('记一笔：0 分在本地就拒，一次请求都不发', () async {
      final AppStore store = buildStore();

      final String? message =
          await store.submitQuickNote(delta: 0, reason: '零分');

      expect(message, '调整金额不能为 0');
      expect(writeApi.adjustCalls, 0);
    });

    // --------------------------------------------- W5-C：心愿 新增 / 删除
    test('新增心愿：live 下走 POST /wishes，随后用服务端快照刷新', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      expect(store.isWishWriteReadOnly, isFalse);
      writeApi.createWishResult = WishDto.fromJson(wishJson(), r'$');
      // 服务端此刻的「真相」：心愿已经落库，回到 /home 里。
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);

      final String? message = await store.submitAddWish(
        title: '  去游乐园  ',
        cost: 40,
        emoji: '🎡',
      );

      expect(message, isNull);
      expect(writeApi.createWishCalls, 1);
      expect(writeApi.lastTitle, '去游乐园');
      expect(writeApi.lastCost, 40);
      expect(writeApi.lastEmoji, '🎡');
      expect(writeApi.lastIdempotencyKey, startsWith('wish-create-'));
      expect(store.wishes.single.id, 'wish-1');
      expect(store.wishes.single.coverStyle, WishCoverStyle.a);
    });

    test('新增心愿：孩子需审批（403 APPROVAL_REQUIRED）⇒ 返回可读原因，列表不变', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      writeApi.wishError = WriteApiException.fromHttp(
        statusCode: 403,
        body: <String, Object?>{'code': 'APPROVAL_REQUIRED'},
      );

      final String? message = await store.submitAddWish(
        title: '去游乐园',
        cost: 40,
        emoji: '🎡',
      );

      expect(message, contains('家长确认'));
      expect(message, contains('没有保存'));
      expect(store.wishes, isEmpty, reason: '没有保存就不能出现在心愿单里');
      expect(writeApi.createWishCalls, 1);
    });

    test('新增心愿：空标题 / 0 分在本地就拒，一次请求都不发', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();

      expect(
        await store.submitAddWish(title: '   ', cost: 40, emoji: '🎡'),
        '先给心愿起个名字吧～',
      );
      expect(
        await store.submitAddWish(title: '去游乐园', cost: 0, emoji: '🎡'),
        '心愿需要的积分至少是 1 分',
      );
      expect(writeApi.createWishCalls, 0);
    });

    test('删除心愿：DELETE /wishes/:id，进回收站且不再出现在心愿单', () async {
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final Wish wish = store.wishes.single;
      readTransport.homeJson = homeJson(); // 服务端视角：已软删

      final String? message = await store.submitRemoveWish(wish);

      expect(message, isNull);
      expect(writeApi.deleteWishCalls, 1);
      expect(writeApi.lastWishId, 'wish-1');
      expect(writeApi.lastIdempotencyKey, startsWith('wish-delete-'));
      expect(store.wishes, isEmpty);
      // live 模式下「回收站」条目来自服务端快照（当前 `/home` 没有回收站 feed），
      // 所以本地软删标记会被随后的刷新覆盖 —— 这里只钉住「列表里消失了」，
      // 不假装本地回收站已经有了服务端记录。
      expect(
        store.records.where((PointRecord r) => r.points < 0),
        isEmpty,
        reason: '删心愿不碰流水：扣分记录只在真正兑换时产生',
      );
    });

    test('心愿：live 但没注入写客户端 ⇒ 拒绝写，不偷偷改内存', () async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
      );
      addTearDown(store.dispose);
      await store.refreshFromServer();

      final String? addMessage = await store.submitAddWish(
        title: '去游乐园',
        cost: 40,
        emoji: '🎡',
      );

      expect(addMessage, contains('只读模式'));
      expect(store.wishes, isEmpty, reason: '不能悄悄写进本地，让人以为保存了');
      expect(store.isWishWriteReadOnly, isTrue);

      final String? redeemMessage = await store.submitRedeemWish(
        Wish(
          id: 'wish-1',
          title: '去游乐园',
          cost: 40,
          emoji: '🎡',
          coverStyle: WishCoverStyle.a,
        ),
      );
      expect(redeemMessage, contains('只读模式'));
    });

    // --------------------------------------------- W5-C：心愿兑换（approvals）
    test('兑换心愿：live 下走 POST /approvals，pending 只说「已提交」，不扣分', () async {
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final int beforePoints = store.points;
      writeApi.requestRedeemResult = ApprovalDto(
        id: 'approval-1',
        action: 'redeem',
        status: 'pending',
        executedRecordId: null,
        autoReason: null,
      );

      final String? message = await store.submitRedeemWish(store.wishes.single);

      expect(writeApi.requestRedeemCalls, 1);
      expect(writeApi.lastWishId, 'wish-1');
      expect(writeApi.lastIdempotencyKey, startsWith('wish-redeem-'));
      expect(message, contains('已提交给家长确认'));
      expect(
        message,
        contains('批准后才会扣'),
        reason: 'pending 只是申请，扣分要等家长点头',
      );
      expect(
        message?.contains('兑换成功'),
        isFalse,
        reason: 'pending 时还没有扣分，说“成功”就是骗人',
      );
      expect(store.points, beforePoints, reason: '审批没批之前余额不能动');
      expect(store.wishes.single.redeemed, isFalse);
      expect(
        store.records.where((PointRecord r) => r.points < 0),
        isEmpty,
        reason: 'pending 不该产生任何扣分流水',
      );
    });

    test('兑换心愿：approved ⇒ 以服务端快照为准，客户端不自己扣分', () async {
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      // 服务端批准后的真相：余额 11 → 1，心愿已标记兑换。
      readTransport.homeJson = homeJson(
        points: 1,
        wishes: <Object?>[wishJson(redeemed: true)],
      );
      writeApi.requestRedeemResult = ApprovalDto(
        id: 'approval-1',
        action: 'redeem',
        status: 'approved',
        executedRecordId: 'record-9',
        autoReason: null,
      );

      final String? message = await store.submitRedeemWish(store.wishes.single);

      expect(message, isNull);
      expect(store.points, 1);
      expect(store.wishes.single.redeemed, isTrue);
    });

    test('兑换心愿：invalidated ⇒ 说清是哪条前提消失，余额不变', () async {
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      final int beforePoints = store.points;
      writeApi.requestRedeemResult = ApprovalDto(
        id: 'approval-1',
        action: 'redeem',
        status: 'invalidated',
        executedRecordId: null,
        autoReason: 'INSUFFICIENT_POINTS',
      );

      final String? message = await store.submitRedeemWish(store.wishes.single);

      expect(message, contains('积分不够'));
      expect(message, contains('积分没有变动'));
      expect(store.points, beforePoints);
    });

    test('兑换心愿：未知状态不猜，让人刷新确认', () async {
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();
      writeApi.requestRedeemResult = ApprovalDto(
        id: 'approval-1',
        action: 'redeem',
        status: 'someday-new-status',
        executedRecordId: null,
        autoReason: null,
      );

      final String? message = await store.submitRedeemWish(store.wishes.single);

      expect(message, contains('未知的审批状态'));
      expect(message, contains('刷新'));
    });

    test('兑换心愿：空心愿 id 在本地就拒，一次请求都不发', () async {
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);
      final AppStore store = buildStore();
      await store.refreshFromServer();

      final String? message = await store.submitRedeemWish(
        Wish(
          id: '   ',
          title: '去游乐园',
          cost: 40,
          emoji: '🎡',
          coverStyle: WishCoverStyle.a,
        ),
      );

      expect(message, contains('心愿 id'));
      expect(
        writeApi.requestRedeemCalls,
        0,
        reason: '空 id 若发出去只会抛 ArgumentError，再被兜底文案说成「申请已发出」',
      );
    });

    test('兑换确认文案：live 说「提交申请、批准后才扣」，预览说「立即扣除」', () async {
      readTransport.homeJson = homeJson(wishes: <Object?>[wishJson()]);
      final AppStore live = buildStore();
      await live.refreshFromServer();

      final String liveText = live.redeemConfirmText(live.wishes.single);

      expect(liveText, contains('提交给家长确认'));
      expect(liveText, contains('批准后才会扣 40 分'));
      expect(
        liveText,
        contains('现在还没有扣'),
        reason: 'live 只是建审批，弹窗不能暗示已经扣分',
      );
      expect(
        liveText.contains('立即扣除'),
        isFalse,
        reason: '「立即扣除」只属于预览模式；live 说这句就是在骗人',
      );

      final AppStore preview = AppStore();
      addTearDown(preview.dispose);
      expect(preview.resetToSeed(), isTrue, reason: '预览模式要有演示心愿才谈得上确认文案');
      final Wish previewWish = preview.wishes.first;
      final String previewText = preview.redeemConfirmText(previewWish);

      expect(previewText, contains('立即扣除'));
      expect(previewText, contains('${previewWish.cost} 分'));
      expect(
        previewText.contains('提交给家长确认'),
        isFalse,
        reason: '预览模式没有服务端可申请，写「等家长确认」等于演戏',
      );
    });
  });

  test('记一笔：预览模式仍走本地 addQuickNote，返回值语义不变', () async {
    final AppStore store = AppStore();
    addTearDown(store.dispose);
    final int before = store.points;

    final String? message =
        await store.submitQuickNote(delta: 4, reason: '预览奖励');

    expect(message, isNull);
    expect(store.points, before + 4);
    expect(store.records.first.points, 4);
    expect(store.records.first.title, '预览奖励');
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
    expect(find.text('数据来自服务器 · 打卡 / 记一笔 / 兑换 / 昵称均会实时保存'), findsOneWidget);

    await tester.tap(find.text('认真刷牙'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(writeApi.checkInCalls, 1, reason: 'live 模式必须真的写服务端');
    expect(find.textContaining('太棒了'), findsOneWidget);
  });

  testWidgets('live 心愿单：点兑换先弹确认，取消不发请求，确认才提交审批', (WidgetTester tester) async {
    // 心愿单是两列网格，默认 800×600 的测试视口下卡片会被裁掉，
    // 点不到「兑换」；这里放大到 400×800 逻辑像素（同 app_test 的 pumpApp）。
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final _ScriptedReadTransport redeemReadTransport = _ScriptedReadTransport(
      homeJson: jsonEncode(<String, Object?>{
        'child': <String, Object?>{
          'id': 'child-1',
          'name': '小明',
          'pointsBalance': 100,
        },
        'goodHabitCount': 0,
        'rewardCount': 0,
        'habits': <Object?>[],
        'rules': <Object?>[],
        'wishes': <Object?>[
          <String, Object?>{
            'id': 'wish-1',
            'title': '去游乐园',
            'cost': 40,
            'emoji': '🎡',
            'coverStyle': 'A',
            'redeemed': false,
          },
        ],
      }),
      pageJson: jsonEncode(<String, Object?>{
        'records': <Object?>[],
        'limit': 50,
        'hasMore': false,
        'nextCursor': null,
      }),
    );
    final _FakeWriteApi redeemWriteApi = _FakeWriteApi()
      ..requestRedeemResult = ApprovalDto(
        id: 'approval-1',
        action: 'redeem',
        status: 'pending',
        executedRecordId: null,
        autoReason: null,
      );
    final AppStore store = AppStore(
      readApi: ReadApiClient(config: config, transport: redeemReadTransport),
      writeApi: redeemWriteApi,
    );
    addTearDown(store.dispose);

    await tester.pumpWidget(PointsApp(store: store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('心愿单'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('兑换').first);
    await tester.pumpAndSettle();

    expect(find.text('兑换心愿'), findsOneWidget);
    expect(find.textContaining('家长批准后才会扣'), findsOneWidget);
    expect(
      redeemWriteApi.requestRedeemCalls,
      0,
      reason: '弹确认层的那一刻，一个请求都不该发出去',
    );

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    expect(find.text('兑换心愿'), findsNothing);
    expect(redeemWriteApi.requestRedeemCalls, 0, reason: '取消就是什么都不做');
    expect(store.points, 100);

    await tester.tap(find.text('兑换').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('提交申请'));
    await tester.pumpAndSettle();

    expect(redeemWriteApi.requestRedeemCalls, 1);
    expect(redeemWriteApi.lastWishId, 'wish-1');
    expect(find.textContaining('已提交给家长确认'), findsOneWidget);
    expect(store.points, 100, reason: 'pending 时不能动余额');
  });

  // ================================================== W5-E：PATCH /child 改昵称
  //
  // 这一组钉住「改昵称」与前面几组**不一样**的两件事：
  //   ① 服务端返回的 `name` / `childId` 是权威值 —— 本地不能照抄输入；
  //   ② 昵称是**孩子身份的一部分**，回包里的 `childId` 对不上就不能写进档案，
  //      否则家长设备上的一次改名可能落到另一个孩子头上。
  group('档案写端点（W5-E）：PATCH /child', () {
    test('PATCH /child：方法 / 路径 / body / 身份头，且不带幂等键', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{
              'childId': 'child-1',
              'name': '小明明',
            }),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final ChildProfileDto dto = await client.renameChild('  小明明  ');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'PATCH');
      expect(call.uri.path, '/api/child');
      expect(jsonDecode(call.body), <String, Object?>{'name': '小明明'});
      expect(call.headers[kDeviceIdHeader], 'device-1');
      expect(call.headers[kChildIdHeader], 'child-1');
      expect(
        call.headers.containsKey('idempotency-key'),
        isFalse,
        reason: '改成同一个名字是幂等的，PATCH 不需要幂等键',
      );
      expect(dto.childId, 'child-1');
      expect(dto.name, '小明明');
    });

    test('空白昵称在本地就拒，一个请求都不发', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          fail('空昵称不得发请求');
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.renameChild('   '),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.calls, isEmpty);
    });

    test('回包 childId 与当前会话不一致 ⇒ malformed，名字不落地', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{
              'childId': 'child-2',
              'name': '别人家的孩子',
            }),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.renameChild('小明明'),
        throwsA(
          isA<WriteApiException>()
              .having(
                (WriteApiException e) => e.code,
                'code',
                'MALFORMED_RESPONSE',
              )
              .having(
                (WriteApiException e) => e.kind,
                'kind',
                WriteFailureKind.malformed,
              ),
        ),
      );
    });

    test('服务端 400 的两个业务码翻成可展示中文（不出现裸状态码）', () async {
      Future<WriteApiException> fail400(String code) async {
        final _FakeWriteTransport transport = _FakeWriteTransport(
          (Uri uri, Map<String, String> headers, String body) async {
            return WriteHttpResponse(
              statusCode: 400,
              body: jsonEncode(<String, Object?>{
                'statusCode': 400,
                'code': code,
                'message': 'backend english message',
              }),
            );
          },
        );
        final WriteApiClient client =
            WriteApiClient(config: config, transport: transport);
        try {
          await client.renameChild('这个名字有点长');
          fail('$code 必须抛出 WriteApiException');
        } on WriteApiException catch (error) {
          return error;
        }
      }

      final WriteApiException tooLong = await fail400('CHILD_NAME_TOO_LONG');
      expect(tooLong.userMessage, contains('16 个字符'));
      expect(tooLong.userMessage, isNot(contains('400')));

      final WriteApiException empty = await fail400('CHILD_NAME_EMPTY');
      expect(empty.userMessage, contains('不能为空'));
      expect(empty.userMessage, isNot(contains('400')));
    });

    test('403 ⇒ 说明没有权限，且明确「没有保存」', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 403,
            body: jsonEncode(<String, Object?>{
              'statusCode': 403,
              'code': 'PERMISSION_DENIED',
              'message': 'missing action: edit_child_profile',
            }),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.renameChild('小明明'),
        throwsA(
          isA<WriteApiException>()
              .having(
                (WriteApiException e) => e.kind,
                'kind',
                WriteFailureKind.forbidden,
              )
              .having(
                (WriteApiException e) => e.userMessage,
                'userMessage',
                contains('没有保存'),
              ),
        ),
      );
    });
  });

  // ============================================ W5-E：store 侧「三种世界」
  //
  // 同一个方法在三种世界里必须走三条路：预览 = 本地生效、live 无写客户端 =
  // 只读文案且内存不动、live 有写客户端 = 真 PATCH 且以服务端返回值为准。
  group('档案写入口（W5-E）：store 三种世界', () {
    String homeJson({String name = '小明'}) => jsonEncode(<String, Object?>{
          'child': <String, Object?>{
            'id': 'child-1',
            'name': name,
            'pointsBalance': 100,
          },
          'goodHabitCount': 0,
          'rewardCount': 0,
          'habits': <Object?>[],
          'rules': <Object?>[],
          'wishes': <Object?>[],
        });

    String pageJson() => jsonEncode(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': null,
        });

    test('live 有写客户端：PATCH 成功后用服务端名字覆盖档案', () async {
      final _ScriptedReadTransport readTransport = _ScriptedReadTransport(
        homeJson: homeJson(),
        pageJson: pageJson(),
      );
      final _FakeWriteApi writeApi = _FakeWriteApi()
        // 服务端规范化后的值才是库里真实的名字。
        ..renameChildResult = ChildProfileDto(childId: 'child-1', name: '小明明');
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
        writeApi: writeApi,
      );
      addTearDown(store.dispose);
      await store.refreshFromServer();
      expect(store.profile.name, '小明');
      final int recordCallsBefore = readTransport.recordCalls.length;

      final String? message = await store.submitRenameChild('  小明明 ');

      expect(message, isNull);
      expect(writeApi.renameChildCalls, 1);
      expect(writeApi.lastChildName, '小明明', reason: '本地先 trim 再发');
      expect(store.profile.name, '小明明');
      expect(
        readTransport.recordCalls.length,
        recordCallsBefore,
        reason: 'PATCH 回包已是权威值，不该再多跑一次 /home 让滞后快照盖回去',
      );
    });

    test('名字没变就不发请求（PATCH 幂等也不白跑一趟）', () async {
      final _FakeWriteApi writeApi = _FakeWriteApi();
      final AppStore store = AppStore(
        readApi: ReadApiClient(
          config: config,
          transport: _ScriptedReadTransport(
            homeJson: homeJson(),
            pageJson: pageJson(),
          ),
        ),
        writeApi: writeApi,
      );
      addTearDown(store.dispose);
      await store.refreshFromServer();

      final String? message = await store.submitRenameChild(' 小明 ');

      expect(message, contains('没有变化'));
      expect(writeApi.renameChildCalls, 0);
    });

    test('live 但没注入写客户端：给只读文案，档案不动', () async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(
          config: config,
          transport: _ScriptedReadTransport(
            homeJson: homeJson(),
            pageJson: pageJson(),
          ),
        ),
      );
      addTearDown(store.dispose);
      await store.refreshFromServer();
      expect(store.isProfileWriteReadOnly, isTrue);

      final String? message = await store.submitRenameChild('小明明');

      expect(message, store.profileReadOnlyWriteMessage);
      expect(
        store.profile.name,
        '小明',
        reason: '没保存就不能先改，否则下次刷新就打回原形',
      );
    });

    test('预览模式照旧本地生效（演示数据本来就该改）', () async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);
      final String before = store.profile.name;

      final String? message = await store.submitRenameChild(' 小明明 ');

      expect(message, isNull);
      expect(store.profile.name, '小明明');
      expect(store.profile.name, isNot(before));
    });
  });

  testWidgets('live 我的页：点头像改昵称真的 PATCH，不再弹只读提示', (WidgetTester tester) async {
    final _ScriptedReadTransport readTransport = _ScriptedReadTransport(
      homeJson: jsonEncode(<String, Object?>{
        'child': <String, Object?>{
          'id': 'child-1',
          'name': '小明',
          'pointsBalance': 100,
        },
        'goodHabitCount': 0,
        'rewardCount': 0,
        'habits': <Object?>[],
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
      ..renameChildResult = ChildProfileDto(childId: 'child-1', name: '小明明');
    final AppStore store = AppStore(
      readApi: ReadApiClient(config: config, transport: readTransport),
      writeApi: writeApi,
    );
    addTearDown(store.dispose);

    await tester.pumpWidget(PointsApp(store: store));
    await tester.pumpAndSettle();
    await tester.tap(find.text('我的'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('🧒').first);
    await tester.pumpAndSettle();
    expect(find.text('修改昵称'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '小明明');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(writeApi.renameChildCalls, 1);
    expect(writeApi.lastChildName, '小明明');
    expect(find.text('昵称已更新'), findsOneWidget);
    expect(
      find.textContaining('只读模式'),
      findsNothing,
      reason: '昵称已接写端点，不该再说「只读」',
    );
  });

  group('回收站 store（W5-F）：live 删除 / 恢复 / 彻底删除 / 清理过期', () {
    late _TrashScriptedTransport readTransport;
    late _FakeWriteApi writeApi;

    Map<String, Object?> habitRow([String id = 'habit-1']) => <String, Object?>{
          'id': id,
          'title': '认真刷牙',
          'points': 1,
          'icon': 'spray',
          'color': '#7fbf55',
          'condition': '早晚各一次',
          'dailyLimit': 2,
          'ruleId': null,
        };

    String homeJson({List<Object?>? habits}) => jsonEncode(<String, Object?>{
          'child': <String, Object?>{
            'id': 'child-1',
            'name': '小明',
            'pointsBalance': 11,
          },
          'goodHabitCount': (habits ?? <Object?>[habitRow()]).length,
          'rewardCount': 0,
          'habits': habits ?? <Object?>[habitRow()],
          'rules': <Object?>[],
          'wishes': <Object?>[],
        });

    Map<String, Object?> trashRow(String kind, String id, String deletedAt) =>
        <String, Object?>{
          'kind': kind,
          'id': id,
          'title': '被删的 $id',
          'deletedAt': deletedAt,
        };

    Habit habit([String id = 'habit-1']) => Habit(
          id: id,
          title: '认真刷牙',
          points: 1,
          condition: '早晚各一次',
          dailyLimit: 2,
          iconName: 'spray',
          color: const Color(0xFF7FBF55),
        );

    setUp(() {
      readTransport = _TrashScriptedTransport(
        homeJson: homeJson(),
        pageJson: jsonEncode(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': null,
        }),
        trashJson: jsonEncode(<String, Object?>{'items': <Object?>[]}),
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

    test('refreshTrash 失败不清空上一次的结果（空列表会被当成「已彻底删除」）', () async {
      final AppStore store = buildStore();
      readTransport.trashJson = jsonEncode(<String, Object?>{
        'items': <Object?>[
          trashRow('habit', 'habit-1', '2026-10-20T08:00:00.000Z'),
        ],
      });
      await store.refreshTrash();
      expect(store.trashReadStatus, ReadStatus.ready);
      expect(store.trashItems().single.id, 'habit-1');

      readTransport.trashFailure = ReadApiException(
        ReadFailureKind.forbidden,
        '当前身份不能查看回收站。',
      );
      await store.refreshTrash();

      expect(store.trashError, isNotNull);
      expect(store.trashReadStatus, isNot(ReadStatus.ready));
      expect(store.trashItems().single.id, 'habit-1',
          reason: '拉失败时列表必须保留，不能让用户以为东西被彻底删了');
    });

    test('删除习惯：调 DELETE /habits/:id，随后刷新；回包失败则原样回报原因', () async {
      final AppStore store = buildStore();
      await store.refreshFromServer();
      expect(store.habits.single.id, 'habit-1');

      writeApi.habitDeleteError = WriteApiException(
        WriteFailureKind.conflict,
        '这条习惯还有未完成的打卡，暂时不能删除。',
      );
      expect(
        await store.submitRemoveHabit(habit()),
        '这条习惯还有未完成的打卡，暂时不能删除。',
      );
      expect(store.habits.single.id, 'habit-1', reason: '失败时首页不能少一条');

      writeApi.habitDeleteError = null;
      readTransport.homeJson = homeJson(habits: <Object?>[]);
      final String? ok = await store.submitRemoveHabit(store.habits.single);

      expect(ok, isNull);
      expect(writeApi.deleteHabitCalls, 2);
      expect(writeApi.lastHabitId, 'habit-1');
      expect(store.habits, isEmpty);
    });

    test('恢复：kind 用线值拼路径，成功后首页与回收站都刷新', () async {
      final AppStore store = buildStore();
      readTransport.homeJson = homeJson(habits: <Object?>[]);
      readTransport.trashJson = jsonEncode(<String, Object?>{
        'items': <Object?>[
          trashRow('habit', 'habit-1', '2026-10-20T08:00:00.000Z'),
        ],
      });
      await store.refreshFromServer();
      await store.refreshTrash();
      final TrashItem item = store.trashItems().single;

      // 恢复之后服务端的样子
      readTransport.homeJson = homeJson();
      readTransport.trashJson =
          jsonEncode(<String, Object?>{'items': <Object?>[]});
      final String? message = await store.submitRestoreTrash(item);

      expect(message, isNull);
      expect(writeApi.restoreTrashCalls, 1);
      expect(writeApi.lastTrashKind, 'habit');
      expect(writeApi.lastTrashId, 'habit-1');
      expect(store.habits.single.id, 'habit-1');
      expect(store.trashItems(), isEmpty);
    });

    test('彻底删除：成功后本地摘掉该行；服务端拒绝时原样回报原因', () async {
      final AppStore store = buildStore();
      readTransport.trashJson = jsonEncode(<String, Object?>{
        'items': <Object?>[
          trashRow('wish', 'wish-1', '2026-10-20T08:00:00.000Z'),
        ],
      });
      await store.refreshTrash();
      final TrashItem item = store.trashItems().single;

      writeApi.trashError = WriteApiException(
        WriteFailureKind.conflict,
        '这条心愿还有积分流水引用，不能彻底删除。',
      );
      expect(await store.submitPurgeTrash(item), '这条心愿还有积分流水引用，不能彻底删除。');
      expect(store.trashItems().single.id, 'wish-1', reason: '拒绝时不能把行从界面抹掉');

      writeApi.trashError = null;
      readTransport.trashJson =
          jsonEncode(<String, Object?>{'items': <Object?>[]});
      expect(await store.submitPurgeTrash(item), isNull);
      expect(writeApi.purgeTrashCalls, 2);
      expect(writeApi.lastTrashKind, 'wish');
      expect(store.trashItems(), isEmpty);
    });

    test('清理过期：逐条调，部分失败也说清「清了几条 / 几条没清掉」', () async {
      final AppStore store = buildStore();
      final DateTime now = DateTime.utc(2026, 10, 21, 12);
      readTransport.trashJson = jsonEncode(<String, Object?>{
        'items': <Object?>[
          // 超过 90 天 ⇒ 过期
          trashRow('habit', 'habit-old', '2026-01-01T00:00:00.000Z'),
          trashRow('wish', 'wish-old', '2026-01-02T00:00:00.000Z'),
          // 未过期 ⇒ 不该被动
          trashRow('point_rule', 'rule-new', '2026-10-20T00:00:00.000Z'),
        ],
      });
      await store.refreshTrash();
      expect(
        store.trashItems(now: now).where((TrashItem r) => r.expired).length,
        2,
      );

      writeApi.trashError = WriteApiException(
        WriteFailureKind.server,
        '服务器开小差了，请稍后重试。',
      );
      final TrashPurgeOutcome outcome =
          await store.submitPurgeExpiredTrash(now: now);

      expect(outcome.purged, 0);
      expect(outcome.failed, 2);
      expect(outcome.hasFailure, isTrue);
      expect(outcome.error, '服务器开小差了，请稍后重试。');
      expect(store.trashItems(now: now).length, 3, reason: '一条都没删成时，列表不能凭空调走');
    });

    test('没有写客户端：删除 / 恢复都给只读文案，一条请求都不发', () async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(
          config: config,
          transport: _TrashScriptedTransport(
            homeJson: homeJson(),
            pageJson: jsonEncode(<String, Object?>{
              'records': <Object?>[],
              'limit': 50,
              'hasMore': false,
              'nextCursor': null,
            }),
            trashJson: jsonEncode(<String, Object?>{'items': <Object?>[]}),
          ),
        ),
      );
      addTearDown(store.dispose);
      await store.refreshFromServer();

      expect(store.isHabitWriteReadOnly, isTrue);
      expect(
        await store.submitRemoveHabit(store.habits.single),
        store.habitReadOnlyWriteMessage,
      );
      expect(store.isTrashWriteReadOnly, isTrue);
      expect(
        await store.submitRestoreTrash(
          TrashItem(
            kind: TrashKind.habit,
            id: 'habit-1',
            title: '认真刷牙',
            deletedAt: DateTime.utc(2026, 10, 20),
            expired: false,
          ),
        ),
        store.trashReadOnlyWriteMessage,
      );
    });

    testWidgets('live 我的页：回收站显示服务端条目，点「恢复」真的发 POST',
        (WidgetTester tester) async {
      final _TrashScriptedTransport transport = _TrashScriptedTransport(
        homeJson: homeJson(),
        pageJson: jsonEncode(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': null,
        }),
        trashJson: jsonEncode(<String, Object?>{
          'items': <Object?>[
            trashRow('habit', 'habit-1', '2026-10-20T08:00:00.000Z'),
          ],
        }),
      );
      final _FakeWriteApi writeApi = _FakeWriteApi();
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: writeApi,
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();
      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();

      // 入口不预拉回收站（`refreshTrash` 是懒的，进回收站页才发请求），
      // 所以这里只按文案找入口；条数来自已经拉到的 `GET /trash`。
      // 「我的」页的菜单项比视口高（W5-I 又加了一行「邀请码」），
      // 先滚动到可见再点，否则 tap 会打在底部导航上。
      await tester.ensureVisible(find.text('回收站'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回收站'));
      await tester.pumpAndSettle();

      expect(find.text('被删的 habit-1'), findsOneWidget);
      expect(find.textContaining('习惯 · 还能恢复'), findsOneWidget);

      // 恢复后服务端不再返回这一条（列表随刷新变空）。
      transport.trashJson = jsonEncode(<String, Object?>{'items': <Object?>[]});
      await tester.tap(find.text('恢复'));
      await tester.pumpAndSettle();

      expect(writeApi.restoreTrashCalls, 1);
      expect(writeApi.lastTrashKind, 'habit');
      expect(find.text('已恢复“被删的 habit-1”'), findsOneWidget);
    });

    testWidgets('live 回收站拉取失败：显示失败横幅且不清空已有列表', (WidgetTester tester) async {
      final _TrashScriptedTransport transport = _TrashScriptedTransport(
        homeJson: homeJson(),
        pageJson: jsonEncode(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': null,
        }),
        trashJson: jsonEncode(<String, Object?>{'items': <Object?>[]}),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
        writeApi: _FakeWriteApi(),
      );
      addTearDown(store.dispose);

      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();
      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();

      transport.trashFailure = ReadApiException(
        ReadFailureKind.forbidden,
        '当前身份不能查看回收站。',
      );
      await tester.ensureVisible(find.text('回收站'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('回收站'));
      await tester.pumpAndSettle();

      expect(find.textContaining('回收站加载失败'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      expect(find.text('回收站是空的'), findsNothing, reason: '403 不能画成「空回收站」');
    });
  });

  group('家庭成员（W5-H）：拉取 / 改角色 / 移出', () {
    late _TrashScriptedTransport readTransport;
    late _FakeWriteApi writeApi;

    Map<String, Object?> memberRow({
      String memberId = 'm1',
      String userId = 'u1',
      String? displayName = '妈妈',
      String role = 'guardian',
      String status = 'active',
      bool isSelf = true,
    }) =>
        <String, Object?>{
          'memberId': memberId,
          'userId': userId,
          'displayName': displayName,
          'role': role,
          'status': status,
          'joinedAt': '2026-10-01T10:00:00.000Z',
          'removedAt': null,
          'isSelf': isSelf,
        };

    String membersJson(List<Map<String, Object?>> rows) =>
        jsonEncode(<String, Object?>{'items': rows});

    Map<String, Object?> homeJson() => <String, Object?>{
          'child': <String, Object?>{
            'id': 'child-1',
            'name': '小明',
            'pointsBalance': 11,
          },
          'goodHabitCount': 0,
          'rewardCount': 0,
          'habits': <Object?>[],
          'rules': <Object?>[],
          'wishes': <Object?>[],
        };

    setUp(() {
      readTransport = _TrashScriptedTransport(
        homeJson: jsonEncode(homeJson()),
        pageJson: jsonEncode(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': null,
        }),
        trashJson: jsonEncode(<String, Object?>{'items': <Object?>[]}),
        membersJson: membersJson(<Map<String, Object?>>[
          memberRow(),
          memberRow(
            memberId: 'm2',
            userId: 'u2',
            displayName: '小明',
            role: 'child',
            isSelf: false,
          ),
        ]),
      );
      writeApi = _FakeWriteApi();
      writeApi.changeMemberRoleResult = MemberDto(
        memberId: 'm2',
        userId: 'u2',
        displayName: '小明',
        role: 'guardian',
        status: 'active',
        joinedAt: DateTime.parse('2026-10-01T10:00:00.000Z'),
        removedAt: null,
        isSelf: false,
      );
      writeApi.removeMemberResult = MemberRemoveDto(
        memberId: 'm2',
        status: 'removed',
        removedAt: DateTime.parse('2026-10-22T10:00:00.000Z'),
      );
    });

    AppStore buildStore() {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
        writeApi: writeApi,
      );
      addTearDown(store.dispose);
      return store;
    }

    test('打开面板才拉成员：自己是家长 ⇒ canManageMembers，行内带 isSelf', () async {
      final AppStore store = buildStore();
      expect(store.members, isEmpty, reason: '首页刷新不该顺带拉成员');
      expect(readTransport.membersCalls, 0);

      await store.refreshMembers();
      expect(readTransport.membersCalls, 1);
      expect(store.membersReadStatus, ReadStatus.ready);
      expect(store.members.length, 2);
      expect(store.selfMember?.memberId, 'm1');
      expect(store.canManageMembers, isTrue);
      expect(store.membersError, isNull);
    });

    test('改角色：目标角色由当前行推出（孩子 ⇒ 家长），回包替换那一行', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      final FamilyMember child = store.members[1];

      final String? message = await store.submitChangeMemberRole(child);
      expect(message, isNull);
      expect(writeApi.changeMemberRoleCalls, 1);
      expect(writeApi.lastMemberId, 'm2');
      expect(writeApi.lastMemberRole, 'guardian');
      expect(store.members[1].role, MemberRole.guardian);
      expect(store.members[0].role, MemberRole.guardian,
          reason: '只替换被改的那一行，自己那一行不动');
      expect(store.busyMemberId, isNull, reason: '提交结束必须解除忙碌');
    });

    test('改 / 移出自己：本地就拒，一次请求都不发', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      final FamilyMember self = store.selfMember!;

      expect(await store.submitChangeMemberRole(self), contains('不能修改自己'));
      expect(await store.submitRemoveMember(self), contains('不能移出自己'));
      expect(writeApi.changeMemberRoleCalls, 0);
      expect(writeApi.removeMemberCalls, 0);
    });

    test('移出：成功后该行从列表消失，其余保留', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      final FamilyMember child = store.members[1];

      expect(await store.submitRemoveMember(child), isNull);
      expect(writeApi.removeMemberCalls, 1);
      expect(writeApi.lastMemberId, 'm2');
      expect(store.members.map((FamilyMember row) => row.memberId),
          <String>['m1']);
      expect(store.busyMemberId, isNull);
    });

    test('409 冲突：原样回报原因并重拉（本地那一行已经过时）', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      writeApi.memberError = WriteApiException(
        WriteFailureKind.conflict,
        '这个成员已经变了，请刷新后再试。',
      );
      readTransport.membersJson = membersJson(<Map<String, Object?>>[
        memberRow(),
      ]);

      final String? message =
          await store.submitChangeMemberRole(store.members[1]);
      expect(message, '这个成员已经变了，请刷新后再试。');
      expect(readTransport.membersCalls, 2, reason: '409 后必须重拉');
      expect(store.members.length, 1);
    });

    test('拉取失败：列表保留、错误照实上报（不能画成「家里没人」）', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      expect(store.members.length, 2);

      readTransport.membersFailure = ReadApiException(
        ReadFailureKind.forbidden,
        '当前身份不能查看成员。',
      );
      await store.refreshMembers();

      expect(store.membersReadStatus, isNot(ReadStatus.ready));
      expect(store.membersError, isNotNull);
      expect(store.members.length, 2,
          reason: '403 / 断网时已有成员必须保留，不能让家长以为家人都被移出了');
    });

    test('live 但没注入写客户端：拒绝写，且不改内存', () async {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
        writeApi: null,
      );
      addTearDown(store.dispose);
      await store.refreshMembers();

      final String? message = await store.submitRemoveMember(store.members[1]);
      expect(message, store.memberReadOnlyWriteMessage);
      expect(store.members.length, 2);
    });
  });

  // ============================================ W5-I：邀请码写端点
  //
  // 钉住四件事：路径 / 参数口径（与后端 DTO 的 @IsIn/@Max 同一条线）、
  // 回包与请求的一致性校验、「撞码 409」不能被讲成「你没有权限」。
  group('邀请码写端点（W5-I）：POST /invites · /invites/:id/revoke', () {
    Map<String, Object?> inviteJson({
      String id = 'inv-1',
      String code = 'ABCD2345',
      String role = 'child',
      int maxUses = 3,
      int usedCount = 0,
      bool revoked = false,
    }) {
      final DateTime now = DateTime.utc(2026, 10, 22, 10);
      return <String, Object?>{
        'id': id,
        'code': code,
        'role': role,
        'maxUses': maxUses,
        'usedCount': usedCount,
        'expiresAt': now.add(const Duration(days: 7)).toIso8601String(),
        'revoked': revoked,
        'createdAt': now.toIso8601String(),
      };
    }

    test('POST /invites：role / maxUses / expiresInDays + 身份头，且不带幂等键', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: jsonEncode(inviteJson(role: 'guardian', maxUses: 5)),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final InviteDto dto = await client.createInvite(
        role: MemberRole.guardian,
        maxUses: 5,
        expiresInDays: 30,
      );

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/invites');
      expect(jsonDecode(call.body), <String, Object?>{
        'role': 'guardian',
        'maxUses': 5,
        // 只发天数：绝对 `expiresAt` 由服务端算，客户端不许指定。
        'expiresInDays': 30,
      });
      expect(call.headers[kDeviceIdHeader], 'device-1');
      expect(call.headers[kChildIdHeader], 'child-1');
      expect(
        call.headers.containsKey('idempotency-key'),
        isFalse,
        reason: '每次生成本来就该产生一张新码，重放同一个键反而会挡住第二次生成',
      );
      expect(dto.role, 'guardian');
      expect(dto.code, 'ABCD2345');
    });

    test('viewer / 越界参数在本地就拒（与后端 @IsIn/@Max 同口径），一个请求都不发', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          fail('非法参数不得发请求');
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.createInvite(
          role: MemberRole.viewer,
          maxUses: 1,
          expiresInDays: 7,
        ),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        client.createInvite(
          role: MemberRole.child,
          maxUses: kMaxInviteUses + 1,
          expiresInDays: 7,
        ),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        client.createInvite(
          role: MemberRole.child,
          maxUses: 1,
          expiresInDays: kMaxInviteTtlDays + 1,
        ),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        client.createInvite(
          role: MemberRole.child,
          maxUses: 0,
          expiresInDays: 7,
        ),
        throwsA(isA<ArgumentError>()),
      );
      expect(transport.calls, isEmpty);
    });

    test('回包 role 与请求不一致 ⇒ malformed（权限边界画错不能当成功）', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 201,
            body: jsonEncode(inviteJson(role: 'guardian')),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      await expectLater(
        client.createInvite(
          role: MemberRole.child,
          maxUses: 1,
          expiresInDays: 7,
        ),
        throwsA(
          isA<WriteApiException>().having(
            (WriteApiException e) => e.kind,
            'kind',
            WriteFailureKind.malformed,
          ),
        ),
      );
    });

    test('revoke：POST /invites/:id/revoke，回包 {id, revoked:true}', () async {
      final _FakeWriteTransport transport = _FakeWriteTransport(
        (Uri uri, Map<String, String> headers, String body) async {
          return WriteHttpResponse(
            statusCode: 200,
            body: jsonEncode(<String, Object?>{'id': 'inv-1', 'revoked': true}),
          );
        },
      );
      final WriteApiClient client =
          WriteApiClient(config: config, transport: transport);

      final InviteRevokeDto dto = await client.revokeInvite(' inv-1 ');

      final _WriteCall call = transport.calls.single;
      expect(call.method, 'POST');
      expect(call.uri.path, '/api/invites/inv-1/revoke');
      expect(dto.id, 'inv-1');
      expect(dto.revoked, isTrue);
    });

    test('revoke 回包 id 不一致 / revoked=false ⇒ malformed（不能拿别的行当成功）', () async {
      Future<WriteApiException> failWith(Map<String, Object?> body) async {
        final _FakeWriteTransport transport = _FakeWriteTransport(
          (Uri uri, Map<String, String> headers, String payload) async {
            return WriteHttpResponse(statusCode: 200, body: jsonEncode(body));
          },
        );
        final WriteApiClient client =
            WriteApiClient(config: config, transport: transport);
        try {
          await client.revokeInvite('inv-1');
          fail('必须抛出 WriteApiException');
        } on WriteApiException catch (error) {
          return error;
        }
      }

      final WriteApiException otherRow =
          await failWith(<String, Object?>{'id': 'inv-2', 'revoked': true});
      expect(otherRow.kind, WriteFailureKind.malformed);

      final WriteApiException notRevoked =
          await failWith(<String, Object?>{'id': 'inv-1', 'revoked': false});
      expect(notRevoked.kind, WriteFailureKind.malformed);
    });

    test('撞码 409 与 404 各自翻成中文，且「撞码」不说成没权限', () async {
      Future<WriteApiException> failWith(int status, String code) async {
        final _FakeWriteTransport transport = _FakeWriteTransport(
          (Uri uri, Map<String, String> headers, String body) async {
            return WriteHttpResponse(
              statusCode: status,
              body: jsonEncode(<String, Object?>{
                'statusCode': status,
                'code': code,
                'message': 'backend english message',
              }),
            );
          },
        );
        final WriteApiClient client =
            WriteApiClient(config: config, transport: transport);
        try {
          if (code == 'INVITE_NOT_FOUND') {
            await client.revokeInvite('inv-1');
          } else {
            await client.createInvite(
              role: MemberRole.child,
              maxUses: 1,
              expiresInDays: 7,
            );
          }
          fail('$code 必须抛出 WriteApiException');
        } on WriteApiException catch (error) {
          return error;
        }
      }

      final WriteApiException collision =
          await failWith(409, 'INVITE_CODE_GENERATION_FAILED');
      expect(collision.kind, WriteFailureKind.conflict);
      expect(collision.userMessage, contains('再试一次'));
      expect(collision.userMessage, isNot(contains('权限')));
      expect(collision.userMessage, isNot(contains('409')));

      final WriteApiException missing = await failWith(404, 'INVITE_NOT_FOUND');
      expect(missing.kind, WriteFailureKind.notFound);
      expect(missing.userMessage, contains('邀请码'));
      expect(missing.userMessage, isNot(contains('404')));
    });
  });

  // ============================================ W5-I：store 侧邀请码
  group('邀请码（W5-I）：拉取 / 生成 / 吊销', () {
    late _TrashScriptedTransport readTransport;
    late _FakeWriteApi writeApi;

    Map<String, Object?> memberRow({
      String memberId = 'm1',
      String role = 'guardian',
      bool isSelf = true,
    }) =>
        <String, Object?>{
          'memberId': memberId,
          'userId': 'u-$memberId',
          'displayName': isSelf ? '妈妈' : '小明',
          'role': role,
          'status': 'active',
          'joinedAt': '2026-10-01T10:00:00.000Z',
          'removedAt': null,
          'isSelf': isSelf,
        };

    Map<String, Object?> inviteRow({
      String id = 'inv-1',
      String code = 'ABCD2345',
      String role = 'child',
      int maxUses = 3,
      int usedCount = 1,
      Duration ttl = const Duration(days: 7),
      bool revoked = false,
    }) {
      final DateTime now = DateTime.now().toUtc();
      return <String, Object?>{
        'id': id,
        'code': code,
        'role': role,
        'maxUses': maxUses,
        'usedCount': usedCount,
        'expiresAt': now.add(ttl).toIso8601String(),
        'revoked': revoked,
        'createdAt': now.toIso8601String(),
      };
    }

    String invitesJson(List<Map<String, Object?>> rows) =>
        jsonEncode(<String, Object?>{'items': rows});

    setUp(() {
      readTransport = _TrashScriptedTransport(
        homeJson: jsonEncode(<String, Object?>{
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
        }),
        pageJson: jsonEncode(<String, Object?>{
          'records': <Object?>[],
          'limit': 50,
          'hasMore': false,
          'nextCursor': null,
        }),
        trashJson: jsonEncode(<String, Object?>{'items': <Object?>[]}),
        membersJson: jsonEncode(<String, Object?>{
          'items': <Map<String, Object?>>[
            memberRow(),
            memberRow(memberId: 'm2', role: 'child', isSelf: false),
          ],
        }),
        invitesJson: invitesJson(<Map<String, Object?>>[
          inviteRow(),
          inviteRow(
            id: 'inv-2',
            code: 'EFGH6789',
            ttl: const Duration(days: -1),
          ),
        ]),
      );
      writeApi = _FakeWriteApi();
      final DateTime now = DateTime.now().toUtc();
      writeApi.createInviteResult = InviteDto(
        id: 'inv-new',
        code: 'WXYZ6789',
        role: 'child',
        maxUses: 3,
        usedCount: 0,
        expiresAt: now.add(const Duration(days: 7)),
        revoked: false,
        createdAt: now,
      );
      writeApi.revokeInviteResult = InviteRevokeDto(id: 'inv-1', revoked: true);
    });

    AppStore buildStore({bool withWriteApi = true}) {
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: readTransport),
        writeApi: withWriteApi ? writeApi : null,
      );
      addTearDown(store.dispose);
      return store;
    }

    test('打开面板才拉邀请码：事实照服务端落地，状态由本地现算', () async {
      final AppStore store = buildStore();
      expect(store.invites, isEmpty, reason: '首页刷新不该顺带拉邀请码');
      expect(readTransport.invitesCalls, 0);

      await store.refreshMembers();
      expect(store.canManageInvites, isTrue);
      await store.refreshInvites();

      expect(readTransport.invitesCalls, 1);
      expect(store.invitesReadStatus, ReadStatus.ready);
      expect(store.invites.length, 2);
      expect(store.invites[0].status, InviteCodeStatus.usable);
      expect(store.invites[0].remainingUses, 2);
      expect(store.invites[0].displayCode, 'ABCD-2345');
      expect(store.invites[1].status, InviteCodeStatus.expired);
      expect(store.invitesError, isNull);
    });

    test('孩子视角 canManageInvites 为假（与成员权限同一条线）', () async {
      readTransport.membersJson = jsonEncode(<String, Object?>{
        'items': <Map<String, Object?>>[
          memberRow(role: 'child'),
          memberRow(memberId: 'm2', role: 'guardian', isSelf: false),
        ],
      });
      final AppStore store = buildStore();

      await store.refreshMembers();
      expect(store.selfMember?.role, MemberRole.child);
      expect(store.canManageMembers, isFalse);
      expect(store.canManageInvites, isFalse);
    });

    test('生成：插到表头，参数按表单发出，结束后解除忙碌', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      await store.refreshInvites();

      final String? message = await store.submitCreateInvite(
        role: MemberRole.child,
        maxUses: 3,
        expiresInDays: 7,
      );

      expect(message, isNull);
      expect(writeApi.createInviteCalls, 1);
      expect(writeApi.lastInviteRole, MemberRole.child);
      expect(writeApi.lastInviteMaxUses, 3);
      expect(writeApi.lastInviteTtlDays, 7);
      expect(store.invites.first.id, 'inv-new');
      expect(store.invites.first.code, 'WXYZ6789');
      expect(store.invites.length, 3, reason: '生成后不该把旧码冲掉');
      expect(store.isInviteWriteBusy, isFalse);
      expect(readTransport.invitesCalls, 1, reason: '生成走回包，不需要重拉');
    });

    test('生成冲突（409）：回报原因并重拉列表（本地状态已经过时）', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      await store.refreshInvites();
      writeApi.inviteError = WriteApiException(
        WriteFailureKind.conflict,
        '连续生成的邀请码都撞上了已有的码（极少见），这次没有创建成功，请再试一次。',
      );

      final String? message = await store.submitCreateInvite(
        role: MemberRole.child,
        maxUses: 1,
        expiresInDays: 7,
      );

      expect(message, contains('再试一次'));
      expect(readTransport.invitesCalls, 2, reason: '409 后必须重拉');
      expect(store.invites.length, 2, reason: '失败不能凭空多出一张码');
      expect(store.isInviteWriteBusy, isFalse);
    });

    test('吊销：只把那一行标成已吊销，不重拉', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      await store.refreshInvites();
      final InviteCode target = store.invites[0];

      // 弹窗里的 `invite` 是打开时的快照 —— 用快照吊销也必须作用到列表那一行。
      final String? message = await store.submitRevokeInvite(target);

      expect(message, isNull);
      expect(writeApi.revokeInviteCalls, 1);
      expect(writeApi.lastInviteId, 'inv-1');
      expect(store.invites[0].revoked, isTrue);
      expect(store.invites[0].status, InviteCodeStatus.revoked);
      expect(store.invites[0].code, 'ABCD2345', reason: '其余事实保持不变');
      expect(store.invites[1].revoked, isFalse);
      expect(store.busyInviteId, isNull, reason: '提交结束必须解除忙碌');
      expect(readTransport.invitesCalls, 1, reason: '吊销走回包，不需要重拉');
    });

    test('重复吊销：本地就拒，一次请求都不发', () async {
      readTransport.invitesJson = jsonEncode(<String, Object?>{
        'items': <Map<String, Object?>>[
          inviteRow(revoked: true),
        ],
      });
      final AppStore store = buildStore();
      await store.refreshMembers();
      await store.refreshInvites();

      final String? message = await store.submitRevokeInvite(store.invites[0]);
      expect(message, contains('已经吊销过'));
      expect(writeApi.revokeInviteCalls, 0);
    });

    test('吊销 404：回报原因并重拉（这一行已经不在了）', () async {
      final AppStore store = buildStore();
      await store.refreshMembers();
      await store.refreshInvites();
      writeApi.inviteError = WriteApiException(
        WriteFailureKind.notFound,
        '这个邀请码不存在或不属于当前孩子的档案，请刷新邀请码列表。',
      );
      readTransport.invitesJson =
          jsonEncode(<String, Object?>{'items': <Object?>[]});

      final String? message = await store.submitRevokeInvite(store.invites[0]);

      expect(message, contains('邀请码'));
      expect(readTransport.invitesCalls, 2, reason: '404 后必须重拉');
      expect(store.invites, isEmpty);
      expect(store.busyInviteId, isNull);
    });

    test('live 但没注入写客户端：只读文案，列表不动', () async {
      final AppStore store = buildStore(withWriteApi: false);
      await store.refreshMembers();
      await store.refreshInvites();

      expect(
          await store.submitCreateInvite(
            role: MemberRole.child,
            maxUses: 1,
            expiresInDays: 7,
          ),
          store.inviteReadOnlyWriteMessage);
      expect(await store.submitRevokeInvite(store.invites[0]),
          store.inviteReadOnlyWriteMessage);
      expect(store.invites.length, 2);
      expect(store.invites[0].revoked, isFalse);
    });
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
  int adjustCalls = 0;
  int decideCalls = 0;
  int withdrawCalls = 0;
  ApprovalDto? withdrawResult;
  Object? withdrawError;
  String? lastWithdrawKey;
  int createRuleCalls = 0;
  int updateRuleCalls = 0;
  int deleteRuleCalls = 0;
  int deleteHabitCalls = 0;
  int restoreTrashCalls = 0;
  int purgeTrashCalls = 0;
  String? lastTrashKind;
  String? lastTrashId;
  Object? habitDeleteError;
  Object? trashError;
  TrashTargetDto? trashTargetResult;
  int addHabitCalls = 0;
  int createWishCalls = 0;
  int deleteWishCalls = 0;
  int requestRedeemCalls = 0;
  String? lastWishId;
  ApprovalDto? requestRedeemResult;
  ApprovalDto? decideResult;
  String? lastApprovalId;
  bool? lastApprove;
  Object? decideError;
  Completer<ApprovalDto>? decideGate;
  int? lastCost;
  String? lastEmoji;
  WishDto? createWishResult;
  Object? wishError;
  String? lastHabitId;
  String? lastIdempotencyKey;
  String? lastRecordId;
  String? lastNote;
  String? lastAdjustTitle;
  int? lastAdjustPoints;
  String? lastAdjustNote;
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
  WrittenRecordDto? adjustResult;
  RuleDto? createRuleResult;
  RuleDto? updateRuleResult;
  HabitDto? addHabitResult;
  String? deleteRuleResult;
  Object? checkInError;
  Object? adjustError;
  Object? ruleError;
  Completer<WrittenRecordDto>? checkInGate;
  Completer<WrittenRecordDto>? adjustGate;
  int renameChildCalls = 0;
  String? lastChildName;
  ChildProfileDto? renameChildResult;
  Object? renameChildError;
  // ── W5-H 成员 ──
  int changeMemberRoleCalls = 0;
  int removeMemberCalls = 0;
  String? lastMemberId;
  String? lastMemberRole;
  MemberDto? changeMemberRoleResult;
  MemberRemoveDto? removeMemberResult;
  Object? memberError;
  // ── W5-I 邀请码 ──
  int createInviteCalls = 0;
  int revokeInviteCalls = 0;
  MemberRole? lastInviteRole;
  int? lastInviteMaxUses;
  int? lastInviteTtlDays;
  String? lastInviteId;
  InviteDto? createInviteResult;
  InviteRevokeDto? revokeInviteResult;
  Object? inviteError;

  @override
  Future<InviteDto> createInvite({
    required MemberRole role,
    required int maxUses,
    required int expiresInDays,
  }) async {
    createInviteCalls += 1;
    lastInviteRole = role;
    lastInviteMaxUses = maxUses;
    lastInviteTtlDays = expiresInDays;
    if (inviteError != null) throw inviteError!;
    return createInviteResult!;
  }

  @override
  Future<InviteRevokeDto> revokeInvite(String inviteId) async {
    revokeInviteCalls += 1;
    lastInviteId = inviteId;
    if (inviteError != null) throw inviteError!;
    return revokeInviteResult!;
  }

  @override
  Future<MemberDto> changeMemberRole(String memberId, MemberRole role) async {
    changeMemberRoleCalls += 1;
    lastMemberId = memberId;
    lastMemberRole = role.name;
    if (memberError != null) throw memberError!;
    return changeMemberRoleResult!;
  }

  @override
  Future<MemberRemoveDto> removeMember(String memberId) async {
    removeMemberCalls += 1;
    lastMemberId = memberId;
    if (memberError != null) throw memberError!;
    return removeMemberResult!;
  }

  @override
  Future<WrittenRecordDto> adjust({
    required String title,
    required int points,
    String? note,
    String? idempotencyKey,
  }) async {
    adjustCalls += 1;
    lastAdjustTitle = title;
    lastAdjustPoints = points;
    lastAdjustNote = note;
    lastIdempotencyKey = idempotencyKey;
    if (adjustGate != null) return adjustGate!.future;
    if (adjustError != null) throw adjustError!;
    return adjustResult!;
  }

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
  Future<ApprovalDto> decideApproval(
    String approvalId, {
    required bool approve,
    String? idempotencyKey,
  }) async {
    decideCalls += 1;
    lastApprovalId = approvalId;
    lastApprove = approve;
    lastIdempotencyKey = idempotencyKey;
    if (decideGate != null) return decideGate!.future;
    if (decideError != null) throw decideError!;
    return decideResult!;
  }

  @override
  Future<ApprovalDto> withdrawApproval(
    String approvalId, {
    String? idempotencyKey,
  }) async {
    withdrawCalls += 1;
    lastApprovalId = approvalId;
    lastWithdrawKey = idempotencyKey;
    if (withdrawError != null) throw withdrawError!;
    return withdrawResult!;
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
  Future<WishDto> createWish({
    required String title,
    required int cost,
    required String emoji,
    String? idempotencyKey,
  }) async {
    createWishCalls += 1;
    lastTitle = title;
    lastCost = cost;
    lastEmoji = emoji;
    lastIdempotencyKey = idempotencyKey;
    if (wishError != null) throw wishError!;
    return createWishResult!;
  }

  @override
  Future<String> deleteWish(
    String wishId, {
    String? idempotencyKey,
  }) async {
    deleteWishCalls += 1;
    lastWishId = wishId;
    lastIdempotencyKey = idempotencyKey;
    if (wishError != null) throw wishError!;
    return wishId;
  }

  @override
  Future<String> deleteHabit(String habitId, {String? idempotencyKey}) async {
    deleteHabitCalls += 1;
    lastHabitId = habitId;
    lastIdempotencyKey = idempotencyKey;
    if (habitDeleteError != null) throw habitDeleteError!;
    return habitId;
  }

  @override
  Future<TrashTargetDto> restoreTrashItem(String kind, String id) async {
    restoreTrashCalls += 1;
    lastTrashKind = kind;
    lastTrashId = id;
    if (trashError != null) throw trashError!;
    return trashTargetResult ?? TrashTargetDto(kind: kind, id: id);
  }

  @override
  Future<TrashTargetDto> purgeTrashItem(String kind, String id) async {
    purgeTrashCalls += 1;
    lastTrashKind = kind;
    lastTrashId = id;
    if (trashError != null) throw trashError!;
    return trashTargetResult ?? TrashTargetDto(kind: kind, id: id);
  }

  @override
  Future<ApprovalDto> requestRedeem(
    String wishId, {
    String? idempotencyKey,
  }) async {
    requestRedeemCalls += 1;
    lastWishId = wishId;
    lastIdempotencyKey = idempotencyKey;
    if (wishError != null) throw wishError!;
    return requestRedeemResult!;
  }

  @override
  Future<ChildProfileDto> renameChild(String name) async {
    renameChildCalls += 1;
    lastChildName = name;
    if (renameChildError != null) throw renameChildError!;
    return renameChildResult ??
        ChildProfileDto(childId: 'child-1', name: name.trim());
  }

  // W5-H 成员：上面已实现真实替身（记录调用 / 可注入错误），
  // 任何意外调用都会真正走到 `WriteApi` 替身逻辑，而不是静默通过。

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

/// 让 `/trash` 走**自己的**脚本响应（`_ScriptedReadTransport` 会把非 `/home`
/// 的请求全当成分页，回收站因此拿到错误的 JSON）。
class _TrashScriptedTransport implements ReadTransport {
  _TrashScriptedTransport({
    required this.homeJson,
    required this.pageJson,
    required this.trashJson,
    String? membersJson,
    String? invitesJson,
  })  : membersJson =
            membersJson ?? jsonEncode(<String, Object?>{'items': <Object?>[]}),
        invitesJson =
            invitesJson ?? jsonEncode(<String, Object?>{'items': <Object?>[]});

  String homeJson;
  String pageJson;
  String trashJson;
  String membersJson;
  String invitesJson;

  /// 非 null 时 `/trash` 直接抛这个异常（模拟 403 / 断网）。
  ReadApiException? trashFailure;
  int trashCalls = 0;

  /// 非 null 时 `/members` 直接抛这个异常（403 / 断网）。
  ReadApiException? membersFailure;
  int membersCalls = 0;

  /// 非 null 时 `/invites` 直接抛这个异常（403 / 断网）。
  ReadApiException? invitesFailure;
  int invitesCalls = 0;

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    if (uri.path.endsWith('/home')) {
      return ReadHttpResponse(statusCode: 200, body: homeJson);
    }
    if (uri.path.endsWith('/trash')) {
      trashCalls += 1;
      final ReadApiException? failure = trashFailure;
      if (failure != null) throw failure;
      return ReadHttpResponse(statusCode: 200, body: trashJson);
    }
    if (uri.path.endsWith('/members')) {
      membersCalls += 1;
      final ReadApiException? failure = membersFailure;
      if (failure != null) throw failure;
      return ReadHttpResponse(statusCode: 200, body: membersJson);
    }
    if (uri.path.endsWith('/invites')) {
      invitesCalls += 1;
      final ReadApiException? failure = invitesFailure;
      if (failure != null) throw failure;
      return ReadHttpResponse(statusCode: 200, body: invitesJson);
    }
    return ReadHttpResponse(statusCode: 200, body: pageJson);
  }

  @override
  void close() {}
}
