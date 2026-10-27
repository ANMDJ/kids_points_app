import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/app_scope.dart';
import '../../data/app_store.dart';
import '../../data/read_api_errors.dart';
import '../../models/family_export.dart';
import '../../theme/app_colors.dart';
import '../../widgets/app_card.dart';
import '../../widgets/pills.dart';
import '../../widgets/sheet_frame.dart';

/// 打开「导出家庭数据」面板（W7-C）—— 入口固定在「我的」页。
Future<void> showExportSheet(BuildContext context) async {
  final AppStore store = AppScope.of(context);
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) {
      return ExportSheet(store: store, messenger: messenger);
    },
  );
}

/// 家庭数据导出（W7-C）：家长把孩子的全部数据带走。
///
/// ── 这个面板要回答的两个问题 ────────────────────────────────────────────────
///   ① **文件里有什么**：九个段的条数（`summary.counts`），以及总行数；
///   ② **文件是不是完整的**：`summary.truncated` 为 true 时，把「哪几段被
///      截断」写在最显眼的位置 —— 一份不完整的备份如果看起来完整，
///      比没有备份更糟（家长会以为数据取全了，然后把原始数据删掉）。
///
/// ── 为什么先拉成员、再拉导出 ────────────────────────────────────────────────
///   `export_family_data` 在矩阵里只有 guardian ALLOW，而客户端判断
///   「我是不是家长」只能靠 `GET /members` 里 `isSelf` 那一行。直接拉导出：
///   孩子必然吃一个 403 —— 用一次注定失败的请求探测角色，既慢又会把
///   「没有权限」画成「加载失败」。所以先 `refreshMembers()`。
///
/// ── 为什么这里不提「同意」 ──────────────────────────────────────────────────
///   导出是**读**，且在 `consent-policy` 的豁免集合里：撤回同意后
///   `ConsentGuard` 会拦写动作，但导出必须继续可用（04 §5 可携带权）。
///   面板把这句写出来，家长才不会以为「撤回 = 数据被扣住」。
class ExportSheet extends StatefulWidget {
  const ExportSheet({super.key, required this.store, required this.messenger});

  final AppStore store;
  final ScaffoldMessengerState messenger;

  @override
  State<ExportSheet> createState() => _ExportSheetState();
}

class _ExportSheetState extends State<ExportSheet> {
  /// 有请求（成员 / 导出）在途。
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    // 等首帧之后再拉：`refreshMembers` / `loadExport` 一开始就会 `_notify()`，
    // 在 initState 里同步调用等于 build 期间 setState。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _bootstrap();
    });
  }

  Future<void> _bootstrap() async {
    final AppStore store = widget.store;
    setState(() => _busy = true);
    if (store.isLiveMode && store.selfMember == null) {
      await store.refreshMembers();
    }
    if (!mounted) return;
    if (store.canExportFamilyData) {
      await store.loadExport();
    }
    if (!mounted) return;
    setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final bool canExport = widget.store.canExportFamilyData;
    return SheetFrame(
      title: '导出家庭数据',
      subtitle: canExport
          ? '把这一个孩子的全部数据导成一份 JSON 文件'
          : '只有家长可以导出家庭数据',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: _body(canExport),
      ),
    );
  }

  List<Widget> _body(bool canExport) {
    final AppStore store = widget.store;
    if (!store.isLiveMode) {
      // 预览模式的数据是演示用的，不存在「服务端的这份文件」——
      // 编一份 JSON 给家长下载会让人以为真实数据已经备份。
      return <Widget>[
        _hint('预览模式没有真实的家庭数据，这里没有可导出的文件。接入后端后才能导出。'),
      ];
    }
    if (store.selfMember == null) {
      // 角色未知（成员列表没拉到 / 403 / 断网）：既不能给导出按钮，
      // 也不能说「你不是家长」—— 两种猜法都会把真实原因藏起来。
      return <Widget>[
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        const SizedBox(height: 8),
        ..._unknownRoleRows(),
      ];
    }
    if (!canExport) {
      return <Widget>[
        _hint(
          '你的身份是${store.selfMember!.roleLabel}，不能导出家庭数据。\n'
          '需要备份时，请让家里的家长在「我的 → 导出家庭数据」里操作。',
        ),
      ];
    }

    final FamilyExport? file = store.familyExport;
    if (file != null) {
      return <Widget>[
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        // 刷新失败但手里还有上一次的文件：**两件事都要说**。
        // 只显示旧文件 = 家长会以为这就是刚生成的（甚至以为权限还在）；
        // 只显示错误 = 刚复制过的文件凭空消失。先报错，再标清这份文件是哪次生成的。
        if (store.exportReadStatus == ReadStatus.error) ...<Widget>[
          _errorCard(store.exportError),
          const SizedBox(height: 12),
          _hint(
            '下面是上一次成功生成的文件（${file.generatedText}），可能已经过期。'
            '刷新失败不会删掉它，但请不要把它当成刚导出的副本。',
          ),
          const SizedBox(height: 12),
        ],
        _fileCard(file),
        const SizedBox(height: 12),
        _sectionCard(file),
        const SizedBox(height: 12),
        _actions(file),
        const SizedBox(height: 4),
        _hint(
          '导出会读取孩子的档案、家庭成员、规则与版本、习惯、心愿、积分流水、'
          '审批、同意记录与审计日志。文件里不含设备标识、登录凭据或密码散列。',
        ),
        _hint('导出不受同意状态限制：即使撤回了监护人同意，也仍然可以导出这份文件。'),
      ];
    }

    if (store.exportReadStatus == ReadStatus.error) {
      return <Widget>[
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        _errorCard(store.exportError),
      ];
    }
    return <Widget>[
      const LinearProgressIndicator(minHeight: 2),
      _hint(
        store.exportReadStatus == ReadStatus.loading
            ? '正在生成导出文件…（流水与审计较多时需要几秒）'
            : '还没有开始生成导出文件。',
      ),
    ];
  }

  /// 文件头：孩子 + 生成时间 + 完整性 + 格式版本。
  Widget _fileCard(FamilyExport file) {
    final bool complete = !file.truncated;
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  '${file.childName} 的数据',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              SmallPill(label: complete ? '完整' : '不完整', filled: complete),
            ],
          ),
          const SizedBox(height: 8),
          _line(file.generatedText),
          _line('余额：${file.pointsBalance} 分'),
          _line('文件格式版本：v${file.schemaVersion}（生成方 ${file.generator}）'),
          _line('文件名：${file.fileName}'),
          if (!file.isKnownSchemaVersion) ...<Widget>[
            const SizedBox(height: 6),
            const Text(
              '这份文件来自更新版本的服务端（格式版本高于当前客户端认识的 '
              'v${FamilyExport.supportedSchemaVersion}）。文件本身可以照常复制，'
              '但当前界面可能认不全其中的字段。',
              style: TextStyle(
                fontSize: 11.5,
                height: 1.5,
                color: AppColors.pointSpend,
              ),
            ),
          ],
          if (file.truncated) ...<Widget>[
            const SizedBox(height: 6),
            Text(
              '注意：这份文件不是全量。以下段被单次导出上限截断：'
              '${file.truncatedSectionsText}。'
              '请对照「文件内容」里的条数确认缺了多少。',
              style: const TextStyle(
                fontSize: 11.5,
                height: 1.5,
                color: AppColors.pointSpend,
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 段清单：每段一行「本文件条数 / 库里全量条数」。
  Widget _sectionCard(FamilyExport file) {
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Expanded(
                child: Text(
                  '文件内容',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
              ),
              Text(
                '共 ${file.rowCount} 条',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          for (final FamilyExportSection section in file.sections)
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      section.label,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
                  Text(
                    section.countText,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: section.truncated
                          ? AppColors.pointSpend
                          : AppColors.textPrimary,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _actions(FamilyExport file) {
    final bool busy = _busy || widget.store.isExportBusy;
    return Row(
      children: <Widget>[
        Expanded(
          child: SmallPill(
            label: '复制 JSON',
            filled: true,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            onTap: busy ? null : () => _copy(file),
          ),
        ),
        const SizedBox(width: 10),
        SmallPill(
          label: '重新生成',
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
          onTap: busy ? null : _reload,
        ),
      ],
    );
  }

  Widget _errorCard(ReadApiException? error) {
    return AppCard(
      radius: 16,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Text(
            '生成导出文件失败',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            error?.userMessage ?? '导出请求失败，原因未知。请重试。',
            style: const TextStyle(
              fontSize: 12,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: SmallPill(label: '重试', onTap: _busy ? null : _reload),
          ),
        ],
      ),
    );
  }

  /// 角色未知时的说明 + 重试（与同意面板同口径）。
  List<Widget> _unknownRoleRows() {
    final AppStore store = widget.store;
    final ReadApiException? error = store.membersError;
    final bool loading =
        _busy || store.membersReadStatus == ReadStatus.loading;
    return <Widget>[
      _hint(
        loading
            ? '正在确认你的身份…'
            : '无法确认你的身份（${error?.userMessage ?? '成员列表还没拉到'}），'
                '暂时不能判断能不能导出。',
      ),
      if (!loading)
        Align(
          alignment: Alignment.centerRight,
          child: SmallPill(label: '重试', onTap: _bootstrap),
        ),
    ];
  }

  Widget _line(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Text(
        text,
        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
      ),
    );
  }

  Widget _hint(String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 12,
          height: 1.5,
          color: AppColors.textSecondary,
        ),
      ),
    );
  }

  /// 复制**原始 JSON**（不是本地模型的再序列化）：家长拿到的应当与服务端
  /// 下发的字节一致。剪贴板里放的是完整文件，不只是摘要。
  Future<void> _copy(FamilyExport file) async {
    await Clipboard.setData(ClipboardData(text: file.rawJson));
    if (!mounted) return;
    widget.messenger.hideCurrentSnackBar();
    widget.messenger.showSnackBar(
      SnackBar(
        content: Text(
          '已复制导出文件（${_sizeText(_utf8Bytes(file.rawJson))}，共 ${file.rowCount} 条）',
        ),
      ),
    );
  }

  Future<void> _reload() async {
    if (_busy || widget.store.isExportBusy) return;
    setState(() => _busy = true);
    await widget.store.loadExport();
    if (!mounted) return;
    setState(() => _busy = false);
  }

  /// 字节数 → 「12.3 KB」。只用于提示，不参与任何判断。
  String _sizeText(int bytes) {
    if (bytes < 1024) return '$bytes B';
    final double kb = bytes / 1024;
    if (kb < 1024) return '${kb.toStringAsFixed(1)} KB';
    return '${(kb / 1024).toStringAsFixed(1)} MB';
  }

  /// `String.length` 是 **UTF-16 码元数**，中文按 1 计；拿它当字节数会把
  /// 中文昵称 / 规则标题占多数的导出文件低估三分之一以上（提示写 12 KB、
  /// 实际 40 KB）。这里按码元逐个数宽度，**不额外复制**整份字符串。
  static int _utf8Bytes(String text) {
    var bytes = 0;
    for (var i = 0; i < text.length; i += 1) {
      final int code = text.codeUnitAt(i);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (code >= 0xD800 && code <= 0xDBFF) {
        bytes += 4; // 代理对：高位 + 低位共 4 字节
        i += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }
}
