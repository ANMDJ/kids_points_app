import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../models/habit.dart';

import '../../models/point_rule.dart';
import '../../models/rule_version.dart';
import '../../theme/app_colors.dart';
import '../../widgets/form_fields.dart';
import '../../widgets/points_stepper.dart';
import '../../widgets/segmented_toggle.dart';
import '../../widgets/sheet_frame.dart';

/// “新增 / 编辑规则”：约定做到什么、得几分（也可约定扣分）。
///
/// 传了 [rule] 即为**编辑态**（同一张表单，修 C10）；不传则是新增。
/// 编辑态下 `id` 不变、`currentVersion` 由 store 递增 —— 界面不做版本运算。
Future<void> showAddRuleSheet(BuildContext context, {PointRule? rule}) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return AddRuleSheet(store: store, messenger: messenger, rule: rule);
    },
  );
}

class AddRuleSheet extends StatefulWidget {
  final AppStore store;
  final PointRule? rule;
  final ScaffoldMessengerState messenger;

  const AddRuleSheet({
    required this.store,
    required this.messenger,
    this.rule,
  });

  @override
  State<StatefulWidget> createState() {
    return _AddRuleSheetState();
  }
}

class _AddRuleSheetState extends State<AddRuleSheet> {
  // 编辑态回填：`late` 让初始化推迟到 `widget` 可用之后（State 构造时还没有 widget）。
  late final TextEditingController titleController = TextEditingController(
    text: widget.rule?.title ?? '',
  );
  // 修 E15：表单收集的是**结构字段**（条件 + 每日次数），不再是「细则」自由串
  late final TextEditingController conditionController = TextEditingController(
    text: widget.rule?.condition ?? '',
  );
  late bool isGain = (widget.rule?.points ?? 1) >= 0;
  late int amount = widget.rule == null ? 2 : widget.rule!.points.abs();
  late int dailyLimit = widget.rule?.dailyLimit ?? 1;
  /// 选中的图标下标（修 D9：图标只在新建时选择，编辑态不显示选择器）
  int iconIndex = 0;
  @override
  void dispose() {
    titleController.dispose();
    conditionController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StatefulBuilder(
      builder: (BuildContext sheetContext, StateSetter setSheetState) {
        return SheetFrame(
          title: widget.rule == null ? '新增规则' : '编辑规则',
          subtitle: '规则会出现在积分规则页，也可以加入今天的习惯',
          actionLabel: '保存规则',
          actionIcon: Icons.check_rounded,
          onAction: () async {
            final String title = titleController.text.trim();
            if (title.isEmpty) {
              widget.messenger.showSnackBar(
                const SnackBar(content: Text('规则名称不能为空哦')),
              );
              return;
            }
            if (widget.rule != null) {
              final PointRule rule = widget.rule!;
              // 修 C10（§3.3）：改动后若“今天已打卡数 ≥ 新上限”，**必须**告知家长
              // 今天不能再打卡了 —— 否则改完规则孩子打不了卡，却不知原因。
              // 文案由纯函数 ruleChangeNotice 派生（写在界面里的文案测不到）。
              final String? notice = ruleChangeNotice(
                childName: widget.store.profile.name,
                checkedCountToday: widget.store.checkedCountTodayOfRule(rule),
                newDailyLimit: dailyLimit,
              );
              final String? message = await widget.store.submitUpdateRule(
                rule,
                title: title,
                condition: conditionController.text,
                dailyLimit: dailyLimit,
                points: isGain ? amount : -amount,
              );
              if (!sheetContext.mounted) return;
              if (message != null) {
                widget.messenger.showSnackBar(SnackBar(content: Text(message)));
                return;
              }
              Navigator.of(sheetContext).pop();
              widget.messenger.showSnackBar(
                SnackBar(
                  content: Text(
                    notice ?? '已更新规则：$title（第 ${rule.currentVersion + 1} 版）',
                  ),
                ),
              );
              return;
            }
            final IconOption option = ruleIconOptions[iconIndex];
            final String? message = await widget.store.submitAddRule(
              title: title,
              condition: conditionController.text,
              dailyLimit: dailyLimit,
              points: isGain ? amount : -amount,
              // 修 D9：传的是**图标名字**（白名单校验在 store 里，越界即拒）
              iconName: option.name,
              color: option.color,
            );
            if (!sheetContext.mounted) return;
            if (message != null) {
              // 修 A2：频次越界被拒绝时必须说明原因（禁止静默失败）
              widget.messenger.showSnackBar(SnackBar(content: Text(message)));
              return;
            }
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
              const FieldLabel('达成条件（会显示在名称下方）'),
              SoftTextField(
                controller: conditionController,
                hint: '例如：认真练习不断开',
              ),
              const SizedBox(height: 14),
              // 修 A2 / E15：频次是可运算的结构字段，不再让家长手打「每天 1 次」这种展示串
              const FieldLabel('每天最多几次'),
              PointsStepper(
                value: dailyLimit,
                min: dailyLimitMin,
                max: dailyLimitMax,
                suffix: '次/天',
                onChanged: (int value) =>
                    setSheetState(() => dailyLimit = value),
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
              // 修 D9：图标只在**新建**时选择 —— 编辑态不再显示这个「选了也不生效」的选择器。
              // 原因：图标是创建时写入的字段，而 `updateRule` 的版本快照（`RuleVersion`）
              // 里没有图标字段 —— 允许「改了但不入版本」会让「第 N 版规则长什么样」缺一块
              // （C10 的语义要求版本快照完整）。要让编辑也能改图标，得先把 iconName 纳入
              // 版本快照（契约扩展），本轮不做，见 `docs/design/03` §D9 现状。
              if (widget.rule == null) ...<Widget>[
                const SizedBox(height: 14),
                const FieldLabel('选择图标'),
                IconPicker(
                  selectedIndex: iconIndex,
                  onSelected: (int index) =>
                      setSheetState(() => iconIndex = index),
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// 长按规则：编辑规则 / 加入今天的习惯 / 移到回收站。
Future<void> showRuleActionsSheet(
  BuildContext context,
  PointRule rule, {
  /// 点“编辑这条规则”：由页面负责收起本菜单并打开编辑态表单（修 C10）
  VoidCallback? onEdit,
}) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  // 这条规则**当前**生成的习惯（没有就是还没加入，或已经被移出到回收站）。
  // 首页习惯是独立实体（A1），删规则不会连带删习惯 —— 所以这里要单独给出口。
  Habit? habitFromRule;
  for (final Habit habit in store.habits) {
    if (habit.ruleId == rule.id) {
      habitFromRule = habit;
      break;
    }
  }

  await showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      // 提升成 final：闭包里用可空可变局部变量不会被流分析提升。
      final Habit? habit = habitFromRule;
      return SheetFrame(
        title: rule.title,
        subtitle: ruleDetail(rule),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _ActionRow(
              icon: Icons.edit_rounded,
              label: '编辑这条规则（当前第 ${rule.currentVersion} 版）',
              onTap: () {
                Navigator.of(sheetContext).pop();
                if (onEdit != null) onEdit();
              },
            ),
            const SizedBox(height: 10),
            _ActionRow(
              icon: Icons.playlist_add_check_rounded,
              label: '加入今天的习惯',
              onTap: () async {
                // 修 A1：扣分规则不能生成可打卡习惯（原先 abs 会把扣分变成加分），
                // 被拒绝时必须把原因告诉家长（禁止静默失败）。
                // live 模式走 POST /point-rules/:id/habits，判重由服务端按
                // sourceRuleId 做（改过标题也不会重复生成）。
                final String? message =
                    await store.submitAddHabitFromRule(rule);
                if (!sheetContext.mounted) return;
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
            if (habit != null) ...<Widget>[
              _ActionRow(
                icon: Icons.remove_circle_outline_rounded,
                label: '把“${habit.title}”移出首页习惯',
                danger: true,
                onTap: () async {
                  // 修 C9 / W5-F：首页习惯也是**软删**（进回收站 90 天可恢复），
                  // 已发生的打卡流水继续带 habitId 回指，不会断链。
                  // live 模式走 DELETE /habits/:id；矩阵里孩子 DENY，服务端 403。
                  final String? message =
                      await store.submitRemoveHabit(habit);
                  if (!sheetContext.mounted) return;
                  if (message != null) {
                    messenger.showSnackBar(SnackBar(content: Text(message)));
                    return;
                  }
                  Navigator.of(sheetContext).pop();
                  messenger.showSnackBar(
                    const SnackBar(
                      content: Text('已移出首页习惯，90 天内可在「我的 · 回收站」恢复'),
                    ),
                  );
                },
              ),
              const SizedBox(height: 10),
            ],
            _ActionRow(
              icon: Icons.delete_outline_rounded,
              label: '移到回收站',
              danger: true,
              onTap: () async {
                // 修 C9：删除只改状态位（软删），规则留在数据里 90 天可恢复 ——
                // 历史流水的回指（ruleId / ruleVersion）因此不会指向空。
                // live 模式走 DELETE /point-rules/:id（服务端幂等）。
                final String? message = await store.submitRemoveRule(rule);
                if (!sheetContext.mounted) return;
                if (message != null) {
                  messenger.showSnackBar(SnackBar(content: Text(message)));
                  return;
                }
                Navigator.of(sheetContext).pop();
                messenger.showSnackBar(
                  const SnackBar(
                    content: Text('已移到回收站，90 天内可在「我的 · 回收站」恢复'),
                  ),
                );
              },
            ),
          ],
        ),
      );
    },
  );
}

/// 操作菜单里的一行（图标 + 文案）。
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
