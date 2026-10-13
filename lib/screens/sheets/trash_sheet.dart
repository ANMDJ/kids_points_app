import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../models/trash.dart';
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/pills.dart';
import '../../widgets/sheet_frame.dart';

/// 打开「回收站」（修 C9）—— 入口固定在「我的」页，与 Taro 侧同一处。
Future<void> showTrashSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return TrashSheet(store: store, messenger: messenger);
    },
  );
}

/// 回收站（修 C9）：规则 / 心愿 / 习惯三类**配置**的软删条目汇总。
///
/// 两条路径各一条：**恢复**（[AppStore.restoreTrash]）与**彻底删除**（[AppStore.purgeTrash]）。
/// 流水与审计**永不进回收站**（`01` §5：账本不可变）—— 这里只有配置项。
///
/// 过期（满 90 天）只是**判定**：是否真清理由家长点「清理已过期」决定，
/// **不做任何自动清理**。判定与文案全部来自纯函数 [isTrashExpired] /
/// [trashRetentionText]，本组件不做任何日期运算
/// （那正是 E17 的病：展示串在界面里被手算出来）。
class TrashSheet extends StatefulWidget {
  const TrashSheet({super.key, required this.store, required this.messenger});

  final AppStore store;
  final ScaffoldMessengerState messenger;

  @override
  State<TrashSheet> createState() => _TrashSheetState();
}

class _TrashSheetState extends State<TrashSheet> {
  @override
  Widget build(BuildContext context) {
    final List<TrashItem> items = widget.store.trashItems();
    final int expiredCount =
        items.where((TrashItem item) => item.expired).length;

    return SheetFrame(
      title: '回收站',
      subtitle: '删除的规则 / 心愿 / 习惯在这里保留 $trashRetentionDays 天',
      actionLabel: expiredCount > 0 ? '清理已过期（$expiredCount）' : null,
      actionIcon: Icons.delete_sweep_rounded,
      onAction: () => _purgeExpired(expiredCount),
      child: items.isEmpty
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 28),
              child: Center(
                child: Text(
                  '回收站是空的',
                  style: TextStyle(
                    fontSize: 13,
                    color: AppColors.textSecondary,
                  ),
                ),
              ),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: items
                  .map(
                    (TrashItem item) => Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: AppCard(
                        radius: 16,
                        child: Row(
                          children: <Widget>[
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: <Widget>[
                                  Text(
                                    item.title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 14.5,
                                      fontWeight: FontWeight.w700,
                                      color: AppColors.textPrimary,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    '${item.kindLabel} · ${item.retentionText()}',
                                    style: const TextStyle(
                                      fontSize: 11.5,
                                      color: AppColors.textSecondary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 10),
                            SmallPill(label: '恢复', onTap: () => _restore(item)),
                            const SizedBox(width: 8),
                            _DangerPill(
                              label: '彻底删除',
                              onTap: () => _purge(item),
                            ),
                          ],
                        ),
                      ),
                    ),
                  )
                  .toList(),
            ),
    );
  }
  /// 恢复一条：回到列表（状态复位、`deletedAt` 清空），审计里留下一条 restore。
  void _restore(TrashItem item) {
    final bool done = widget.store.restoreTrash(item.kind, item.id);
    widget.messenger.showSnackBar(
      SnackBar(content: Text(done ? '已恢复“${item.title}”' : '这条内容已经不在了')),
    );
    if (done) setState(() {});
  }

  /// 彻底删除（物理删）—— 必须先软删才走得到这里，且要家长二次确认。
  Future<void> _purge(TrashItem item) async {
    final bool confirmed = await _confirm(
      title: '彻底删除',
      message: '彻底删除后无法恢复，确定删除“${item.title}”吗？',
      confirmLabel: '彻底删除',
    );
    if (!confirmed) return;
    final bool done = widget.store.purgeTrash(item.kind, item.id);
    widget.messenger.showSnackBar(
      SnackBar(content: Text(done ? '已彻底删除' : '这条内容已经不在了')),
    );
    if (done) setState(() {});
  }

  /// 清理**已过期**条目 —— 只在家长显式点击时执行（不做任何自动清理）。
  Future<void> _purgeExpired(int expiredCount) async {
    final bool confirmed = await _confirm(
      title: '清理已过期',
      message: '确定清理 $expiredCount 条已过 $trashRetentionDays 天保留期的内容吗？',
      confirmLabel: '清理',
    );
    if (!confirmed) return;
    final int purged = widget.store.purgeExpiredTrash();
    widget.messenger.showSnackBar(
      SnackBar(content: Text(purged > 0 ? '已清理 $purged 条' : '没有可清理的内容')),
    );
    if (purged > 0) setState(() {});
  }

  Future<bool> _confirm({
    required String title,
    required String message,
    required String confirmLabel,
  }) async {
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(title),
          content: Text(message),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(confirmLabel),
            ),
          ],
        );
      },
    );
    return ok == true;
  }

}
/// 危险操作胶囊（“彻底删除”）：与 [SmallPill] 同形，换成告警色。
class _DangerPill extends StatelessWidget {
  const _DangerPill({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: const Color(0xFFFDF1E9),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(
          label,
          style: const TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w700,
            color: AppColors.pointSpend,
          ),
        ),
      ),
    );
  }
}

