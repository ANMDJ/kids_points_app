import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/read_api_errors.dart';
import '../models/approval.dart';
import '../theme/app_colors.dart';
import '../widgets/app_card.dart';
import '../widgets/gradient_page.dart';
import '../widgets/page_header.dart';
import '../widgets/pills.dart';
import 'approval_detail_screen.dart';

/// 「我的申请」：**我提交的**审批（W5-J），含撤回。
///
/// ── 2026-11-04：从底部弹窗改成**整页列表**（用户要求）─────────────────────
///   弹窗只装得下两三行，申请一多就得在里面滚；而这是一份会被反复回看的
///   记录（「上次那条为什么被拒」）。改成二级页后有返回、有刷新，
///   列表高度 = 整屏。
///
/// ── 为什么不复用家长收件箱（`ApprovalsScreen`）───────────────────────────
///   两个列表的数据源、权限与动作都不同：
///     · 收件箱 = `GET /approvals` + 批 / 拒（`review_approvals`，孩子 403）；
///     · 这里   = `GET /approvals/mine` + 撤回（`view_own_approvals`，两角色 ALLOW）。
///   把「批准」按钮放进这里会诱导家长给**自己**提的申请盖章，而服务端本来就
///   禁止自批 —— 界面不该先给一个按下去必然失败的动作。
class MyApplicationsScreen extends StatefulWidget {
  const MyApplicationsScreen({super.key});

  @override
  State<MyApplicationsScreen> createState() => _MyApplicationsScreenState();
}

class _MyApplicationsScreenState extends State<MyApplicationsScreen> {
  final List<ApprovalInboxItem> _items = <ApprovalInboxItem>[];
  String? _nextCursor;
  bool _hasMore = false;
  bool _loading = false;
  String? _loadError;

  /// 正在撤回的那一条（逐行禁用，而不是整块灰掉）。
  String? _withdrawingId;

  /// 首次加载失败后重试用的标记：null = 还没成功过。
  bool _loadedOnce = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _load(reset: true);
    });
  }

  Future<void> _load({required bool reset}) async {
    if (_loading) return;
    if (!reset && !_hasMore) return;

    setState(() {
      _loading = true;
      _loadError = null;
      if (reset) {
        _items.clear();
        _nextCursor = null;
        _hasMore = false;
      }
    });

    try {
      final ApprovalsPage page = await AppScope.of(context).fetchMyApprovals(
        cursor: reset ? null : _nextCursor,
      );
      if (!mounted) return;
      setState(() {
        if (reset) _items.clear();
        _items.addAll(page.items);
        _nextCursor = page.nextCursor;
        _hasMore = page.hasMore;
        _loadedOnce = true;
      });
    } on ReadApiException catch (error) {
      if (!mounted) return;
      setState(() => _loadError = error.userMessage);
    } catch (error) {
      if (!mounted) return;
      setState(() => _loadError = '申请列表没能加载，请稍后重试。');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _withdraw(ApprovalInboxItem item) async {
    if (_withdrawingId != null) return;
    final bool confirmed = await _confirm(
      title: '撤回申请',
      message: approvalWithdrawConfirmText(item),
      confirmLabel: '撤回',
    );
    if (!confirmed || !mounted) return;

    setState(() => _withdrawingId = item.id);
    final String? error = await AppScope.of(context).withdrawApproval(item.id);
    if (!mounted) return;
    setState(() => _withdrawingId = null);

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(error ?? '已撤回；家长那边不会再看到这条申请。')),
    );
    // 成功要重拉（状态以服务端为准）；409（已批 / 已过期）也要重拉，
    // 因为本地那一行已经过时。其余失败（断网 / 403）不重拉，避免把
    // 一次网络故障放大成「列表被清空」。
    if (error != null && !_looksStale(error)) return;
    await _load(reset: true);
  }

  /// 409 的文案由 `write_api_errors.dart` 统一产出；这里只判断
  /// 「本地那一行是不是已经过时」。真正的显示仍然用原文案。
  bool _looksStale(String message) =>
      message.contains('已经被处理') ||
      message.contains('有效期') ||
      message.contains('前提已经变了');

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
    return ok ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final bool readOnly = !AppScope.of(context).canWithdrawApprovals;
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            PageHeader(
              title: '我的申请',
              onBack: () => Navigator.of(context).maybePop(),
              trailing: IconButton(
                tooltip: '刷新',
                splashRadius: 20,
                iconSize: 19,
                onPressed: _loading ? null : () => _load(reset: true),
                icon: const Icon(
                  Icons.refresh_rounded,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: Text(
                readOnly ? '只读模式：暂时不能撤回' : '你提交的申请都在这里；待处理的可以自己撤回',
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
            if (_loading && _items.isNotEmpty)
              const LinearProgressIndicator(minHeight: 2),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
                children: <Widget>[
                  if (_loadError != null) _errorRow(_loadError!),
                  if (_loading && _items.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 24),
                      child: Center(
                        child: Text(
                          '正在加载申请…',
                          style: TextStyle(
                            fontSize: 13,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ),
                    ),
                  if (!_loading && _items.isEmpty) _emptyState(),
                  ..._items.map(
                    (ApprovalInboxItem item) => _row(item, readOnly),
                  ),
                  if (_hasMore) ...<Widget>[
                    const SizedBox(height: 4),
                    Center(
                      child: SmallPill(
                        label: _loading ? '加载中…' : '加载更多',
                        onTap: _loading ? null : () => _load(reset: false),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 空态要区分「预览模式」与「真的没有」——把预览说成「没有申请」
  /// 会让孩子以为自己的申请丢了。
  Widget _emptyState() {
    final String text;
    if (_loadError == null && !_loadedOnce) {
      text = '申请列表还没加载';
    } else if (!AppScope.of(context).isLiveMode) {
      text = '预览模式没有申请记录';
    } else {
      text = '还没有提交过申请';
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 26),
      child: Center(
        child: Text(
          text,
          style: const TextStyle(fontSize: 13, color: AppColors.textSecondary),
        ),
      ),
    );
  }

  Widget _errorRow(String message) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              '申请加载失败：$message',
              style: const TextStyle(fontSize: 12, color: AppColors.pointSpend),
            ),
          ),
          const SizedBox(width: 8),
          SmallPill(
            label: '重试',
            onTap: _loading ? null : () => _load(reset: true),
          ),
        ],
      ),
    );
  }

  Widget _row(ApprovalInboxItem item, bool readOnly) {
    final bool busy = _withdrawingId == item.id;
    final DateTime now = DateTime.now();
    final bool canWithdraw = !readOnly && item.canWithdrawAt(now);
    final ApprovalSummary? summary = item.summary;
    final String headline = summary?.headline ?? '内容无法识别';
    final String detail = summary?.detail ?? '这条申请的内容读不懂，仍然可以撤回';

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        radius: 16,
        onTap: () => _openDetail(item),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    headline,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
                SmallPill(
                  label: item.autoReasonLabel.isEmpty
                      ? item.statusLabel
                      : '${item.statusLabel} · ${item.autoReasonLabel}',
                  filled: item.isPending,
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              detail,
              style: const TextStyle(
                fontSize: 12.5,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 6),
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    '提交于 ${_formatTime(item.createdAt)}',
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
                if (canWithdraw)
                  SmallPill(
                    label: busy ? '撤回中…' : '撤回',
                    onTap: busy ? null : () => _withdraw(item),
                  )
                else if (item.isPending && !readOnly)
                  Text(
                    item.isExpiredAt(now) ? '已过期' : '不可撤回',
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// 打开详情（P1-3）：本页是「我提交的」，所以允许撤回、不显示批准。
  ///
  /// 返回时**总是重拉第一页**：详情页里可能撤回了 / 读到服务端最新状态，
  /// 而本页的 `_items` 是打开时那一份 —— 不重拉就会留一行过时的「撤回」。
  Future<void> _openDetail(ApprovalInboxItem item) async {
    await Navigator.of(context).push<Object?>(
      MaterialPageRoute<Object?>(
        builder: (_) => ApprovalDetailScreen(
          approvalId: item.id,
          initial: item,
          canWithdraw: true,
        ),
      ),
    );
    if (!mounted) return;
    await _load(reset: true);
  }

}

String _formatTime(DateTime time) {
  final DateTime local = time.toLocal();
  final String hh = local.hour.toString().padLeft(2, '0');
  final String mm = local.minute.toString().padLeft(2, '0');
  return '${local.month} 月 ${local.day} 日 $hh:$mm';
}
