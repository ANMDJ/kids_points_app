import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../widgets/form_fields.dart';
import '../../widgets/pills.dart';
import '../../widgets/points_stepper.dart';
import '../../widgets/segmented_toggle.dart';
import '../../widgets/sheet_frame.dart';

const List<String> _quickReasons = <String>[
  '主动帮忙做家务',
  '自主阅读',
  '按时起床',
  '主动整理房间',
  '顶嘴 / 发脾气',
];

const List<int> _quickAmounts = <int>[1, 2, 5, 10];

/// “记一笔”：家长手动加/减分。
Future<void> showQuickNoteSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return QuickNoteSheet(store: store, messenger: messenger);
    },
  );
}

class QuickNoteSheet extends StatefulWidget {
  final AppStore store;
  final ScaffoldMessengerState messenger;

  const QuickNoteSheet({required this.store, required this.messenger});

  @override
  State<StatefulWidget> createState() {
    return _QuickNoteSheetState();
  }
}

class _QuickNoteSheetState extends State<QuickNoteSheet> {
  final TextEditingController reasonController = TextEditingController();
  bool isGain = true;
  int amount = 1;
  String selectedReason = '';

  @override
  void dispose() {
    reasonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StatefulBuilder(
      builder: (BuildContext sheetContext, StateSetter setSheetState) {
        final int delta = isGain ? amount : -amount;
        return SheetFrame(
          title: '记一笔',
          subtitle: '家长手动加分或扣分，孩子立刻能看到',
          actionLabel: '保存（${delta > 0 ? '+' : ''}$delta 积分）',
          actionIcon: Icons.check_rounded,
          onAction: () {
            final String typed = reasonController.text.trim();
            final String reason = selectedReason.isNotEmpty
                ? (typed.isEmpty ? selectedReason : '$selectedReason（$typed）')
                : (typed.isEmpty ? '额外调整' : typed);
            final String? message =
                widget.store.addQuickNote(delta: delta, reason: reason);
            if (message != null) {
              // 修 B6：超额扣分会被拒绝，必须把原因告诉家长（禁止静默失败）
              widget.messenger.showSnackBar(SnackBar(content: Text(message)));
              return;
            }
            Navigator.of(sheetContext).pop();
            widget.messenger.showSnackBar(
              SnackBar(
                content: Text(
                  delta > 0
                      ? '已加 $delta 积分：$reason'
                      : '已扣 ${delta.abs()} 积分：$reason',
                ),
              ),
            );
          },
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              SegmentedToggle(
                leftLabel: '奖励加分',
                rightLabel: '扣分提醒',
                leftSelected: isGain,
                onChanged: (bool value) => setSheetState(() => isGain = value),
              ),
              const SizedBox(height: 18),
              PointsStepper(
                value: amount,
                min: 1,
                max: 999,
                onChanged: (int value) => setSheetState(() => amount = value),
              ),
              const SizedBox(height: 6),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: 8,
                children: _quickAmounts
                    .map(
                      (int value) => QuickTag(
                        label: '$value 分',
                        selected: amount == value,
                        onTap: () => setSheetState(() => amount = value),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 16),
              const FieldLabel('常见事由'),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: _quickReasons
                    .map(
                      (String reason) => QuickTag(
                        label: reason,
                        selected: selectedReason == reason,
                        onTap: () => setSheetState(() {
                          selectedReason =
                              selectedReason == reason ? '' : reason;
                        }),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 16),
              const FieldLabel('补充说明（可选）'),
              SoftTextField(
                controller: reasonController,
                hint: '例如：今天主动帮妈妈洗碗',
                maxLines: 2,
              ),
            ],
          ),
        );
      },
    );
  }
}
