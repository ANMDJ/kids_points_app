import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../data/read_api_errors.dart';
import '../models/approval.dart';
import '../theme/app_colors.dart';
import '../widgets/app_card.dart';
import '../widgets/gradient_page.dart';
import '../widgets/page_header.dart';
import '../widgets/pills.dart';

/// 审批详情（P1-3，2026-11-10）。
///
/// ── 它补的是什么 ──────────────────────────────────────────────────────────────
///   收件箱卡片只装得下一行 `summary`：家长点进去要看「规则快照 / 金额 /
///   谁提的 / 什么时候批的 / 生成了哪条流水」；孩子要看「家长是拒了还是
///   系统判定失效 / 我还能不能撤回」。而通知里的深链只有一个 `approvalId`
///   —— 目标那一条可能不在已加载的那一页，所以本页**按 id 现取**。
///
/// ── 三条与列表一致的纪律 ──────────────────────────────────────────────────────
///   ① **不编内容**：`summary == null` 显示「内容无法识别」并禁用批准；
///   ② **不假装成功**：批准 / 拒绝 / 撤回的结果以服务端回包为准（`AppStore`
///      里已经做了这一层），失败原样显示服务端文案；
///   ③ **403 / 404 要说 403 / 404**：读失败不画成「加载中」，也不画成空内容。
///
/// ── 动作由调用方声明（`canDecide` / `canWithdraw`）────────────────────────────
///   同一个页面服务两种人：家长收件箱（可批 / 拒）与「我的申请」（可撤回）。
///   服务端的权限是最终判据，但界面不该先给一个按下去必然 403 的按钮
///   （孩子看到「批准」只会以为自己有权限）。
class ApprovalDetailScreen extends StatefulWidget {
  const ApprovalDetailScreen({
    super.key,
    required this.approvalId,
    this.initial,
    this.canDecide = false,
    this.canWithdraw = false,
  });

  /// 要显示的审批 id（通知深链 / 列表行都只知道它）。
  final String approvalId;

  /// 列表里已有的那一行：先画出来（避免白屏），再用服务端的最新一条覆盖。
  final ApprovalInboxItem? initial;

  /// 允许批准 / 拒绝（家长收件箱入口）。
  final bool canDecide;

  /// 允许撤回（「我的申请」入口）。
  final bool canWithdraw;

  @override
  State<ApprovalDetailScreen> createState() => _ApprovalDetailScreenState();
}

class _ApprovalDetailScreenState extends State<ApprovalDetailScreen> {
  late ApprovalInboxItem? _item = widget.initial;
  ReadApiException? _error;
  bool _loading = false;

  /// 有写请求在途（批准 / 拒绝 / 撤回）—— 三个按钮一起禁用，避免串批。
  bool _busy = false;

  /// 这次打开期间是否真的改过状态（返回时让列表知道要重拉）。
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    // 等首帧之后再取：`fetchApproval` 失败会 setState，不能在 build 期间跑。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _load();
    });
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final ApprovalInboxItem fresh =
          await AppScope.of(context).fetchApproval(widget.approvalId);
      if (!mounted) return;
      setState(() => _item = fresh);
    } on ReadApiException catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    } catch (_) {
      if (!mounted) return;
      setState(() => _error = ReadApiException(
            ReadFailureKind.server,
            '这条申请没能加载，请稍后重试。',
            code: 'APPROVAL_DETAIL_FAILED',
          ));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 读失败时的文案：404 的通用文案说的是「孩子档案」，这里要说「这条申请」。
  String _errorText(ReadApiException error) {
    if (error.code == 'APPROVAL_NOT_FOUND' || error.statusCode == 404) {
      return '这条申请不存在，或不属于当前孩子（404）。它可能已被删除，'
          '也可能链接来自另一台设备的通知。';
    }
    if (error.code == 'NOT_REQUESTER') {
      return '只有申请人本人或有权批准这条申请的家长可以查看详情（403）。';
    }
    return error.userMessage;
  }

  @override
  Widget build(BuildContext context) {
    final ApprovalInboxItem? item = _item;
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            PageHeader(
              title: '申请详情',
              onBack: _busy ? null : () => Navigator.of(context).pop(_changed),
              trailing: IconButton(
                tooltip: '刷新',
                splashRadius: 20,
                iconSize: 19,
                onPressed: _loading || _busy ? null : _load,
                icon: const Icon(
                  Icons.refresh_rounded,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
            if (_loading) const LinearProgressIndicator(minHeight: 2),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 6, 20, 28),
                children: <Widget>[
                  if (_error != null) ...<Widget>[
                    _ErrorBanner(
                      message: _errorText(_error!),
                      onRetry: _loading ? null : _load,
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (item == null && _error == null)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 48),
                      child: Center(
                        child: Text(
                          '正在读取这条申请…',
                          style: TextStyle(
                            fontSize: 13,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ),
                    )
                  else if (item != null) ...<Widget>[
                    _headerCard(item),
                    const SizedBox(height: 12),
                    _contentCard(item),
                    const SizedBox(height: 12),
                    _decisionCard(item),
                    const SizedBox(height: 12),
                    _executionCard(item),
                    const SizedBox(height: 12),
                    _timeCard(item),
                    const SizedBox(height: 18),
                    ..._actions(item),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _headerCard(ApprovalInboxItem item) {
    final ApprovalSummary? summary = item.summary;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  summary?.headline ?? '内容无法识别',
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              _StatusPill(item: item),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            summary?.detail ?? '服务端返回的申请内容无法解析（数据异常）。',
            style: const TextStyle(
              fontSize: 13,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: <Widget>[
              _Tag(label: item.requesterLabel),
              const SizedBox(width: 8),
              Text(
                '提交于 ${formatApprovalTime(item.createdAt)}',
                style: const TextStyle(fontSize: 11.5, color: AppColors.textHint),
              ),
            ],
          ),
        ],
      ),
    );
  }


  /// 申请内容：金额 / 规则快照 / 理由 —— 按 `summary` 的判别式分支给字段，
  /// 不把 JSON 原样丢给用户。
  Widget _contentCard(ApprovalInboxItem item) {
    final ApprovalSummary? summary = item.summary;
    if (summary == null) {
      return const _Section(
        title: '申请内容',
        children: <Widget>[
          Text(
            '这条申请的 payload 读不懂（库里的坏数据，或客户端比服务端旧）。'
            '为避免批错，页面不展示猜测出来的内容，并且禁止「批准」；'
            '需要时可以拒绝后让对方重新提交。',
            style: TextStyle(
              fontSize: 12.5,
              height: 1.55,
              color: AppColors.pointSpend,
            ),
          ),
        ],
      );
    }

    final List<Widget> rows = <Widget>[];
    if (summary is RedeemSummary) {
      rows.add(_FactRow(label: '心愿', value: summary.title));
      rows.add(_FactRow(label: '本次扣分', value: '${summary.cost} 分'));
      rows.add(_FactRow(label: '心愿 id', value: summary.wishId, mono: true));
    } else if (summary is BonusSummary) {
      rows.add(_FactRow(label: '申请加分', value: '+${summary.amount} 分'));
      rows.add(_FactRow(
        label: '事由',
        value: summary.reason.trim().isEmpty ? '（没有写事由）' : summary.reason,
      ));
      rows.add(_FactRow(
        label: '依据（快照）',
        value: summary.basisTitle?.trim().isNotEmpty == true
            ? summary.basisTitle!
            : '没有关联规则 / 习惯',
      ));
      if (summary.ruleId != null) {
        rows.add(_FactRow(label: '规则 id', value: summary.ruleId!, mono: true));
      }
      if (summary.habitId != null) {
        rows.add(_FactRow(label: '习惯 id', value: summary.habitId!, mono: true));
      }
    } else if (summary is AddWishSummary) {
      rows.add(
        _FactRow(label: '心愿名', value: '${summary.emoji}「${summary.title}」'),
      );
      rows.add(_FactRow(label: '兑换成本', value: '${summary.cost} 分'));
    }
    rows.add(_FactRow(label: '动作', value: item.action, mono: true));

    return _Section(title: '申请内容', children: rows);
  }

  /// 处理情况：状态 / 谁处理的 / 系统失效原因。
  Widget _decisionCard(ApprovalInboxItem item) {
    final String handled;
    if (item.isPending) {
      handled = '还没有人处理';
    } else if (item.isSelfApproved) {
      handled = '申请人自己处理（自批）';
    } else if (item.decidedByUserId != null) {
      handled = '另一位家庭成员处理';
    } else {
      handled = '系统自动处理（未执行）';
    }
    return _Section(
      title: '处理情况',
      children: <Widget>[
        _FactRow(label: '当前状态', value: item.statusLabel),
        _FactRow(label: '处理方式', value: handled),
        _FactRow(
          label: '处理时间',
          value: item.decidedAt == null ? '—' : formatApprovalTime(item.decidedAt!),
        ),
        if (item.autoReasonLabel.isNotEmpty)
          _FactRow(label: '系统原因', value: item.autoReasonLabel),
        if (item.isPending && item.isExpiredAt(DateTime.now()))
          const _FactRow(
            label: '有效期',
            value: '已过期（服务端会在下次读写时落成 expired）',
          ),
      ],
    );
  }


  /// 执行结果 / 幂等事实。
  ///
  /// 这段是「幂等键结果」的**可核对**表达：审批执行时用 `approval:<id>`
  /// 作流水幂等键，因此同一条审批最多一笔流水；重复点击只会得到 409。
  Widget _executionCard(ApprovalInboxItem item) {
    final String? recordId = item.executedRecordId;
    return _Section(
      title: '执行结果',
      children: <Widget>[
        if (recordId == null)
          const Text(
            '这条审批还没有产生积分流水（未批准 / 已拒绝 / 已撤回 / 有效期到期）。',
            style: TextStyle(
              fontSize: 12.5,
              height: 1.55,
              color: AppColors.textSecondary,
            ),
          )
        else ...<Widget>[
          _FactRow(label: '积分流水', value: recordId, mono: true),
          const Text(
            '同一条审批只会生成一笔流水（幂等键 approval:<审批 id>）：'
            '重复点「批准」不会重复加 / 扣分。',
            style: TextStyle(
              fontSize: 12,
              height: 1.5,
              color: AppColors.textHint,
            ),
          ),
          const SizedBox(height: 4),
        ],
        _FactRow(label: '审批 id', value: item.id, mono: true),
      ],
    );
  }

  Widget _timeCard(ApprovalInboxItem item) {
    final String? remaining = item.remainingTextAt(DateTime.now());
    return _Section(
      title: '时间',
      children: <Widget>[
        _FactRow(label: '提交', value: formatApprovalTime(item.createdAt)),
        _FactRow(label: '有效期至', value: formatApprovalTime(item.expiresAt)),
        if (remaining != null) _FactRow(label: '剩余', value: remaining),
      ],
    );
  }

  List<Widget> _actions(ApprovalInboxItem item) {
    final DateTime now = DateTime.now();
    final AppStore store = AppScope.of(context);
    final bool pending = item.isPending && !item.isExpiredAt(now);
    final bool showDecide =
        pending && widget.canDecide && store.canDecideApprovals;
    final bool showWithdraw =
        pending && widget.canWithdraw && store.canWithdrawApprovals;

    if (!showDecide && !showWithdraw) {
      return const <Widget>[
        Text(
          '这条申请已经没有可执行的动作（已处理 / 已过期，或当前入口只能查看）。',
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 12, color: AppColors.textHint),
        ),
      ];
    }

    return <Widget>[
      if (showDecide)
        Row(
          children: <Widget>[
            Expanded(
              child: _ActionButton(
                label: '拒绝',
                foreground: AppColors.pointSpend,
                background: const Color(0xFFFFF0E6),
                onTap: _busy ? null : () => _decide(item, approve: false),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _ActionButton(
                label: '批准',
                foreground: Colors.white,
                background: AppColors.primaryDeep,
                onTap: _busy || item.summary == null
                    ? null
                    : () => _decide(item, approve: true),
              ),
            ),
          ],
        ),
      if (showWithdraw)
        _ActionButton(
          label: _busy ? '处理中…' : '撤回这条申请',
          foreground: AppColors.pointSpend,
          background: const Color(0xFFFFF0E6),
          onTap: _busy ? null : () => _withdraw(item),
        ),
      if (showDecide) ...<Widget>[
        const SizedBox(height: 8),
        Text(
          item.summary == null
              ? '内容无法识别，不能批准；可以拒绝后让对方重新提交。'
              : '批准会立即生效并写入积分流水；拒绝不改变任何积分。',
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 11.5, color: AppColors.textHint),
        ),
      ],
    ];
  }


  Future<void> _decide(ApprovalInboxItem item, {required bool approve}) async {
    if (_busy) return;
    final bool confirmed = await _confirm(
      title: approve ? '批准这次申请' : '拒绝这次申请',
      message: approvalConfirmText(approve: approve, item: item),
      confirmLabel: approve ? '批准' : '拒绝',
    );
    if (!confirmed || !mounted) return;

    setState(() => _busy = true);
    final String? error =
        await AppScope.of(context).decideApproval(item, approve: approve);
    if (!mounted) return;
    setState(() => _busy = false);
    if (error != null) {
      _snack(error);
      // 409（已被处理 / 过期 / 前提变化）：本地那条已过时，重新取一次。
      await _load();
      return;
    }
    _changed = true;
    _snack(approve ? '已批准，这次申请已生效。' : '已拒绝，这次申请不会生效。');
    await _load();
  }

  Future<void> _withdraw(ApprovalInboxItem item) async {
    if (_busy) return;
    final bool confirmed = await _confirm(
      title: '撤回申请',
      message: approvalWithdrawConfirmText(item),
      confirmLabel: '撤回',
    );
    if (!confirmed || !mounted) return;

    setState(() => _busy = true);
    final String? error = await AppScope.of(context).withdrawApproval(item.id);
    if (!mounted) return;
    setState(() => _busy = false);
    if (error != null) {
      _snack(error);
      await _load();
      return;
    }
    _changed = true;
    _snack('已撤回；家长那边不会再看到这条申请。');
    await _load();
  }

  Future<bool> _confirm({
    required String title,
    required String message,
    required String confirmLabel,
  }) async {
    final bool? confirmed = await showDialog<bool>(
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
    return confirmed ?? false;
  }

  void _snack(String text) {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text(text)));
  }
}


/// 小节卡片：标题 + 若干行。
class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            title,
            style: const TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w800,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          ...children,
        ],
      ),
    );
  }
}

/// 一行「标签 : 值」。值允许换行（事由可能很长）。
class _FactRow extends StatelessWidget {
  const _FactRow({
    required this.label,
    required this.value,
    this.mono = false,
  });

  final String label;
  final String value;

  /// id 类字段用等宽字体 + 小一号：用户要抄给客服时才分得清 0/O。
  final bool mono;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          SizedBox(
            width: 88,
            child: Text(
              label,
              style: const TextStyle(fontSize: 12, color: AppColors.textHint),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontSize: mono ? 11.5 : 12.5,
                height: 1.45,
                fontWeight: mono ? FontWeight.w500 : FontWeight.w600,
                fontFamily: mono ? 'monospace' : null,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 状态胶囊（与收件箱同色：待处理 = 绿，拒绝 = 红，其余 = 灰）。
class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.item});

  final ApprovalInboxItem item;

  @override
  Widget build(BuildContext context) {
    final bool expired = item.isExpiredAt(DateTime.now());
    final String label = expired ? '已过期' : item.statusLabel;
    final Color color = switch (item.status) {
      'pending' => AppColors.primaryDeep,
      'rejected' => AppColors.pointSpend,
      _ => AppColors.textSecondary,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: item.isPending ? AppColors.primarySoft : AppColors.chipBg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w700,
          color: color,
        ),
      ),
    );
  }
}

/// 申请人角色的小标签。
class _Tag extends StatelessWidget {
  const _Tag({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.chipBg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: AppColors.textSecondary,
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
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: foreground,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message, required this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      color: const Color(0xFFFFF6EE),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Text(
              message,
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.5,
                color: AppColors.pointSpend,
              ),
            ),
          ),
          const SizedBox(width: 8),
          SmallPill(label: '重试', onTap: onRetry),
        ],
      ),
    );
  }
}

