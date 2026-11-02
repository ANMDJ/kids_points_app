import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/http_transport_types.dart';
import 'package:kids_points_app/data/identity_api.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/session_scope.dart';
import 'package:kids_points_app/data/token_store.dart';
import 'package:kids_points_app/data/write_api_errors.dart';

/// W10-B / P0-1：身份客户端（`GET /auth/session` + `POST /auth/child-session`）。
///
/// ── 这里钉的四件事 ─────────────────────────────────────────────────────────
///   ① 会话建立请求**不带** `x-kp-child-id`（那正是它要签出来的东西）；
///   ② 两个请求都带 `x-kp-device-id` + `Authorization`（缺一个就是 401）；
///   ③ 401 会**清掉 token**（闸门据此回登录页，而不是无限重试）；
///   ④ 回包缺 `children` ⇒ `malformed`（不把"回包截断"当成"你还没有孩子"）。
const String _validToken =
    'kps_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

void main() {
  late SessionScope scope;

  setUp(() async {
    scope = SessionScope(store: MemorySessionStore(), random: _FixedRandom());
    await scope.restore();
  });

  ReadApiConfig config() => ReadApiConfig(
        baseUrl: 'https://example.test/kids',
        session: scope,
      );

  test('★ 设备 id 运行期生成并写进请求头；没有孩子时不发 child 头', () async {
    final AuthTokenHolder holder =
        AuthTokenHolder(initial: _validToken);
    addTearDown(holder.dispose);
    final _RecordingTransport transport = _RecordingTransport(
      statusCode: 200,
      body: jsonEncode(<String, Object?>{
        'user': <String, Object?>{'id': 'u-1', 'displayName': null},
        'expiresAt': '2026-11-09T00:00:00.000Z',
        'children': <Object?>[
          <String, Object?>{
            'childId': 'child-1',
            'name': '小明',
            'role': 'guardian',
          },
        ],
      }),
    );
    final IdentityApiClient api = IdentityApiClient(
      config: config(),
      holder: holder,
      transport: transport,
    );

    final List<ChildMembership> children = await api.fetchMemberships();
    expect(children.single.childId, 'child-1');
    expect(children.single.name, '小明');
    expect(children.single.role, 'guardian');

    expect(transport.calls.single.method, 'GET');
    expect(transport.calls.single.uri.path, '/kids/auth/session');
    expect(transport.calls.single.headers['x-kp-device-id'], scope.deviceId);
    expect(transport.calls.single.headers['authorization'], 'Bearer $_validToken');
    expect(transport.calls.single.headers.containsKey('x-kp-child-id'), isFalse);
  });

  test('establishChildSession：POST body 只带 childId，回包写入角色', () async {
    final AuthTokenHolder holder =
        AuthTokenHolder(initial: _validToken);
    addTearDown(holder.dispose);
    final _RecordingTransport transport = _RecordingTransport(
      statusCode: 200,
      body: jsonEncode(<String, Object?>{
        'childId': 'child-9',
        'role': 'guardian',
        'sessionExpiresAt': '2026-11-09T00:00:00.000Z',
      }),
    );
    final IdentityApiClient api = IdentityApiClient(
      config: config(),
      holder: holder,
      transport: transport,
    );

    final ChildSessionResult result =
        await api.establishChildSession(' child-9 ');
    expect(result.childId, 'child-9');
    expect(result.role, 'guardian');

    final _Call call = transport.calls.single;
    expect(call.method, 'POST');
    expect(call.uri.path, '/kids/auth/child-session');
    expect(jsonDecode(call.body), <String, Object?>{'childId': 'child-9'});
    expect(call.headers.containsKey('x-kp-child-id'), isFalse);
  });

  test('★ 401 ⇒ 清掉 token 并抛出 unauthenticated（闸门回登录页）', () async {
    final AuthTokenHolder holder =
        AuthTokenHolder(initial: _validToken);
    addTearDown(holder.dispose);
    final IdentityApiClient api = IdentityApiClient(
      config: config(),
      holder: holder,
      transport: _RecordingTransport(
        statusCode: 401,
        body: jsonEncode(<String, Object?>{'code': 'TOKEN_EXPIRED'}),
      ),
    );

    await expectLater(
      api.fetchMemberships(),
      throwsA(isA<WriteApiException>().having(
        (WriteApiException e) => e.kind,
        'kind',
        WriteFailureKind.unauthenticated,
      )),
    );
    expect(holder.hasToken, isFalse);
  });

  test('★ 回包缺 children ⇒ malformed（不冒充"你还没有孩子"）', () async {
    final AuthTokenHolder holder =
        AuthTokenHolder(initial: _validToken);
    addTearDown(holder.dispose);
    final IdentityApiClient api = IdentityApiClient(
      config: config(),
      holder: holder,
      transport: _RecordingTransport(
        statusCode: 200,
        body: jsonEncode(<String, Object?>{
          'user': <String, Object?>{'id': 'u-1'},
          'expiresAt': '2026-11-09T00:00:00.000Z',
        }),
      ),
    );

    await expectLater(
      api.fetchMemberships(),
      throwsA(isA<ReadApiException>().having(
        (ReadApiException e) => e.kind,
        'kind',
        ReadFailureKind.malformed,
      )),
    );
  });
}

class _Call {
  _Call(this.method, this.uri, this.headers, this.body);

  final String method;
  final Uri uri;
  final Map<String, String> headers;
  final String body;
}

class _RecordingTransport implements WriteTransport {
  _RecordingTransport({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
  final List<_Call> calls = <_Call>[];

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    calls.add(_Call(method, uri, Map<String, String>.from(headers), body));
    return WriteHttpResponse(statusCode: statusCode, body: this.body);
  }

  @override
  void close() {}
}

/// 固定随机源：设备 id 可预测，断言就不依赖运气。
class _FixedRandom implements Random {
  int _value = 0;

  @override
  bool nextBool() => false;

  @override
  double nextDouble() => 0;

  @override
  int nextInt(int max) {
    _value = (_value + 7) % max;
    return _value;
  }
}
