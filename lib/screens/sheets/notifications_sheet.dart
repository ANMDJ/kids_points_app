import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../data/read_api_errors.dart';
import '../../data/read_dto.dart';
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/pills.dart';
import '../../widgets/sheet_frame.dart';
import 'my_applications_sheet.dart';

/// 打开「消息」面板（W5-L）—— 入口固定在「我的」页，与 Taro 侧同一处。
///
/// [onOpenApprovals]：家长收到「新申请待确认」（W5-M）时，点「去审批」要把
/// 底部 tab 切到「审批」页 —— 由 `HomeShell` 提供（它才持有 tab 下标）。
/// 没提供时只关面板：宁可少一次跳转，也不要把家长送进「我的申请」。
Future<void> showNotificationSheet(
  BuildContext context, {
  VoidCallback? onOpenApprovals,
}) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return NotificationSheet(
        store: store,
        messenger: messenger,
        onOpenApprovals: onOpenApprovals,
      );
    },
  );
}

/// 站内通知中心（W5-L）：审批结果等消息的**收件箱**。
///
/// ── 收件人恒为「我」 ──────────────────────────────────────────────────────
///   客户端没有「看谁的」参数：服务端按会话 `userId` 收口，别人的 id 与
///   不存在的 id 返回同一句 404。界面因此**不需要**任何角色判断 ——
///   两条路由在矩阵里两侧都 ALLOW。
///
/// ── 未读只有一种事实源 ────────────────────────────────────────────────────
///   行上的灰化 / 圆点全部由 `NotificationDto.isUnread`（= `readAt == null`）
///   现算；数量用服务端下发的整份 `unreadCount`，**不**对 `items` 求和
///   （本页 20 条之外的未读会被漏掉）。
///
/// ── 点开 = 标记已读，但不强制跳转 ─────────────────────────────────────────
///   点一条就打一次 `PATCH /notifications/:id/read`（失败经 SnackBar 原样上报，
///   界面不回滚成未读 —— 服务端回包才是权威值）。
///   审批类消息多一个胶囊，但去向按 `type` 分（W5-M）：
///     · `approval.approved` / `approval.rejected` ⇒「查看申请」→「我的申请」看结果；
///     · `approval.submitted`（家长收到「有人提交了申请」）⇒「去审批」→ 关面板并切到
///       「审批」页。把后者也送进「我的申请」等于让家长去翻自己**没提交过**的列表。
///   普通消息（没有 `approvalId`）只是读掉，不做无意义的跳转。
class NotificationSheet extends StatefulWidget {
  const NotificationSheet({
    super.key,
    required this.store,
    required this.messenger,
    this.onOpenApprovals,
  });

  final AppStore store;
  final ScaffoldMessengerState messenger;

  /// 切到「审批」页（由 `HomeShell` 提供）；为空时「去审批」只关面板。
  final VoidCallback? onOpenApprovals;

  @override
  State<NotificationSheet> createState() => _NotificationSheetState();
}

class _NotificationSheetState extends State<NotificationSheet> {
  /// 有读请求（首次拉取 / 重试 / 加载更多）在途；写请求的忙碌状态由
  /// `store.busyNotificationId` 表达（逐行禁用）。
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // 等首帧之后再拉：`refreshNotifications` 一开始就会 `_notify()`，
    // 在 initState 里同步调用等于 build 期间 setState。
    // 失败**不弹窗**：错误留在 `store.notificationsError` 里由面板照实展示。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.store.refreshNotifications().then((_) {
        if (mounted) setState(() {});
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    final List<NotificationDto> items = widget.store.notifications;
    final int unread = widget.store.unreadNotificationCount;

    return SheetFrame(
      title: unread > 0 ? '消息（$unread 条未读）' : '消息',
      subtitle: '审批申请与结果会在这里留一条；点一下即标记已读',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          ..._statusRows(),
          if (items.isEmpty)
            _emptyState()
          else
            ...items.map(_row),
          if (items.isNotEmpty && widget.store.notificationsHasMore)
            _moreRow(),
        ],
      ),
    );
  }

  /// 一行通知：未读圆点 + 标题 + 时间 + 正文；审批类多一个「查看申请」。
  ///
  /// 已读的行**不隐藏**（那不是「消息没了」），只是颜色变浅 ——
  /// 用户回头找「上周那条被拒的原因」时还得看得见。
  Widget _row(NotificationDto item) {
    final bool unread = item.isUnread;
    final bool busy = widget.store.busyNotificationId == item.id;
    final String? approvalId = item.approvalId;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        radius: 16,
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: busy ? null : () => _markRead(item),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    if (unread) ...<Widget>[
                      Container(
                        width: 8,
                        height: 8,
                        margin: const EdgeInsets.only(top: 6, right: 8),
                        decoration: const BoxDecoration(
                          color: AppColors.pointSpend,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ],
                    Expanded(
                      child: Text(
                        item.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 14.5,
                          fontWeight:
                              unread ? FontWeight.w700 : FontWeight.w600,
                          color: unread
                              ? AppColors.textPrimary
                              : AppColors.textSecondary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      _dateTimeText(item.createdAt),
                      style: const TextStyle(
                        fontSize: 11,
                        color: AppColors.textHint,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  item.body,
                  maxLines: 4,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12.5,
                    height: 1.45,
                    color: unread
                        ? AppColors.textPrimary
                        : AppColors.textSecondary,
                  ),
                ),
                if (approvalId != null) ...<Widget>[
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: <Widget>[
                      SmallPill(
                        label: busy
                            ? '处理中…'
                            : item.isApprovalSubmitted
                                ? '去审批'
                                : '查看申请',
                        onTap: busy
                            ? null
                            : () async {
                                await _markRead(item);
                                if (!mounted) return;
                                if (!item.isApprovalSubmitted) {
                                  await showMyApplicationsSheet(context);
                                  return;
                                }
                                // 先关面板再切 tab：切完 tab 这块 context 已不在树上，
                                // 再 pop 会对着一个已销毁的 Navigator 动手。
                                final NavigatorState navigator =
                                    Navigator.of(context);
                                final VoidCallback? openApprovals =
                                    widget.onOpenApprovals;
                                navigator.pop();
                                openApprovals?.call();
                              },
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }


  /// 空态必须区分**没拉到**与**真的没有** —— 403 / 断网时显示「没有消息」
  /// 会让用户以为审批结果从来没来过。
  Widget _emptyState() {
    final String text;
    final ReadStatus status = widget.store.notificationsReadStatus;
    if (widget.store.notificationsError != null) {
      text = '消息列表没能加载';
    } else if (status == ReadStatus.loading) {
      text = '正在加载消息…';
    } else if (!widget.store.isLiveMode) {
      text = '预览模式没有站内消息';
    } else {
      text = '还没有消息';
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Center(
        child: Text(
          text,
          style: const TextStyle(
            fontSize: 13,
            color: AppColors.textSecondary,
          ),
        ),
      ),
    );
  }

  /// 顶部状态行：加载中 / 加载失败（+ 重试）。失败时保留已有行。
  List<Widget> _statusRows() {
    final List<Widget> rows = <Widget>[];
    final ReadStatus status = widget.store.notificationsReadStatus;
    if (status == ReadStatus.loading && widget.store.notifications.isEmpty) {
      rows.add(
        const Padding(
          padding: EdgeInsets.only(bottom: 10),
          child: Text(
            '正在加载消息…',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
        ),
      );
    }
    final ReadApiException? error = widget.store.notificationsError;
    if (error != null) {
      rows.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  '消息加载失败：${error.userMessage}',
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

  /// 底部「加载更多」：`SheetFrame` 内部是普通滚动视图，没有滚动回调，
  /// 所以显式给一个按钮 —— 比偷偷监听滚动位置更可预期。
  Widget _moreRow() {
    return Padding(
      padding: const EdgeInsets.only(top: 2, bottom: 4),
      child: Center(
        child: SmallPill(
          label: _busy ? '正在加载…' : '加载更多',
          onTap: _busy ? null : _loadMore,
        ),
      ),
    );
  }

  Future<void> _reload() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.store.refreshNotifications();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  Future<void> _loadMore() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.store.loadMoreNotifications();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  /// 标记已读。**不**在预览模式 / 只读模式下假装成功：直接说明原因。
  ///
  /// 已读的行再点不重复请求（`store.markNotificationRead` 也会提前返回）。
  Future<void> _markRead(NotificationDto item) async {
    if (!item.isUnread) return;
    if (widget.store.isNotificationWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(widget.store.notificationReadOnlyWriteMessage)),
      );
      return;
    }
    final String? error = await widget.store.markNotificationRead(item);
    if (!mounted) return;
    if (error != null) {
      widget.messenger.showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    setState(() {});
  }
}

String _two(int value) => value.toString().padLeft(2, '0');

/// 通知时间按**本地时区**展示（服务端下发 UTC）；精确到分钟就够了 ——
/// 站内消息不用于对账，多一个秒位只会让行更挤。
String _dateTimeText(DateTime value) {
  final DateTime local = value.toLocal();
  return '${local.month}月${local.day}日 ${_two(local.hour)}:${_two(local.minute)}';
}

