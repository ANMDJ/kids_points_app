import 'package:flutter/material.dart';

import 'data/app_scope.dart';
import 'data/app_store.dart';
import 'data/read_api.dart';
import 'screens/home_shell.dart';
import 'theme/app_theme.dart';

void main() {
  // W4-B：只有三项 `--dart-define` 都配齐才接后端；否则保持本地预览数据，
  // 不会出现「发了请求 → 401 → 页面显示成网络错误」的假象。
  final ReadApiConfig config = ReadApiConfig.fromEnvironment();
  runApp(
    PointsApp(
      store: AppStore(
        readApi: config.isConfigured ? ReadApiClient(config: config) : null,
      ),
    ),
  );
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
