import 'package:flutter/material.dart';

/// 图标名 → [IconData] 的**映射表** —— 修 **D9**。
///
/// **为什么必须有这张表**：图标在数据库与小程序里存的都是**名字**
/// （后端 `PointRule.icon` / `Habit.icon` 是 `String`，小程序侧是
/// `kids_points_mp/src/components/Icon/icons.ts` 的 `IconName`），
/// 而 Flutter 侧原先把字段类型直接写成 `IconData` ——
/// 于是 `01` §3 承诺的「接 API 不改 UI」**不成立**：服务端来的 `"book"` 落不进
/// `IconData`，接 API 那一刻必须逐处改界面代码。这正是 D9
/// （见 `docs/design/03` §D9、`06-w0-report.md` §3）。
///
/// 现在的分工（四道口子，缺一条这个缺陷就还能复发）：
///   1. **数据层只存名字**：[IconNames] 的取值是**唯一**允许写进
///      `Habit.iconName` / `PointRule.iconName` / `PointRecord.iconName` 的东西
///      （`lib/models/**` 与 `lib/data/**` 里不许再出现 `IconData` / `Icons.` ——
///      由 `tools/icon-names-check.mjs` 钉死）；
///   2. **渲染时才查表**：界面拿不到可写的 `IconData` 字段，想换图标只能改这张表
///      （一处改、两端同步，与 [AppColors] 同款思路）；
///   3. **写入口做白名单校验**：[isKnownIconName] 在 `AppStore.addRule` 里被调用，
///      越界的名字**拒绝并说明原因**，不静默落库（A2 / B6 的同类教训）；
///   4. **渲染口兜底**：[fallbackIcon] —— 历史数据或服务端将来新增的名字
///      一律落到「未知」占位，界面既不会崩、也不会画个空白让人以为「本来就没图标」。
///
/// ⚠️ **名字集合是跨端契约**：本表的 [appIcons] 键集合、`icons.ts` 的 `ICONS`
/// 键集合、后端 `ICON_NAMES`（`backend/prisma/seed/templates.data.ts`）三者必须**逐字相等**。
/// 后端那份是**手抄**的（后端不能 import 小程序 TS），所以它由
/// `npm run icons:check`（`tools/icon-names-check.mjs`）与真身逐个比对 ——
/// 闸门存在的原因正是「手抄会漂移」。**新增图标 = 三处同时加，然后跑闸门。**
class IconNames {
  const IconNames._();

  // 底部导航
  static const String home = 'home';
  static const String homeFill = 'homeFill';
  static const String heart = 'heart';
  static const String heartFill = 'heartFill';
  static const String smile = 'smile';

  // 习惯 / 规则
  static const String book = 'book';
  static const String stories = 'stories';
  static const String backpack = 'backpack';
  static const String clipboard = 'clipboard';
  static const String gift = 'gift';
  static const String palette = 'palette';
  static const String music = 'music';
  static const String basketball = 'basketball';
  static const String spray = 'spray';
  static const String trophy = 'trophy';
  static const String star = 'star';
  static const String starFill = 'starFill';

  // 操作类
  static const String plus = 'plus';
  static const String minus = 'minus';
  static const String check = 'check';
  static const String pencil = 'pencil';
  static const String editNote = 'editNote';
  static const String chevronLeft = 'chevronLeft';
  static const String chevronRight = 'chevronRight';
  static const String copy = 'copy';
  static const String close = 'close';
  static const String listCheck = 'listCheck';
  static const String trash = 'trash';

  /// 兜底占位：**它也在白名单里**（`icons.ts` 的同名 SVG 是问号圈）。
  /// 把兜底放进白名单而不是另立一份，是为了让「三份名单相等」这条闸门
  /// 一句话说得清 —— 否则兜底就成了第四处需要单独对齐的东西。
  static const String unknown = 'unknown';
}

/// 名字 → Material 图标。**每个跨端名字只能在这里出现一次**
/// （同一枚字形可以对应多个名字，例如 `home` / `homeFill` 的实心与线性版）。
const Map<String, IconData> appIcons = <String, IconData>{
  IconNames.home: Icons.home_rounded,
  IconNames.homeFill: Icons.home_filled,
  IconNames.heart: Icons.favorite_border_rounded,
  IconNames.heartFill: Icons.favorite_rounded,
  IconNames.smile: Icons.sentiment_satisfied_alt_rounded,
  IconNames.book: Icons.menu_book_rounded,
  IconNames.stories: Icons.auto_stories_rounded,
  IconNames.backpack: Icons.luggage_rounded,
  IconNames.clipboard: Icons.assignment_rounded,
  IconNames.gift: Icons.redeem_rounded,
  IconNames.palette: Icons.brush_rounded,
  IconNames.music: Icons.music_note_rounded,
  IconNames.basketball: Icons.sports_basketball_rounded,
  IconNames.spray: Icons.cleaning_services_rounded,
  IconNames.trophy: Icons.emoji_events_rounded,
  IconNames.star: Icons.star_outline_rounded,
  IconNames.starFill: Icons.star_rounded,
  IconNames.plus: Icons.add_rounded,
  IconNames.minus: Icons.remove_rounded,
  IconNames.check: Icons.check_rounded,
  IconNames.pencil: Icons.edit_rounded,
  IconNames.editNote: Icons.edit_note_rounded,
  IconNames.chevronLeft: Icons.chevron_left_rounded,
  IconNames.chevronRight: Icons.chevron_right_rounded,
  IconNames.copy: Icons.content_copy_rounded,
  IconNames.close: Icons.close_rounded,
  IconNames.listCheck: Icons.playlist_add_check_rounded,
  IconNames.trash: Icons.delete_outline_rounded,
  IconNames.unknown: Icons.help_outline_rounded,
};

/// 兜底图标：**由映射表派生**，不是第二份真相 ——
/// 「未登记的名字画什么」这件事因此只有一个答案。
IconData get fallbackIcon => appIcons[IconNames.unknown]!;

/// 名字 → 图标；未登记的名字落到 [fallbackIcon]（不抛异常、不空白）。
///
/// ⚠️ 兜底是**最后一道防线**，不是常态：服务端新增图标名而客户端未升级时，
/// 界面显示「未知」占位比崩溃或空白都诚实（空白会被当成「这条规则本来就没图标」）。
IconData iconDataFor(String name) => appIcons[name] ?? fallbackIcon;

/// 名字是否在白名单内 —— 写入口（`AppStore.addRule`）用它**拒绝**非法取值。
///
/// Dart 没有字面量联合类型（对照 Taro 侧 `icon: IconName`），
/// 所以「取值只能是白名单里的名字」这件事在 Dart 里只能由
/// 「写入口校验 ＋ 渲染口兜底 ＋ 闸门（`icons:check`）」三件套保证。
bool isKnownIconName(String name) => appIcons.containsKey(name);
