import 'dart:async';

import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../theme/app_colors.dart';
import '../widgets/app_bottom_nav.dart';
import '../widgets/read_status_banner.dart';
import 'home_screen.dart';
import 'profile_screen.dart';
import 'wishlist_screen.dart';

/// 三段式外壳：首页 / 心愿单 / 我的。
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
              children: const <Widget>[
                HomeScreen(),
                WishlistScreen(),
                ProfileScreen(),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: AppBottomNav(
        currentIndex: _index,
        onChanged: (int index) => setState(() => _index = index),
      ),
    );
  }
}
