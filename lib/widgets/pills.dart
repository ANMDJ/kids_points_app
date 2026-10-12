import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 小胶囊标签：心愿卡上的“兑换 / 还差 N”。
class SmallPill extends StatelessWidget {
  const SmallPill({
    super.key,
    required this.label,
    this.onTap,
    this.filled = false,
    this.padding = const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
  });

  final String label;
  final VoidCallback? onTap;
  final bool filled;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final Widget content = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: filled ? const Color(0xFFC6E8AC) : AppColors.chipBg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w700,
          color: filled ? AppColors.primaryText : AppColors.textSecondary,
        ),
      ),
    );
    if (onTap == null) return content;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: content,
    );
  }
}

/// 可选择的筛选胶囊（记录页的“全部 / 表扬 / 兑换 / 调整”）。
class SoftChip extends StatelessWidget {
  const SoftChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? AppColors.primary : AppColors.chipBg,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
            color: selected ? AppColors.primaryText : AppColors.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// 快捷标签（“记一笔”弹窗里的常用事由）。
class QuickTag extends StatelessWidget {
  const QuickTag({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: selected ? AppColors.primarySoft : AppColors.chipBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: selected ? AppColors.primaryDeep : Colors.transparent,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12.5,
            color: selected ? AppColors.primaryText : AppColors.textSecondary,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ),
    );
  }
}
