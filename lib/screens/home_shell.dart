import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../widgets/app_bottom_nav.dart';
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.pageTop,
      body: IndexedStack(
        index: _index,
        children: const <Widget>[
          HomeScreen(),
          WishlistScreen(),
          ProfileScreen(),
        ],
      ),
      bottomNavigationBar: AppBottomNav(
        currentIndex: _index,
        onChanged: (int index) => setState(() => _index = index),
      ),
    );
  }
}
