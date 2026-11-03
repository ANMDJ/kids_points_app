import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 家长 PIN 的输入状态（4–6 位数字）。
///
/// ── 为什么是 `ValueNotifier<String>` 而不是 `TextEditingController` ─────────
///   PIN 输入**不经过系统键盘**（见 [PinPad]），没有文本选择 / 光标 / 输入法
///   这一整套概念要管。只留「现在敲了几个数字」这一个事实，界面据此画圆点。
///
/// ── 长度为什么是 4–6 ────────────────────────────────────────────────────────
///   与服务端 `backend/src/common/pin-format.ts` 的 `isPinFormatValid()`
///   完全一致（`docs/design/02` §9.18）。本地只做**形状**预检：值对不对永远
///   由服务端回答 —— 客户端不保存任何 PIN 的派生值，也就没法在断网时
///   「假装验过了」。
class PinInputController extends ValueNotifier<String> {
  PinInputController() : super('');

  /// 最少 4 位（服务端口径）。
  static const int minLength = 4;

  /// 最多 6 位（服务端口径）。
  static const int maxLength = 6;

  /// 已经能提交了吗（4–6 位）。
  bool get isReady => value.length >= minLength;

  /// 追加一位数字。非单个数字 / 已满一律忽略。
  void add(String digit) {
    if (value.length >= maxLength) return;
    if (!RegExp(r'^[0-9]$').hasMatch(digit)) return;
    value = '${value}$digit';
  }

  /// 退掉一位。
  void backspace() {
    if (value.isEmpty) return;
    value = value.substring(0, value.length - 1);
  }

  /// 清空（换个人来输时不必点 N 次退格）。
  void clear() {
    if (value.isEmpty) return;
    value = '';
  }
}

/// 锁屏风格的 PIN 输入：**圆点** ＋ **自绘数字键盘**。
///
/// ── 为什么要自绘键盘，而不是 `TextField` + `keyboardType: number` ────────────
///   ① 系统数字键盘在小屏上会盖住圆点与错误提示；锁屏的意义有一半是
///      「看得见自己敲了几位」；
///   ② 系统键盘带回车键、候选词、粘贴菜单 —— 对一个 4–6 位数字的输入框，
///      这些只会带来误解（有人以为能粘贴微信里的 PIN）；
///   ③ 自绘键盘在 Web / 桌面上表现一致，测试也能稳定地点到某个数字。
///
/// ★ 这里**没有**「提交」按钮：提交动作属于调用方（锁屏是「解锁」、面板是
///   「进入家长模式」）。本组件只负责收集数字与展示圆点，避免两个提交入口。
class PinPad extends StatelessWidget {
  const PinPad({
    super.key,
    required this.controller,
    this.enabled = true,
    this.errorText,
    this.hintText,
  });

  final PinInputController controller;

  /// false ⇒ 键盘与圆点整体变灰（提交中 / 已锁定）。
  final bool enabled;

  /// 错误提示（原样展示服务端 / 本地文案）。
  final String? errorText;

  /// 圆点下面的常驻说明（例如「4–6 位数字」）。
  final String? hintText;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<String>(
      valueListenable: controller,
      builder: (BuildContext context, String value, _) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _PinDots(
              length: value.length,
              enabled: enabled,
              hasError: errorText != null,
            ),
            if (hintText != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                hintText!,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 11.5,
                  color: AppColors.textHint,
                ),
              ),
            ],
            if (errorText != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                errorText!,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 12,
                  height: 1.45,
                  color: AppColors.pointSpend,
                ),
              ),
            ],
            const SizedBox(height: 18),
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 268),
                child: Column(
                  children: <Widget>[
                    for (final List<String> row in _digitRows)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: <Widget>[
                            for (final String key in row) _digit(key),
                          ],
                        ),
                      ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: <Widget>[
                        _PinKey(
                          key: const ValueKey<String>('pin-key-clear'),
                          label: '清空',
                          onTap: enabled ? controller.clear : null,
                          subtle: true,
                        ),
                        _digit('0'),
                        _PinKey(
                          key: const ValueKey<String>('pin-key-backspace'),
                          icon: Icons.backspace_outlined,
                          onTap: enabled ? controller.backspace : null,
                          semanticLabel: '删除一位',
                          subtle: true,
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  /// 数字键盘的行（0 单独和「清空 / 退格」在同一行）。
  static const List<List<String>> _digitRows = <List<String>>[
    <String>['1', '2', '3'],
    <String>['4', '5', '6'],
    <String>['7', '8', '9'],
  ];

  Widget _digit(String digit) {
    return _PinKey(
      key: ValueKey<String>('pin-key-$digit'),
      label: digit,
      onTap: enabled ? () => controller.add(digit) : null,
      semanticLabel: '数字 $digit',
    );
  }
}

/// 已输入位数：实心圆点；未输入：空心；错误：红色。
///
/// 固定 6 个槽位而不是「跟着输入变长」：槽位数量本身就是「最多 6 位」这条规则
/// 的可视化。
class _PinDots extends StatelessWidget {
  const _PinDots({
    required this.length,
    required this.enabled,
    required this.hasError,
  });

  final int length;
  final bool enabled;
  final bool hasError;

  @override
  Widget build(BuildContext context) {
    final Color active = hasError
        ? AppColors.pointSpend
        : (enabled ? AppColors.primaryDeep : AppColors.textHint);
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int index = 0; index < PinInputController.maxLength; index += 1)
          AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            margin: const EdgeInsets.symmetric(horizontal: 7),
            width: 14,
            height: 14,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: index < length ? active : Colors.transparent,
              border: Border.all(
                color: index < length ? active : AppColors.textHint,
                width: index < length ? 1.2 : 1.6,
              ),
            ),
          ),
      ],
    );
  }
}

/// 一个按键（数字用实底白圆、功能键用透明底）。
class _PinKey extends StatelessWidget {
  const _PinKey({
    super.key,
    this.label,
    this.icon,
    required this.onTap,
    this.semanticLabel,
    this.subtle = false,
  });

  final String? label;
  final IconData? icon;
  final VoidCallback? onTap;
  final String? semanticLabel;
  final bool subtle;

  @override
  Widget build(BuildContext context) {
    final bool on = onTap != null;
    final Color fg = on
        ? (subtle ? AppColors.textSecondary : AppColors.textPrimary)
        : AppColors.textHint;
    return Semantics(
      button: true,
      label: semanticLabel,
      child: Material(
        color: subtle || !on ? Colors.transparent : AppColors.surface,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: 76,
            height: 56,
            child: Center(
              child: icon != null
                  ? Icon(icon, size: 22, color: fg)
                  : Text(
                      label ?? '',
                      style: TextStyle(
                        fontSize: 23,
                        fontWeight: FontWeight.w600,
                        color: fg,
                      ),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
