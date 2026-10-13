import 'point_record.dart' show MemberRole;

/// 审计动作 —— **枚举**（编译期穷尽），修 C11。
///
/// 刻意**不用** `String action`：字符串里的拼写漂移（`point_rule.updte`）不会报错，
/// 只会在几个月后"查不到那次改动"时才被发现 —— 与 E16 用枚举取代数组下标同理。
///
/// 白名单（`02` §5 与 `backend/prisma/schema.prisma` 的 `AuditAction`）共五类：
/// 规则 / 心愿 / 习惯 / 成员 / 同意。本端只有前四类的部分动作可达：
///   - `memberRename` —— 成员改名（"我的"页可达）；
///   - ❌ **成员增删 / 角色切换 / 家长同意（consent）**：前端没有对应入口，
///     **未实现**，故**不在**本枚举里 —— 不假装覆盖（见 docs/design/03 §C11）。
enum AuditAction {
  pointRuleCreate('point_rule.create'),
  pointRuleUpdate('point_rule.update'),
  pointRuleDelete('point_rule.delete'),
  pointRuleRestore('point_rule.restore'),
  pointRulePurge('point_rule.purge'),
  wishCreate('wish.create'),
  wishDelete('wish.delete'),
  wishRestore('wish.restore'),
  wishPurge('wish.purge'),
  habitCreate('habit.create'),
  habitDelete('habit.delete'),
  habitRestore('habit.restore'),
  habitPurge('habit.purge'),
  pointRecordCheckIn('point_record.check_in'),
  pointRecordUndoCheckIn('point_record.undo_check_in'),
  pointRecordQuickNote('point_record.quick_note'),
  pointRecordRedeem('point_record.redeem'),
  memberRename('member.rename');

  const AuditAction(this.wireName);

  /// 与后端 / Taro 侧一致的线值（日志、审计导出里可读）
  final String wireName;
}

/// 审计对象类型（与 [AuditAction] 的前缀一一对应）。
enum AuditTargetType {
  pointRule('point_rule'),
  wish('wish'),
  habit('habit'),
  pointRecord('point_record'),
  member('member');

  const AuditTargetType(this.wireName);

  final String wireName;
}

/// 审计里的变更快照（`before` / `after`）。
typedef AuditSnapshot = Map<String, Object?>;

/// 一条审计记录 —— **追加式**（只增不删、永不更新），修 C11。
///
/// 与后端 `AuditLog`（`backend/prisma/schema.prisma`）同构：
/// `action` / `targetType` / `targetId` / `before` / `after`（JSON 快照）/
/// `actorRole` / `createdAt`（此处为 [time]）。
class AuditEntry {
  AuditEntry({
    required this.id,
    required this.action,
    required this.targetType,
    required this.targetId,
    required this.before,
    required this.after,
    required this.actorRole,
    required this.time,
  });

  final String id;
  final AuditAction action;
  final AuditTargetType targetType;
  final String targetId;

  /// **变更前**快照；新增类动作（create）为 null
  final AuditSnapshot? before;

  /// **变更后**快照；删除类动作保留末态
  final AuditSnapshot? after;

  final MemberRole actorRole;
  final DateTime time;
}

/// 深度拷贝一个 JSON 形状的值（标量原样返回，语义上不可变）。
Object? _deepCopyValue(Object? value) {
  if (value is Map) {
    return <String, Object?>{
      for (final MapEntry<Object?, Object?> entry in value.entries)
        '${entry.key}': _deepCopyValue(entry.value),
    };
  }
  if (value is List) {
    return value.map(_deepCopyValue).toList();
  }
  // String / int / bool / DateTime / null 都是不可变值，直接引用即安全
  return value;
}

/// 生成**真快照** —— 深拷贝。
///
/// 若只存 Map 的浅拷贝，写入审计之后原对象一改，"变更前后"会同时指向那批已变形的
/// 值，审计就成了摆设（这正是 C11 要防的"看起来在做安全"）。
/// 08 §6 把这一条列为**测试全绿也抓不到**的失败形态之一：
/// 断言 `auditLog.length == 1` 会全绿，快照其实是活的 ——
/// 抓法是"写完审计再改原对象，再读审计，内容必须不变"。
AuditSnapshot auditSnapshotOf(Map<String, Object?> fields) =>
    _deepCopyValue(fields)! as AuditSnapshot;
