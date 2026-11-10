import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../models/onboarding.dart' show validateParentPin;
import '../theme/app_colors.dart';
import '../widgets/gradient_page.dart';
import '../widgets/page_header.dart';
import '../widgets/pin_pad.dart';
import '../widgets/soft_button.dart';
import 'parent_pin_reset_screen.dart';

/// 设置 / 修改家长 PIN（2026-11-04）。
///
/// ── 两个入口，同一份界面 ────────────────────────────────────────────────────
///   · **首启闸门**（[gate] = true）：家长第一次进 App，但账号还没有 PIN
///     ⇒ 强制设一个（没有返回按钮；退出登录是唯一出口，见 [onSignOut]）；
///   · **「我的 → 家长模式 → 修改 PIN」**（[gate] = false）：普通二级页。
///
/// ── 为什么三步而不是一个表单 ────────────────────────────────────────────────
///   PIN 是**看不见**的：一次输入错了，要到下次解锁才发现。所以：
///     ① 已有 PIN 时必须先证明「知道旧的」（服务端验，走 verify 端点）；
///     ② 新 PIN 输两遍，不一致当场说，而不是存进去再说。
///   三步都用锁屏式数字键盘（[PinPad]），全程没有系统键盘、没有明文回显。
///
/// ── 改完之后会发生什么（界面必须说清）─────────────────────────────────────
///   · 其它设备上的旧 PIN **立刻失效**（PIN 落在成员位上）；
///   · 「忘记 PIN」目前**没有**找回通道 —— 只能由另一位家长重设
///     （`backend/src/auth/auth.service.ts#setParentPin` 的已知缺口）。
class ParentPinSetupScreen extends StatefulWidget {
  const ParentPinSetupScreen({
    super.key,
    this.gate = false,
    this.onDone,
    this.onSignOut,
  });

  /// true = 首启闸门：没有返回按钮，只留「退出登录」这一条出路。
  final bool gate;

  /// 保存成功后的回调（闸门靠它 `setState` 放行；二级页为空时自行 `pop`）。
  final VoidCallback? onDone;

  /// 「退出登录，用手机号 / 密码重新登录」——只在闸门模式下显示，
  /// 由 `PinGuard` 从 `SessionActions` 借来（同一份实现）。
  final Future<void> Function()? onSignOut;

  @override
  State<ParentPinSetupScreen> createState() => _ParentPinSetupScreenState();
}

/// 三步：验证旧 PIN（改 PIN 才有）→ 输入新 PIN → 再输一遍。
enum _Step { current, creating, confirm }

class _ParentPinSetupScreenState extends State<ParentPinSetupScreen> {
  final PinInputController _pin = PinInputController();

  late AppStore _store;
  bool _storeReady = false;

  _Step _step = _Step.current;
  String? _currentPin;
  String? _newPin;
  String? _error;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _store = AppScope.of(context);
    if (_storeReady) return;
    _storeReady = true;
    // 已设过 PIN ⇒ 先验旧的；没设过 ⇒ 直接设（服务端此时不要求 currentPin）。
    _step = _store.isParentPinConfigured ? _Step.current : _Step.creating;
  }

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  bool get _needsCurrent => _store.isParentPinConfigured;

  @override
  Widget build(BuildContext context) {
    final String title = widget.gate
        ? '先设置家长 PIN'
        : (_needsCurrent ? '修改家长 PIN' : '设置家长 PIN');
    final String subtitle = switch (_step) {
      _Step.current => '请输入当前的家长 PIN，确认是家长本人。',
      _Step.creating => '设一个 4–6 位数字。之后每次打开 App、从后台回来都要它。',
      _Step.confirm => '请再输一遍，确认没有按错。',
    };

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              PageHeader(
                title: title,
                onBack:
                    widget.gate ? null : () => Navigator.of(context).maybePop(),
              ),
              if (widget.gate) ...<Widget>[
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                  decoration: BoxDecoration(
                    color: AppColors.primarySoft,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: const Text(
                    '这台设备现在默认是家长模式。设一个 PIN，孩子拿到手机时就进不去；'
                    '家长每次解锁都要输它。',
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.6,
                      color: AppColors.primaryText,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 14),
              Text(
                subtitle,
                style: const TextStyle(
                  fontSize: 13,
                  height: 1.5,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 22),
              if (_busy) const LinearProgressIndicator(minHeight: 2),
              const SizedBox(height: 6),
              PinPad(
                controller: _pin,
                enabled: !_busy,
                errorText: _error,
                hintText: '4–6 位数字',
              ),
              const SizedBox(height: 22),
              // 与锁屏同一个坑：按钮的可用性取决于输入位数，必须跟着控制器重建。
              ValueListenableBuilder<String>(
                valueListenable: _pin,
                builder: (BuildContext context, String value, _) {
                  final bool ready = !_busy && _pin.isReady;
                  return SoftButton(
                    label: _actionLabel,
                    icon: _step == _Step.confirm
                        ? Icons.check_rounded
                        : Icons.arrow_forward_rounded,
                    enabled: ready,
                    onTap: ready ? _submit : null,
                  );
                },
              ),
              const SizedBox(height: 18),
              Text(
                _needsCurrent
                    ? '改掉之后，其它设备上的旧 PIN 立刻失效。'
                    : '忘记 PIN 时可以用账号密码联网重置（入口在下面）。',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 11.5,
                  height: 1.6,
                  color: AppColors.textHint,
                ),
              ),
              // 用户第 7 条：忘记 PIN 的**联网**重置入口。
              // 只在「需要先验证旧 PIN」这一步显示 —— 新 PIN 阶段点它没有意义。
              if (_step == _Step.current)
                Center(
                  child: TextButton(
                    onPressed: _busy ? null : _openReset,
                    child: const Text('忘记当前 PIN？用账号密码重置'),
                  ),
                ),
              if (widget.gate && widget.onSignOut != null) ...<Widget>[
                const SizedBox(height: 6),
                Center(
                  child: TextButton.icon(
                    onPressed: _busy ? null : widget.onSignOut,
                    icon: const Icon(Icons.logout_rounded, size: 18),
                    label: const Text('退出登录，用手机号/密码重新登录'),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  String get _actionLabel => switch (_step) {
        _Step.current => '验证当前 PIN',
        _Step.creating => '下一步',
        _Step.confirm => '保存 PIN',
      };

  Future<void> _submit() async {
    final String value = _pin.value;
    if (!_pin.isReady) {
      setState(() => _error = '家长 PIN 是 4–6 位数字。');
      return;
    }
    switch (_step) {
      case _Step.current:
        await _verifyCurrent(value);
      case _Step.creating:
        _acceptNewPin(value);
      case _Step.confirm:
        await _save(value);
    }
  }

  /// ① 验证旧 PIN（**只校验**，不改角色 —— 否则这台 30 天的家长设备会被
  ///    压成 5 分钟，见 `docs/design/52-app-pin-lock.md` §3）。
  Future<void> _verifyCurrent(String value) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await _store.checkParentPin(value);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
      if (failure == null) {
        _currentPin = value;
        _step = _Step.creating;
        _pin.clear();
      }
    });
  }

  /// ② 新 PIN：本地形状预检（与服务端同一份规则），通过后进入「再输一遍」。
  void _acceptNewPin(String value) {
    final String? invalid = validateParentPin(value);
    if (invalid != null) {
      setState(() => _error = invalid);
      return;
    }
    setState(() {
      _newPin = value;
      _step = _Step.confirm;
      _error = null;
      _pin.clear();
    });
  }

  /// 忘记当前 PIN ⇒ 联网重置（账号密码）。成功后回到「设置新 PIN」这一步 ——
  /// 重置页已经让家长设过并确认了新 PIN，这里不让同一个人再输第三遍。
  Future<void> _openReset() async {
    final String? newPin = await Navigator.of(context).push<String>(
      MaterialPageRoute<String>(
        builder: (_) => const ParentPinResetScreen(),
      ),
    );
    if (!mounted || newPin == null) return;
    setState(() {
      _error = null;
      _step = _Step.creating;
      _newPin = null;
      _pin.clear();
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('家长 PIN 已重置，可以继续修改或直接返回。')),
    );
  }

  /// ③ 两次一致 ⇒ 提交。`currentPin` 只在「已设过 PIN」时传。
  Future<void> _save(String value) async {
    if (value != _newPin) {
      setState(() {
        _error = '两次输入不一致，请重新输入。';
        _step = _Step.creating;
        _newPin = null;
        _pin.clear();
      });
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final bool hadPin = _needsCurrent;
    final String? failure = await _store.setParentPin(
      pin: value,
      currentPin: hadPin ? _currentPin : null,
    );
    if (!mounted) return;
    final bool changed = _store.lastParentPinResult?.changed ?? false;
    setState(() {
      _busy = false;
      _error = failure;
      if (failure == null) _pin.clear();
    });
    if (failure != null) return;

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(changed ? '家长 PIN 已修改' : '家长 PIN 已设置')),
    );
    final VoidCallback? onDone = widget.onDone;
    if (onDone != null) {
      onDone();
      return;
    }
    Navigator.of(context).maybePop();
  }
}

