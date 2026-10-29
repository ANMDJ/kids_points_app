import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../models/onboarding.dart' show validateParentPin;
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/sheet_frame.dart';

/// 打开「家长模式」面板（W8-C）—— 入口固定在「我的」页。
Future<void> showParentModeSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return ParentModeSheet(store: store, messenger: messenger);
    },
  );
}

/// 家长模式（W8-C）：用 PIN 换 5 分钟家长权限，或立刻退出。
///
/// ── 这个面板要回答的三个问题 ────────────────────────────────────────────────
///   ① **我现在是不是家长模式**：服务端事实（`activeRole`），不是本地开关；
///   ② **还剩多久**：从 `parentModeExpiresAt` 现算 —— 面板里每秒重绘的是
///      「剩余秒数」，不是"减了 1 的计数器"，所以切到后台再回来也对得上；
///   ③ **输错了会怎样**：还剩几次 / 锁定到什么时候，必须写在输入框旁边 ——
///      家长连错 5 次会被锁 15 分钟，而"锁 15 分钟"这件事如果不提前说，
///      就会被读成"应用坏了"。
///
/// ── 为什么退出不需要 PIN ────────────────────────────────────────────────────
///   `02` §7：降级永远允许。孩子正拿着手机时，家长必须能立刻收回权限；
///   给"退出"加一道 PIN 等于把权限锁在家长模式里。
class ParentModeSheet extends StatefulWidget {
  const ParentModeSheet({super.key, required this.store, required this.messenger});

  final AppStore store;
  final ScaffoldMessengerState messenger;

  @override
  State<ParentModeSheet> createState() => _ParentModeSheetState();
}

class _ParentModeSheetState extends State<ParentModeSheet> {
  final TextEditingController _pin = TextEditingController();
  final TextEditingController _currentPin = TextEditingController();
  final TextEditingController _newPin = TextEditingController();

  /// 每秒重绘一次倒计时（只在需要时读取 `store.parentModeRemainingSeconds`）。
  Timer? _ticker;

  /// 本组件的在途标记（store 里另有 `isParentModeBusy` / `isParentPinBusy`）。
  bool _busy = false;

  /// 「设置 / 修改 PIN」折叠区是否展开。
  bool _pinEditorOpen = false;

  /// 面板内的即时错误（由 store 的返回值原样搬到界面上）。
  String? _error;

  @override
  void initState() {
    super.initState();
    // 等首帧之后再拉：`refreshParentMode` 一开始就会 `_notify()`，
    // 在 initState 里同步调用等于 build 期间 setState。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      widget.store.refreshParentMode();
    });
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _pin.dispose();
    _currentPin.dispose();
    _newPin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final AppStore store = widget.store;
    final DateTime now = DateTime.now();
    final bool parentMode = store.isParentMode;
    // ★ 「家长模式」有两种来源，说法必须分开（W8-C 验收抓到的缺陷）：
    //   · PIN 换的 5 分钟 ⇒ 倒计时；
    //   · 邀请码加入的家长设备 ⇒ 登录会话自带，倒计时毫无意义（30 天 = 43200:00）。
    final bool sessionBacked = store.isParentModeSessionBacked;
    final bool locked = store.isParentPinLockedAt(now);

    return SheetFrame(
      title: '家长模式',
      subtitle: !parentMode
          ? '输入家长 PIN 可以在这台设备上临时获得 5 分钟家长权限'
          : sessionBacked
              ? '这台设备已以家长身份登录，登录期间一直是家长权限'
              : '这台设备现在是家长权限（${_mmss(store.parentModeRemainingSeconds(now))} 后自动收回）',
      actionLabel: parentMode
          ? '退出家长模式'
          : locked
              ? '已锁定，请稍后再试'
              : '进入家长模式',
      actionIcon: parentMode
          ? Icons.lock_open_rounded
          : Icons.lock_outline_rounded,
      onAction: _busy || (!parentMode && locked)
          ? null
          : (parentMode ? _exit : _enter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          ..._statusRows(now, parentMode, locked),
          const SizedBox(height: 12),
          ...(parentMode
              ? _parentModeRows(now, sessionBacked)
              : _childModeRows(now, locked)),
          ..._pinEditorRows(store),
          if (_error != null) ...<Widget>[
            const SizedBox(height: 10),
            _hint(_error!, danger: true),
          ],
        ],
      ),
    );
  }

  /// 顶部状态行：还在加载 / 读失败 / 已锁定 / 还剩几次。
  ///
  /// 这里**不猜**：`store.parentMode == null` 表示"还没拉到"，此时既不显示
  /// 「还剩 5 次」也不显示「还没设置 PIN」—— 两种猜法都会误导。
  List<Widget> _statusRows(DateTime now, bool parentMode, bool locked) {
    final AppStore store = widget.store;
    final bool known = store.parentMode != null;
    return <Widget>[
      if (store.parentModeReadStatus == ReadStatus.loading && !known)
        _hint('正在读取家长模式状态…'),
      if (store.parentModeError != null)
        _hint('状态没读成功：${store.parentModeError}', danger: true),
      if (locked)
        _hint(
          '家长 PIN 已锁定，请 ${_humanize(store.parentPinLockSecondsAt(now))}后再试。'
          '锁定期间服务端不校验 PIN，也不会因为继续尝试而延长。',
          danger: true,
        ),
      if (known && !locked && !parentMode && store.isParentPinConfigured)
        _hint('还剩 ${store.parentPinRemainingAttempts} 次尝试机会；连错 5 次会锁 15 分钟。'),
      // 已经在家长模式、却没有 PIN —— 典型是"用邀请码加入的家长设备"：
      // 权限来自登录会话，和 PIN 是两件独立的事，必须说清楚，否则家长会以为
      // 面板坏了（"我明明是家长，为什么让我先设置 PIN"）。
      if (known && parentMode && !store.isParentPinConfigured)
        _hint(
          '这台设备已经有家长权限，但这个账号还没有家长 PIN。'
          '设置之后，同一账号在「孩子拿着手机」时也能凭 PIN 临时切回家长模式。',
        ),
      if (known && !parentMode && !store.isParentPinConfigured)
        _hint(
          '这个账号还没有家长 PIN。孩子模式的会话没有设置权限 —— '
          '请先用家长账号进入一次家长模式，再在下面设置。',
          danger: true,
        ),
    ];
  }

  /// 不在家长模式时：PIN 输入框。
  List<Widget> _childModeRows(DateTime now, bool locked) {
    return <Widget>[
      const SizedBox(height: 4),
      TextField(
        controller: _pin,
        enabled: !locked && !_busy,
        keyboardType: TextInputType.number,
        obscureText: true,
        maxLength: 6,
        inputFormatters: <TextInputFormatter>[
          FilteringTextInputFormatter.digitsOnly,
        ],
        decoration: const InputDecoration(
          labelText: '家长 PIN',
          hintText: '4–6 位数字',
          counterText: '',
        ),
        onSubmitted: (_) {
          if (locked || _busy) return;
          _enter();
        },
      ),
    ];
  }

  /// 已经是家长模式时：倒计时（PIN 换的）或"以家长身份登录"（会话自带）。
  ///
  /// ★ 两种来源的界面**必须不同**：
  ///   · `pin` —— 有 5 分钟 TTL，倒计时是有效信息；
  ///   · `session` —— TTL 是登录会话（30 天），画成倒计时会变成 `43200:00`
  ///     这种"看起来像坏了"的数字。这里给一句确定的身份说明，并提醒共用设备
  ///     用完退出（退出只降级这台设备，不影响别的家长设备）。
  List<Widget> _parentModeRows(DateTime now, bool sessionBacked) {
    final int seconds = widget.store.parentModeRemainingSeconds(now);
    return <Widget>[
      AppCard(
        radius: 16,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: <Widget>[
            Icon(
              sessionBacked ? Icons.verified_user_outlined : Icons.timer_outlined,
              size: 20,
              color: AppColors.primaryDeep,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                sessionBacked
                    ? '已以家长身份登录'
                    : (seconds > 0 ? '还剩 ${_mmss(seconds)} 家长权限' : '家长权限已到期'),
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 8),
      _hint(
        sessionBacked
            ? '这台设备是家长设备：登录期间一直是家长权限，不会 5 分钟收回。'
                '和孩子共用同一台手机时，用完请点「退出家长模式」。'
            : '到期会自动收回；「退出家长模式」随时可用，不需要 PIN。',
      ),
    ];
  }

  /// 「设置 / 修改家长 PIN」折叠区。
  ///
  /// 默认收起：这个面板 90% 的用法是「进去 5 分钟」，把两个输入框摆在最上面
  /// 只会让人以为必须改 PIN 才能进去。
  ///
  /// ★ 已有 PIN 时**必须**填当前 PIN：否则任何拿到解锁手机的孩子都能改掉它，
  ///   PIN 就只是装饰。这条限制在服务端（`manage_parent_pin` 仅家长 ALLOW），
  ///   这里的输入框只是让家长少走一次 403。
  List<Widget> _pinEditorRows(AppStore store) {
    final bool configured = store.isParentPinConfigured;
    return <Widget>[
      const SizedBox(height: 6),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed:
              _busy ? null : () => setState(() => _pinEditorOpen = !_pinEditorOpen),
          icon: Icon(
            _pinEditorOpen ? Icons.expand_less_rounded : Icons.expand_more_rounded,
            size: 18,
          ),
          label: Text(configured ? '修改家长 PIN' : '设置家长 PIN'),
        ),
      ),
      if (_pinEditorOpen) ...<Widget>[
        if (configured) ...<Widget>[
          TextField(
            controller: _currentPin,
            enabled: !_busy,
            keyboardType: TextInputType.number,
            obscureText: true,
            maxLength: 6,
            inputFormatters: <TextInputFormatter>[
              FilteringTextInputFormatter.digitsOnly,
            ],
            decoration: const InputDecoration(
              labelText: '当前 PIN',
              counterText: '',
            ),
          ),
          const SizedBox(height: 8),
        ],
        TextField(
          controller: _newPin,
          enabled: !_busy,
          keyboardType: TextInputType.number,
          obscureText: true,
          maxLength: 6,
          inputFormatters: <TextInputFormatter>[
            FilteringTextInputFormatter.digitsOnly,
          ],
          decoration: InputDecoration(
            labelText: configured ? '新的 PIN' : '家长 PIN',
            hintText: '4–6 位数字',
            counterText: '',
          ),
        ),
        const SizedBox(height: 6),
        _hint(
          configured
              ? '改掉之后，其它设备上的旧 PIN 立刻失效；当前 5 分钟家长模式不受影响。'
              : '设置后进入家长模式就需要它。忘记 PIN 目前只能由另一位家长重新设置。',
        ),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerRight,
          child: FilledButton(
            onPressed: _busy ? null : _savePin,
            child: Text(configured ? '保存新 PIN' : '设置 PIN'),
          ),
        ),
      ],
    ];
  }

  // --------------------------------------------------------------- 动作

  Future<void> _enter() async {
    final String pin = _pin.text.trim();
    final String? invalid = validateParentPin(pin);
    if (pin.isEmpty || invalid != null) {
      setState(() => _error = pin.isEmpty ? '请输入家长 PIN。' : invalid);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await widget.store.enterParentMode(pin);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
      // 成功后清空输入框：明文 PIN 不该留在控制器里被下一次 build 带出去。
      if (failure == null) _pin.clear();
    });
    if (failure == null) _toast('已进入家长模式（5 分钟后自动收回）');
  }

  Future<void> _exit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await widget.store.exitParentMode();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
    });
    if (failure == null) _toast('已退出家长模式');
  }

  Future<void> _savePin() async {
    final AppStore store = widget.store;
    final bool configured = store.isParentPinConfigured;
    final String next = _newPin.text.trim();
    final String? invalid = validateParentPin(next);
    if (next.isEmpty || invalid != null) {
      setState(() => _error = next.isEmpty ? '请输入新的家长 PIN。' : invalid);
      return;
    }
    final String current = _currentPin.text.trim();
    if (configured && current.isEmpty) {
      setState(() => _error = '请输入当前家长 PIN。');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await store.setParentPin(
      pin: next,
      currentPin: configured ? current : null,
    );
    if (!mounted) return;
    final bool changed = store.lastParentPinResult?.changed ?? false;
    setState(() {
      _busy = false;
      _error = failure;
      if (failure == null) {
        _pinEditorOpen = false;
        _currentPin.clear();
        _newPin.clear();
      }
    });
    if (failure == null) _toast(changed ? '家长 PIN 已修改' : '家长 PIN 已设置');
  }

  void _toast(String message) {
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(SnackBar(content: Text(message)));
  }

  // --------------------------------------------------------------- 展示工具

  Widget _hint(String text, {bool danger = false}) {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12,
          height: 1.5,
          color: danger ? AppColors.pointSpend : AppColors.textSecondary,
        ),
      ),
    );
  }

  /// 秒 → `4:57`（分钟不补零，秒补零）。
  static String _mmss(int seconds) {
    final int safe = seconds < 0 ? 0 : seconds;
    final String rest = (safe % 60).toString().padLeft(2, '0');
    return '${safe ~/ 60}:$rest';
  }

  /// 秒 → 「14 分 59 秒」。锁定时长是 15 分钟，用 `14:59` 会让人误读成倒计时
  /// 之外的一段时间，所以这里用文字。
  static String _humanize(int seconds) {
    final int safe = seconds < 0 ? 0 : seconds;
    final int minutes = safe ~/ 60;
    final int rest = safe % 60;
    if (minutes == 0) return '$rest 秒';
    if (rest == 0) return '$minutes 分钟';
    return '$minutes 分 $rest 秒';
  }
}


