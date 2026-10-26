import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../data/read_api_errors.dart';
import '../../models/consent.dart';
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/pills.dart';
import '../../widgets/sheet_frame.dart';

/// 打开「监护人同意」面板（W7-B）—— 入口固定在「我的」页。
Future<void> showConsentSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return ConsentSheet(store: store, messenger: messenger);
    },
  );
}

/// 监护人同意（W7-B）：家长查看 / 作出 / 撤回，孩子只能看到「找家长」。
///
/// ── 为什么先拉成员、再拉同意 ─────────────────────────────────────────────────
///   `view_consent` / `manage_consent` 在矩阵里只有 guardian ALLOW，而客户端
///   判断「我是不是家长」只能靠 `GET /members` 里的 `isSelf` 那一行。
///   若直接拉同意：孩子必然吃一个 403 —— 用一次注定失败的请求去「探测」角色，
///   既慢又会把「没有权限」画成「加载失败」。所以先 `refreshMembers()`。
///
/// ── 为什么「撤回」也要在这里做 ───────────────────────────────────────────────
///   撤回后 `ConsentGuard`（W7-A 第四道屏障）会拦掉写动作，但**读取**与
///   **重新同意**是豁免的。面板必须把这句话写出来，否则家长会以为
///   「撤回 = 数据被删了」，或者撤回后再也回不来。
class ConsentSheet extends StatefulWidget {
  const ConsentSheet({super.key, required this.store, required this.messenger});

  final AppStore store;
  final ScaffoldMessengerState messenger;

  @override
  State<ConsentSheet> createState() => _ConsentSheetState();
}

class _ConsentSheetState extends State<ConsentSheet> {
  /// 有读请求（成员 / 同意状态）在途。
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // 必须等首帧之后再拉：`refreshMembers` 一开始就会 `_notify()`（置成 loading），
    // 在 initState 里同步调用等于 build 期间 setState。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _bootstrap();
    });
  }

  /// 先确认角色，再决定拉不拉同意状态。
  Future<void> _bootstrap() async {
    final AppStore store = widget.store;
    setState(() => _busy = true);
    if (store.isLiveMode && store.selfMember == null) {
      await store.refreshMembers();
    }
    if (!mounted) return;
    if (store.canManageConsent) {
      await store.refreshConsent();
    }
    if (!mounted) return;
    setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final bool canManage = widget.store.canManageConsent;

    return SheetFrame(
      title: '监护人同意',
      subtitle: canManage
          ? '孩子资料的收集与使用，需要监护人明确同意'
          : '只有家长可以查看和修改同意状态',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: _body(canManage),
      ),
    );
  }

  List<Widget> _body(bool canManage) {
    final AppStore store = widget.store;
    if (!store.isLiveMode) {
      // 预览模式没有真实同意记录 —— 编一个「已同意」会让人以为合规动作已经做过。
      return <Widget>[
        _hint('预览模式没有真实的同意记录。接入后端后才能作出或撤回同意。'),
      ];
    }
    if (store.selfMember == null) {
      // 角色未知（成员列表没拉到 / 403 / 断网）：既不能给按钮也不能说
      // 「你不是家长」—— 两种猜法都会把真实原因藏起来。
      return <Widget>[
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        const SizedBox(height: 8),
        ..._memberStatusRows(),
      ];
    }
    if (!canManage) {
      return <Widget>[
        _hint(
          '你的身份是${store.selfMember!.roleLabel}，不能查看或修改同意状态。\n'
          '需要作出/撤回同意时，请让家里的家长在「我的 → 监护人同意」里操作。',
        ),
      ];
    }

    final GuardianConsent consent = store.consent;
    // 「未同意」只有在服务端真的这样说过时才能显示：只读快照还是本地初值
    // （未拉到 / 403 / 断网）时，把它画成「未同意」会诱导家长去点一个
    // 可能重复同意、也可能必然失败的按钮。
    final bool known =
        consent.childId.isNotEmpty || store.consentReadStatus == ReadStatus.ready;
    return <Widget>[
      if (_busy) const LinearProgressIndicator(minHeight: 2),
      _stateCard(consent, known),
      const SizedBox(height: 14),
      ..._consentStatusRows(),
      if (!known)
        _hint(
          store.consentReadStatus == ReadStatus.loading
              ? '正在读取同意状态…'
              : '同意状态未知，暂时不能操作。请重试或稍后再打开。',
        )
      else if (consent.isGranted)
        _withdrawCard()
      else
        _grantCard(),
      const SizedBox(height: 4),
      _hint(
        '撤回同意后，打卡、规则、心愿等写入会暂停（服务端返回 403 CONSENT_REQUIRED），'
        '读取和「重新同意」不受影响。撤回不会删除已经发生的数据。',
      ),
    ];
  }

  /// 当前状态卡：状态 + 协议版本 + 两个时间点。
  Widget _stateCard(GuardianConsent consent, bool known) {
    final List<String> lines = <String>[
      '协议版本：${consent.versionLabel}',
      if (consent.isGranted) consent.grantedText ?? '同意时间未知',
      if (consent.isWithdrawn) consent.withdrawnText ?? '撤回时间未知',
    ];
    final String pillLabel;
    if (known) {
      pillLabel = consent.statusLabel;
    } else if (widget.store.consentReadStatus == ReadStatus.loading) {
      pillLabel = '加载中';
    } else {
      pillLabel = '状态未知';
    }
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Expanded(
                child: Text(
                  '当前状态',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              SmallPill(
                label: pillLabel,
                filled: known && consent.isGranted,
              ),
            ],
          ),
          const SizedBox(height: 8),
          for (final String line in lines)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Text(
                line,
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.textSecondary,
                ),
              ),
            ),
          if (consent.isGranted && consent.isDraftVersion) ...<Widget>[
            const SizedBox(height: 6),
            const Text(
              '注意：当前协议文本仍是占位版（版本号以 -draft 结尾），'
              '上线前需替换为法务确认的正式文本。',
              style: TextStyle(
                fontSize: 11.5,
                height: 1.5,
                color: AppColors.pointSpend,
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 作出同意：把「同意的是什么」说清楚，再给按钮。
  ///
  /// 请求体只有 `{accepted: true}` —— 版本由服务端决定，客户端不能自报。
  Widget _grantCard() {
    final AppStore store = widget.store;
    final bool busy = store.isConsentWriteBusy;
    final bool withdrawn = store.consent.isWithdrawn;
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            withdrawn ? '重新同意' : '作出同意',
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            withdrawn
                ? '重新同意后，写入会恢复。协议版本以服务端当前配置为准。'
                : '同意后，孩子的积分、习惯、心愿等资料才会按协议处理；'
                    '你可以随时在这里撤回。',
            style: const TextStyle(
              fontSize: 12,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: SmallPill(
              label: busy ? '提交中…' : (withdrawn ? '重新同意' : '我已阅读并同意'),
              filled: true,
              onTap: busy ? null : _grant,
            ),
          ),
        ],
      ),
    );
  }

  /// 撤回同意：危险操作，二次确认后才发请求。
  Widget _withdrawCard() {
    final AppStore store = widget.store;
    final bool busy = store.isConsentWriteBusy;
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            '撤回同意',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            '撤回后写入会立即暂停，已经发生的数据保留；重新同意即可恢复。',
            style: TextStyle(
              fontSize: 12,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: _DangerPill(
              label: busy ? '撤回中…' : '撤回同意',
              onTap: busy ? null : _withdraw,
            ),
          ),
        ],
      ),
    );
  }

  /// 状态加载失败行（失败时保留已有快照，不清成「未同意」）。
  List<Widget> _consentStatusRows() {
    final ReadApiException? error = widget.store.consentError;
    if (error == null) return const <Widget>[];
    return <Widget>[
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Text(
                '同意状态加载失败：${error.userMessage}',
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.pointSpend,
                ),
              ),
            ),
            const SizedBox(width: 8),
            SmallPill(label: '重试', onTap: _busy ? null : _reloadConsent),
          ],
        ),
      ),
    ];
  }

  /// 成员没拉到时的状态行（含重试）—— 角色未知就不能画按钮。
  List<Widget> _memberStatusRows() {
    final ReadApiException? error = widget.store.membersError;
    if (error == null) {
      return <Widget>[
        const Text(
          '正在确认你的家庭成员身份…',
          style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
        ),
      ];
    }
    return <Widget>[
      Row(
        children: <Widget>[
          Expanded(
            child: Text(
              '无法确认你的家庭成员身份：${error.userMessage}',
              style: const TextStyle(
                fontSize: 12,
                color: AppColors.pointSpend,
              ),
            ),
          ),
          const SizedBox(width: 8),
          SmallPill(label: '重试', onTap: _busy ? null : _bootstrap),
        ],
      ),
    ];
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

  Future<void> _reloadConsent() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.store.refreshConsent();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  Future<void> _grant() async {
    final AppStore store = widget.store;
    if (store.isConsentWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(store.consentReadOnlyWriteMessage)),
      );
      return;
    }
    setState(() {});
    final String? error = await store.submitGrantConsent();
    if (!mounted) return;
    setState(() {});
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '已记录同意，谢谢你的信任')),
    );
  }

  Future<void> _withdraw() async {
    final AppStore store = widget.store;
    if (store.isConsentWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(store.consentReadOnlyWriteMessage)),
      );
      return;
    }
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text('撤回同意'),
          content: const Text(
            '确定撤回监护人同意吗？\n'
            '撤回后打卡、规则、心愿等写入会立即暂停，读取和重新同意不受影响；'
            '已经发生的数据不会被删除。',
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('撤回'),
            ),
          ],
        );
      },
    );
    if (ok != true || !mounted) return;

    setState(() {});
    final String? error = await store.submitWithdrawConsent();
    if (!mounted) return;
    setState(() {});
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '已撤回同意，写入已暂停')),
    );
  }
}

/// 危险操作胶囊（「撤回同意」）：与 SmallPill 同形，换成告警色。
class _DangerPill extends StatelessWidget {
  const _DangerPill({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Opacity(
        opacity: onTap == null ? 0.5 : 1,
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
      ),
    );
  }
}
