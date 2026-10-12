import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 右下角的悬浮“新增”按钮：收起时是圆形悬浮按钮，展开时是整行胶囊按钮。
///
/// - 收起（[expanded] 为 false）：宽高都是 [height] 的圆形按钮，只显示图标；
/// - 展开（[expanded] 为 true）：宽度补间到 [expandedWidth]，图标左侧“长”出文字。
///
/// 宽度、阴影、图标大小、文字宽度都会做补间动画，中途不会有跳变或溢出。
class FloatingAddButton extends StatelessWidget {
  const FloatingAddButton({
    super.key,
    required this.label,
    required this.expanded,
    required this.expandedWidth,
    required this.onTap,
    this.icon,
    this.height = 52,
    this.duration = const Duration(milliseconds: 340),
    this.curve = Curves.easeOutCubic,
  });

  final String label;
  final bool expanded;

  /// 展开后的完整宽度，由页面按左右留白算好后传入（不能用 infinity，否则无法补间）。
  final double expandedWidth;
  final VoidCallback? onTap;
  final IconData? icon;
  final double height;
  final Duration duration;
  final Curve curve;

  @override
  Widget build(BuildContext context) {
    final bool active = onTap != null;
    final BorderRadius radius = BorderRadius.circular(height / 2);

    return Opacity(
      opacity: active ? 1 : 0.55,
      child: Tooltip(
        message: label,
        child: AnimatedContainer(
          duration: duration,
          curve: curve,
          width: expanded ? expandedWidth : height,
          height: height,
          decoration: BoxDecoration(
            borderRadius: radius,
            gradient: const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[Color(0xFFD8F1BA), Color(0xFFB4E08C)],
            ),
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: expanded
                    ? const Color(0x337FBF55)
                    : const Color(0x4D6BAE48),
                blurRadius: expanded ? 16 : 22,
                spreadRadius: expanded ? 0 : 1,
                offset: Offset(0, expanded ? 8 : 10),
              ),
            ],
          ),
          child: Material(
            color: Colors.transparent,
            borderRadius: radius,
            child: InkWell(
              borderRadius: radius,
              onTap: active ? onTap : null,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  if (icon != null)
                    AnimatedScale(
                      scale: expanded ? 1 : 1.16,
                      duration: duration,
                      curve: Curves.easeOutBack,
                      child: Icon(icon, size: 19, color: AppColors.primaryText),
                    ),
                  // 文字常驻在树里，只用宽度 0 → 自然宽度做动画：
                  // 收起时被裁掉（视觉上只剩图标），展开时从图标右边“长”出来。
                  ExcludeSemantics(
                    excluding: !expanded,
                    child: AnimatedSize(
                      duration: duration,
                      curve: curve,
                      alignment: Alignment.centerLeft,
                      child: SizedBox(
                        width: expanded ? null : 0,
                        child: AnimatedOpacity(
                          opacity: expanded ? 1 : 0,
                          duration: expanded
                              ? duration
                              : const Duration(milliseconds: 140),
                          child: Padding(
                            padding: const EdgeInsets.only(left: 8, right: 6),
                            child: Text(
                              label,
                              maxLines: 1,
                              softWrap: false,
                              overflow: TextOverflow.clip,
                              style: const TextStyle(
                                fontSize: 15.5,
                                fontWeight: FontWeight.w700,
                                color: AppColors.primaryText,
                                letterSpacing: 0.5,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
