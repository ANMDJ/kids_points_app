import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../models/kid_mode.dart';
import '../../models/onboarding.dart' show validateParentPin;
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/sheet_frame.dart';
import '../session_actions.dart';

/// 打开「家长模式」面板（W8-C）—— 入口固定在「我的」页。
Future<void> showParentModeSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  // D7（2026-11-03）：引导期跳过 PIN 的存量账号 5 分钟后会卡在
  // 「没有 PIN ⇒ 进不去家长模式 ⇒ 也没权限设 PIN」。唯一能走的路是重新登录，
  // 而「退出登录」只有 `AccountGate` 那一份实现 —— 在这里**借**它，不另写一份。
  // `null`（预览 / 未登录）⇒ 面板不画那个按钮。
  // 用 `findAncestorWidgetOfExactType`（而不是 `maybeOf` 的 `dependOnInherited…`）：
  // 这里在回调里读一次就完事，不该在「我的」页上注册一条重建依赖。
  final Future<void> Function()? signOut =
      context.findAncestorWidgetOfExactType<SessionActions>()?.signOut;
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return ParentModeSheet(
        store: store,
        messenger: messenger,
        signOut: signOut,
      );
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
  const ParentModeSheet({
    super.key,
    required this.store,
    required this.messenger,
    this.signOut,
  });

  final AppStore store;
  final ScaffoldMessengerState messenger;

  /// 「退出登录」——由 `showParentModeSheet()` 从 [SessionActions] 借来
  /// （同一份实现，见 `session_actions.dart` 文件头）。
  ///
  /// 只在一种情况下用到：**没有家长 PIN、又不在家长模式**。这是引导期
  /// 跳过 PIN 的存量账号的绝境（`43` §8 D7）：5 分钟窗口一过就回落 `child`，
  /// 既进不了家长模式，也没权限补设 PIN。`null` ⇒ 不画这个按钮。
  final Future<void> Function()? signOut;

  @override
  State<ParentModeSheet> createState() => _ParentModeSheetState();
}

class _ParentModeSheetState extends State<ParentModeSheet> {
  final TextEditingController _pin = TextEditingController();
  final TextEditingController _currentPin = TextEditingController();
  final TextEditingController _newPin = TextEditingController();

  /// 结束孩子模式要用的 PIN（与「进入家长模式」的 `_pin` 分开：
  /// 两个动作的失败文案不同，共用控制器会让上一次的输入串到下一次）。
  final TextEditingController _kidPin = TextEditingController();

  /// 家长选择的「给孩子用多少分钟」（1–30，默认 15）。
  int _kidMinutes = kKidModeDefaultMinutes;

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
    _kidPin.dispose();
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

    // W14：孩子模式的三态。它的优先级高于家长模式（服务端已把角色压到 child），
    // 所以界面上三块互斥：孩子模式中 / 孩子模式已到期 / 家长模式 / 孩子模式。
    final bool kidActive = store.isKidModeActiveAt(now);
    final bool kidExpired = store.isKidModeExpiredAt(now);
    final bool kidModeOn = kidActive || kidExpired;
    final int kidSeconds = store.kidModeRemainingSeconds(now);

    return SheetFrame(
      title: '家长模式',
      subtitle: kidActive
          ? '孩子模式已开启：还剩 ${kidModeMmss(kidSeconds)}（到点不会自动回家长模式，要用 PIN 收回）'
          : kidExpired
              ? '孩子模式的时间到了 —— 请输入家长 PIN 收回，手机才会回到家长权限'
              : !parentMode
                  ? '输入家长 PIN 可以在这台设备上临时获得 5 分钟家长权限'
                  : sessionBacked
                      ? '这台设备已以家长身份登录，登录期间一直是家长权限'
                      : '这台设备现在是家长权限（${_mmss(store.parentModeRemainingSeconds(now))} 后自动收回）',
      actionLabel: kidModeOn
          ? '结束孩子模式'
          : parentMode
              ? '退出家长模式'
              : locked
                  ? '已锁定，请稍后再试'
                  : '进入家长模式',
      actionIcon: kidModeOn
          ? Icons.timer_off_outlined
          : parentMode
              ? Icons.lock_open_rounded
              : Icons.lock_outline_rounded,
      onAction: _busy || (!parentMode && !kidModeOn && locked)
          ? null
          : kidModeOn
              ? _exitKidMode
              : (parentMode ? _exit : _enter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (_busy) const LinearProgressIndicator(minHeight: 2),
          ..._statusRows(now, parentMode, locked),
          const SizedBox(height: 12),
          if (kidModeOn)
            ..._kidModeRows(now, kidExpired)
          else if (parentMode) ...<Widget>[
            ..._parentModeRows(now, sessionBacked),
            ..._kidModeLauncherRows(),
          ] else
            ..._childModeRows(now, locked),
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
      // ★ 这一条以前写的是「请先用家长账号进入一次家长模式，再在下面设置」——
      //   对引导期跳过 PIN 的账号**不可执行**：5 分钟窗口一过就回落 child，
      //   而进家长模式本身就要 PIN（`43` §8 D7）。现在把唯一能走的路写出来，
      //   并在下面给一个按钮（`_childModeRows`），不做「请去别处」的空提示。
      if (known && !parentMode && !store.isParentPinConfigured)
        _hint(
          '这个账号还没有家长 PIN，而现在不是家长模式 —— 设置 PIN 需要家长权限。'
          '引导期的 5 分钟家长权限已经到期，只能这样补：退出登录 → '
          '用申请时的手机号/密码重新登录 → 再回到这里设置。',
          danger: true,
        ),
    ];
  }

  /// 不在家长模式时：PIN 输入框（＋「没有 PIN」时的唯一自助出口）。
  List<Widget> _childModeRows(DateTime now, bool locked) {
    final AppStore store = widget.store;
    // `parentMode != null` ⇒ 状态已知，才敢判断「这个账号真的没有 PIN」。
    final bool stuckWithoutPin =
        store.parentMode != null && !store.isParentPinConfigured;
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
      // 没有 PIN 且不在家长模式 ⇒ 上面那行提示说的最后一步必须真的能点。
      // 只有拿到 `signOut` 时才画（预览 / 未登录画了也没用）。
      if (stuckWithoutPin && widget.signOut != null) ...<Widget>[
        const SizedBox(height: 2),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _busy ? null : _signOutAndReLogin,
            icon: const Icon(Icons.logout_rounded, size: 18),
            label: const Text('退出登录，用手机号/密码重新登录'),
          ),
        ),
      ],
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

  /// 孩子模式进行中 / 已到期：倒计时 + 用家长 PIN 收回（W14）。
  ///
  /// ★ 到期态**不是**「自动结束」：手机停在孩子权限，等家长来收。
  ///   界面必须把这句话写出来，否则家长会以为"30 分钟一到就恢复了"，
  ///   而实际上孩子只是失去了时间、并没有失去权限 —— 那是**更糟**的错觉。
  List<Widget> _kidModeRows(DateTime now, bool expired) {
    final int seconds = widget.store.kidModeRemainingSeconds(now);
    return <Widget>[
      AppCard(
        radius: 16,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: <Widget>[
            Icon(
              expired ? Icons.timer_off_outlined : Icons.schedule_rounded,
              size: 20,
              color: expired ? AppColors.pointSpend : AppColors.primaryDeep,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                expired ? '时间到了 —— 等家长 PIN 收回' : '还能用 ${kidModeMmss(seconds)}',
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
        expired
            ? '时间到了以后手机不会自动回到家长模式 —— 这是故意的：'
                '否则孩子等一等就能自己批心愿。请输入家长 PIN 收回。'
            : '这段时间里手机是孩子权限：可以打卡、提交心愿（需要家长审批）。'
                '到点后不会自动回家长模式，需要用下面的 PIN 收回。',
        danger: expired,
      ),
      const SizedBox(height: 12),
      TextField(
        controller: _kidPin,
        enabled: !_busy,
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
          if (_busy) return;
          _exitKidMode();
        },
      ),
      const SizedBox(height: 8),
      Align(
        alignment: Alignment.centerRight,
        child: FilledButton(
          onPressed: _busy ? null : _exitKidMode,
          child: const Text('结束孩子模式'),
        ),
      ),
    ];
  }

  /// 家长模式下：把手机交给孩子用 N 分钟（W14）。
  ///
  /// ── 为什么把"写在纸上"的提示常驻在时长下面 ──────────────────────────────
  ///   这是产品的核心意图（家长原话）：先让孩子把愿望落到纸上、做好规划，
  ///   再给一段**有限**时间填。把提示藏进帮助页等于没说。
  /// ── 为什么默认 15 而不是 30 ───────────────────────────────────────────────
  ///   默认即上限会鼓励"反正也是 30 分钟"；15 让"少用一会儿"成为默认选择。
  List<Widget> _kidModeLauncherRows() {
    return <Widget>[
      const SizedBox(height: 16),
      const Divider(height: 1),
      const SizedBox(height: 12),
      const Text(
        '把手机交给孩子用',
        style: TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.w700,
          color: AppColors.textPrimary,
        ),
      ),
      const SizedBox(height: 6),
      _hint('建议先让孩子把想做的写在纸上、想清楚，再来手机上填 —— 减少盯着屏幕的时间。'),
      const SizedBox(height: 8),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: <Widget>[
          for (final int minutes in kKidModeDurationChoices)
            ChoiceChip(
              label: Text('$minutes 分钟'),
              selected: _kidMinutes == minutes,
              onSelected: _busy
                  ? null
                  : (_) => setState(() => _kidMinutes = minutes),
            ),
        ],
      ),
      const SizedBox(height: 8),
      _hint('到点后需要你输入家长 PIN 收回；不会自动回到家长模式。'),
      const SizedBox(height: 8),
      Align(
        alignment: Alignment.centerRight,
        child: FilledButton.tonalIcon(
          onPressed: _busy ? null : _enterKidMode,
          icon: const Icon(Icons.timer_outlined, size: 18),
          label: Text('给孩子用 $_kidMinutes 分钟'),
        ),
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

  /// 开孩子模式（W14）。时长由面板上的 chip 决定（默认 15 分钟）。
  Future<void> _enterKidMode() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await widget.store.enterKidMode(_kidMinutes);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
    });
    if (failure == null) {
      _toast('孩子模式已开启：$_kidMinutes 分钟后需要家长 PIN 收回');
    }
  }

  /// 用家长 PIN 结束孩子模式（W14）—— 到期后也是这一条。
  Future<void> _exitKidMode() async {
    final String pin = _kidPin.text.trim();
    final String? invalid = validateParentPin(pin);
    if (pin.isEmpty || invalid != null) {
      setState(() => _error = pin.isEmpty ? '请输入家长 PIN。' : invalid);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final String? failure = await widget.store.exitKidMode(pin);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = failure;
      if (failure == null) _kidPin.clear();
    });
    if (failure == null) _toast('孩子模式已结束，手机回到家长权限');
  }

  /// 存量账号的唯一自助出口（`43` §8 D7）：退出登录，让家长用手机号/密码重登。
  ///
  /// ── 为什么不是「就在这里设 PIN」──────────────────────────────────────────────
  ///   `POST /auth/parent-pin` 要 `manage_parent_pin`，而矩阵里孩子是 DENY。
  ///   引导期跳过 PIN 的账号在 5 分钟窗口过后就是 `child`，本机没有任何办法
  ///   提升权限 —— 只有重新登录（登录签发的是 30 天家长会话）。
  ///
  /// ── 为什么先关面板再退出 ────────────────────────────────────────────────────
  ///   退出后 `AccountGate` 会把整棵子树换成登录页，这个面板已经不在树上；
  ///   留在面板里等 `signOut()` 只会对着一个卸载后的 context 报错。
  Future<void> _signOutAndReLogin() async {
    final Future<void> Function()? signOut = widget.signOut;
    if (signOut == null || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final NavigatorState navigator = Navigator.of(context);
    if (navigator.canPop()) navigator.pop();
    await signOut();
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


