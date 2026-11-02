import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_version.dart';
import '../data/app_version_api.dart';
import '../data/read_api_errors.dart';
import '../data/url_opener.dart';
import '../theme/app_colors.dart';

/// 版本检查的控制器（W10-B，2026-11-02）。
///
/// ── 为什么把"检查"与"弹窗"分开 ──────────────────────────────────────────────
///   「我的 → 检查更新」与启动自动检查要走**同一条**逻辑，但 UI 反馈不同：
///   前者要提示"已是最新版本"，后者只在有新版本时打扰用户。
///   控制器只回答事实（最新版本 / 错误），弹窗由界面决定。
class AppUpdateController extends ChangeNotifier {
  AppUpdateController({
    required this.api,
    this.currentVersion = kAppVersion,
    this.currentBuild = kAppBuildNumber,
    this.now,
  });

  /// `null` ⇒ 预览模式：没有可查的后端，所有检查都静默跳过。
  final AppVersionApi? api;
  final String currentVersion;
  final int currentBuild;

  /// 可注入的时钟（测试用；生产为 `DateTime.now`）。
  final DateTime Function()? now;

  AppVersionInfo? latest;
  String? lastError;
  bool checking = false;

  DateTime? _lastCheckAt;

  bool get hasUpdate {
    final AppVersionInfo? info = latest;
    return info != null && info.isNewerThan(currentVersion, currentBuild);
  }

  /// 拉一次版本信息。`force=false` 时 6 小时内不重复请求
  /// （App 反复切前台不该打一串 `GET /app/version`）。
  Future<AppVersionInfo?> check({bool force = false}) async {
    final AppVersionApi? client = api;
    if (client == null) return null;

    final DateTime clock = (now ?? DateTime.now)();
    final DateTime? last = _lastCheckAt;
    if (!force &&
        last != null &&
        clock.difference(last) < const Duration(hours: 6)) {
      return latest;
    }
    if (checking) return latest;

    checking = true;
    lastError = null;
    notifyListeners();
    try {
      latest = await client.fetch();
      _lastCheckAt = clock;
      return latest;
    } on ReadApiException catch (error) {
      // ★ 更新检查失败**不打扰用户**（除手动点的那次）：网络抖一下就弹
      //   "检查更新失败"只会让人以为 App 坏了。错误留给手动入口展示。
      lastError = error.userMessage;
      return null;
    } finally {
      checking = false;
      notifyListeners();
    }
  }
}

/// 让「我的」页能触发同一个控制器（不把 controller 逐层透传）。
class AppUpdateScope extends InheritedWidget {
  const AppUpdateScope({
    super.key,
    required this.controller,
    required this.onCheckManually,
    required super.child,
  });

  final AppUpdateController controller;
  final Future<void> Function() onCheckManually;

  static AppUpdateScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppUpdateScope>();

  @override
  bool updateShouldNotify(AppUpdateScope oldWidget) =>
      oldWidget.controller != controller;
}

/// 启动检查 + 更新弹窗（W10-B，2026-11-02）。
///
/// ── 为什么在**所有闸门之外** ────────────────────────────────────────────────
///   版本太旧时可能连登录接口都不兼容。更新提示必须在登录页也能出现，
///   否则用户面对的是一个"密码明明对却登不进去"的死结。
///
/// ── 失败静默 ────────────────────────────────────────────────────────────────
///   检查失败绝不影响使用（返回 `null`）；只有用户**手动**点检查时才提示。
class UpdateGate extends StatefulWidget {
  const UpdateGate({
    super.key,
    required this.child,
    this.api,
    this.currentVersion = kAppVersion,
    this.currentBuild = kAppBuildNumber,
    this.autoCheck = true,
    this.now,
  });

  final Widget child;
  final AppVersionApi? api;
  final String currentVersion;
  final int currentBuild;
  final bool autoCheck;
  final DateTime Function()? now;

  @override
  State<UpdateGate> createState() => _UpdateGateState();
}

class _UpdateGateState extends State<UpdateGate> with WidgetsBindingObserver {
  late final AppUpdateController _controller = AppUpdateController(
    api: widget.api,
    currentVersion: widget.currentVersion,
    currentBuild: widget.currentBuild,
    now: widget.now,
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (widget.autoCheck && widget.api != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _autoCheck();
      });
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 回到前台时再查一次（控制器内部 6 小时节流）。
    if (state == AppLifecycleState.resumed && widget.autoCheck) {
      _autoCheck();
    }
  }

  Future<void> _autoCheck() async {
    final AppVersionInfo? info = await _controller.check();
    if (!mounted || info == null) return;
    if (info.isNewerThan(widget.currentVersion, widget.currentBuild)) {
      await _present(info);
    }
  }

  Future<void> _manualCheck() async {
    final AppVersionInfo? info = await _controller.check(force: true);
    if (!mounted) return;
    if (info == null) {
      final String message = _controller.lastError ?? '检查更新失败，请稍后再试。';
      _snack(message);
      return;
    }
    if (!info.isNewerThan(widget.currentVersion, widget.currentBuild)) {
      _snack('已是最新版本（$kAppVersionLabel）。');
      return;
    }
    await _present(info);
  }

  void _snack(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  Future<void> _present(AppVersionInfo info) async {
    final bool required =
        info.requiresUpdate(widget.currentVersion, widget.currentBuild);
    final String? action = await showDialog<String>(
      context: context,
      barrierDismissible: !required,
      builder: (BuildContext context) => _UpdateDialog(
        info: info,
        currentLabel: kAppVersionLabel,
        required: required,
      ),
    );
    if (action != 'update' || !mounted) return;

    final bool opened = await openExternalUrl(info.downloadUrl);
    if (opened) return;
    // 打不开就退回到"复制链接"：这是用户在旧 Android / 无浏览器上
    // 唯一还能自救的路径，不能什么都不做。
    await Clipboard.setData(ClipboardData(text: info.downloadUrl));
    if (!mounted) return;
    _snack('已复制下载链接，请用浏览器打开：${info.downloadUrl}');
  }

  @override
  Widget build(BuildContext context) {
    return AppUpdateScope(
      controller: _controller,
      onCheckManually: _manualCheck,
      child: widget.child,
    );
  }
}

class _UpdateDialog extends StatelessWidget {
  const _UpdateDialog({
    required this.info,
    required this.currentLabel,
    required this.required,
  });

  final AppVersionInfo info;
  final String currentLabel;
  final bool required;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surface,
      title: Text(
        '发现新版本 v${info.latestVersion}',
        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
      ),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              required
                  ? '这个版本已不被支持，需要更新后才能继续使用。'
                  : '当前版本 $currentLabel，可以现在更新。',
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.6,
                color: AppColors.textSecondary,
              ),
            ),
            if (info.releaseNotes.trim().isNotEmpty) ...<Widget>[
              const SizedBox(height: 12),
              const Text(
                '更新内容',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 4),
              Text(
                info.releaseNotes,
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.6,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
            const SizedBox(height: 14),
            const Text(
              '下载地址',
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 4),
            SelectableText(
              info.downloadUrl,
              style: const TextStyle(fontSize: 11.5, color: AppColors.textHint),
            ),
          ],
        ),
      ),
      actions: <Widget>[
        if (!required)
          TextButton(
            onPressed: () => Navigator.of(context).pop('later'),
            child: const Text('稍后'),
          ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop('update'),
          child: const Text('立即更新'),
        ),
      ],
    );
  }
}

