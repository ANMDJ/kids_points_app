import 'package:flutter/material.dart';

import 'data/app_scope.dart';
import 'data/app_store.dart';
import 'data/app_version_api.dart';
import 'data/auth_api.dart';
import 'data/date_code_api.dart';
import 'data/device_token_api.dart';
import 'data/identity_api.dart';
import 'data/onboarding_api.dart';
import 'data/parent_mode_api.dart';
import 'data/push_token_lifecycle.dart';
import 'data/push_token_registration.dart';
import 'data/push_token_runtime.dart';
import 'data/read_api.dart';
import 'data/session_scope.dart';
import 'data/token_store.dart';
import 'data/write_api.dart';
import 'screens/account_gate.dart';
import 'screens/date_code_gate.dart';
import 'screens/home_shell.dart';
import 'screens/onboarding_gate.dart';
import 'screens/update_gate.dart';
import 'theme/app_theme.dart';

Future<void> main() async {
  // W6-F：`PushTokenLifecycle` 要注册 `WidgetsBindingObserver`，必须先初始化绑定。
  // `runApp()` 内部也会初始化，但推送运行时在 `runApp()` 之前就要接上，所以显式调用。
  WidgetsFlutterBinding.ensureInitialized();

  // W10-B / P0-1：运行期身份。设备 id 首启生成并持久化；孩子 id 登录后由
  // `POST /auth/child-session` 签发。**不再从 `--dart-define` 读这两个值。**
  final SessionScope session = SessionScope();
  await session.restore();

  // 编译期只剩 `baseUrl`：它决定这个安装包连哪个环境。
  // 没配 ⇒ 预览模式（闸门直接放行、一个请求都不发）。
  final ReadApiConfig config = ReadApiConfig.fromEnvironment(session: session);
  final bool configured = config.hasBaseUrl;

  // W9-D：**唯一**的 token 持有者。所有 API 客户端都拿它的取值函数，
  // 而不是各自读文件 —— 否则登录/登出之后会出现"有的页面能用、有的页面 401"。
  final AuthTokenHolder tokens = AuthTokenHolder();
  final AuthApiClient? authApi =
      configured ? AuthApiClient(config: config, holder: tokens) : null;
  // W10-B：把 token 落到这台设备 / 这个孩子上（`GET /auth/session` +
  // `POST /auth/child-session`）。没有它，真机上的第一个业务请求必然 401。
  final IdentityApiClient? identityApi =
      configured ? IdentityApiClient(config: config, holder: tokens) : null;
  // W10-B：版本检查（匿名端点，登录前也要能查）。
  final AppVersionApi? versionApi =
      configured ? AppVersionApi(config: config) : null;
  // 没配后端 ⇒ 不发 Authorization 头（预览模式本来就没有 token）。
  final String? Function()? bearerToken =
      configured ? () => tokens.token : null;

  // W6-E / W6-F：设备推送 token 上报。**与后端配置解耦地失败**：
  //   · 没配 KP_PUSH_TOKEN ⇒ 什么都不做（正常预览）；
  //   · 配错 / 发布构建 ⇒ 只打日志，绝不拦住启动；
  //   · 请求失败 / 409 / 超时 ⇒ 由 registrar 吞掉并返回结果。
  // 这里刻意不 `await`：推送登记最多 10 秒，不能把首帧压在它后面。
  if (configured) _startPushToken(config, bearerToken);

  final AppStore store = AppStore(
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
  );

  runApp(
    PointsApp(
      store: store,
      tokens: configured ? tokens : null,
      authApi: authApi,
      identityApi: identityApi,
      session: session,
      config: config,
      appVersionApi: versionApi,
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
    this.identityApi,
    this.session,
    this.config,
    this.appVersionApi,
  });

  final AppStore store;

  /// W9-D：token 持有者。`null` ⇒ 预览模式（闸门直接放行）。
  final AuthTokenHolder? tokens;

  /// W9-D：账号登录客户端。`null` ⇒ 登录页会说明"这个版本没有配置账号登录"。
  final AuthApi? authApi;

  /// W10-B：运行期身份客户端（会话 / 建孩子）。
  final IdentityApi? identityApi;

  /// W10-B：运行期身份（设备 id / 孩子 id）。
  final SessionScope? session;

  /// 配置来源（省略时闸门自己读 `--dart-define`）。
  final ReadApiConfig? config;

  /// W10-B：版本检查客户端。`null` ⇒ 不做更新检查（预览 / 离线测试）。
  final AppVersionApi? appVersionApi;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      store: store,
      child: MaterialApp(
        title: '积分小管家',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        // W10-B：版本检查在**所有闸门之外**：旧版本可能连登录都过不去，
        // 必须让用户在登录页也能看到"去下载新版"。
        home: UpdateGate(
          api: appVersionApi,
          child: AccountGate(
            holder: tokens,
            authApi: authApi,
            identityApi: identityApi,
            session: session,
            config: config,
            // 换账号 / 建孩子后清空首页缓存，避免上一个孩子的数据残留。
            onIdentityChanged: store.resetForIdentity,
            child: const DateCodeGate(
              child: OnboardingGate(child: HomeShell()),
            ),
          ),
        ),
      ),
    );
  }
}

