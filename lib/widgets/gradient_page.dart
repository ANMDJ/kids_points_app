import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 页面统一背景：浅绿到奶白渐变 + 顶部安全区 + 右下角叶子装饰。
class GradientPage extends StatelessWidget {
  const GradientPage({
    super.key,
    required this.child,
    this.showLeaves = true,
    this.safeTop = true,
    this.safeBottom = false,
  });

  final Widget child;
  final bool showLeaves;
  final bool safeTop;
  final bool safeBottom;

  @override
  Widget build(BuildContext context) {
    Widget content = child;
    if (safeTop || safeBottom) {
      content = SafeArea(top: safeTop, bottom: safeBottom, child: content);
    }
    return Container(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: <Color>[AppColors.pageTop, AppColors.pageBottom],
        ),
      ),
      child: Stack(
        children: <Widget>[
          if (showLeaves)
            Positioned(
              right: -12,
              bottom: -8,
              child: LeafDecoration(
                size: 132,
                color: AppColors.leafGreen,
              ),
            ),
          Positioned.fill(child: content),
        ],
      ),
    );
  }
}

/// 手绘两片小叶子，作为页面角落的装饰（无需图片资源）。
class LeafDecoration extends StatelessWidget {
  const LeafDecoration({
    super.key,
    this.size = 120,
    this.color = AppColors.leafGreen,
    this.opacity = 0.85,
  });

  final double size;
  final Color color;
  final double opacity;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Opacity(
        opacity: opacity,
        child: CustomPaint(
          size: Size(size, size),
          painter: _LeafPainter(color),
        ),
      ),
    );
  }
}

class _LeafPainter extends CustomPainter {
  _LeafPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final double w = size.width;
    final double h = size.height;
    final Paint stem = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = w * 0.022
      ..strokeCap = StrokeCap.round;
    final Paint leaf = Paint()
      ..color = color
      ..style = PaintingStyle.fill;

    final Path mainStem = Path()
      ..moveTo(w * 0.12, h * 0.96)
      ..quadraticBezierTo(w * 0.42, h * 0.66, w * 0.66, h * 0.18);
    canvas.drawPath(mainStem, stem);

    final Path leafRight = Path()
      ..moveTo(w * 0.46, h * 0.60)
      ..quadraticBezierTo(w * 0.94, h * 0.54, w * 0.96, h * 0.22)
      ..quadraticBezierTo(w * 0.58, h * 0.28, w * 0.46, h * 0.60)
      ..close();
    canvas.drawPath(leafRight, leaf);

    final Path leafLeft = Path()
      ..moveTo(w * 0.34, h * 0.76)
      ..quadraticBezierTo(w * 0.02, h * 0.74, w * 0.04, h * 0.46)
      ..quadraticBezierTo(w * 0.30, h * 0.50, w * 0.34, h * 0.76)
      ..close();
    canvas.drawPath(leafLeft, leaf);
  }

  @override
  bool shouldRepaint(covariant _LeafPainter oldDelegate) =>
      oldDelegate.color != color;
}
