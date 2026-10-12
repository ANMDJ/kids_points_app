import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 二级页顶部栏：返回箭头 + 居中标题 + 可选右侧按钮。
class PageHeader extends StatelessWidget {
  const PageHeader({
    super.key,
    required this.title,
    this.onBack,
    this.trailing,
  });

  final String title;
  final VoidCallback? onBack;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 50,
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 56,
            child: onBack == null
                ? null
                : Align(
                    alignment: Alignment.centerLeft,
                    child: IconButton(
                      iconSize: 20,
                      splashRadius: 22,
                      padding: const EdgeInsets.only(left: 6),
                      icon: const Icon(
                        Icons.arrow_back_ios_new_rounded,
                        color: AppColors.textPrimary,
                      ),
                      onPressed: onBack,
                    ),
                  ),
          ),
          Expanded(
            child: Center(
              child: Text(
                title,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
          ),
          SizedBox(width: 56, child: trailing),
        ],
      ),
    );
  }
}

/// 小节标题，例如“今天的习惯”。
class SectionTitle extends StatelessWidget {
  const SectionTitle({
    super.key,
    required this.title,
    this.trailing,
  });

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        children: <Widget>[
          Text(
            title,
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const Spacer(),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}
