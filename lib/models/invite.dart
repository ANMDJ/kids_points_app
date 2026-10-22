import 'point_record.dart' show MemberRole;

/// 一个邀请码最多能被几个人用（与 `backend/src/invites/invite-code.ts` 的
/// `MAX_INVITE_USES` 同口径；后端 DTO 用 `@Max(10)` 兜底）。
const int kMaxInviteUses = 10;

/// 邀请码最长有效期（天），对应后端 `MAX_INVITE_TTL_DAYS = 30`。
const int kMaxInviteTtlDays = 30;

/// 邀请码的**可用状态**（`GET /invites` 的派生结论）。
///
/// 服务端只下发**事实**：`usedCount` / `maxUses` / `expiresAt` / `revoked`
/// （`backend/src/invites/invites.types.ts` 的「不下发结论」纪律）。「还能不能
/// 用」在这里现算 —— 把 `expired` 缓存成一个布尔值，弹窗开着跨过有效期就会说谎。
enum InviteCodeStatus {
  /// 还有名额、没过期、没吊销 —— 可以拿去加入。
  usable,

  /// 名额用完了（`usedCount >= maxUses`）：码本身仍然有效但已经进不来人。
  exhausted,

  /// 过了 `expiresAt`。
  expired,

  /// 家长主动吊销过（服务端 `revoked = true`，重复吊销仍是 200）。
  revoked,
}

/// 状态徽标文案（双端口径一致，见 `kids_points_mp/src/data/types.ts`）。
String inviteCodeStatusLabel(InviteCodeStatus status) {
  switch (status) {
    case InviteCodeStatus.usable:
      return '可用';
    case InviteCodeStatus.exhausted:
      return '已用完';
    case InviteCodeStatus.expired:
      return '已过期';
    case InviteCodeStatus.revoked:
      return '已吊销';
  }
}

/// 邀请码（`GET /invites` 的一行 / `POST /invites` 的回包）。
///
/// `role` 复用 [MemberRole]，但邀请码**只会**是 `child` / `guardian`：
/// `viewer` 不是合法目标角色（后端 `CreateInviteDto` 用 `@IsIn` 拒绝），
/// `mapInvite` 遇到它会显式报错，而不是画出一张「加入后什么都做不了」的票。
class InviteCode {
  const InviteCode({
    required this.id,
    required this.code,
    required this.role,
    required this.maxUses,
    required this.usedCount,
    required this.expiresAt,
    required this.revoked,
    required this.createdAt,
  });

  final String id;

  /// 服务端生成的 8 位码（不含 0/O/1/I/L），客户端**不改写**它。
  final String code;
  final MemberRole role;
  final int maxUses;
  final int usedCount;
  final DateTime expiresAt;
  final bool revoked;
  final DateTime createdAt;

  /// 还剩几个名额（服务端理论上不会让 `usedCount` 超过 `maxUses`，这里仍夹到 0，
  /// 避免一个越界的行被画成负数）。
  int get remainingUses {
    final int left = maxUses - usedCount;
    return left > 0 ? left : 0;
  }

  bool isExpiredAt(DateTime now) => !expiresAt.isAfter(now);

  /// 某个时刻的状态。三类「不能用」按**最确定的事实**排序：
  /// 已吊销 ⇒ 已用完 ⇒ 已过期（一个码可能同时满足多条，徽标只说最重要的那条）。
  InviteCodeStatus statusAt(DateTime now) {
    if (revoked) return InviteCodeStatus.revoked;
    if (usedCount >= maxUses) return InviteCodeStatus.exhausted;
    if (isExpiredAt(now)) return InviteCodeStatus.expired;
    return InviteCodeStatus.usable;
  }

  InviteCodeStatus get status => statusAt(DateTime.now());

  bool get isUsable => status == InviteCodeStatus.usable;

  /// 吊销成功后的本地副本：服务端回包只有 `{id, revoked: true}`，
  /// 其余事实保持不变（不重拉也能立刻把按钮收掉）。
  InviteCode revokedCopy() {
    return InviteCode(
      id: id,
      code: code,
      role: role,
      maxUses: maxUses,
      usedCount: usedCount,
      expiresAt: expiresAt,
      revoked: true,
      createdAt: createdAt,
    );
  }

  String get statusLabel => inviteCodeStatusLabel(status);

  /// 角色徽标文案；`viewer` 只在历史数据里出现（邀请码不该出现）。
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

  /// 「已用 1/3」—— 名额是这张票最要紧的信息，放在最前面。
  String get usageText => '已用 $usedCount/$maxUses';

  /// 「有效至 2026-11-01 12:00」—— 本地时区；绝对时刻才有用，
  /// 「还有 7 天」会随刷新漂移。
  String get expiresText => '有效至 ${_dateTimeText(expiresAt)}';

  /// 展示用的分组：`ABCD2345` ⇒ `ABCD-2345`（与后端 `formatInviteCode` 同形）。
  ///
  /// **只用于展示**：复制出去的仍是原始 [code]，服务端 `normalizeInviteCode`
  /// 会去掉连字符，两种写法都能加入。
  String get displayCode {
    if (code.length != 8) return code;
    return '${code.substring(0, 4)}-${code.substring(4)}';
  }
}

String _two(int value) => value.toString().padLeft(2, '0');

String _dateTimeText(DateTime value) {
  final DateTime local = value.toLocal();
  return '${local.year}-${_two(local.month)}-${_two(local.day)} '
      '${_two(local.hour)}:${_two(local.minute)}';
}
