import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/app_scope.dart';
import 'package:kids_points_app/data/app_store.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/read_api_errors.dart';
import 'package:kids_points_app/data/read_dto.dart';
import 'package:kids_points_app/data/read_mapper.dart';
import 'package:kids_points_app/models/family_export.dart';
import 'package:kids_points_app/screens/sheets/export_sheet.dart';

/// W7-C：家庭数据导出（`GET /export`）。
///
/// 这几组用例钉住的是**家长能看出来的事**：
///   ① 文件是不是完整的（`truncated` 与 `truncatedSections` 必须自洽，
///      不允许「说不清哪段被截断」的文件混过去）；
///   ② 复制出来的必须是**服务端原文**（不是本地按模型重新序列化的近似物）；
///   ③ 失败**不清空**上一次的文件，403 照实说「没有权限」而不是「没有数据」；
///   ④ 孩子身份**不发**这个请求（矩阵 `export_family_data` child DENY），
///      面板先看角色，再决定拉不拉。
void main() {
  const ReadApiConfig config = ReadApiConfig(
    baseUrl: 'http://127.0.0.1:3999/api',
    deviceId: 'device-1',
    childId: 'child-1',
  );

  /// 一份最小的导出文件（九段齐全、默认完整）。
  Map<String, Object?> exportJson({
    int schemaVersion = 1,
    String generator = 'kids-points-backend',
    String childId = 'child-1',
    String childName = '小明',
    int pointsBalance = 7,
    Map<String, int>? counts,
    Map<String, int>? totals,
    bool truncated = false,
    List<String> truncatedSections = const <String>[],
  }) =>
      <String, Object?>{
        'schemaVersion': schemaVersion,
        'generator': generator,
        'generatedAt': '2026-10-27T01:30:00.000Z',
        'child': <String, Object?>{
          'id': childId,
          'name': childName,
          'pointsBalance': pointsBalance,
        },
        'summary': <String, Object?>{
          'counts': counts ??
              <String, int>{
                'members': 2,
                'rules': 4,
                'habits': 3,
                'wishes': 1,
                'records': 12,
                'approvals': 2,
                'consents': 1,
                'auditLogs': 5,
              },
          'totals': totals ??
              <String, int>{'records': 12, 'approvals': 2, 'auditLogs': 5},
          'truncated': truncated,
          'truncatedSections': truncatedSections,
        },
      };

  FamilyExportDto parse({
    int schemaVersion = 1,
    Map<String, int>? counts,
    Map<String, int>? totals,
    bool truncated = false,
    List<String> truncatedSections = const <String>[],
  }) {
    final Map<String, Object?> json = exportJson(
      schemaVersion: schemaVersion,
      counts: counts,
      totals: totals,
      truncated: truncated,
      truncatedSections: truncatedSections,
    );
    return FamilyExportDto.fromJson(json, rawJson: jsonEncode(json));
  }

  group('FamilyExportDto：完整性三字段必须自洽', () {
    test('truncated=true 却没说哪段被截断 ⇒ malformed（不能只有日志知道）', () {
      expect(
        () => parse(truncated: true),
        throwsA(isA<ReadApiException>()
            .having((ReadApiException e) => e.kind, 'kind',
                ReadFailureKind.malformed)
            .having((ReadApiException e) => e.userMessage, 'userMessage',
                contains('truncatedSections'))),
      );
    });

    test('列出了被截断的段、truncated 却是 false ⇒ malformed（自相矛盾）', () {
      expect(
        () => parse(truncatedSections: <String>['records']),
        throwsA(isA<ReadApiException>().having(
            (ReadApiException e) => e.kind, 'kind', ReadFailureKind.malformed)),
      );
    });

    test('条数为负 ⇒ malformed（负数是「坏响应」，不是空段）', () {
      expect(
        () => parse(counts: const <String, int>{'records': -1}),
        throwsA(isA<ReadApiException>().having(
            (ReadApiException e) => e.detail, 'detail', contains('不能为负'))),
      );
    });

    test('counts 是空对象 ⇒ malformed（一个段都没有的文件没有意义）', () {
      expect(
        () => parse(counts: const <String, int>{}),
        throwsA(isA<ReadApiException>().having(
            (ReadApiException e) => e.kind, 'kind', ReadFailureKind.malformed)),
      );
    });

    test('totals 也必须有内容（三张大表的全量条数，不能省略成空）', () {
      expect(
        () => parse(totals: const <String, int>{}),
        throwsA(isA<ReadApiException>().having(
            (ReadApiException e) => e.kind, 'kind', ReadFailureKind.malformed)),
      );
    });


    test('schemaVersion 必须是正整数', () {
      expect(
        () => parse(schemaVersion: 0),
        throwsA(isA<ReadApiException>().having(
            (ReadApiException e) => e.kind, 'kind', ReadFailureKind.malformed)),
      );
    });

    test('更新的格式版本照样能读出摘要，但界面必须知道「认不全」', () {
      final FamilyExportDto dto = parse(schemaVersion: 2);
      final FamilyExport file = mapFamilyExport(dto);

      expect(file.schemaVersion, 2);
      expect(file.isKnownSchemaVersion, isFalse);
      expect(file.childName, '小明');
      expect(FamilyExport.supportedSchemaVersion, 1);
    });

    test('rawJson 原样保留：服务端下发什么，复制出来就是什么', () {
      final Map<String, Object?> json = exportJson();
      final String raw = jsonEncode(json);
      final FamilyExportDto dto =
          FamilyExportDto.fromJson(json, rawJson: raw);

      expect(dto.rawJson, raw);
      expect(mapFamilyExport(dto).rawJson, raw);
    });
  });

  group('FamilyExport：界面口径（条数 / 段名 / 文件名）', () {
    test('总行数是各段之和，段顺序沿用后端下发的顺序', () {
      final FamilyExport file = mapFamilyExport(parse());

      expect(file.rowCount, 30);
      expect(
        file.sections.map((FamilyExportSection s) => s.label).toList(),
        <String>['家庭成员', '积分规则', '好习惯', '心愿', '积分流水', '审批申请', '同意记录', '审计日志'],
      );
      expect(file.sections.first.included, 2);
      expect(file.sections.first.truncated, isFalse);
    });

    test('不认识的段名原样显示（backend 加段不能被藏起来）', () {
      final FamilyExport file = mapFamilyExport(
        parse(counts: const <String, int>{'mysterySection': 3}),
      );

      expect(file.sections.single.label, 'mysterySection');
      expect(file.sections.single.countText, '3 条');
    });

    test('截断段显示「本文件 / 库里全量」；没有全量时只说本文件条数', () {
      final FamilyExport truncated = mapFamilyExport(parse(
        counts: const <String, int>{'records': 500, 'habits': 3},
        totals: const <String, int>{'records': 1200},
        truncated: true,
        truncatedSections: const <String>['records'],
      ));

      expect(truncated.sections.first.countText, '500 / 1200 条（已截断）');
      expect(truncated.sections.first.truncated, isTrue);
      expect(truncated.sections[1].countText, '3 条');
      expect(truncated.truncated, isTrue);
      expect(truncated.truncatedSectionsText, '积分流水');

      final FamilyExport noTotals = mapFamilyExport(parse(
        counts: const <String, int>{'records': 500},
        totals: const <String, int>{'approvals': 0},
        truncated: true,
        truncatedSections: const <String>['records'],
      ));
      expect(noTotals.sections.single.countText, '500 条');
      expect(
        noTotals.sections.single.total,
        isNull,
        reason: '这一段没下发全量时不能编一个',
      );
    });

    test('完整文件的 truncatedSectionsText 是「—」，不是空串', () {
      expect(mapFamilyExport(parse()).truncatedSectionsText, '—');
    });

    test('文件名纯 ASCII：孩子 id + 本地日期，中文昵称不进文件名', () {
      final FamilyExport file = mapFamilyExport(parse());
      final DateTime local = file.generatedAt.toLocal();
      String two(int value) => value.toString().padLeft(2, '0');

      expect(
        file.fileName,
        'family-export-child-1-${local.year}-${two(local.month)}-'
        '${two(local.day)}.json',
      );
      expect(RegExp(r'^[A-Za-z0-9.\-]+$').hasMatch(file.fileName), isTrue);
    });
  });

  group('AppStore.loadExport：单飞、失败保留旧文件、预览模式不发请求', () {
    test('预览模式直接进入 ready 空态（不编一份假文件）', () async {
      final AppStore store = AppStore();
      addTearDown(store.dispose);

      await store.loadExport();

      expect(store.isLiveMode, isFalse);
      expect(store.familyExport, isNull);
      expect(store.exportReadStatus, ReadStatus.ready);
      expect(store.exportError, isNull);
      expect(store.isExportBusy, isFalse);
    });

    test('成功时存下完整文件，rawJson 与服务端下发逐字一致', () async {
      final _ExportTransport transport =
          _ExportTransport(exportBody: jsonEncode(exportJson()));
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.loadExport();

      expect(transport.exportCalls, 1);
      expect(store.exportReadStatus, ReadStatus.ready);
      expect(store.exportError, isNull);
      expect(store.familyExport, isNotNull);
      expect(store.familyExport!.rawJson, transport.exportBody);
      expect(store.familyExport!.rowCount, 30);
      expect(store.isExportBusy, isFalse);
    });

    test('403 照实报错，且**不清空**上一次拿到的文件', () async {
      final _ExportTransport transport =
          _ExportTransport(exportBody: jsonEncode(exportJson()));
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await store.loadExport();
      final String firstRaw = store.familyExport!.rawJson;

      transport.exportStatus = 403;
      transport.exportBody =
          '{"code":"FORBIDDEN","message":"缺少 export_family_data 权限"}';
      await store.loadExport();

      expect(store.exportReadStatus, ReadStatus.error);
      expect(store.exportError!.kind, ReadFailureKind.forbidden);
      expect(store.exportError!.statusCode, 403);
      expect(
        store.familyExport!.rawJson,
        firstRaw,
        reason: '失败不能把「刚复制过的文件」说成「没有文件」',
      );
    });

    test('连点两次只发一个请求（不会得到两份时间不同的文件）', () async {
      final _ExportTransport transport = _ExportTransport(
        exportBody: jsonEncode(exportJson()),
        gate: Completer<void>(),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      final Future<void> first = store.loadExport();
      await Future<void>.delayed(Duration.zero);
      expect(store.isExportBusy, isTrue);

      await store.loadExport();
      expect(transport.exportCalls, 1);

      transport.gate!.complete();
      await first;

      expect(transport.exportCalls, 1);
      expect(store.familyExport, isNotNull);
      expect(store.isExportBusy, isFalse);
    });
  });

  group('ExportSheet：先看角色，再拉文件', () {
    /// 面板需要 `ScaffoldMessengerState`（复制成功 / 失败的提示走 SnackBar）。
    Future<void> pumpSheet(WidgetTester tester, AppStore store) async {
      await tester.pumpWidget(
        AppScope(
          store: store,
          child: MaterialApp(
            home: Builder(
              builder: (BuildContext context) => Scaffold(
                body: ExportSheet(
                  store: store,
                  messenger: ScaffoldMessenger.of(context),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('家长：文件头 + 段清单 + 复制出来的是服务端原文',
        (WidgetTester tester) async {
      final _ExportTransport transport =
          _ExportTransport(exportBody: jsonEncode(exportJson()));
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (MethodCall call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map<Object?, Object?>)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));

      await pumpSheet(tester, store);

      expect(store.canExportFamilyData, isTrue);
      expect(transport.exportCalls, 1);
      expect(find.text('小明 的数据'), findsOneWidget);
      expect(find.text('完整'), findsOneWidget);
      expect(find.text('不完整'), findsNothing);
      expect(find.text('文件内容'), findsOneWidget);
      expect(find.text('共 30 条'), findsOneWidget);
      expect(find.text('积分流水'), findsOneWidget);
      expect(find.text('12 条'), findsOneWidget);
      expect(find.textContaining('family-export-child-1-'), findsOneWidget);
      expect(
        find.textContaining('导出不受同意状态限制'),
        findsOneWidget,
        reason: '撤回同意后仍可导出（04 §5 可携带权）——面板要把这点说出来',
      );

      await tester.tap(find.text('复制 JSON'));
      await tester.pumpAndSettle();

      expect(copied, transport.exportBody);
      expect(
        copied,
        jsonEncode(exportJson()),
        reason: '复制的必须是服务端原文，不是本地模型重新序列化的结果',
      );

      // 复制提示里的「大小」要按**真实 UTF-8 字节**算：`rawJson.length` 是
      // UTF-16 码元数（中文按 1 计），会把含中文昵称的文件说小一圈。
      final String trueSize = _sizeText(utf8.encode(copied!).length);
      expect(
        find.text('已复制导出文件（$trueSize，共 30 条）'),
        findsOneWidget,
        reason: '提示里的大小必须是 UTF-8 字节数，不是字符串长度',
      );
      expect(
        _sizeText(copied!.length),
        isNot(trueSize),
        reason: '这份夹具含中文，字符数 ≠ 字节数 —— 否则这条断言什么也验不出来',
      );
    });

    testWidgets('孩子：只显示「找家长」，且**不**发导出请求',
        (WidgetTester tester) async {
      final _ExportTransport transport = _ExportTransport(
        memberRole: 'child',
        exportBody: jsonEncode(exportJson()),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await pumpSheet(tester, store);

      expect(store.canExportFamilyData, isFalse);
      expect(
        transport.exportCalls,
        0,
        reason: '矩阵 export_family_data child DENY：明知会 403 就不要探测',
      );
      expect(find.text('只有家长可以导出家庭数据'), findsOneWidget);
      expect(find.textContaining('不能导出家庭数据'), findsOneWidget);
      expect(find.text('复制 JSON'), findsNothing);
      expect(find.text('文件内容'), findsNothing);
    });

    testWidgets('被截断：不完整与「已截断」必须写在明面上',
        (WidgetTester tester) async {
      final _ExportTransport transport = _ExportTransport(
        exportBody: jsonEncode(exportJson(
          counts: const <String, int>{'records': 500, 'habits': 3},
          totals: const <String, int>{'records': 1200},
          truncated: true,
          truncatedSections: const <String>['records'],
        )),
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await pumpSheet(tester, store);

      expect(find.text('不完整'), findsOneWidget);
      expect(find.text('500 / 1200 条（已截断）'), findsOneWidget);
      expect(find.textContaining('这份文件不是全量'), findsOneWidget);
      expect(find.text('共 503 条'), findsOneWidget);
    });

    testWidgets('403 显示「生成失败」而不是「没有数据」',
        (WidgetTester tester) async {
      final _ExportTransport transport = _ExportTransport(
        exportStatus: 403,
        exportBody:
            '{"code":"FORBIDDEN","message":"缺少 export_family_data 权限"}',
      );
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await pumpSheet(tester, store);

      expect(find.text('生成导出文件失败'), findsOneWidget);
      expect(find.textContaining('403'), findsOneWidget);
      expect(find.text('重试'), findsOneWidget);
      expect(
        find.textContaining('还没有开始生成导出文件'),
        findsNothing,
        reason: '失败不能画成「还没开始」',
      );
    });
    testWidgets('刷新失败：错误与「上一次的文件」必须同时出现，不许静默',
        (WidgetTester tester) async {
      final _ExportTransport transport =
          _ExportTransport(exportBody: jsonEncode(exportJson()));
      final AppStore store = AppStore(
        readApi: ReadApiClient(config: config, transport: transport),
      );
      addTearDown(store.dispose);

      await pumpSheet(tester, store);
      expect(find.text('小明 的数据'), findsOneWidget);
      expect(find.text('生成导出文件失败'), findsNothing);

      transport.exportStatus = 403;
      transport.exportBody =
          '{"code":"FORBIDDEN","message":"缺少 export_family_data 权限"}';

      await tester.tap(find.text('重新生成'));
      await tester.pumpAndSettle();

      expect(transport.exportCalls, 2);
      expect(find.text('生成导出文件失败'), findsOneWidget);
      expect(find.textContaining('403'), findsOneWidget);
      expect(
        find.textContaining('上一次成功生成的文件'),
        findsOneWidget,
        reason: '旧文件还在就必须标清它是哪一次生成的，不能让它冒充新副本',
      );
      expect(
        find.text('小明 的数据'),
        findsOneWidget,
        reason: '刷新失败不能把刚复制过的文件说成「没有文件」',
      );
      expect(find.text('复制 JSON'), findsOneWidget);
    });
  });
}

/// 与面板里 `_sizeText` 同口径的格式化（只在用例里复算预期文案）。
String _sizeText(int bytes) {
  if (bytes < 1024) return '$bytes B';
  final double kb = bytes / 1024;
  if (kb < 1024) return '${kb.toStringAsFixed(1)} KB';
  return '${(kb / 1024).toStringAsFixed(1)} MB';
}

/// `GET /members` + `GET /export` 的假传输层。
///
/// [gate] 非 null 时 `/export` 会挂住，用于验证单飞（第二次点击不发请求）。
class _ExportTransport implements ReadTransport {
  _ExportTransport({
    this.memberRole = 'guardian',
    this.exportBody = '{}',
    this.exportStatus = 200,
    this.gate,
  });

  final String memberRole;
  String exportBody;
  int exportStatus;
  Completer<void>? gate;

  int exportCalls = 0;
  int memberCalls = 0;

  String get _membersJson => jsonEncode(<String, Object?>{
        'items': <Object?>[
          <String, Object?>{
            'memberId': 'm-self',
            'userId': 'u-self',
            'displayName': memberRole == 'guardian' ? '妈妈' : '小明',
            'role': memberRole,
            'status': 'active',
            'joinedAt': '2026-10-01T10:00:00.000Z',
            'removedAt': null,
            'isSelf': true,
          },
        ],
      });

  @override
  Future<ReadHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
  ) async {
    if (uri.path.endsWith('/members')) {
      memberCalls += 1;
      return ReadHttpResponse(statusCode: 200, body: _membersJson);
    }
    if (uri.path.endsWith('/export')) {
      exportCalls += 1;
      final Completer<void>? waiting = gate;
      if (waiting != null) await waiting.future;
      return ReadHttpResponse(statusCode: exportStatus, body: exportBody);
    }
    return ReadHttpResponse(statusCode: 404, body: '{"code":"NOT_FOUND"}');
  }

  @override
  void close() {}
}
