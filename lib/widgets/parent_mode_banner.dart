import 'dart:async';

import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../theme/app_colors.dart';

/// 顶部抬头栏里的**家长 / 孩子模式状态条**（2026-11-10，用户第 2 条）。
///
/// ── 它替掉的那句话 ──────────────────────────────────────────────────────────
///   用户问「输入 PIN 进入家长模式，为什么没有 5 分钟倒计时？」
///   原因不是倒计时算不出来，而是**从来没有地方显示它**：只有「我的 → 家长模式」
///   那个弹层里每秒重绘一次，回到首页就看不见了。
///   现在倒计时常驻在四个 tab 的抬头栏（`HomeShell` 的 `ReadStatusBanner`
///   旁边），任何页面都能看到还剩多少。
///
/// ── 为什么必须每秒重绘，且必须从绝对时刻算 ──────────────────────────────────
///   服务端给的是 `parentModeExpiresAt`（绝对时刻），本地自减的整数在后台挂起 /
///   改系统时间之后全是错的（`app_store.dart#parentModeRemainingSeconds` 的注释）。
///   这里只是每秒重建一次，然后用同一个绝对时刻现算。
///
/// ── 四种状态（服务端事实，不猜）──────────────────────────────────────────────
///   ① 孩子模式窗口内 / 已到期 ⇒ 写孩子模式（倒计时 / 等 PIN 收回）；
///   ② PIN 换来的家长窗口    ⇒ 「家长模式 · 剩余 4:57」；
///   ③ 窗口走完              ⇒ 「已结束 · 点此输入 PIN 继续」（不是 00:00 的假倒计时）；
///   ④ 会话自带的家长身份    ⇒ 「家长身份（登录会话）· 无 5 分钟倒计时」——
///      这句是用户第 1 条的答案本身：30 天会话不该被渲染成倒计时。
class ParentModeBanner extends StatefulWidget {
  const ParentModeBanner({super.key, required this.onTap});

  /// 点一下：锁屏式 PIN 入口（`PinGuard` 的锁屏 / 家长模式面板都由调用方决定）。
  final VoidCallback onTap;

  @override
  State<ParentModeBanner> createState() => _ParentModeBannerState();
}

class _ParentModeBannerState extends State<ParentModeBanner> {
  Timer? _ticker;

  /// 只有「真的在显示状态条」时才跑 1 秒定时器。
  ///
  /// 预览模式 / 还没拉到 `parent-mode` 时，这条横幅是 `SizedBox.shrink()`；
  /// 让它继续每秒 `setState` 只是白烧电（`build` 里直接 return 也没用 ——
  /// 重建请求已经发生了）。因此定时器的开关跟着这两个前提走。
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final AppStore store = AppScope.of(context);
    _syncTicker(store.hasParentMode && store.parentMode != null);
  }

  void _syncTicker(bool wanted) {
    if (wanted == (_ticker != null)) return;
    if (!wanted) {
      _ticker?.cancel();
      _ticker = null;
      return;
    }
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    // 预览模式没有服务端事实；宁可什么都不显示，也不编一个倒计时。
    if (!store.hasParentMode || store.parentMode == null) {
      return const SizedBox.shrink();
    }

    final DateTime now = DateTime.now();
    final bool kidActive = store.isKidModeActiveAt(now);
    final bool kidExpired = store.isKidModeExpiredAt(now);
    final bool parentMode = store.isParentMode;
    final bool pinBacked = store.isParentModePinBacked;
    final bool sessionBacked = store.isParentModeSessionBacked;
    final int parentSeconds = store.parentModeRemainingSeconds(now);
    final int kidSeconds = store.kidModeRemainingSeconds(now);

    final IconData icon;
    final String text;
    final Color fg;
    final Color bg;

    if (kidActive) {
      icon = Icons.schedule_rounded;
      text = '孩子模式 · 剩余 ${_mmss(kidSeconds)}';
      fg = AppColors.primaryText;
      bg = AppColors.primarySoft;
    } else if (kidExpired) {
      icon = Icons.timer_off_outlined;
      text = '孩子模式已到时间 · 输入 PIN 收回';
      fg = AppColors.pointSpend;
      bg = AppColors.cream;
    } else if (parentMode && pinBacked && parentSeconds > 0) {
      icon = Icons.timer_outlined;
      text = '家长模式 · 剩余 ${_mmss(parentSeconds)}';
      fg = AppColors.primaryText;
      bg = AppColors.primarySoft;
    } else if (parentMode && pinBacked) {
      icon = Icons.lock_clock_rounded;
      text = '家长模式已结束 · 输入 PIN 再开 5 分钟';
      fg = AppColors.pointSpend;
      bg = AppColors.cream;
    } else if (parentMode && sessionBacked) {
      icon = Icons.verified_user_outlined;
      text = '家长身份（登录会话）· 无 5 分钟倒计时';
      fg = AppColors.primaryText;
      bg = AppColors.primarySoft;
    } else {
      icon = Icons.lock_outline_rounded;
      text = '孩子权限 · 输入 PIN 进入家长模式';
      fg = AppColors.textSecondary;
      bg = AppColors.chipBg;
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: widget.onTap,
          borderRadius: BorderRadius.circular(14),
          child: Ink(
            padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: <Widget>[
                Icon(icon, size: 15, color: fg),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11.5,
                      height: 1.4,
                      fontWeight: FontWeight.w600,
                      color: fg,
                    ),
                  ),
                ),
                Icon(Icons.chevron_right_rounded, size: 17, color: fg),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 秒 → `4:57`（分钟不补零、秒补零，与家长模式面板同一口径）。
  static String _mmss(int seconds) {
    final int safe = seconds < 0 ? 0 : seconds;
    final String rest = (safe % 60).toString().padLeft(2, '0');
    return '${safe ~/ 60}:$rest';
  }
}