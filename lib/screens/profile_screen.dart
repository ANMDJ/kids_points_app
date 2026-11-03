import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_version.dart';
import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../data/app_version_api.dart';
import '../theme/app_colors.dart';
import '../widgets/app_card.dart';
import '../widgets/gradient_page.dart';
import 'points_record_screen.dart';
import 'points_rule_screen.dart';
import 'family_join_actions.dart';
import 'session_actions.dart';
import 'onboarding_screen.dart';
import 'update_gate.dart';
import 'sheets/account_sheet.dart';
import 'sheets/consent_sheet.dart';
import 'sheets/export_sheet.dart';
import 'sheets/family_deletion_sheet.dart';
import 'sheets/invite_sheet.dart';
import 'sheets/join_family_sheet.dart';
import 'sheets/member_sheet.dart';
import 'sheets/my_applications_sheet.dart';
import 'sheets/notifications_sheet.dart';
import 'sheets/parent_mode_sheet.dart';
import 'sheets/trash_sheet.dart';

/// 我的：孩子档案 + 好习惯/奖励次数战绩 + 积分记录 / 积分规则入口。
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key, this.onOpenApprovals});

  /// 切到「审批」tab：`HomeShell` 持有下标，只有在「我的」页能打开通知面板，
  /// 「去审批」才需要一个把 tab 切过去的动作（W5-M）。
  final VoidCallback? onOpenApprovals;

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    // 修 C9：回收站入口固定在“我的”页（两端同一处）—— 入口上直接显示待处理条数。
    final int trashCount = store.trashItems().length;
    // W5-L：未读消息数（服务端下发的整份计数；0 时不画红点）。
    final int unreadNotifications = store.unreadNotificationCount;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    // W10-B：版本检查入口（`null` ⇒ 预览模式 / 未接后端，只显示当前版本）。
    final AppUpdateScope? update = AppUpdateScope.maybeOf(context);
    // P0-2：登录态下的「退出登录」。`null` ⇒ 预览模式 / 未登录，不画这一行。
    final SessionActions? sessionActions = SessionActions.maybeOf(context);
    // P0-3：登录态下的「加入家庭」。`null` ⇒ 预览模式 / 未登录，不画这一行。
    final FamilyJoinActions? joinActions = FamilyJoinActions.maybeOf(context);

    // live 模式下昵称已经接了写端点（`PATCH /child`，W5-E）、回收站也接了
    // 后端（W5-F）；只剩「恢复演示数据」是纯本地操作 —— 它若在 live 模式下
    // 执行，会拿演示数据覆盖真实数据，所以只拦它。
    bool guardReadOnly() {
      if (!store.isReadOnly) return false;
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text(store.readOnlyWriteMessage)),
      );
      return true;
    }

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 22, 20, 28),
          children: <Widget>[
            Row(
              children: <Widget>[
                GestureDetector(
                  onTap: () => _renameChild(context, store),
                  child: Container(
                    width: 62,
                    height: 62,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: const LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: <Color>[AppColors.cream, AppColors.creamDeep],
                      ),
                      border: Border.all(color: AppColors.primary, width: 2),
                    ),
                    child: const Center(
                      child: Text('🧒', style: TextStyle(fontSize: 30)),
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        store.profile.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                          color: AppColors.textPrimary,
                        ),
                      ),
                      const SizedBox(height: 6),
                      GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTap: () {
                          Clipboard.setData(
                            ClipboardData(text: store.profile.childId),
                          );
                          messenger.showSnackBar(
                            const SnackBar(content: Text('已复制孩子 ID')),
                          );
                        },
                        child: Row(
                          children: <Widget>[
                            Text(
                              'ID:${store.profile.childId}',
                              style: const TextStyle(
                                fontSize: 11.5,
                                color: AppColors.textSecondary,
                              ),
                            ),
                            const SizedBox(width: 6),
                            const Icon(
                              Icons.content_copy_rounded,
                              size: 13,
                              color: AppColors.textHint,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (update != null)
              AnimatedBuilder(
                animation: update.controller,
                builder: (BuildContext context, _) {
                  final AppVersionInfo? latest = update.controller.latest;
                  if (!update.controller.hasUpdate || latest == null) {
                    return const SizedBox.shrink();
                  }
                  return Padding(
                    padding: const EdgeInsets.only(top: 14),
                    child: _UpdateBanner(
                      version: latest.latestVersion,
                      onTap: () => unawaited(update.onCheckManually()),
                    ),
                  );
                },
              ),
            const SizedBox(height: 20),
            _StatsCard(
              goodHabitCount: store.profile.goodHabitCount,
              rewardCount: store.profile.rewardCount,
            ),
            const SizedBox(height: 16),
            AppCard(
              radius: 20,
              padding: EdgeInsets.zero,
              child: Column(
                children: <Widget>[
                  _MenuRow(
                    icon: Icons.menu_book_rounded,
                    color: AppColors.primaryDeep,
                    label: '积分记录',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const PointsRecordScreen(),
                      ),
                    ),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.emoji_events_rounded,
                    color: AppColors.starYellow,
                    label: '积分规则',
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const PointsRuleScreen(),
                      ),
                    ),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.assignment_outlined,
                    // W5-J：我提交过的申请 + 撤回。与家长收件箱是**两个**
                    // 入口：这里孩子也有，且动作是撤回而不是批 / 拒。
                    color: AppColors.primaryDeep,
                    label: '我的申请',
                    onTap: () => showMyApplicationsSheet(context),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.notifications_none_rounded,
                    // W5-L：站内通知中心。审批出结果时服务端会给申请人写一条，
                    // W5-M 起有人提交申请时也会给家长写一条；未读数由
                    // `unreadNotificationCount` 下发的整份计数决定。
                    color: AppColors.starYellow,
                    label: '消息',
                    badgeCount: unreadNotifications,
                    onTap: () => showNotificationSheet(
                      context,
                      onOpenApprovals: onOpenApprovals,
                    ),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.groups_rounded,
                    color: AppColors.primaryDeep,
                    label: '家庭成员',
                    onTap: () {
                      // W5-H：成员列表 / 改角色 / 移出都由服务端判定；
                      // 孩子也能看列表（矩阵 `view_members`），写入口按角色隐藏。
                      showMemberSheet(context);
                    },
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.confirmation_number_rounded,
                    color: AppColors.starYellow,
                    label: '邀请码',
                    onTap: () {
                      // W5-I：生成 / 列表 / 吊销都由服务端判定（`invite_member`
                      // 仅家长 ALLOW）。孩子点进来只看到「找家长要」的说明 ——
                      // 面板内部先确认角色，不会先吃一个必然的 403。
                      showInviteSheet(context);
                    },
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  // P0-3：加入另一个家庭（`POST /invites/accept`）。
                  // 与「邀请码」相反的方向：那一行是**发**码，这一行是**收**码。
                  // 只有真能加入时才画：`joinActions == null`（未登录/无运行期身份）
                  // 或预览模式（没配 `KP_API_BASE_URL`，点了必然得到一句"没接后端"）。
                  if (joinActions != null && store.isLiveMode) ...<Widget>[
                    _MenuRow(
                      icon: Icons.group_add_rounded,
                      color: AppColors.primaryDeep,
                      label: '加入家庭',
                      onTap: () => showJoinFamilySheet(context),
                    ),
                    const Divider(
                      height: 1,
                      thickness: 1,
                      color: AppColors.divider,
                      indent: 66,
                    ),
                  ],
                  if (store.hasParentMode) ...<Widget>[
                    _MenuRow(
                      icon: Icons.admin_panel_settings_outlined,
                      // W8-C：切家长模式（PIN 换 5 分钟）。矩阵里
                      // `switch_role_mode` 对孩子**也是** ALLOW —— PIN 才是那道门，
                      // 所以这一行在孩子设备上同样要显示：家长可以把手机接过去
                      // 自己输 PIN，不必让孩子"先登出再登录"。
                      color: AppColors.primaryDeep,
                      label: store.isParentMode ? '家长模式 · 已开启' : '家长模式',
                      onTap: () => showParentModeSheet(context),
                    ),
                    const Divider(
                      height: 1,
                      thickness: 1,
                      color: AppColors.divider,
                      indent: 66,
                    ),
                  ],
                  if (store.hasDateCodeGate && store.isDateCodeGateUnlocked)
                    ...<Widget>[
                      _MenuRow(
                        icon: Icons.lock_outline_rounded,
                        // W9-C：立刻把启动闸门锁回去。只清本地内存 —— 服务端
                        // 根本没有「已解锁」这个状态（见 app_store 里那块的边界）。
                        // 有了它，家长不必重启 App 就能验证「码到底管不管用」。
                        color: AppColors.primaryDeep,
                        label: '立即锁定入口',
                        onTap: () {
                          store.lockDateCodeGate();
                          messenger.hideCurrentSnackBar();
                          messenger.showSnackBar(
                            const SnackBar(
                              content: Text('已锁定：下次打开 App 需要重新输入验证码'),
                            ),
                          );
                        },
                      ),
                      const Divider(
                        height: 1,
                        thickness: 1,
                        color: AppColors.divider,
                        indent: 66,
                      ),
                    ],
                  if (store.hasOnboarding &&
                      (store.needsOnboarding || store.onboardingError != null))
                    ...<Widget>[
                      _MenuRow(
                        icon: Icons.auto_awesome_outlined,
                        // W8-B：引导闸门在「状态未知」时放行进首页（断网 / 403），
                        // 这里必须留一个可重试的入口；`onboarded=false` 时则是
                        // 「继续首次引导」——中途退出的家长能从这里接着走（04 §6 4.12）。
                        color: AppColors.primaryDeep,
                        label: store.needsOnboarding
                            ? '继续首次引导'
                            : '重试读取引导状态',
                        onTap: () => _openOnboarding(context, store),
                      ),
                      const Divider(
                        height: 1,
                        thickness: 1,
                        color: AppColors.divider,
                        indent: 66,
                      ),
                    ],
                  _MenuRow(
                    icon: Icons.verified_user_outlined,
                    // W7-B：监护人同意（查看 / 作出 / 撤回）。矩阵里
                    // `view_consent` / `manage_consent` 仅家长 ALLOW ——
                    // 面板内部先确认角色，孩子点进来只看到「找家长」说明，
                    // 不会先用一次必然 403 的请求去「探测」身份。
                    color: AppColors.primaryDeep,
                    label: '监护人同意',
                    onTap: () => showConsentSheet(context),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.file_download_outlined,
                    // W7-C：家庭数据导出（可携带权，04 §5）。矩阵里
                    // `export_family_data` 仅家长 ALLOW —— 面板内部先确认
                    // 角色，孩子点进来只看到「找家长」说明。
                    // 它与「监护人同意」是两件事：导出不受同意状态限制，
                    // 撤回同意后仍然可用。
                    color: AppColors.primaryDeep,
                    label: '导出家庭数据',
                    onTap: () => showExportSheet(context),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.delete_forever_outlined,
                    // W7-D：家庭数据删除（可删除权，02 §9.20）。矩阵里
                    // `view/manage_family_deletion` 仅家长 ALLOW —— 面板内部先
                    // 确认角色，孩子点进来只看到「找家长」说明。
                    // 它与同意状态无关：撤回同意后仍然可以删（04 §5）。
                    color: AppColors.pointSpend,
                    label: '删除家庭数据',
                    onTap: () => showFamilyDeletionSheet(context),
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  _MenuRow(
                    icon: Icons.delete_outline_rounded,
                    color: AppColors.pointSpend,
                    label: trashCount > 0 ? '回收站（$trashCount）' : '回收站',
                    onTap: () {
                      // W5-F：live 模式下回收站已经接了后端（`GET /trash` +
                      // 恢复 / 彻底删除），不再整入口拦截 —— 孩子也能看
                      // （矩阵 `view_trash`），恢复 / 彻底删除由服务端按角色判。
                      showTrashSheet(context);
                    },
                  ),
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: AppColors.divider,
                    indent: 66,
                  ),
                  AnimatedBuilder(
                    // `update == null`（预览 / 未接版本服务）时用一条永不变化的
                    // 动画占位：仍然渲染同一行，只是没有「有新版本」的状态。
                    animation: update?.controller ??
                        const AlwaysStoppedAnimation<double>(0),
                    builder: (BuildContext context, _) {
                      final AppVersionInfo? latest = update?.controller.latest;
                      final bool hasUpdate =
                          update?.controller.hasUpdate == true && latest != null;
                      return _MenuRow(
                        icon: Icons.system_update_alt_rounded,
                        color: AppColors.primaryDeep,
                        // 有新版时这一行**直接写待办**（「发现新版本 vX · 点此更新」），
                        // 而不是让用户先点一次「检查更新」才知道有没有。
                        label: hasUpdate
                            ? '发现新版本 v${latest.latestVersion} · 点此更新'
                            : '检查更新（$kAppVersionLabel）',
                        onTap: () {
                          // W10-B：与启动检查共用同一个控制器（`UpdateGate` 注入）。
                          // 预览模式没有版本服务 ⇒ 只告诉用户当前版本，不假装在查。
                          if (update == null) {
                            messenger.showSnackBar(
                              SnackBar(
                                content: Text('当前版本 $kAppVersionLabel（未接版本服务）'),
                              ),
                            );
                            return;
                          }
                          unawaited(update.onCheckManually());
                        },
                      );
                    },
                  ),
                  // P0-2b：登录账号（绑定 / 换绑手机号邮箱、设置 / 修改密码）。
                  // 只有「已接后端且已登录」时才画 —— 预览模式没有账号这回事，
                  // 画一个点了报错的入口比没有入口更糟（与下面的退出登录同判据）。
                  if (sessionActions?.authApi != null) ...<Widget>[
                    const Divider(
                      height: 1,
                      thickness: 1,
                      color: AppColors.divider,
                      indent: 66,
                    ),
                    _MenuRow(
                      icon: Icons.badge_outlined,
                      color: AppColors.primaryDeep,
                      // 文案不写「绑定」：有些人已经绑过，只是来改密码。
                      label: '登录账号',
                      onTap: () => showAccountSheet(context),
                    ),
                  ],
                  // P0-2：退出登录 —— 只有在**真的能退**（闸门提供了动作）时才画。
                  // 它是「换账号」的唯一入口：注册填错手机号、或想把 App 交给
                  // 另一位家长时，没有这一行就只能清 App 数据。
                  if (sessionActions != null) ...<Widget>[
                    const Divider(
                      height: 1,
                      thickness: 1,
                      color: AppColors.divider,
                      indent: 66,
                    ),
                    _MenuRow(
                      icon: Icons.logout_rounded,
                      color: AppColors.textSecondary,
                      label: '退出登录',
                      onTap: () => _confirmSignOut(context, sessionActions),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 22),
            // 修 E18：生产构建下整个入口不渲染，避免暴露“清空真实数据”的能力
            if (allowDemoReset)
              Center(
                child: TextButton(
                  onPressed: () {
                    if (guardReadOnly()) return;
                    if (!store.resetToSeed()) {
                      messenger.showSnackBar(
                        const SnackBar(content: Text('正式环境不支持恢复演示数据')),
                      );
                      return;
                    }
                    messenger.showSnackBar(
                      const SnackBar(content: Text('已恢复演示数据')),
                    );
                  },
                  child: const Text(
                    '恢复演示数据',
                    style: TextStyle(
                      fontSize: 12.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// P0-2：二次确认后再退出。
  ///
  /// ── 为什么要确认 ────────────────────────────────────────────────────────────
  ///   退出后必须重新输入手机号/邮箱 + 密码（App **不存**密码，也没有短信验证码，
  ///   见 `token_store.dart` 文件头）。误触一次就等于把家长挡在门外，直到他想
  ///   起密码 —— 所以文案要同时说清「要重新登录」和「数据不会丢」。
  Future<void> _confirmSignOut(
    BuildContext context,
    SessionActions actions,
  ) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('退出登录？'),
        content: const Text(
          '退出后需要重新输入手机号/邮箱和密码才能进入。\n'
          '孩子的习惯、积分和心愿都不会丢失。',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('确认退出'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    // 退出成功后闸门会把整棵树换成登录页，这里**不要**再 setState。
    await actions.signOut();
  }

  Future<void> _renameChild(BuildContext context, AppStore store) async {
    // 在第一个 await 之前抓好 messenger：表单提交后页面可能已被弹走，
    // 之后再 `ScaffoldMessenger.of(context)` 就是拿一个已失效的 context。
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    // 刻意不用 TextEditingController：`showDialog` 的 future 在 pop 那一刻就
    // 完成了，弹层还在退场动画里继续 build TextField —— 此时 dispose 控制器会抛
    // “A TextEditingController was used after being disposed”。
    // 一个 `initialValue + onChanged` 的 TextFormField 就够，还自带状态管理。
    String draft = store.profile.name;
    final String? name = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text('修改昵称'),
          content: TextFormField(
            initialValue: store.profile.name,
            autofocus: true,
            maxLength: 16,
            onChanged: (String value) => draft = value,
            decoration: const InputDecoration(hintText: '输入新的昵称'),
          ),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(draft),
              child: const Text('保存'),
            ),
          ],
        );
      },
    );
    if (name == null) return;

    // 预览模式 ⇒ 本地改名（返回 null）；live 且已接写端点 ⇒ 真 PATCH；
    // live 但没注入写客户端 ⇒ 返回只读文案，本地档案不动。
    final String? message = await store.submitRenameChild(name);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(
      SnackBar(content: Text(message ?? '昵称已更新')),
    );
  }

  /// 打开首启引导（W8-B）。
  ///
  /// 两种入口共用一行：
  ///   · `onboarded=false` ⇒ 进引导（从第①步重新走 —— 服务端只存学段 / 关注点，
  ///     不存「上次走到第几步」，重走是刻意的：步骤不是权威状态）；
  ///   · 状态未知（断网 / 403）⇒ 只重拉一次并报告结果，**不**贸然进引导。
  Future<void> _openOnboarding(BuildContext context, AppStore store) async {
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    if (!store.needsOnboarding) {
      await store.refreshOnboarding();
      if (!context.mounted) return;
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            store.onboardingError ??
                (store.needsOnboarding
                    ? '引导还没完成，可以点「继续首次引导」。'
                    : '引导状态已更新。'),
          ),
        ),
      );
      return;
    }

    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (BuildContext routeContext) => OnboardingScreen(
          onFinished: () {
            // 完成之后**弹回「我的」页**（而不是切 tab）：闸门此时已经
            // 会因为 `onboarded` 变 true 而放行，回到首页由用户自己决定。
            Navigator.of(routeContext).pop();
          },
        ),
      ),
    );
  }
}

/// 战绩卡：好习惯累计 / 奖励次数。
/// 「我的」页顶部的新版本横幅（W11-B，2026-11-02）。
///
/// ── 为什么还要一个横幅 ──────────────────────────────────────────────────────
///   自动弹窗只在**启动那一刻**出现，用户点「稍后」之后就没有第二次提醒；
///   列表最后一行又要滚到底才看得到。把「有新版本」放到头像下面，
///   才是「一眼能看见」——这正是用户反馈的「看不到更新按钮」。
class _UpdateBanner extends StatelessWidget {
  const _UpdateBanner({required this.version, required this.onTap});

  final String version;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          color: AppColors.chipBg,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.primary.withValues(alpha: 0.35)),
        ),
        child: Row(
          children: <Widget>[
            const Icon(
              Icons.system_update_alt_rounded,
              size: 20,
              color: AppColors.primaryDeep,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                '发现新版本 v$version',
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textPrimary,
                ),
              ),
            ),
            const Text(
              '立即更新',
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                color: AppColors.primaryDeep,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatsCard extends StatelessWidget {
  const _StatsCard({
    required this.goodHabitCount,
    required this.rewardCount,
  });

  final int goodHabitCount;
  final int rewardCount;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      radius: 20,
      padding: const EdgeInsets.symmetric(vertical: 18),
      child: Row(
        children: <Widget>[
          Expanded(child: _StatColumn(value: '$goodHabitCount', label: '好习惯')),
          Container(width: 1, height: 38, color: AppColors.divider),
          Expanded(child: _StatColumn(value: '$rewardCount', label: '奖励次数')),
        ],
      ),
    );
  }
}

class _StatColumn extends StatelessWidget {
  const _StatColumn({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: <Widget>[
        Text(
          value,
          style: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w800,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: const TextStyle(
            fontSize: 12,
            color: AppColors.textSecondary,
          ),
        ),
      ],
    );
  }
}

/// “积分记录 / 积分规则”入口行。
class _MenuRow extends StatelessWidget {
  const _MenuRow({
    required this.icon,
    required this.color,
    required this.label,
    required this.onTap,
    this.badgeCount = 0,
  });

  final IconData icon;
  final Color color;
  final String label;
  final VoidCallback onTap;

  /// 未读角标数量（W5-L）；0 表示不画。**只**用它表达「有多少条没读」，
  /// 不要另存一个布尔值 —— 两个字段迟早互相矛盾。
  final int badgeCount;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
        child: Row(
          children: <Widget>[
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: color.withAlpha(34),
                borderRadius: BorderRadius.circular(11),
              ),
              child: Icon(icon, size: 19, color: color),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Row(
                children: <Widget>[
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w600,
                        color: AppColors.textPrimary,
                      ),
                    ),
                  ),
                  if (badgeCount > 0) ...<Widget>[
                    const SizedBox(width: 8),
                    Container(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                      constraints: const BoxConstraints(minWidth: 18),
                      decoration: BoxDecoration(
                        color: AppColors.pointSpend,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        // 99+ 之后不再精确报数：入口只需要说「有一堆没读」。
                        badgeCount > 99 ? '99+' : '$badgeCount',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 11,
                          height: 1.3,
                          fontWeight: FontWeight.w700,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const Icon(
              Icons.chevron_right_rounded,
              size: 22,
              color: AppColors.textHint,
            ),
          ],
        ),
      ),
    );
  }
}
