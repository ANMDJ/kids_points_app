import 'package:flutter/widgets.dart';

/// 「输入邀请码加入家庭」的唯一动作入口（`43` §0 **P0-3**，2026-11-03）。
///
/// ── 为什么需要它，而不是让面板自己调 API ────────────────────────────────────
///   一次"加入"要做三件事，而这三件事的持有者都不在「我的」页：
///     ① `POST /invites/accept`（用**当前** token + 设备 id + 当前孩子会话）；
///     ② 把回包里的 `childId` 落到本机（`SessionScope.adoptChild`）——
///        服务端已在同一事务里签发 `DeviceSession`，不必再调一次
///        `POST /auth/child-session`；
///     ③ 通知上层清空上一个孩子的页面缓存（`AppStore.resetForIdentity`），
///        否则加入后仍会先看到原来那个家庭的数据。
///   在页面里另写一份 ②③ 就等于造第二个真相：某天漏掉 ③，就会出现
///   「已经加入新家庭，但首页还是旧家庭的积分」。
///
/// ── 为什么 `null` 是正常状态 ────────────────────────────────────────────────
///   预览模式（没配 `KP_API_BASE_URL`）/ 未登录 / 没有运行期身份：
///   画一个点了必然失败的「加入家庭」比不画更糟（与 `SessionActions` 同一判据）。
///
/// ── 为什么模态弹窗要**先取再传** ────────────────────────────────────────────
///   `showModalBottomSheet` 把内容挂到 Navigator 的 Overlay 上，而
///   `AccountGate` 在 `MaterialApp.home` 之下 —— 弹窗的 context 查不到这个
///   InheritedWidget。`showJoinFamilySheet()` 因此在**打开之前**就取好，
///   作为参数传进面板（`showInviteSheet` 传 store 是同一手法）。
class FamilyJoinActions extends InheritedWidget {
  const FamilyJoinActions({
    super.key,
    required this.joinFamily,
    required super.child,
  });

  /// 加入家庭。`null` = 成功；字符串 = 可直接展示的失败文案。
  ///
  /// ★ 只返回文案、不抛异常：调用方是界面，它只需要"显示什么"。
  ///   失败分类（400/409/401）在 `write_api_errors.dart` 已经翻成中文。
  final Future<String?> Function(String code) joinFamily;

  static FamilyJoinActions? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<FamilyJoinActions>();

  @override
  bool updateShouldNotify(FamilyJoinActions oldWidget) =>
      joinFamily != oldWidget.joinFamily;
}
