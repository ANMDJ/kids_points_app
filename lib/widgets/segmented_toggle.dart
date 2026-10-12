import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 二选一分段控件（奖励 / 扣除、加分 / 扣分）。
class SegmentedToggle extends StatelessWidget {
  const SegmentedToggle({
    super.key,
    required this.leftLabel,
    required this.rightLabel,
    required this.leftSelected,
    required this.onChanged,
  });

  final String leftLabel;
  final String rightLabel;
  final bool leftSelected;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.chipBg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: _SegmentItem(
              label: leftLabel,
              selected: leftSelected,
              color: AppColors.pointGain,
              onTap: () => onChanged(true),
            ),
          ),
          Expanded(
            child: _SegmentItem(
              label: rightLabel,
              selected: !leftSelected,
              color: AppColors.pointSpend,
              onTap: () => onChanged(false),
            ),
          ),
        ],
      ),
    );
  }
}

class _SegmentItem extends StatelessWidget {
  const _SegmentItem({
    required this.label,
    required this.selected,
    required this.color,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        height: 38,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? Colors.white : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
          boxShadow: selected
              ? const <BoxShadow>[
                  BoxShadow(
                    color: AppColors.shadow,
                    blurRadius: 10,
                    offset: Offset(0, 4),
                  ),
                ]
              : null,
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 13.5,
            fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
            color: selected ? color : AppColors.textSecondary,
          ),
        ),
      ),
    );
  }
}
