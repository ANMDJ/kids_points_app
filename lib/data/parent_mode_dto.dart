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
