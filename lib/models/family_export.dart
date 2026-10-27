/// 家庭数据导出文件（`GET /export`，W7-C）。
///
/// ── 它是什么 ────────────────────────────────────────────────────────────────
///   02 §9.20 / 04 §5 的「可携带」：家长把这一个孩子的全部数据带走的**那个文件**。
///   文件本体是 `rawJson`（服务端原样下发的 JSON 文本），界面只负责把
///   「这份文件里有什么、是不是完整」说清楚 —— **不重新组装**内容。
///
///   为什么不把各段解析成模型再展示：导出文件是给家长带走的，校验它的活儿
///   应该发生在拿走以后（或后端测试里）。客户端若把它拆成九个模型，任何一次
///   后端加字段都要跟着改三处，而家长真正需要的信息只有「条数 + 是否截断」。
///
/// ── 三个诚实字段 ────────────────────────────────────────────────────────────
///   · [schemaVersion]：文件格式版本。不认识（比 [supportedSchemaVersion] 新）
///     时面板提示「文件来自更新版本」，而不是猜测字段含义；
///   · [truncated] / [truncatedSections]：`true` 时这份文件**不完整**，必须
///     写在界面最显眼的位置 —— 不能只在服务端日志里知道；
///   · [generatedAt]：文件生成时间（服务端时间），不是「刚才点的这一刻」。
class FamilyExport {
  const FamilyExport({
    required this.rawJson,
    required this.schemaVersion,
    required this.generator,
    required this.generatedAt,
    required this.childId,
    required this.childName,
    required this.pointsBalance,
    required this.counts,
    required this.totals,
    required this.truncated,
    required this.truncatedSections,
  });

  /// 客户端认识的最新文件格式版本（与后端 `EXPORT_SCHEMA_VERSION` 同口径）。
  ///
  /// 只做**上限**比较：`schemaVersion <= 1` 都能读（后端承诺字段只增不改名），
  /// 更大的版本说明文件来自更新的服务端，界面不该假装看得懂。
  static const int supportedSchemaVersion = 1;

  /// 服务端下发的原始 JSON 文本 —— 复制 / 落盘用这一份，不用重新序列化。
  final String rawJson;

  final int schemaVersion;

  /// 生成方（后端固定 `kids-points-backend`）：文件被转到别处后仍能追溯来源。
  final String generator;

  final DateTime generatedAt;

  final String childId;
  final String childName;

  /// 导出时刻的余额（与最后一条流水的 `balanceAfter` 一致）。
  final int pointsBalance;

  /// 本文件**实际包含**的条数（段名 → 条数），顺序由后端固定。
  final Map<String, int> counts;

  /// 库里**全量**条数（只含被截断保护的三张大表：records / approvals / auditLogs）。
  final Map<String, int> totals;

  /// 是否被单次导出上限截断。
  final bool truncated;

  /// 被截断的段名（空 = 完整）。
  final List<String> truncatedSections;

  /// 文件格式版本是否被本客户端认识。
  bool get isKnownSchemaVersion => schemaVersion <= supportedSchemaVersion;

  /// 这份文件一共多少行数据（各段之和，不含 `summary` 自身）。
  int get rowCount {
    int total = 0;
    for (final int value in counts.values) {
      total += value;
    }
    return total;
  }

  /// 「2026-10-27 09:30 导出」；服务端时间是 UTC，展示一律转本地。
  String get generatedText {
    final DateTime local = generatedAt.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} '
        '${two(local.hour)}:${two(local.minute)} 导出';
  }

  /// 建议文件名 —— 与后端 `Content-Disposition` 同口径（纯 ASCII，中文昵称不进文件名）。
  String get fileName {
    final DateTime local = generatedAt.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return 'family-export-$childId-'
        '${local.year}-${two(local.month)}-${two(local.day)}.json';
  }

  /// 段名 → 中文标签。**顺序**即后端 `counts` 的插入顺序（文件段顺序）。
  ///
  /// 遇到不认识的段名原样显示原名：宁可露出一个英文键，也不要把
  /// 「backend 新增了一段」这种事实藏起来。
  static const Map<String, String> sectionLabels = <String, String>{
    'members': '家庭成员',
    'rules': '积分规则',
    'habits': '好习惯',
    'wishes': '心愿',
    'records': '积分流水',
    'approvals': '审批申请',
    'consents': '同意记录',
    'auditLogs': '审计日志',
  };

  /// 界面要显示的每一行：中文段名 + 本文件条数 + （被截断时的）全量条数。
  List<FamilyExportSection> get sections {
    return <FamilyExportSection>[
      for (final MapEntry<String, int> entry in counts.entries)
        FamilyExportSection(
          key: entry.key,
          label: sectionLabels[entry.key] ?? entry.key,
          included: entry.value,
          total: totals[entry.key],
          truncated: truncatedSections.contains(entry.key),
        ),
    ];
  }

  /// 被截断的段的中文名（用于面板上的「不完整」提示）。
  String get truncatedSectionsText {
    if (truncatedSections.isEmpty) return '—';
    return truncatedSections
        .map((String key) => sectionLabels[key] ?? key)
        .join('、');
  }
}

/// 导出文件里的一段 —— 只用于展示「本文件有几条 / 库里共几条」。
class FamilyExportSection {
  const FamilyExportSection({
    required this.key,
    required this.label,
    required this.included,
    required this.total,
    required this.truncated,
  });

  /// 线格式段名（`records` 等）。
  final String key;

  /// 中文标签。
  final String label;

  /// 本文件包含的条数。
  final int included;

  /// 库里的全量条数；后端只在三张大表上下发 `totals`，其余段为 null。
  final int? total;

  /// 这一段是否被截断。
  final bool truncated;

  /// 「12 条」或「500 / 1200 条（已截断）」。
  String get countText {
    final int? full = total;
    if (truncated && full != null && full != included) {
      return '$included / $full 条（已截断）';
    }
    return '$included 条';
  }
}
