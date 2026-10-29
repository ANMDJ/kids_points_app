import '../models/parent_mode.dart';
import 'parent_mode_dto.dart';

/// DTO → 模型（W8-C）。
///
/// 一对一搬运，不做任何"修正"：DTO 已经把坏形状挡在数据层外（见
/// `parent_mode_dto.dart` 的五类自相矛盾），这里再"兜一下"只会掩盖服务端 bug。
///
/// `modeSource` 是唯一的"翻译"：线格式是字符串（`'pin'` / `'session'` / null），
/// 模型里换成 [ParentModeSource]，让界面用 `==` 判断而不是比字符串 —— 打错一个
/// 字母在 Dart 里是编译错，在字符串里是"永远不成立的分支"。
ParentMode mapParentMode(ParentModeDto dto) {
  return ParentMode(
    activeRole: dto.activeRole,
    parentMode: dto.parentMode,
    // DTO 已保证：`parentMode == false` ⇒ 一定是 null；`true` ⇒ 一定是两者之一。
    modeSource: dto.modeSource == 'session'
        ? ParentModeSource.session
        : (dto.modeSource == 'pin' ? ParentModeSource.pin : null),
    expiresAt: dto.parentModeExpiresAt,
    remainingSeconds: dto.remainingSeconds,
    pinConfigured: dto.pinConfigured,
    remainingAttempts: dto.remainingAttempts,
    lockedUntil: dto.lockedUntil,
  );
}

ParentPinResult mapParentPinResult(ParentPinDto dto) {
  return ParentPinResult(
    pinConfigured: dto.pinConfigured,
    changed: dto.changed,
    pinSetAt: dto.pinSetAt,
    remainingAttempts: dto.remainingAttempts,
  );
}
