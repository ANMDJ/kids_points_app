/// 孩子模式的**产品常量**（W14，2026-11-03 / `docs/design/51-kid-mode-window.md`）。
///
/// ── 为什么单独一个文件 ──────────────────────────────────────────────────────
///   30 这个数字同时出现在三端：
///     · 后端 `backend/src/auth/kid-mode.policy.ts`（判定 + DTO 上限）；
///     · 本文件（UI 步进的上界与本地预检）；
///     · `kids_points_mp/src/data/parent_mode.ts`（小程序同构）。
///   三份手抄必然漂移（`password_rules` 已经交过学费：文案与规则各改一半），
///   所以 `tools/kid-mode-check.mjs` 会逐字比对这三处，`npm run ci` 里跑。
///
/// ── 为什么不复用家长模式的 5 分钟 ────────────────────────────────────────────
///   方向相反：家长模式是**升级**（child ⇒ guardian，5 分钟，PIN 换来）；
///   孩子模式是**降级**（guardian ⇒ child，1–30 分钟，家长主动交出手机）。
///   共用一份常量会让"调长家长窗口"顺手把孩子的可用时间也改了。
library;

/// 一次最短 1 分钟。
const int kKidModeMinMinutes = 1;

/// 一次最长 30 分钟（产品裁定，2026-11-03）。
const int kKidModeMaxMinutes = 30;

/// 面板默认选中 15 分钟 —— **不是**上限：默认即上限会让"少用一会儿"变成额外操作。
const int kKidModeDefaultMinutes = 15;

/// 面板上的快捷时长（5 的倍数 + 上限）。
const List<int> kKidModeDurationChoices = <int>[5, 10, 15, 20, 25, 30];

/// 本地预检：整数 1–30。`null` = 合法。
///
/// ★ 这只是"少发一次注定 400 的请求"；服务端仍会用自己的 `KID_MODE_MAX_MINUTES`
///   再夹一次（`clampKidModeMinutes()`）—— 客户端校验永远不是护栏。
String? validateKidModeMinutes(int minutes) {
  if (minutes < kKidModeMinMinutes || minutes > kKidModeMaxMinutes) {
    return '给孩子用的时长要在 $kKidModeMinMinutes–$kKidModeMaxMinutes 分钟之间。';
  }
  return null;
}

/// 秒 → `12:34`（分钟不补零，秒补零）。孩子模式顶栏与面板共用。
///
/// 与 `ParentModeApiClient.humanizeSeconds()`（文字版）刻意分开：
/// 倒计时用等宽数字更好读，文案用「12 分 34 秒」更适合句子。
String kidModeMmss(int seconds) {
  final int safe = seconds < 0 ? 0 : seconds;
  final int minutes = safe ~/ 60;
  final int rest = safe % 60;
  return '$minutes:${rest.toString().padLeft(2, '0')}';
}
