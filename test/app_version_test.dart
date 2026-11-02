import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/app_version.dart';
import 'package:kids_points_app/data/app_version_api.dart';
import 'package:kids_points_app/data/http_transport_types.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/screens/login_screen.dart';
import 'package:kids_points_app/screens/update_gate.dart';

/// W10-B：App 自更新的客户端用例（2026-11-02）。
///
/// ── 这里钉的四件事 ─────────────────────────────────────────────────────────
///   ① 版本比较是**数值逐段**（`1.0.10 > 1.0.9`）且先版本后构建号；
///   ② 下载地址只接受 http(s) 绝对地址（`javascript:` ⇒ malformed）；
///   ③ 版本检查请求不带 token / 设备头（登录前也要能查）；
///   ④ 有新版本才弹窗；强制更新时不出现「稍后」。
void main() {
  AppVersionInfo info({
    String latestVersion = '1.0.1',
    int latestBuild = 2,
    String minimumVersion = '1.0.0',
    int minimumBuild = 1,
    String downloadUrl = 'https://hub.littlewish.top:8443/app/kids.apk',
  }) =>
      AppVersionInfo(
        latestVersion: latestVersion,
        latestBuild: latestBuild,
        minimumVersion: minimumVersion,
        minimumBuild: minimumBuild,
        downloadUrl: downloadUrl,
        releaseNotes: '修复登录',
        publishedAt: null,
      );

  group('版本比较（与后端 policy 同一口径）', () {
    test('数值逐段：1.0.10 > 1.0.9', () {
      expect(compareAppVersions('1.0.10', '1.0.9'), greaterThan(0));
      expect(compareAppVersions('1.2.3', '1.2.3'), 0);
      expect(compareAppVersions('1.0.0', '2.0.0'), lessThan(0));
    });

    test('同版本号时比构建号', () {
      final AppVersionInfo sameVersion = info(latestBuild: 7);
      expect(sameVersion.isNewerThan('1.0.1', 6), isTrue);
      expect(sameVersion.isNewerThan('1.0.1', 7), isFalse);
    });

    test('最低版本判断用于强制更新', () {
      final AppVersionInfo forced =
          info(minimumVersion: '1.0.3', minimumBuild: 4);
      expect(forced.requiresUpdate('1.0.2', 3), isTrue);
      expect(forced.requiresUpdate('1.0.3', 4), isFalse);
    });
  });

  group('AppVersionInfo.fromJson', () {
    test('完整回包解析成功（publishedAt 可空）', () {
      final AppVersionInfo parsed = AppVersionInfo.fromJson(<String, Object?>{
        'platform': 'android',
        'latestVersion': '1.2.3',
        'latestBuild': 12,
        'minimumVersion': '1.2.0',
        'minimumBuild': 10,
        'downloadUrl': 'https://example.test/kids.apk',
        'releaseNotes': '修复登录',
        'publishedAt': '2026-11-02T00:00:00.000Z',
      }, r'$');
      expect(parsed.latestVersion, '1.2.3');
      expect(parsed.latestBuild, 12);
      expect(parsed.publishedAt, isNotNull);
    });

    test('★ 非 http(s) 的下载地址 ⇒ malformed（不许变成可点击脚本）', () {
      expect(
        () => AppVersionInfo.fromJson(<String, Object?>{
          'latestVersion': '1.2.3',
          'latestBuild': 12,
          'minimumVersion': '1.2.0',
          'minimumBuild': 10,
          'downloadUrl': 'javascript:alert(1)',
          'releaseNotes': '',
          'publishedAt': null,
        }, r'$'),
        throwsA(isA<ReadApiException>().having(
          (ReadApiException e) => e.kind,
          'kind',
          ReadFailureKind.malformed,
        )),
      );
    });
  });

  group('AppVersionApi.fetch', () {
    test('★ GET /app/version，只带 accept（登录前可用）', () async {
      final _RecordingTransport transport = _RecordingTransport(
        body: jsonEncode(<String, Object?>{
          'latestVersion': '1.0.1',
          'latestBuild': 2,
          'minimumVersion': '1.0.0',
          'minimumBuild': 1,
          'downloadUrl': 'https://example.test/kids.apk',
          'releaseNotes': '',
          'publishedAt': null,
        }),
      );
      final AppVersionApi api = AppVersionApi(
        config: const ReadApiConfig(baseUrl: 'https://example.test/kids'),
        transport: transport,
      );

      final AppVersionInfo result = await api.fetch();
      expect(result.latestVersion, '1.0.1');
      expect(transport.headers.keys, <String>[kAcceptHeader]);
      expect(transport.uri!.path, '/kids/app/version');
    });

    test('没配 baseUrl ⇒ 本地就拒（不发请求）', () async {
      final _RecordingTransport transport = _RecordingTransport(body: '{}');
      final AppVersionApi api = AppVersionApi(
        config: const ReadApiConfig(baseUrl: ''),
        transport: transport,
      );
      await expectLater(api.fetch(), throwsA(isA<ReadApiException>()));
      expect(transport.calls, 0);
    });
  });

  group('UpdateGate：只在有新版本时弹窗', () {
    testWidgets('新版本 ⇒ 显示更新说明与「稍后」；点稍后关闭', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: UpdateGate(
          api: _FakeVersionApi(info()),
          currentVersion: '1.0.0',
          currentBuild: 1,
          child: const Scaffold(body: Text('HOME')),
        ),
      ));
      await tester.pumpAndSettle();

      expect(find.text('发现新版本 v1.0.1'), findsOneWidget);
      expect(find.text('修复登录'), findsOneWidget);
      expect(find.text('稍后'), findsOneWidget);

      await tester.tap(find.text('稍后'));
      await tester.pumpAndSettle();
      expect(find.text('发现新版本 v1.0.1'), findsNothing);
      expect(find.text('HOME'), findsOneWidget);
    });

    testWidgets('已是最新 ⇒ 不打扰', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: UpdateGate(
          api: _FakeVersionApi(info(latestVersion: '1.0.0', latestBuild: 1)),
          currentVersion: '1.0.0',
          currentBuild: 1,
          child: const Scaffold(body: Text('HOME')),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text('HOME'), findsOneWidget);
    });

    testWidgets('★ 低于最低版本 ⇒ 没有「稍后」（强制更新）', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: UpdateGate(
          api: _FakeVersionApi(info(minimumVersion: '9.0.0', minimumBuild: 1)),
          currentVersion: '1.0.0',
          currentBuild: 1,
          child: const Scaffold(body: Text('HOME')),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.text('稍后'), findsNothing);
      expect(find.text('立即更新'), findsOneWidget);
      expect(find.textContaining('已不被支持'), findsOneWidget);
    });
  });

  testWidgets('★ 登录页底部也显示「发现新版本 · 点此更新」（W11-B）', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: UpdateGate(
        api: _FakeVersionApi(info(latestVersion: '9.9.9', latestBuild: 9)),
        currentVersion: '1.0.0',
        currentBuild: 1,
        child: LoginScreen(onSubmit: (String _, String __) async => null),
      ),
    ));
    await tester.pumpAndSettle();

    // 自动检查会先弹出更新对话框；登录页底部是同一个事实的第二个入口，
    // 这样「进不去 App 的人」也能看到并触发更新。
    expect(find.textContaining('点此更新'), findsOneWidget);

    await tester.tap(find.text('稍后'));
    await tester.pumpAndSettle();
    expect(find.textContaining('发现新版本 v9.9.9'), findsOneWidget);
  });

  test('★ pubspec.yaml 与 lib/app_version.dart 必须同步（改一处忘另一处会红）',
      () {
    final String pubspec = File('pubspec.yaml').readAsStringSync();
    final Match? match = RegExp(
      r'^version:\s*(\d+\.\d+\.\d+)\+(\d+)',
      multiLine: true,
    ).firstMatch(pubspec);
    expect(match, isNotNull, reason: 'pubspec.yaml 缺少 version: x.y.z+build');
    expect(match!.group(1), kAppVersion);
    expect(int.parse(match.group(2)!), kAppBuildNumber);
  });
}

class _FakeVersionApi extends AppVersionApi {
  _FakeVersionApi(this.info)
      : super(config: const ReadApiConfig(baseUrl: 'https://example.test/kids'));

  final AppVersionInfo info;

  @override
  Future<AppVersionInfo> fetch() async => info;
}

class _RecordingTransport implements ReadTransport {
  _RecordingTransport({required this.body});

  final String body;
  int calls = 0;
  Uri? uri;
  Map<String, String> headers = <String, String>{};

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    calls += 1;
    this.uri = uri;
    this.headers = Map<String, String>.from(headers);
    return ReadHttpResponse(statusCode: 200, body: body);
  }

  @override
  void close() {}
}
