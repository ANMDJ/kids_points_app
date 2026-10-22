import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../data/read_api_errors.dart';
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
  /// 有写请求在途：禁用按钮，双击不该发出两次恢复 / 两次彻底删除。
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // live 模式才会真的发请求（预览模式的回收站来自本地列表，refreshTrash 直接返回）。
    // 失败**不弹窗**：错误留在 `store.trashError` 里，由页面照实展示 ——
    // 403 / 断网都不能被画成「回收站是空的」。
    //
    // 必须等**首帧之后**再拉：`refreshTrash` 一开始就会 `_notify()`（把状态置成
    // loading），在 `initState` 里同步调用等于在 build 期间 `setState`，
    // 会被框架判定为 "setState() called during build"。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.store.refreshTrash().then((_) {
        if (mounted) setState(() {});
      });
    });
  }

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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          ..._statusRows(),
          if (items.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Center(
                child: Text(
                  widget.store.trashError != null ? '回收站没能加载' : '回收站是空的',
                  style: const TextStyle(
                    fontSize: 13,
                    color: AppColors.textSecondary,
                  ),
                ),
              ),
            )
          else
            ...items.map(
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
            ),
        ],
      ),
    );
  }

  /// 顶部状态行：加载中 / 加载失败。
  ///
  /// 失败时**保留**上一次成功的列表（store 不会清空），这里只补一条横幅 +
  /// 重试入口 —— 把已有内容换成一句「加载失败」等于让人以为东西都没了。
  List<Widget> _statusRows() {
    final List<Widget> rows = <Widget>[];
    final ReadStatus status = widget.store.trashReadStatus;
    if (status == ReadStatus.loading && widget.store.trashItems().isEmpty) {
      rows.add(
        const Padding(
          padding: EdgeInsets.only(bottom: 10),
          child: Text(
            '正在加载回收站…',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
        ),
      );
    }
    final ReadApiException? error = widget.store.trashError;
    if (error != null) {
      rows.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  '回收站加载失败：${error.userMessage}',
                  style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.pointSpend,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SmallPill(label: '重试', onTap: _reload),
            ],
          ),
        ),
      );
    }
    return rows;
  }

  Future<void> _reload() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.store.refreshTrash();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  /// 恢复一条。
  ///
  /// live：`POST /trash/:kind/:id/restore`（服务端判定优先，409 原样展示）；
  /// 预览：本地状态复位 + 审计留痕。两条路径都由 store 统一处理。
  Future<void> _restore(TrashItem item) async {
    if (_busy) return;
    if (widget.store.isTrashWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(widget.store.trashReadOnlyWriteMessage)),
      );
      return;
    }
    setState(() => _busy = true);
    final String? error = await widget.store.submitRestoreTrash(item);
    if (!mounted) return;
    setState(() => _busy = false);
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '已恢复“${item.title}”')),
    );
  }

  /// 彻底删除（物理删）—— 必须先软删才走得到这里，且要家长二次确认。
  Future<void> _purge(TrashItem item) async {
    if (_busy) return;
    if (widget.store.isTrashWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(widget.store.trashReadOnlyWriteMessage)),
      );
      return;
    }
    final bool confirmed = await _confirm(
      title: '彻底删除',
      message: '彻底删除后无法恢复，确定删除“${item.title}”吗？',
      confirmLabel: '彻底删除',
    );
    if (!confirmed || !mounted) return;
    setState(() => _busy = true);
    final String? error = await widget.store.submitPurgeTrash(item);
    if (!mounted) return;
    setState(() => _busy = false);
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '已彻底删除')),
    );
  }

  /// 清理**已过期**条目 —— 只在家长显式点击时执行（不做任何自动清理）。
  Future<void> _purgeExpired(int expiredCount) async {
    if (_busy) return;
    if (widget.store.isTrashWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(widget.store.trashReadOnlyWriteMessage)),
      );
      return;
    }
    final bool confirmed = await _confirm(
      title: '清理已过期',
      message: '确定清理 $expiredCount 条已过 $trashRetentionDays 天保留期的内容吗？',
      confirmLabel: '清理',
    );
    if (!confirmed || !mounted) return;
    setState(() => _busy = true);
    final TrashPurgeOutcome outcome =
        await widget.store.submitPurgeExpiredTrash();
    if (!mounted) return;
    setState(() => _busy = false);
    widget.messenger.showSnackBar(
      SnackBar(content: Text(_purgeExpiredMessage(outcome))),
    );
  }

  /// 批量清理的结果文案 —— 部分成功必须**分段说清**，不能只说"已清理 N 条"
  /// （那会让剩下几条看起来也删掉了），也不能只说"失败"（前几条真的删了）。
  String _purgeExpiredMessage(TrashPurgeOutcome outcome) {
    if (!outcome.hasFailure) {
      return outcome.purged > 0 ? '已清理 ${outcome.purged} 条' : '没有可清理的内容';
    }
    if (outcome.purged > 0) {
      return '已清理 ${outcome.purged} 条，还有 ${outcome.failed} 条没清掉：'
          '${outcome.error}';
    }
    return '没能清理：${outcome.error}';
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

