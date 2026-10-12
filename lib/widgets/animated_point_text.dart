import 'package:flutter/material.dart';

/// 积分数字滚动动画：数值变化时从旧值平滑过渡到新值。
class AnimatedPointText extends StatefulWidget {
  const AnimatedPointText({
    super.key,
    required this.value,
    required this.style,
    this.duration = const Duration(milliseconds: 500),
  });

  final int value;
  final TextStyle style;
  final Duration duration;

  @override
  State<AnimatedPointText> createState() => _AnimatedPointTextState();
}

class _AnimatedPointTextState extends State<AnimatedPointText> {
  late int _from = widget.value;

  @override
  void didUpdateWidget(covariant AnimatedPointText oldWidget) {
    if (oldWidget.value != widget.value) {
      _from = oldWidget.value;
    }
    super.didUpdateWidget(oldWidget);
  }

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(
        begin: _from.toDouble(),
        end: widget.value.toDouble(),
      ),
      duration: widget.duration,
      curve: Curves.easeOutCubic,
      builder: (BuildContext context, double value, Widget? child) {
        return Text('${value.round()}', style: widget.style);
      },
    );
  }
}
