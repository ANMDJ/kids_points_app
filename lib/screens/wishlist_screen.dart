import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../models/wish.dart';
import '../theme/app_colors.dart';
import '../widgets/floating_add_button.dart';
import '../widgets/gradient_page.dart';
import '../widgets/wish_card.dart';
import 'sheets/add_wish_sheet.dart';

/// 心愿单：甜的心愿单 + 可兑换/还差多少 + 右下角可展开的“新增心愿”。
///
/// 列表还没滚到底时，“新增心愿”收成右下角的圆形悬浮按钮；
/// 滚到底部后自动展开成整行胶囊按钮（与原来贴在底部的样子一致）。
class WishlistScreen extends StatefulWidget {
  const WishlistScreen({super.key});

  @override
  State<WishlistScreen> createState() => _WishlistScreenState();
}

class _WishlistScreenState extends State<WishlistScreen> {
  /// 悬浮按钮高度，同时也是收起时的宽度（正圆）。
  static const double _fabHeight = 52;

  /// 悬浮按钮距离屏幕右边 / 下边的距离。
  static const double _fabMargin = 20;

  /// 距离底部多少像素以内就算“已经滚到底”。
  static const double _bottomTolerance = 24;

  /// 标题栏高度：标题行在其中垂直居中，滚动区域从标题栏下方开始
  /// （不再像浮层那样压在列表上）。
  static const double _headerHeight = 56;

  final ScrollController _controller = ScrollController();

  /// 默认收起成圆形悬浮按钮；首帧布局结束后再由 [_syncExpanded] 纠正
  /// （列表很短、一进来就已经在底部时会自动展开）。
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_syncExpanded);
  }

  @override
  void dispose() {
    _controller.removeListener(_syncExpanded);
    _controller.dispose();
    super.dispose();
  }

  /// 滚到底部 → 展开成整行按钮；否则收成右下角的圆形悬浮按钮。
  void _syncExpanded() {
    if (!mounted || !_controller.hasClients) return;
    final ScrollPosition position = _controller.position;
    final bool expanded =
        position.pixels >= position.maxScrollExtent - _bottomTolerance;
    if (expanded != _expanded) {
      setState(() => _expanded = expanded);
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    // 心愿增删会改变可滚动高度，一帧结束后重新判断按钮该展开还是收起。
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncExpanded());

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: GradientPage(
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            final double available = constraints.maxWidth;
            final double expandedWidth =
                available.isFinite ? available - _fabMargin * 2 : 320;
            return Stack(
              children: <Widget>[
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    // 标题栏固定在滚动区域“上方”：不随列表滚动，也不覆盖列表内容。
                    SizedBox(
                      height: _headerHeight,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 20),
                        child: Row(
                          children: <Widget>[
                            const Text(
                              '甜的心愿单',
                              style: TextStyle(
                                fontSize: 20,
                                fontWeight: FontWeight.w800,
                                color: AppColors.textPrimary,
                              ),
                            ),
                            const SizedBox(width: 6),
                            // 设计稿 header：标题右侧是一枚「编辑」图标（非装饰星星）。
                            const Icon(
                              Icons.edit_rounded,
                              size: 18,
                              color: AppColors.starYellow,
                            ),
                            const Spacer(),
                            const Text(
                              '当前可用积分',
                              style: TextStyle(
                                fontSize: 11.5,
                                color: AppColors.textSecondary,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              '${store.points}',
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w800,
                                color: AppColors.pointGain,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    Expanded(
                      child: ListView(
                        controller: _controller,
                        // 只给底部预留悬浮按钮的位置：滚到底时最后一张卡片落在按钮上方。
                        padding: const EdgeInsets.fromLTRB(
                          20,
                          12,
                          20,
                          _fabHeight + _fabMargin,
                        ),
                        children: <Widget>[
                          GridView.builder(
                            shrinkWrap: true,
                            padding: EdgeInsets.zero,
                            physics: const NeverScrollableScrollPhysics(),
                            itemCount: store.wishes.length,
                            gridDelegate:
                                const SliverGridDelegateWithFixedCrossAxisCount(
                              crossAxisCount: 2,
                              mainAxisSpacing: 14,
                              crossAxisSpacing: 14,
                              childAspectRatio: 0.62,
                            ),
                            itemBuilder: (BuildContext context, int index) {
                              final Wish wish = store.wishes[index];
                              return WishCard(
                                wish: wish,
                                points: store.points,
                                onRedeem: () async {
                                  // 修：这里原本判的是 `store.isReadOnly`
                                  // （＝ live 即真，那是"其余写入口仍只读"的旧口径），
                                  // 于是 live 模式下点兑换只会弹"只读模式"，永远发不出
                                  // 审批请求。与新增 / 删除统一改成 `isWishWriteReadOnly`。
                                  if (store.isWishWriteReadOnly) {
                                    messenger.hideCurrentSnackBar();
                                    messenger.showSnackBar(
                                      SnackBar(
                                          content: Text(
                                              store.wishReadOnlyWriteMessage)),
                                    );
                                    return;
                                  }
                                  // 兑换要扣分 / 要打扰家长，先弹确认：
                                  // 文案由 store 给（live 是"提交申请、批准后才扣"，
                                  // 预览是"立即扣除"），取消就什么都不做。
                                  final bool confirmed = await _confirmRedeem(
                                      context, store, wish);
                                  if (!confirmed) return;
                                  // live 模式走 `POST /approvals`（兑换在矩阵里是
                                  // REQUIRE_APPROVAL）：回包 pending 时**还没有扣分**，
                                  // 所以文案必须由 store 给，不能在这里写「兑换成功」。
                                  final String? message =
                                      await store.submitRedeemWish(wish);
                                  messenger.hideCurrentSnackBar();
                                  messenger.showSnackBar(
                                    SnackBar(
                                      content: Text(
                                        message ?? '兑换成功：${wish.title}',
                                      ),
                                    ),
                                  );
                                },
                                onLongPress: () => _confirmRemove(
                                    context, store, messenger, wish),
                              );
                            },
                          ),
                          const SizedBox(height: 18)
                        ],
                      ),
                    ),
                  ],
                ),
                Positioned(
                  right: _fabMargin,
                  bottom: _fabMargin,
                  child: FloatingAddButton(
                    label: '新增心愿',
                    icon: Icons.favorite_rounded,
                    expanded: _expanded,
                    expandedWidth: expandedWidth,
                    onTap: () {
                      if (store.isWishWriteReadOnly) {
                        messenger.hideCurrentSnackBar();
                        messenger.showSnackBar(
                          SnackBar(
                              content: Text(store.wishReadOnlyWriteMessage)),
                        );
                        return;
                      }
                      showAddWishSheet(context);
                    },
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  /// 兑换前的确认弹层 —— 取消返回 false，一次请求都不发。
  ///
  /// 文案来自 `AppStore.redeemConfirmText()`：live 说「提交给家长确认，批准后才扣」，
  /// 预览说「立即扣除」。页面不自己拼句子，否则两种模式迟早说错一种。
  Future<bool> _confirmRedeem(
    BuildContext context,
    AppStore store,
    Wish wish,
  ) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text('兑换心愿'),
          content: Text(store.redeemConfirmText(wish)),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              // live 只是建审批（家长批准前不扣分），按钮就别写"兑换成功"的语气
              child: Text(store.isLiveMode ? '提交申请' : '确认兑换'),
            ),
          ],
        );
      },
    );
    return confirmed ?? false;
  }

  Future<void> _confirmRemove(
    BuildContext context,
    AppStore store,
    ScaffoldMessengerState messenger,
    Wish wish,
  ) async {
    if (store.isWishWriteReadOnly) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text(store.wishReadOnlyWriteMessage)),
      );
      return;
    }
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: const Text('移到回收站'),
          content: Text('确定要把“${wish.title}”移到回收站吗？90 天内可恢复。'),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('移到回收站'),
            ),
          ],
        );
      },
    );
    if (confirmed == true) {
      // 修 C9：删除是**软删**（移到回收站，90 天内可恢复），不是物理删除 ——
      // 历史流水的回指（wishId）因此不会指向空。
      // W5-C：live 模式走 DELETE /wishes/:id；失败时**不假装删掉了**，
      // 直接把服务端给的可读原因显示出来（例如已被别的设备删掉）。
      final String? message = await store.submitRemoveWish(wish);
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            message ?? '已移到回收站，90 天内可在「我的 · 回收站」恢复',
          ),
        ),
      );
    }
  }
}
