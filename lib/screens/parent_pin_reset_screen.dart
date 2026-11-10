import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../models/onboarding.dart' show validateParentPin;
import '../theme/app_colors.dart';
import '../widgets/gradient_page.dart';
import '../widgets/page_header.dart';
import '../widgets/pin_pad.dart';
import '../widgets/soft_button.dart';

/// 忘记家长 PIN ⇒ 用**账号密码**联网重置（2026-11-10，用户第 7 条）。
///
/// ── 它为什么必须存在（而不是「只能由另一位家长重设」）──────────────────────
///   孩子模式到期（W14 的 A 方案）或家长自己忘了 PIN 时，设备停在 `child`；
///   「修改 PIN」要 `manage_parent_pin`，而矩阵里孩子是 **DENY** ——
///   那一刻改不了。服务端因此单开了一条只要求 `switch_role_mode` 的路由
///   （`POST /auth/parent-pin/reset`，`docs/design/53` §2），凭据是登录密码。
///
/// ── 三步，且顺序刻意是「先密码、后新 PIN」──────────────────────────────────
///   ① 密码：这是唯一能证明「你是这个账号」的东西（PIN 正是忘掉的那个）；
///   ② 新 PIN：输一遍；
///   ③ 再输一遍：PIN 看不见，输错了要到下次解锁才发现。
///   密码框用系统键盘（它可能很长）；两个 PIN 用锁屏式键盘（`PinPad`）。
///
/// ── 成功后会发生什么（界面必须说清）────────────────────────────────────────
///   · 旧 PIN（如果还记得）和其它设备上的 PIN **立刻失效**；
///   · 失败计数与锁定被清零；
///   · **不会**自动进入家长模式 —— 重置只换钥匙（服务端同一条口径）。
///     锁屏进来的调用方会在成功后用新 PIN 走一次解锁。
class ParentPinResetScreen extends StatefulWidget {
  const ParentPinResetScreen({
    super.key,
    this.onReset,
    this.initialPassword,
  });

  /// 重置成功后的回调（拿到**新 PIN**）。`null` ⇒ 直接 `pop(新 PIN)`。
  final Future<void> Function(String newPin)? onReset;

  /// 预填的密码（锁屏 / 设置页拿不到密码，留空即可；测试可注入）。
  final String? initialPassword;

  @override
  State<ParentPinResetScreen> createState() => _ParentPinResetScreenState();
}
enum _ResetStep { password, creating, confirm }

class _ParentPinResetScreenState extends State<ParentPinResetScreen> {
  late final TextEditingController _password =
      TextEditingController(text: widget.initialPassword ?? '');
  final PinInputController _pin = PinInputController();

  _ResetStep _step = _ResetStep.password;
  String? _newPin;
  String? _error;
  bool _busy = false;
  bool _obscure = true;

  @override
  void dispose() {
    _password.dispose();
    _pin.dispose();
    super.dispose();
  }

  String get _subtitle => switch (_step) {
        _ResetStep.password => '输入这个账号的登录密码（不是家长 PIN）。',
        _ResetStep.creating => '设一个 4–6 位数字的新 PIN。',
        _ResetStep.confirm => '请再输一遍，确认没有按错。',
      };

  String get _actionLabel => switch (_step) {
        _ResetStep.password => '下一步',
        _ResetStep.creating => '下一步',
        _ResetStep.confirm => '重置 PIN',
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          children: <Widget>[
            PageHeader(
              title: '重置家长 PIN',
              onBack: _busy ? null : () => Navigator.of(context).maybePop(),
            ),
            const SizedBox(height: 4),
            Text(
              _subtitle,
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.6,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 18),
            ..._body(),
            const SizedBox(height: 16),
            const Text(
              '重置只换一把钥匙：成功后旧 PIN 立刻失效，'
              '并且不会自动进入家长模式。',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 11.5,
                height: 1.6,
                color: AppColors.textHint,
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body() {
    if (_step == _ResetStep.password) {
      return <Widget>[
        TextField(
          controller: _password,
          enabled: !_busy,
          obscureText: _obscure,
          autofocus: true,
          decoration: InputDecoration(
            labelText: '登录密码',
            hintText: '注册 / 改密时用的那个密码',
            suffixIcon: IconButton(
              tooltip: _obscure ? '显示密码' : '隐藏密码',
              icon: Icon(
                _obscure
                    ? Icons.visibility_off_outlined
                    : Icons.visibility_outlined,
                size: 20,
              ),
              onPressed: () => setState(() => _obscure = !_obscure),
            ),
          ),
          onSubmitted: (_) => _submit(),
        ),
        if (_error != null) ...<Widget>[
          const SizedBox(height: 10),
          Text(
            _error!,
            style: const TextStyle(
              fontSize: 12.5,
              height: 1.5,
              color: AppColors.pointSpend,
            ),
          ),
        ],
        const SizedBox(height: 16),
        SoftButton(
          label: _busy ? '正在提交…' : _actionLabel,
          icon: Icons.arrow_forward_rounded,
          enabled: !_busy,
          onTap: _busy ? null : _submit,
        ),
      ];
    }
    return <Widget>[
      const SizedBox(height: 6),
      PinPad(
        controller: _pin,
        enabled: !_busy,
        errorText: _error,
        hintText: '4–6 位数字',
      ),
      const SizedBox(height: 20),
      ValueListenableBuilder<String>(
        valueListenable: _pin,
        builder: (BuildContext context, String value, _) {
          final bool ready = !_busy && _pin.isReady;
          return SoftButton(
            label: _busy ? '正在提交…' : _actionLabel,
            icon: Icons.lock_reset_rounded,
            enabled: ready,
            onTap: ready ? _submit : null,
          );
        },
      ),
      const SizedBox(height: 10),
      TextButton(
        onPressed: _busy
            ? null
            : () => setState(() {
                  _step = _ResetStep.password;
                  _newPin = null;
                  _pin.clear();
                  _error = null;
                }),
        child: const Text('返回，重新输入密码'),
      ),
    ];
  }

  Future<void> _submit() async {
    switch (_step) {
      case _ResetStep.password:
        if (_password.text.trim().isEmpty) {
          setState(() => _error = '请输入登录密码（不是家长 PIN）。');
          return;
        }
        setState(() {
          _error = null;
          _step = _ResetStep.creating;
          _pin.clear();
        });
        return;
      case _ResetStep.creating:
        final String value = _pin.value;
        final String? invalid = validateParentPin(value);
        if (invalid != null) {
          setState(() => _error = invalid);
          return;
        }
        setState(() {
          _newPin = value;
          _step = _ResetStep.confirm;
          _error = null;
          _pin.clear();
        });
        return;
      case _ResetStep.confirm:
        await _save(_pin.value);
    }
  }

  Future<void> _save(String value) async {
    if (value != _newPin) {
      setState(() {
        _error = '两次输入不一致，请重新输入。';
        _step = _ResetStep.creating;
        _newPin = null;
        _pin.clear();
      });
      return;
    }
    final AppStore store = AppScope.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await store.resetParentPin(
      password: _password.text,
      newPin: value,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
      if (failure != null) _pin.clear();
    });
    if (failure != null) return;

    final String newPin = value;
    final Future<void> Function(String)? onReset = widget.onReset;
    if (onReset != null) {
      await onReset(newPin);
      return;
    }
    Navigator.of(context).pop(newPin);
  }
}
