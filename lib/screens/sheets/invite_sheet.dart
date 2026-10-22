import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../data/read_api_errors.dart';
import '../../models/invite.dart';
import '../../models/point_record.dart' show MemberRole;
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/pills.dart';
import '../../widgets/sheet_frame.dart';

/// 打开「邀请码」面板（W5-I）—— 入口固定在「我的」页（与 Taro 侧同一处）。
Future<void> showInviteSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return InviteSheet(store: store, messenger: messenger);
    },
  );
}

/// 邀请码（W5-I）：家长生成 / 查看 / 吊销，孩子只能看到「找家长要」。
///
/// ── 为什么先拉成员、再拉邀请码 ───────────────────────────────────────────────
///   `invite_member` 在矩阵里只有 guardian ALLOW，而客户端判断「我是不是家长」
///   只能靠 `GET /members` 里的 `isSelf` 那一行。若直接拉邀请码：
///     · 家长：能成功，但没有 `selfMember` 时界面仍不知道该不该给按钮；
///     · 孩子：必然吃一个 403 —— 用一次注定失败的请求去「探测」角色，
///       既慢又会把「没有权限」画成「加载失败」。
///   所以先 `refreshMembers()`，拿到角色后再决定要不要拉列表。
///
/// ── 为什么列表不缓存「状态结论」 ────────────────────────────────────────────
///   「可用 / 已用完 / 已过期 / 已吊销」由 [InviteCode.statusAt] 在 build 时
///   现算：弹窗开着跨过有效期时，缓存下来的 `expired` 会说谎。
class InviteSheet extends StatefulWidget {
  const InviteSheet({super.key, required this.store, required this.messenger});

  final AppStore store;
  final ScaffoldMessengerState messenger;

  @override
  State<InviteSheet> createState() => _InviteSheetState();
}

class _InviteSheetState extends State<InviteSheet> {
  /// 有读请求（成员 / 邀请码）在途。
  bool _busy = false;

  /// 生成表单的三个选择（默认：孩子 · 1 人 · 7 天 —— 最常见的「给另一个孩子开号」）。
  MemberRole _role = MemberRole.child;
  int _maxUses = 1;
  int _expiresInDays = 7;

  static const List<int> _useOptions = <int>[1, 3, 5];
  static const List<int> _ttlOptions = <int>[1, 7, 30];

  @override
  void initState() {
    super.initState();
    // 必须等首帧之后再拉：`refreshMembers` 一开始就会 `_notify()`（置成 loading），
    // 在 initState 里同步调用等于 build 期间 setState。
    // 失败**不弹窗**：错误留在 store 上，由面板照实展示。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _bootstrap();
    });
  }

  /// 先确认角色，再决定拉不拉邀请码列表。
  Future<void> _bootstrap() async {
    final AppStore store = widget.store;
    setState(() => _busy = true);
    if (store.isLiveMode && store.selfMember == null) {
      await store.refreshMembers();
    }
    if (!mounted) return;
    if (store.canManageInvites) {
      await store.refreshInvites();
    }
    if (!mounted) return;
    setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final bool canManage = widget.store.canManageInvites;

    return SheetFrame(
      title: '邀请码',
      subtitle: canManage
          ? '生成邀请码发给家人，让对方加入这个家庭'
          : '只有家长可以生成和查看邀请码',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: _body(canManage),
      ),
    );
  }

  List<Widget> _body(bool canManage) {
    final AppStore store = widget.store;
    if (!store.isLiveMode) {
      // 预览模式没有真实家庭，也没有邀请码可发 —— 编一个假码会让人真的去试。
      return <Widget>[
        _hint('预览模式没有真实的邀请码。接入后端后才能生成和吊销邀请码。'),
      ];
    }
    if (store.selfMember == null) {
      // 角色未知（成员列表没拉到 / 403 / 断网）：此时既不能给表单也不能说
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
          '你的身份是${store.selfMember!.roleLabel}，不能生成或查看邀请码。\n'
          '需要加入新成员时，请让家里的家长在「我的 → 邀请码」里生成一个码给你。',
        ),
      ];
    }
    final List<InviteCode> invites = store.invites;
    return <Widget>[
      if (_busy) const LinearProgressIndicator(minHeight: 2),
      _createCard(),
      const SizedBox(height: 14),
      ..._inviteStatusRows(),
      if (invites.isEmpty) _emptyState() else ...invites.map(_inviteRow),
      const SizedBox(height: 4),
      _hint('邀请码就是钥匙：拿到码的人可以加入这个家庭，只发给信任的人。'
          '吊销后立即失效，已加入的成员不受影响。'),
    ];
  }

  /// 生成表单：角色 / 名额 / 有效期。三个都是**封闭选项** ——
  /// 自由输入只会换来后端 400（`@Min/@Max`），不如直接给出合法集合。
  Widget _createCard() {
    final AppStore store = widget.store;
    final bool busy = store.isInviteWriteBusy;

    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            '生成新邀请码',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 10),
          _label('邀请谁'),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: <Widget>[
              for (final MemberRole role in <MemberRole>[
                MemberRole.child,
                MemberRole.guardian,
              ])
                SoftChip(
                  label: role == MemberRole.child ? '孩子' : '家长',
                  selected: _role == role,
                  onTap: busy ? () {} : () => setState(() => _role = role),
                ),
            ],
          ),
          const SizedBox(height: 10),
          _label('可以被几个人使用'),
          Wrap(
            spacing: 8,
            children: <Widget>[
              for (final int value in _useOptions)
                SoftChip(
                  label: '$value 人',
                  selected: _maxUses == value,
                  onTap: busy ? () {} : () => setState(() => _maxUses = value),
                ),
            ],
          ),
          const SizedBox(height: 10),
          _label('有效期'),
          Wrap(
            spacing: 8,
            children: <Widget>[
              for (final int days in _ttlOptions)
                SoftChip(
                  label: days == 1 ? '1 天' : '$days 天',
                  selected: _expiresInDays == days,
                  onTap:
                      busy ? () {} : () => setState(() => _expiresInDays = days),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Align(
            alignment: Alignment.centerRight,
            child: SmallPill(
              label: busy ? '生成中…' : '生成邀请码',
              filled: true,
              onTap: busy ? null : _create,
            ),
          ),
        ],
      ),
    );
  }

  /// 一行邀请码：码 + 状态 + 角色 / 名额 / 有效期 + 复制 / 吊销。
  Widget _inviteRow(InviteCode invite) {
    final AppStore store = widget.store;
    final DateTime now = DateTime.now();
    final InviteCodeStatus status = invite.statusAt(now);
    final bool rowBusy = store.busyInviteId == invite.id;
    final bool canRevoke = status != InviteCodeStatus.revoked;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        radius: 16,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    invite.displayCode,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 19,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.6,
                      fontFeatures: <FontFeature>[FontFeature.tabularFigures()],
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
                SmallPill(
                  label: inviteCodeStatusLabel(status),
                  filled: status == InviteCodeStatus.usable,
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              '${invite.roleLabel}邀请码 · ${invite.usageText}',
              style: const TextStyle(
                fontSize: 12,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              invite.expiresText,
              style: const TextStyle(
                fontSize: 11.5,
                color: AppColors.textHint,
              ),
            ),
            const SizedBox(height: 10),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: <Widget>[
                SmallPill(label: '复制', onTap: () => _copy(invite)),
                if (canRevoke) ...<Widget>[
                  const SizedBox(width: 8),
                  _DangerPill(
                    label: rowBusy ? '吊销中…' : '吊销',
                    onTap: store.isInviteWriteBusy ? null : () => _revoke(invite),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          color: AppColors.textSecondary,
        ),
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

  /// 空态必须区分**没拉到**与**真的没有** —— 403 / 断网时显示「还没有邀请码」
  /// 会让家长以为自己的码被删了。
  Widget _emptyState() {
    final String text;
    final ReadStatus status = widget.store.invitesReadStatus;
    if (widget.store.invitesError != null) {
      text = '邀请码列表没能加载';
    } else if (status == ReadStatus.loading) {
      text = '正在加载邀请码…';
    } else {
      text = '还没有生成过邀请码';
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
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

  /// 成员没拉到时的状态行（含重试）—— 角色未知就不能画表单。
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

  /// 邀请码列表的加载状态行（失败时保留已有行）。
  List<Widget> _inviteStatusRows() {
    final ReadApiException? error = widget.store.invitesError;
    if (error == null) return const <Widget>[];
    return <Widget>[
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Row(
          children: <Widget>[
            Expanded(
              child: Text(
                '邀请码加载失败：${error.userMessage}',
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.pointSpend,
                ),
              ),
            ),
            const SizedBox(width: 8),
            SmallPill(label: '重试', onTap: _busy ? null : _reloadInvites),
          ],
        ),
      ),
    ];
  }

  Future<void> _reloadInvites() async {
    if (_busy) return;
    setState(() => _busy = true);
    await widget.store.refreshInvites();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  Future<void> _create() async {
    final AppStore store = widget.store;
    if (store.isInviteWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(store.inviteReadOnlyWriteMessage)),
      );
      return;
    }
    setState(() {});
    final String? error = await store.submitCreateInvite(
      role: _role,
      maxUses: _maxUses,
      expiresInDays: _expiresInDays,
    );
    if (!mounted) return;
    setState(() {});
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '邀请码已生成，复制后发给家人')),
    );
  }

  void _copy(InviteCode invite) {
    // 复制**原始码**（不带连字符）：即使对方用的客户端不会 normalize，
    // 也能直接粘进输入框；带连字符的展示形式只是给人读的。
    Clipboard.setData(ClipboardData(text: invite.code));
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(content: Text('已复制邀请码 ${invite.displayCode}')),
    );
  }

  Future<void> _revoke(InviteCode invite) async {
    final AppStore store = widget.store;
    if (store.isInviteWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(store.inviteReadOnlyWriteMessage)),
      );
      return;
    }
    final bool? ok = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text('吊销邀请码'),
          content: Text(
            '确定吊销 ${invite.displayCode} 吗？\n'
            '吊销后这个码不能再用来加入家庭，已经加入的成员不受影响。',
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('吊销'),
            ),
          ],
        );
      },
    );
    if (ok != true || !mounted) return;

    setState(() {});
    final String? error = await store.submitRevokeInvite(invite);
    if (!mounted) return;
    setState(() {});
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '已吊销 ${invite.displayCode}')),
    );
  }
}

/// 危险操作胶囊（「吊销」）：与 [SmallPill] 同形，换成告警色。
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
