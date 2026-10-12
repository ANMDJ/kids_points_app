import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 主操作按钮：浅绿渐变胶囊（“记一笔”“新增心愿”“新增规则”）。
class SoftButton extends StatelessWidget {
  const SoftButton({
    super.key,
    required this.label,
    required this.onTap,
    this.icon,
    this.enabled = true,
    this.height = 52,
  });

  final String label;
  final VoidCallback? onTap;
  final IconData? icon;
  final bool enabled;
  final double height;

  @override
  Widget build(BuildContext context) {
    final bool active = enabled && onTap != null;
    final BorderRadius radius = BorderRadius.circular(height / 2);
    return Opacity(
      opacity: active ? 1 : 0.55,
      child: Material(
        color: Colors.transparent,
        borderRadius: radius,
        child: InkWell(
          borderRadius: radius,
          onTap: active ? onTap : null,
          child: Ink(
            height: height,
            decoration: BoxDecoration(
              borderRadius: radius,
              gradient: const LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[Color(0xFFD8F1BA), Color(0xFFB4E08C)],
              ),
              boxShadow: const <BoxShadow>[
                BoxShadow(
                  color: Color(0x337FBF55),
                  blurRadius: 16,
                  offset: Offset(0, 8),
                ),
              ],
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                if (icon != null) ...<Widget>[
                  Icon(icon, size: 19, color: AppColors.primaryText),
                  const SizedBox(width: 8),
                ],
                Text(
                  label,
                  style: const TextStyle(
                    fontSize: 15.5,
                    fontWeight: FontWeight.w700,
                    color: AppColors.primaryText,
                    letterSpacing: 0.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
