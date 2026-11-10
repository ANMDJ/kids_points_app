import 'package:flutter/material.dart';

import '../models/approval.dart';
import '../models/consent.dart';
import '../models/family_deletion.dart';
import '../models/family_export.dart';
import '../models/habit.dart';
import '../models/invite.dart';
import '../models/member.dart';
import '../models/point_record.dart';
import '../models/point_rule.dart';
import '../models/trash.dart';
import '../models/wish.dart';
import '../theme/app_colors.dart';
import '../theme/app_icons.dart';
import 'read_api_errors.dart';
import 'read_dto.dart';

/// 首页快照的**本地形态**：把线上 DTO 映射成 UI 已经在用的模型。
///
/// 为什么要这一层：页面（`HomeScreen` 等）现在消费的是 `Habit` / `PointRule` /
/// `Wish` / `PointRecord`。若让页面直接读 DTO，服务端字段一改就得改 UI；
/// 反过来，映射出错时错误也只会在这里**显式**抛出，不会变成界面上的空列表。
class HomeSnapshot {
  const HomeSnapshot({
    required this.childId,
    required this.childName,
    required this.pointsBalance,
    required this.goodHabitCount,
    required this.rewardCount,
    required this.habits,
    required this.rules,
    required this.wishes,
  });

  final String childId;
  final String childName;
  final int pointsBalance;
  final int goodHabitCount;
  final int rewardCount;
  final List<Habit> habits;
  final List<PointRule> rules;
  final List<Wish> wishes;
}

/// 一页流水 + 下一页游标。`nextCursor == null` ⇔ 没有更多。
class RecordsPage {
  const RecordsPage({
    required this.records,
    required this.limit,
    required this.hasMore,
    required this.nextCursor,
  });

  final List<PointRecord> records;
  final int limit;
  final bool hasMore;
  final String? nextCursor;
}

/// 线格式 → 本地模型。任何无法解释的枚举 / 颜色都抛 malformed，
/// 不做「猜一个默认值」—— 猜错会显示成一条看似正常的错误流水。
HomeSnapshot mapHome(HomeDto dto) {
  return HomeSnapshot(
    childId: dto.childId,
    childName: dto.childName,
    pointsBalance: dto.pointsBalance,
    goodHabitCount: dto.goodHabitCount,
    rewardCount: dto.rewardCount,
    habits: dto.habits
        .asMap()
        .entries
        .map((MapEntry<int, HabitDto> entry) =>
            mapHabit(entry.value, 'habits[${entry.key}]'))
        .toList(growable: false),
    rules: dto.rules
        .asMap()
        .entries
        .map((MapEntry<int, RuleDto> entry) =>
            mapRule(entry.value, 'rules[${entry.key}]'))
        .toList(growable: false),
    wishes: dto.wishes
        .asMap()
        .entries
        .map((MapEntry<int, WishDto> entry) =>
            mapWish(entry.value, 'wishes[${entry.key}]'))
        .toList(growable: false),
  );
}

/// `GET /trash` → 回收站展示模型（W5-F）。
///
/// `kind` 在 DTO 里是**字符串**，在这里严格转枚举：不认识就抛 malformed ——
/// 不能默默跳过一行（回收站少一条 = 家长以为它已经被彻底删掉了）。
///
/// `expired` 由 [isTrashExpired] 现算（同一份 90 天常量），不信任服务端字段
/// —— 服务端本来也不下发它。
List<TrashItem> mapTrash(TrashListDto dto, {DateTime? now}) {
  final DateTime time = now ?? DateTime.now();
  return dto.items
      .asMap()
      .entries
      .map((MapEntry<int, TrashItemDto> entry) {
        final TrashItemDto item = entry.value;
        final String path = 'items[${entry.key}]';
        final TrashKind? kind = trashKindFromWire(item.kind);
        if (kind == null) {
          throw ReadApiException.malformed(
            '$path.kind',
            detail: '未知回收站类型：${item.kind}',
          );
        }
        return TrashItem(
          kind: kind,
          id: item.id,
          title: item.title,
          deletedAt: item.deletedAt,
          expired: isTrashExpired(item.deletedAt, now: time),
        );
      })
      .toList(growable: false);
}

RecordsPage mapRecordsPage(RecordsPageDto dto) {
  return RecordsPage(
    records: dto.records
        .asMap()
        .entries
        .map((MapEntry<int, RecordDto> entry) =>
            mapRecord(entry.value, 'records[${entry.key}]'))
        .toList(growable: false),
    limit: dto.limit,
    hasMore: dto.hasMore,
    nextCursor: dto.nextCursor,
  );
}

/// 单条习惯 DTO → UI 模型（写端点回包也走这里，避免两套字段解释）。
Habit mapHabit(HabitDto dto, String path) {
  return Habit(
    id: dto.id,
    title: dto.title,
    points: dto.points,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    iconName: dto.icon,
    color: parseHexColor(dto.color, '$path.color'),
    ruleId: dto.ruleId,
  );
}

/// 单条规则 DTO → UI 模型（写端点回包也走这里）。
///
/// `direction` 只用来**校验**：DTO 的 `points` 已经带符号，这里不再取反。
PointRule mapRule(RuleDto dto, String path) {
  if (dto.direction != 'reward' && dto.direction != 'penalty') {
    throw ReadApiException.malformed(
      '$path.direction',
      detail: '未知规则方向：${dto.direction}',
    );
  }
  return PointRule(
    id: dto.id,
    title: dto.title,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    points: dto.points,
    iconName: dto.icon,
    color: parseHexColor(dto.color, '$path.color'),
    currentVersion: dto.currentVersion,
  );
}

/// 单条心愿 DTO → UI 模型（写端点回包也走这里）。
///
/// `coverStyle` 由服务端给定（A–D）；预览模式新增心愿时由本地
/// [pickCoverStyle] 算 —— 两处同一套算法，颜色不会因为“谁写的”而不同。
Wish mapWish(WishDto dto, String path) {
  return Wish(
    id: dto.id,
    title: dto.title,
    cost: dto.cost,
    emoji: dto.emoji,
    coverStyle: parseCoverStyle(dto.coverStyle, '$path.coverStyle'),
    redeemed: dto.redeemed,
  );
}

/// 单条线格式流水 → 本地模型。写端点返回的记录与 `GET /records` 同构，
/// 因此复用同一函数（避免“读取一条口径、写入另一条口径”）。
PointRecord mapRecord(RecordDto dto, [String path = 'record']) {
  final RecordCategory category = parseCategory(dto.category, '$path.category');
  final RecordSource source = parseSource(dto.source, '$path.source');
  final DateTime time = dto.createdAt.toLocal();
  final RecordIcon style = recordIconOf(category, source, dto.points);

  return PointRecord(
    id: dto.id,
    title: dto.title,
    subtitle: recordSubtitle(
      time: time,
      source: source,
      category: category,
      note: dto.note,
    ),
    points: dto.points,
    time: time,
    category: category,
    iconName: style.iconName,
    color: style.color,
    source: source,
    operatorRole: parseOperatorRole(dto.operatorRole, '$path.operatorRole'),
    note: dto.note,
    habitId: dto.habitId,
    ruleId: dto.ruleId,
    ruleVersion: dto.ruleVersion,
    wishId: dto.wishId,
    reversesRecordId: dto.reversesRecordId,
    balanceAfter: dto.balanceAfter,
  );
}

// ───────────────────────────── 线格式枚举 → 本地枚举 ─────────────────────────────

RecordCategory parseCategory(String raw, String path) {
  switch (raw) {
    case 'praise':
      return RecordCategory.praise;
    case 'exchange':
      return RecordCategory.exchange;
    case 'adjust':
      return RecordCategory.adjust;
  }
  throw ReadApiException.malformed(path, detail: '未知流水分类：$raw');
}

RecordSource parseSource(String raw, String path) {
  switch (raw) {
    case 'child_self':
      return RecordSource.childSelf;
    case 'guardian':
      return RecordSource.guardian;
    case 'agent':
      return RecordSource.agent;
    case 'approval':
      return RecordSource.approval;
    case 'system':
      return RecordSource.system;
    case 'correction':
      return RecordSource.correction;
  }
  throw ReadApiException.malformed(path, detail: '未知流水来源：$raw');
}

/// `null` = 系统 / 冲正记录，没有「操作人角色」。
MemberRole? parseOperatorRole(String? raw, String path) {
  if (raw == null) return null;
  switch (raw) {
    case 'guardian':
      return MemberRole.guardian;
    case 'child':
      return MemberRole.child;
    case 'viewer':
      return MemberRole.viewer;
  }
  throw ReadApiException.malformed(path, detail: '未知操作人角色：$raw');
}

WishCoverStyle parseCoverStyle(String raw, String path) {
  switch (raw.toUpperCase()) {
    case 'A':
      return WishCoverStyle.a;
    case 'B':
      return WishCoverStyle.b;
    case 'C':
      return WishCoverStyle.c;
    case 'D':
      return WishCoverStyle.d;
  }
  throw ReadApiException.malformed(path, detail: '未知心愿配色：$raw');
}

/// `#RRGGBB` → Color。只接受这一种写法：后端 `seed` / 写入口都按它存。
Color parseHexColor(String raw, String path) {
  final RegExpMatch? match =
      RegExp(r'^#([0-9a-fA-F]{6})$').firstMatch(raw.trim());
  if (match == null) {
    throw ReadApiException.malformed(path, detail: '颜色必须是 #RRGGBB：$raw');
  }
  return Color(0xFF000000 | int.parse(match.group(1)!, radix: 16));
}

/// `Color` → `#RRGGBB`（写入口只接受这一种写法）。
///
/// alpha 一律丢弃：规则 / 习惯的颜色本来就是不透明的，带上 `#AARRGGBB`
/// 只会被后端 400 拒掉。输出与 seed 数据同口径（小写）。
String hexColorOf(Color color) =>
    '#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

// ───────────────────────── 家长审批收件箱（W5-D） ─────────────────────────

/// 收件箱行 → 本地模型。
///
/// `summary == null`（服务端读不懂 payload，或 `kind` 比客户端新）**原样保留**：
/// 页面据此显示「内容无法识别」并禁用批准。这里绝不编一个空摘要糊过去 ——
/// 那等于让家长在看不见内容的情况下点「批准」。
ApprovalInboxItem mapApprovalInboxItem(ApprovalInboxItemDto dto) {
  return ApprovalInboxItem(
    id: dto.id,
    action: dto.action,
    status: dto.status,
    requesterUserId: dto.requesterUserId,
    decidedByUserId: dto.decidedByUserId,
    executedRecordId: dto.executedRecordId,
    autoReason: dto.autoReason,
    createdAt: dto.createdAt,
    decidedAt: dto.decidedAt,
    expiresAt: dto.expiresAt,
    summary: dto.summary == null ? null : mapApprovalSummary(dto.summary!),
    requesterRole: dto.requesterRole,
  );
}

ApprovalSummary mapApprovalSummary(ApprovalSummaryDto dto) {
  if (dto is RedeemSummaryDto) {
    return RedeemSummary(wishId: dto.wishId, title: dto.title, cost: dto.cost);
  }
  if (dto is BonusSummaryDto) {
    return BonusSummary(
      amount: dto.amount,
      reason: dto.reason,
      ruleId: dto.ruleId,
      habitId: dto.habitId,
      basisTitle: dto.basisTitle,
    );
  }
  if (dto is AddWishSummaryDto) {
    return AddWishSummary(title: dto.title, cost: dto.cost, emoji: dto.emoji);
  }
  // sealed + 穷尽分支：将来新增摘要类型时编译器会在这里报错，逼着补文案。
  throw ReadApiException.malformed('summary.kind',
      detail: '未知的摘要类型 ${dto.runtimeType}');
}

ApprovalsPage mapApprovalsPage(ApprovalsPageDto dto) {
  return ApprovalsPage(
    items: dto.items.map(mapApprovalInboxItem).toList(growable: false),
    hasMore: dto.hasMore,
    nextCursor: dto.nextCursor,
  );
}

// ───────────────────────────── 流水的图标 / 颜色 ─────────────────────────────

class RecordIcon {
  const RecordIcon(this.iconName, this.color);

  final String iconName;
  final Color color;
}

/// 流水没有 `icon` / `color` 字段（账本是结构数据），图标由
/// **(category, source, 正负)** 派生 —— 与 seed 的观感一致，且只有这一处规则。
RecordIcon recordIconOf(
    RecordCategory category, RecordSource source, int points) {
  if (category == RecordCategory.exchange) {
    return const RecordIcon(IconNames.gift, AppColors.orange);
  }
  if (source == RecordSource.correction) {
    return const RecordIcon(IconNames.close, AppColors.pointSpend);
  }
  if (category == RecordCategory.adjust) {
    return points >= 0
        ? const RecordIcon(IconNames.plus, AppColors.pointGain)
        : const RecordIcon(IconNames.minus, AppColors.pointSpend);
  }
  if (source == RecordSource.childSelf) {
    return const RecordIcon(IconNames.check, AppColors.pointGain);
  }
  return const RecordIcon(IconNames.starFill, AppColors.starYellow);
}

// ───────────────────────────── 家庭成员（W5-H） ─────────────────────────────

/// 线格式 → [FamilyMember]。
///
/// `role` / `status` 在 DTO 里是字符串，**只有这里**决定哪些值是认识的：
/// 不认识就抛 [ReadApiException]（一条坏行会让整页显式失败），而不是
/// 猜成 `child` —— 猜错等于把权限边界画错。
FamilyMember mapMember(MemberDto dto, {String path = r'$'}) {
  if (dto.memberId.trim().isEmpty) {
    throw ReadApiException.malformed('$path.memberId', detail: 'memberId 不能为空');
  }
  final MemberRole? role = parseOperatorRole(dto.role, '$path.role');
  if (role == null) {
    throw ReadApiException.malformed('$path.role', detail: '角色不能为空');
  }
  return FamilyMember(
    memberId: dto.memberId,
    userId: dto.userId,
    displayName: dto.displayName,
    role: role,
    status: _memberStatusFromWire(dto.status, '$path.status'),
    joinedAt: dto.joinedAt,
    removedAt: dto.removedAt,
    isSelf: dto.isSelf,
  );
}

List<FamilyMember> mapMembers(MemberListDto dto) {
  return dto.items
      .asMap()
      .entries
      .map((MapEntry<int, MemberDto> entry) =>
          mapMember(entry.value, path: 'items[${entry.key}]'))
      .toList(growable: false);
}

MemberStatus _memberStatusFromWire(String raw, String path) {
  switch (raw) {
    case 'active':
      return MemberStatus.active;
    case 'removed':
      return MemberStatus.removed;
  }
  throw ReadApiException.malformed(path, detail: '未知成员状态：$raw');
}

// ───────────────────────────── 邀请码（W5-I） ─────────────────────────────

/// 线格式 → [InviteCode]。
///
/// 三条本地校验，都是为了**不让界面说谎**：
///   · `role` 不认识（含 `viewer`）⇒ 整次读取失败 —— 邀请码不该能建出 viewer，
///     画成「访客」会让人以为这张票有用；
///   · `maxUses < 1` ⇒ 契约漂移（后端 DTO 是 `@Min(1)`），不能算成「已用完」；
///   · `usedCount` 越界 ⇒ 同样显式失败，不夹成 0/上限（那会隐藏真 bug）。
InviteCode mapInvite(InviteDto dto, {String path = r'$'}) {
  if (dto.id.trim().isEmpty) {
    throw ReadApiException.malformed('$path.id', detail: 'id 不能为空');
  }
  if (dto.code.trim().isEmpty) {
    throw ReadApiException.malformed('$path.code', detail: '邀请码不能为空');
  }
  final MemberRole? role = parseOperatorRole(dto.role, '$path.role');
  if (role == null || role == MemberRole.viewer) {
    // 后端 `CreateInviteDto` 用 `@IsIn(['child','guardian'])`：viewer 出现在
    // 邀请码上是契约漂移，猜成 child 会把邀请的权限画错。
    throw ReadApiException.malformed(
      '$path.role',
      detail: '邀请码角色只能是 guardian / child，收到 ${dto.role}',
    );
  }
  if (dto.maxUses < 1) {
    throw ReadApiException.malformed(
      '$path.maxUses',
      detail: 'maxUses 必须 ≥ 1，收到 ${dto.maxUses}',
    );
  }
  if (dto.usedCount < 0 || dto.usedCount > dto.maxUses) {
    throw ReadApiException.malformed(
      '$path.usedCount',
      detail: 'usedCount 必须在 0..${dto.maxUses} 之间，收到 ${dto.usedCount}',
    );
  }
  return InviteCode(
    id: dto.id,
    code: dto.code,
    role: role,
    maxUses: dto.maxUses,
    usedCount: dto.usedCount,
    expiresAt: dto.expiresAt,
    revoked: dto.revoked,
    createdAt: dto.createdAt,
  );
}

List<InviteCode> mapInvites(InviteListDto dto) {
  return dto.items
      .asMap()
      .entries
      .map((MapEntry<int, InviteDto> entry) =>
          mapInvite(entry.value, path: 'items[${entry.key}]'))
      .toList(growable: false);
}

// ──────────────────────────── 监护人同意（W7-B） ────────────────────────────

/// 线格式 → [GuardianConsent]。
///
/// `status` 只认识 `granted` / `withdrawn` / `none`；**不认识就抛**，不猜成
/// `none` —— 猜成 `none` 会让「已同意」的家庭看到一个「同意」按钮，点下去
/// 就是第二次同意（服务端虽然幂等，但界面在说谎）。
///
/// 形状校验（版本号 / 时间是否齐）在 [ConsentStateDto] 里已经做过了，
/// 这里只做语义转换。
GuardianConsent mapConsent(ConsentStateDto dto) {
  final String path = r'$';
  return GuardianConsent(
    childId: dto.childId,
    status: _consentStatusFromWire(dto.status, '$path.status'),
    consentVersion: dto.consentVersion,
    grantedAt: dto.grantedAt,
    withdrawnAt: dto.withdrawnAt,
  );
}

GuardianConsentStatus _consentStatusFromWire(String raw, String path) {
  switch (raw) {
    case 'granted':
      return GuardianConsentStatus.granted;
    case 'withdrawn':
      return GuardianConsentStatus.withdrawn;
    case 'none':
      return GuardianConsentStatus.none;
  }
  throw ReadApiException.malformed(path, detail: '未知同意状态：$raw');
}

// ──────────────────────────── 家庭数据导出（W7-C） ────────────────────────────

/// 线格式 → [FamilyExport]。
///
/// 几乎是 1:1（导出文件本身就是界面要展示的结论），只多带一份 `rawJson`：
/// 家长复制 / 落盘时应当拿到服务端下发的**同一份字节**。
///
/// 版本号不做「不认识就抛」：文件来自更新的服务端时，界面要能**看到**它并把
/// 这件事说出来（[FamilyExport.isKnownSchemaVersion]），而不是把整份导出
/// 变成一个错误页 —— 家长要的是数据，不是一个版本协商失败。
FamilyExport mapFamilyExport(FamilyExportDto dto) {
  return FamilyExport(
    rawJson: dto.rawJson,
    schemaVersion: dto.schemaVersion,
    generator: dto.generator,
    generatedAt: dto.generatedAt,
    childId: dto.childId,
    childName: dto.childName,
    pointsBalance: dto.pointsBalance,
    counts: Map<String, int>.unmodifiable(dto.counts),
    totals: Map<String, int>.unmodifiable(dto.totals),
    truncated: dto.truncated,
    truncatedSections: List<String>.unmodifiable(dto.truncatedSections),
  );
}


/// 删除状态 DTO → UI 模型（W7-D）。
///
/// ★ 未知状态在这里**不会**落到 `none`：DTO 已经把它抛成 `malformed`，
///   这里只做无歧义的映射。把未知当 `none` 会让「后端加了新状态」显示成
///   「从未申请删除」—— 最坏的一种默认值。
FamilyDeletion mapFamilyDeletion(FamilyDeletionStateDto dto) {
  final FamilyDeletionStatus? status =
      familyDeletionStatusFromWire(dto.status);
  if (status == null) {
    throw ReadApiException.malformed(
      r'$.status',
      detail: '未知删除状态：${dto.status}',
    );
  }
  final FamilyDeletionSummaryDto? summary = dto.summary;
  return FamilyDeletion(
    childId: dto.childId,
    status: status,
    requestedAt: dto.requestedAt,
    scheduledFor: dto.scheduledFor,
    cancelledAt: dto.cancelledAt,
    executedAt: dto.executedAt,
    daysRemaining: dto.daysRemaining,
    canCancel: dto.canCancel,
    summary: summary == null
        ? null
        : FamilyDeletionSummary(
            coolingDays: summary.coolingDays,
            redacted: Map<String, int>.unmodifiable(summary.redacted),
            keptRecords: summary.keptRecords,
            keptPointsBalance: summary.keptPointsBalance,
            note: summary.note,
          ),
  );
}

