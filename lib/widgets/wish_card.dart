import 'package:flutter/material.dart';

import '../models/wish.dart';
import '../theme/app_colors.dart';
import 'pills.dart';

/// 心愿单卡片的 4 套插画底色。
const List<List<Color>> wishGradients = <List<Color>>[
  <Color>[Color(0xFFFFF8E6), Color(0xFFFBE7B8)],
  <Color>[Color(0xFFFFF6E9), Color(0xFFF7DCC0)],
  <Color>[Color(0xFFF3FAEA), Color(0xFFDCEEBE)],
  <Color>[Color(0xFFFFF6F1), Color(0xFFF8D9CE)],
];

/// 心愿卡片：插画 + 名称 + 所需积分 + 兑换/还差 N。
class WishCard extends StatelessWidget {
  const WishCard({
    super.key,
    required this.wish,
    required this.points,
    required this.onRedeem,
    this.onLongPress,
  });

  final Wish wish;
  final int points;
  final VoidCallback onRedeem;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final bool affordable = !wish.redeemed && points >= wish.cost;
    final int gap = wish.cost - points > 0 ? wish.cost - points : 0;
    final List<Color> colors =
        wishGradients[wish.backgroundIndex % wishGradients.length];

    return GestureDetector(
      onLongPress: onLongPress,
      child: Container(
        padding: const EdgeInsets.all(9),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.divider),
          boxShadow: const <BoxShadow>[
            BoxShadow(
              color: AppColors.shadow,
              blurRadius: 16,
              offset: Offset(0, 6),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Expanded(
              child: Container(
                width: double.infinity,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(14),
                  gradient: LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: colors,
                  ),
                ),
                child: Stack(
                  children: <Widget>[
                    Center(
                      child: Text(
                        wish.emoji,
                        style: const TextStyle(fontSize: 46),
                      ),
                    ),
                    const Positioned(
                      top: 6,
                      right: 8,
                      child: Text('✨', style: TextStyle(fontSize: 14)),
                    ),
                    if (wish.redeemed)
                      Positioned.fill(
                        child: Container(
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: Colors.white.withAlpha(160),
                            borderRadius: BorderRadius.circular(14),
                          ),
                          child: const Text(
                            '已兑换',
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w800,
                              color: AppColors.textSecondary,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              wish.title,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 11.5,
                height: 1.35,
                color: AppColors.textPrimary,
              ),
            ),
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                Text(
                  '${wish.cost}',
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w800,
                    color: AppColors.orange,
                  ),
                ),
                const SizedBox(width: 2),
                const Text(
                  '积分',
                  style: TextStyle(fontSize: 10.5, color: AppColors.orange),
                ),
                // 卡片较窄（比如超大系统字体）时，让胶囊整体等比缩小而不是溢出。
                Flexible(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerRight,
                    child: affordable
                        ? SmallPill(label: '兑换', filled: true, onTap: onRedeem)
                        : wish.redeemed
                            ? const SmallPill(label: '已兑换')
                            : SmallPill(label: '还差 $gap'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
