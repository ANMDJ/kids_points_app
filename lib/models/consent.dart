/// 监护人同意的**库内状态**（`GET /consent` 的 `status`，W7-B）。
///
/// 线值只有三个：`granted` / `withdrawn` / `none`。后两者在库里是不同事实
/// （「撤回」与「从没同意过」），界面文案也应当分开 —— 撤回过的家庭再点同意
/// 是**恢复**，不是首次同意。
enum GuardianConsentStatus { granted, withdrawn, none }

/// 当前孩子的监护人同意快照（`GET /consent`）。
///
/// **只有事实**：`status` / 协议版本 / 两个时间点。
/// 没有 `canGrant` / `canWithdraw` —— 谁能写由服务端矩阵判定
/// （`grant_consent` / `withdraw_consent` 仅 guardian ALLOW），客户端
/// 只负责在服务端拒绝时把 403 的 `code` 原样解释出来。
///
/// `consentVersion` 是**同意时**的协议版本，不是当前协议版本：它记录的是
/// 「家长当初同意的是哪一版」，协议升级后旧记录仍然显示旧版本号，这样
/// 「孩子的新资料按哪一版处理」才有据可查。
class GuardianConsent {
  const GuardianConsent({
    required this.childId,
    required this.status,
    required this.consentVersion,
    required this.grantedAt,
    required this.withdrawnAt,
  });

  /// 「还没有任何记录」的本地初值 —— **不是**服务端下发的事实。
  ///
  /// 界面用它画空态，但不应把它当成「服务端说没同意」：在
  /// `consentReadStatus != ready` 时显示「同意状态未知」更诚实。
  static const GuardianConsent unknown = GuardianConsent(
    childId: '',
    status: GuardianConsentStatus.none,
    consentVersion: null,
    grantedAt: null,
    withdrawnAt: null,
  );

  final String childId;
  final GuardianConsentStatus status;

  /// 同意时的协议版本（例如 `2026-10-27`）；`none` / `withdrawn` 时可能为 null。
  final String? consentVersion;

  /// 同意时间；`none` 时为 null。
  final DateTime? grantedAt;

  /// 撤回时间；仅 `withdrawn` 时有值。
  final DateTime? withdrawnAt;

  bool get isGranted => status == GuardianConsentStatus.granted;

  bool get isWithdrawn => status == GuardianConsentStatus.withdrawn;

  /// 是否从未同意过（与「撤回」分开）。
  bool get isNeverGranted => status == GuardianConsentStatus.none;

  /// 状态徽标文案。
  String get statusLabel {
    switch (status) {
      case GuardianConsentStatus.granted:
        return '已同意';
      case GuardianConsentStatus.withdrawn:
        return '已撤回';
      case GuardianConsentStatus.none:
        return '未同意';
    }
  }

  /// 协议版本展示值：没有版本号时显示「—」，不要留空（看起来像加载失败）。
  String get versionLabel {
    final String raw = (consentVersion ?? '').trim();
    return raw.isEmpty ? '—' : raw;
  }

  /// 协议文本仍是占位版（`*-draft`）—— 界面据此提醒「法务文本待替换」。
  ///
  /// 为什么由客户端判断：后端只保证 `CONSENT_VERSION` 这一常量，
  /// 「是不是草案」是**命名约定**，放在 UI 侧解释比新增一个只读字段更轻。
  bool get isDraftVersion {
    final String raw = (consentVersion ?? '').trim();
    return raw.isEmpty || raw.endsWith('-draft');
  }

  /// 「2026-10-27 09:30 同意」；没有时间时返回 null（不编一个假时间）。
  String? get grantedText {
    final DateTime? at = grantedAt;
    if (at == null) return null;
    return '${_dateTimeText(at)} 同意';
  }

  /// 「2026-10-27 10:05 撤回」；没有时间时返回 null。
  String? get withdrawnText {
    final DateTime? at = withdrawnAt;
    if (at == null) return null;
    return '${_dateTimeText(at)} 撤回';
  }
}

String _two(int value) => value.toString().padLeft(2, '0');

String _dateTimeText(DateTime value) {
  final DateTime local = value.toLocal();
  return '${local.year}-${_two(local.month)}-${_two(local.day)} '
      '${_two(local.hour)}:${_two(local.minute)}';
}
