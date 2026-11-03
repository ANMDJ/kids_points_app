import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../models/habit.dart';
import '../theme/app_colors.dart';
import '../widgets/animated_point_text.dart';
import '../widgets/gradient_page.dart';
import '../widgets/habit_tile.dart';
import '../widgets/kid_mode_banner.dart';
import '../widgets/page_header.dart';
import '../widgets/points_jar.dart';
import '../widgets/soft_button.dart';
import 'sheets/parent_mode_sheet.dart';
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

    // W14：孩子模式期间首页顶部常驻一条状态条。
    // ★ 这里**不**渲染倒计时：首页没有秒级刷新，写死的数字在切后台后会变成
    //   谎言。精确剩余时间在「家长模式」面板里（那里每秒重绘）。
    final DateTime now = DateTime.now();
    final bool kidModeExpired = store.isKidModeExpiredAt(now);
    final bool kidModeOn = kidModeExpired || store.isKidModeActiveAt(now);

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: RefreshIndicator(
          color: AppColors.primaryDeep,
          onRefresh: store.refreshFromServer,
          child: ListView(
            // 内容比屏幕短时也要能下拉刷新（否则空态/一条记录时刷新手势无效）。
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
            children: <Widget>[
              if (kidModeOn) ...<Widget>[
                KidModeBanner(
                  expired: kidModeExpired,
                  onTap: () => showParentModeSheet(context),
                ),
                const SizedBox(height: 14),
              ],
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
              ...habits.map(
                (HabitView habit) => HabitTile(
                  habit: habit,
                  onTap: () async {
                    // live 模式走服务端写入口；预览模式由 store 回落到本地写。
                    // 视图是快照，取回习惯本身交给 store（Dart 没有 TS 的结构类型兼容）
                    final String? message =
                        await store.submitCheckIn(habit.habit);
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
                    final String? message =
                        await store.submitUndoCheckIn(habit.habit);
                    if (!messenger.mounted) return;
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
}
