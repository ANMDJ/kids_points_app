/// 家长模式（guardian）**权限的来源**（W8-C）。
///
/// 服务端只有一行 `DeviceSession.activeRole`，但"为什么是 guardian"有两种，界面对
/// 它们的说法完全不同：
///   * [pin] —— 刚才输了家长 PIN，换来 5 分钟（`02` §7 的 TTL）；
///   * [session] —— 这台设备本来就是用邀请码加入的家长设备，登录会话（30 天）自带
///     guardian 权限。它不是"5 分钟后自动收回"，而是"下次登录前一直有效"。
///
/// 服务端按「到期时刻离现在有多远」派生后下发（≤5 分钟 ⇒ [pin]，否则 ⇒
/// [session]），客户端**不许**自己再猜。
enum ParentModeSource {
  pin,

  /// 登录会话自带（邀请码加入的家长设备）。
  session,
}

/// 家长模式的**服务端事实**（W8-C，2026-10-27 / `02` §7、§9.18）。
///
/// ── 为什么这里只有一个"剩余秒数"的**函数**，没有本地倒计时状态 ──────────────
///   家长模式的 TTL 由服务端持有（`DeviceSession.expiresAt`）。客户端若从
///   "5:00" 自己往下数，三件事会让它说谎：手机时间不准、App 被切到后台
///   （Dart 定时器暂停）、家长手动改了系统时间。
///   所以模型里存的是**绝对时刻** [expiresAt]，界面每帧用 [remainingSecondsAt]
///   现算 —— 服务端下发的 [remainingSeconds] 只是**快照**，只用于「还没有本地
///   时钟校准的第一步」。
class ParentMode {
  const ParentMode({
    required this.activeRole,
    required this.parentMode,
    required this.modeSource,
    required this.expiresAt,
    required this.remainingSeconds,
    required this.pinConfigured,
    required this.remainingAttempts,
    required this.lockedUntil,
    required this.kidMode,
    required this.kidModeExpired,
    required this.kidModeUntil,
    required this.kidModeRemainingSeconds,
  });

  /// 预览模式 / 还没拉到过任何服务端状态时的占位值。
  ///
  /// `pinConfigured: false` + `parentMode: false` 表示"还不知道"，
  /// 界面据此**不显示**"先设置 PIN"这类会误导的引导（store 用 `parentMode == null`
  /// 表达"还没拉到"，这个常量只是给非空字段做兜底）。
  static const ParentMode unknown = ParentMode(
    activeRole: 'child',
    parentMode: false,
    modeSource: null,
    expiresAt: null,
    remainingSeconds: 0,
    pinConfigured: false,
    remainingAttempts: 5,
    lockedUntil: null,
    kidMode: false,
    kidModeExpired: false,
    kidModeUntil: null,
    kidModeRemainingSeconds: 0,
  );

  /// `guardian` / `child` / `viewer` —— 服务端按会话行 + TTL 现算。
  final String activeRole;

  /// 这台设备**当前**是否处于家长模式（服务端判定，不是 UI 开关）。
  final bool parentMode;

  /// guardian 的来源（[ParentModeSource.pin] / [ParentModeSource.session]）；
  /// 不在家长模式时为 null。
  final ParentModeSource? modeSource;

  /// 家长模式到期的**绝对时刻**；不在家长模式时为 null。
  final DateTime? expiresAt;

  /// 拉取那一刻服务端算出的剩余秒数（快照，已知偏大）。
  final int remainingSeconds;

  /// 当前账号是否已经设过家长 PIN（决定按钮写"输入 PIN"还是"先设置 PIN"）。
  final bool pinConfigured;

  /// 还允许输错几次（0 = 已锁定）。
  final int remainingAttempts;

  /// 锁定到什么时候；未锁定为 null。
  final DateTime? lockedUntil;

  /// 孩子模式**正在窗口内**（W14；服务端判定，`kidModeUntil > now`）。
  ///
  /// ★ 为 true 时 [activeRole] 必然是 `child`、[parentMode] 必然是 false。
  final bool kidMode;

  /// 孩子模式**已到点、但还没有被家长 PIN 收回**（W14）。
  ///
  /// ★ 这是 A 方案的核心状态：到期**不**自动回家长模式，设备停在 child，
  ///   直到家长输入 PIN。界面据此显示「时间到了，请输入家长 PIN」。
  final bool kidModeExpired;

  /// 孩子模式的到期**绝对时刻**（与 [expiresAt] 同一套纪律：不存本地倒计时）。
  final DateTime? kidModeUntil;

  /// 拉取那一刻服务端算出的孩子模式剩余秒数（快照，只用于首帧）。
  final int kidModeRemainingSeconds;

  /// 是"登录会话自带"的家长身份吗（决定文案：不显示 5 分钟倒计时）。
  bool get isSessionBacked => modeSource == ParentModeSource.session;

  /// 是"PIN 换来的 5 分钟"吗（只有这种才该显示倒计时）。
  bool get isPinBacked => modeSource == ParentModeSource.pin;

  /// 孩子模式**此刻**是否还在窗口内（`kidModeUntil > now`）。
  ///
  /// ★ 用**绝对时刻**现算，而不是相信 `kidMode` 快照：面板可能开了几分钟，
  ///   快照里的 `kidMode: true` 早就过期了。本地时钟不准时最坏结果是多显示
  ///   一会儿倒计时；下一次 `refreshParentMode()` 会以服务端为准。
  bool kidModeActiveAt(DateTime now) {
    final DateTime? until = kidModeUntil;
    if (!kidMode || until == null) return false;
    return until.isAfter(now);
  }

  /// 孩子模式是否处于「时间到了、等家长输 PIN」的状态。
  ///
  /// ★ 两个来源取**或**：服务端已明确 `kidModeExpired`，或本地时钟已越过
  ///   `kidModeUntil`（界面不能停在一个已经过期的倒计时上）。
  bool kidModeExpiredAt(DateTime now) {
    if (kidModeExpired) return true;
    return kidMode && kidModeUntil != null && !kidModeActiveAt(now);
  }

  /// 孩子模式还剩几秒（向上取整；未开 / 已到期都 0）。
  int kidModeSecondsAt(DateTime now) {
    final DateTime? until = kidModeUntil;
    if (until == null) return 0;
    final int ms = until.difference(now).inMilliseconds;
    return ms <= 0 ? 0 : (ms / 1000).ceil();
  }

  /// 是否处于锁定中（锁定期间后端连 scrypt 都不跑，客户端不该再发请求）。
  bool isLockedAt(DateTime now) {
    final DateTime? until = lockedUntil;
    return until != null && until.isAfter(now);
  }

  /// 距离家长模式结束还有几秒（**向上取整**，与后端 `remainingSeconds()` 同口径）。
  ///
  /// `expiresAt === now` 视为已过期 —— 与后端 `isSessionActive()` 的边界一致，
  /// 否则会出现"设备会话刚过期、倒计时却还显示 1 秒"。
  int remainingSecondsAt(DateTime now) {
    final DateTime? until = expiresAt;
    if (!parentMode || until == null) return 0;
    final int ms = until.difference(now).inMilliseconds;
    return ms <= 0 ? 0 : (ms / 1000).ceil();
  }

  /// 锁定还剩几秒（用于"请 14:59 后再试"）。
  int lockSecondsAt(DateTime now) {
    final DateTime? until = lockedUntil;
    if (until == null) return 0;
    final int ms = until.difference(now).inMilliseconds;
    return ms <= 0 ? 0 : (ms / 1000).ceil();
  }

  ParentMode copyWith({
    String? activeRole,
    bool? parentMode,
    ParentModeSource? modeSource,
    bool clearModeSource = false,
    DateTime? expiresAt,
    bool clearExpiresAt = false,
    int? remainingSeconds,
    bool? pinConfigured,
    int? remainingAttempts,
    DateTime? lockedUntil,
    bool clearLockedUntil = false,
    bool? kidMode,
    bool? kidModeExpired,
    DateTime? kidModeUntil,
    bool clearKidModeUntil = false,
    int? kidModeRemainingSeconds,
  }) {
    return ParentMode(
      activeRole: activeRole ?? this.activeRole,
      parentMode: parentMode ?? this.parentMode,
      modeSource: clearModeSource ? null : (modeSource ?? this.modeSource),
      expiresAt: clearExpiresAt ? null : (expiresAt ?? this.expiresAt),
      remainingSeconds: remainingSeconds ?? this.remainingSeconds,
      pinConfigured: pinConfigured ?? this.pinConfigured,
      remainingAttempts: remainingAttempts ?? this.remainingAttempts,
      lockedUntil: clearLockedUntil ? null : (lockedUntil ?? this.lockedUntil),
      kidMode: kidMode ?? this.kidMode,
      kidModeExpired: kidModeExpired ?? this.kidModeExpired,
      kidModeUntil:
          clearKidModeUntil ? null : (kidModeUntil ?? this.kidModeUntil),
      kidModeRemainingSeconds:
          kidModeRemainingSeconds ?? this.kidModeRemainingSeconds,
    );
  }
}

/// `POST /auth/parent-pin` 的结果（设 / 改家长 PIN）。
class ParentPinResult {
  const ParentPinResult({
    required this.pinConfigured,
    required this.changed,
    required this.pinSetAt,
    required this.remainingAttempts,
  });

  /// 是否已配置（这个端点成功后恒为 true）。
  final bool pinConfigured;

  /// true = **修改**了已有 PIN；false = 首次设置。
  ///
  /// 界面用它决定提示语："已修改" vs "已设置" —— 两者对家长的含义不同
  /// （前者意味着别的设备上的旧 PIN 立刻失效）。
  final bool changed;

  /// PIN 落库时刻（服务端事实）。
  final DateTime? pinSetAt;

  /// 成功后清零的失败次数（后端返回 5）。
  final int remainingAttempts;
}
