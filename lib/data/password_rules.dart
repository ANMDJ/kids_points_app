/// 密码强度的**客户端镜像**（2026-11-03）。
///
/// ── 为什么现在要有这一份（原先的纪律是「客户端不抄」）────────────────────────
///   2026-11-03 用户拿网站邀请码注册，App 直接把请求发出去、再显示服务端的
///   `400 WEAK_PASSWORD`：他知道「密码有问题」却不知道**要求是什么**，
///   改一次再试一次。规则只有一句话（8–64 位、非纯数字…），在提交前
///   本地说清楚，比让用户撞一次接口便宜得多。
///
/// ── 与服务端的关系（**仍然只有服务端说了算**）────────────────────────────────
///   真相之源是 `backend/src/identity/account-identifier.ts#validatePasswordStrength`。
///   本文件是它的逐条镜像；`test/password_rules_test.dart` 会读那个 TS 文件，
///   把「六句文案 + 8/64 两个边界」逐字钉住 —— 改一边忘了另一边会红。
///   两边万一仍不一致，**以服务端回的 `message` 为准**（`write_api_errors.dart`
///   已经负责把原文透传到界面），本地这层只是「少一次必然失败的往返」。
///
/// ── 为什么文案与阈值都放在这里，而不是散在界面里 ────────────────────────────
///   注册页（`register_screen.dart`）与数据层（`auth_api.dart`）都要用同一句
///   提示：界面负责即时反馈，数据层负责「任何调用方都绕不过去」。
///   两处各写一句文案，第二天就会出现「界面说 8 位、接口说 10 位」。
///
/// ★ 文案里**不带**用户输入的原文（提示可能被截图 / 进日志），
///   这与服务端 `passwordMessage()` 的纪律一致。
library;

/// 与服务端 `PASSWORD_MIN` / `PASSWORD_MAX` 逐字一致。
const int kPasswordMin = 8;
const int kPasswordMax = 64;

/// 注册页常驻的密码要求（**必须**与服务端的六条拒绝口径对得上）。
///
/// 放在这里而不是写在 widget 里：`register_screen.dart` 只负责把它显示出来，
/// 将来「登录账号」面板要复用时不需要再抄一遍。
const String kPasswordRequirementHint =
    '密码 $kPasswordMin–$kPasswordMax 位，至少含一个字母；不能是纯数字、'
    '同一字符重复、常见弱密码，也不能和手机号/邮箱相同。';

/// 密码不合格的原因（与服务端 `PasswordFailure` 同名同序）。
enum PasswordFailure {
  tooShort,
  tooLong,
  allSame,
  allDigits,
  common,
  sameAsIdentifier,
}

/// 判定结果。`failure == null` ⇒ 通过。
class PasswordCheck {
  const PasswordCheck._(this.failure);

  /// 通过。
  const PasswordCheck.ok() : failure = null;

  final PasswordFailure? failure;

  bool get ok => failure == null;

  /// 给用户看的那句话（`null` ⇒ 通过）。与服务端 `passwordMessage()` 同文。
  String? get message => failure == null ? null : passwordFailureMessage(failure!);
}

/// 常见弱口令（**小写比较**）。与服务端 `COMMON_PASSWORDS` 同一张表。
///
/// 刻意只有十几条：这是一张「明显不该过」的清单，不是 rockyou。
/// 真正的防线是限流 + 慢哈希。
///
/// ★ 公开常量而不是私有：`test/password_rules_test.dart` 要逐条比对服务端那张表，
///   看得见的表才钉得住（私有表只能靠「某个密码是否被拒」间接猜）。
const Set<String> kCommonPasswords = <String>{
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password1',
  'passw0rd',
  'qwertyui',
  'qwerty123',
  'abc12345',
  'iloveyou',
  'admin123',
  '1qaz2wsx',
  'zxcvbnm1',
  'woaini1314',
};

/// 密码强度判定（客户端镜像）。
///
/// [identifier] 是用户填的手机号或邮箱原文（不必先规范化，本函数会做
/// 与服务端同样的「去分隔符 / 去 +86 / 邮箱小写」）。传 `null` ⇒ 跳过
/// `SAME_AS_IDENTIFIER` 这一条（例如改密时界面拿不到账号标识）。
///
/// 判定顺序与服务端**逐条相同**（顺序会影响用户看到哪句话）：
///   长度 → 与标识相同 → 单一字符 → 纯数字 → 常见弱口令。
/// `SAME_AS_IDENTIFIER` 排在 `ALL_DIGITS` 之前，是为了把「不能用自己的手机号」
/// 说得比「不能纯数字」更具体。
PasswordCheck checkPasswordStrength(String password, {String? identifier}) {
  final int length = password.runes.length;
  if (length < kPasswordMin) {
    return const PasswordCheck._(PasswordFailure.tooShort);
  }
  if (length > kPasswordMax) {
    return const PasswordCheck._(PasswordFailure.tooLong);
  }

  final String lower = password.toLowerCase();
  final String? target = _identifierForComparison(identifier);
  if (target != null && target.isNotEmpty) {
    if (lower == target) {
      return const PasswordCheck._(PasswordFailure.sameAsIdentifier);
    }
    final int at = target.indexOf('@');
    if (at > 0 && lower == target.substring(0, at)) {
      return const PasswordCheck._(PasswordFailure.sameAsIdentifier);
    }
  }

  // `\1+` 是反向引用：`aaaaaaaa` 命中，`aabbbbbb` 不命中（与服务端同一写法）。
  if (RegExp(r'^(.)\1+$', dotAll: true).hasMatch(password)) {
    return const PasswordCheck._(PasswordFailure.allSame);
  }
  if (RegExp(r'^\d+$').hasMatch(password)) {
    return const PasswordCheck._(PasswordFailure.allDigits);
  }
  if (kCommonPasswords.contains(lower)) {
    return const PasswordCheck._(PasswordFailure.common);
  }

  return const PasswordCheck.ok();
}

/// 与服务端 `passwordMessage()` **逐字一致**的文案。
///
/// 每一句都要能告诉用户「下一步怎么改」——否则他只会反复提交同一个密码。
String passwordFailureMessage(PasswordFailure reason) {
  switch (reason) {
    case PasswordFailure.tooShort:
      return '密码至少 $kPasswordMin 位。';
    case PasswordFailure.tooLong:
      return '密码最多 $kPasswordMax 位（太长的密码只是给自己添麻烦）。';
    case PasswordFailure.allSame:
      return '密码不能是同一个字符重复。';
    case PasswordFailure.allDigits:
      return '密码不能全是数字，请至少带一个字母。';
    case PasswordFailure.common:
      return '这个密码太常见了，很容易被猜到，请换一个。';
    case PasswordFailure.sameAsIdentifier:
      return '密码不能和你的手机号或邮箱一样。';
  }
}

/// 把用户的输入整理成「库里会存的那个值」，只用于密码比较。
///
/// 与服务端 `normalizePhone()` / `normalizeEmail()` 的关键步骤一致：
/// 手机号去空格 / 连字符 / 括号、剥 `+86` 或 13 位的 `86` 前缀；
/// 邮箱统一小写。**不做**格式校验 —— 形状错由服务端回答，
/// 这里只需要「比较时两边是同一个字符串」。
String? _identifierForComparison(String? raw) {
  final String trimmed = raw?.trim() ?? '';
  if (trimmed.isEmpty) return null;
  if (trimmed.contains('@')) return trimmed.toLowerCase();

  String compact = trimmed.replaceAll(RegExp(r'[\s\-()]'), '');
  if (compact.startsWith('+86')) {
    compact = compact.substring(3);
  } else if (compact.length == 13 && compact.startsWith('86')) {
    compact = compact.substring(2);
  }
  return compact.toLowerCase();
}
