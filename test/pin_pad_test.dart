import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/widgets/pin_pad.dart';

/// 锁屏式 PIN 键盘（2026-11-04）：数字 / 退格 / 清空 / 4–6 位边界。
///
/// 这些用例钉的是**输入组件本身**的边界，不是闸门逻辑 —— 后者在
/// `pin_guard_test.dart`。分开写是因为组件一旦被复用（锁屏、家长面板、
/// 设置页），任何一处的手滑都会在这里先红。
void main() {
  group('PinInputController', () {
    test('只收单个数字；4–6 位边界', () {
      final PinInputController controller = PinInputController();
      addTearDown(controller.dispose);

      expect(controller.value, '');
      expect(controller.isReady, isFalse);

      controller.add('1');
      controller.add('2');
      controller.add('3');
      expect(controller.isReady, isFalse, reason: '3 位还不能提交（服务端最少 4 位）');

      controller.add('4');
      expect(controller.value, '1234');
      expect(controller.isReady, isTrue);

      // 第 7 位被丢弃：服务端只接受 4–6 位，多出来的必须在这里就挡掉。
      for (final String digit in <String>['5', '6', '7']) {
        controller.add(digit);
      }
      expect(controller.value, '123456');
    });

    test('非法字符被忽略（不是抛异常）', () {
      final PinInputController controller = PinInputController();
      addTearDown(controller.dispose);

      controller.add('a');
      controller.add('');
      controller.add('12');
      expect(controller.value, '');

      controller.add('9');
      expect(controller.value, '9');
    });

    test('退格 / 清空', () {
      final PinInputController controller = PinInputController();
      addTearDown(controller.dispose);

      controller.add('1');
      controller.add('2');
      controller.backspace();
      expect(controller.value, '1');

      controller.backspace();
      controller.backspace(); // 空的时候不抛
      expect(controller.value, '');

      controller.add('1');
      controller.add('2');
      controller.clear();
      expect(controller.value, '');
    });
  });

  group('PinPad：界面', () {
    Widget host(
      PinInputController controller, {
      bool enabled = true,
      String? errorText,
    }) {
      return MaterialApp(
        home: Scaffold(
          body: PinPad(
            controller: controller,
            enabled: enabled,
            errorText: errorText,
            hintText: '4–6 位数字',
          ),
        ),
      );
    }

    Future<void> tapDigit(WidgetTester tester, String digit) async {
      await tester.tap(find.byKey(ValueKey<String>('pin-key-$digit')));
      await tester.pump();
    }

    testWidgets('点数字键 ⇒ 控制器收数；退格 / 清空键可用', (WidgetTester tester) async {
      final PinInputController controller = PinInputController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(host(controller));

      // 0–9 十个数字键都在（自绘键盘，不依赖系统输入法）。
      for (int digit = 0; digit <= 9; digit += 1) {
        expect(
          find.byKey(ValueKey<String>('pin-key-$digit')),
          findsOneWidget,
          reason: '缺少数字键 $digit',
        );
      }
      expect(find.text('4–6 位数字'), findsOneWidget);

      await tapDigit(tester, '1');
      await tapDigit(tester, '2');
      expect(controller.value, '12');

      await tester.tap(find.byKey(const ValueKey<String>('pin-key-backspace')));
      await tester.pump();
      expect(controller.value, '1');

      await tester.tap(find.byKey(const ValueKey<String>('pin-key-clear')));
      await tester.pump();
      expect(controller.value, '');
    });

    testWidgets('enabled=false ⇒ 按键点了也不动（提交中 / 锁定）', (WidgetTester tester) async {
      final PinInputController controller = PinInputController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(host(controller, enabled: false));

      await tapDigit(tester, '1');
      expect(controller.value, '');
    });

    testWidgets('错误文案原样展示（不做二次解释）', (WidgetTester tester) async {
      final PinInputController controller = PinInputController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        host(controller, errorText: '家长 PIN 不对（还剩 4 次尝试机会）。'),
      );

      expect(find.text('家长 PIN 不对（还剩 4 次尝试机会）。'), findsOneWidget);
    });
  });
}
