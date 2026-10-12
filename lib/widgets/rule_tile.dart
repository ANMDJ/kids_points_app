import 'package:flutter/material.dart';

import '../models/point_rule.dart';
import '../theme/app_colors.dart';
import 'app_card.dart';

/// 积分规则列表项：图标 + 名称/细则 + 分值，长按可编辑（加入习惯 / 删除）。
class RuleTile extends StatelessWidget {
  const RuleTile({
    super.key,
    required this.rule,
    this.onTap,
    this.onLongPress,
  });

  final PointRule rule;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        radius: 16,
        onTap: onTap,
        onLongPress: onLongPress,
        child: Row(
          children: <Widget>[
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: rule.color.withAlpha(34),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(rule.icon, size: 20, color: rule.color),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    rule.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    rule.detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              rule.amountText,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
                color: rule.isGain ? AppColors.pointGain : AppColors.pointSpend,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
