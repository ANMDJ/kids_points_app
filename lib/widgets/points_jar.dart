import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 首页的“积分罐”插画：薄荷绿罐盖 + 玻璃罐 + 柠檬小黄脸 + 星光。
///
/// 全部用 Canvas 手绘，不依赖任何图片资源，任意分辨率下都清晰。
class PointsJar extends StatelessWidget {
  const PointsJar({super.key, this.width = 180});

  final double width;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      height: width * (196 / 180),
      child: CustomPaint(painter: _JarPainter()),
    );
  }
}

class _JarPainter extends CustomPainter {
  static const double _designWidth = 180;
  static const double _designHeight = 196;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / _designWidth, size.height / _designHeight);
    _paintShadow(canvas);
    _paintBody(canvas);
    _paintBlob(canvas);
    _paintLid(canvas);
    _paintSparkles(canvas);
    canvas.restore();
  }

  void _paintShadow(Canvas canvas) {
    canvas.drawOval(
      Rect.fromCenter(center: const Offset(90, 186), width: 116, height: 16),
      Paint()..color = const Color(0x227FBF55),
    );
  }

  void _paintBody(Canvas canvas) {
    final RRect body =
        RRect.fromLTRBR(30, 70, 150, 182, const Radius.circular(26));
    canvas.drawRRect(
      body,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[Color(0xF2FFFFFF), AppColors.jarGlass],
        ).createShader(body.outerRect),
    );
    canvas.drawRRect(
      body,
      Paint()
        ..color = AppColors.jarGlassEdge
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.6,
    );
    // 玻璃高光
    final RRect highlight =
        RRect.fromLTRBR(42, 90, 54, 150, const Radius.circular(6));
    canvas.drawRRect(highlight, Paint()..color = const Color(0x99FFFFFF));
  }

  void _paintBlob(Canvas canvas) {
    final RRect blob =
        RRect.fromLTRBR(57, 99, 123, 165, const Radius.circular(30));
    canvas.drawRRect(
      blob,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[AppColors.jarBlobLight, AppColors.jarBlobDeep],
        ).createShader(blob.outerRect),
    );
    final RRect shine =
        RRect.fromLTRBR(67, 106, 85, 121, const Radius.circular(9));
    canvas.drawRRect(shine, Paint()..color = const Color(0x80FFFFFF));

    final Paint dark = Paint()..color = const Color(0xFF5F4B22);
    canvas.drawCircle(const Offset(76, 131), 4, dark);
    canvas.drawCircle(const Offset(104, 131), 4, dark);

    final Paint blush = Paint()..color = const Color(0x33E88E6A);
    canvas.drawCircle(const Offset(64, 142), 6.5, blush);
    canvas.drawCircle(const Offset(116, 142), 6.5, blush);

    final Path mouth = Path()
      ..moveTo(82, 143)
      ..quadraticBezierTo(90, 152, 98, 143);
    canvas.drawPath(
      mouth,
      Paint()
        ..color = const Color(0xFF7A5A22)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.4
        ..strokeCap = StrokeCap.round,
    );
  }

  void _paintLid(Canvas canvas) {
    // 罐口
    final RRect neck =
        RRect.fromLTRBR(36, 60, 144, 78, const Radius.circular(10));
    canvas.drawRRect(neck, Paint()..color = const Color(0xFF9CCC79));
    // 罐盖主体
    final RRect lid =
        RRect.fromLTRBR(30, 40, 150, 70, const Radius.circular(14));
    canvas.drawRRect(lid, Paint()..color = AppColors.jarLid);
    canvas.drawRRect(
      lid,
      Paint()
        ..color = AppColors.jarLidDark
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.4,
    );
    // 盖顶
    final RRect top =
        RRect.fromLTRBR(46, 28, 134, 46, const Radius.circular(10));
    canvas.drawRRect(top, Paint()..color = AppColors.jarLidLight);
    // 盖子上的小叶子
    final Path leaf = Path()
      ..moveTo(90, 40)
      ..quadraticBezierTo(78, 22, 62, 26)
      ..quadraticBezierTo(72, 42, 90, 40)
      ..close();
    canvas.drawPath(leaf, Paint()..color = AppColors.jarLidDark);
  }

  void _paintSparkles(Canvas canvas) {
    // 罐外的小海星（设计稿右侧的黄色星星）
    canvas.drawPath(
      _star(const Offset(139, 116), 12, 5, 0.45),
      Paint()..color = AppColors.starYellow,
    );
    canvas.drawPath(
      _star(const Offset(46, 96), 7, 4, 0.28),
      Paint()..color = const Color(0xFFF8D98A),
    );
    canvas.drawPath(
      _star(const Offset(132, 72), 5.5, 4, 0.28),
      Paint()..color = const Color(0xFFF8D98A),
    );
    canvas.drawPath(
      _star(const Offset(36, 140), 5, 4, 0.28),
      Paint()..color = const Color(0xFFF3CFA0),
    );
  }

  Path _star(Offset center, double radius, int points, double innerRatio) {
    final Path path = Path();
    for (int i = 0; i < points * 2; i++) {
      final double r = i.isEven ? radius : radius * innerRatio;
      final double angle = -math.pi / 2 + i * math.pi / points;
      final Offset p = Offset(
        center.dx + r * math.cos(angle),
        center.dy + r * math.sin(angle),
      );
      if (i == 0) {
        path.moveTo(p.dx, p.dy);
      } else {
        path.lineTo(p.dx, p.dy);
      }
    }
    path.close();
    return path;
  }

  @override
  bool shouldRepaint(covariant _JarPainter oldDelegate) => false;
}
