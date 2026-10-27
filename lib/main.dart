import 'package:flutter/material.dart';

import 'data/app_scope.dart';
import 'data/app_store.dart';
import 'data/device_token_api.dart';
import 'data/onboarding_api.dart';
import 'data/push_token_lifecycle.dart';
import 'data/push_token_registration.dart';
import 'data/push_token_runtime.dart';
import 'data/read_api.dart';
import 'data/write_api.dart';
import 'screens/home_shell.dart';
import 'screens/onboarding_gate.dart';
import 'theme/app_theme.dart';

void main() {
  // W6-F：`PushTokenLifecycle` 要注册 `WidgetsBindingObserver`，必须先初始化绑定。
  // `runApp()` 内部也会初始化，但推送运行时在 `runApp()` 之前就要接上，所以显式调用。
  WidgetsFlutterBinding.ensureInitialized();

  // W4-B / W4-E：只有三项 `--dart-define` 都配齐才接后端；否则保持本地预览数据，
  // 不会出现「发了请求 → 401 → 页面显示成网络错误」的假象。
  final ReadApiConfig config = ReadApiConfig.fromEnvironment();
  final bool configured = config.isConfigured;

  // W6-E / W6-F：设备推送 token 上报。**与后端配置解耦地失败**：
  //   · 没配 KP_PUSH_TOKEN ⇒ 什么都不做（正常预览）；
  //   · 配错 / 发布构建 ⇒ 只打日志，绝不拦住启动；
  //   · 请求失败 / 409 / 超时 ⇒ 由 registrar 吞掉并返回结果。
  // 这里刻意不 `await`：推送登记最多 10 秒，不能把首帧压在它后面。
  if (configured) _startPushToken(config);

  runApp(
    PointsApp(
      store: AppStore(
        readApi: configured ? ReadApiClient(config: config) : null,
        writeApi: configured ? WriteApiClient(config: config) : null,
        // W8-B：引导闸门。只在配置齐全时注入 —— 预览模式没有服务端状态，
        // 编一个「未引导」会把人推进一个永远完不成的流程。
        onboardingApi: configured ? OnboardingApiClient(config: config) : null,
      ),
    ),
  );
}

/// 启动推送运行时（fire-and-forget）。
///
/// 与 W6-E 的一次性上报不同，这里**不关闭** registrar：`PushTokenLifecycle` 会在
/// App 回到前台时按冷却窗口重新读取 token（真实 SDK 轮换 token 后能自动补报），
/// 退出登录时调用 [PushTokenLifecycle.revoke] 即可停止并注销。
///
/// 真接入时把 [PushTokenConfig.fromEnvironment] 换成厂商 SDK 适配器实现的
/// [PushTokenSource]（`FirebaseMessaging.instance.getToken()` /
/// `wx.getPushToken` 等），其余流程（去重、单飞、409 处理、生命周期）完全复用。
void _startPushToken(ReadApiConfig config) {
  final PushTokenConfig push = PushTokenConfig.fromEnvironment();
  if (!push.enabled) {
    // 没配 token = 未接入推送，不是错误；预览 / 本地开发都走这条。
    return;
  }

  final String? configError = push.validationError;
  if (configError != null) {
    debugPrint('[push] 推送配置无效，已跳过上报：$configError');
    return;
  }

  final PushTokenSource? source = push.toSource();
  if (source == null) return;

  final PushTokenRegistrar registrar = PushTokenRegistrar(
    api: DeviceTokenApiClient(config: config),
    source: source,
    log: debugPrint,
  );
  final PushTokenRuntime runtime = PushTokenRuntime(
    registrar: registrar,
    log: debugPrint,
  );

  // 对象由 `WidgetsBinding` 的 observer 列表持有，不需要全局变量。
  PushTokenLifecycle(runtime: runtime, log: debugPrint).start();
}

/// 积分小管家：儿童习惯打卡 + 积分奖励。
class PointsApp extends StatelessWidget {
  const PointsApp({super.key, required this.store});

  final AppStore store;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      store: store,
      child: MaterialApp(
        title: '积分小管家',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        // W8-B：先过引导闸门 —— 服务端说 `onboarded: false` 就进引导，
        // 否则（含状态未知 / 孩子身份）直接进首页外壳。
        home: const OnboardingGate(child: HomeShell()),
      ),
    );
  }
}
