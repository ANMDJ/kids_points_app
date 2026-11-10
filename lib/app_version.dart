/// App 版本号的**唯一**编译期来源（W10-B，2026-11-02）。
///
/// ── 为什么需要这个文件 ──────────────────────────────────────────────────────
///   纯 Flutter SDK 没有任何读取安装包版本的能力（`package_info_plus` 是第三方
///   依赖，与 README「零第三方依赖」的硬约束冲突）。所以版本号写在代码里，
///   由 `test/app_version_test.dart` 与 `pubspec.yaml` 的 `version:` **双向钉住**
///   —— 改一处忘了另一处会红，而不是等到用户装了两个\"同版本\"却行为不同的包。
///
/// ── 与后端的关系 ────────────────────────────────────────────────────────────
///   `GET /app/version` 返回 `latestVersion` / `latestBuild`；
///   客户端拿这里的常量去比（见 `lib/data/app_version_api.dart` 的比较函数）。
///   发布新版时**三处一起改**：pubspec.yaml、本文件、部署机的
///   `APP_LATEST_VERSION` / `APP_LATEST_BUILD`。
library;

/// 与 `pubspec.yaml` 的 `version: 1.0.7+8` 前半段逐字一致。
const String kAppVersion = '1.0.7';

/// 与 `pubspec.yaml` 的 `+8` 逐字一致（Android `versionCode`）。
const int kAppBuildNumber = 8;

/// 界面上展示的版本标签。
String get kAppVersionLabel => 'v$kAppVersion ($kAppBuildNumber)';
