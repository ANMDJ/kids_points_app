import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

class _NavItem {
  const _NavItem(this.icon, this.activeIcon, this.label);

  final IconData icon;
  final IconData activeIcon;
  final String label;
}

/// 底部导航：首页 / 心愿单 / 审批 / 我的。
class AppBottomNav extends StatelessWidget {
  const AppBottomNav({
    super.key,
    required this.currentIndex,
    required this.onChanged,
  });

  final int currentIndex;
  final ValueChanged<int> onChanged;

  static const List<_NavItem> _items = <_NavItem>[
    _NavItem(Icons.home_rounded, Icons.home_rounded, '首页'),
    _NavItem(Icons.favorite_border_rounded, Icons.favorite_rounded, '心愿单'),
    _NavItem(Icons.fact_check_outlined, Icons.fact_check_rounded, '审批'),
    _NavItem(
      Icons.sentiment_satisfied_alt_rounded,
      Icons.sentiment_very_satisfied_rounded,
      '我的',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.shadow,
            blurRadius: 20,
            offset: Offset(0, -6),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 64,
          child: Row(
            children: List<Widget>.generate(_items.length, (int index) {
              final _NavItem item = _items[index];
              final bool active = index == currentIndex;
              return Expanded(
                child: InkWell(
                  onTap: () => onChanged(index),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: <Widget>[
                      Icon(
                        active ? item.activeIcon : item.icon,
                        size: 23,
                        color: active
                            ? AppColors.primaryDeep
                            : AppColors.navInactive,
                      ),
                      const SizedBox(height: 3),
                      Text(
                        item.label,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight:
                              active ? FontWeight.w700 : FontWeight.w500,
                          color: active
                              ? AppColors.primaryDeep
                              : AppColors.navInactive,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    );
  }
}
