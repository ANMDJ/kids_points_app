import 'package:flutter/widgets.dart';

import 'app_store.dart';

/// 把 [AppStore] 注入整棵树（放在 MaterialApp 之上，弹窗里也能拿到）。
class AppScope extends InheritedNotifier<AppStore> {
  const AppScope({super.key, required AppStore store, required super.child})
      : super(notifier: store);

  static AppStore of(BuildContext context) {
    final AppScope? scope =
        context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope 未找到：请在 MaterialApp 之上包裹 AppScope。');
    return scope!.notifier!;
  }
}
