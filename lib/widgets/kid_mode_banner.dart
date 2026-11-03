import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// 首页顶部的「孩子模式」状态条（W14，2026-11-03）。
///
/// ── 为什么只写状态、不写倒计时 ──────────────────────────────────────────────
///   首页没有秒级刷新（只有面板有 ticker）。在这里渲染一个"剩余 12:34"，
///   用户切后台 5 分钟回来会看到一个**静止的假数字** —— 那比不显示更坏。
///   要精确剩余时间，点这条进面板（那里有每秒重绘的倒计时）。
///
/// ── 为什么它必须常驻 ────────────────────────────────────────────────────────
///   孩子模式是"这台设备被降级了"的状态。不写在首页，孩子看到的界面与平时
///   没有任何区别，只会在一操作时撞上 403 —— 那是把状态藏起来。
class KidModeBanner extends StatelessWidget {
  const KidModeBanner({
    super.key,
    required this.expired,
    required this.onTap,
  });

  /// true = 时间到了、等家长 PIN 收回；false = 还在窗口内。
  final bool expired;

  /// 点一下打开「家长模式」面板（唯一能收回的地方）。
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color accent = expired ? AppColors.pointSpend : AppColors.primaryDeep;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Ink(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: expired ? AppColors.cream : AppColors.primarySoft,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: <Widget>[
              Icon(
                expired ? Icons.timer_off_outlined : Icons.schedule_rounded,
                size: 18,
                color: accent,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  expired
                      ? '孩子模式的时间到了 —— 请家长输入 PIN 收回'
                      : '孩子模式进行中 —— 家长专属操作需要家长 PIN',
                  style: TextStyle(
                    fontSize: 12.5,
                    height: 1.4,
                    fontWeight: FontWeight.w600,
                    color: accent,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Icon(Icons.chevron_right_rounded, size: 18, color: accent),
            ],
          ),
        ),
      ),
    );
  }
}
