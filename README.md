# 积分小管家（kids_points_app）

一个面向孩子的「习惯打卡 + 积分奖励」Flutter App，按设计稿 1:1 实现了 5 个页面：

| 设计稿页面 | 实现文件 | 主要交互 |
| --- | --- | --- |
| 首页（积分罐 + 今天的习惯） | `lib/screens/home_screen.dart` | 点习惯卡打卡加分、长按撤销、“记一笔”手动加减分 |
| 心愿单（甜的心愿单） | `lib/screens/wishlist_screen.dart` | 积分够→“兑换”扣分并记录；不够→“还差 N”；新增/删除心愿 |
| 我的（孩子档案 + 战绩） | `lib/screens/profile_screen.dart` | 点头像改昵称、复制 ID、进入积分记录 / 积分规则、恢复演示数据 |
| 积分记录 | `lib/screens/points_record_screen.dart` | 全部 / 表扬 / 兑换 / 调整 筛选，按 今天 / 昨天 分组 |
| 积分规则 | `lib/screens/points_rule_screen.dart` | 新增规则；长按规则可“加入今天的习惯”或删除 |

## 技术说明

- **纯 Flutter SDK 实现，零第三方依赖**：不引入 provider / intl / shared_preferences，`flutter pub get` 在离线环境也能通过。
- **状态管理**：`AppStore extends ChangeNotifier` + `AppScope extends InheritedNotifier<AppStore>`，放在 `MaterialApp` 之上，弹窗里也能取到同一个 store。
- **视觉**：所有插画都是 `CustomPainter` 手绘（积分罐、叶子装饰），emoji 作为插画元素，**不需要任何图片资源**，也不会出现资源路径报错。
- **数据持久化**：当前是内存态（重启回到演示数据）。要持久化只需在 `AppStore._persist()` 里写入
  `shared_preferences` / `sqflite`，UI 层无需改动（详见 `lib/data/app_store.dart` 注释）。
- **测试**：`test/app_test.dart` 覆盖打卡、重复打卡、撤销、加减分、兑换、筛选、新增规则以及 3 个界面冒烟用例。

## 如何运行

本目录只包含跨平台共享代码（`lib/`、`pubspec.yaml`、`test/`），平台工程目录需要由 Flutter 生成一次：

```bash
cd kids_points_app

# 1) 生成 android/ios/web/windows 等平台目录（不会覆盖已有的 lib/ 与 pubspec.yaml）
flutter create . --project-name kids_points_app --platforms=android,ios,web,windows

# 2) 拉依赖（离线环境可加 --offline）
flutter pub get

# 3) 运行（示例）
flutter run -d windows     # 桌面窗口，最快预览
flutter run -d chrome      # 浏览器
flutter run                # 连接的手机 / 模拟器
```

> 想在手机上看效果，推荐把窗口/设备宽度保持在 390~430 逻辑像素（iPhone 尺寸），布局就是设计稿的比例。

### 跑测试与静态检查

```bash
flutter analyze
flutter test
```

## 目录结构

```
lib/
├── main.dart                   # 入口：AppScope + MaterialApp
├── theme/
│   ├── app_colors.dart         # 奶油黄 + 薄荷绿色板
│   └── app_theme.dart
├── models/                     # Habit / Wish / PointRecord / PointRule / ChildProfile
├── data/
│   ├── seed_data.dart          # 演示数据（124 积分、324 好习惯、4 次奖励…）
│   ├── app_store.dart          # 状态中心：打卡 / 记一笔 / 兑换 / 规则
│   └── app_scope.dart          # InheritedNotifier 注入
├── widgets/                    # 积分罐、叶子、软按钮、胶囊、卡片、步进器等组件
└── screens/
    ├── home_shell.dart         # 底部导航（首页 / 心愿单 / 我的）
    ├── home_screen.dart
    ├── wishlist_screen.dart
    ├── profile_screen.dart
    ├── points_record_screen.dart
    ├── points_rule_screen.dart
    └── sheets/                 # 记一笔 / 新增心愿 / 新增规则 / 规则操作
```

## 交互亮点

- 积分数字变化用 `TweenAnimationBuilder` 做了一个滚动动画，打卡/兑换时孩子能直观看到分数变化。
- 打卡成功后弹出提示，长按卡片可撤销（同时移除今天的表扬流水并扣回分数）。
- 心愿卡积分不足时按钮变成灰色的“还差 N”，并实时随积分变化。
- 新增规则时可以选加分或扣分方向、图标和分值；保存后可一键加入首页习惯。
