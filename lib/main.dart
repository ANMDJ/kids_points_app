import 'package:flutter/material.dart';

import 'data/app_scope.dart';
import 'data/app_store.dart';
import 'data/auth_api.dart';
import 'data/date_code_api.dart';
import 'data/device_token_api.dart';
import 'data/onboarding_api.dart';
import 'data/parent_mode_api.dart';
import 'data/push_token_lifecycle.dart';
import 'data/push_token_registration.dart';
import 'data/push_token_runtime.dart';
import 'data/read_api.dart';
import 'data/token_store.dart';
import 'data/write_api.dart';
import 'screens/account_gate.dart';
import 'screens/date_code_gate.dart';
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

  // W9-D：**唯一**的 token 持有者。四个 API 客户端都拿它的取值函数，
  // 而不是各自读文件 —— 否则登录/登出之后会出现"有的页面能用、有的页面 401"。
  final AuthTokenHolder tokens = AuthTokenHolder();
  final AuthApiClient? authApi =
      configured ? AuthApiClient(config: config, holder: tokens) : null;
  // 没配后端 ⇒ 不发 Authorization 头（预览模式本来就没有 token）。
  final String? Function()? bearerToken =
      configured ? () => tokens.token : null;

  // W6-E / W6-F：设备推送 token 上报。**与后端配置解耦地失败**：
  //   · 没配 KP_PUSH_TOKEN ⇒ 什么都不做（正常预览）；
  //   · 配错 / 发布构建 ⇒ 只打日志，绝不拦住启动；
  //   · 请求失败 / 409 / 超时 ⇒ 由 registrar 吞掉并返回结果。
  // 这里刻意不 `await`：推送登记最多 10 秒，不能把首帧压在它后面。
  if (configured) _startPushToken(config, bearerToken);

  runApp(
    PointsApp(
      store: AppStore(
        readApi: configured
            ? ReadApiClient(config: config, tokenProvider: bearerToken)
            : null,
        writeApi: configured
            ? WriteApiClient(config: config, tokenProvider: bearerToken)
            : null,
        // W8-B：引导闸门。只在配置齐全时注入 —— 预览模式没有服务端状态，
        // 编一个「未引导」会把人推进一个永远完不成的流程。
        onboardingApi: configured
            ? OnboardingApiClient(config: config, tokenProvider: bearerToken)
            : null,
        // W8-C：切家长模式 + 设 / 改家长 PIN。同样只在配置齐全时注入 ——
        // 预览模式没有会话、没有 PIN，画一个点了必然失败的入口比不画更糟。
        parentModeApi: configured
            ? ParentModeApiClient(config: config, tokenProvider: bearerToken)
            : null,
        // W9-C：启动闸门用的 6 位验证码。注入的**唯一**后果是「启动时先要一次
        // 今天的码」；它不产生凭据，也不改变身份（见 `date_code_gate.dart` 文件头）。
        dateCodeApi: configured ? DateCodeApiClient(config: config) : null,
      ),
      tokens: configured ? tokens : null,
      authApi: authApi,
      config: config,
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
void _startPushToken(ReadApiConfig config, String? Function()? tokenProvider) {
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
    api: DeviceTokenApiClient(config: config, tokenProvider: tokenProvider),
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
  const PointsApp({
    super.key,
    required this.store,
    this.tokens,
    this.authApi,
    this.config,
  });

  final AppStore store;

  /// W9-D：token 持有者。`null` ⇒ 预览模式（闸门直接放行）。
  final AuthTokenHolder? tokens;

  /// W9-D：账号登录客户端。`null` ⇒ 登录页会说明"这个版本没有配置账号登录"。
  final AuthApi? authApi;

  /// 配置来源（省略时闸门自己读 `--dart-define`）。
  final ReadApiConfig? config;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      store: store,
      child: MaterialApp(
        title: '积分小管家',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        // W9-D：**最外层**是账号闸门（你是谁）。没有 token ⇒ 登录页。
        //   ★ 三层闸门的方向性约束各不相同，别把它们合并：
        //     · AccountGate：没配后端 ⇒ **放行**（预览模式没有账号这回事）；
        //     · DateCodeGate：拿不到状态 ⇒ **继续锁着**（它是门锁）；
        //     · OnboardingGate：拿不到状态 ⇒ **放行**（别把家长挡在引导外面）。
        home: AccountGate(
          holder: tokens,
          authApi: authApi,
          config: config,
          child: const DateCodeGate(
            child: OnboardingGate(child: HomeShell()),
          ),
        ),
      ),
    );
  }
}
