import 'dart:async';

import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../theme/app_colors.dart';
import '../widgets/app_bottom_nav.dart';
import '../widgets/read_status_banner.dart';
import 'approvals_screen.dart';
import 'home_screen.dart';
import 'profile_screen.dart';
import 'wishlist_screen.dart';

/// 四段式外壳：首页 / 心愿单 / 审批 / 我的。
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  bool _loadStarted = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 只触发一次首屏加载：切 tab / 重建不会重新发请求（下拉刷新是显式动作）。
    if (_loadStarted) return;
    _loadStarted = true;
    final AppStore store = AppScope.of(context);
    if (!store.isLiveMode) return;
    // ★ 不能在这里直接 `refreshFromServer()`：它同步 `notifyListeners()`，
    //   而 `didChangeDependencies` 仍在 build 阶段 —— 会触发 markNeedsBuild during build。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !store.isLiveMode) return;
      unawaited(store.refreshFromServer());
      // W14（2026-11-03）：首页要显示「孩子模式」状态条，所以首屏也拉一次模式。
      // 只在这里（首屏一次）加，**不**塞进 `refreshFromServer` —— 那个函数是
      // 每次下拉刷新都会跑的，给每个家庭多付一次"与首页数据无关"的请求。
      // 面板里仍会各自拉一次（打开即最新）。
      unawaited(store.refreshParentMode());
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.pageTop,
      body: Column(
        children: <Widget>[
          // 只读模式的**全局**提示：不是错误，也不是空数据。
          const ReadStatusBanner(),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: <Widget>[
                const HomeScreen(),
                const WishlistScreen(),
                const ApprovalsScreen(),
                // W5-M：通知里的「去审批」要把 tab 切到审批页 —— 下标只有这里知道。
                ProfileScreen(onOpenApprovals: () => _select(2)),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: AppBottomNav(
        currentIndex: _index,
        onChanged: (int index) => _select(index),
      ),
    );
  }

  /// 切 tab。审批页**懒加载**：`IndexedStack` 会在启动时就 build 它，
  /// 若在 `initState` 里发请求，孩子设备一启动就会吃一个 403。
  /// 因此只在第一次真正切到审批页时拉第一页（失败后由页面自己的「重试」再发）。
  ///
  /// 「我的」页同样懒：它是 `IndexedStack` 里**总会** build 的，W5-L 的未读
  /// 红点不能挂在它的 `initState` 上 —— 那等于启动就多发一次 `GET /notifications`。
  /// 切过去时单独取一次未读数（`limit=1`），失败静默（红点只是提示）。
  void _select(int index) {
    setState(() => _index = index);
    final AppStore store = AppScope.of(context);
    if (index == 3) {
      if (!store.isLiveMode) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !store.isLiveMode) return;
        unawaited(store.refreshUnreadNotificationCount());
      });
      return;
    }
    if (index != 2) return;
    if (!store.isLiveMode) return;
    if (store.approvalReadStatus != ReadStatus.idle) return;
    // 不能同步 notify（还在 build/setState 链上），推到下一帧。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(store.refreshApprovals());
    });
  }
}
