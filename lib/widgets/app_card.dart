import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 统一的白色圆角卡片容器（列表项、战绩卡都用它）。
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
    this.margin = EdgeInsets.zero,
    this.radius = 18,
    this.color = AppColors.surface,
    this.border = true,
    this.onTap,
    this.onLongPress,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final EdgeInsetsGeometry margin;
  final double radius;
  final Color color;
  final bool border;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    Widget content = Padding(padding: padding, child: child);
    if (onTap != null || onLongPress != null) {
      // Material/InkWell 放在卡片内部，水波纹才会画在白色底之上。
      content = Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(radius),
          onTap: onTap,
          onLongPress: onLongPress,
          child: content,
        ),
      );
    }
    return Container(
      margin: margin,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
        border: border ? Border.all(color: AppColors.divider) : null,
        boxShadow: const <BoxShadow>[
          BoxShadow(
            color: AppColors.shadow,
            blurRadius: 18,
            offset: Offset(0, 8),
          ),
        ],
      ),
      child: content,
    );
  }
}
