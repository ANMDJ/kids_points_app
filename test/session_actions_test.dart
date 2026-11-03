import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:kids_points_app/data/app_scope.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/screens/profile_screen.dart';
import 'package:kids_points_app/screens/session_actions.dart';

/// P0-2：「我的 → 退出登录」（2026-11-03）。
///
/// 这条用例钉三件事：
///   ① 没有闸门注入（预览模式 / 未登录）时**不画**这一行 —— 点了没反应的入口
///      比没有入口更糟；
///   ② 有注入时，点一下**先弹确认**，不直接退出（退出要重新输密码）；
///   ③ 确认后才调用唯一的那份 `signOut`（撤销会话 / 清 childId / 回登录页
///      都在闸门里做，页面不自己清 token）。
void main() {
  Future<void> pumpProfile(
    WidgetTester tester, {
    required AppStore store,
    Future<void> Function()? signOut,
  }) async {
    const Widget page = ProfileScreen();
    await tester.pumpWidget(
      AppScope(
        store: store,
        child: MaterialApp(
          home: signOut == null
              ? page
              : SessionActions(signOut: signOut, child: page),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('★ 预览模式（闸门没有提供 signOut）⇒ 不出现「退出登录」',
      (WidgetTester tester) async {
    final AppStore store = AppStore();
    addTearDown(store.dispose);

    await pumpProfile(tester, store: store);

    expect(find.text('退出登录'), findsNothing);
  });

  testWidgets('★ 点「退出登录」先确认；取消不调用，确认才调用一次',
      (WidgetTester tester) async {
    final AppStore store = AppStore();
    addTearDown(store.dispose);
    int calls = 0;

    await pumpProfile(
      tester,
      store: store,
      signOut: () async => calls += 1,
    );

    // ListView 的 children 是**一次性构建**的，`scrollUntilVisible` 会在
    // 「已经在树里但还在屏幕外」时提前返回 —— 必须真的滚到可见区再点。
    await tester.ensureVisible(find.text('退出登录'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('退出登录'));
    await tester.pumpAndSettle();

    // ② 先确认，且文案说清「要重新登录」+「数据不会丢」。
    expect(find.text('退出登录？'), findsOneWidget);
    expect(find.textContaining('不会丢失'), findsOneWidget);

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(calls, 0, reason: '取消就是什么都不做');

    await tester.tap(find.text('退出登录'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认退出'));
    await tester.pumpAndSettle();
    expect(calls, 1);
  });
}
