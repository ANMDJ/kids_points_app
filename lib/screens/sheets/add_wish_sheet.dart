import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../theme/app_colors.dart';
import '../../widgets/form_fields.dart';
import '../../widgets/points_stepper.dart';
import '../../widgets/sheet_frame.dart';

/// “新增心愿”：孩子写下想要兑换的奖励以及需要的积分。
Future<void> showAddWishSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return AddWishSheet(store: store, messenger: messenger);
    },
  );
}

class AddWishSheet extends StatefulWidget {
  final AppStore store;
  final ScaffoldMessengerState messenger;

  const AddWishSheet({
    required this.store,
    required this.messenger,
  });

  @override
  State<StatefulWidget> createState() => _AddWishSheetState();
}

class _AddWishSheetState extends State<AddWishSheet> {
  final TextEditingController titleController = TextEditingController();
  int cost = 40;
  String emoji = wishEmojis.first;

  @override
  void dispose() {
    titleController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StatefulBuilder(
      builder: (BuildContext sheetContext, StateSetter setSheetState) {
        return SheetFrame(
          title: '新增心愿',
          subtitle: '当前可用积分 ${widget.store.points}',
          actionLabel: '保存心愿',
          actionIcon: Icons.favorite_rounded,
          onAction: () async {
            final String title = titleController.text.trim();
            if (title.isEmpty) {
              widget.messenger.showSnackBar(
                const SnackBar(content: Text('先给心愿起个名字吧～')),
              );
              return;
            }
            // W5-C：live 模式真的 POST /wishes；孩子的权限若是「需要审批」，
            // 服务端 403 `APPROVAL_REQUIRED` ⇒ 返回可读原因，**弹窗不关、
            // 输入不丢**，让家长知道这次没保存。
            final String? message = await widget.store.submitAddWish(
              title: title,
              cost: cost,
              emoji: emoji,
            );
            if (!sheetContext.mounted) return;
            if (message != null) {
              widget.messenger.hideCurrentSnackBar();
              widget.messenger.showSnackBar(SnackBar(content: Text(message)));
              return;
            }
            Navigator.of(sheetContext).pop();
            widget.messenger.showSnackBar(
              SnackBar(content: Text('已添加心愿：$title（$cost 积分）')),
            );
          },
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const FieldLabel('心愿名称'),
              SoftTextField(
                controller: titleController,
                hint: '例如：去游乐园玩一整天',
                maxLines: 2,
              ),
              const SizedBox(height: 16),
              const FieldLabel('需要多少积分'),
              PointsStepper(
                value: cost,
                min: 1,
                max: 9999,
                onChanged: (int value) => setSheetState(() => cost = value),
              ),
              const SizedBox(height: 16),
              const FieldLabel('选个图标'),
              EmojiPicker(
                selected: emoji,
                onSelected: (String value) =>
                    setSheetState(() => emoji = value),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                decoration: BoxDecoration(
                  color: AppColors.primarySoft,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  widget.store.points >= cost
                      ? '现在就能兑换，点“兑换”立即生效'
                      : '还差 ${cost - widget.store.points} 积分，加油打卡就能达成',
                  style: const TextStyle(
                    fontSize: 12.5,
                    color: AppColors.primaryText,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
