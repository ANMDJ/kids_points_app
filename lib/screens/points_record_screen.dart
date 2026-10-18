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
  static const List<RecordCategory?> _filters = <RecordCategory?>[
    null,
    RecordCategory.praise,
    RecordCategory.exchange,
    RecordCategory.adjust,
  ];

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    // ★ live 模式下列表**已经**是服务端按分类过滤后的结果；
    //   再按 `recordFilter` 过一遍只会把后面的页漏掉（见 AppStore.visibleRecords）。
    final List<PointRecord> list = store.visibleRecords;
    final bool live = store.isLiveMode;

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
                              selected: store.recordFilter == category,
                              onTap: () => store.setRecordFilter(category),
                            ),
                          );
                        }).toList(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    live && store.hasMoreRecords
                        ? '已加载 ${list.length} 条'
                        : '共 ${list.length} 条',
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
              child: _buildBody(store, list),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(AppStore store, List<PointRecord> list) {
    final bool firstLoad =
        store.isLiveMode && store.readStatus == ReadStatus.loading;
    if (firstLoad && list.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (list.isEmpty) {
      final Widget empty =
          _EmptyHint(failed: store.isLiveMode && store.readError != null);
      if (!store.isLiveMode) return empty;
      // 空态也要能下拉刷新：查看失败后若连重试手势都没有，页面就成了死路。
      return RefreshIndicator(
        color: AppColors.primaryDeep,
        onRefresh: store.refreshFromServer,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: <Widget>[
            SliverFillRemaining(hasScrollBody: false, child: empty),
          ],
        ),
      );
    }

    final List<Widget> children = <Widget>[
      ..._buildGroups(list),
      if (store.isLiveMode) _buildFooter(store, list.length),
    ];

    final Widget listView = ListView(
      // 短列表也能下拉刷新：否则「加载失败后只剩几条」时手势会失效。
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
      children: children,
    );
    // 下拉刷新只在 live 模式有意义；预览模式的 `refreshFromServer` 是空操作。
    return store.isLiveMode
        ? RefreshIndicator(
            color: AppColors.primaryDeep,
            onRefresh: store.refreshFromServer,
            child: listView,
          )
        : listView;
  }

  /// 双向「加载更多」的**服务端一半**：游标原样回传，不用 offset。
  Widget _buildFooter(AppStore store, int loaded) {
    if (store.readStatus == ReadStatus.loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 18),
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );
    }

    if (store.hasMoreRecords) {
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Center(
          child: TextButton(
            onPressed: store.loadMoreRecords,
            child: Text(
              store.readStatus == ReadStatus.error ? '重试加载更多' : '加载更多',
            ),
          ),
        ),
      );
    }

    if (loaded == 0) return const SizedBox(height: 12);
    return const Padding(
      padding: EdgeInsets.only(top: 16),
      child: Center(
        child: Text(
          '没有更多了',
          style: TextStyle(fontSize: 11.5, color: AppColors.textHint),
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
  const _EmptyHint({this.failed = false});

  final bool failed;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Text(failed ? '⚠️' : '🍃', style: const TextStyle(fontSize: 40)),
          const SizedBox(height: 10),
          Text(
            failed ? '没有可展示的记录\n请查看上方提示后重试' : '这里还没有记录',
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 13.5,
              height: 1.5,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}
