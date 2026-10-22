import 'point_record.dart' show MemberRole;

/// 成员位的**库内状态**（`MemberStatus`）。
///
/// 服务端 `GET /members` 不发 `removed` 行（`mapMember` 仍会解析 `status`），
/// 保留这个枚举是为了「线格式只下发事实」：将来若加 `includeRemoved`，
/// 界面不需要重新定义一套状态。
enum MemberStatus { active, removed }

/// 家庭成员（`GET /members` 的一行）。
///
/// **只有事实**：`memberId` / `userId` / 昵称 / 角色 / 状态 / 时间 / `isSelf`。
/// 没有 `canChangeRole` / `canRemove` —— 「我是家长」由
/// `AppStore.canManageMembers` 从 `isSelf` 那一行推出来，服务端仍是最终裁决者
/// （被拒绝时按 403 的 `code` 解释原因）。
class FamilyMember {
  const FamilyMember({
    required this.memberId,
    required this.userId,
    required this.displayName,
    required this.role,
    required this.status,
    required this.joinedAt,
    required this.removedAt,
    required this.isSelf,
  });

  final String memberId;
  final String userId;

  /// 服务端原样下发的昵称；null = 没设置（界面用「未命名成员」占位）。
  final String? displayName;
  final MemberRole role;
  final MemberStatus status;
  final DateTime joinedAt;
  final DateTime? removedAt;

  /// 服务端算的「这一行是不是我」：客户端不知道自己的 userId。
  final bool isSelf;

  bool get isActive => status == MemberStatus.active;

  /// 昵称的展示值：空白与 null 都不能画成一行空白（那看起来像加载失败）。
  String get nameLabel {
    final String raw = (displayName ?? '').trim();
    return raw.isEmpty ? '未命名成员' : raw;
  }

  /// 角色徽标文案；`viewer` 只在历史数据里出现。
  String get roleLabel {
    switch (role) {
      case MemberRole.guardian:
        return '家长';
      case MemberRole.child:
        return '孩子';
      case MemberRole.viewer:
        return '访客';
    }
  }

  /// 「2026-10-01 加入」—— 本地时区；不做「几天前」这类会随刷新漂移的文案。
  String get joinedText => '${_dateText(joinedAt)} 加入';

  /// 可切换到的另一个角色；家长 ⇒ 孩子，孩子 ⇒ 家长。
  ///
  /// 返回 null 表示「没有可切的角色」（`viewer` 不是合法目标角色，见
  /// `25-w5h-handoff.md` §5）。真正提交前仍会被服务端屏障二复核。
  MemberRole? get switchableRole {
    switch (role) {
      case MemberRole.guardian:
        return MemberRole.child;
      case MemberRole.child:
        return MemberRole.guardian;
      case MemberRole.viewer:
        return null;
    }
  }

  /// 「设为孩子 / 设为家长」按钮文案。
  String? get switchableRoleLabel {
    final MemberRole? target = switchableRole;
    if (target == null) return null;
    return target == MemberRole.child ? '设为孩子' : '设为家长';
  }
}

String _two(int value) => value.toString().padLeft(2, '0');

String _dateText(DateTime value) {
  final DateTime local = value.toLocal();
  return '${local.year}-${_two(local.month)}-${_two(local.day)}';
}
