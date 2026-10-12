import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 圆形加减按钮 + 数值，用于编辑积分值。
class PointsStepper extends StatelessWidget {
  const PointsStepper({
    super.key,
    required this.value,
    required this.onChanged,
    this.min = 1,
    this.max = 999,
    this.suffix = '积分',
  });

  final int value;
  final ValueChanged<int> onChanged;
  final int min;
  final int max;
  final String suffix;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        _RoundButton(
          icon: Icons.remove_rounded,
          onTap: value > min ? () => onChanged(value - 1) : null,
        ),
        SizedBox(
          width: 84,
          child: Column(
            children: <Widget>[
              Text(
                '$value',
                style: const TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w800,
                  color: AppColors.primaryText,
                  height: 1.1,
                ),
              ),
              Text(
                suffix,
                style: const TextStyle(
                  fontSize: 11,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
        ),
        _RoundButton(
          icon: Icons.add_rounded,
          onTap: value < max ? () => onChanged(value + 1) : null,
        ),
      ],
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({required this.icon, required this.onTap});

  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final bool enabled = onTap != null;
    return Material(
      color: enabled ? AppColors.primarySoft : AppColors.chipBg,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: 42,
          height: 42,
          child: Icon(
            icon,
            size: 22,
            color: enabled ? AppColors.primaryText : AppColors.textHint,
          ),
        ),
      ),
    );
  }
}
