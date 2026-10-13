import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_icons.dart';

/// 表单小节标题。
class FieldLabel extends StatelessWidget {
  const FieldLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, top: 4),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w700,
          color: AppColors.textSecondary,
        ),
      ),
    );
  }
}

/// 圆角无边框输入框，和整体风格统一。
class SoftTextField extends StatelessWidget {
  const SoftTextField({
    super.key,
    required this.controller,
    this.hint,
    this.maxLines = 1,
    this.keyboardType,
    this.onChanged,
  });

  final TextEditingController controller;
  final String? hint;
  final int maxLines;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      maxLines: maxLines,
      keyboardType: keyboardType,
      onChanged: onChanged,
      style: const TextStyle(fontSize: 14, color: AppColors.textPrimary),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(fontSize: 13.5, color: AppColors.textHint),
        filled: true,
        fillColor: AppColors.chipBg,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AppColors.primary, width: 1.4),
        ),
      ),
    );
  }
}

/// 一个可选的图标 + 配色。
class IconOption {
  const IconOption(this.name, this.color);

  /// 图标**名字**（跨端契约里的名字，不是 `IconData`）—— 修 D9
  final String name;
  final Color color;
}

/// 规则可选图标（也是新习惯的默认图标来源）。
///
/// 名字与配色**必须**与小程序侧 `FormFields/index.tsx` 的 `ruleIconOptions`
/// 逐一对应（同名、同序、同色）—— 名字集合由 `npm run icons:check` 钉死。
const List<IconOption> ruleIconOptions = <IconOption>[
  IconOption(IconNames.book, AppColors.starYellow),
  IconOption(IconNames.backpack, AppColors.pointSpend),
  IconOption(IconNames.clipboard, AppColors.primaryDeep),
  IconOption(IconNames.stories, Color(0xFF7BB0E8)),
  IconOption(IconNames.palette, Color(0xFFE58FB0)),
  IconOption(IconNames.music, Color(0xFF9B8BE8)),
  IconOption(IconNames.basketball, AppColors.orange),
  IconOption(IconNames.spray, Color(0xFF62C1B8)),
];

/// 图标选择器。
class IconPicker extends StatelessWidget {
  const IconPicker({
    super.key,
    required this.selectedIndex,
    required this.onSelected,
  });

  final int selectedIndex;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: List<Widget>.generate(ruleIconOptions.length, (int index) {
        final IconOption option = ruleIconOptions[index];
        final bool selected = index == selectedIndex;
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => onSelected(index),
          child: Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: option.color.withAlpha(selected ? 60 : 30),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: selected ? option.color : Colors.transparent,
                width: 1.6,
              ),
            ),
            child: Icon(iconDataFor(option.name), size: 21, color: option.color),
          ),
        );
      }),
    );
  }
}

/// emoji 选择器（心愿插画）。
const List<String> wishEmojis = <String>[
  '🎁',
  '🍖',
  '🐶',
  '🍦',
  '🧩',
  '🎡',
  '📚',
  '🚲',
  '🎮',
  '🍿',
  '⚽',
  '🎨',
];

class EmojiPicker extends StatelessWidget {
  const EmojiPicker({
    super.key,
    required this.selected,
    required this.onSelected,
  });

  final String selected;
  final ValueChanged<String> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: wishEmojis.map((String emoji) {
        final bool isSelected = emoji == selected;
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => onSelected(emoji),
          child: Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: isSelected ? AppColors.primarySoft : AppColors.chipBg,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: isSelected ? AppColors.primaryDeep : Colors.transparent,
                width: 1.6,
              ),
            ),
            child: Text(emoji, style: const TextStyle(fontSize: 22)),
          ),
        );
      }).toList(),
    );
  }
}
