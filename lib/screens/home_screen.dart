import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../models/habit.dart';
import '../theme/app_colors.dart';
import '../widgets/animated_point_text.dart';
import '../widgets/gradient_page.dart';
import '../widgets/habit_tile.dart';
import '../widgets/page_header.dart';
import '../widgets/points_jar.dart';
import '../widgets/soft_button.dart';
import 'sheets/quick_note_sheet.dart';

/// 首页：当前可用积分 + 积分罐 + 今天的习惯 + 记一笔。
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    final int doneCount =
        store.habits.where((Habit habit) => habit.checked).length;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
          children: <Widget>[
            const Text(
              '当前可用积分',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 13.5,
                color: AppColors.textSecondary,
                letterSpacing: 0.4,
              ),
            ),
            const SizedBox(height: 4),
            Center(
              child: AnimatedPointText(
                value: store.points,
                style: const TextStyle(
                  fontSize: 46,
                  fontWeight: FontWeight.w800,
                  height: 1.06,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
            Center(child: PointsJar(width: 168)),
            const SizedBox(height: 20),
            SectionTitle(
              title: '今天的习惯',
              trailing: Text(
                '已完成 $doneCount/${store.habits.length}',
                style: const TextStyle(
                  fontSize: 11.5,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
            ...store.habits.map(
              (Habit habit) => HabitTile(
                habit: habit,
                onTap: () {
                  final String? message = store.checkIn(habit);
                  messenger.hideCurrentSnackBar();
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text(
                        message ?? '太棒了！“${habit.title}”+${habit.points} 积分',
                      ),
                    ),
                  );
                },
                onLongPress: () {
                  // 修 B7：撤销改为写入一条冲正流水（原记录保留），失败时给出可读原因
                  final String? message = store.undoCheckIn(habit);
                  messenger.hideCurrentSnackBar();
                  messenger.showSnackBar(
                    SnackBar(
                      content: Text(message ?? '已撤销“${habit.title}”的打卡'),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 10),
            SoftButton(
              label: '记一笔',
              icon: Icons.edit_note_rounded,
              onTap: () => showQuickNoteSheet(context),
            ),
            const SizedBox(height: 10),
            const Center(
              child: Text(
                '点习惯卡片打卡 · 长按可撤销',
                style: TextStyle(fontSize: 11, color: AppColors.textHint),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
