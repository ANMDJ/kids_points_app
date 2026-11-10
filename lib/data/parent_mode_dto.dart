import 'read_api_errors.dart';
import 'read_dto.dart';

/// 家长模式 / 家长 PIN 两个端点的**线格式**（W8-C，2026-10-27 / `02` §7）。
///
/// 与其它 DTO 同一口径：缺字段 / 类型不对 / 形状自相矛盾一律
/// [ReadApiException.malformed]，绝不 `as int? ?? 0` 猜一个默认值。
///
/// ── 这里判的五类「自相矛盾」─────────────────────────────────────────────────
///   ① `parentMode` 必须等于 `activeRole == 'guardian'` —— 服务端就是按它派生的；
///      两者不一致说明版本漂移，界面会同时显示"家长模式"和"孩子角标"。
///   ② `parentModeExpiresAt` 与 `parentMode` 必须同真同假：在家长模式却没有
///      到期时刻 = 倒计时无从算起；不在家长模式却有到期时刻 = 迟早被误用。
///   ③ `modeSource` 与 `parentMode` 同真同假，且只允许 `pin` / `session`。
///   ④ `remainingSeconds` 必须与**来源**对得上：
///        · 不在家长模式 ⇒ 0；
///        · `pin` ⇒ 1..300（TTL 是常量）；
///        · `session` ⇒ 301..一年。
///      ★ 这里**不能**统一按"≤300"卡：用邀请码加入的家长设备，会话一上来就是
///        `guardian`、TTL 是 30 天（见 `invites/invite-code.ts`），`remainingSeconds`
///        会是 2 592 000。按 5 分钟硬卡的话，家长本机的第一屏就是"数据格式不符合
///        预期" —— 这正是 W8-C 验收时抓到的缺陷（`modeSource` 就是它的修复）。
///        上界给一年是为了抓单位错误（把毫秒当秒会得到 2.6e9）。
///   ⑤ 锁定态：`lockedUntil != null` ⇒ `remainingAttempts == 0`；
///      未锁定时 `remainingAttempts` 必须在 1..5 之间（5 = 一次都没错）。
class ParentModeDto {
  ParentModeDto({
    required this.activeRole,
    required this.parentMode,
    required this.modeSource,
    required this.parentModeExpiresAt,
    required this.remainingSeconds,
    required this.pinConfigured,
    required this.remainingAttempts,
    required this.lockedUntil,
    required this.kidMode,
    required this.kidModeExpired,
    required this.kidModeUntil,
    required this.kidModeRemainingSeconds,
  });

  factory ParentModeDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final ParentModeDto dto = ParentModeDto(
      activeRole: readString(json, 'activeRole', '$path.activeRole'),
      parentMode: readBool(json, 'parentMode', '$path.parentMode'),
      modeSource: readOptionalString(json, 'modeSource', '$path.modeSource'),
      parentModeExpiresAt:
          readOptionalDate(json, 'parentModeExpiresAt', '$path.parentModeExpiresAt'),
      remainingSeconds: readInt(json, 'remainingSeconds', '$path.remainingSeconds'),
      pinConfigured: readBool(json, 'pinConfigured', '$path.pinConfigured'),
      remainingAttempts:
          readInt(json, 'remainingAttempts', '$path.remainingAttempts'),
      lockedUntil: readOptionalDate(json, 'lockedUntil', '$path.lockedUntil'),
      kidMode: readBool(json, 'kidMode', '$path.kidMode'),
      kidModeExpired: readBool(json, 'kidModeExpired', '$path.kidModeExpired'),
      kidModeUntil: readOptionalDate(json, 'kidModeUntil', '$path.kidModeUntil'),
      kidModeRemainingSeconds:
          readInt(json, 'kidModeRemainingSeconds', '$path.kidModeRemainingSeconds'),
    );
    dto._validateShape(path);
    return dto;
  }

  /// `guardian` / `child` / `viewer`。
  final String activeRole;
  final bool parentMode;

  /// guardian 权限的**来源**：`pin`（PIN 换的 5 分钟）/ `session`（登录会话自带）；
  /// 不在家长模式时为 null。界面据此决定是"倒计时"还是"已以家长身份登录"。
  final String? modeSource;
  final DateTime? parentModeExpiresAt;
  final int remainingSeconds;
  final bool pinConfigured;
  final int remainingAttempts;
  final DateTime? lockedUntil;

  /// 孩子模式正在窗口内（W14）。
  final bool kidMode;

  /// 孩子模式已到点、等家长 PIN 收回（W14；A 方案，到期**不**回家长模式）。
  final bool kidModeExpired;

  /// 孩子模式的到期绝对时刻。
  final DateTime? kidModeUntil;

  /// 孩子模式剩余秒数（快照）。
  final int kidModeRemainingSeconds;

  /// 孩子模式最长 30 分钟 `= 1800` 秒（与 `kid-mode.policy.ts` 同源）。
  static const int maxKidModeSeconds = 1800;

  /// 家长模式最长 5 分钟（`02` §7）—— 超过它说明**不是** PIN 换来的。
  static const int maxTtlSeconds = 300;

  /// 登录会话的剩余时间上界：一年。只用来抓"毫秒当秒"这类单位错误。
  static const int maxSessionTtlSeconds = 366 * 24 * 60 * 60;

  void _validateShape(String path) {
    if (activeRole != 'guardian' && activeRole != 'child' && activeRole != 'viewer') {
      throw ReadApiException.malformed(
        '$path.activeRole',
        detail: '未知角色：$activeRole',
      );
    }
    if (parentMode != (activeRole == 'guardian')) {
      throw ReadApiException.malformed(
        '$path.parentMode',
        detail: 'parentMode=$parentMode 与 activeRole=$activeRole 自相矛盾',
      );
    }
    if (parentMode && parentModeExpiresAt == null) {
      throw ReadApiException.malformed(
        '$path.parentModeExpiresAt',
        detail: '处于家长模式但没有到期时刻 —— 倒计时无从算起',
      );
    }
    if (!parentMode && parentModeExpiresAt != null) {
      throw ReadApiException.malformed(
        '$path.parentModeExpiresAt',
        detail: '不在家长模式却给了到期时刻',
      );
    }
    if (!parentMode) {
      if (modeSource != null) {
        throw ReadApiException.malformed(
          '$path.modeSource',
          detail: '不在家长模式却给了来源：$modeSource',
        );
      }
      if (remainingSeconds != 0) {
        throw ReadApiException.malformed(
          '$path.remainingSeconds',
          detail: '不在家长模式时剩余秒数必须为 0：$remainingSeconds',
        );
      }
    } else if (modeSource == 'pin') {
      if (remainingSeconds < 1 || remainingSeconds > maxTtlSeconds) {
        throw ReadApiException.malformed(
          '$path.remainingSeconds',
          detail: 'PIN 换来的家长模式剩余秒数越界（1–$maxTtlSeconds）：$remainingSeconds',
        );
      }
    } else if (modeSource == 'session') {
      if (remainingSeconds <= maxTtlSeconds ||
          remainingSeconds > maxSessionTtlSeconds) {
        throw ReadApiException.malformed(
          '$path.remainingSeconds',
          detail: '登录会话的剩余秒数越界（$maxTtlSeconds–$maxSessionTtlSeconds）：'
              '$remainingSeconds',
        );
      }
    } else {
      throw ReadApiException.malformed(
        '$path.modeSource',
        detail: '处于家长模式但来源缺失/未知：$modeSource',
      );
    }
    if (lockedUntil != null) {
      if (remainingAttempts != 0) {
        throw ReadApiException.malformed(
          '$path.remainingAttempts',
          detail: '已锁定但剩余次数不是 0：$remainingAttempts',
        );
      }
    } else if (remainingAttempts < 1 || remainingAttempts > 5) {
      throw ReadApiException.malformed(
        '$path.remainingAttempts',
        detail: '未锁定时剩余次数必须在 1–5 之间：$remainingAttempts',
      );
    }

    // ── W14：孩子模式的四类自相矛盾 ─────────────────────────────────────────
    // ① 不可能同时"进行中"和"已到期"：它们是同一个时间戳的两种状态；
    // ② 孩子模式与家长模式互斥 —— 服务端就是按儿童优先级降级的，
    //    两者同时为真说明服务端没把 kidModeUntil 算进 effectiveRole；
    // ③ 有状态就必须有绝对时刻（否则本地倒计时无从算起）；
    // ④ 剩余秒数必须与状态对得上：进行中 ⇒ 1..1800；已到期 / 未开 ⇒ 0。
    if (kidMode && kidModeExpired) {
      throw ReadApiException.malformed(
        '$path.kidModeExpired',
        detail: 'kidMode 与 kidModeExpired 同时为 true',
      );
    }
    if ((kidMode || kidModeExpired) && parentMode) {
      throw ReadApiException.malformed(
        '$path.parentMode',
        detail: '孩子模式与家长模式同时为 true（服务端未把 kidModeUntil 计入 effectiveRole）',
      );
    }
    if (kidMode || kidModeExpired) {
      if (kidModeUntil == null) {
        throw ReadApiException.malformed(
          '$path.kidModeUntil',
          detail: '孩子模式有状态却没有到期时刻',
        );
      }
      if (kidMode && (kidModeRemainingSeconds < 1 || kidModeRemainingSeconds > maxKidModeSeconds)) {
        throw ReadApiException.malformed(
          '$path.kidModeRemainingSeconds',
          detail: '孩子模式剩余秒数越界（1–$maxKidModeSeconds）：$kidModeRemainingSeconds',
        );
      }
      if (kidModeExpired && kidModeRemainingSeconds != 0) {
        throw ReadApiException.malformed(
          '$path.kidModeRemainingSeconds',
          detail: '已到期的孩子模式剩余秒数必须为 0：$kidModeRemainingSeconds',
        );
      }
    } else {
      if (kidModeUntil != null) {
        throw ReadApiException.malformed(
          '$path.kidModeUntil',
          detail: '没有孩子模式却给了到期时刻',
        );
      }
      if (kidModeRemainingSeconds != 0) {
        throw ReadApiException.malformed(
          '$path.kidModeRemainingSeconds',
          detail: '没有孩子模式时剩余秒数必须为 0：$kidModeRemainingSeconds',
        );
      }
    }
  }
}

/// `POST /auth/parent-pin` 的回包。
///
/// `changed` 与 `pinConfigured` 是**两个**布尔：前者说"这次是改还是设"，
/// 后者说"现在有没有 PIN"。合并成一个会让"修改成功"看起来像"首次设置成功"
/// （家长会以为别的设备上的旧 PIN 还能用）。
class ParentPinDto {
  ParentPinDto({
    required this.pinConfigured,
    required this.changed,
    required this.pinSetAt,
    required this.remainingAttempts,
  });

  factory ParentPinDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final ParentPinDto dto = ParentPinDto(
      pinConfigured: readBool(json, 'pinConfigured', '$path.pinConfigured'),
      changed: readBool(json, 'changed', '$path.changed'),
      pinSetAt: readOptionalDate(json, 'pinSetAt', '$path.pinSetAt'),
      remainingAttempts:
          readInt(json, 'remainingAttempts', '$path.remainingAttempts'),
    );
    dto._validateShape(path);
    return dto;
  }

  final bool pinConfigured;
  final bool changed;
  final DateTime? pinSetAt;
  final int remainingAttempts;

  void _validateShape(String path) {
    // 这个端点的成功语义就是"PIN 现在存在"：`false` 只可能是服务端写丢了。
    if (!pinConfigured) {
      throw ReadApiException.malformed(
        '$path.pinConfigured',
        detail: '设置 PIN 成功后 pinConfigured 必须为 true',
      );
    }
    if (remainingAttempts < 0 || remainingAttempts > 5) {
      throw ReadApiException.malformed(
        '$path.remainingAttempts',
        detail: '剩余次数越界（0–5）：$remainingAttempts',
      );
    }
  }
}

/// `POST /auth/parent-pin/reset` 的回包（P1-7，2026-11-04；App 接入 2026-11-10）。
///
/// 重置只换一把钥匙：**没有** `activeRole` / `parentModeExpiresAt` ——
/// 界面不能在「重置成功」之后顺手显示「已进入家长模式」（那是另一件事，
/// 由 `POST /auth/parent-mode` 回答）。
class ParentPinResetDto {
  ParentPinResetDto({
    required this.pinConfigured,
    required this.pinSetAt,
    required this.remainingAttempts,
    required this.clearedFailures,
    required this.wasLocked,
  });

  factory ParentPinResetDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final ParentPinResetDto dto = ParentPinResetDto(
      pinConfigured: readBool(json, 'pinConfigured', '$path.pinConfigured'),
      pinSetAt: readOptionalDate(json, 'pinSetAt', '$path.pinSetAt'),
      remainingAttempts:
          readInt(json, 'remainingAttempts', '$path.remainingAttempts'),
      clearedFailures: readInt(json, 'clearedFailures', '$path.clearedFailures'),
      wasLocked: readBool(json, 'wasLocked', '$path.wasLocked'),
    );
    dto._validateShape(path);
    return dto;
  }

  final bool pinConfigured;
  final DateTime? pinSetAt;
  final int remainingAttempts;

  /// 重置前被清掉的错误次数（给界面说「之前的 N 次错误作废」）。
  final int clearedFailures;

  /// 重置前是否处于锁定（true ⇒ 现在已解锁）。
  final bool wasLocked;

  void _validateShape(String path) {
    if (!pinConfigured) {
      throw ReadApiException.malformed(
        '$path.pinConfigured',
        detail: '重置 PIN 成功后 pinConfigured 必须为 true',
      );
    }
    if (remainingAttempts < 0 || remainingAttempts > 5) {
      throw ReadApiException.malformed(
        '$path.remainingAttempts',
        detail: '剩余次数越界（0–5）：$remainingAttempts',
      );
    }
    if (clearedFailures < 0) {
      throw ReadApiException.malformed(
        '$path.clearedFailures',
        detail: '清掉的错误次数不能是负数：$clearedFailures',
      );
    }
  }
}

/// `POST /auth/parent-pin/verify` 的回包（2026-11-04，本机 PIN 锁）。
///
/// ── 为什么 `valid` 必须是 `true` ────────────────────────────────────────────
///   服务端把「不对」表达成 403 / 429，而不是 `200 {valid:false}` —— 与
///   `POST /auth/parent-mode` 同一口径。收到 `valid:false` 只可能是版本漂移，
///   按 malformed 处理，界面会显示「结果不符合约定」，而不是含糊地停在锁屏
///   让人一直重试。
class ParentPinVerifyDto {
  ParentPinVerifyDto({required this.valid, required this.remainingAttempts});

  factory ParentPinVerifyDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final ParentPinVerifyDto dto = ParentPinVerifyDto(
      valid: readBool(json, 'valid', '$path.valid'),
      remainingAttempts:
          readInt(json, 'remainingAttempts', '$path.remainingAttempts'),
    );
    dto._validateShape(path);
    return dto;
  }

  /// 校验通过（这个端点只会回 true）。
  final bool valid;

  /// 还能错几次（成功不清零）。
  final int remainingAttempts;

  void _validateShape(String path) {
    if (!valid) {
      throw ReadApiException.malformed(
        '$path.valid',
        detail: '校验失败必须用 403 / 429 表达，不能回 200 + valid:false',
      );
    }
    if (remainingAttempts < 0 || remainingAttempts > 5) {
      throw ReadApiException.malformed(
        '$path.remainingAttempts',
        detail: '剩余次数越界（0–5）：$remainingAttempts',
      );
    }
  }
}

