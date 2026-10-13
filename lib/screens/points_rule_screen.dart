import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../models/point_rule.dart';
import '../theme/app_colors.dart';
import '../widgets/gradient_page.dart';
import '../widgets/page_header.dart';
import '../widgets/rule_tile.dart';
import '../widgets/soft_button.dart';
import 'sheets/add_rule_sheet.dart';

/// 积分规则：家庭约定清单 + 新增规则。
class PointsRuleScreen extends StatelessWidget {
  const PointsRuleScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    final double bottomInset = MediaQuery.of(context).padding.bottom;

    // 长按 / 点按规则：打开操作菜单（编辑 / 加入今天的习惯 / 移到回收站）。
    // 「编辑」走的是**同一张表单**（修 C10）—— 编辑态由 AddRuleSheet 自己认得出来。
    void openRuleActions(PointRule rule) {
      showRuleActionsSheet(
        context,
        rule,
        onEdit: () => showAddRuleSheet(context, rule: rule),
      );
    }
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: Column(
          children: <Widget>[
            PageHeader(
              title: '积分规则',
              onBack: () => Navigator.of(context).maybePop(),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 4, 20, 12),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  '长按规则可编辑、加入今天的习惯，也可以移到回收站',
                  style: TextStyle(
                    fontSize: 11.5,
                    color: AppColors.textHint,
                  ),
                ),
              ),
            ),
            Expanded(
              child: store.rules.isEmpty
                  ? const Center(
                      child: Text(
                        '还没有规则，点下方按钮新增吧',
                        style: TextStyle(
                          fontSize: 13,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                      children: store.rules
                          .map(
                            (PointRule rule) => RuleTile(
                              rule: rule,
                              onTap: () => openRuleActions(rule),
                              onLongPress: () =>
                                  openRuleActions(rule),
                            ),
                          )
                          .toList(),
                    ),
            ),
            Padding(
              padding: EdgeInsets.fromLTRB(20, 8, 20, 14 + bottomInset),
              child: SoftButton(
                label: '新增规则',
                icon: Icons.menu_book_rounded,
                onTap: () => showAddRuleSheet(context),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
