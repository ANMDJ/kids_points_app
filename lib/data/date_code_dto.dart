import 'read_api_errors.dart';
import 'read_dto.dart';

/// `POST /auth/date-code` 的回包形状（W9-C，2026-10-29）。
///
/// ── 与其它 DTO 同一口径 ───────────────────────────────────────────────────
///   缺字段 / 类型不对 / 形状自相矛盾一律 [ReadApiException.malformed]，
///   绝不 `as int? ?? 0` 猜一个默认值 —— 猜错的后果是界面显示「今天是 0 号」。
///
/// ── 这里判的三类「自相矛盾」───────────────────────────────────────────────
///   ① `weekDay` 必须是 1–7（ISO 星期），`serverDate` 必须是 `YYYY-MM-DD`；
///   ② `valid == true` ⇒ `dayOffset` 只能是 **-1 / 0 / 1**、`acceptedUntil` 必须有值
///      （否则界面算不出「这个码还能用多久」）；
///   ③ `valid == false` ⇒ 这两个字段必须都是 null。
///      若服务端留着半个结果（比如 valid:false 却给了 dayOffset:0），界面会同时
///      显示「验证码错误」和「今天是今天的码」，家长无从判断该信哪一句。
///
/// ★ 它**不是**凭据：响应里没有 token，将来也不该有 —— 见后端
///   `date-verification-code.ts` 文件头的诚实标注。
class DateCodeVerdictDto {
  DateCodeVerdictDto({
    required this.valid,
    required this.serverDate,
    required this.weekDay,
    required this.dayOffset,
    required this.acceptedUntil,
  });

  factory DateCodeVerdictDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final DateCodeVerdictDto dto = DateCodeVerdictDto(
      valid: readBool(json, 'valid', '$path.valid'),
      serverDate: readString(json, 'serverDate', '$path.serverDate'),
      weekDay: readInt(json, 'weekDay', '$path.weekDay'),
      dayOffset: readOptionalInt(json, 'dayOffset', '$path.dayOffset'),
      acceptedUntil: readOptionalDate(json, 'acceptedUntil', '$path.acceptedUntil'),
    );
    dto._validateShape(path);
    return dto;
  }

  /// 输入是否命中**服务器今天 ± 1 天**内的某一天。
  final bool valid;

  /// 服务器当天（Asia/Shanghai）的日历日，`YYYY-MM-DD`。
  final String serverDate;

  /// 服务器当天的 ISO 星期（1 = 周一 … 7 = 周日）。
  final int weekDay;

  /// 命中哪一天：-1 昨天 / 0 今天 / 1 明天；未命中为 null。
  final int? dayOffset;

  /// 该输入彻底失效的时刻；未命中为 null。
  final DateTime? acceptedUntil;

  /// 服务端允许的三个偏移。
  static const Set<int> allowedDayOffsets = <int>{-1, 0, 1};

  static final RegExp _serverDatePattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

  void _validateShape(String path) {
    if (!_serverDatePattern.hasMatch(serverDate)) {
      throw ReadApiException.malformed(
        '$path.serverDate',
        detail: '不是 YYYY-MM-DD：$serverDate',
      );
    }
    if (weekDay < DateTime.monday || weekDay > DateTime.sunday) {
      throw ReadApiException.malformed(
        '$path.weekDay',
        detail: 'ISO 星期必须是 1–7，收到 $weekDay',
      );
    }

    if (valid) {
      final int? offset = dayOffset;
      if (offset == null || !allowedDayOffsets.contains(offset)) {
        throw ReadApiException.malformed(
          '$path.dayOffset',
          detail: 'valid=true 时 dayOffset 只能是 -1 / 0 / 1，收到 $offset',
        );
      }
      if (acceptedUntil == null) {
        throw ReadApiException.malformed(
          '$path.acceptedUntil',
          detail: 'valid=true 却没有失效时刻 —— 界面无法显示「还能用多久」',
        );
      }
      return;
    }

    if (dayOffset != null || acceptedUntil != null) {
      throw ReadApiException.malformed(
        path,
        detail: 'valid=false 却带了命中信息（dayOffset=$dayOffset）',
      );
    }
  }
}
