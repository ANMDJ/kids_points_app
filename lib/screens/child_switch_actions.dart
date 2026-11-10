import 'package:flutter/widgets.dart';

import '../data/identity_api.dart' show ChildMembership;

/// 「切换孩子」的唯一动作入口（2026-11-10，用户第 3 条）。
///
/// ── 它解决的是什么 ──────────────────────────────────────────────────────────
///   后端一直支持一个账号在多个孩子上有成员位（`GET /auth/session` 的
///   `children[]`），但 App 在 `AccountGate._ensureChild()` 里**永远取第一个**：
///   `children.first`。于是「允许有多个孩子」在产品上等于不存在 ——
///   第二个孩子的数据根本进不去。
///
/// ── 为什么是两个回调，而不是把列表塞进来 ────────────────────────────────────
///   · 冷启动时不需要多付一次 `GET /auth/session`（孩子 id 已从本地恢复）；
///   · 列表只有「点开切换页」那一刻才需要 ⇒ [loadChildren] 现取；
///   · `switchChild` 要做三件事（`POST /auth/child-session` → `adoptChild`
///     → 清空上一个孩子的页面缓存），持有者全在 `AccountGate`。
///     在页面里另写一份就是造第二个真相（与 `FamilyJoinActions` 同一理由）。
///
/// ── 为什么模态弹层要先取再传 ────────────────────────────────────────────────
///   `AccountGate` 在 `MaterialApp.home` 之下，而路由 / 弹层挂在 Navigator 上
///   —— 它们的 context 查不到这个 InheritedWidget。调用方必须先
///   `ChildSwitchActions.maybeOf(context)`，再把动作传给页面（同
///   `family_join_actions.dart` 文件头）。
class ChildSwitchActions extends InheritedWidget {
  const ChildSwitchActions({
    super.key,
    required this.loadChildren,
    required this.switchChild,
    required this.currentChildId,
    required super.child,
  });

  /// 取「我在哪些孩子上有成员位」。失败时抛 `ReadApiException`，由页面显示原文。
  final Future<List<ChildMembership>> Function() loadChildren;

  /// 切到某个孩子。`null` = 成功；字符串 = 可直接展示的失败文案。
  final Future<String?> Function(String childId) switchChild;

  /// 当前会话指向哪个孩子（用来在列表里打勾）。
  final String? currentChildId;

  static ChildSwitchActions? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ChildSwitchActions>();

  @override
  bool updateShouldNotify(ChildSwitchActions oldWidget) =>
      switchChild != oldWidget.switchChild ||
      loadChildren != oldWidget.loadChildren ||
      currentChildId != oldWidget.currentChildId;
}