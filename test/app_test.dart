// flutter_test 会在 Windows/macOS 上把中文按原样比较，无需额外配置。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/main.dart';
import 'package:kids_points_app/models/habit.dart';
import 'package:kids_points_app/models/point_record.dart';
import 'package:kids_points_app/models/point_rule.dart';
import 'package:kids_points_app/models/wish.dart';
import 'package:kids_points_app/screens/wishlist_screen.dart';
import 'package:kids_points_app/theme/app_colors.dart';
import 'package:kids_points_app/widgets/floating_add_button.dart';
import 'package:kids_points_app/widgets/wish_card.dart';

void main() {
  /// 演示数据是**测试夹具**（修 E18 / D13 第 10 条）：
  /// 应用首启是**空态**，需要演示数据时必须**显式载入** —— 测试里也一样。
  /// 不写这个 helper，用例就会悄悄依赖「构造函数替我们种数据」，
  /// 而那正是 E18 描述的错误行为本身。
  AppStore seededStore() {
    final AppStore store = AppStore();
    expect(store.resetToSeed(), isTrue, reason: '调试构建下应可显式载入演示数据夹具');
    return store;
  }

  group('演示数据', () {
    test('首次启动的数值与设计稿一致', () {
      final AppStore store = seededStore();
      expect(store.points, 124);
      expect(store.profile.goodHabitCount, 324);
      expect(store.profile.rewardCount, 4);
      expect(store.habits.length, 3);
      expect(store.rules.length, 4);
      expect(store.wishes.length, 4);
      expect(store.records.length, 4);
    });
  });

  group('习惯打卡', () {
    test('打卡成功后积分与好习惯次数增加，并写入表扬流水', () {
      final AppStore store = seededStore();
      // 番茄钟：今天演示流水已有 1 条，上限 2 次 → 还能再打一次
      final Habit habit = store.habits.first;

      final String? message = store.checkIn(habit);

      expect(message, isNull);
      expect(habitView(habit, store.records).checkedCountToday, 2);
      expect(store.points, 125);
      expect(store.profile.goodHabitCount, 325);
      expect(store.records.first.category, RecordCategory.praise);
      expect(store.records.first.points, 1);
      expect(store.records.first.title, '番茄钟写作业');
    });

    test('重复打卡会被拦下，积分不变', () {
      final AppStore store = seededStore();
      final Habit habit = store.habits[2]; // 自主阅读：每天 1 次
      store.checkIn(habit);

      final String? message = store.checkIn(habit);

      expect(message, isNotNull);
      expect(store.points, 126);
    });

    test('撤销打卡会扣回积分并写入冲正记录（修 B7）', () {
      final AppStore store = seededStore();
      final Habit habit = store.habits[2];
      store.checkIn(habit);

      final String? message = store.undoCheckIn(habit);

      expect(message, isNull);
      expect(habitView(habit, store.records).checked, isFalse);
      expect(store.points, 124);
      expect(store.profile.goodHabitCount, 324);
    });
  });

  group('记一笔与兑换', () {
    test('加分会记录为调整流水，但不累加奖励次数（修 A5）', () {
      final AppStore store = seededStore();

      final String? message =
          store.addQuickNote(delta: 5, reason: '主动帮忙做家务');

      expect(message, isNull);
      expect(store.points, 129);
      // rewardCount 语义是“奖励兑换次数”，手动加分不得递增
      expect(store.profile.rewardCount, 4);
      expect(store.records.first.category, RecordCategory.adjust);
      expect(store.records.first.amountText, '+5');
      expect(store.records.first.balanceAfter, 129);
    });

    test('超额扣分被拒绝，不再静默截断余额（修 B6）', () {
      final AppStore store = seededStore();
      final int before = store.records.length;

      final String? message = store.addQuickNote(delta: -999, reason: '随便扣分');

      expect(message, isNotNull, reason: '应返回拒绝原因而非静默失败');
      expect(store.points, 124, reason: '被拒绝时余额不变（否则账本不平）');
      expect(store.records.length, before, reason: '被拒绝时不写流水');
    });

    test('恰好扣光余额是允许的，且流水与余额一致', () {
      final AppStore store = seededStore();

      final String? message = store.addQuickNote(delta: -124, reason: '全扣');

      expect(message, isNull);
      expect(store.points, 0);
      expect(store.records.first.points, -124);
      expect(store.records.first.balanceAfter, 0);
    });

    test('积分足够时可以兑换心愿，并生成兑换流水', () {
      final AppStore store = seededStore();
      final Wish wish = store.wishes.first; // 40 积分

      final bool ok = store.redeem(wish);

      expect(ok, isTrue);
      expect(wish.redeemed, isTrue);
      expect(store.points, 84);
      expect(store.profile.rewardCount, 5);
      expect(store.records.first.category, RecordCategory.exchange);
      expect(store.records.first.points, -40);
      expect(store.canRedeem(wish), isFalse);
      // 修 B8：完整标题快照（不再 shortTitle 截断）+ 回指心愿
      expect(store.records.first.title, '兑换：${wish.title}');
      expect(store.records.first.title.endsWith('…'), isFalse);
      expect(store.records.first.wishId, wish.id);
      // 修 A4 / E19：subtitle 由结构化字段派生
      expect(store.records.first.subtitle.contains('兑换奖励'), isTrue);
      expect(store.records.first.operatorRole, MemberRole.guardian);
    });

    test('积分不足时无法兑换', () {
      final AppStore store = seededStore();
      final Wish expensive = store.wishes[2]; // 445 积分

      expect(store.canRedeem(expensive), isFalse);
      expect(store.redeem(expensive), isFalse);
      expect(store.points, 124);
      expect(store.gapOf(expensive), 321);
    });
  });

  group('筛选与规则', () {
    test('记录可以按分类过滤', () {
      final AppStore store = seededStore();
      expect(store.recordsOf(null).length, 4);
      expect(store.recordsOf(RecordCategory.praise).length, 3);
      expect(store.recordsOf(RecordCategory.exchange).length, 1);
      expect(store.recordsOf(RecordCategory.adjust), isEmpty);
    });

    test('新增规则后可以一键加入今天的习惯', () {
      final AppStore store = seededStore();
      expect(
        store.addRule(
          title: '每天练琴 30 分钟',
          condition: '认真练习不断开',
          dailyLimit: 2,
          points: 3,
          icon: Icons.music_note_rounded,
          color: Colors.amber,
        ),
        isNull,
      );

      expect(store.rules.length, 5);
      expect(store.rules.first.amountText, '+3');
      expect(store.rules.first.dailyLimit, 2);
      expect(ruleDetail(store.rules.first), '认真练习不断开 · 每天最多 2 次');

      expect(store.addHabitFromRule(store.rules.first), isNull);

      expect(store.habits.length, 4);
      expect(store.habits.last.title, '每天练琴 30 分钟');
      expect(store.habits.last.points, 3);
      expect(store.habits.last.condition, '认真练习不断开', reason: '条件直取结构字段');
      expect(store.habits.last.dailyLimit, 2, reason: '频次直取结构字段');
      expect(habitView(store.habits.last, store.records).checked, isFalse);
    });
  });

  group('账本可追溯性（A1 / A4 / B7 / B8 / I2 / I6）', () {
    test('孩子自助打卡记录为 childSelf，不谎称“家长记录”（修 A4）', () {
      final AppStore store = seededStore();
      final Habit habit = store.habits[2]; // 自主阅读 +2

      final String? message = store.checkIn(
        habit,
        actor: const ActorContext(role: MemberRole.child),
      );

      expect(message, isNull);
      final PointRecord record = store.records.first;
      expect(record.source, RecordSource.childSelf);
      expect(record.operatorRole, MemberRole.child);
      expect(record.subtitle.contains('家长'), isFalse);
      expect(record.subtitle.endsWith('· 自己完成'), isTrue);
      // subtitle 必须与派生函数一致，防止有人重新手写文案
      expect(
        record.subtitle,
        recordSubtitle(time: record.time, source: record.source),
      );
      expect(record.balanceAfter, 126);
      expect(record.habitId, habit.id);
    });

    test('撤销打卡写入冲正记录，原记录保留（修 B7 / I6）', () {
      final AppStore store = seededStore();
      final Habit habit = store.habits[2];
      store.checkIn(habit);
      final PointRecord origin = store.records.first;
      final int before = store.records.length;

      final String? message = store.undoCheckIn(habit);

      expect(message, isNull);
      expect(
        store.records.length,
        before + 1,
        reason: '撤销应新增冲正记录，而非物理删除（条数 +1）',
      );
      final PointRecord revert = store.records.first;
      expect(revert.source, RecordSource.correction);
      expect(revert.reversesRecordId, origin.id);
      expect(revert.points, -2);
      expect(
        store.records.where((PointRecord r) => r.id == origin.id).length,
        1,
        reason: '原记录不可被删除',
      );
      expect(store.points, 124);
    });

    test('扣分规则不能加入今天的习惯（修 A1，不再 abs 成加分）', () {
      final AppStore store = seededStore();
      store.addRule(
        title: '打人',
        condition: '不可以打人',
        dailyLimit: 1,
        points: -3,
        icon: Icons.warning_amber_rounded,
        color: Colors.red,
      );
      final int before = store.habits.length;

      final String? message = store.addHabitFromRule(store.rules.first);

      expect(message, isNotNull, reason: '应返回拒绝原因');
      expect(store.habits.length, before, reason: '扣分规则不得生成习惯');
      expect(store.habits.any((Habit h) => h.points < 0), isFalse);
    });

    test('balanceAfter 余额链自洽（I2，按写入顺序）', () {
      final AppStore store = seededStore();
      store.checkIn(store.habits[2]);
      store.addQuickNote(delta: 3, reason: '家长奖励');
      store.undoCheckIn(store.habits[2]);

      final List<PointRecord> byInsertion =
          store.records.reversed.toList(growable: false);
      for (int i = 1; i < byInsertion.length; i++) {
        expect(
          byInsertion[i].balanceAfter,
          byInsertion[i - 1].balanceAfter + byInsertion[i].points,
          reason: '余额链断裂于「${byInsertion[i].title}」',
        );
      }
      expect(store.records.first.balanceAfter, store.points);
    });

    test('release 构建下不允许恢复演示数据（修 E18）', () {
      // 判据层：release 必须被拒 —— 不依赖「测试恰好跑在 debug」这个巧合
      expect(demoResetAllowed(isRelease: true), isFalse, reason: 'release / profile 构建必须禁止');
      expect(demoResetAllowed(isRelease: false), isTrue, reason: '调试构建可用');
      // 编译期常量与判据必须表达同一语义（两处漂移即红）
      expect(allowDemoReset, demoResetAllowed(), reason: 'const 闸门与纯函数判据不得漂移');

      final AppStore store = seededStore();
      store.checkIn(store.habits[2]);
      expect(store.points, 126);

      expect(store.resetToSeed(), allowDemoReset);
      if (allowDemoReset) {
        expect(store.points, 124, reason: '恢复后回到演示数据');
      } else {
        expect(store.points, 126, reason: '被拒绝时数据不受影响');
      }
    });
  });

  group('首启空态（修 E18）', () {
    test('首启为空态：不预置任何演示数据', () {
      final AppStore store = AppStore();

      expect(store.points, 0, reason: '首启不得预置 124 分假数据');
      expect(store.profile.name, isEmpty, reason: '首启不得有假昵称');
      expect(store.profile.goodHabitCount, 0, reason: '首启不得声称完成过 324 个好习惯');
      expect(store.profile.rewardCount, 0);
      expect(store.habits, isEmpty);
      expect(store.wishes, isEmpty);
      expect(store.records, isEmpty);
      expect(store.rules, isEmpty);
    });

    test('空态下各入口可用，且演示数据只能显式载入', () {
      final AppStore store = AppStore();

      // 首启用户第一眼就是空态：查询与写入都不能崩
      expect(store.recordsOf(null), isEmpty);
      expect(store.addQuickNote(delta: 2, reason: '开局奖励'), isNull);
      expect(store.points, 2);
      expect(store.records.single.balanceAfter, 2, reason: '空态起步的余额链必须自洽');

      // 演示数据仍在，但它是「一次显式操作」，不是首启默认值
      expect(store.resetToSeed(), allowDemoReset);
      if (allowDemoReset) {
        expect(store.points, 124, reason: '显式载入后回到演示数据');
        expect(store.habits.length, 3);
      }
    });
  });

  group('频次结构字段与派生状态（修 A2 / A3 / E15 / E17）', () {
    test('演示数据只带结构字段，展示串一律派生（修 A2 / E17）', () {
      final AppStore store = seededStore();

      expect(
        store.habits.map((Habit h) => h.dailyLimit).toList(),
        <int>[2, 1, 1],
      );
      expect(
        store.rules.map((PointRule r) => r.dailyLimit).toList(),
        <int>[2, 1, 1, 1],
      );
      // checked / limitText / doneText 已不是字段 —— 这里能编译过本身就是证据
      expect(habitView(store.habits.first, store.records).limitText, '每天最多 2 次');
      expect(habitView(store.habits.first, store.records).doneText, '今日已完成 1 次');
    });

    test('「每天最多 2 次」真的可以打卡 2 次，第 3 次才被拦（修 A3）', () {
      final AppStore store = seededStore();
      final Habit pomodoro = store.habits.first;

      final HabitView before = habitView(pomodoro, store.records);
      expect(before.checkedCountToday, 1);
      expect(before.checked, isFalse, reason: '1 < 2：还没到上限，必须还能打卡');

      expect(store.checkIn(pomodoro), isNull, reason: '第 2 次打卡必须成功');

      final HabitView after = habitView(pomodoro, store.records);
      expect(after.checkedCountToday, 2);
      expect(after.doneText, '今日已完成 2 次');
      expect(after.checked, isTrue);
      expect(store.points, 125);

      expect(
        store.checkIn(pomodoro),
        '“番茄钟写作业”今天已经完成 2 次啦，明天继续加油～',
      );
      expect(store.records.length, 5, reason: '被拦时不写流水');

      expect(
        habitView(store.habits[1], store.records).checked,
        isTrue,
        reason: '每天 1 次的习惯 1 次即到上限',
      );
    });

    test('已打卡次数由当天流水派生，被冲正的原记录不再计入（修 A3）', () {
      final AppStore store = seededStore();
      final Habit reading = store.habits[2];

      expect(habitView(reading, store.records).doneText, '今日已完成 0 次');
      expect(habitView(reading, store.records).limitText, '每天 1 次');

      expect(store.checkIn(reading), isNull);
      expect(habitView(reading, store.records).checkedCountToday, 1);

      expect(store.undoCheckIn(reading), isNull);
      expect(
        habitView(reading, store.records).checkedCountToday,
        0,
        reason: '被冲正的原记录不得再计入（否则撤销后仍显示已打卡）',
      );
      expect(habitView(reading, store.records).checked, isFalse);
      expect(store.checkIn(reading), isNull, reason: '撤销后应当可以重新打卡');
    });

    test('展示串由结构字段派生，结构字段是唯一真相（修 E15 / E17）', () {
      expect(limitTextOf(1), '每天 1 次');
      expect(limitTextOf(2), '每天最多 2 次');
      expect(doneTextOf(0), '今日已完成 0 次');
      expect(doneTextOf(3), '今日已完成 3 次');

      final AppStore store = seededStore();
      store.addRule(
        title: '练琴',
        condition: '连续 3 天',
        dailyLimit: 1,
        points: 4,
        icon: Icons.music_note_rounded,
        color: Colors.amber,
      );
      expect(store.rules.first.condition, '连续 3 天', reason: '条件不被 split 切碎');
      expect(ruleDetail(store.rules.first), '连续 3 天 · 每天 1 次');
    });

    test('频次越界被拒绝（1–5 的整数），且不写规则（修 A2）', () {
      final AppStore store = seededStore();
      for (final int bad in <int>[0, 6, -1]) {
        expect(
          store.addRule(
            title: '越界频次',
            condition: '条件',
            dailyLimit: bad,
            points: 1,
            icon: Icons.star_rounded,
            color: Colors.amber,
          ),
          isNotNull,
          reason: 'dailyLimit=$bad 应被拒绝',
        );
      }
      expect(store.rules.length, 4, reason: '被拒绝时不写规则');
      expect(isDailyLimitValid(dailyLimitMax), isTrue);
      expect(isDailyLimitValid(dailyLimitMax + 1), isFalse);
    });
  });

  group('心愿配色稳定枚举（修 E16）', () {
    test('删项不让其余心愿换色，新增先补空档', () {
      final AppStore store = seededStore();
      expect(
        store.wishes.map((Wish w) => w.coverStyle).toList(),
        <WishCoverStyle>[
          WishCoverStyle.a,
          WishCoverStyle.b,
          WishCoverStyle.c,
          WishCoverStyle.d,
        ],
        reason: '演示数据显式声明配色，不靠数组下标',
      );

      // 删掉中间的 b：其余心愿的配色一个都不许变
      store.removeWish(store.wishes[1]);
      expect(
        store.wishes.map((Wish w) => w.coverStyle).toList(),
        <WishCoverStyle>[
          WishCoverStyle.a,
          WishCoverStyle.c,
          WishCoverStyle.d,
        ],
        reason: '删项不得让其余心愿换色',
      );

      // 新增：应补回空出来的 b，而不是按 wishes.length % 4 又算成别的
      store.addWish(title: '新心愿', cost: 10, emoji: '🎁');
      expect(store.wishes.first.coverStyle, WishCoverStyle.b,
          reason: '有空档先补空档');
    });

    test('四个占满时由 id 稳定派生，期望值与 Taro 侧一致（跨端同源）', () {
      expect(pickCoverStyle(wishCoverStyles, 'wish-9'), WishCoverStyle.c);
      expect(pickCoverStyle(wishCoverStyles, 'wish-9'), WishCoverStyle.c,
          reason: '同 id 永远同色');
      expect(wishCoverHash('wish-9'), 355514,
          reason: '哈希算式被钉死：改了就会让既有心愿换色');
    });

    test('卡片按稳定枚举取色，不再有数组下标', () {
      expect(wishGradientOf(WishCoverStyle.a).first, const Color(0xFFFFF8E6));
      expect(wishGradientOf(WishCoverStyle.d).last, const Color(0xFFF8D9CE));
      expect(
        wishGradientOf(WishCoverStyle.a),
        isNot(equals(wishGradientOf(WishCoverStyle.b))),
        reason: '不同枚举取值必须取到不同底色',
      );
    });
  });

  group('界面冒烟测试', () {
    Future<void> pumpApp(WidgetTester tester, AppStore store) async {
      tester.view.physicalSize = const Size(1200, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(PointsApp(store: store));
      await tester.pumpAndSettle();
    }

    testWidgets('首启空态不崩：0 分 0 习惯也能渲染首页', (WidgetTester tester) async {
      final AppStore store = AppStore();
      await pumpApp(tester, store);

      expect(store.points, 0);
      expect(find.text('当前可用积分'), findsWidgets);
      expect(find.text('今天的习惯'), findsOneWidget);
      expect(find.textContaining('已完成 0/0'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('首页展示积分、习惯与记一笔', (WidgetTester tester) async {
      await pumpApp(tester, seededStore());

      expect(find.text('当前可用积分'), findsWidgets);
      expect(find.text('今天的习惯'), findsOneWidget);
      expect(find.text('番茄钟写作业'), findsWidgets);
      expect(find.text('记一笔'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('心愿单展示心愿卡片与新增心愿', (WidgetTester tester) async {
      await pumpApp(tester, seededStore());

      // 心愿单在 IndexedStack 里，切到这一页才“onstage”，查找才能命中。
      await tester.tap(find.text('心愿单'));
      await tester.pumpAndSettle();

      expect(find.text('甜的心愿单'), findsOneWidget);
      expect(find.text('兑换'), findsWidgets);
      expect(find.text('还差 321'), findsWidgets);
      expect(find.text('新增心愿'), findsOneWidget);

      // 设计稿 header：标题右侧是「编辑」图标，右侧的当前可用积分为绿色。
      final Finder screen = find.byType(WishlistScreen);
      final Icon editIcon = tester.widget<Icon>(
        find.descendant(of: screen, matching: find.byIcon(Icons.edit_rounded)),
      );
      expect(editIcon.color, AppColors.starYellow);

      final Text pointsText = tester.widget<Text>(
        find.descendant(of: screen, matching: find.text('124')),
      );
      expect(pointsText.style?.color, AppColors.pointGain);

      // 标题栏在滚动区域“上方”，不是压在列表上的浮层：标题与第一张心愿卡不重叠。
      final Rect titleRect = tester.getRect(find.text('甜的心愿单'));
      final Rect firstCardRect = tester.getRect(find.byType(WishCard).first);
      expect(titleRect.top, greaterThan(0));
      expect(firstCardRect.top, greaterThanOrEqualTo(titleRect.bottom));
      expect(tester.takeException(), isNull);
    });

    testWidgets('新增心愿默认收在右下角，滚到底部后展开成整行按钮', (WidgetTester tester) async {
      final AppStore store = seededStore();
      for (int i = 0; i < 6; i++) {
        store.addWish(title: '测试心愿 $i', cost: 10 + i, emoji: '🎁');
      }
      await pumpApp(tester, store);
      await tester.tap(find.text('心愿单'));
      await tester.pumpAndSettle();

      final Finder button = find.byType(FloatingAddButton);
      final ScrollableState scrollable = tester.state(
        find
            .descendant(
              of: find.byType(WishlistScreen),
              matching: find.byType(Scrollable),
            )
            .first,
      );

      // 列表还很长 → 收成右下角的圆形悬浮按钮。
      expect(scrollable.position.maxScrollExtent, greaterThan(0));
      expect(tester.getSize(button).width, 52);
      expect(tester.getSize(button).height, 52);

      // 滚到底部 → 展开成整行胶囊按钮（宽度为页面宽度减去左右各 20）。
      scrollable.position.jumpTo(scrollable.position.maxScrollExtent);
      await tester.pumpAndSettle();
      expect(tester.getSize(button).width, moreOrLessEquals(360, epsilon: 0.5));
      expect(tester.getSize(button).height, 52);

      // 再滚回顶部 → 又会收回右下角。
      scrollable.position.jumpTo(0);
      await tester.pumpAndSettle();
      expect(tester.getSize(button).width, 52);

      // 悬浮按钮本身依然可以点到，并且能弹出“新增心愿”弹窗。
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(find.text('心愿名称'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('点击习惯卡片即可打卡加分', (WidgetTester tester) async {
      final AppStore store = seededStore();
      await pumpApp(tester, store);
      expect(store.points, 124);

      await tester.tap(find.text('自主阅读'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(store.points, 126);
      expect(find.textContaining('+2 积分'), findsWidgets);
      // 让 SnackBar 自动关闭，避免留下未完成的定时器
      await tester.pumpAndSettle(const Duration(seconds: 5));
    });
  });
}
