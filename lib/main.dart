import 'package:flutter/material.dart';

import 'data/app_scope.dart';
import 'data/app_store.dart';
import 'screens/home_shell.dart';
import 'theme/app_theme.dart';

void main() {
  runApp(PointsApp(store: AppStore()));
}

/// 积分小管家：儿童习惯打卡 + 积分奖励。
class PointsApp extends StatelessWidget {
  const PointsApp({super.key, required this.store});

  final AppStore store;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      store: store,
      child: MaterialApp(
        title: '积分小管家',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        home: const HomeShell(),
      ),
    );
  }
}
