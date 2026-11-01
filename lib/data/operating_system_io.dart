import 'dart:io' show Platform;

/// **移动 / 桌面**的操作系统名（`android` / `ios` / `linux` / `macos` / `windows`）。
///
/// Web 上本文件不会被编译 —— 见 `operating_system.dart` 的条件导出。
String currentOperatingSystem() => Platform.operatingSystem;
