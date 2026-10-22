import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../data/read_api_errors.dart';
import '../models/approval.dart';
import '../theme/app_colors.dart';
import '../widgets/app_card.dart';
import '../widgets/gradient_page.dart';
import '../widgets/pills.dart';

/// 家长审批收件箱（W5-D）：待处理 / 已通过 / 已拒绝 / 全部。
///
/// ── 三条界面纪律 ──────────────────────────────────────────────────────────
///   ① **不编内容**：卡片文案全部来自结构化 `summary`（服务端不下发展示串）。
///      `summary == null`（坏数据 / 更新的服务端）显示「内容无法识别」并**禁用批准**
///      —— 看不到内容就不该点批；但「拒绝」仍然可用，否则那一行会永久卡住。
///   ② **不假装成功**：批准 / 拒绝的结果以服务端回包为准，409（已处理 / 过期 /
///      前提变化）原样显示服务端语义，并立刻重拉列表。
///   ③ **403 要说 403**：孩子角色调用这个端点会被矩阵拦下。页面明说「没有批准
///      权限」，不能说成「暂无待审批」（那是 D3 那类假象）。
class ApprovalsScreen extends StatefulWidget {
  const ApprovalsScreen({super.key});

  @override
  State<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

class _ApprovalsScreenState extends State<ApprovalsScreen> {
  /// 过滤胶囊：`status` 是后端契约里的原词，`label` 只用于显示。
  static const List<(String, String)> _filters = <(String, String)>[
    ('pending', '待处理'),
    ('approved', '已通过'),
    ('rejected', '已拒绝'),
    ('all', '全部'),
  ];

  Future<void> _decide(
    AppStore store,
    ApprovalInboxItem item,
    bool approve,
  ) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    if (!await _confirm(approve, item)) return;
    final String? error = await store.decideApproval(item, approve: approve);
    if (!mounted) return;
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          error ?? (approve ? '已批准，这次申请已生效。' : '已拒绝，这次申请不会生效。'),
        ),
      ),
    );
  }

  Future<bool> _confirm(bool approve, ApprovalInboxItem item) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(approve ? '批准这次申请' : '拒绝这次申请'),
          content: Text(approvalConfirmText(approve: approve, item: item)),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(approve ? '批准' : '拒绝'),
            ),
          ],
        );
      },
    );
    return confirmed ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    final List<ApprovalInboxItem> items = store.approvals;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            SizedBox(
              height: 56,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Row(
                  children: <Widget>[
                    const Text(
                      '家长审批',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w800,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (store.pendingApprovalCount > 0 &&
                        store.approvalStatusFilter == 'pending')
                      SmallPill(
                        label: '${store.pendingApprovalCount} 条',
                        filled: true,
                      ),
                    const Spacer(),
                    IconButton(
                      tooltip: '刷新',
                      splashRadius: 20,
                      iconSize: 19,
                      onPressed: store.isLiveMode
                          ? () => store.refreshApprovals()
                          : null,
                      icon: const Icon(
                        Icons.refresh_rounded,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                children: _filters.map(((String, String) filter) {
                  return Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: SoftChip(
                      label: filter.$2,
                      selected: store.approvalStatusFilter == filter.$1,
                      onTap: () => store.setApprovalStatusFilter(filter.$1),
                    ),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 14),
            Expanded(child: _buildBody(store, items)),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(AppStore store, List<ApprovalInboxItem> items) {
    final bool firstLoad = store.isLiveMode &&
        store.approvalReadStatus == ReadStatus.loading &&
        items.isEmpty;
    if (firstLoad) {
      return const Center(child: CircularProgressIndicator());
    }

    if (items.isEmpty) {
      return RefreshIndicator(
        color: AppColors.primaryDeep,
        onRefresh: store.isLiveMode ? store.refreshApprovals : () async {},
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(20, 40, 20, 28),
          children: <Widget>[
            _EmptyHint(store: store),
          ],
        ),
      );
    }

    final DateTime now = DateTime.now();
    return RefreshIndicator(
      color: AppColors.primaryDeep,
      onRefresh: store.isLiveMode ? store.refreshApprovals : () async {},
      child: ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 28),
        itemCount: items.length + 1,
        separatorBuilder: (BuildContext context, int index) =>
            const SizedBox(height: 10),
        itemBuilder: (BuildContext context, int index) {
          if (index == items.length) return _buildFooter(store);
          final ApprovalInboxItem item = items[index];
          return _ApprovalCard(
            item: item,
            now: now,
            busy: store.decidingApprovalId != null,
            deciding: store.decidingApprovalId == item.id,
            canWrite: store.canDecideApprovals,
            onApprove: () => _decide(store, item, true),
            onReject: () => _decide(store, item, false),
          );
        },
      ),
    );
  }

  Widget _buildFooter(AppStore store) {
    if (store.approvalReadStatus == ReadStatus.loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 18),
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }
    if (store.hasMoreApprovals) {
      return Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Center(
          child: TextButton(
            onPressed: store.loadMoreApprovals,
            child: Text(
              store.approvalReadStatus == ReadStatus.error
                  ? '重试加载更多'
                  : '加载更多',
            ),
          ),
        ),
      );
    }
    return const Padding(
      padding: EdgeInsets.only(top: 12),
      child: Center(
        child: Text(
          '没有更多了',
          style: TextStyle(fontSize: 11.5, color: AppColors.textHint),
        ),
      ),
    );
  }
}

/// 空态：必须区分「还没有数据」「读取失败」「没权限」「预览模式」。
class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.store});

  final AppStore store;

  @override
  Widget build(BuildContext context) {
    if (!store.isLiveMode) {
      return const _Hint(
        emoji: '🌱',
        text: '预览模式没有审批数据。\n连上后端后，孩子的兑换 / 加分申请会出现在这里。',
      );
    }

    if (store.approvalReadStatus == ReadStatus.error) {
      final ReadApiException? error = store.approvalError;
      // 403 是**权限**问题，不是空列表：直接说没有批准资格，并给出下一步。
      if (error != null && error.kind == ReadFailureKind.forbidden) {
        return _Hint(
          emoji: '🔒',
          text: '当前身份没有批准申请的权限（403）。\n审批只能由家长设备处理；孩子设备可以继续提交申请。',
          action: TextButton(
            onPressed: store.refreshApprovals,
            child: const Text('重试'),
          ),
        );
      }
      return _Hint(
        emoji: '⚠️',
        text: '${error?.userMessage ?? '读取审批列表失败。'}\n这不是「没有待审批」。',
        action: TextButton(
          onPressed: store.refreshApprovals,
          child: const Text('重试'),
        ),
      );
    }

    if (store.approvalReadStatus == ReadStatus.idle) {
      return _Hint(
        emoji: '📨',
        text: '还没读取审批列表。',
        action: TextButton(
          onPressed: store.refreshApprovals,
          child: const Text('读取'),
        ),
      );
    }

    return const _Hint(
      emoji: '🍃',
      text: '没有符合条件的申请。',
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint({required this.emoji, required this.text, this.action});

  final String emoji;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(emoji, style: const TextStyle(fontSize: 40)),
          const SizedBox(height: 10),
          Text(
            text,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 13,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
          if (action != null) action!,
        ],
      ),
    );
  }
}


/// 一条申请。
class _ApprovalCard extends StatelessWidget {
  const _ApprovalCard({
    required this.item,
    required this.now,
    required this.busy,
    required this.deciding,
    required this.canWrite,
    required this.onApprove,
    required this.onReject,
  });

  final ApprovalInboxItem item;
  final DateTime now;

  /// 有任意一条申请在提交中（所有卡片按钮都禁用，避免串批）。
  final bool busy;
  final bool deciding;

  /// 收件箱写入是否可用（live + 有写客户端）。
  final bool canWrite;
  final VoidCallback onApprove;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    final bool pending = item.isPending;
    final bool expired = item.isExpiredAt(now);
    final String? blocked = item.approveBlockedReasonAt(now);
    final String? remaining = item.remainingTextAt(now);

    return AppCard(
      padding: const EdgeInsets.fromLTRB(14, 13, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _SummaryBadge(summary: item.summary),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      item.summary?.headline ?? '内容无法识别',
                      style: const TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w700,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      item.summary?.detail ??
                          '服务端返回的申请内容无法解析（数据异常），不能批准。',
                      style: const TextStyle(
                        fontSize: 12,
                        height: 1.4,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              _StatusPill(item: item, expired: expired, remaining: remaining),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '提交于 ${formatApprovalTime(item.createdAt)}',
            style: const TextStyle(fontSize: 11, color: AppColors.textHint),
          ),
          if (!pending) ...<Widget>[
            const SizedBox(height: 4),
            Text(
              item.autoReasonLabel.isEmpty
                  ? item.statusLabel
                  : '${item.statusLabel} · ${item.autoReasonLabel}',
              style: const TextStyle(fontSize: 11, color: AppColors.textHint),
            ),
          ],
          if (pending) ...<Widget>[
            const SizedBox(height: 10),
            Row(
              children: <Widget>[
                if (blocked != null)
                  Expanded(
                    child: Text(
                      blocked,
                      style: const TextStyle(
                        fontSize: 11,
                        height: 1.4,
                        color: AppColors.pointSpend,
                      ),
                    ),
                  )
                else
                  const Spacer(),
                if (deciding)
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else ...<Widget>[
                  _ActionButton(
                    label: '拒绝',
                    foreground: AppColors.pointSpend,
                    background: const Color(0xFFFFF0E6),
                    onTap: !canWrite || expired ? null : onReject,
                  ),
                  const SizedBox(width: 8),
                  _ActionButton(
                    label: '批准',
                    foreground: Colors.white,
                    background: AppColors.primaryDeep,
                    onTap:
                        !canWrite || expired || blocked != null || busy
                            ? null
                            : onApprove,
                  ),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}


class _SummaryBadge extends StatelessWidget {
  const _SummaryBadge({required this.summary});

  final ApprovalSummary? summary;

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color) = switch (summary) {
      RedeemSummary() => (Icons.card_giftcard_rounded, AppColors.orange),
      BonusSummary() => (Icons.add_circle_outline_rounded, AppColors.pointGain),
      AddWishSummary() => (Icons.favorite_border_rounded, AppColors.starYellow),
      _ => (Icons.help_outline_rounded, AppColors.textHint),
    };
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(13),
      ),
      child: Icon(icon, size: 20, color: color),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({
    required this.item,
    required this.expired,
    required this.remaining,
  });

  final ApprovalInboxItem item;
  final bool expired;
  final String? remaining;

  @override
  Widget build(BuildContext context) {
    if (item.isPending) {
      if (expired) {
        return const SmallPill(
          label: '已过期',
          padding: EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        );
      }
      return SmallPill(
        label: remaining ?? '待处理',
        filled: true,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      );
    }
    final Color color = switch (item.status) {
      'approved' => AppColors.primaryText,
      'rejected' => AppColors.pointSpend,
      _ => AppColors.textSecondary,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: AppColors.chipBg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        item.statusLabel,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w700,
          color: color,
        ),
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.label,
    required this.foreground,
    required this.background,
    required this.onTap,
  });

  final String label;
  final Color foreground;
  final Color background;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: onTap == null ? 0.45 : 1,
      child: Material(
        color: background,
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: foreground,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// `10 月 21 日 14:05`（本地时区）。
///
/// 服务端下发 UTC；直接显示会让家长看到差 8 小时的「提交时间」。
String formatApprovalTime(DateTime time) {
  final DateTime local = time.toLocal();
  final String hh = local.hour.toString().padLeft(2, '0');
  final String mm = local.minute.toString().padLeft(2, '0');
  return '${local.month} 月 ${local.day} 日 $hh:$mm';
}

