import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../theme/app_colors.dart';
import '../widgets/app_card.dart';
import '../widgets/gradient_page.dart';
import 'points_record_screen.dart';
import 'points_rule_screen.dart';
import 'sheets/trash_sheet.dart';

/// 我的：孩子档案 + 好习惯/奖励次数战绩 + 积分记录 / 积分规则入口。
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    // 修 C9：回收站入口固定在“我的”页（两端同一处）—— 入口上直接显示待处理条数。
    final int trashCount = store.trashItems().length;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

    // live 模式只有读端点：本地改名 / 回收站 / 恢复演示数据都不会写回服务器。
    // 统一提示，而不是让用户以为「改成功了，只是服务器没同步」。
    bool guardReadOnly() {
      if (!store.isReadOnly) return false;
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text(store.readOnlyWriteMessage)),
      );
      return true;
    }

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 22, 20, 28),
          children: <Widget>[
            Row(
              children: <Widget>[
                GestureDetector(
                  onTap: () {
                    if (guardReadOnly()) return;
                    _renameChild(context, store);
                  },
                  child: Container(
                    width: 62,
                    height: 62,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: const LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: <Color>[AppColors.cream, AppColors.creamDeep],
                      ),
                      border: Border.all(color: AppColors.primary, width: 2),
                    ),
                    child: const Center(
                      child: Text('🧒', style: TextStyle(fontSize: 30)),
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        store.profile.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 6),
                      GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () {
                          Clipboard.setData(
                            ClipboardData(text: store.profile.childId),
                          );
                          messenger.showSnackBar(
                            const SnackBar(content: Text('已复制孩子 ID')),
                          );
                        },
                        child: Row(
                          children: <Widget>[
                            Text(
                              'ID:${store.profile.childId}',
                              style: const TextStyle(
                                fontSize: 11.5,
                                color: AppColors.textSecondary,
                              ),
                            ),
                            const SizedBox(width: 6),
                            const Icon(
                              Icons.content_copy_rounded,
                              size: 13,
                              color: AppColors.textHint,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            _StatsCard(
              goodHabitCount: store.profile.goodHabitCount,
              rewardCount: store.profile.rewardCount,
            ),
            const SizedBox(height: 16),
            AppCard(
              radius: 20,
              padding: EdgeInsets.zero,
              child: Column(
                children: <Widget>[
                  _MenuRow(
                    icon: Icons.menu_book_rounded,
                    color: AppColors.primaryDeep,
                    label: '积分记录',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const PointsRecordScreen(),
                      ),
                    ),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.emoji_events_rounded,
                    color: AppColors.starYellow,
                    label: '积分规则',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const PointsRuleScreen(),
                      ),
                    ),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.delete_outline_rounded,
                    color: AppColors.pointSpend,
                    label: trashCount > 0 ? '回收站（$trashCount）' : '回收站',
                    onTap: () {
                      // 回收站里的恢复 / 彻底删除都是写操作；live 模式下整入口拦截。
                      if (guardReadOnly()) return;
                      showTrashSheet(context);
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 22),
            // 修 E18：生产构建下整个入口不渲染，避免暴露“清空真实数据”的能力
            if (allowDemoReset)
              Center(
                child: TextButton(
                  onPressed: () {
                    if (guardReadOnly()) return;
                    if (!store.resetToSeed()) {
                      messenger.showSnackBar(
                        const SnackBar(content: Text('正式环境不支持恢复演示数据')),
                      );
                      return;
                    }
                    messenger.showSnackBar(
                      const SnackBar(content: Text('已恢复演示数据')),
                    );
                  },
                  child: const Text(
                    '恢复演示数据',
                    style: TextStyle(
                      fontSize: 12.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _renameChild(BuildContext context, AppStore store) async {
    final TextEditingController controller =
        TextEditingController(text: store.profile.name);
    final String? name = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text('修改昵称'),
          content: TextField(
            controller: controller,
            autofocus: true,
            maxLength: 16,
            decoration: const InputDecoration(hintText: '输入新的昵称'),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(controller.text),
              child: const Text('保存'),
            ),
          ],
        );
      },
    );
    controller.dispose();
    if (name != null) store.renameChild(name);
  }
}

/// 战绩卡：好习惯累计 / 奖励次数。
class _StatsCard extends StatelessWidget {
  const _StatsCard({
    required this.goodHabitCount,
    required this.rewardCount,
  });

  final int goodHabitCount;
  final int rewardCount;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      radius: 20,
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Row(
        children: <Widget>[
          Expanded(child: _StatColumn(value: '$goodHabitCount', label: '好习惯')),
          Container(width: 1, height: 38, color: AppColors.divider),
          Expanded(child: _StatColumn(value: '$rewardCount', label: '奖励次数')),
        ],
      ),
    );
  }
}

class _StatColumn extends StatelessWidget {
  const _StatColumn({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Text(
          value,
          style: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w800,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            color: AppColors.textSecondary,
          ),
        ),
      ],
    );
  }
}

/// “积分记录 / 积分规则”入口行。
class _MenuRow extends StatelessWidget {
  const _MenuRow({
    required this.icon,
    required this.color,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final Color color;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
        child: Row(
          children: <Widget>[
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: color.withAlpha(34),
                borderRadius: BorderRadius.circular(11),
              ),
              child: Icon(icon, size: 19, color: color),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
            const Icon(
              Icons.chevron_right_rounded,
              size: 22,
              color: AppColors.textHint,
            ),
          ],
        ),
      ),
    );
  }
}
