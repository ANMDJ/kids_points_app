/// **浏览器**的操作系统名。
///
/// ── 为什么返回 `web` 而不是猜一个 `android` / `ios` ────────────────────────
///   浏览器的 User-Agent 可以随便改，猜出来的平台会决定 `DeviceToken.platform`
///   —— 猜错等于把推送地址挂到一个错的渠道上。`web` 不是受支持的推送平台，
///   于是 `PushTokenConfig` 会**明确报错**（「无法从操作系统 `web` 推断推送平台」），
///   而不是静默登记一条假 token。
///
///   ★ 本仓库的 Web 版本只用于预览 / 联调，**不做** Web Push。
String currentOperatingSystem() => 'web';
