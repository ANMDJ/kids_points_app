import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../models/point_rule.dart';
import '../../theme/app_colors.dart';
import '../../widgets/form_fields.dart';
import '../../widgets/points_stepper.dart';
import '../../widgets/segmented_toggle.dart';
import '../../widgets/sheet_frame.dart';

/// “新增规则”：约定做到什么、得几分（也可约定扣分）。
Future<void> showAddRuleSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return AddRuleSheet(store: store, messenger: messenger);
    },
  );
}

class AddRuleSheet extends StatefulWidget {
  final AppStore store;
  final ScaffoldMessengerState messenger;

  const AddRuleSheet({
    required this.store,
    required this.messenger,
  });

  @override
  State<StatefulWidget> createState() {
    return _AddRuleSheetState();
  }
}

class _AddRuleSheetState extends State<AddRuleSheet> {
  final TextEditingController titleController = TextEditingController();
  final TextEditingController detailController = TextEditingController();
  bool isGain = true;
  int amount = 2;
  int iconIndex = 0;
  @override
  void dispose() {
    titleController.dispose();
    detailController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StatefulBuilder(
      builder: (BuildContext sheetContext, StateSetter setSheetState) {
        return SheetFrame(
          title: '新增规则',
          subtitle: '规则会出现在积分规则页，也可以加入今天的习惯',
          actionLabel: '保存规则',
          actionIcon: Icons.check_rounded,
          onAction: () {
            final String title = titleController.text.trim();
            if (title.isEmpty) {
              widget.messenger.showSnackBar(
                const SnackBar(content: Text('规则名称不能为空哦')),
              );
              return;
            }
            final IconOption option = ruleIconOptions[iconIndex];
            widget.store.addRule(
              title: title,
              detail: detailController.text,
              points: isGain ? amount : -amount,
              icon: option.icon,
              color: option.color,
            );
            Navigator.of(sheetContext).pop();
            widget.messenger.showSnackBar(
              SnackBar(
                content: Text(
                  '已新增规则：$title（${isGain ? '+' : '-'}$amount 积分）',
                ),
              ),
            );
          },
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const FieldLabel('规则名称'),
              SoftTextField(
                controller: titleController,
                hint: '例如：每天练琴 30 分钟',
              ),
              const SizedBox(height: 14),
              const FieldLabel('细则（会显示在名称下方）'),
              SoftTextField(
                controller: detailController,
                hint: '例如：认真练习不断开 · 每天 1 次',
              ),
              const SizedBox(height: 16),
              const FieldLabel('积分方向'),
              SegmentedToggle(
                leftLabel: '奖励加分',
                rightLabel: '扣分提醒',
                leftSelected: isGain,
                onChanged: (bool value) => setSheetState(() => isGain = value),
              ),
              const SizedBox(height: 14),
              PointsStepper(
                value: amount,
                min: 1,
                max: 999,
                onChanged: (int value) => setSheetState(() => amount = value),
              ),
              const SizedBox(height: 14),
              const FieldLabel('选择图标'),
              IconPicker(
                selectedIndex: iconIndex,
                onSelected: (int index) =>
                    setSheetState(() => iconIndex = index),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 长按规则：加入今天的习惯 / 删除规则。
Future<void> showRuleActionsSheet(BuildContext context, PointRule rule) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return SheetFrame(
        title: rule.title,
        subtitle: rule.detail,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _ActionRow(
              icon: Icons.playlist_add_check_rounded,
              label: '加入今天的习惯',
              onTap: () {
                // 修 A1：扣分规则不能生成可打卡习惯（原先 abs 会把扣分变成加分），
                // 被拒绝时必须把原因告诉家长（禁止静默失败）
                final String? message = store.addHabitFromRule(rule);
                if (message != null) {
                  messenger.showSnackBar(SnackBar(content: Text(message)));
                  return;
                }
                Navigator.of(sheetContext).pop();
                messenger.showSnackBar(
                  SnackBar(content: Text('“${rule.title}”已加入首页习惯')),
                );
              },
            ),
            const SizedBox(height: 10),
            _ActionRow(
              icon: Icons.delete_outline_rounded,
              label: '删除这条规则',
              danger: true,
              onTap: () {
                store.removeRule(rule);
                Navigator.of(sheetContext).pop();
                messenger.showSnackBar(const SnackBar(content: Text('规则已删除')));
              },
            ),
          ],
        ),
      );
    },
  );
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.icon,
    required this.label,
    required this.onTap,
    this.danger = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final Color color = danger ? AppColors.pointSpend : AppColors.primaryText;
    return Material(
      color: danger ? const Color(0xFFFDF1E9) : AppColors.primarySoft,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
          child: Row(
            children: <Widget>[
              Icon(icon, size: 20, color: color),
              const SizedBox(width: 10),
              Text(
                label,
                style: TextStyle(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                  color: color,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
