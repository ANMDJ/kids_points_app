import 'trash.dart' show RecordStatus, SoftDeletable, defaultStatus;

/// 心愿插画的配色方案 —— **稳定枚举**，与后端 `enum WishCoverStyle` 一一对应
/// （`backend/prisma/schema.prisma`）。
///
/// 修 E16：原先用 `backgroundIndex`（值＝`wishes.length % 4`）表达配色，
/// 于是配色由**插入时的列表长度**决定 —— 删除中间某个心愿后，
/// 后续新增的心愿会与既有心愿撞色，既有心愿的配色也可能跳变。
enum WishCoverStyle { a, b, c, d }

/// 配色枚举的全部取值，以及补空档时的优先顺序。
const List<WishCoverStyle> wishCoverStyles = <WishCoverStyle>[
  WishCoverStyle.a,
  WishCoverStyle.b,
  WishCoverStyle.c,
  WishCoverStyle.d,
];

/// id → 稳定哈希（跨端同源：Taro 侧 `wishCoverHash` 必须用同一算式）。
/// 取模前的 `% 1000003` 只为避免大数，与配色语义无关。
int wishCoverHash(String id) {
  int hash = 0;
  for (int i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.codeUnitAt(i)) % 1000003;
  }
  return hash;
}

/// 挑一个配色 —— **与列表长度无关**，所以删项不会让既有心愿变色。
///
/// ① 还有空档：按 a → d 补第一个空档（新增不与既有撞色）；
/// ② 四个都占满：由 `id` 哈希稳定取值（可能撞色，但**永不漂移** —— 同一个 id 永远同一个色）。
WishCoverStyle pickCoverStyle(List<WishCoverStyle> taken, String id) {
  final Set<WishCoverStyle> used = taken.toSet();
  for (final WishCoverStyle style in wishCoverStyles) {
    if (!used.contains(style)) return style;
  }
  return wishCoverStyles[wishCoverHash(id) % wishCoverStyles.length];
}

/// 心愿单里可以兑换的奖励。
/// **修 C9 追加**：软删除位 `status` / `deletedAt`。删除心愿不再从数据里消失 ——
/// 历史扣分流水的 `wishId` 因此永远指得到人（“那 40 分兑换了什么”永远答得出），
/// 且误删可在 90 天内恢复。
class Wish implements SoftDeletable {
  Wish({
    required this.id,
    required this.title,
    required this.cost,
    required this.emoji,
    required this.coverStyle,
    this.redeemed = false,
    this.status = defaultStatus,
    this.deletedAt,
  });

  @override
  final String id;

  @override
  final String title;

  /// 兑换所需积分
  final int cost;

  /// 插画用的 emoji（无网络/无图片资源时也能保持可爱风格）
  final String emoji;

  /// 插画底色方案（**稳定枚举**，不再用数组下标）—— 修 E16
  final WishCoverStyle coverStyle;

  /// 是否已兑换
  bool redeemed;

  /// `active` 才出现在心愿单里；`deleted` 进回收站 —— 修 C9
  @override
  RecordStatus status;

  /// 进入回收站的时间（`active` 时为 null）—— 修 C9
  @override
  DateTime? deletedAt;

  /// 审计快照的**结构字段**（由 `auditSnapshotOf` 深拷贝）—— 修 C11
  @override
  Map<String, Object?> snapshot() => <String, Object?>{
        'id': id,
        'title': title,
        'cost': cost,
        'emoji': emoji,
        'coverStyle': coverStyle.name,
        'redeemed': redeemed,
        'status': status.name,
        'deletedAt': deletedAt,
      };
}
