import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../data/read_api_errors.dart';
import '../theme/app_colors.dart';

/// 只读数据状态的**全局**横条（W4-B）。
///
/// 三条硬约束：
///   ① 只在 `store.isLiveMode` 时出现 —— 本地预览不打扰用户；
///   ② 失败时**明确说出现在看到的是哪份数据**（空态 / 旧的服务端数据），
///      不能把 501/401 显示成「暂无记录」；
///   ③ 只读就说只读 —— 写客户端没就绪时不能让用户以为操作已经保存。
///   ★ 2026-11-10（用户第 8 条）：**成功态**的那行常驻文案
///      （「数据来自服务器 · 打卡 / 记一笔 / 兑换 / 昵称均会实时保存」）已删除 ——
///      它只是在说「一切正常」，正式版却天天占着抬头栏一行。
///      现在只有**读取失败**（① / ②）与**首次读取中**才出现横条。
class ReadStatusBanner extends StatelessWidget {
  const ReadStatusBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    if (!store.isLiveMode) return const SizedBox.shrink();

    final Widget content;
    final ReadApiException? error = store.readError;

    if (store.readStatus == ReadStatus.error && error != null) {
      final String retained;
      if (store.usingPreview) {
        // live 模式首次读取成功前**没有**预览种子可展示（首启是空态），
        // 说成“仍是本地预览数据”会让人以为屏幕上那些 0 是演示数据。
        retained = '首次读取尚未成功，当前没有可展示的数据（不是「没有记录」）。';
      } else if (store.records.isEmpty) {
        retained = '当前没有可展示的记录，请重试。';
      } else {
        retained = '已加载的内容保留在下方，可以继续查看。';
      }
      content = _Banner(
        background: const Color(0xFFFFF1E8),
        foreground: const Color(0xFF9A4B1E),
        icon: Icons.error_outline_rounded,
        text: '${error.userMessage}\n$retained',
        action: TextButton(
          onPressed: () => store.refreshFromServer(),
          style: TextButton.styleFrom(
            foregroundColor: const Color(0xFF9A4B1E),
            padding: const EdgeInsets.symmetric(horizontal: 8),
            minimumSize: const Size(44, 32),
          ),
          child: const Text('重试', style: TextStyle(fontSize: 12)),
        ),
      );
    } else if (store.usingPreview) {
      content = const _Banner(
        background: AppColors.primarySoft,
        foreground: AppColors.primaryText,
        icon: Icons.cloud_download_outlined,
        text: '正在读取服务器数据…',
      );
    } else {
      // 2026-11-10（用户第 8 条）：「数据来自服务器 · 打卡 / 记一笔 / 兑换 /
      // 昵称均会实时保存」这条**常驻**提示被删掉了。
      //   理由：它不是状态，而是「一切正常」的同义词 —— 每天占着抬头栏一行，
      //   用户读不到任何新信息。真正需要看的话只在两种时候：读取失败（上面）
      //   与首次读取中（上一分支）。所以「正式版是否还会一直存在」的答案是：
      //   **不会**了；只有出错 / 首次加载才出现。
      return const SizedBox.shrink();
    }

    return SafeArea(
      bottom: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
        child: content,
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({
    required this.background,
    required this.foreground,
    required this.icon,
    required this.text,
    this.action,
  });

  final Color background;
  final Color foreground;
  final IconData icon;
  final String text;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon, size: 16, color: foreground),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                fontSize: 11.5,
                height: 1.45,
                color: foreground,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
          if (action != null) action!,
        ],
      ),
    );
  }
}
