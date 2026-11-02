import 'dart:async';
import 'dart:convert';

import 'http_transport.dart';
import 'read_api.dart' show ReadApiConfig;
import 'read_api_errors.dart';
import 'read_dto.dart';

/// `GET /app/version` 的回包（W10-B，2026-11-02）。
///
/// ── 与其它 DTO 同一口径 ─────────────────────────────────────────────────────
///   缺字段 / 类型不对 ⇒ [ReadApiException.malformed]，不猜默认值。
///   这里猜错的后果很具体：`downloadUrl` 猜成空串 ⇒ 用户点了「立即更新」
///   什么都不会发生，而界面看起来一切正常。
///
/// ── 只有"更新"是客户端判断 ─────────────────────────────────────────────────
///   服务端只给事实（最新版本 / 最低版本 / 下载地址），不判断"你要不要更新"：
///   客户端才知道自己装的是哪个版本（`kAppVersion` / `kAppBuildNumber`）。
class AppVersionInfo {
  const AppVersionInfo({
    required this.latestVersion,
    required this.latestBuild,
    required this.minimumVersion,
    required this.minimumBuild,
    required this.downloadUrl,
    required this.releaseNotes,
    required this.publishedAt,
  });

  factory AppVersionInfo.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final AppVersionInfo info = AppVersionInfo(
      latestVersion: readString(json, 'latestVersion', '$path.latestVersion'),
      latestBuild: readInt(json, 'latestBuild', '$path.latestBuild'),
      minimumVersion: readString(json, 'minimumVersion', '$path.minimumVersion'),
      minimumBuild: readInt(json, 'minimumBuild', '$path.minimumBuild'),
      downloadUrl: readString(json, 'downloadUrl', '$path.downloadUrl'),
      releaseNotes: readString(json, 'releaseNotes', '$path.releaseNotes'),
      publishedAt: readOptionalDate(json, 'publishedAt', '$path.publishedAt'),
    );

    if (_parseVersion(info.latestVersion) == null ||
        _parseVersion(info.minimumVersion) == null) {
      throw ReadApiException.malformed(
        path,
        detail: 'latestVersion / minimumVersion 必须是 x.y.z',
      );
    }
    // ★ 只接受 http(s) 绝对地址：`javascript:` 或相对路径会变成
    //   「点一下就执行脚本」/「点了没反应」，两者都不该出现在更新按钮上。
    final Uri? url = Uri.tryParse(info.downloadUrl);
    if (url == null ||
        !(url.scheme == 'http' || url.scheme == 'https') ||
        url.host.isEmpty) {
      throw ReadApiException.malformed(
        '$path.downloadUrl',
        detail: '必须是 http(s) 绝对地址（收到：${info.downloadUrl}）',
      );
    }
    return info;
  }

  final String latestVersion;
  final int latestBuild;
  final String minimumVersion;
  final int minimumBuild;
  final String downloadUrl;
  final String releaseNotes;
  final DateTime? publishedAt;

  /// 服务端的最新版**是否比**当前安装的版本新。
  ///
  /// 先比版本号（数值逐段），相同时再比构建号 —— 与后端
  /// `app-version.policy.ts#compareVersions` 同一口径。
  bool isNewerThan(String currentVersion, int currentBuild) {
    final int diff = compareAppVersions(latestVersion, currentVersion);
    if (diff != 0) return diff > 0;
    return latestBuild > currentBuild;
  }

  /// 当前版本是否**低于最低支持版本**（强制更新）。
  bool requiresUpdate(String currentVersion, int currentBuild) {
    final int diff = compareAppVersions(minimumVersion, currentVersion);
    if (diff != 0) return diff > 0;
    return minimumBuild > currentBuild;
  }
}


/// `x.y.z` → `[x, y, z]`；形状不对 ⇒ `null`。
List<int>? _parseVersion(String raw) {
  final String value = raw.trim();
  if (!RegExp(r'^\d{1,4}\.\d{1,4}\.\d{1,4}$').hasMatch(value)) return null;
  return value.split('.').map(int.parse).toList(growable: false);
}

/// 数值逐段比较（`1.0.10 > 1.0.9`；字符串比较会判反）。
///
/// 非法版本一律排**最旧**：它只可能来自配置错误，不该看起来比真实版本新。
int compareAppVersions(String a, String b) {
  final List<int>? left = _parseVersion(a);
  final List<int>? right = _parseVersion(b);
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  final int length = left.length > right.length ? left.length : right.length;
  for (int index = 0; index < length; index += 1) {
    final int l = index < left.length ? left[index] : 0;
    final int r = index < right.length ? right[index] : 0;
    if (l != r) return l - r;
  }
  return 0;
}

/// `GET /app/version` 的客户端。
///
/// ── 为什么不需要 token / 设备头 ──────────────────────────────────────────────
///   它是**匿名**端点（后端 `@Public()`）：只回公开的版本号与下载地址。
///   登录之前就要能检查更新（否则旧版本登不进去时没有任何自救路径），
///   所以这里刻意只发 `Accept`。
class AppVersionApi {
  AppVersionApi({
    required this.config,
    ReadTransport? transport,
    this.timeout = const Duration(seconds: 10),
  }) : _transport = transport ?? createReadTransport(connectionTimeout: timeout);

  final ReadApiConfig config;
  final Duration timeout;
  final ReadTransport _transport;

  Future<AppVersionInfo> fetch() async {
    final String? baseError = config.baseUrlError;
    if (baseError != null) {
      throw ReadApiException(
        ReadFailureKind.badRequest,
        baseError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final Uri uri = config.uri('/app/version');
    final ReadHttpResponse response;
    try {
      response = await _transport
          .send(uri, <String, String>{kAcceptHeader: 'application/json'})
          .timeout(timeout);
    } on TimeoutException {
      throw ReadApiException.timeout(timeout);
    } on ReadApiException {
      rethrow;
    } on Exception catch (error) {
      throw ReadApiException.network(error);
    }

    Object? body;
    if (response.body.trim().isNotEmpty) {
      try {
        body = jsonDecode(response.body);
      } on FormatException {
        body = null;
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ReadApiException.fromHttp(
        statusCode: response.statusCode,
        body: body,
      );
    }
    if (body == null) {
      throw ReadApiException.malformed(
        r'$',
        detail: 'HTTP ${response.statusCode} 但响应体为空',
      );
    }
    return AppVersionInfo.fromJson(body, r'$');
  }

  void close() => _transport.close();
}
