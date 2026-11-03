import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kids_points_app/data/auth_api.dart';
import 'package:kids_points_app/data/auth_dto.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/screens/sheets/account_sheet.dart';

/// P0-2b：「我的 → 登录账号」面板（2026-11-03）。
///
/// 这条用例钉四件事（每条都能失败）：
///   ① 打开就**先读一次**（`GET /auth/account`）：不读就只能画空白框，用户会
///      以为自己没绑过，于是又绑一次（换号 ⇒ 上一台设备再也登不进来）；
///   ② `hasPassword` 决定「设置密码 / 新密码 + 当前密码」——猜错就是一次必然 400；
///   ③ 弱密码**本地就说清要求**，一个请求都不发（这是 2026-11-03 那次 400 的教训）；
///   ④ 服务端拒绝取**原文**：`403 CURRENT_PASSWORD_INVALID` 不是 401，
///      不该把用户踢回登录页，也不该把它说成「网络错误」。
class _FakeAuthApi implements AuthApi {
  _FakeAuthApi({required this.info});

  AccountInfo info;

  /// 下一次 `updateAccount` 要抛的异常（`null` ⇒ 成功）。
  WriteApiException? failWith;

  int fetchCalls = 0;
  int updateCalls = 0;
  Map<String, Object?>? lastUpdate;

  @override
  Future<AccountInfo> fetchAccount() async {
    fetchCalls += 1;
    return info;
  }

  @override
  Future<AccountInfo> updateAccount({
    String? phone,
    String? email,
    String? password,
    String? currentPassword,
  }) async {
    updateCalls += 1;
    lastUpdate = <String, Object?>{
      if (phone != null) 'phone': phone,
      if (email != null) 'email': email,
      if (password != null) 'password': password,
      if (currentPassword != null) 'currentPassword': currentPassword,
    };
    final WriteApiException? failure = failWith;
    if (failure != null) throw failure;
    info = AccountInfo(
      phone: phone ?? info.phone,
      email: email ?? info.email,
      hasPassword: info.hasPassword || password != null,
    );
    return info;
  }

  @override
  Future<AuthLoginResult> loginAccount({
    required String identifier,
    required String password,
  }) async =>
      throw UnimplementedError('面板不登录');

  @override
  Future<AuthLoginResult> registerWithInvite({
    required String inviteCode,
    required String identifier,
    required String password,
    String? displayName,
  }) async =>
      throw UnimplementedError('面板不注册');

  @override
  Future<void> logout() async {}

  @override
  void close() {}
}

Future<void> pumpSheet(WidgetTester tester, AuthApi api) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: AccountSheet(authApi: api)),
    ),
  );
  await tester.pumpAndSettle();
}

/// 输入框顺序：手机号 → 邮箱 → 密码 → 当前密码（`hasPassword` 时才有第 4 个）。
Finder fieldAt(int index) => find.byType(TextField).at(index);

void main() {
  testWidgets('★ 打开即读一次，并显示掩码手机号 + 「新密码 / 当前密码」',
      (WidgetTester tester) async {
    final _FakeAuthApi api = _FakeAuthApi(
      info: const AccountInfo(
        phone: '13800138000',
        email: null,
        hasPassword: true,
      ),
    );

    await pumpSheet(tester, api);

    expect(api.fetchCalls, 1, reason: '必须先读再画，否则用户会重复绑定');
    expect(api.updateCalls, 0);
    // 掩码手机号在**两处**出现：状态行（「已绑定 138****8000，…」）与
    // 手机号输入框的提示（「当前 138****8000；换号请直接填新号」）。
    // 这里只钉状态行那一句，避免用例对「提示文案长什么样」过度耦合。
    expect(find.textContaining('已绑定 138****8000'), findsOneWidget);
    // hasPassword ⇒ 写「新密码」并要求当前密码
    expect(find.text('新密码'), findsOneWidget);
    expect(find.text('当前密码'), findsOneWidget);
    expect(find.textContaining('可以用手机号或邮箱 + 密码登录'), findsOneWidget);
  });

  testWidgets('没设过密码 ⇒ 写「设置密码」，且不要求当前密码', (WidgetTester tester) async {
    final _FakeAuthApi api = _FakeAuthApi(
      info: const AccountInfo(
        phone: null,
        email: 'dad@example.com',
        hasPassword: false,
      ),
    );

    await pumpSheet(tester, api);

    expect(find.text('设置密码'), findsOneWidget);
    expect(find.text('当前密码'), findsNothing);
    expect(find.textContaining('还没有设置密码'), findsOneWidget);
  });

  testWidgets('★ 弱密码：本地就说清要求，一个请求都不发（2026-11-03 那次 400）',
      (WidgetTester tester) async {
    final _FakeAuthApi api = _FakeAuthApi(
      info: const AccountInfo(
        phone: '13800138000',
        email: null,
        hasPassword: true,
      ),
    );
    await pumpSheet(tester, api);

    await tester.enterText(fieldAt(2), '12345678');
    await tester.enterText(fieldAt(3), 'jiazhang2026');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(api.updateCalls, 0, reason: '注定 400 的请求不该发出去');
    expect(find.text('密码不能全是数字，请至少带一个字母。'), findsOneWidget);
  });

  testWidgets('★ 服务端 403 取原文，且留在本页（不跳登录页、不说成网络错误）',
      (WidgetTester tester) async {
    final _FakeAuthApi api = _FakeAuthApi(
      info: const AccountInfo(
        phone: '13800138000',
        email: null,
        hasPassword: true,
      ),
    );
    api.failWith = WriteApiException.fromHttp(
      statusCode: 403,
      body: <String, Object?>{
        'code': 'CURRENT_PASSWORD_INVALID',
        'message': '当前密码不正确，密码没有修改。',
      },
    );
    await pumpSheet(tester, api);

    await tester.enterText(fieldAt(2), 'jiazhang2027');
    await tester.enterText(fieldAt(3), 'wrong-old');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(api.updateCalls, 1);
    expect(api.lastUpdate?['currentPassword'], 'wrong-old');
    expect(find.text('当前密码不正确，密码没有修改。'), findsOneWidget);
    // 面板还在（没有跳走），保存按钮回到可点状态。
    expect(find.text('保存'), findsOneWidget);
  });

  testWidgets('★ 只提交改动过的字段：填邮箱时请求里没有 phone',
      (WidgetTester tester) async {
    final _FakeAuthApi api = _FakeAuthApi(
      info: const AccountInfo(
        phone: '13800138000',
        email: null,
        hasPassword: true,
      ),
    );
    await pumpSheet(tester, api);

    await tester.enterText(fieldAt(1), 'dad@example.com');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(api.updateCalls, 1);
    expect(api.lastUpdate?['email'], 'dad@example.com');
    expect(api.lastUpdate?.containsKey('phone'), isFalse,
        reason: '空手机号框不许发出去（服务端会当成"要清掉绑定"）');
    expect(api.lastUpdate?.containsKey('password'), isFalse);
    // 状态行与输入框都更新了
    expect(find.textContaining('dad@example.com'), findsWidgets);
  });

  testWidgets('没有任何改动时点保存 ⇒ 只提示，不发请求', (WidgetTester tester) async {
    final _FakeAuthApi api = _FakeAuthApi(
      info: const AccountInfo(
        phone: '13800138000',
        email: null,
        hasPassword: false,
      ),
    );
    await pumpSheet(tester, api);

    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();

    expect(api.updateCalls, 0);
    expect(find.textContaining('没有要保存的改动'), findsOneWidget);
  });
}
