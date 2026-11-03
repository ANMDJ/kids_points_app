import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kids_points_app/data/identity_api.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/session_scope.dart';
import 'package:kids_points_app/data/token_store.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/models/invite.dart';
import 'package:kids_points_app/screens/account_gate.dart';
import 'package:kids_points_app/screens/family_join_actions.dart';
import 'package:kids_points_app/screens/sheets/join_family_sheet.dart';

/// P0-3：「已有账号 → 输入邀请码加入家庭」（2026-11-03）。
///
/// ── 这里钉的五件事（每条都能失败）────────────────────────────────────────────
///   ① 形状规则与后端 `invite-code.ts` **逐字同源**（改一边忘另一边会红）；
///   ② 空码 / 少抄一位**本地**就说清楚，一个请求都不发；
///   ③ 面板上送的是**规范化后**的裸码（`abcd-efgh` ⇒ `ABCDEFGH`）；
///   ④ 服务端拒绝取**原文**（`ALREADY_MEMBER` / `INVITE_CODE_UNAVAILABLE`），
///      且留在面板里（不能把一次可修正的输入错误变成"什么都没发生"）；
///   ⑤ 成功路径必须走完三件事：accept → `SessionScope.adoptChild` →
///      `onIdentityChanged`。只做第一件 = 新会话已签发、App 还停在旧家庭。
const String _token = 'kps_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

/// 直接挂在 `MaterialApp.home` 上的面板宿主：用按钮打开，拿到 pop 的返回值。
Widget host(
  Future<String?> Function(String code) join, {
  ValueChanged<bool?>? onResult,
}) {
  return MaterialApp(
    home: Builder(
      builder: (BuildContext context) => Scaffold(
        body: Center(
          child: TextButton(
            onPressed: () async {
              final bool? result = await showModalBottomSheet<bool>(
                context: context,
                isScrollControlled: true,
                backgroundColor: Colors.transparent,
                builder: (BuildContext sheetContext) =>
                    JoinFamilySheet(joinFamily: join),
              );
              onResult?.call(result);
            },
            child: const Text('打开'),
          ),
        ),
      ),
    ),
  );
}

/// `IdentityApi` 替身：只实现本文件关心的四类动作。
class _FakeIdentityApi implements IdentityApi {
  _FakeIdentityApi({this.joinFailure});

  /// 非空 ⇒ `acceptInvite` 抛这个异常（模拟 409 / 400）。
  WriteApiException? joinFailure;

  final List<String> accepted = <String>[];

  @override
  Future<List<ChildMembership>> fetchMemberships() async =>
      const <ChildMembership>[
        ChildMembership(childId: 'child-1', name: '小明', role: 'guardian'),
      ];

  @override
  Future<ChildSessionResult> establishChildSession(String childId) async =>
      ChildSessionResult(
        childId: childId,
        role: 'guardian',
        sessionExpiresAt: DateTime.now().add(const Duration(days: 30)),
      );

  @override
  Future<ChildSessionResult> acceptInvite(String code) async {
    accepted.add(code);
    final WriteApiException? failure = joinFailure;
    if (failure != null) throw failure;
    return ChildSessionResult(
      childId: 'child-joined',
      role: 'child',
      sessionExpiresAt: DateTime.now().add(const Duration(days: 30)),
    );
  }

  @override
  Future<BootstrapChildResult> bootstrapChild(
          {String relation = 'other'}) async =>
      const BootstrapChildResult(childId: 'child-new', role: 'guardian');

  @override
  Future<void> renameChild(String name) async {}

  @override
  void close() {}
}

void main() {
  group('形状规则', () {
    test('规范化：去空白与连字符、转大写', () {
      expect(normalizeInviteCodeInput(' abcd-efgh '), 'ABCDEFGH');
      expect(normalizeInviteCodeInput('ABCD EFGH'), 'ABCDEFGH');
      expect(normalizeInviteCodeInput('ab-cd efgh'), 'ABCDEFGH');
    });

    test('8 位 / 31 个易辨认字符（不含 0 O 1 I L）', () {
      expect(isWellFormedInviteCode('ABCDEFGH'), isTrue);
      expect(isWellFormedInviteCode('ABCDEFG'), isFalse, reason: '少抄一位');
      expect(isWellFormedInviteCode('ABCD0FGH'), isFalse, reason: '0 不在字母表');
      expect(isWellFormedInviteCode('ABCDIFGH'), isFalse, reason: 'I 不在字母表');
      expect(isWellFormedInviteCode('ABCDFGHJ'), isTrue);
    });

    test('形状常量与后端 invite-code.ts 同源（改一边忘另一边会红）', () {
      final File source = File('backend/src/invites/invite-code.ts');
      expect(source.existsSync(), isTrue, reason: '找不到后端唯一判据');
      final String ts = source.readAsStringSync();
      expect(
        ts,
        contains("export const INVITE_CODE_ALPHABET = '$kInviteCodeAlphabet'"),
        reason: '字母表已漂移：本地会放行、服务端会 400',
      );
      expect(
        ts,
        contains('export const INVITE_CODE_LENGTH = $kInviteCodeLength'),
        reason: '码长已漂移',
      );
    });
  });

  group('面板：本地先拦', () {
    testWidgets('空码 ⇒ 提示且零请求', (WidgetTester tester) async {
      final List<String> calls = <String>[];
      await tester.pumpWidget(host((String code) async {
        calls.add(code);
        return null;
      }));
      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('加入'));
      await tester.pumpAndSettle();

      expect(calls, isEmpty, reason: '空输入不该发请求');
      expect(find.textContaining('请先输入邀请码'), findsOneWidget);
    });

    testWidgets('少抄一位 ⇒ 报出当前位数且零请求', (WidgetTester tester) async {
      final List<String> calls = <String>[];
      await tester.pumpWidget(host((String code) async {
        calls.add(code);
        return null;
      }));
      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'abcd');
      await tester.tap(find.text('加入'));
      await tester.pumpAndSettle();

      expect(calls, isEmpty);
      expect(find.textContaining('现在输入的是 4 位'), findsOneWidget);
    });
  });

  group('面板：服务端说了算', () {
    testWidgets('成功 ⇒ 上送规范化裸码并关掉面板', (WidgetTester tester) async {
      final List<String> calls = <String>[];
      bool? result;
      await tester.pumpWidget(host(
        (String code) async {
          calls.add(code);
          return null;
        },
        onResult: (bool? value) => result = value,
      ));
      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'abcd-efgh');
      await tester.tap(find.text('加入'));
      await tester.pumpAndSettle();

      expect(calls, <String>['ABCDEFGH']);
      expect(result, isTrue, reason: '成功要回传 true，调用方据此提示');
      expect(find.text('加入家庭'), findsNothing, reason: '成功后面板应关闭');
    });

    testWidgets('409 ALREADY_MEMBER ⇒ 显示原文，面板不关',
        (WidgetTester tester) async {
      await tester.pumpWidget(host((String code) async {
        return '你已经是这个孩子的成员了，这次没有消耗邀请码，角色也没有被改变。';
      }));
      await tester.tap(find.text('打开'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'abcdefgh');
      await tester.tap(find.text('加入'));
      await tester.pumpAndSettle();

      expect(find.textContaining('已经是这个孩子的成员'), findsOneWidget);
      expect(find.text('加入家庭'), findsOneWidget,
          reason: '可修正的失败不该关掉面板');
    });
  });

  group('闸门编排（accept → adoptChild → onIdentityChanged）', () {
    /// 一个最小的"闸门内页面"：一个按钮，点了就调 `FamilyJoinActions`。
    Widget gate({
      required SessionScope scope,
      required AuthTokenHolder holder,
      required IdentityApi identity,
      required Future<void> Function(BuildContext context) onJoin,
      VoidCallback? onIdentityChanged,
    }) =>
        MaterialApp(
          home: AccountGate(
            holder: holder,
            identityApi: identity,
            session: scope,
            config: ReadApiConfig(
              baseUrl: 'https://example.test/kids',
              session: scope,
            ),
            onIdentityChanged: onIdentityChanged,
            child: Scaffold(
              body: Builder(
                builder: (BuildContext context) => TextButton(
                  onPressed: () => onJoin(context),
                  child: const Text('JOIN'),
                ),
              ),
            ),
          ),
        );

    testWidgets('★ 加入成功后 childId 切到新家庭，并清一次缓存',
        (WidgetTester tester) async {
      final SessionScope scope = SessionScope(store: MemorySessionStore());
      await scope.restore();
      final AuthTokenHolder holder =
          AuthTokenHolder(store: MemoryTokenStore(_token));
      addTearDown(holder.dispose);
      final _FakeIdentityApi identity = _FakeIdentityApi();
      int resets = 0;
      String? message;

      await tester.pumpWidget(gate(
        scope: scope,
        holder: holder,
        identity: identity,
        onIdentityChanged: () => resets += 1,
        onJoin: (BuildContext context) async {
          message =
              await FamilyJoinActions.maybeOf(context)!.joinFamily('jkmn2345');
        },
      ));
      await tester.pumpAndSettle();
      expect(scope.childId, 'child-1');
      final int baseline = resets;

      await tester.tap(find.text('JOIN'));
      await tester.pumpAndSettle();

      expect(message, isNull, reason: '成功时回调返回 null');
      expect(identity.accepted, <String>['jkmn2345']);
      expect(scope.childId, 'child-joined');
      expect(scope.role, 'child', reason: '角色来自邀请码行，不由客户端指定');
      expect(resets, baseline + 1, reason: '换孩子必须清一次页面缓存');
    });

    testWidgets('★ 409 ⇒ 原文回传，childId 不变', (WidgetTester tester) async {
      final SessionScope scope = SessionScope(store: MemorySessionStore());
      await scope.restore();
      final AuthTokenHolder holder =
          AuthTokenHolder(store: MemoryTokenStore(_token));
      addTearDown(holder.dispose);
      final _FakeIdentityApi identity = _FakeIdentityApi(
        joinFailure: WriteApiException(
          WriteFailureKind.conflict,
          '这张邀请码现在不能用（可能已过期、已用完或已吊销）。',
          statusCode: 409,
          code: 'INVITE_CODE_UNAVAILABLE',
        ),
      );
      int resets = 0;
      String? message;

      await tester.pumpWidget(gate(
        scope: scope,
        holder: holder,
        identity: identity,
        onIdentityChanged: () => resets += 1,
        onJoin: (BuildContext context) async {
          message =
              await FamilyJoinActions.maybeOf(context)!.joinFamily('jkmn2345');
        },
      ));
      await tester.pumpAndSettle();
      final int baseline = resets;

      await tester.tap(find.text('JOIN'));
      await tester.pumpAndSettle();

      expect(message, contains('不能用'), reason: '必须把服务端原文交给界面');
      expect(scope.childId, 'child-1', reason: '失败不许改身份');
      expect(resets, baseline, reason: '失败不该清缓存');
    });
  });
}
