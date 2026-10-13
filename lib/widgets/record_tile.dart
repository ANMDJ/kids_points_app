import 'package:flutter/material.dart';

import '../models/point_record.dart';
import '../theme/app_colors.dart';
import '../theme/app_icons.dart';
import 'app_card.dart';

/// 积分记录的一条流水。
class RecordTile extends StatelessWidget {
  const RecordTile({super.key, required this.record});

  final PointRecord record;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        radius: 16,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: <Widget>[
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: record.color.withAlpha(32),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(iconDataFor(record.iconName), size: 20, color: record.color),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    record.title,
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
                    record.subtitle,
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
              record.amountText,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
                color:
                    record.isGain ? AppColors.pointGain : AppColors.pointSpend,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
