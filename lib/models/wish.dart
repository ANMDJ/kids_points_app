/// 心愿单里可以兑换的奖励。
class Wish {
  Wish({
    required this.id,
    required this.title,
    required this.cost,
    required this.emoji,
    required this.backgroundIndex,
    this.redeemed = false,
  });

  final String id;
  final String title;

  /// 兑换所需积分
  final int cost;

  /// 插画用的 emoji（无网络/无图片资源时也能保持可爱风格）
  final String emoji;

  /// 插画底色方案索引，见 WishIllustrationGradients
  final int backgroundIndex;

  /// 是否已兑换
  bool redeemed;
}
