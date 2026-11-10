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
    // 修 A2 / A3 / E17：首页消费**派生视图**（checked / limitText / doneText 都由
    // 结构字段 ＋ 当天流水现算），习惯上那些状态字段已不复存在。
    final List<HabitView> habits = store.habitViews;
    final int doneCount =
        habits.where((HabitView habit) => habit.checked).length;
    // 未完成 = 还没到今天的上限（1/2 的仍然算未完成，用户第 10 条）。
    final List<HabitView> pendingHabits =
        habits.where((HabitView habit) => !habit.checked).toList();
    final List<HabitView> doneHabits =
        habits.where((HabitView habit) => habit.checked).toList();

    // 2026-11-10：孩子模式 / 家长模式的倒计时与状态已移到**抬头栏**
    // （`HomeShell` → `widgets/parent_mode_banner.dart`，四个 tab 都看得到）。
    // 首页不再重复画一条 `KidModeBanner` —— 两行同样的字只会让人以为出了两次状态。

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: RefreshIndicator(
          color: AppColors.primaryDeep,
          onRefresh: store.refreshFromServer,
          child: ListView(
            // 内容比屏幕短时也要能下拉刷新（否则空态/一条记录时刷新手势无效）。
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 28),
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
              const Center(child: PointsJar(width: 168)),
              const SizedBox(height: 20),
              // 2026-11-10（用户第 10 条）：「可以完成两次的任务，把已完成和未完成
              // 分开显示」。分组判据是**达上限**（`checked`），不是「打过一次」——
              // 1/2 的任务必须留在「未完成」里，否则家长会以为它今天做完了。
              SectionTitle(
                title: '今天的习惯',
                trailing: Text(
                  '已完成 $doneCount/${habits.length}',
                  style: const TextStyle(
                    fontSize: 11.5,
                    color: AppColors.textSecondary,
                  ),
                ),
              ),
              if (pendingHabits.isEmpty && doneHabits.isNotEmpty)
                const Padding(
                  padding: EdgeInsets.only(bottom: 12),
                  child: Text(
                    '今天的习惯都完成了 🎉',
                    style: TextStyle(
                      fontSize: 12.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
              ...pendingHabits.map(
                (HabitView habit) => _tile(habit, store, messenger),
              ),
              if (doneHabits.isNotEmpty) ...<Widget>[
                const SizedBox(height: 4),
                SectionTitle(
                  title: '已完成',
                  trailing: Text(
                    '${doneHabits.length} 项',
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
                ...doneHabits.map(
                  (HabitView habit) => _tile(habit, store, messenger),
                ),
              ],
              const SizedBox(height: 10),
              SoftButton(
                label: '记一笔',
                icon: Icons.edit_note_rounded,
                onTap: () {
                  if (store.isAdjustReadOnly) {
                    messenger.hideCurrentSnackBar();
                    messenger.showSnackBar(
                      SnackBar(content: Text(store.adjustReadOnlyWriteMessage)),
                    );
                    return;
                  }
                  showQuickNoteSheet(context);
                },
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
      ),
    );
  }

  /// 一张习惯卡（未完成 / 已完成两组共用）。
  ///
  /// ── 撤销后的提示为什么要带进度（用户第 12 条）────────────────────────────
  ///   旧提示只说「已撤销」，而 1/2 的任务撤销后卡片**看起来没变**
  ///   （`checked` 只在达上限时才变）—— 于是被读成「撤销没生效」。
  ///   现在撤销成功后再取一次派生视图，把 `今日已完成 N/M` 写进同一句提示。
  Widget _tile(
    HabitView habit,
    AppStore store,
    ScaffoldMessengerState messenger,
  ) {
    return HabitTile(
      habit: habit,
      onTap: () async {
        // live 模式走服务端写入口；预览模式由 store 回落到本地写。
        // 视图是快照，取回习惯本身交给 store（Dart 没有 TS 的结构类型兼容）
        final String? message = await store.submitCheckIn(habit.habit);
        if (!messenger.mounted) return;
        messenger.hideCurrentSnackBar();
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              message ?? '太棒了！“${habit.title}”+${habit.points} 积分',
            ),
          ),
        );
      },
      onLongPress: () async {
        // 修 B7：撤销改为写入一条冲正流水（原记录保留），失败时给出可读原因
        final String? message = await store.submitUndoCheckIn(habit.habit);
        if (!messenger.mounted) return;
        final HabitView after = store.habitViewOf(habit.habit);
        messenger.hideCurrentSnackBar();
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              message ?? '已撤销“${habit.title}”的打卡（${after.progressText}）',
            ),
          ),
        );
      },
    );
  }
}
