import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../data/read_api_errors.dart';
import '../../models/family_deletion.dart';
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/pills.dart';
import '../../widgets/sheet_frame.dart';

/// 打开「删除家庭数据」面板（W7-D）—— 入口固定在「我的」页。
Future<void> showFamilyDeletionSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return FamilyDeletionSheet(store: store, messenger: messenger);
    },
  );
}

/// 家庭数据删除（W7-D）：申请 → 7 天冷却 → 后台执行 → 就地匿名化。
///
/// ── 这个面板必须说清的三件事 ────────────────────────────────────────────────
///   ① **不会立刻删**：申请后进入冷却期，`scheduledFor` 之前随时可以撤销；
///   ② **删的是「写了什么」**：昵称 / 规则与条件的文字 / 流水备注 / 成员 PIN
///      会被抹掉，而流水的分数与余额**保留**（账本 append-only，02 §5.7 I5）；
///   ③ **撤销同意不等于数据被扣住**：删除与导出都不受 `ConsentGuard` 管辖，
///      撤回同意之后仍然可以删（04 §5）。
///
/// ── 二次确认 ────────────────────────────────────────────────────────────────
///   第一次点击只是**展开**警告（[_confirming]），第二次「确认删除」才发请求，
///   且请求体显式带 `confirmed: true`。不做「长按 / 滑动」这类花活：
///   删除的关键不是手势难度，而是**看清后果之后再决定**。
class FamilyDeletionSheet extends StatefulWidget {
  const FamilyDeletionSheet({
    super.key,
    required this.store,
    required this.messenger,
  });

  final AppStore store;
  final ScaffoldMessengerState messenger;

  @override
  State<FamilyDeletionSheet> createState() => _FamilyDeletionSheetState();
}

class _FamilyDeletionSheetState extends State<FamilyDeletionSheet> {
  /// 有请求（成员 / 删除状态 / 提交）在途。
  bool _busy = false;

  /// 是否已经展开「确认删除」这一步。
  bool _confirming = false;

  @override
  void initState() {
    super.initState();
    // 等首帧之后再拉：`refreshMembers` / `loadFamilyDeletion` 一开始就会
    // `_notify()`，在 initState 里同步调用等于 build 期间 setState。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _bootstrap();
    });
  }

  Future<void> _bootstrap() async {
    final AppStore store = widget.store;
    setState(() => _busy = true);
    if (store.isLiveMode && store.selfMember == null) {
      await store.refreshMembers();
    }
    if (!mounted) return;
    if (store.canManageFamilyDeletion) {
      await store.loadFamilyDeletion();
    }
    if (!mounted) return;
    setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final bool canManage = widget.store.canManageFamilyDeletion;
    return SheetFrame(
      title: '删除家庭数据',
      subtitle: canManage
          ? '申请后有 ${FamilyDeletion.coolingDays} 天可以撤销'
          : '只有家长可以删除家庭数据',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: _body(canManage),
      ),
    );
  }

  List<Widget> _body(bool canManage) {
    final AppStore store = widget.store;
    if (!store.isLiveMode) {
      return <Widget>[
        _hint('预览模式没有真实的家庭数据，这里不会执行删除。接入后端后才能申请。'),
      ];
    }
    if (store.selfMember == null) {
      // 角色未知（成员列表没拉到 / 403 / 断网）：既不能给删除按钮，
      // 也不能说「你不是家长」—— 两种猜法都会把真实原因藏起来。
      return <Widget>[
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        const SizedBox(height: 8),
        ..._unknownRoleRows(),
      ];
    }
    if (!canManage) {
      return <Widget>[
        _hint(
          '你的身份是${store.selfMember!.roleLabel}，不能删除家庭数据。\n'
          '删除与导出一样只属于家长：它会不可逆地抹掉全家的描述性数据。',
        ),
      ];
    }

    final FamilyDeletion? state = store.familyDeletion;
    if (store.deletionReadStatus == ReadStatus.loading && state == null) {
      return <Widget>[
        const LinearProgressIndicator(minHeight: 2),
        const SizedBox(height: 8),
      ];
    }
    if (store.deletionReadStatus == ReadStatus.error) {
      return <Widget>[
        _errorCard(store.deletionError),
        if (state != null) ..._stateRows(state),
      ];
    }
    if (state == null) {
      return <Widget>[
        _hint('还没有拉到删除状态。'),
        Align(
          alignment: Alignment.centerRight,
          child: SmallPill(label: '重试', onTap: _busy ? null : _bootstrap),
        ),
      ];
    }
    return _stateRows(state);
  }

  List<Widget> _stateRows(FamilyDeletion state) {
    switch (state.status) {
      case FamilyDeletionStatus.none:
      case FamilyDeletionStatus.cancelled:
        return <Widget>[
          if (state.status == FamilyDeletionStatus.cancelled)
            _hint('上一次的删除申请已撤销（${_dateText(state.cancelledAt)}）。')
          else
            _hint('当前没有待执行的删除请求。'),
          _warningCard(state),
          const SizedBox(height: 12),
          if (!_confirming)
            Align(
              alignment: Alignment.centerRight,
              child: SmallPill(
                label: '申请删除…',
                filled: true,
                padding:
                    const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
                onTap: widget.store.isDeletionBusy
                    ? null
                    : () => setState(() => _confirming = true),
              ),
            )
          else
            ..._confirmRows(),
        ];
      case FamilyDeletionStatus.pending:
        return <Widget>[
          AppCard(
            radius: 16,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '${state.statusLabel} · ${state.deadlineText}',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  state.remainingText,
                  style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.textSecondary,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  '在到期之前，你随时可以撤销这条申请；撤销不会留下任何删除痕迹。',
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.5,
                    color: AppColors.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: SmallPill(
              label: '撤销删除申请',
              filled: true,
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
              onTap: widget.store.isDeletionBusy ? null : _cancel,
            ),
          ),
        ];
      case FamilyDeletionStatus.executed:
        return <Widget>[
          AppCard(
            radius: 16,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  '${state.statusLabel} · ${state.deadlineText}',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
                const SizedBox(height: 6),
                ..._summaryRows(state.summary),
                const SizedBox(height: 6),
                const Text(
                  '这个家庭的数据已不可逆地匿名化，无法恢复。',
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.5,
                    color: AppColors.pointSpend,
                  ),
                ),
              ],
            ),
          ),
        ];
    }
  }

  /// 后果说明 —— 写具体做了什么，不写「数据将被删除」这种含糊话。
  Widget _warningCard(FamilyDeletion state) {
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            '会发生什么',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 6),
          _line('· 孩子昵称、年龄段、兴趣，以及成员 PIN 会被抹掉；'),
          _line('· 规则 / 习惯 / 心愿的标题与条件、流水备注、审批文本会被替换为「[已删除]」；'),
          _line('· 积分的分数与余额**保留**：账本是追加式的，删掉数值会让对账无法解释；'),
          _line(
            '· 申请后 ${state.summary?.coolingDays ?? FamilyDeletion.coolingDays} 天才会执行，期间可以撤销。',
          ),
          const SizedBox(height: 6),
          const Text(
            '建议先用「导出家庭数据」留一份副本。',
            style: TextStyle(
              fontSize: 12,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }


  List<Widget> _confirmRows() {
    return <Widget>[
      const AppCard(
        radius: 16,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              '确认申请删除？',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                color: AppColors.pointSpend,
              ),
            ),
            SizedBox(height: 6),
            Text(
              '再次点击「确认删除」才会提交给服务器。提交后进入冷却期，7 天内可以撤销。',
              style: TextStyle(
                fontSize: 12,
                height: 1.5,
                color: AppColors.textSecondary,
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: <Widget>[
          SmallPill(
            label: '再想想',
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            onTap: widget.store.isDeletionBusy
                ? null
                : () => setState(() => _confirming = false),
          ),
          const SizedBox(width: 10),
          SmallPill(
            label: '确认删除',
            filled: true,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            onTap: widget.store.isDeletionBusy ? null : _request,
          ),
        ],
      ),
    ];
  }

  List<Widget> _summaryRows(FamilyDeletionSummary? summary) {
    if (summary == null) {
      return <Widget>[
        const Text(
          '执行摘要缺失：无法回答这次删了哪些内容。',
          style: TextStyle(fontSize: 12, color: AppColors.pointSpend),
        ),
      ];
    }
    final List<MapEntry<String, int>> rows = summary.changedRows;
    return <Widget>[
      if (rows.isEmpty)
        const Text(
          '没有可匿名化的内容（这个家庭没有留下描述性数据）。',
          style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
        )
      else
        for (final MapEntry<String, int> row in rows)
          _line('· ${summary.labelFor(row.key)}：${row.value} 行'),
      const SizedBox(height: 4),
      Text(
        summary.keptText,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: AppColors.textPrimary,
        ),
      ),
      if (summary.note.trim().isNotEmpty) _line(summary.note),
    ];
  }

  Widget _errorCard(ReadApiException? error) {
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            '读取删除状态失败',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            error?.userMessage ?? '删除状态请求失败，原因未知。请重试。',
            style: const TextStyle(
              fontSize: 12,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: SmallPill(label: '重试', onTap: _busy ? null : _bootstrap),
          ),
        ],
      ),
    );
  }

  List<Widget> _unknownRoleRows() {
    final AppStore store = widget.store;
    final ReadApiException? error = store.membersError;
    final bool loading = _busy || store.membersReadStatus == ReadStatus.loading;
    return <Widget>[
      _hint(
        loading
            ? '正在确认你的身份…'
            : '无法确认你的身份（${error?.userMessage ?? '成员列表还没拉到'}），暂时不能判断能不能删除。',
      ),
      if (!loading)
        Align(
          alignment: Alignment.centerRight,
          child: SmallPill(label: '重试', onTap: _bootstrap),
        ),
    ];
  }

  Future<void> _request() async {
    setState(() => _busy = true);
    final String? error = await widget.store.requestFamilyDeletion();
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (error == null) _confirming = false;
    });
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(
        content: Text(
          error ??
              '已提交删除申请：${FamilyDeletion.coolingDays} 天内可以撤销，到期后由后台执行。',
        ),
      ),
    );
  }

  Future<void> _cancel() async {
    setState(() => _busy = true);
    final String? error = await widget.store.cancelFamilyDeletion();
    if (!mounted) return;
    setState(() => _busy = false);
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '已撤销删除申请，数据不会被删除。')),
    );
  }

  String _dateText(DateTime? at) {
    if (at == null) return '时间未知';
    final DateTime local = at.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)}';
  }

  Widget _line(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Text(
        text,
        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
      ),
    );
  }

  Widget _hint(String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 12,
          height: 1.5,
          color: AppColors.textSecondary,
        ),
      ),
    );
  }
}

