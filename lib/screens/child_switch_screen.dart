import 'package:flutter/material.dart';

import '../data/identity_api.dart' show ChildMembership;
import '../data/read_api_errors.dart';
import '../theme/app_colors.dart';
import '../widgets/app_card.dart';
import '../widgets/gradient_page.dart';
import '../widgets/page_header.dart';

/// 切换孩子（2026-11-10，用户第 3 条：「不是允许有多个孩子吗？如何切换？」）。
///
/// ── 为什么是**整页**而不是弹窗 ──────────────────────────────────────────────
///   与 2026-11-04 的「我的申请 / 消息」同一条理由：列表要能滚、要有刷新、
///   要能显示失败原因。弹层里塞 N 个孩子 + 错误重试，最后一定被系统键盘 /
///   底部导航挤坏。
///
/// ── 动作从哪来 ──────────────────────────────────────────────────────────────
///   `loadChildren` / `switchChild` 由「我的」页在打开前从
///   `ChildSwitchActions` 取好传进来（路由查不到那个 InheritedWidget，
///   见 `child_switch_actions.dart` 文件头）。
class ChildSwitchScreen extends StatefulWidget {
  const ChildSwitchScreen({
    super.key,
    required this.loadChildren,
    required this.switchChild,
    this.currentChildId,
  });

  final Future<List<ChildMembership>> Function() loadChildren;
  final Future<String?> Function(String childId) switchChild;
  final String? currentChildId;

  @override
  State<ChildSwitchScreen> createState() => _ChildSwitchScreenState();
}

class _ChildSwitchScreenState extends State<ChildSwitchScreen> {
  List<ChildMembership>? _children;
  String? _error;
  bool _loading = true;
  String? _switching;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<ChildMembership> children = await widget.loadChildren();
      if (!mounted) return;
      setState(() {
        _children = children;
        _loading = false;
      });
    } on ReadApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.userMessage;
        _loading = false;
      });
    } on Exception catch (error) {
      if (!mounted) return;
      setState(() {
        _error = '读取孩子列表失败：$error';
        _loading = false;
      });
    }
  }

  Future<void> _select(ChildMembership child) async {
    if (_switching != null) return;
    if (child.childId == widget.currentChildId) {
      Navigator.of(context).maybePop();
      return;
    }
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    setState(() => _switching = child.childId);
    final String? failure = await widget.switchChild(child.childId);
    if (!mounted) return;
    setState(() => _switching = null);
    if (failure != null) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(SnackBar(content: Text(failure)));
      return;
    }
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(content: Text('已切换到「${child.name}」')));
    Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          children: <Widget>[
            PageHeader(
              title: '切换孩子',
              onBack: () => Navigator.of(context).maybePop(),
            ),
            const Text(
              '切换后首页、心愿单、审批都会按所选孩子重新加载。',
              style: TextStyle(
                fontSize: 12,
                height: 1.6,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: 14),
            ..._body(),
          ],
        ),
      ),
    );
  }

  List<Widget> _body() {
    if (_loading) {
      return const <Widget>[
        Padding(
          padding: EdgeInsets.symmetric(vertical: 40),
          child: Center(child: CircularProgressIndicator()),
        ),
      ];
    }
    if (_error != null) {
      return <Widget>[
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                _error!,
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.6,
                  color: AppColors.pointSpend,
                ),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(onPressed: _load, child: const Text('重试')),
              ),
            ],
          ),
        ),
      ];
    }
    final List<ChildMembership> children =
        _children ?? const <ChildMembership>[];
    if (children.isEmpty) {
      return const <Widget>[
        Text(
          '这个账号还没有任何孩子档案。',
          style: TextStyle(fontSize: 12.5, color: AppColors.textSecondary),
        ),
      ];
    }
    return <Widget>[
      for (final ChildMembership child in children)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: AppCard(
            onTap: () => _select(child),
            child: Row(
              children: <Widget>[
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: AppColors.primarySoft,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Center(
                    child: Text('🧒', style: TextStyle(fontSize: 20)),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        child.name.isEmpty ? '（未命名）' : child.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 14.5,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '我的角色：${_roleLabel(child.role)}',
                        style: const TextStyle(
                          fontSize: 11.5,
                          color: AppColors.textSecondary,
                        ),
                      ),
                    ],
                  ),
                ),
                if (_switching == child.childId)
                  const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else if (child.childId == widget.currentChildId)
                  const Icon(
                    Icons.check_circle_rounded,
                    size: 20,
                    color: AppColors.primaryDeep,
                  )
                else
                  const Icon(
                    Icons.chevron_right_rounded,
                    size: 20,
                    color: AppColors.textHint,
                  ),
              ],
            ),
          ),
        ),
    ];
  }

  static String _roleLabel(String role) => switch (role) {
        'guardian' => '家长',
        'child' => '孩子',
        'viewer' => '只读',
        _ => role,
      };
}
