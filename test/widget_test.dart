// 应用启动冒烟测试：根组件可以正常挂载、渲染首页且不抛异常。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/main.dart';

void main() {
  testWidgets('应用启动后展示首页', (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(PointsApp(store: AppStore()));
    await tester.pumpAndSettle();

    expect(find.text('当前可用积分'), findsWidgets);
    expect(find.text('今天的习惯'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
