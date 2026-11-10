import 'dart:async';

import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../theme/app_colors.dart';
import '../widgets/gradient_page.dart';
import '../widgets/pin_pad.dart';
import '../widgets/soft_button.dart';
import 'parent_pin_reset_screen.dart';
import 'parent_pin_setup_screen.dart';
import 'session_actions.dart';

/// 本机 PIN 闸门（2026-11-04，**替代**原来的「6 位日期码」启动闸门）。
///
/// ── 它替掉的旧行为（用户原话：「那个锁屏没有意义」）────────────────────────
///   旧的 `DateCodeGate` 要家长算「月日 + 星期」得到一个可推导的 6 位数字。
///   它拦不住任何人（规则就写在界面上），却要求家长每次开机先做一道算术题。
///   现在改成**家长自己设的 PIN** —— 与「进入家长模式」用的是同一个 PIN。
///
/// ── 三个时刻会锁上 ────────────────────────────────────────────────────────
///   ① 冷启动：`isAppUnlocked` 初始为 false；
///   ② 退到后台（`paused` / `hidden`）⇒ `lockAppForBackground()`；
///   ③ 孩子模式窗口结束后回到前台 ⇒ `settleAppLockAfterResume()` 补锁。
///
/// ── 2026-11-10 语义修订（用户第 1 / 13 条）──────────────────────────────────
///   用户要的模型是「**输入 PIN = 进入家长模式，开始 5 分钟倒计时**」。
///   于是解锁走 `POST /auth/parent-mode`（不是只校验的 `verify`）：
///     · 不在家长模式 ⇒ 开一个 5 分钟窗口；
///     · 已经在窗口内 ⇒ 再输一次 = **重置**这 5 分钟；
///     · 孩子模式中 / 已到期 ⇒ 先 `DELETE /auth/kid-mode` 收回，再解锁。
///   5 分钟倒计时显示在四个 tab 的抬头栏（`widgets/parent_mode_banner.dart`）。
///
/// ── 两道**放行**（宁可少锁一次，也不能把人锁在门外）───────────────────────
///   · 一次都拉不到 `/auth/parent-mode`（断网 / 服务端旧）⇒ 不知道有没有 PIN，
///     直接放行：这道门是**软锁**，不是安全边界（真正的边界在服务端矩阵）；
///   · **孩子模式窗口内** ⇒ 手机本来就是给孩子用的，锁上会让孩子切一次应用
///     就再也回不来（窗口结束才锁，这正是 W14 的 A 方案）。
///
/// ── 没设 PIN 的家长设备 ⇒ 先设再进（需求 4(a)）─────────────────────────────
///   「当前不是默认家长模式吗？家长进来的时候先设置 PIN 码。」
///   于是：家长身份 + `pinConfigured == false` ⇒ 强制引导到设置页。
///   孩子设备没有 `manage_parent_pin` 权限（服务端 403），所以**不**在那里拦 ——
///   拦了就是第七个「做不到的提示」。
class PinGuard extends StatefulWidget {
  const PinGuard({super.key, required this.child});

  /// 解锁后要显示的页面（引导闸门 → 首页外壳）。
  final Widget child;

  @override
  State<PinGuard> createState() => _PinGuardState();
}

class _PinGuardState extends State<PinGuard> with WidgetsBindingObserver {
  late AppStore _store;
  bool _ready = false;

  /// 已经排了一次「下一帧去拉状态」（防止 `didChangeDependencies` 连跑多次
  /// 排出一串重复请求）。
  bool _fetchScheduled = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// 每次 store 通知都会走到这里（`AppScope` 是 `InheritedNotifier`）。
  ///
  /// ★ 不能用「只拉一次」的标记：换账号 / 换孩子后 `store.resetForIdentity()`
  ///   会把 `parentMode` 清成 null。一次性标记会让闸门永远停在「正在准备本机锁…」
  ///   —— 那是一个比「没锁」更糟的假象（用例 `换身份后重新拉状态` 钉着它）。
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _store = AppScope.of(context);
    _ready = true;
    final AppStore store = _store;
    if (!store.hasParentMode) return;
    if (store.parentMode != null) return;
    // loading：已经有请求在飞；error：不无限重试（下拉 / 回前台会再试）。
    if (store.parentModeReadStatus == ReadStatus.loading) return;
    if (store.parentModeReadStatus == ReadStatus.error) return;
    if (_fetchScheduled) return;
    _fetchScheduled = true;
    // 不在 build / didChangeDependencies 里同步 notify（refresh 一上来就置 loading）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _fetchScheduled = false;
      if (!mounted) return;
      final AppStore current = _store;
      if (!current.hasParentMode || current.parentMode != null) return;
      if (current.parentModeReadStatus == ReadStatus.loading) return;
      if (current.parentModeReadStatus == ReadStatus.error) return;
      unawaited(current.refreshParentMode());
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_ready) return;
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) {
      // 「只要退出前台，回来就要重新输 PIN」——需求 4(b)。
      _store.lockAppForBackground();
      return;
    }
    if (state != AppLifecycleState.resumed) return;
    // 后台期间孩子模式可能结束了 ⇒ 先补锁；再对齐一次服务端事实
    // （PIN 可能刚在另一台设备上被改，角色也可能已到期）。
    _store.settleAppLockAfterResume();
    if (_store.hasParentMode) unawaited(_store.refreshParentMode());
  }

  /// 「退出登录」借闸门那一份实现（与 `parent_mode_sheet.dart` 同一手法）：
  /// 锁屏 / 设置页是最后一道门，必须有**一条**出路。
  Future<void> Function()? get _signOut =>
      context.findAncestorWidgetOfExactType<SessionActions>()?.signOut;

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    // 预览 / 测试夹具：没有 PIN 可验，整道门不启用。
    if (!store.hasParentMode) return widget.child;

    final ReadStatus status = store.parentModeReadStatus;
    if (store.parentMode == null) {
      // 拉失败（断网 / 旧服务端）⇒ 放行；还在拉 ⇒ 只说一句「正在准备」，
      // 先露一眼首页就等于把锁绕过去了。
      if (status == ReadStatus.error) return widget.child;
      return const _PinGuardSplash();
    }

    if (!store.isParentPinConfigured) {
      // 家长设备 + 没 PIN：先设再进。孩子设备没权限设，交给面板的说明。
      if (!store.isParentMode) return widget.child;
      return ParentPinSetupScreen(
        gate: true,
        onDone: () => setState(() {}),
        onSignOut: _signOut,
      );
    }

    // 孩子模式窗口内不锁（见文件头）；窗口结束后 `isKidModeActiveAt` 为 false，
    // 于是下一次重建 / 回到前台就会落到下面的锁屏。
    if (store.isKidModeActiveAt(DateTime.now())) return widget.child;
    if (store.isAppUnlocked) return widget.child;
    // ★ 用 `Offstage` 保留首页子树（而不是直接不建它）：家长从后台回来只是
    //   临时离开，解锁后应该回到**原来那个 tab**、列表也还在；换成
    //   `return 锁屏` 会让 HomeShell 整棵重建（跳回首页 + 重新拉一遍数据）。
    //   `Offstage` 不布局、不绘制、收不到输入，也不会被 `find.text` 找到。
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        Offstage(offstage: true, child: widget.child),
        _PinLockScreen(store: store, onSignOut: _signOut),
      ],
    );
  }
}

/// 确认「有没有 PIN」时的等待态。
///
/// 只有一次 `GET /auth/parent-mode`，正常几百毫秒 —— 不给可点的「跳过」：
/// 跳过等于替用户决定「这台设备没有锁」。
class _PinGuardSplash extends StatelessWidget {
  const _PinGuardSplash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: AppColors.pageTop,
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text('🔒', style: TextStyle(fontSize: 38)),
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
                '正在准备本机锁…',
                style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 锁着时的整页界面：锁屏式数字键盘 + 「解锁」。
class _PinLockScreen extends StatefulWidget {
  const _PinLockScreen({required this.store, this.onSignOut});

  final AppStore store;

  /// 唯一出路：「用手机号 / 密码重新登录」。只在**已经出过错**（输错 / 被锁）
  /// 时出现 —— 一进来就摆一个大按钮会被误认为推荐动作。
  final Future<void> Function()? onSignOut;

  @override
  State<_PinLockScreen> createState() => _PinLockScreenState();
}

class _PinLockScreenState extends State<_PinLockScreen> {
  final PinInputController _pin = PinInputController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _unlock() async {
    if (_busy || !_pin.isReady) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await widget.store.unlockAppWithPin(_pin.value);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
      // 失败就清空：留着上一串数字会让人以为「再点一次就行」。
      if (failure != null) _pin.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final DateTime now = DateTime.now();
    final bool kidActive = widget.store.isKidModeActiveAt(now);
    final bool kidExpired = widget.store.isKidModeExpiredAt(now);
    final int lockSeconds = widget.store.parentPinLockSecondsAt(now);
    final bool locked = widget.store.isParentPinLockedAt(now) || lockSeconds > 0;
    final bool parentMode = widget.store.isParentMode;
    final bool pinBacked = widget.store.isParentModePinBacked;
    final int parentSeconds = widget.store.parentModeRemainingSeconds(now);

    // 副标题必须说清「这次输 PIN 会发生什么」（用户第 13 条）：
    //   · 孩子模式中 / 已到期 ⇒ 收回孩子模式（不是「解锁」了事）；
    //   · 已在 5 分钟窗口内     ⇒ 再输一次会**重置**成 5 分钟；
    //   · 其余                 ⇒ 开一个新的 5 分钟窗口。
    final String subtitle;
    if (kidActive || kidExpired) {
      subtitle = kidExpired
          ? '孩子模式的时间到了。输入家长 PIN 会结束孩子模式，并回到家长权限。'
          : '孩子模式进行中。输入家长 PIN 可以提前收回这台手机。';
    } else if (parentMode && pinBacked && parentSeconds > 0) {
      subtitle = '家长模式还剩 ${_mmss(parentSeconds)}。'
          '再输一次 PIN 会重新计时 5 分钟。';
    } else {
      subtitle = '输入家长 PIN 进入家长模式（5 分钟，可随时再输一次续期）。';
    }

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: SafeArea(
          child: Column(
            children: <Widget>[
              // 上半部分（说明 / 错误）可滚动：小屏 + 长错误文案不会把键盘顶出屏幕。
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(24, 28, 24, 8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: <Widget>[
              Center(
                child: Container(
                  width: 68,
                  height: 68,
                  decoration: const BoxDecoration(
                    color: AppColors.primarySoft,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.lock_rounded,
                    size: 30,
                    color: AppColors.primaryDeep,
                  ),
                ),
              ),
              const SizedBox(height: 14),
              const Text(
                '已锁定',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 21,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                subtitle,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.6,
                  color: AppColors.textSecondary,
                ),
              ),
              if (_busy) ...<Widget>[
                const SizedBox(height: 14),
                const LinearProgressIndicator(minHeight: 2),
              ],
                    ],
                  ),
                ),
              ),
              // 下半部分：数字键盘靠近屏幕底部（用户第 5 条「符合人体工程学」）。
              // 键盘自己会变大（用户第 4 条），所以这里不再给它额外的大边距。
              SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
              PinPad(
                controller: _pin,
                enabled: !_busy,
                errorText: _error ??
                    (locked
                        ? '家长 PIN 已连续输错，暂时锁定。'
                            '请 ${_humanize(lockSeconds)}后再试。'
                        : null),
                hintText: '4–6 位数字',
              ),
              const SizedBox(height: 18),
              // ★ 必须包一层 `ValueListenableBuilder`：按钮的可用状态取决于
              //   「敲了几位」，而输入状态在 `PinPad` 内部变化 —— 不监听的话，
              //   家长敲满 4 位后「解锁」仍然是灰的（实测踩到）。
              ValueListenableBuilder<String>(
                valueListenable: _pin,
                builder: (BuildContext context, String value, _) {
                  final bool ready = !_busy && _pin.isReady;
                  return SoftButton(
                    label: _busy ? '正在校验…' : '解锁',
                    icon: Icons.lock_open_rounded,
                    enabled: ready,
                    onTap: ready ? _unlock : null,
                  );
                },
              ),
              const SizedBox(height: 6),
              // 用户第 7 条：忘记 PIN 时有一条**联网**重置的路。
              // 它走账号密码（`POST /auth/parent-pin/reset`），
              // 成功后用刚设的新 PIN 直接解锁本机。
              Center(
                child: TextButton(
                  onPressed: _busy ? null : _openReset,
                  child: const Text('忘记 PIN？用账号密码重置'),
                ),
              ),
              const Text(
                '这是本机的入口锁：解锁会同时打开 5 分钟家长权限。'
                '（断网时无法校验，锁门会放行。）',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11,
                  height: 1.55,
                  color: AppColors.textHint,
                ),
              ),
              if (widget.onSignOut != null && (_error != null || locked))
                Center(
                  child: TextButton.icon(
                    onPressed: _busy ? null : widget.onSignOut,
                    icon: const Icon(Icons.logout_rounded, size: 18),
                    label: const Text('用手机号/密码重新登录'),
                  ),
                ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 忘记 PIN ⇒ 重置页；成功后用**新 PIN** 解锁（家长刚刚亲手设过它）。
  Future<void> _openReset() async {
    final String? newPin = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(
        builder: (_) => const ParentPinResetScreen(),
      ),
    );
    if (!mounted || newPin == null) return;
    _pin.value = newPin;
    await _unlock();
  }

  /// 秒 → `4:57`（与家长模式面板 / 顶部状态条同一口径）。
  static String _mmss(int seconds) {
    final int safe = seconds < 0 ? 0 : seconds;
    final String rest = (safe % 60).toString().padLeft(2, '0');
    return '${safe ~/ 60}:$rest';
  }

  static String _humanize(int seconds) {
    final int safe = seconds < 0 ? 0 : seconds;
    final int minutes = safe ~/ 60;
    final int rest = safe % 60;
    if (minutes == 0) return '$rest 秒';
    if (rest == 0) return '$minutes 分钟';
    return '$minutes 分 $rest 秒';
  }
}
