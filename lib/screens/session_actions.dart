import 'package:flutter/widgets.dart';

import '../data/auth_api.dart';

/// 「退出登录」的唯一入口（`43` §0 **P0-2** 的一半，2026-11-03）。
///
/// ── 为什么需要一个 InheritedWidget 而不是把回调一路传下去 ────────────────────
///   `退出登录` 必须做三件事，而这三件事的持有者都不在「我的」页：
///     ① 撤销服务端这条会话（`POST /auth/logout`）＋ 清本地 token；
///     ② 清掉本机的 `childId`（否则下一个账号的第一个请求会带着别人的孩子）；
///     ③ 把闸门切回登录页。
///   ①②③ 全在 `AccountGate` 里，且**必须**走它那一份 —— 在页面里另写一份
///   「清 token」等于造第二个真相：某天漏掉 ②，就会出现「换了账号却看到上一个
///   孩子的数据」。
///
/// ── 为什么 `null` 是正常状态 ────────────────────────────────────────────────
///   预览模式（没配 `KP_API_BASE_URL`）/ 未登录时不提供这个动作：
///   画一个点了没反应的「退出登录」比不画更糟。
class SessionActions extends InheritedWidget {
  const SessionActions({
    super.key,
    required this.signOut,
    this.authApi,
    required super.child,
  });

  /// 退出登录（成功后闸门会切回登录页）。**不要**在这里再清一次 token。
  final Future<void> Function() signOut;

  /// 已登录时的账号客户端（`GET/PUT /auth/account`，P0-2b 2026-11-03）。
  ///
  /// ── 为什么它挂在**这里**而不是让「我的」页自己 new 一个 ────────────────────
  ///   账号绑定与密码修改都要求「同一个 token 持有者」：`AuthApiClient` 的
  ///   401 分支会**清掉本地 token**（见 `auth_api.dart` 的 `_send` ②）。
  ///   页面里另 new 一个客户端也能发请求，但它拿的是另一份 holder 时，
  ///   「凭据失效了」这件事就只在那个副本里生效 —— 闸门还以为自己登录着。
  ///
  /// `null` ⇒ 预览模式 / 未接后端：**不画**「登录账号」这一行
  /// （画一个点了没反应的入口比不画更糟，与 [signOut] 同一判据）。
  final AuthApi? authApi;

  static SessionActions? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SessionActions>();

  @override
  bool updateShouldNotify(SessionActions oldWidget) =>
      signOut != oldWidget.signOut || authApi != oldWidget.authApi;
}
