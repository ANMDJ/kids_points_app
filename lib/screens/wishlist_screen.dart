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
                                onRedeem: () {
                                  if (store.isReadOnly) {
                                    messenger.hideCurrentSnackBar();
                                    messenger.showSnackBar(
                                      SnackBar(
                                          content:
                                              Text(store.readOnlyWriteMessage)),
                                    );
                                    return;
                                  }
                                  final bool ok = store.redeem(wish);
                                  messenger.hideCurrentSnackBar();
                                  messenger.showSnackBar(
                                    SnackBar(
                                      content: Text(
                                        ok
                                            ? '兑换成功：${wish.title}'
                                            : '积分还不够，继续加油打卡吧！',
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
                      if (store.isReadOnly) {
                        messenger.hideCurrentSnackBar();
                        messenger.showSnackBar(
                          SnackBar(content: Text(store.readOnlyWriteMessage)),
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

  Future<void> _confirmRemove(
    BuildContext context,
    AppStore store,
    ScaffoldMessengerState messenger,
    Wish wish,
  ) async {
    if (store.isReadOnly) {
      messenger.hideCurrentSnackBar();
      messenger.showSnackBar(
        SnackBar(content: Text(store.readOnlyWriteMessage)),
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
      store.removeWish(wish);
      messenger.showSnackBar(
        const SnackBar(content: Text('已移到回收站，90 天内可在「我的 · 回收站」恢复')),
      );
    }
  }
}
