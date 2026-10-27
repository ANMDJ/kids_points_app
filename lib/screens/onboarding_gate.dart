import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../theme/app_colors.dart';
import 'onboarding_screen.dart';

/// 首启引导的**闸门**（W8-B，2026-10-27 / `04` §3、§6 4.1 / 4.8）。
///
/// ── 它只做一件事：用服务端事实决定「进首页还是进引导」 ──────────────────────
///   `Child.onboardedAt` 是权威状态（`04` §3），客户端不缓存。因此启动时先问
///   一次 `GET /onboarding`，拿到 `onboarded: false` 才把界面切到引导。
///
/// ── 三种「问不到」的处理（都**不阻塞**应用） ────────────────────────────────
///   ① 没注入引导客户端（预览数据 / 测试夹具）⇒ 直接进首页；
///   ② 403（孩子身份 / 只读成员）⇒ 直接进首页 —— 引导只能由家长完成，
///      孩子设备被拦在引导里只会得到一个「只有家长能操作」的死页面；
///   ③ 网络错误 / 501 ⇒ 也进首页，同时把原因记在 `store.onboardingError`，
///      「我的」页仍可手动重试或进入引导。
///   ★ 这与「未完成引导就进首页」不是同一件事：①–③ 都是**不知道**，
///     而 `onboarded: false` 是**知道**。把「不知道」当「未完成」会让一次超时
///     变成一场无法完成的强制引导。
class OnboardingGate extends StatefulWidget {
  const OnboardingGate({super.key, required this.child});

  /// 闸门放行后要显示的页面（首页外壳）。
  final Widget child;

  @override
  State<OnboardingGate> createState() => _OnboardingGateState();
}

class _OnboardingGateState extends State<OnboardingGate> {
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    final AppStore store = AppScope.of(context);
    if (!store.hasOnboarding) return;
    // 不能在 build / didChangeDependencies 里同步 notify（`refreshOnboarding`
    // 一开始就把状态置为 loading）—— 推到下一帧。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !store.hasOnboarding) return;
      store.refreshOnboarding();
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    if (!store.hasOnboarding) return widget.child;

    final bool unknown = store.onboarding == null &&
        (store.onboardingReadStatus == ReadStatus.idle ||
            store.onboardingReadStatus == ReadStatus.loading);
    if (unknown) {
      return const _OnboardingSplash();
    }

    // 「拉失败」与「孩子身份」都走这里：不拦，但也不假装知道。
    if (store.needsOnboarding) {
      return OnboardingScreen(onFinished: () => setState(() {}));
    }
    return widget.child;
  }
}

/// 确认引导状态时的等待态。
///
/// 只有一次 `GET`，正常在几百毫秒内结束 —— 因此不做骨架屏，也不用
/// 可点击的「跳过」：跳过等于替用户决定「你已经引导过了」。
class _OnboardingSplash extends StatelessWidget {
  const _OnboardingSplash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: AppColors.pageTop,
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text('🌱', style: TextStyle(fontSize: 40)),
              SizedBox(height: 16),
              Text(
                '积分小管家',
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary,
                ),
              ),
              SizedBox(height: 18),
              SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2.4),
              ),
              SizedBox(height: 12),
              Text(
                '正在确认引导状态…',
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
