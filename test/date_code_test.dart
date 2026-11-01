import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/date_code_api.dart';
import 'package:kids_points_app/data/date_code_dto.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/write_api.dart';
import 'package:kids_points_app/data/write_api_errors.dart';

/// W9-C：固定规则 6 位验证码（`MMDD` ＋ 两位 ISO 星期）的**客户端**测试。
///
/// 这些用例钉住的是**家长能看出来的事**：
///   ① 少打一位 / 空串 ⇒ 当场拒绝，**不发请求**（不能表现成「请求失败」）；
///   ② 码不对是 `200 { valid:false }` ⇒ 正常回包，不是异常（界面要提示"再算一次"）；
///   ③ 形状自相矛盾的回包一律 `malformed`（不猜默认值）；
///   ④ 429 ⇒ 带"还要等多久"的异常，而不是"网络有问题"；
///   ⑤ 客户端**不重算**规则：请求体只有 `code` 一个字段。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  /// `POST /auth/date-code` 的默认回包（命中今天的码）。
  Map<String, Object?> verdictJson({
    bool valid = true,
    String serverDate = '2026-10-29',
    int weekDay = 4,
    int? dayOffset = 0,
    String? acceptedUntil = '2026-10-30T16:00:00.000Z',
  }) =>
      <String, Object?>{
        'valid': valid,
        'serverDate': serverDate,
        'weekDay': weekDay,
        'dayOffset': dayOffset,
        'acceptedUntil': acceptedUntil,
      };

  group('本地预检：形状错不发请求', () {
    test('空串 ⇒ ArgumentError，且一个请求都没发', () async {
      final _FakeTransport transport = _FakeTransport(verdictJson());
      final DateCodeApiClient api =
          DateCodeApiClient(config: config, transport: transport);

      await expectLater(() => api.verify('  '), throwsArgumentError);
      expect(transport.callCount, 0);
    });

    test('5 位 / 7 位 / 含字母 ⇒ ArgumentError（不是「请求失败」）', () async {
      for (final String bad in <String>['10290', '1029040', '10290a']) {
        final _FakeTransport transport = _FakeTransport(verdictJson());
        final DateCodeApiClient api =
            DateCodeApiClient(config: config, transport: transport);

        await expectLater(() => api.verify(bad), throwsArgumentError);
        expect(transport.callCount, 0, reason: '$bad 不该发请求');
      }
    });

    test('前后空格被裁掉：发送的仍是 6 位数字', () async {
      final _FakeTransport transport = _FakeTransport(verdictJson());
      final DateCodeApiClient api =
          DateCodeApiClient(config: config, transport: transport);

      await api.verify(' 102904 ');

      expect(jsonDecode(transport.lastBody), <String, Object?>{'code': '102904'});
    });
  });

  group('请求形状：只发 code，带设备头（供后端限流的设备维度）', () {
    test('POST /auth/date-code ＋ JSON ＋ accept/device/child 头', () async {
      final _FakeTransport transport = _FakeTransport(verdictJson());
      final DateCodeApiClient api =
          DateCodeApiClient(config: config, transport: transport);

      await api.verify('102904');

      expect(transport.methods, <String>['POST']);
      expect(transport.paths, <String>['/api/auth/date-code']);
      expect(transport.lastHeaders['content-type'], contains('application/json'));
      expect(transport.lastHeaders[kDeviceIdHeader], 'device-1');
      expect(transport.lastHeaders[kChildIdHeader], 'child-1');
    });

    test('配置不完整 ⇒ CLIENT_NOT_CONFIGURED，且不发请求', () async {
      final _FakeTransport transport = _FakeTransport(verdictJson());
      final DateCodeApiClient api = DateCodeApiClient(
        config: const ReadApiConfig(baseUrl: '', deviceId: '', childId: ''),
        transport: transport,
      );

      final WriteApiException error = await _failureOf(() => api.verify('102904'));

      expect(error.code, 'CLIENT_NOT_CONFIGURED');
      expect(transport.callCount, 0);
    });
  });

  group('回包解析：命中 / 未命中 / 形状矛盾', () {
    test('命中今天：valid=true、dayOffset=0、acceptedUntil 是绝对时刻', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(verdictJson()),
      );

      final DateCodeVerdictDto dto = await api.verify('102904');

      expect(dto.valid, isTrue);
      expect(dto.serverDate, '2026-10-29');
      expect(dto.weekDay, DateTime.thursday);
      expect(dto.dayOffset, 0);
      expect(dto.acceptedUntil, DateTime.parse('2026-10-30T16:00:00.000Z'));
    });

    test('码不对：valid=false 且 dayOffset / acceptedUntil 都是 null（不抛）', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(
          verdictJson(valid: false, dayOffset: null, acceptedUntil: null),
        ),
      );

      final DateCodeVerdictDto dto = await api.verify('000000');

      expect(dto.valid, isFalse);
      expect(dto.dayOffset, isNull);
      expect(dto.acceptedUntil, isNull);
      expect(dto.serverDate, '2026-10-29');
    });

    test('valid=true 却没有 acceptedUntil ⇒ malformed（算不出"还能用多久"）', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(verdictJson(acceptedUntil: null)),
      );

      final WriteApiException error = await _failureOf(() => api.verify('102904'));

      expect(error.kind, WriteFailureKind.malformed);
    });

    test('valid=true 但 dayOffset=2 ⇒ malformed', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(verdictJson(dayOffset: 2)),
      );

      final WriteApiException error = await _failureOf(() => api.verify('102904'));

      expect(error.kind, WriteFailureKind.malformed);
    });

    test('valid=false 却带 dayOffset ⇒ malformed（不留半个结果）', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(verdictJson(valid: false, dayOffset: 0)),
      );

      final WriteApiException error = await _failureOf(() => api.verify('102904'));

      expect(error.kind, WriteFailureKind.malformed);
    });

    test('weekDay=0 / serverDate 不是 YYYY-MM-DD ⇒ malformed', () async {
      for (final Map<String, Object?> bad in <Map<String, Object?>>[
        verdictJson(weekDay: 0),
        verdictJson(serverDate: '2026/10/29'),
      ]) {
        final DateCodeApiClient api = DateCodeApiClient(
          config: config,
          transport: _FakeTransport(bad),
        );

        final WriteApiException error = await _failureOf(() => api.verify('102904'));

        expect(error.kind, WriteFailureKind.malformed);
      }
    });
  });

  group('错误映射：400 / 429 / 5xx 各说各的话', () {
    test('400 ⇒ badRequest，detail 用后端的中文说明', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(
          <String, Object?>{'message': '验证码是 6 位数字'},
          statusCode: 400,
        ),
      );

      final WriteApiException error = await _failureOf(() => api.verify('102904'));

      expect(error.kind, WriteFailureKind.badRequest);
      expect(error.statusCode, 400);
      expect(error.detail, contains('6 位数字'));
    });

    test('★ 429 ⇒ DateCodeRateLimitedException，带「还要等多久」', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(
          <String, Object?>{
            'code': 'DATE_CODE_RATE_LIMITED',
            'scope': 'device',
            'retryAfterSeconds': 45,
          },
          statusCode: 429,
        ),
      );

      final WriteApiException error = await _failureOf(() => api.verify('102904'));

      expect(error, isA<DateCodeRateLimitedException>());
      final DateCodeRateLimitedException limited =
          error as DateCodeRateLimitedException;
      expect(limited.retryAfterSeconds, 45);
      expect(limited.userMessage, contains('45 秒'));
      // 仍然是 conflict ⇒ 既有的 `on WriteApiException` 分支都能接住它
      expect(limited.kind, WriteFailureKind.conflict);
    });

    test('500 ⇒ server（不是"验证码错了"）', () async {
      final DateCodeApiClient api = DateCodeApiClient(
        config: config,
        transport: _FakeTransport(<String, Object?>{}, statusCode: 500),
      );

      final WriteApiException error = await _failureOf(() => api.verify('102904'));

      expect(error.statusCode, 500);
      expect(error.kind, WriteFailureKind.server);
    });
  });
}

/// 取异常而不是让它冒泡成测试失败。
Future<WriteApiException> _failureOf(Future<Object?> Function() run) async {
  try {
    await run();
  } on WriteApiException catch (error) {
    return error;
  }
  throw StateError('预期抛 WriteApiException，但没有');
}

/// `WriteTransport` 的假实现：记录方法 / 路径 / 头 / 请求体，回包由构造参数决定。
class _FakeTransport implements WriteTransport {
  _FakeTransport(this.body, {this.statusCode = 200});

  final Map<String, Object?> body;
  final int statusCode;
  final List<String> methods = <String>[];
  final List<String> paths = <String>[];
  String lastBody = '';
  Map<String, String> lastHeaders = <String, String>{};

  int get callCount => paths.length;

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    methods.add(method);
    paths.add(uri.path);
    lastBody = body;
    lastHeaders = headers;
    return WriteHttpResponse(statusCode: statusCode, body: jsonEncode(this.body));
  }

  @override
  void close() {}
}

