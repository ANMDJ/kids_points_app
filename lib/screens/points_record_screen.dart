import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../models/point_record.dart';
import '../theme/app_colors.dart';
import '../widgets/gradient_page.dart';
import '../widgets/page_header.dart';
import '../widgets/pills.dart';
import '../widgets/record_tile.dart';

/// 积分记录：按 全部 / 表扬 / 兑换 / 调整 过滤，并按天分组（今天 / 昨天）。
class PointsRecordScreen extends StatefulWidget {
  const PointsRecordScreen({super.key});

  @override
  State<PointsRecordScreen> createState() => _PointsRecordScreenState();
}

class _PointsRecordScreenState extends State<PointsRecordScreen> {
  RecordCategory? _category;

  static const List<RecordCategory?> _filters = <RecordCategory?>[
    null,
    RecordCategory.praise,
    RecordCategory.exchange,
    RecordCategory.adjust,
  ];

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    final List<PointRecord> list = store.recordsOf(_category);

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: Column(
          children: <Widget>[
            PageHeader(
              title: '积分记录',
              onBack: () => Navigator.of(context).maybePop(),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: _filters.map((RecordCategory? category) {
                          return Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: SoftChip(
                              label: category?.label ?? '全部',
                              selected: _category == category,
                              onTap: () => setState(() => _category = category),
                            ),
                          );
                        }).toList(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '共 ${list.length} 条',
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Expanded(
              child: list.isEmpty
                  ? const _EmptyHint()
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                      children: _buildGroups(list),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _buildGroups(List<PointRecord> list) {
    final List<Widget> children = <Widget>[];
    String currentLabel = '';
    for (final PointRecord record in list) {
      final String label = dayLabel(record.time);
      if (label != currentLabel) {
        children.add(
          Padding(
            padding: EdgeInsets.only(
              top: children.isEmpty ? 0 : 8,
              bottom: 10,
            ),
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        );
        currentLabel = label;
      }
      children.add(RecordTile(record: record));
    }
    return children;
  }
}

/// 把时间转成“今天 / 昨天 / 前天 / M 月 d 日”。
String dayLabel(DateTime time) {
  final DateTime now = DateTime.now();
  final DateTime today = DateTime(now.year, now.month, now.day);
  final DateTime day = DateTime(time.year, time.month, time.day);
  final int diff = today.difference(day).inDays;
  switch (diff) {
    case 0:
      return '今天';
    case 1:
      return '昨天';
    case 2:
      return '前天';
    default:
      return '${time.month} 月 ${time.day} 日';
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text('🍃', style: TextStyle(fontSize: 40)),
          SizedBox(height: 10),
          Text(
            '这里还没有记录',
            style: TextStyle(fontSize: 13.5, color: AppColors.textSecondary),
          ),
        ],
      ),
    );
  }
}
