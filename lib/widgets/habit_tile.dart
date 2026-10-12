import 'package:flutter/material.dart';

import '../models/habit.dart';
import '../theme/app_colors.dart';
import 'app_card.dart';

/// 首页“今天的习惯”列表项：左侧打卡圆勾 + 名称/细则 + 右侧分值。
class HabitTile extends StatelessWidget {
  const HabitTile({
    super.key,
    required this.habit,
    required this.onTap,
    this.onLongPress,
  });

  /// 派生视图：checked / limitText / doneText 都由结构字段 ＋ 当天流水现算（修 A2 / A3 / E17）
  final HabitView habit;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: AppCard(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Row(
          children: <Widget>[
            AnimatedContainer(
              duration: const Duration(milliseconds: 220),
              width: 27,
              height: 27,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: habit.checked
                    ? AppColors.primaryDeep
                    : const Color(0xFFF1F3ED),
                border: habit.checked
                    ? null
                    : Border.all(color: const Color(0xFFE1E6D9)),
              ),
              child: Icon(
                Icons.check_rounded,
                size: 17,
                color: habit.checked ? Colors.white : const Color(0xFFCBD2C2),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    habit.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14.5,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    habit.subtitle,
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
              habit.amountText,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
                color: AppColors.pointGain,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
