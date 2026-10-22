import 'package:flutter/material.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../data/read_api_errors.dart';
import '../../models/member.dart';
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/pills.dart';
import '../../widgets/sheet_frame.dart';

/// 打开「家庭成员」面板（W5-H）—— 入口固定在「我的」页，与 Taro 侧同一处。
Future<void> showMemberSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return MemberSheet(store: store, messenger: messenger);
    },
  );
}

/// 家庭成员（W5-H）：谁在这个家庭里、各自是什么角色。
///
/// 服务端只下发**事实**（`role` / `status` / `isSelf`），本组件据
/// `store.canManageMembers`（= 自己那一行是不是家长）决定给不给按钮；
/// 真正的拒绝（403 / 409）由 store 原样上报，这里只负责展示原因。
///
/// 自己的那一行**永远没有**写按钮：后端两条路由都禁止作用于自己 ——
/// 自我降级会把自己锁在门外，而「移出自己」等于退出家庭。
class MemberSheet extends StatefulWidget {
  const MemberSheet({super.key, required this.store, required this.messenger});

  final AppStore store;
  final ScaffoldMessengerState messenger;

  @override
  State<MemberSheet> createState() => _MemberSheetState();
}

class _MemberSheetState extends State<MemberSheet> {
  /// 有读请求（首次拉取 / 重试）在途；写请求的忙碌状态由
  /// `store.busyMemberId` 表达（逐行禁用，而不是整块灰掉）。
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // 必须等首帧之后再拉：`refreshMembers` 一开始就会 `_notify()`（置成 loading），
    // 在 initState 里同步调用等于 build 期间 setState。
    // 失败**不弹窗**：错误留在 `store.membersError` 里由页面照实展示。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.store.refreshMembers().then((_) {
        if (mounted) setState(() {});
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    final List<FamilyMember> members = widget.store.members;
    final bool canManage = widget.store.canManageMembers;

    return SheetFrame(
      title: '家庭成员',
      subtitle: canManage
          ? '你是家长，可以调整成员角色或把成员移出家庭'
          : '你是成员，只有家长可以调整角色或移出成员',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          ..._statusRows(),
          if (members.isEmpty) _emptyState() else ...members.map(_row),
        ],
      ),
    );
  }

  /// 一行成员：昵称 + 角色徽标 + 加入时间；家长看别人时多两个写入口。
  Widget _row(FamilyMember member) {
    final bool busy = widget.store.busyMemberId == member.memberId;
    final bool canManageThis = widget.store.canManageMembers && !member.isSelf;
    final String? switchLabel = member.switchableRoleLabel;

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
                    member.nameLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
                if (member.isSelf) const SmallPill(label: '你', filled: true),
                if (member.isSelf) const SizedBox(width: 6),
                SmallPill(label: member.roleLabel),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              member.joinedText,
              style: const TextStyle(
                fontSize: 11.5,
                color: AppColors.textSecondary,
              ),
            ),
            if (canManageThis && switchLabel != null) ...<Widget>[
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: <Widget>[
                  SmallPill(
                    label: switchLabel,
                    onTap: busy ? null : () => _changeRole(member),
                  ),
                  const SizedBox(width: 8),
                  _DangerPill(
                    label: busy ? '处理中…' : '移出',
                    onTap: busy ? null : () => _remove(member),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// 空态必须区分**没拉到**与**真的没有** —— 403 / 断网时显示「没有成员」
  /// 会让家长以为家人都被移出了。
  Widget _emptyState() {
    final String text;
    final ReadStatus status = widget.store.membersReadStatus;
    if (widget.store.membersError != null) {
      text = '成员列表没能加载';
    } else if (status == ReadStatus.loading) {
      text = '正在加载成员…';
    } else if (!widget.store.isLiveMode) {
      text = '预览模式没有家庭成员信息';
    } else {
      text = '成员列表是空的';
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
    final ReadStatus status = widget.store.membersReadStatus;
    if (status == ReadStatus.loading && widget.store.members.isEmpty) {
      rows.add(
        const Padding(
          padding: EdgeInsets.only(bottom: 10),
          child: Text(
            '正在加载成员…',
            style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
          ),
        ),
      );
    }
    final ReadApiException? error = widget.store.membersError;
    if (error != null) {
      rows.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  '成员加载失败：${error.userMessage}',
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
    await widget.store.refreshMembers();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  /// 切换角色前先确认：两个方向都会改变**权限**（家长 ⇄ 孩子），
  /// 点错一下不该悄悄生效。真正的判定仍由服务端做出。
  Future<void> _changeRole(FamilyMember member) async {
    if (widget.store.isMemberWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(widget.store.memberReadOnlyWriteMessage)),
      );
      return;
    }
    final String? label = member.switchableRoleLabel;
    if (label == null) return;
    final bool confirmed = await _confirm(
      title: '确认调整角色',
      message: '确定把“${member.nameLabel}”$label吗？'
          '角色决定谁可以修改规则、批准申请和管理成员。',
      confirmLabel: label,
    );
    if (!confirmed || !mounted) return;

    final String? error = await widget.store.submitChangeMemberRole(member);
    if (!mounted) return;
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '角色已更新')),
    );
  }

  Future<void> _remove(FamilyMember member) async {
    if (widget.store.isMemberWriteReadOnly) {
      widget.messenger.showSnackBar(
        SnackBar(content: Text(widget.store.memberReadOnlyWriteMessage)),
      );
      return;
    }
    final bool confirmed = await _confirm(
      title: '移出成员',
      message: '确定把“${member.nameLabel}”移出家庭吗？'
          '移出后 TA 将无法再访问这个家庭的数据。',
      confirmLabel: '移出',
    );
    if (!confirmed || !mounted) return;

    final String? error = await widget.store.submitRemoveMember(member);
    if (!mounted) return;
    widget.messenger.showSnackBar(
      SnackBar(content: Text(error ?? '已移出“${member.nameLabel}”')),
    );
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

/// 危险操作胶囊（“移出”）：与 [SmallPill] 同形，换成告警色。
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
