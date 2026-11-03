import 'package:flutter/material.dart';

import '../models/approval.dart';
import '../models/audit.dart';
import '../models/child_profile.dart';
import '../models/consent.dart';
import '../models/family_deletion.dart';
import '../models/family_export.dart';
import '../models/habit.dart';
import '../models/invite.dart';
import '../models/kid_mode.dart';
import '../models/member.dart';
import '../models/onboarding.dart';
import '../models/parent_mode.dart';
import '../models/point_record.dart';
import '../models/point_rule.dart';
import '../models/rule_version.dart';
import '../models/trash.dart';
import '../models/wish.dart';
import '../theme/app_colors.dart';
import '../theme/app_icons.dart';
import 'seed_data.dart';
import 'onboarding_api.dart';
import 'onboarding_dto.dart';
import 'onboarding_mapper.dart';
import 'parent_mode_api.dart';
import 'parent_mode_dto.dart';
import 'parent_mode_mapper.dart';
import 'read_api.dart';
import 'read_api_errors.dart';
import 'read_dto.dart';
import 'read_mapper.dart';
import 'write_api.dart';
import 'write_api_errors.dart';
import 'write_dto.dart';

/// release / profile 构建的判定 —— **编译期常量**（等价于 `!kDebugMode`）。
///
/// 用 `bool.fromEnvironment` 直接表达，以免在纯数据层引入对 flutter/foundation 的依赖。
const bool _isReleaseBuild = bool.fromEnvironment('dart.vm.product') ||
    bool.fromEnvironment('dart.vm.profile');

/// 演示数据的**准入判据**（修 E18）。
///
/// 刻意写成纯函数：若判据只存在于 [allowDemoReset] 这个编译期常量里，
/// 测试就只能靠“碰巧跑在调试构建”才验证得到它；
/// 现在可以确定性地断言 `demoResetAllowed(isRelease: true) == false`。
bool demoResetAllowed({bool isRelease = _isReleaseBuild}) => !isRelease;

/// 是否允许“恢复演示数据”（修 E18）。
///
/// 该方法原先是**生产可达**的公开 API，“我的”页按钮直接调用 ——
/// 用户可一键清空真实数据并恢复假演示数据（124 分 / 324 好习惯 / 4 次奖励）。
/// release / profile 构建下为 false，入口在编译期被整段树摇掉。
const bool allowDemoReset = !_isReleaseBuild;

/// 只读数据的加载状态（W4-B）。
///
/// `ready` 之后仍可能 `loadingMore`（追加下一页）或 `error`（保留已加载内容）。
enum ReadStatus { idle, loading, ready, loadingMore, error }

/// 「新增心愿」的三种结局 —— 不能再用 `String?` 把「已保存」和「已提交审批」混成 null。
///
/// 背景（2026-11-03 用户实测）：孩子点「保存心愿」被服务端拦成 403
/// `APPROVAL_REQUIRED`，界面只提示「需要家长确认，这次没有保存」——
/// 但**没有生成任何审批单**，家长切回家长模式后收件箱里什么都没有。
/// 权限矩阵里 `add_wish` 对孩子本来就是 `REQUIRE_APPROVAL`：正确做法不是
/// 把入口藏起来，而是把这次操作真的落成一条审批申请。
enum WishAddStatus {
  /// 心愿已经落库（家长直接新增，或审批当场通过）。
  saved,

  /// 已提交给孩子所在的家庭，等家长在「家长审批」里处理。**还没有落库**。
  pendingApproval,

  /// 没保存，也没有提交审批；[WishAddResult.error] 是可展示原因。
  failed,
}

/// [AppStore.submitAddWish] 的返回值。
class WishAddResult {
  const WishAddResult.saved()
      : status = WishAddStatus.saved,
        error = null;

  const WishAddResult.pending()
      : status = WishAddStatus.pendingApproval,
        error = null;

  const WishAddResult.failed(String message)
      : status = WishAddStatus.failed,
        error = message;

  final WishAddStatus status;
  final String? error;

  bool get isSaved => status == WishAddStatus.saved;
  bool get isPendingApproval => status == WishAddStatus.pendingApproval;
  bool get isFailed => status == WishAddStatus.failed;
}

/// 应用状态中心：积分余额、习惯、心愿、流水、规则。
///
/// 目前是纯内存实现（会话内有效）。要落地持久化时，
/// 只需在 [_persist] 中接入 shared_preferences / sqflite 即可，UI 层无需改动。
class AppStore extends ChangeNotifier {
  /// 首启是**空态**（修 E18 第二半）。
  ///
  /// 原先构造即 `_reset()` → 应用一打开就是假数据（124 分 / 324 好习惯 /
  /// “萌新铲屎官的小可爱”）：新用户看到“我完成了 324 个好习惯”是荒谬的。
  /// seed 自此只作**测试夹具**，由 [resetToSeed] 显式载入。
  AppStore({
    ReadApiClient? readApi,
    WriteApi? writeApi,
    OnboardingApi? onboardingApi,
    ParentModeApi? parentModeApi,
  })  : _readApi = readApi,
        _writeApi = writeApi,
        _onboardingApi = onboardingApi,
        _parentModeApi = parentModeApi {
    _resetToEmpty();
  }

  /// 只读 API 客户端；为 null 表示**没有配置后端**，整个 App 用本地数据。
  ///
  /// 只有 `main()` 按 `--dart-define` 注入：测试 / 演示默认走原路径，
  /// 不会因为环境里恰好有变量就偷偷发请求。
  final ReadApiClient? _readApi;

  /// 写 API 客户端（W4-E）；与 [_readApi] 一样只在配置齐全时注入。
  /// 它只覆盖已经上线的「打卡 / 撤销」两条写入口，其它写功能仍走只读拦截。
  final WriteApi? _writeApi;

  /// 首启引导客户端（W8-B）。为 null = 不接后端（预览 / 测试夹具），
  /// 引导闸门**不启用** —— 预览模式没有服务端状态，编一个「未引导」会把人
  /// 推进一个永远完不成的流程。
  final OnboardingApi? _onboardingApi;

  /// 家长模式客户端（W8-C）。为 null = 不接后端（预览 / 测试夹具）：
  /// 「我的」页那行入口**不显示**，因为本地没有 PIN 也没有会话 TTL，
  /// 画一个点了只会失败的按钮比不画更糟。
  final ParentModeApi? _parentModeApi;

  /// 一页流水条数 —— 与后端 DTO 的上限（200）同口径，50 是「首屏够用」的折中。
  static const int _recordsPageSize = 50;

  ReadStatus _readStatus = ReadStatus.idle;
  ReadApiException? _readError;
  bool _usingPreview = true;
  bool _hasMoreRecords = false;
  String? _nextCursor;
  RecordCategory? _recordFilter;

  /// 每次「重新加载 / 切分类」都 +1；在途的旧响应据此丢弃（防串页）。
  int _readEpoch = 0;
  bool _disposed = false;

  // ─────────────────────── 家长审批收件箱（W5-D） ───────────────────────
  //
  // 与首页 / 流水**分开加载**：收件箱只有家长会打开，塞进 `refreshFromServer`
  // 会让每个孩子的首页都多付一次请求（还有 403 的风险 —— 孩子角色本来就没
  // 批准资格）。生命周期因此独立：进页面才拉，离开不清。

  /// 一页收件箱条数：比流水页小，因为每行要解析 payload 生成摘要。
  static const int _approvalsPageSize = 20;

  /// 通知页大小（与后端 `GET /notifications` 的默认值一致）。
  static const int _notificationsPageSize = 20;

  /// 后端允许的状态过滤词（`APPROVAL_STATUS_FILTERS` 同口径）。
  static const Set<String> approvalStatusFilters = <String>{
    'pending',
    'approved',
    'rejected',
    'withdrawn',
    'invalidated',
    'expired',
    'all',
  };

  final List<ApprovalInboxItem> _approvalItems = <ApprovalInboxItem>[];
  String _approvalFilter = 'pending';
  ReadStatus _approvalReadStatus = ReadStatus.idle;
  ReadApiException? _approvalError;
  bool _hasMoreApprovals = false;
  String? _nextApprovalCursor;

  /// 收件箱自己的 epoch：切状态 / 重新拉取时作废在途响应（与 [_readEpoch] 同理）。
  int _approvalEpoch = 0;

  /// 正在提交判定的那条 id；非 null 时界面禁用所有按钮（防双击 / 防串批）。
  String? _decidingApprovalId;

  /// 写请求串行化：防止双击把同一动作提交两次，也防止“撤销”与“打卡”交叉。
  bool _writeInFlight = false;

  // ─────────────────────── 回收站（W5-F） ───────────────────────
  //
  // 只存**事实**：服务端下发的 `deletedAt`。`expired` 每次读时用
  // `isTrashExpired` 现算 —— 缓存一个"是否过期"的布尔值，页面开着
  // 跨过第 90 天就会说谎。

  final List<TrashItem> _trashItems = <TrashItem>[];
  ReadStatus _trashReadStatus = ReadStatus.idle;
  ReadApiException? _trashError;

  /// 回收站自己的 epoch：重复进入 / 手动刷新时作废在途响应（与 [_readEpoch] 同理）。
  int _trashReadEpoch = 0;

  // ─────────────────────── 家庭成员（W5-H） ───────────────────────
  //
  // 与回收站同策略：**进「成员」面板才拉**（`refreshMembers`），首页刷新不带
  // 这次请求 —— 成员列表是低频数据，不该让每个孩子每次刷新都多付一次往返。
  //
  // 只存服务端下发的**事实**（角色 / 状态 / `isSelf`）；「我能不能改」由
  // [canManageMembers] 从 `isSelf` 那一行现算，缓存成布尔值会在角色变化后说谎。

  final List<FamilyMember> _members = <FamilyMember>[];
  ReadStatus _membersReadStatus = ReadStatus.idle;
  ReadApiException? _membersError;

  /// 成员列表自己的 epoch：重复打开面板 / 手动刷新时作废在途响应。
  int _membersReadEpoch = 0;

  /// 正在提交改角色 / 移出的成员 id；非 null 时面板禁用该行按钮（防双击）。
  String? _busyMemberId;

  // ─────────────────────── 邀请码（W5-I） ───────────────────────
  //
  // 与成员列表同策略：**打开邀请码面板时才拉**（`refreshInvites`）。
  // 邀请码是低频、且**只有家长能看**（`invite_member` guardian ALLOW）——
  // 首页刷新带上它，孩子每次刷新都要吃一个 403。
  //
  // 列表里存的只是服务端事实（次数 / 有效期 / `revoked`），「还能不能用」
  // 由 `InviteCode.statusAt(now)` 现算：把 `expired` 缓存成字段，面板开着
  // 跨过有效期就会说谎。

  final List<InviteCode> _invites = <InviteCode>[];
  ReadStatus _invitesReadStatus = ReadStatus.idle;
  ReadApiException? _invitesError;

  /// 邀请码列表自己的 epoch：重复打开面板 / 手动刷新时作废在途响应。
  int _invitesReadEpoch = 0;

  /// 正在吊销的邀请码 id；非 null 时该行按钮禁用（防双击）。
  String? _busyInviteId;

  /// 是否正在生成邀请码（提交期间禁用「生成」按钮，避免连点产生一屏废码）。
  bool _creatingInvite = false;

  // ─────────────────────── 监护人同意（W7-B，服务端） ───────────────────────
  //
  // 与成员列表同策略：**打开同意面板 / 我的页时才拉**（`refreshConsent`）。
  // `GET /consent` 是 guardian 专属（孩子 403），因此不能塞进首页刷新 ——
  // 孩子每次下拉都会吃一个 403。
  //
  // 存的是服务端事实（状态 / 同意时版本 / 两个时间点）；「能不能改」由
  // `canManageConsent` 从成员列表那一行现算 —— 与邀请码同一条判据。

  GuardianConsent _consent = GuardianConsent.unknown;
  ReadStatus _consentReadStatus = ReadStatus.idle;
  ReadApiException? _consentError;

  /// 同意状态的 epoch：重复打开面板 / 手动刷新时作废在途响应。
  int _consentReadEpoch = 0;

  /// 是否正在提交同意 / 撤回（两个按钮互斥，防双击）。
  bool _consentWriteBusy = false;

  // ─────────────────────── 家庭数据导出（W7-C，服务端） ───────────────────────
  //
  // 与同意面板同策略：**打开导出面板时才拉**（`loadExport`）。`GET /export`
  // 是 guardian 专属（矩阵 `export_family_data` child DENY），塞进首页刷新
  // 会让每个孩子每次下拉都吃一个 403。
  //
  // 与同意**不同**的一点：导出**不受** `ConsentGuard` 管辖 —— 撤回同意后
  // 仍然必须可用（04 §5 的可携带权）。所以这里没有任何「同意生效中」前置判断，
  // 缓存也不需要随同意状态失效。
  //
  // 存的是一份完整文件（含 `rawJson`）：家长点「复制」时复制的必须是服务端
  // 下发的原始字节，而不是按本地模型重新拼出来的近似物。

  FamilyExport? _familyExport;
  ReadStatus _exportReadStatus = ReadStatus.idle;
  ReadApiException? _exportError;

  /// 是否正在下载导出文件（按钮据此禁用，防连点下载出两份时间不同的文件）。
  bool _exportBusy = false;

  // ─────────────────────── 家庭数据删除（W7-D，服务端） ───────────────────────
  //
  // 与导出同一策略：**打开删除面板时才拉**（`loadFamilyDeletion`）。
  // 删除状态是 guardian 专属（矩阵两个动作 child DENY），塞进首页刷新
  // 会让每个孩子每次下拉都吃一个 403。
  //
  // 与导出的另一个共同点：删除**不受** `ConsentGuard` 管辖 —— 撤回同意后
  // 仍必须能删（否则「撤回」等于「数据被扣住」）。这里同样**不读** `_consent`。
  //
  // 状态是服务端事实（`scheduledFor` / `daysRemaining` / `summary`）：
  // 客户端不用本地时钟算倒计时，也不重算「删了多少行」。
  FamilyDeletion? _familyDeletion;
  ReadStatus _deletionReadStatus = ReadStatus.idle;
  ReadApiException? _deletionError;

  /// 是否正在提交申请 / 撤销（两个按钮互斥，防双击）。
  bool _deletionBusy = false;

  /// 读状态请求的代际（与同意同一手法：旧响应不得覆盖新响应）。
  int _deletionReadEpoch = 0;

  // ─────────────────────── 站内通知（W5-L，服务端） ───────────────────────
  //
  // 与成员 / 邀请码同策略：**打开通知面板时才拉**（`refreshNotifications`）。
  // 通知是每个角色都有的低频数据，但把它塞进首页刷新会让每次下拉都多付
  // 一次往返；红点另走 `refreshUnreadNotificationCount()`（只取 1 条）。
  //
  // 存的是**服务端事实**（`readAt` / `createdAt`），未读由
  // `NotificationDto.isUnread` 现算 —— 缓存成布尔值会在标记已读后说谎。

  final List<NotificationDto> _notifications = <NotificationDto>[];
  ReadStatus _notificationsReadStatus = ReadStatus.idle;
  ReadApiException? _notificationsError;

  /// 通知列表自己的 epoch：重复打开面板 / 手动刷新时作废在途响应。
  int _notificationsReadEpoch = 0;

  /// 红点的 epoch：与列表分开，避免「只刷新红点」把列表的在途响应作废。
  int _notificationBadgeEpoch = 0;

  /// 下一页游标；null = 没有下一页。**原样**传回服务端，不许自己拼。
  String? _notificationsCursor;
  bool _notificationsHasMore = false;

  /// 服务端下发的**整份**未读数（不是本页未读数）。
  int _unreadNotificationCount = 0;

  /// 正在标记已读的通知 id；非 null 时该行禁用（防双击）。
  String? _busyNotificationId;
  // ------------------------------------------- 首启引导（W8-B，服务端）
  //
  // 与同意 / 导出等「面板打开才拉」的切片**不同**：引导必须在**启动时**问一次。
  // `Child.onboardedAt` 是权威状态（04 §3），客户端不许缓存 ——
  // 不拉这一下，就只能在家长已经看到空首页之后才发现「其实该走引导」。
  //
  // 但「拉失败」**不阻塞**应用：403（孩子身份 / 只读成员）与网络错误都会让
  // 闸门放行到首页 —— 否则一次断网就会把整个应用锁在「正在确认引导状态」。
  // 失败原因经 [onboardingError] 上报，「我的」页仍可手动重试 / 进入引导。
  //
  // 快照只存服务端事实；「第几步」是界面的临时状态，**不进 store、不落库**
  // （04 §3：引导只有一个权威状态）。

  /// 最近一次成功拉到的引导快照；还没拉到过时是 null（**不是**「未完成引导」）。
  OnboardingView? _onboarding;
  ReadStatus _onboardingReadStatus = ReadStatus.idle;
  String? _onboardingError;
  int _onboardingReadEpoch = 0;

  /// 是否正在提交草稿 / 完成引导 —— 界面据此禁用按钮（防双击重复采纳）。
  bool _onboardingWriteBusy = false;

  /// 最近一次「完成引导」的结果（第⑦步要显示「已采纳 N 条」）。
  OnboardingResult? _lastOnboardingResult;

  /// 完成引导后**成功加入今日习惯**的条数（扣分约定不会加）。
  int _lastOnboardingHabitCount = 0;

  /// 没能自动加入今日习惯的约定标题（扣分约定 / 单条失败）——
  /// 第⑦步必须把这些**说出来**，否则家长会以为首页该有的习惯已经全在了。
  List<String> _lastOnboardingManualTitles = <String>[];



  /// 是否接入了后端（与「当前是否已加载成功」是两件事）。
  bool get isLiveMode => _readApi != null;

  // ----------------------------------------------------- 首启引导：只读快照

  /// 引导闸门是否可用（接上了引导客户端）。
  ///
  /// 预览模式 / 只注入了读客户端的测试夹具里它是 false —— 闸门**不启用**，
  /// 界面直接进首页。绝不用「本地默认未引导」把人推进一个发不出请求的流程。
  bool get hasOnboarding => _onboardingApi != null;

  /// 最近一次拉到的引导快照；null = 还没成功拉到（**不是**「未引导」）。
  OnboardingView? get onboarding => _onboarding;

  ReadStatus get onboardingReadStatus => _onboardingReadStatus;

  /// 拉引导状态失败的原因（403 = 当前身份没有 `view_onboarding`，通常是孩子设备）。
  String? get onboardingError => _onboardingError;

  /// 是否正在提交引导草稿 / 完成引导。
  bool get isOnboardingBusy => _onboardingWriteBusy;

  /// 是否**必须**走引导：服务端明确说「未完成」。
  ///
  /// ★ 只有拿到 `onboarded: false` 才为 true。状态未知（idle / loading / error）
  ///   一律 false —— 把「不知道」当成「未引导」会让一次超时变成一场强制引导。
  bool get needsOnboarding => _onboarding?.onboarded == false;

  /// 最近一次完成引导的结果；没完成过是 null。
  OnboardingResult? get lastOnboardingResult => _lastOnboardingResult;

  /// 完成引导后成功加入今日习惯的条数。
  int get lastOnboardingHabitCount => _lastOnboardingHabitCount;

  /// 需要家长之后在「积分规则」页手动加入习惯的约定标题。
  List<String> get lastOnboardingManualTitles =>
      List<String>.unmodifiable(_lastOnboardingManualTitles);

  // ──────────────────── 家长模式 ＋ 家长 PIN（W8-C） ────────────────────
  //
  // 这里存的是**服务端事实**：`activeRole` / `parentModeExpiresAt` / `pinConfigured`。
  // 界面上的「还剩 4:57」不是状态字段，而是每次重建时用
  // [parentModeRemainingSeconds] 从绝对时刻现算的 —— 本地不放倒计时整数，
  // 就不会出现「App 切后台 3 分钟后回来，UI 还说剩 4 分半」。
  //
  // 与同意 / 导出等切片一样「打开即拉」：家长模式只在「我的」页点开面板时才需要，
  // 塞进 `refreshFromServer` 会让每个孩子的首页都多付一次请求。

  ParentMode? _parentMode;
  ReadStatus _parentModeReadStatus = ReadStatus.idle;
  String? _parentModeError;

  /// 进 / 出家长模式在途（防连点：连点两次会消耗两次 PIN 校验）。
  bool _parentModeBusy = false;

  /// 设 / 改 PIN 在途。
  bool _parentPinBusy = false;

  /// 最近一次设 / 改 PIN 的结果（面板据此说「已修改」还是「已设置」）。
  ParentPinResult? _lastParentPinResult;

  /// 最近一次 429 告诉我们「还要等多少秒」（仅用于把文案说具体）。
  int _parentPinLockSeconds = 0;

  /// 是否接入了家长模式客户端（预览模式不显示这个入口）。
  bool get hasParentMode => _parentModeApi != null;

  /// 最近一次拉到的家长模式快照；null = 还没拉过（**不是**「不在家长模式」）。
  ParentMode? get parentMode => _parentMode;

  /// 服务端判定的「这台设备此刻是不是家长模式」。
  bool get isParentMode => _parentMode?.parentMode ?? false;

  /// 当前的家长权限是**登录会话自带**的（邀请码加入的家长设备），不是 PIN 换的
  /// 5 分钟。界面据此不显示倒计时（那个 30 天会被渲染成 `43200:00`）。
  bool get isParentModeSessionBacked => _parentMode?.isSessionBacked ?? false;

  /// 当前的家长权限是**PIN 换来的 5 分钟**（只有这种才有倒计时）。
  bool get isParentModePinBacked => _parentMode?.isPinBacked ?? false;

  ReadStatus get parentModeReadStatus => _parentModeReadStatus;
  String? get parentModeError => _parentModeError;

  /// 是否已经设过家长 PIN —— 决定按钮写「输入 PIN」还是「先设置 PIN」。
  bool get isParentPinConfigured => _parentMode?.pinConfigured ?? false;

  /// 剩余可尝试次数（5 = 一次都没错；0 = 已锁定）。
  int get parentPinRemainingAttempts => _parentMode?.remainingAttempts ?? 5;

  /// 是否处于 PIN 锁定中（锁定期间后端不跑 scrypt，客户端不该再发请求）。
  bool isParentPinLockedAt(DateTime now) =>
      _parentMode?.isLockedAt(now) ?? false;

  /// 锁定还剩几秒（0 = 未锁定）。优先用服务端快照里的 `lockedUntil`，
  /// 其次用最近一次 429 的 `retryAfterSeconds`（快照可能还没刷新）。
  int parentPinLockSecondsAt(DateTime now) {
    final int fromSnapshot = _parentMode?.lockSecondsAt(now) ?? 0;
    if (fromSnapshot > 0) return fromSnapshot;
    return _parentPinLockSeconds;
  }

  bool get isParentModeBusy => _parentModeBusy;
  bool get isParentPinBusy => _parentPinBusy;
  ParentPinResult? get lastParentPinResult => _lastParentPinResult;

  /// 家长模式还剩几秒（0 = 不在家长模式 / 已到期）。
  ///
  /// 界面每帧都用它，而不是自减一个整数：手机时间不准、后台挂起都会让
  /// 自减的倒计时说谎，而服务端给的 [ParentMode.expiresAt] 是绝对时刻。
  int parentModeRemainingSeconds(DateTime now) =>
      _parentMode?.remainingSecondsAt(now) ?? 0;

  /// 孩子模式正在窗口内（W14；服务端快照）。
  bool get isKidMode => _parentMode?.kidMode ?? false;

  /// 孩子模式已到点、等家长 PIN 收回（W14；A 方案）。
  bool get isKidModeExpired => _parentMode?.kidModeExpired ?? false;

  /// 孩子模式**此刻**是否仍在窗口内（用本地时钟现算绝对时刻）。
  bool isKidModeActiveAt(DateTime now) =>
      _parentMode?.kidModeActiveAt(now) ?? false;

  /// 孩子模式是否处于「时间到了、等家长输 PIN」。
  bool isKidModeExpiredAt(DateTime now) =>
      _parentMode?.kidModeExpiredAt(now) ?? false;

  /// 孩子模式还剩几秒（向上取整；未开 / 已到期都 0）。
  int kidModeRemainingSeconds(DateTime now) =>
      _parentMode?.kidModeSecondsAt(now) ?? 0;

  // ──────────────────── 本机 PIN 锁（2026-11-04，替代 6 位日期码闸门） ────────
  //
  // ★ 它是什么：App 的**入口软锁** —— 冷启动 / 从后台回到前台要输一次家长 PIN。
  //   与「进入家长模式」是**两件事**：解锁走 `POST /auth/parent-pin/verify`，
  //   **不改变**角色 / TTL。若复用「进入家长模式」，一台以家长身份登录的设备
  //   （30 天会话）解锁几次就会被压成 5 分钟 —— 那正是用户报「家长模式怎么没了」
  //   的成因（见 `docs/design/52-app-pin-lock.md` §3）。
  //
  // ★ 它不是什么：不是认证，也不是密码学意义上的安全边界。
  //   · 值对不对只在服务端判定（库里只有 `scrypt$…`），所以**断网解不开**；
  //   · 反过来，一次都拉不到 `/auth/parent-mode`（不知道有没有 PIN）时闸门
  //     **放行** —— 软锁不该把 App 变成打不开的砖（见 `pin_guard.dart`）；
  //   · 真正的权限边界仍只有一处：服务端的矩阵 + PIN 计次 / 锁定。

  /// 本次运行（含后台往返）是否已经过 PIN 锁。构造 / 换身份时回到 false。
  bool _appUnlocked = false;

  /// 校验在途（防连点：连点两次会白烧两次失败次数）。
  bool _appLockBusy = false;

  /// 最近一次解锁失败的说明（界面原样显示）。
  String? _appLockError;

  /// 「退到后台时孩子模式正开着」⇒ 回来时若窗口已结束，要补上锁。
  bool _relockPending = false;

  /// 是否启用本机 PIN 锁（预览 / 测试夹具不启用）。
  bool get hasParentPinLock => _parentModeApi != null;

  /// 本次运行是否已经过解锁。
  bool get isAppUnlocked => _appUnlocked;

  bool get isAppLockBusy => _appLockBusy;

  String? get appLockError => _appLockError;


  /// live 模式下是否已接上写端点（W4-E：只覆盖打卡 / 撤销）。
  bool get usesServerWrites => _readApi != null && _writeApi != null;

  /// 打卡是否被只读拦截。
  ///
  /// 本地预览可以照常写（那本来就是演示）；live 但没注入写客户端时**必须拦**，
  /// 否则会改内存却不落库，用户以为已经保存。
  bool get isCheckInReadOnly => isLiveMode && _writeApi == null;

  /// 首页打卡 / 长按撤销是否可用。
  bool get canWriteCheckIns => !isCheckInReadOnly;

  /// 「记一笔」是否被只读拦截（W5-B：live 模式下 `POST /records/adjust` 早已上线）。
  ///
  /// ★ 2026-11-03 修：首页原先判的是 [isReadOnly]（`live ⇒ true`），
  /// 于是**每个连了后端的家庭**点「记一笔」都只会看到
  /// 「写客户端未就绪或尚未接后端」—— 端点明明可用。与打卡 / 心愿同一条判据：
  /// 只有 live 但**没注入写客户端**时才拦。
  bool get isAdjustReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下「记一笔」的文案 —— 页面直接展示，不另编理由。
  String get adjustReadOnlyWriteMessage =>
      '只读模式：记一笔还没有接上后端，这次操作没有保存到服务器。';

  /// 仍未接后端的本地写入口（回收站 / 恢复演示数据）是否被只读拦截。
  /// 本地预览数据不受影响，可以随便点 —— 那本来就是演示。
  ///
  /// 具体写入口不要再用它判断，各自有专属的 `is*ReadOnly`
  /// （打卡 / 规则 / 心愿 / 档案在 live 模式下都已接后端）。
  bool get isReadOnly => isLiveMode;

  /// 规则写入口是否被只读拦截（W5-A：新建 / 编辑 / 删除 / 加入习惯）。
  ///
  /// 与 [isReadOnly] 分开：live 模式下这四条已经接了后端，不该再被全局
  /// 「写入口未接」拦掉；只有**没注入写客户端**时才拦。
  bool get isRuleWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下规则写操作的文案 —— 页面直接展示，不另编理由。
  String get ruleReadOnlyWriteMessage => '只读模式：规则写入还没有接上后端，这次操作没有保存到服务器。';

  /// 心愿写入口是否被只读拦截（W5-C：新增 / 删除）。
  ///
  /// 与 [isReadOnly] 分开：live 模式下这两条已经接了后端，不该再被全局
  /// 「写入口未接」拦掉；只有**没注入写客户端**时才拦。
  bool get isWishWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下心愿写操作的文案 —— 页面直接展示，不另编理由。
  String get wishReadOnlyWriteMessage => '只读模式：心愿写入还没有接上后端，这次操作没有保存到服务器。';

  /// 档案写入口（昵称）是否被只读拦截（W5-E）。
  ///
  /// 与 [isReadOnly] 分开：live 模式下昵称已经接了后端（`PATCH /child`），
  /// 不该再被全局「写入口未接」拦掉；只有**没注入写客户端**时才拦。
  bool get isProfileWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下档案写操作的文案 —— 页面直接展示，不另编理由。
  String get profileReadOnlyWriteMessage =>
      '只读模式：昵称修改暂时写不进去（写客户端未就绪），这次没有保存到服务器。';

  // ─────────────────────── 回收站（W5-F，服务端） ───────────────────────
  //
  // 与审批收件箱同策略：**进回收站页才拉**（`refreshTrash`）。首页 / 流水
  // 刷新不额外带这次请求 —— 回收站是低频页面，不该让每个孩子每次刷新
  // 都多付一次往返。代价是 profile 上的条数在打开回收站之前是 0（不显示），
  // 这比"猜一个数"诚实。

  /// 回收站加载状态（与首页 [readStatus] 分开：回收站失败不该把首页画成错误页）。
  ReadStatus get trashReadStatus => _trashReadStatus;

  /// 回收站的加载错误（403 = 没有查看资格；**不能**显示成"回收站是空的"）。
  ReadApiException? get trashError => _trashError;

  /// 回收站读到的条目（live）。预览模式恒为空 —— 预览的回收站来自本地列表。
  List<TrashItem> get _liveTrashRows => _trashItems;

  /// 回收站写入口（恢复 / 彻底删除）是否被只读拦截。
  ///
  /// 与 [isReadOnly] 分开：live 模式下这两条已经接了后端，只有**没注入
  /// 写客户端**时才拦；预览模式反而可以随便点（那是演示数据）。
  bool get isTrashWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下回收站写操作的文案 —— 页面直接展示，不另编理由。
  String get trashReadOnlyWriteMessage =>
      '只读模式：回收站操作暂时写不进去（写客户端未就绪），这次没有保存到服务器。';

  /// 习惯写入口（删除首页习惯）是否被只读拦截（W5-F）。
  ///
  /// 与 [isReadOnly] 分开：live 模式下 `DELETE /habits/:id` 已经接了后端，
  /// 只有**没注入写客户端**时才拦。
  bool get isHabitWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下习惯写操作的文案 —— 页面直接展示，不另编理由。
  String get habitReadOnlyWriteMessage => '只读模式：习惯删除还没有接上后端，这次操作没有保存到服务器。';

  // ─────────────────────── 家庭成员（W5-H，服务端） ───────────────────────

  /// 成员列的**只读快照**（服务端顺序：家长在前、按加入时间）。
  List<FamilyMember> get members => List<FamilyMember>.unmodifiable(_members);

  /// 成员列表加载状态（与首页 [readStatus] 分开：403 不该把首页画成错误页）。
  ReadStatus get membersReadStatus => _membersReadStatus;

  /// 成员列表的加载错误（403 = 没有查看资格，**不能**显示成「没有成员」）。
  ReadApiException? get membersError => _membersError;

  /// 正在提交改角色 / 移出的成员 id；非 null 时该行按钮应禁用。
  String? get busyMemberId => _busyMemberId;

  /// 成员写入口（改角色 / 移出）是否被只读拦截。
  ///
  /// 与 [isReadOnly] 分开：live 模式下这两条已经接了后端，只有**没注入
  /// 写客户端**时才拦；预览模式没有真实成员，面板另有空态文案。
  bool get isMemberWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下成员写操作的文案 —— 页面直接展示，不另编理由。
  String get memberReadOnlyWriteMessage =>
      '只读模式：成员管理暂时写不进去（写客户端未就绪），这次没有保存到服务器。';

  /// 「我」那一行；服务端没下发（或列表还没拉到）时为 null。
  FamilyMember? get selfMember {
    for (final FamilyMember member in _members) {
      if (member.isSelf) return member;
    }
    return null;
  }

  /// 当前用户能否管理成员 —— **只看自己那一行的角色**。
  ///
  /// 服务端仍然是最终裁决者：这里为 true 只表示「界面可以给出按钮」，
  /// 真正的拒绝（403 `FORBIDDEN` / `CANNOT_MODIFY_SELF`）照样原样上报。
  bool get canManageMembers => selfMember?.role == MemberRole.guardian;

  // ─────────────────────── 邀请码（W5-I，服务端） ───────────────────────

  /// 邀请码列的**只读快照**（服务端顺序：新码在前）。
  List<InviteCode> get invites => List<InviteCode>.unmodifiable(_invites);

  /// 邀请码列表加载状态（与首页 / 成员状态分开）。
  ReadStatus get invitesReadStatus => _invitesReadStatus;

  /// 邀请码列表的加载错误（403 = 当前身份没有 `invite_member`，
  /// **不能**画成「还没有邀请码」）。
  ReadApiException? get invitesError => _invitesError;

  /// 正在吊销的邀请码 id；非 null 时该行按钮应禁用。
  String? get busyInviteId => _busyInviteId;

  /// 是否正在生成 / 吊销邀请码 —— 面板据此禁用所有写按钮（防双击造出一屏废码）。
  bool get isInviteWriteBusy => _creatingInvite || _busyInviteId != null;

  /// 邀请码写入口（生成 / 吊销）是否被只读拦截。
  bool get isInviteWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下邀请码写操作的文案 —— 页面直接展示，不另编理由。
  String get inviteReadOnlyWriteMessage =>
      '只读模式：邀请码暂时写不进去（写客户端未就绪），这次没有保存到服务器。';

  /// 能否管理邀请码 —— 与 [canManageMembers] 同一条判据（`invite_member`
  /// 在矩阵里只有 guardian ALLOW）。服务端仍是最终裁决者：
  /// 这里为 true 只表示「界面可以给出按钮」，403 照样原样上报。
  ///
  /// 注意：它依赖**成员列表已拉到**（`selfMember`），所以邀请码面板打开时
  /// 要先 `refreshMembers()` —— 否则家长会看到一个空面板。
  bool get canManageInvites => canManageMembers;

  // ─────────────────────── 监护人同意（W7-B，服务端） ───────────────────────

  /// 当前同意快照；未拉到时是 [GuardianConsent.unknown]（**不是**服务端事实）。
  GuardianConsent get consent => _consent;

  /// 同意状态的加载状态（与成员 / 邀请码分开）。
  ReadStatus get consentReadStatus => _consentReadStatus;

  /// 同意状态的加载错误（403 = 当前身份没有 `view_consent`，
  /// **不能**画成「未同意」—— 那会诱导孩子或访客去点一个必然失败的按钮）。
  ReadApiException? get consentError => _consentError;

  /// 是否正在提交同意 / 撤回 —— 面板据此禁用两个按钮。
  bool get isConsentWriteBusy => _consentWriteBusy;

  /// 同意写入口（作出 / 撤回）是否被只读拦截。
  bool get isConsentWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下同意写操作的文案 —— 页面直接展示，不另编理由。
  String get consentReadOnlyWriteMessage =>
      '只读模式：同意状态暂时写不进去（写客户端未就绪），这次没有保存到服务器。';

  /// 能否管理同意 —— `view_consent` / `manage_consent` 在矩阵里都是
  /// guardian ALLOW / child DENY，与成员管理同一条判据。
  ///
  /// 服务端仍是最终裁决者：这里为 true 只表示「界面可以给出按钮」，
  /// 403 照样原样上报。依赖成员列表已拉到（`selfMember`），
  /// 所以同意面板打开时同样要先 `refreshMembers()`。
  bool get canManageConsent => canManageMembers;

  // ─────────────────────── 家庭数据导出（W7-C，服务端） ───────────────────────

  /// 最近一次成功拉到的导出文件；还没拉到过时为 null（**不是**「没有数据」）。
  FamilyExport? get familyExport => _familyExport;

  /// 导出的加载状态（与成员 / 同意分开）。
  ReadStatus get exportReadStatus => _exportReadStatus;

  /// 导出的加载错误（403 = 当前身份没有 `export_family_data`，
  /// **不能**画成「没有可导出的数据」—— 那会把权限问题说成数据问题）。
  ReadApiException? get exportError => _exportError;

  /// 是否正在下载导出文件。
  bool get isExportBusy => _exportBusy;

  /// 能否导出家庭数据 —— `export_family_data` 在矩阵里只有 guardian ALLOW，
  /// 与成员管理同一条判据（`selfMember.role`）。
  ///
  /// 服务端仍是最终裁决者：这里为 true 只表示「界面可以给出入口」，
  /// 403 照样原样上报。依赖成员列表已拉到（`selfMember`），
  /// 所以导出面板打开时同样要先 `refreshMembers()`。
  bool get canExportFamilyData => canManageMembers;

  // ─────────────────────── 家庭数据删除（W7-D，服务端） ───────────────────────

  /// 最近一次拉到的删除状态；还没拉到过时为 null（**不是**「从未申请」）。
  /// 从未申请是 `FamilyDeletionStatus.none` 那个**已解析**的对象。
  FamilyDeletion? get familyDeletion => _familyDeletion;

  /// 删除状态的加载状态（与导出 / 同意分开）。
  ReadStatus get deletionReadStatus => _deletionReadStatus;

  /// 删除状态的加载错误（403 = 当前身份没有 `view_family_deletion`，
  /// **不能**画成「没有删除请求」—— 那会把权限问题说成数据问题）。
  ReadApiException? get deletionError => _deletionError;

  /// 是否正在提交申请 / 撤销。
  bool get isDeletionBusy => _deletionBusy;

  /// 能否申请 / 撤销删除 —— 两个动作在矩阵里都是 guardian ALLOW / child DENY，
  /// 与成员管理同一条判据（`selfMember.role`）。
  ///
  /// 服务端仍是最终裁决者：这里为 true 只表示「界面可以给出按钮」，
  /// 403 照样原样上报。依赖成员列表已拉到（`selfMember`），
  /// 所以删除面板打开时同样要先 `refreshMembers()`。
  bool get canManageFamilyDeletion => canManageMembers;

  // ─────────────────────── 站内通知（W5-L，服务端） ───────────────────────

  /// 通知列的**只读快照**（服务端顺序：新通知在前）。
  List<NotificationDto> get notifications =>
      List<NotificationDto>.unmodifiable(_notifications);

  /// 通知列表加载状态（与首页 / 成员 / 邀请码状态分开）。
  ReadStatus get notificationsReadStatus => _notificationsReadStatus;

  /// 通知列表的加载错误（403 = 当前身份没有 `view_notifications`，
  /// **不能**画成「还没有消息」）。
  ReadApiException? get notificationsError => _notificationsError;

  /// 未读通知总数 —— 红点用它。0 时不显示红点。
  int get unreadNotificationCount => _unreadNotificationCount;

  /// 是否还有下一页（面板滚到底时据此决定要不要继续拉）。
  bool get notificationsHasMore => _notificationsHasMore;

  /// 正在标记已读的通知 id；非 null 时该行应禁用。
  String? get busyNotificationId => _busyNotificationId;

  /// 通知写入口（标记已读）是否被只读拦截。
  ///
  /// 与 [isReadOnly] 分开：live 模式下这条已经接了后端，只有**没注入
  /// 写客户端**时才拦。
  bool get isNotificationWriteReadOnly => isLiveMode && _writeApi == null;

  /// 只读模式下通知写操作的文案 —— 页面直接展示，不另编理由。
  String get notificationReadOnlyWriteMessage =>
      '只读模式：标记已读暂时写不进去（写客户端未就绪），这次没有保存到服务器。';

  ReadStatus get readStatus => _readStatus;

  ReadApiException? get readError => _readError;

  /// 当前展示的是本地预览数据（未配置后端，或首次加载尚未成功）。
  bool get usingPreview => _usingPreview;

  /// 服务端还有下一页（仅 live 有效）。
  bool get hasMoreRecords => _hasMoreRecords;

  /// 当前记录页的服务端筛选（null = 全部）。
  RecordCategory? get recordFilter => _recordFilter;

  // ------------------------------------------------ 审批收件箱的只读视图

  /// 收件箱当前的 `status` 过滤词（默认 `pending`）。
  String get approvalStatusFilter => _approvalFilter;

  /// 收件箱加载状态。与首页的 [readStatus] **分开**：收件箱失败不该把
  /// 首页也画成错误页，反之亦然。
  ReadStatus get approvalReadStatus => _approvalReadStatus;

  /// 收件箱的加载错误（403 = 没有批准资格，页面要如实说，而不是「暂无」）。
  ReadApiException? get approvalError => _approvalError;

  bool get hasMoreApprovals => _hasMoreApprovals;

  /// 已加载的收件箱行（新 → 旧，服务端顺序原样保留）。
  List<ApprovalInboxItem> get approvals =>
      List<ApprovalInboxItem>.unmodifiable(_approvalItems);

  /// 当前已加载里还「待处理」的条数（底部导航红点用；不是服务端总数）。
  int get pendingApprovalCount =>
      _approvalItems.where((ApprovalInboxItem item) => item.isPending).length;

  /// 正在提交判定的那条申请 id；非 null 时按钮全部禁用。
  String? get decidingApprovalId => _decidingApprovalId;

  /// 收件箱的写入是否可用：live 且注入了写客户端。
  bool get canDecideApprovals => isLiveMode && _writeApi != null;

  /// 「我的申请」的撤回是否可用（W5-J）：与判定同一判据。
  bool get canWithdrawApprovals => isLiveMode && _writeApi != null;

  /// 只读模式下写操作统一文案 —— 页面直接展示，不另编理由。
  ///
  /// 走到这里有两个原因，文案同时覆盖：写客户端没能构造出来（配置缺失 / 构造失败），
  /// 或这个能力压根还没有端点（回收站恢复、恢复演示数据）。不再点名具体功能 ——
  /// W5-B 之后「兑换 / 记一笔 / 档案」都已经能真写，旧文案会变成假话。
  String get readOnlyWriteMessage => '只读模式：这个操作暂时写不进去（写客户端未就绪或尚未接后端），没有保存。';

  /// 记录页要展示的流水：
  ///   · 预览模式：对本地流水按分类过滤（原逻辑）；
  ///   · live 模式：服务端已按 `category` 过滤，这里不再二次过滤，
  ///     否则「全部」只加载 50 条时会漏掉后面的同类记录。
  List<PointRecord> get visibleRecords => _usingPreview
      ? recordsOf(_recordFilter)
      : List<PointRecord>.unmodifiable(records);

  int _points = 0;
  late ChildProfile profile;

  /// 流水：**只增不删**（撤销也走冲正记录）—— 与审计、版本表同等待遇。
  final List<PointRecord> records = <PointRecord>[];

  /// 规则版本表 —— **只增不删、永不 UPDATE**（`02` §5.3 / §5.6），修 C10。
  final List<RuleVersion> ruleVersions = <RuleVersion>[];

  /// 审计流水 —— **追加式**（只增不删、永不 UPDATE），修 C11。
  final List<AuditEntry> auditLog = <AuditEntry>[];

  // 三个配置列表的**唯一**存储：含回收站条目（status 为 deleted 的项）。
  // 页面**不得**直接读它们 —— 一律走下面的 getter（自动过滤回收站，§3.6）。
  final List<Habit> _habitList = <Habit>[];
  final List<Wish> _wishList = <Wish>[];
  final List<PointRule> _ruleList = <PointRule>[];

  /// 列表的**唯一**读法（docs/design/08 §3.6）：[activeOnly] 只在这里收口。
  ///
  /// 页面拿到的是“活着的”；回收站拿的是 `deleted` 的 ——
  /// 排除 `deleted` 的判断全仓库只有 trash.dart 一处，
  /// 两端各写一遍 `status == active` 迟早漂移（那正是 E15 / E17 教过的）。
  List<Habit> get habits => activeOnly(_habitList);

  List<Wish> get wishes => activeOnly(_wishList);

  List<PointRule> get rules => activeOnly(_ruleList);

  int get points => _points;

  int _seq = 0;

  /// 空态：每个真实用户的第一步都从这里开始（修 E18）。
  void _resetToEmpty() {
    _points = 0;
    profile = ChildProfile(
      name: '',
      childId: '',
      goodHabitCount: 0,
      rewardCount: 0,
    );
    _habitList.clear();
    _wishList.clear();
    _ruleList.clear();
    records.clear();
    ruleVersions.clear();
    auditLog.clear();
    _approvalItems.clear();
    _approvalFilter = 'pending';
    _approvalReadStatus = ReadStatus.idle;
    _approvalError = null;
    _hasMoreApprovals = false;
    _nextApprovalCursor = null;
    _decidingApprovalId = null;
    _trashItems.clear();
    _trashReadStatus = ReadStatus.idle;
    _trashError = null;
    _members.clear();
    _membersReadStatus = ReadStatus.idle;
    _membersError = null;
    _busyMemberId = null;
    _invites.clear();
    _invitesReadStatus = ReadStatus.idle;
    _invitesError = null;
    _busyInviteId = null;
    _creatingInvite = false;
    _consent = GuardianConsent.unknown;
    _consentReadStatus = ReadStatus.idle;
    _consentError = null;
    _consentWriteBusy = false;
    _familyDeletion = null;
    _deletionReadStatus = ReadStatus.idle;
    _deletionError = null;
    _deletionBusy = false;
    _notifications.clear();
    _notificationsReadStatus = ReadStatus.idle;
    _notificationsError = null;
    _notificationsCursor = null;
    _notificationsHasMore = false;
    _unreadNotificationCount = 0;
    _busyNotificationId = null;
    _onboarding = null;
    _onboardingReadStatus = ReadStatus.idle;
    _onboardingError = null;
    _onboardingWriteBusy = false;
    _lastOnboardingResult = null;
    _lastOnboardingHabitCount = 0;
    _lastOnboardingManualTitles = <String>[];
    _parentMode = null;
    _parentModeReadStatus = ReadStatus.idle;
    _parentModeError = null;
    _parentModeBusy = false;
    _parentPinBusy = false;
    _lastParentPinResult = null;
    _parentPinLockSeconds = 0;
    // 本机 PIN 锁：回到「锁着」。构造时就走这里 ⇒ 冷启动一定先要 PIN。
    _appUnlocked = false;
    _appLockBusy = false;
    _appLockError = null;
    _relockPending = false;
  }

  /// 载入演示数据 —— 只由 [resetToSeed] 调用（调试构建 / 测试夹具）。
  void _applySeed() {
    final SeedBundle seed = buildSeedData();
    _points = seed.points;
    profile = seed.profile;
    _habitList
      ..clear()
      ..addAll(seed.habits);
    _wishList
      ..clear()
      ..addAll(seed.wishes);
    records
      ..clear()
      ..addAll(seed.records);
    _ruleList
      ..clear()
      ..addAll(seed.rules);
    ruleVersions
      ..clear()
      ..addAll(seed.ruleVersions);
    // 夹具的审计**从空开始**：审计记录的是“这台设备上发生过的变更”，
    // 预置数据不是变更（否则回收站 / 审计页会显示一堆没人做过的操作）。
    auditLog.clear();
  }

  /// 恢复演示数据（“我的”页长按头像可触发）。返回是否真的执行了恢复。
  ///
  /// **修 E18**：原先是**生产可达**的公开方法 —— 用户可一键清空真实数据并恢复假演示数据。
  /// 现由 [allowDemoReset]（编译期常量）守卫，仅调试构建可用。
  ///
  /// 注意它现在是演示数据的**唯一**入口：首启不再自动载入 seed（那是 E18 的另一半）。
  bool resetToSeed() {
    if (!allowDemoReset) return false;
    _applySeed();
    _persist();
    return true;
  }

  // ---------------------------------------------------------------- 查询

  /// 按分类过滤流水，[category] 为 null 表示“全部”。
  List<PointRecord> recordsOf(RecordCategory? category) {
    if (category == null) return List<PointRecord>.unmodifiable(records);
    return records.where((PointRecord r) => r.category == category).toList();
  }

  // ------------------------------------------------------- 只读 API（W4-B）

  /// 身份切换（登录 / 换账号 / 建孩子）时清空所有页面级缓存。
  ///
  /// ── 为什么必须有它 ──────────────────────────────────────────────────────────
  ///   `AppStore` 是进程内单例，`_readApi` 只是**取值函数**（每次请求现读
  ///   `SessionScope`）。换账号后如果不主动清空，首页会先显示上一个孩子的
  ///   积分 / 心愿，直到下一次刷新回来 —— 那是最不该出现的\"串数据\"。
  ///
  /// ── 为什么不动 API 客户端 ──────────────────────────────────────────────────
  ///   它们本身无状态（设备 / 孩子 id 都在 `ReadApiConfig` 里动态取），
  ///   重建客户端只会丢掉测试注入的替身。
  void resetForIdentity() {
    _resetToEmpty();
    _usingPreview = false;
    _readStatus = ReadStatus.idle;
    _readError = null;
    // 让仍在路上的请求结果作废（`refreshFromServer` 用 epoch 判新旧）。
    _readEpoch += 1;
    _notify();
  }

  /// 从后端拉取首页快照 + 第一页流水；失败时**保留已有数据**并记录错误。
  ///
  /// 两个请求并发：首页和流水各自独立，任何一个失败都会走 catch，
  /// 不会出现「首页更新了、流水还是旧的」这种半新半旧的静默状态。
  Future<void> refreshFromServer() async {
    final ReadApiClient? api = _readApi;
    if (api == null) return;

    final int epoch = ++_readEpoch;
    _readStatus = ReadStatus.loading;
    _readError = null;
    _notify();

    try {
      final List<Object> results = await Future.wait<Object>(<Future<Object>>[
        api.fetchHome(),
        api.fetchRecords(
          category: _recordFilter?.name,
          limit: _recordsPageSize,
        ),
      ]);
      if (epoch != _readEpoch || _disposed) return;

      final HomeSnapshot home = mapHome(results[0] as HomeDto);
      final RecordsPage page = mapRecordsPage(results[1] as RecordsPageDto);

      _applyHomeSnapshot(home);
      _applyRecordsPage(page, append: false);
      _usingPreview = false;
      _readStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = error;
      _readStatus = ReadStatus.error;
    } catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = _unexpectedReadError(error);
      _readStatus = ReadStatus.error;
    }
    _notify();
  }

  /// 追加下一页。**必须**用服务端给的 `nextCursor` 原样请求；
  /// 没有更多 / 正在加载 / 预览模式时直接返回（不会重复请求同一页）。
  Future<void> loadMoreRecords() async {
    final ReadApiClient? api = _readApi;
    final String? cursor = _nextCursor;
    if (api == null ||
        _usingPreview ||
        !_hasMoreRecords ||
        cursor == null ||
        _readStatus == ReadStatus.loadingMore ||
        _readStatus == ReadStatus.loading) {
      return;
    }

    final int epoch = _readEpoch;
    _readStatus = ReadStatus.loadingMore;
    _readError = null;
    _notify();

    try {
      final RecordsPageDto dto = await api.fetchRecords(
        category: _recordFilter?.name,
        limit: _recordsPageSize,
        cursor: cursor,
      );
      if (epoch != _readEpoch || _disposed) return;

      _applyRecordsPage(mapRecordsPage(dto), append: true);
      _readStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = error;
      _readStatus = ReadStatus.error;
    } catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = _unexpectedReadError(error);
      _readStatus = ReadStatus.error;
    }
    _notify();
  }

  /// 切换记录页分类。live 模式下**重新向服务端要第一页**（带 `category`），
  /// 因为本地只过滤已加载的 50 条会漏掉后面的同类记录（那是假「共 N 条」）。
  Future<void> setRecordFilter(RecordCategory? category) async {
    if (_recordFilter == category) return;
    _recordFilter = category;

    if (_readApi == null) {
      _notify();
      return;
    }
    // 首次加载还没成功时，切分类不能只改本地筛选：服务端那页仍按旧分类在途，
    // 回来后会和 chip 对不上。整页刷新会递增 epoch，把旧响应作废。
    if (_usingPreview) {
      await refreshFromServer();
      return;
    }
    final ReadApiClient api = _readApi;

    final int epoch = ++_readEpoch;
    _readStatus = ReadStatus.loading;
    _readError = null;
    _nextCursor = null;
    _hasMoreRecords = false;
    records.clear();
    _notify();

    try {
      final RecordsPageDto dto = await api.fetchRecords(
        category: _recordFilter?.name,
        limit: _recordsPageSize,
      );
      if (epoch != _readEpoch || _disposed) return;

      _applyRecordsPage(mapRecordsPage(dto), append: false);
      _readStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = error;
      _readStatus = ReadStatus.error;
    } catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = _unexpectedReadError(error);
      _readStatus = ReadStatus.error;
    }
    _notify();
  }

  // ------------------------------------------------- 审批收件箱（W5-D）

  /// 拉取收件箱第一页（live）。预览模式没有审批数据 —— 直接进入
  /// `ready` 空态，页面据此显示「预览模式没有待审批的申请」，而不是报错。
  ///
  /// ★ 为什么不像 `/home` 那样在 [refreshFromServer] 里一起拉：
  ///   · 孩子角色调用这个端点必然 403，把 403 塞进首页刷新会污染首页错误；
  ///   · 收件箱只在家长打开时才有用，没必要每次首页刷新都付一次请求。
  Future<void> refreshApprovals() => _loadApprovals(append: false);

  /// 拉取「我的申请」的一页（W5-J）。
  ///
  /// ★ 为什么不像收件箱那样把结果存进 store：
  ///   这个列表只在「我的申请」面板打开时有用，且**两个角色**都会看；
  ///   把它塞进全局状态会让「家长收件箱」与「我的申请」两套游标 / 错误
  ///   互相污染。面板自己持有生命周期，store 只负责「怎么问服务端」。
  ///
  /// 预览模式返回空页（没有后端可问）—— 页面据此说「预览模式没有申请」，
  /// 而不是编一条假数据。
  Future<ApprovalsPage> fetchMyApprovals({
    String status = 'all',
    int limit = 20,
    String? cursor,
  }) async {
    final ReadApiClient? api = _readApi;
    if (api == null) {
      return const ApprovalsPage(
          items: <ApprovalInboxItem>[], hasMore: false, nextCursor: null);
    }
    final ApprovalsPageDto dto = await api.fetchMyApprovals(
      status: status,
      limit: limit,
      cursor: cursor,
    );
    return mapApprovalsPage(dto);
  }

  /// 追加下一页；没有更多 / 正在加载时直接返回。
  Future<void> loadMoreApprovals() async {
    if (!_hasMoreApprovals || _nextApprovalCursor == null) return;
    if (_approvalReadStatus == ReadStatus.loading ||
        _approvalReadStatus == ReadStatus.loadingMore) {
      return;
    }
    await _loadApprovals(append: true);
  }

  /// 切换收件箱状态过滤（`pending` / `approved` / `rejected` / …）。
  ///
  /// 与流水分类同一纪律：live 模式**重新向服务端要第一页**（带 `status`），
  /// 因为本地只过滤已加载的 20 条会漏掉后面的同类申请。未知过滤词直接忽略。
  Future<void> setApprovalStatusFilter(String status) async {
    if (status == _approvalFilter) return;
    if (!approvalStatusFilters.contains(status)) return;
    _approvalFilter = status;
    _approvalItems.clear();
    _hasMoreApprovals = false;
    _nextApprovalCursor = null;
    _approvalError = null;
    await _loadApprovals(append: false);
  }

  Future<void> _loadApprovals({required bool append}) async {
    final ReadApiClient? api = _readApi;

    if (api == null) {
      // 预览：没有后端可问。明确置空 + ready，让页面说「预览模式没有」，
      // 而不是停在 loading 转圈或显示一个编出来的假申请。
      _approvalEpoch++;
      _approvalItems.clear();
      _hasMoreApprovals = false;
      _nextApprovalCursor = null;
      _approvalError = null;
      _approvalReadStatus = ReadStatus.ready;
      _notify();
      return;
    }

    final int epoch = ++_approvalEpoch;
    _approvalReadStatus = append ? ReadStatus.loadingMore : ReadStatus.loading;
    _approvalError = null;
    if (!append) {
      _approvalItems.clear();
      _hasMoreApprovals = false;
      _nextApprovalCursor = null;
    }
    _notify();

    try {
      final ApprovalsPageDto dto = await api.fetchApprovals(
        status: _approvalFilter,
        limit: _approvalsPageSize,
        cursor: append ? _nextApprovalCursor : null,
      );
      if (epoch != _approvalEpoch || _disposed) return;

      final ApprovalsPage page = mapApprovalsPage(dto);
      // 按 id 去重：键集翻页本不该重叠，但客户端多一道保险。
      final Set<String> known =
          _approvalItems.map((ApprovalInboxItem item) => item.id).toSet();
      _approvalItems.addAll(
        page.items.where((ApprovalInboxItem item) => known.add(item.id)),
      );
      _nextApprovalCursor = page.nextCursor;
      _hasMoreApprovals = page.hasMore;
      _approvalReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (epoch != _approvalEpoch || _disposed) return;
      _approvalError = error;
      _approvalReadStatus = ReadStatus.error;
      // 失败时保留已加载的行（与流水一致）：网络抖一下不该让家长丢掉列表，
      // 页面会在顶部显示错误横幅 + 重试入口。
    } catch (error) {
      if (epoch != _approvalEpoch || _disposed) return;
      _approvalError = _unexpectedReadError(error);
      _approvalReadStatus = ReadStatus.error;
    }
    _notify();
  }

  /// 批准 / 拒绝一条申请。成功返回 null（界面自己提示），失败返回可展示文案。
  ///
  /// 三层校验，缺一层都会让界面说谎：
  ///   ① **本地能判死的先拒**：已终态 / 已过期 / 内容读不懂 —— 这类请求发出去
  ///      只会换来 409，而且白白让列表里的状态晚一拍才更新；
  ///   ② 发送前设 [_decidingApprovalId]，双击不会变成两次判定（幂等键只是第二道）；
  ///   ③ 409 一律**重新拉列表**：服务端说「已经处理过」时，本地那条早已过期，
  ///      不刷新就会一直显示着一条点不动的申请。
  Future<String?> decideApproval(
    ApprovalInboxItem item, {
    required bool approve,
    DateTime? now,
  }) async {
    final DateTime moment = now ?? DateTime.now();

    if (!isLiveMode) return '预览模式没有需要处理的申请。';
    final WriteApi? api = _writeApi;
    if (api == null) {
      return '只读模式：审批写入还没有接上后端，这次操作没有保存到服务器。';
    }
    if (item.id.trim().isEmpty) return '申请 id 不能为空';
    if (!item.isPending) return '这条申请已经处理过了，请刷新列表。';
    if (item.isExpiredAt(moment)) {
      return '这条申请已超过 72 小时有效期，不能再批 / 拒，请让孩子重新提交。';
    }
    if (approve && item.summary == null) {
      return item.approveBlockedReasonAt(moment) ?? '内容无法识别，不能批准。';
    }
    if (_decidingApprovalId != null) return '上一条申请正在处理中，请稍候…';

    _decidingApprovalId = item.id;
    _notify();
    try {
      final ApprovalDto result = await api.decideApproval(
        item.id,
        approve: approve,
        idempotencyKey: _newIdempotencyKey('approval-decide'),
      );
      if (_disposed) return null;

      // 服务端回包的状态必须与这次点击一致；不一致说明契约漂移，不能当成功。
      final String expected = approve ? 'approved' : 'rejected';
      if (result.status != expected) {
        await refreshApprovals();
        return '服务端返回的状态是「${result.status}」，'
            '与这次操作不一致，请刷新确认。';
      }

      // 批准会写账本 / 改余额 / 可能新建心愿 ⇒ 首页数据必须重拉，
      // 否则家长回到首页看到的还是旧积分。
      if (approve) await refreshFromServer();
      await refreshApprovals();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.kind == WriteFailureKind.conflict) {
        // 409：本地看到的那条已经过时了。刷新后界面才与服务端一致。
        await refreshApprovals();
      }
      return error.userMessage;
    } catch (error) {
      return '这次审批结果无法确认，请刷新后查看，避免重复提交。';
    } finally {
      _decidingApprovalId = null;
      _notify();
    }
  }

  /// 撤回自己提交的申请（W5-J）。成功返回 null，失败返回可展示文案。
  ///
  /// 与 [decideApproval] 的差别：
  ///   · 撤回**不需要** payload / 余额重算 —— 服务端只把 `pending → withdrawn`，
  ///     不写流水、不动积分，因此成功后**不必**重拉首页快照；
  ///   · 收件箱只在「家长已经打开过」时才刷新：孩子调用收件箱端点必然 403，
  ///     为了同步一个孩子看不到的列表而制造一次 403，会把界面画成故障。
  Future<String?> withdrawApproval(String approvalId) async {
    if (!isLiveMode) return '预览模式没有可撤回的申请。';
    final WriteApi? api = _writeApi;
    if (api == null) return readOnlyWriteMessage;
    final String id = approvalId.trim();
    if (id.isEmpty) return '申请 id 不能为空';

    try {
      final ApprovalDto result = await api.withdrawApproval(
        id,
        idempotencyKey: _newIdempotencyKey('approval-withdraw'),
      );
      if (_disposed) return null;

      // 服务端回包必须是 `withdrawn`；否则说明契约漂移，不能当成功。
      if (result.status != 'withdrawn') {
        return '服务端返回的状态是「${result.status}」，'
            '与这次撤回不一致，请刷新确认。';
      }
      if (_approvalReadStatus != ReadStatus.idle) {
        await refreshApprovals();
      }
      return null;
    } on WriteApiException catch (error) {
      // 409（已被批 / 已过期）：本地那条已经过时，收件箱若已加载就同步一次。
      if (!_disposed && error.kind == WriteFailureKind.conflict) {
        if (_approvalReadStatus != ReadStatus.idle) await refreshApprovals();
      }
      return error.userMessage;
    } catch (error) {
      return '这次撤回结果无法确认，请刷新后查看，避免重复提交。';
    }
  }

  void _applyHomeSnapshot(HomeSnapshot home) {
    _points = home.pointsBalance;
    profile = ChildProfile(
      name: home.childName,
      childId: home.childId,
      goodHabitCount: home.goodHabitCount,
      rewardCount: home.rewardCount,
    );
    _habitList
      ..clear()
      ..addAll(home.habits);
    _ruleList
      ..clear()
      ..addAll(home.rules);
    _wishList
      ..clear()
      ..addAll(home.wishes);
  }

  void _applyRecordsPage(RecordsPage page, {required bool append}) {
    if (!append) records.clear();
    // 按 id 去重：键集翻页本不该重叠，但客户端多一道保险 ——
    // 宁可少显示一条重复，也不能让「加载更多」把同一笔流水堆两遍。
    final Set<String> known = records.map((PointRecord r) => r.id).toSet();
    records.addAll(page.records.where((PointRecord r) => known.add(r.id)));
    _nextCursor = page.nextCursor;
    _hasMoreRecords = page.hasMore;
  }

  ReadApiException _unexpectedReadError(Object error) => ReadApiException(
        ReadFailureKind.malformed,
        '读取数据时发生意外错误。请重试；若持续出现请反馈。',
        code: 'UNEXPECTED_READ_ERROR',
        detail: error.toString(),
      );

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _readApi?.close();
    _writeApi?.close();
    _onboardingApi?.close();
    _parentModeApi?.close();
    super.dispose();
  }

  /// 首页用的**派生视图**列表 —— 修 A2 / A3 / E17。
  ///
  /// 页面不再读任何“状态字段”：checked / limitText / doneText 都在这里
  /// 由 `dailyLimit` ＋ 当天流水现算。视图是**快照对象**，不回写 store，
  /// 因此也不存在“谁改了 checked 导致状态与流水不一致”的可能。
  List<HabitView> get habitViews =>
      habits.map((Habit habit) => habitView(habit, records)).toList();

  /// 单个习惯的派生视图（用于“刚打完卡”的单点查询）。
  HabitView habitViewOf(Habit habit) => habitView(habit, records);

  bool canRedeem(Wish wish) => !wish.redeemed && _points >= wish.cost;

  int gapOf(Wish wish) {
    final int gap = wish.cost - _points;
    return gap > 0 ? gap : 0;
  }

  // ---------------------------------------------------------------- 打卡

  /// 首页习惯打卡。成功返回 null，失败返回提示文案。
  ///
  /// [actor] 记录**真实操作人** —— 修 A4：原先无论谁打卡都写死“家长记录”，
  /// 孩子自己完成也显示“家长记录”，流水在撒谎且责任链断裂。
  String? checkIn(Habit habit, {ActorContext actor = const ActorContext()}) {
    // 修 A3：上限判定必须来自**当天流水**，不能是布尔量 checked ——
    // 否则“每天最多 2 次”的规则打完 1 次就再也打不了第 2 次（承诺的次数永远不可达）。
    // 习惯以 store 里的**当前**定义为准（视图是快照，不能信任调用方传进来的副本）。
    Habit? live;
    for (final Habit item in habits) {
      if (item.id == habit.id) {
        live = item;
        break;
      }
    }
    if (live == null) {
      return '“${habit.title}”已经不在今天的习惯里了';
    }
    final int done = checkedCountToday(records, live.id);
    if (done >= live.dailyLimit) {
      return '“${live.title}”今天已经完成 $done 次啦，明天继续加油～';
    }
    final RecordSource source = actor.role == MemberRole.child
        ? RecordSource.childSelf
        : RecordSource.guardian;
    _points += live.points;
    profile.goodHabitCount += 1;
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      title: live.title,
      subtitle: recordSubtitle(time: time, source: source),
      points: live.points,
      time: time,
      category: RecordCategory.praise,
      // 修 D9：流水只带**图标名字**（与规则/习惯同源），渲染时才查表
      iconName: live.iconName,
      color: live.color,
      source: source,
      operatorRole: actor.role,
      habitId: live.id,
      // 修 C10：习惯由哪条规则派生，就把那条规则**当时的版本**钉在这一笔上 ——
      // 没有它，规则改成 +5 之后这笔 +3 就成了无法解释的数字。
      ruleId: live.ruleId,
      ruleVersion: _currentRuleVersion(live.ruleId),
      balanceAfter: _points,
    );
    records.insert(0, record);
    // 修 C11：写流水与记审计在**同一次操作**里、只 persist 一次
    _audit(
      AuditAction.pointRecordCheckIn,
      AuditTargetType.pointRecord,
      record.id,
      null,
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  /// 撤销今天的打卡（长按习惯卡片）。成功返回 null，失败返回提示文案。
  ///
  /// **修 B7**：原先用 `removeWhere` 直接删掉今天的流水 —— 历史被物理抹掉
  /// （违背账本不可变原则），且按 `title` 匹配会**误删同名习惯**的记录。
  /// 现改为按 `habitId`（唯一）定位并写入**冲正记录**，原记录保留不动。
  /// 因此撤销后流水条数 **+1 而非 −1**。详见 docs/design/02 §5。
  String? undoCheckIn(
    Habit habit, {
    ActorContext actor = const ActorContext(),
  }) {
    // 修 A3：可撤销性同样按**当天流水**判定（checked 已不是可写字段）；
    // 真正决定“撤销哪一条”的仍是下面按 habitId 定位的 target。
    if (checkedCountToday(records, habit.id) == 0) {
      return '“${habit.title}”今天还没有打卡，不用撤销';
    }
    final Set<String?> reversedIds = records
        .where((PointRecord r) => r.reversesRecordId != null)
        .map((PointRecord r) => r.reversesRecordId)
        .toSet();
    PointRecord? target;
    for (final PointRecord r in records) {
      if (r.habitId == habit.id &&
          r.category == RecordCategory.praise &&
          r.source != RecordSource.correction &&
          !reversedIds.contains(r.id) &&
          isSameDay(r.time)) {
        target = r;
        break;
      }
    }
    if (target == null) {
      return '没有找到“${habit.title}”今天的打卡记录';
    }
    // 修 B6 同类保护：扣回不得超过当前余额（禁止静默截断，否则账本不平）
    if (target.points > _points) {
      return '积分不足，无法撤销（需扣回 ${target.points} 分，当前只有 $_points 分）';
    }
    // 修 A3：这里不再写 habit.checked = false —— 它是派生值，
    // 撤销通过「新增一条指向原记录的冲正记录」表达（见 habit.dart 的 checkedCountToday）
    _points -= target.points;
    if (profile.goodHabitCount > 0) profile.goodHabitCount -= 1;
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      title: '撤销：${target.title}',
      subtitle: recordSubtitle(
        time: time,
        source: RecordSource.correction,
        note: target.title,
      ),
      points: -target.points,
      time: time,
      category: RecordCategory.adjust,
      iconName: IconNames.minus,
      color: AppColors.pointSpend,
      source: RecordSource.correction,
      operatorRole: actor.role,
      note: target.title,
      habitId: habit.id,
      // 修 C10：冲正记录**继承**原记录的规则与版本 ——
      // “哪一版规则产生了这笔分、又是谁撤销的”因此都留在账上
      ruleId: target.ruleId,
      ruleVersion: target.ruleVersion,
      reversesRecordId: target.id,
      balanceAfter: _points,
    );
    records.insert(0, record);
    _audit(
      AuditAction.pointRecordUndoCheckIn,
      AuditTargetType.pointRecord,
      record.id,
      null,
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  // ------------------------------------------------------- 服务端写入口（W4-E）

  /// 首页打卡的统一入口。
  ///
  /// · 预览模式：走原来的本地 [checkIn]（返回值语义不变）；
  /// · live 模式：POST `/records/check-in`，成功后先把返回的流水落到本地，
  ///   再刷新服务端快照（余额 / 好习惯次数以服务端为准）。
  ///
  /// 写请求全程串行：第二次点击在第一次结束前到达时直接返回提示，
  /// 不会产生两笔无法解释的重复打卡。
  Future<String?> submitCheckIn(
    Habit habit, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) return checkIn(habit, actor: actor);
    final WriteApi? api = _writeApi;
    if (api == null) {
      return '只读模式：打卡写入还没有接上后端，这次操作没有保存到服务器。';
    }
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      final WrittenRecordDto result = await api.checkIn(
        habit.id,
        idempotencyKey: _newIdempotencyKey('checkin'),
      );
      if (_disposed) return null;
      _applyWrittenRecord(result.record);
      // 写成功后再刷新：即使刷新失败，界面也已经能看到刚写入的那笔流水，
      // 不会把“写入成功、读取失败”误报成“打卡失败”。
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '打卡请求已发出，但结果无法确认。请刷新后查看，避免重复操作。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 长按撤销今天的打卡（服务端写入口）。
  ///
  /// 目标记录优先从已加载流水里找；当前记录页可能被分类过滤 / 只加载了 50 条，
  /// 找不到时再单独取一页不分类的流水定位，**不修改**记录页正在展示的列表。
  Future<String?> submitUndoCheckIn(
    Habit habit, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) return undoCheckIn(habit, actor: actor);
    final WriteApi? api = _writeApi;
    if (api == null) {
      return '只读模式：撤销写入还没有接上后端，这次操作没有保存到服务器。';
    }
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      final PointRecord? target = await _findUndoRecord(habit.id);
      if (target == null) {
        return '没有找到“${habit.title}”今天的打卡记录';
      }
      final WrittenRecordDto result = await api.reverse(
        target.id,
        idempotencyKey: _newIdempotencyKey('reverse'),
        note: target.title,
      );
      if (_disposed) return null;
      _applyWrittenRecord(result.record);
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '撤销请求已发出，但结果无法确认。请刷新后查看，避免重复操作。';
    } finally {
      _writeInFlight = false;
    }
  }

  // ------------------------------------------------- 服务端写入口（W5-A：规则）

  /// 新增规则（服务端写入口）。
  ///
  /// · 预览模式：走本地 [addRule]，返回值语义不变；
  /// · live 模式：POST `/point-rules`，服务端在一个事务里写规则 + 第 1 版版本行
  ///   + 审计日志；成功后把回包落到本地，再用服务端快照校正。
  ///
  /// 图标白名单 / 每日次数在**发请求前**按双端同一口径校验 —— 输入错误不值得
  /// 让用户等一个 400。
  Future<String?> submitAddRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String iconName,
    required Color color,
    ActorContext actor = const ActorContext(),
  }) async {
    final String? invalid =
        _validateRuleFields(dailyLimit: dailyLimit, iconName: iconName);
    if (invalid != null) return invalid;
    if (!isLiveMode) {
      return addRule(
        title: title,
        condition: condition,
        dailyLimit: dailyLimit,
        points: points,
        iconName: iconName,
        color: color,
        actor: actor,
      );
    }
    final WriteApi? api = _writeApi;
    if (api == null) return ruleReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      final RuleDto dto = await api.createRule(
        title: title,
        condition: condition,
        dailyLimit: dailyLimit,
        points: points,
        icon: iconName,
        color: hexColorOf(color),
        idempotencyKey: _newIdempotencyKey('rule-create'),
      );
      if (_disposed) return null;
      _applyRuleDto(dto);
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '规则请求已发出，但结果无法确认。请刷新后查看，避免重复提交。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 编辑规则（服务端写入口）。
  ///
  /// `expectedVersion` 取的是**界面上看到的**版本号：服务端只接受「改的是当前版」，
  /// 否则 409 `RULE_VERSION_CONFLICT` —— 不会悄悄覆盖另一位家长刚做的修改。
  Future<String?> submitUpdateRule(
    PointRule rule, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    ActorContext actor = const ActorContext(),
  }) async {
    final String? invalid = _validateRuleFields(
      dailyLimit: dailyLimit,
      iconName: rule.iconName,
    );
    if (invalid != null) return invalid;
    if (!isLiveMode) {
      return updateRule(
        rule,
        title: title,
        condition: condition,
        dailyLimit: dailyLimit,
        points: points,
        actor: actor,
      );
    }
    final WriteApi? api = _writeApi;
    if (api == null) return ruleReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      final RuleDto dto = await api.updateRule(
        rule.id,
        title: title,
        condition: condition,
        dailyLimit: dailyLimit,
        points: points,
        expectedVersion: rule.currentVersion,
        idempotencyKey: _newIdempotencyKey('rule-update'),
      );
      if (_disposed) return null;
      _applyRuleDto(dto);
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '规则请求已发出，但结果无法确认。请刷新后查看，避免重复提交。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 软删规则（服务端写入口）：删除只改状态位，版本行与历史流水保留。
  ///
  /// 服务端是幂等的（重复删除同样回 200），这里也照常返回 null。
  Future<String?> submitRemoveRule(
    PointRule rule, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) {
      removeRule(rule, actor: actor);
      return null;
    }
    final WriteApi? api = _writeApi;
    if (api == null) return ruleReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      await api.deleteRule(
        rule.id,
        idempotencyKey: _newIdempotencyKey('rule-delete'),
      );
      if (_disposed) return null;
      // 先让本地镜像跟上：即使随后的刷新失败，也不会留一条「已删却还在列表里」
      // 的规则（回收站条目的 deletedAt 用本地时间，刷新成功后以服务端为准）。
      final PointRule? local = _findById(_ruleList, rule.id);
      if (local != null && local.status != RecordStatus.deleted) {
        local.status = RecordStatus.deleted;
        local.deletedAt = DateTime.now();
        _persist();
      }
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '删除请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 按规则生成首页习惯（服务端写入口）。
  ///
  /// 扣分规则 / 重复添加在本地先拦一次（即时反馈），最终仍以服务端判定为准：
  /// 服务端按 `sourceRuleId` 判重，改过标题也不会重复生成。
  Future<String?> submitAddHabitFromRule(
    PointRule rule, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) return addHabitFromRule(rule, actor: actor);
    if (rule.points < 0) {
      return '“${rule.title}”是扣分规则，不能加入今天的习惯';
    }
    if (habits.any((Habit habit) => habit.ruleId == rule.id)) {
      return '“${rule.title}”已经在今天的习惯里了';
    }
    final WriteApi? api = _writeApi;
    if (api == null) return ruleReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      final HabitDto dto = await api.addHabitFromRule(
        rule.id,
        idempotencyKey: _newIdempotencyKey('rule-habit'),
      );
      if (_disposed) return null;
      _applyHabitDto(dto);
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 每日次数 / 图标白名单 —— 本地与写入口**共用**同一套校验与文案。
  String? _validateRuleFields({
    required int dailyLimit,
    required String iconName,
  }) {
    if (!isDailyLimitValid(dailyLimit)) {
      return '每天次数只能是 $dailyLimitMin–$dailyLimitMax 之间的整数';
    }
    if (!isKnownIconName(iconName)) {
      return '图标「$iconName」不在可选列表里';
    }
    return null;
  }

  /// 写回包 → UI 规则模型（与服务端快照同一套映射）。
  void _applyRuleDto(RuleDto dto) {
    final PointRule rule;
    try {
      rule = mapRule(dto, 'rule');
    } on ReadApiException catch (error) {
      throw WriteApiException.malformed(
        'rule',
        detail: error.detail ?? error.userMessage,
      );
    }
    _ruleList
      ..removeWhere((PointRule item) => item.id == rule.id)
      ..insert(0, rule);
    _persist();
  }

  /// 写回包 → UI 心愿模型（与服务端快照同一套映射）。
  void _applyWishDto(WishDto dto) {
    final Wish wish;
    try {
      wish = mapWish(dto, 'wish');
    } on ReadApiException catch (error) {
      throw WriteApiException.malformed(
        'wish',
        detail: error.detail ?? error.userMessage,
      );
    }
    _wishList
      ..removeWhere((Wish item) => item.id == wish.id)
      ..insert(0, wish);
    _persist();
  }

  /// 写回包 → UI 习惯模型。
  void _applyHabitDto(HabitDto dto) {
    final Habit habit;
    try {
      habit = mapHabit(dto, 'habit');
    } on ReadApiException catch (error) {
      throw WriteApiException.malformed(
        'habit',
        detail: error.detail ?? error.userMessage,
      );
    }
    _habitList
      ..removeWhere((Habit item) => item.id == habit.id)
      ..add(habit);
    _persist();
  }

  /// 把写端点返回的流水立即落到本地（随后仍会用服务端快照校正）。
  void _applyWrittenRecord(RecordDto dto) {
    final PointRecord record;
    try {
      record = mapRecord(dto);
    } on ReadApiException catch (error) {
      throw WriteApiException.malformed(
        'record',
        detail: error.detail ?? error.userMessage,
      );
    }
    final bool existed = records.any((PointRecord r) => r.id == record.id);
    records.removeWhere((PointRecord r) => r.id == record.id);
    records.insert(0, record);
    _points = dto.balanceAfter;

    if (!existed) {
      // 只是刷新失败时的兜底计数：刷新成功后会被服务端的 goodHabitCount 覆盖。
      if (dto.category == 'praise' && dto.source != 'correction') {
        profile.goodHabitCount += 1;
      } else if (dto.source == 'correction' &&
          dto.points < 0 &&
          profile.goodHabitCount > 0) {
        profile.goodHabitCount -= 1;
      }
    }
    _persist();
  }

  /// 在当前列表里找「今天、未冲正」的那笔打卡。
  PointRecord? _findUndoRecordIn(Iterable<PointRecord> source, String habitId) {
    final Set<String?> reversedIds = source
        .where((PointRecord r) => r.reversesRecordId != null)
        .map((PointRecord r) => r.reversesRecordId)
        .toSet();
    for (final PointRecord record in source) {
      if (record.habitId == habitId &&
          record.category == RecordCategory.praise &&
          record.source != RecordSource.correction &&
          !reversedIds.contains(record.id) &&
          isSameDay(record.time)) {
        return record;
      }
    }
    return null;
  }

  Future<PointRecord?> _findUndoRecord(String habitId) async {
    final PointRecord? local = _findUndoRecordIn(records, habitId);
    if (local != null) return local;

    final ReadApiClient? read = _readApi;
    if (read == null) return null;
    try {
      // 取一页**不分类**的流水：冲正记录是 adjust，只在 praise 里找会误以为
      // 原记录仍未冲正。200 是后端 DTO 的上限。
      final RecordsPageDto page = await read.fetchRecords(limit: 200);
      return _findUndoRecordIn(mapRecordsPage(page).records, habitId);
    } on ReadApiException {
      return null;
    }
  }

  /// 幂等键只用于**同一次用户动作**的自动重试；这里每次用户点击生成一个，
  /// 所以双击仍是两笔（由 [_writeInFlight] 拦住），断线重试不会变成两笔。
  String _newIdempotencyKey(String prefix) =>
      '$prefix-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  // ------------------------------------------------------------ 记一笔

  /// “记一笔”：家长手动加/减分。[delta] 为负表示扣分。
  /// 成功返回 null，失败返回提示文案。
  ///
  /// **修 B6**：原先 `_points += delta; if (_points < 0) _points = 0;` 会**静默截断**余额，
  /// 而流水照记原始 delta —— 余额 124、delta=-9999 时余额变 0（实际变动 −124）却记 −9999，
  /// **Σ流水 ≠ 余额，账本无法对账**。现改为**拒绝超额扣分**。
  ///
  /// **修 A5**：原先 `if (isGain) profile.rewardCount += 1;` —— 手动加分被计成一次“奖励兑换”，
  /// 但 rewardCount 的语义是**累计兑换次数**，只应由 redeem 递增。
  String? addQuickNote({
    required int delta,
    required String reason,
    String note = '',
    ActorContext actor = const ActorContext(),
  }) {
    if (delta == 0) {
      return '调整金额不能为 0';
    }
    if (delta < 0 && delta.abs() > _points) {
      return '积分不足，当前只有 $_points 分，最多可扣 $_points 分';
    }
    final bool isGain = delta > 0;
    final RecordSource source = actor.role == MemberRole.child
        ? RecordSource.childSelf
        : RecordSource.guardian;
    _points += delta;
    final String title =
        reason.trim().isEmpty ? (isGain ? '额外奖励' : '扣除积分') : reason.trim();
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      title: title,
      subtitle: recordSubtitle(time: time, source: source, note: note),
      points: delta,
      time: time,
      category: RecordCategory.adjust,
      iconName: isGain ? IconNames.plus : IconNames.minus,
      color: isGain ? AppColors.pointGain : AppColors.pointSpend,
      source: source,
      operatorRole: actor.role,
      note: note.trim(),
      // 手动“记一笔”不来自任何规则 —— 版本号因此为 null（不是“忘了写”）
      ruleId: null,
      ruleVersion: null,
      balanceAfter: _points,
    );
    records.insert(0, record);
    _audit(
      AuditAction.pointRecordQuickNote,
      AuditTargetType.pointRecord,
      record.id,
      null,
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  // ------------------------------------------------- 服务端写入口（W5-B：记一笔）

  /// 「记一笔」的服务端写入口。
  ///
  /// · 预览模式：走本地 [addQuickNote]，返回值语义完全不变；
  /// · live 模式：POST `/records/adjust` —— 服务端在**一个事务**里锁余额、
  ///   写流水、写审计；成功后先把回包落到本地，再用服务端快照校正。
  ///
  /// 与 [addQuickNote] 的两点差别，都是「服务端说了算」的直接后果：
  ///   1. **余额够不够扣由服务端在锁内判定**（409 `INSUFFICIENT_POINTS`）；
  ///      本地 `_points` 可能已被别的设备改过，不能拿它当裁决依据 ——
  ///      拿旧余额拒绝一次合法扣分，和静默截断余额（B6）一样糟；
  ///   2. 流水 id / `balanceAfter` 全部来自回包，本地不先造一条 ——
  ///      否则刷新后会出现「本地一条 + 服务端一条」两笔。
  ///
  /// 写请求全程串行：第二次点击在第一次结束前到达时直接返回提示。
  Future<String?> submitQuickNote({
    required int delta,
    required String reason,
    String note = '',
    ActorContext actor = const ActorContext(),
  }) async {
    if (delta == 0) {
      return '调整金额不能为 0';
    }
    if (!isLiveMode) {
      return addQuickNote(
          delta: delta, reason: reason, note: note, actor: actor);
    }
    final WriteApi? api = _writeApi;
    if (api == null) {
      return '只读模式：记一笔还没有接上后端，这次操作没有保存到服务器。';
    }
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    // 空事由用默认文案 —— 与 [addQuickNote] 同一口径，标题必须解释这一笔。
    final String title =
        reason.trim().isEmpty ? (delta > 0 ? '额外奖励' : '扣除积分') : reason.trim();

    _writeInFlight = true;
    try {
      final WrittenRecordDto result = await api.adjust(
        title: title,
        points: delta,
        note: note,
        idempotencyKey: _newIdempotencyKey('adjust'),
      );
      if (_disposed) return null;
      _applyWrittenRecord(result.record);
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '记一笔的请求已发出，但结果无法确认。请刷新后查看，避免重复操作。';
    } finally {
      _writeInFlight = false;
    }
  }

  // ------------------------------------------------------------ 心愿单

  /// 兑换心愿。成功返回 true，积分不足或已兑换返回 false。
  ///
  /// **修 B8**：原先 `'兑换：${_shortTitle(wish.title)}'` 把标题截断到 10 字符后
  /// **永久写进流水**，且没有 `wishId` 回指 —— 心愿删除后这笔扣分再也无法解释。
  /// 现改为**完整标题快照 + wishId 回指**，截断交给渲染层的 ellipsis。
  bool redeem(Wish wish, {ActorContext actor = const ActorContext()}) {
    if (!canRedeem(wish)) return false;
    final RecordSource source = actor.role == MemberRole.child
        ? RecordSource.childSelf
        : RecordSource.guardian;
    _points -= wish.cost;
    wish.redeemed = true;
    profile.rewardCount += 1;
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      // 修 B8：完整标题，不截断
      title: '兑换：${wish.title}',
      subtitle: recordSubtitle(
        time: time,
        source: source,
        category: RecordCategory.exchange,
      ),
      points: -wish.cost,
      time: time,
      category: RecordCategory.exchange,
      iconName: IconNames.gift,
      color: AppColors.orange,
      source: source,
      operatorRole: actor.role,
      // 兑换与规则无关，版本号同样为 null
      ruleId: null,
      ruleVersion: null,
      // 修 B8：回指心愿，即使心愿被删除也能解释这笔支出
      wishId: wish.id,
      balanceAfter: _points,
    );
    records.insert(0, record);
    _audit(
      AuditAction.pointRecordRedeem,
      AuditTargetType.pointRecord,
      record.id,
      auditSnapshotOf(wish.snapshot()),
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return true;
  }

  void addWish({
    required String title,
    required int cost,
    required String emoji,
    ActorContext actor = const ActorContext(),
  }) {
    final String id = _newId('wish');
    final Wish wish = Wish(
      id: id,
      title: title.trim(),
      cost: cost,
      emoji: emoji,
      // 修 E16：配色只由「空档 + id」决定，与列表长度无关 —— 删项后既有心愿不再换色
      // （回收站里的心愿不参与选色：它们不在列表上，配色可以回收再利用）
      coverStyle: pickCoverStyle(
        wishes.map((Wish item) => item.coverStyle).toList(),
        id,
      ),
    );
    _wishList.insert(0, wish);
    _audit(
      AuditAction.wishCreate,
      AuditTargetType.wish,
      wish.id,
      null,
      auditSnapshotOf(wish.snapshot()),
      actor,
    );
    _persist();
  }

  /// 删除心愿 —— **软删**（进回收站，90 天内可恢复），修 C9。
  ///
  /// 原先 `wishes.remove(wish)`：误删不可恢复；且已发生的兑换流水再也找不到
  /// 它回指的心愿（`wishId` 指向空 —— “这笔扣分换的是什么”从此无解）。
  void removeWish(Wish wish, {ActorContext actor = const ActorContext()}) {
    final Wish? live = _findById(_wishList, wish.id);
    if (live == null) return;
    if (_softDelete(live, TrashKind.wish, actor)) _persist();
  }

  // ------------------------------------------- 服务端写入口（W5-C：心愿）

  /// 新增心愿（服务端写入口）。
  ///
  /// · 预览模式：走本地 [addWish]，结果语义不变（`saved`）；
  /// · live 模式：先 `POST /wishes`。家长 ⇒ 直接落库；
  ///   孩子（矩阵 `add_wish = REQUIRE_APPROVAL`）⇒ 服务端回 403
  ///   `APPROVAL_REQUIRED`，此时**接着** `POST /approvals` 落一条审批单，
  ///   返回 [WishAddStatus.pendingApproval]。
  ///
  /// ★ 2026-11-03 修：之前只把 403 的文案返回界面，**没有提交审批单**。
  ///   用户看到「需要家长确认」，家长切回家长模式却发现收件箱里没有这条 ——
  ///   「开了口子却不落单」比一开始就禁用按钮更糟。现在的口径是：
  ///   要么真的存上，要么真的提交，要么说清为什么两件事都没发生。
  Future<WishAddResult> submitAddWish({
    required String title,
    required int cost,
    required String emoji,
    ActorContext actor = const ActorContext(),
  }) async {
    final String trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty) {
      return const WishAddResult.failed('先给心愿起个名字吧～');
    }
    if (cost < 1) {
      return const WishAddResult.failed('心愿需要的积分至少是 1 分');
    }
    if (!isLiveMode) {
      addWish(
        title: trimmedTitle,
        cost: cost,
        emoji: emoji,
        actor: actor,
      );
      return const WishAddResult.saved();
    }
    final WriteApi? api = _writeApi;
    if (api == null) {
      return WishAddResult.failed(wishReadOnlyWriteMessage);
    }
    if (_writeInFlight) {
      return const WishAddResult.failed('上一次操作正在保存中，请稍候…');
    }

    _writeInFlight = true;
    try {
      final WishDto dto = await api.createWish(
        title: trimmedTitle,
        cost: cost,
        emoji: emoji,
        idempotencyKey: _newIdempotencyKey('wish-create'),
      );
      if (_disposed) return const WishAddResult.saved();
      _applyWishDto(dto);
      await refreshFromServer();
      return const WishAddResult.saved();
    } on WriteApiException catch (error) {
      // 只有「缺审批」这一种拒绝可以改走审批流。成员级收紧
      // （`childCannotAddWish` ⇒ 403 DENY）必须原样报错 ——
      // 否则会把「家长明确禁止」说成「已提交，等家长批准」。
      if (error.code != 'APPROVAL_REQUIRED') {
        return WishAddResult.failed(error.userMessage);
      }
      try {
        final ApprovalDto approval = await api.requestAddWish(
          title: trimmedTitle,
          cost: cost,
          emoji: emoji,
          idempotencyKey: _newIdempotencyKey('wish-approval'),
        );
        if (_disposed) return const WishAddResult.saved();
        if (approval.status == 'pending') {
          // **不**本地插一条心愿：还没落库。审批通过后由 /home 快照带回来。
          return const WishAddResult.pending();
        }
        // 家长自批等极少数情况（孩子路径不会走到）：以服务端为准刷新。
        await refreshFromServer();
        return const WishAddResult.saved();
      } on WriteApiException catch (approvalError) {
        return WishAddResult.failed(approvalError.userMessage);
      } catch (error) {
        return const WishAddResult.failed(
          '审批申请已发出，但结果无法确认。请刷新后查看。',
        );
      }
    } catch (error) {
      return const WishAddResult.failed(
        '心愿请求已发出，但结果无法确认。请刷新后查看，避免重复提交。',
      );
    } finally {
      _writeInFlight = false;
    }
  }

  /// 删除心愿（服务端写入口 `delete_wish`）—— **软删**，与 [removeWish] 同语义。
  ///
  /// 不碰任何流水：已发生的兑换记录继续带 `wishId` 回指（修 C9），
  /// 所以「那 40 分换的是什么」永远答得出。真正删不掉的只是列表上的一项。
  Future<String?> submitRemoveWish(
    Wish wish, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) {
      removeWish(wish, actor: actor);
      return null;
    }
    final WriteApi? api = _writeApi;
    if (api == null) return wishReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      // 客户端会校验回包 `wishId` 与请求一致（不一致 ⇒ malformed），
      // 因此这里拿到的一定是「刚删的那条」。
      await api.deleteWish(
        wish.id,
        idempotencyKey: _newIdempotencyKey('wish-delete'),
      );
      if (_disposed) return null;
      removeWish(wish, actor: actor);
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '删除请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _writeInFlight = false;
    }
  }

  // ------------------------------------------------------------ 积分规则

  /// 兑换心愿（服务端写入口）。
  ///
  /// 后端**没有**「直接兑换」的接口：`redeem` 在权限矩阵里对两个角色都是
  /// `REQUIRE_APPROVAL`，唯一正确路径是 `POST /approvals` 建一条申请。
  /// 因此这里的返回值语义与其它写入口不同 —— **null 只代表「已生效」**，
  /// 而 `pending` 是一个**要展示给用户的正常结果**（文案里明说「等家长确认、
  /// 还没扣分」），不能当成功静默掉。
  ///
  /// 兑换前的**确认文案** —— 只用于弹窗，不参与任何写请求。
  ///
  /// 两种模式必须说两种话，否则弹窗自己就在骗人：
  ///   · live：`redeem` 在矩阵里是 `REQUIRE_APPROVAL` ⇒ 点「提交申请」只是**建一条审批**，
  ///     此刻一分不扣（`pending` 不是成功），所以不能写「立即扣除」；
  ///   · 预览：没有服务端可申请，确认就直接本地扣分 —— 这时写「等家长确认」
  ///     等于演一场永远不会有人批的戏。
  String redeemConfirmText(Wish wish) {
    if (!isLiveMode) {
      return '要花 ${wish.cost} 分兑换“${wish.title}”吗？'
          '确认后积分会立即扣除，心愿会标记为已兑换。';
    }
    return '要把“${wish.title}”提交给家长确认吗？'
        '家长批准后才会扣 ${wish.cost} 分，现在还没有扣。';
  }

  /// 预览模式仍走本地 [redeem]（没有后端可申请，演示需要能看见扣分）。
  Future<String?> submitRedeemWish(
    Wish wish, {
    ActorContext actor = const ActorContext(),
  }) async {
    // 本地就能判死的先拒：空 id 进到 `requestRedeem` 会抛 `ArgumentError`，被下面的
    // 兜底 catch 翻成「兑换申请已发出」—— 一个字节都没发出去，不能这么说。
    if (wish.id.trim().isEmpty) return '心愿 id 不能为空';
    if (!isLiveMode) {
      return redeem(wish, actor: actor) ? null : '积分还不够，继续加油打卡吧！';
    }
    final WriteApi? api = _writeApi;
    if (api == null) return readOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      final ApprovalDto approval = await api.requestRedeem(
        wish.id,
        idempotencyKey: _newIdempotencyKey('wish-redeem'),
      );
      if (_disposed) return null;
      switch (approval.status) {
        case 'approved':
          // 家长自批（或服务端瞬时批准）：以服务端快照为准，不手写扣分。
          await refreshFromServer();
          return null;
        case 'pending':
          return '已提交给家长确认：批准后才会扣 ${wish.cost} 分，'
              '心愿也会标记为已兑换。';
        case 'rejected':
          return '家长拒绝了这次兑换，积分没有变动。';
        case 'withdrawn':
          return '这次兑换申请已被撤回，积分没有变动。';
        case 'invalidated':
          return '这次兑换无法生效（${_autoReasonText(approval.autoReason)}），'
              '积分没有变动。';
        default:
          // 未知状态不猜：宁可让用户刷新确认，也不能把「不清楚」说成「成功」。
          return '服务端返回了未知的审批状态「${approval.status}」，'
              '请刷新后查看兑换结果。';
      }
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '兑换申请已发出，但结果无法确认。请刷新后查看，避免重复提交。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 审批被自动判无效的原因 → 家长看得懂的一句话（`02` §4.2）。
  String _autoReasonText(String? reason) {
    switch (reason) {
      case 'WISH_DELETED':
        return '心愿已经被删除了';
      case 'INSUFFICIENT_POINTS':
        return '积分不够了';
      case 'MEMBER_REMOVED':
        return '成员已经被移出家庭';
      default:
        return '已有前提发生变化';
    }
  }

  // ------------------------------------------------------------ 积分规则

  /// 新增规则。成功返回 null，失败返回提示文案。
  ///
  /// **修 E15 / A2**：参数由 `detail` 自由串改为 `condition` ＋ `dailyLimit` 结构字段
  /// （展示串交给 [ruleDetail] 派生）；`dailyLimit` 越界时**拒绝**而不是夹到边界 ——
  /// 静默改写会让家长以为约定已按他的意思生效。
  ///
  /// **修 D9**：图标入参是**名字**（`iconName`），且必须落在白名单里 —— 越界同样
  /// **拒绝**：落一个不存在的名字，界面只会画成「未知」占位，家长看不到自己选的那个图标
  /// （静默兜底能保证不崩，但不该被当成「存进去了」）。
  String? addRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String iconName,
    required Color color,
    ActorContext actor = const ActorContext(),
  }) {
    final String? invalid =
        _validateRuleFields(dailyLimit: dailyLimit, iconName: iconName);
    if (invalid != null) return invalid;
    final PointRule rule = PointRule(
      id: _newId('rule'),
      title: title.trim(),
      condition: condition.trim().isEmpty ? '家长约定' : condition.trim(),
      dailyLimit: dailyLimit,
      points: points,
      iconName: iconName,
      color: color,
      // 修 C10：新建即 version 1，并**同时**留下 version 1 的版本记录 ——
      // 于是 `currentVersion` 永远指向一条真实存在的版本（回放不留空档）。
      currentVersion: 1,
    );
    _ruleList.insert(0, rule);
    ruleVersions.add(
      RuleVersion(
        id: _newId('rv'),
        ruleId: rule.id,
        version: 1,
        title: rule.title,
        condition: rule.condition,
        dailyLimit: rule.dailyLimit,
        points: rule.points,
        changedByRole: actor.role,
        changedAt: DateTime.now(),
        changeNote: '新建规则',
      ),
    );
    _audit(
      AuditAction.pointRuleCreate,
      AuditTargetType.pointRule,
      rule.id,
      null,
      auditSnapshotOf(rule.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  /// 删除规则 —— **软删**（进回收站，90 天内可恢复），修 C9。
  ///
  /// 版本记录**不跟着删**：否则历史流水的 `(ruleId, ruleVersion)` 指向空
  /// （“这分按什么规则给的”永远无法回答，见 `02` §5.6）。
  void removeRule(PointRule rule, {ActorContext actor = const ActorContext()}) {
    final PointRule? live = _findById(_ruleList, rule.id);
    if (live == null) return;
    if (_softDelete(live, TrashKind.pointRule, actor)) _persist();
  }

  /// 按规则生成一个首页习惯（规则页“加入今天的习惯”用）。
  /// 成功返回 null，失败返回提示文案。
  ///
  /// **修 A1**：原先 `points: rule.points.abs()` 把扣分规则**静默转成加分习惯** ——
  /// 家长定「打人 −3 分」，孩子打人后打卡反而 **+3 分**。属产品性质级错误。
  /// 扣分规则不应生成可打卡习惯，直接拒绝并给出可读文案。
  String? addHabitFromRule(
    PointRule rule, {
    ActorContext actor = const ActorContext(),
  }) {
    if (habits.any((Habit h) => h.title == rule.title)) {
      return '“${rule.title}”已经在今天的习惯里了';
    }
    if (rule.points < 0) {
      return '“${rule.title}”是扣分规则，不能加入今天的习惯';
    }
    // 修 E15：条件与频次**直取结构字段** —— 原先这里 rule.detail.split(' · ')
    // 反解析：多一段就丢一段、没分隔符就静默落到默认值「每天 1 次」。
    final Habit habit = Habit(
      id: _newId('habit'),
      title: rule.title,
      points: rule.points,
      condition: rule.condition,
      dailyLimit: rule.dailyLimit,
      iconName: rule.iconName,
      color: rule.color,
      // 修 C10：记住“我是由哪条规则派生的” —— 有了这条链，打卡写出的流水
      // 才能同时写清 (ruleId, ruleVersion)；改规则时也才知道该同步谁。
      // 靠标题匹配是 E15 那类病（改个名就断链）。
      ruleId: rule.id,
    );
    _habitList.add(habit);
    _audit(
      AuditAction.habitCreate,
      AuditTargetType.habit,
      habit.id,
      null,
      auditSnapshotOf(habit.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  // ------------------------------------------------------------ 档案

  void renameChild(String name, {ActorContext actor = const ActorContext()}) {
    final String trimmed = name.trim();
    if (trimmed.isEmpty) return;
    final AuditSnapshot before = auditSnapshotOf(profile.snapshot());
    profile.name = trimmed;
    // 修 C11：改名是“成员”类变更 —— 用 `memberRename` 记一条，
    // 而不是混进流水（成员变更不是积分变更）。
    // 成员增删 / 角色切换 / 家长同意在本轮**未实现**（前端没有入口），
    // 因此 AuditAction 里也没有对应取值 —— 不假装覆盖。
    _audit(
      AuditAction.memberRename,
      AuditTargetType.member,
      profile.childId.isEmpty ? 'local-child' : profile.childId,
      before,
      auditSnapshotOf(profile.snapshot()),
      actor,
    );
    _persist();
  }

  /// 改孩子昵称（服务端写入口 `edit_child_profile`，W5-E，2026-10-21）。
  ///
  /// 三种世界三种结局，语义与其它 `submit*` 一致：
  ///   · 预览（无后端）：走本地 [renameChild]，返回 null —— 演示数据本来就该生效；
  ///   · live 但没注入写客户端：返回只读文案，**不改内存**（否则刷新就打回原形）；
  ///   · live 且有写客户端：PATCH 成功后用**服务端返回的 name** 覆盖本地档案，
  ///     失败返回可展示文案，本地档案保持原样。
  ///
  /// 为什么要以服务端返回值为准：服务端会 trim、未来还可能做敏感词替换。
  /// 本地照抄输入就会显示一个库里并不存在的昵称 —— 那正是「看着成功」的假象。
  Future<String?> submitRenameChild(
    String name, {
    ActorContext actor = const ActorContext(),
  }) async {
    final String trimmed = name.trim();
    if (trimmed.isEmpty) return '昵称不能为空，这次没有保存。';

    if (!isLiveMode) {
      renameChild(trimmed, actor: actor);
      return null;
    }

    final WriteApi? api = _writeApi;
    if (api == null) return profileReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    // 没有变化就不发请求：PATCH 虽然幂等，但白跑一次往返换不回任何信息，
    // 还要在审计上多写一条「无变化」的判断路径（服务端也要锁一次行）。
    if (profile.name == trimmed) return '昵称没有变化，这次没有提交。';

    _writeInFlight = true;
    try {
      final ChildProfileDto written = await api.renameChild(trimmed);
      if (_disposed) return null;
      profile.name = written.name;
      _persist();
      // 刻意**不**顺手 `refreshFromServer()`：改名只动 `/home` 里的 `child.name`
      // 这一个字段，而它的权威值已经在 PATCH 回包里了。再拉一次只多一次往返，
      // 还可能被一个滞后（读副本 / 缓存）的快照把刚改好的名字盖回去。
      return null;
    } on ArgumentError {
      return '昵称不能为空，这次没有保存。';
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '改名请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _writeInFlight = false;
    }
  }

  // ============================================ 回收站（修 C9）＋ 审计（修 C11）

  /// 写入一条审计 —— **追加式**：只 `insert(0, …)`、永不 UPDATE、永不删除（修 C11）。
  ///
  /// [before] / [after] 一律由 [auditSnapshotOf] **深拷贝**而来。
  /// 存引用的话，写完之后原对象一改，“变更前后”会同时指向那批已变形的值 ——
  /// 审计就成了摆设，而这正是 C11 要防的“看起来在做安全”（docs/design/08 §6）。
  void _audit(
    AuditAction action,
    AuditTargetType targetType,
    String targetId,
    AuditSnapshot? before,
    AuditSnapshot? after,
    ActorContext actor,
  ) {
    auditLog.insert(
      0,
      AuditEntry(
        id: _newId('audit'),
        action: action,
        targetType: targetType,
        targetId: targetId,
        before: before,
        after: after,
        actorRole: actor.role,
        time: DateTime.now(),
      ),
    );
  }

  /// 按类型取**含回收站**的原始列表（只给 store 内部与回收站用）。
  List<SoftDeletable> _listOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return _ruleList;
      case TrashKind.wish:
        return _wishList;
      case TrashKind.habit:
        return _habitList;
    }
  }

  /// 按 id 找出**活着的和回收站里的**那一条（找不到返回 null）。
  static T? _findById<T extends SoftDeletable>(List<T> list, String id) {
    for (final T item in list) {
      if (item.id == id) return item;
    }
    return null;
  }

  // 类型 → 审计动作 / 对象类型。与 Taro 侧的 `${kind}.delete` 是**同一张表**：
  // 写成 switch 而不是拼字符串，枚举穷尽由编译器保证（拼错串只会在半夜才发现）。
  AuditAction _deleteActionOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditAction.pointRuleDelete;
      case TrashKind.wish:
        return AuditAction.wishDelete;
      case TrashKind.habit:
        return AuditAction.habitDelete;
    }
  }

  AuditAction _restoreActionOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditAction.pointRuleRestore;
      case TrashKind.wish:
        return AuditAction.wishRestore;
      case TrashKind.habit:
        return AuditAction.habitRestore;
    }
  }

  AuditAction _purgeActionOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditAction.pointRulePurge;
      case TrashKind.wish:
        return AuditAction.wishPurge;
      case TrashKind.habit:
        return AuditAction.habitPurge;
    }
  }

  AuditTargetType _targetTypeOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditTargetType.pointRule;
      case TrashKind.wish:
        return AuditTargetType.wish;
      case TrashKind.habit:
        return AuditTargetType.habit;
    }
  }

  /// 软删除：**只改 `status` ＋ `deletedAt`，物理数据一律保留** —— 修 C9。
  ///
  /// 原先 `removeWish` / `removeRule` 直接 `remove` 掉对象：误删不可恢复；
  /// 且被删主体一消失，历史流水的回指（`ruleId` / `wishId`）就指向空，
  /// “这 +1 分按什么规则给的”再也无法回答。
  bool _softDelete(SoftDeletable item, TrashKind kind, ActorContext actor) {
    if (item.status == RecordStatus.deleted) return false;
    final AuditSnapshot before = auditSnapshotOf(item.snapshot());
    item.status = RecordStatus.deleted;
    item.deletedAt = DateTime.now();
    _audit(
      _deleteActionOf(kind),
      _targetTypeOf(kind),
      item.id,
      before,
      auditSnapshotOf(item.snapshot()),
      actor,
    );
    return true;
  }

  /// 从回收站恢复：回到 `active` 并清掉 `deletedAt` —— 修 C9。
  bool _restoreItem(SoftDeletable item, TrashKind kind, ActorContext actor) {
    if (item.status != RecordStatus.deleted) return false;
    final AuditSnapshot before = auditSnapshotOf(item.snapshot());
    item.status = RecordStatus.active;
    item.deletedAt = null;
    _audit(
      _restoreActionOf(kind),
      _targetTypeOf(kind),
      item.id,
      before,
      auditSnapshotOf(item.snapshot()),
      actor,
    );
    return true;
  }

  /// 回收站条目（规则 / 心愿 / 习惯三类汇总）—— 修 C9。
  ///
  /// [now] 由调用方传入，好让“90 天边界”可以被确定性地测试（见 [isTrashExpired]）。
  /// 是否**已过期**只是判定；真正清理要等 UI 调 [purgeExpiredTrash] ——
  /// **不做任何自动清理**（过期不等于必须删，产品决定）。
  List<TrashItem> trashItems({DateTime? now}) {
    final DateTime time = now ?? DateTime.now();
    // 分支看 `_readApi`（= 接了服务端的 live 客户端）而不是 `_usingPreview`：
    // `_usingPreview` 只表示「首页还没成功拉过一次」，那时把预览用的演示条目
    // 混进回收站，会让家长看到一堆自己从没删过的东西。live 下就是空列表 +
    // 加载状态（`trashReadStatus`），由页面照实显示。
    if (_readApi != null) {
      // live：条目来自 `GET /trash`（服务端只说"哪条被删了、什么时候删的"），
      // 过期与否在这里用**同一份** 90 天常量现算。
      return _liveTrashRows
          .map(
            (TrashItem item) => TrashItem(
              kind: item.kind,
              id: item.id,
              title: item.title,
              deletedAt: item.deletedAt,
              expired: isTrashExpired(item.deletedAt, now: time),
            ),
          )
          .toList(growable: false)
        ..sort(
            (TrashItem a, TrashItem b) => b.deletedAt.compareTo(a.deletedAt));
    }
    final List<TrashItem> rows = <TrashItem>[];
    void collect(TrashKind kind) {
      for (final SoftDeletable item in trashOnly(_listOf(kind))) {
        rows.add(
          TrashItem(
            kind: kind,
            id: item.id,
            title: item.title,
            // 理论上 `deleted` 必有 `deletedAt`；兜底用 now 只为让展示层免于处理 null
            deletedAt: item.deletedAt ?? time,
            expired: isTrashExpired(item.deletedAt, now: time),
          ),
        );
      }
    }

    collect(TrashKind.pointRule);
    collect(TrashKind.wish);
    collect(TrashKind.habit);
    rows.sort((TrashItem a, TrashItem b) => b.deletedAt.compareTo(a.deletedAt));
    return rows;
  }

  /// 从回收站恢复某一条（按类型 + id 定位）。
  bool restoreTrash(
    TrashKind kind,
    String id, {
    ActorContext actor = const ActorContext(),
  }) {
    final SoftDeletable? item = _findById(_listOf(kind), id);
    if (item == null) return false;
    if (!_restoreItem(item, kind, actor)) return false;
    _persist();
    return true;
  }

  /// 从回收站恢复某条规则（规则页 / 回收站页用）—— 修 C9。
  bool restoreRule(PointRule rule,
          {ActorContext actor = const ActorContext()}) =>
      restoreTrash(TrashKind.pointRule, rule.id, actor: actor);

  /// 从回收站恢复某个心愿（心愿页 / 回收站页用）—— 修 C9。
  bool restoreWish(Wish wish, {ActorContext actor = const ActorContext()}) =>
      restoreTrash(TrashKind.wish, wish.id, actor: actor);

  /// **彻底**删除某条回收站内容 —— 修 C9。
  ///
  /// 只允许删除 `status == deleted` 的条目：列表里的东西想删必须先软删，
  /// 否则“彻底删除”就成了绕过回收站的物理删（C9 又回来了）。
  bool purgeTrash(
    TrashKind kind,
    String id, {
    ActorContext actor = const ActorContext(),
  }) {
    final List<SoftDeletable> list = _listOf(kind);
    final int index = list.indexWhere(
      (SoftDeletable row) => row.id == id && row.status == RecordStatus.deleted,
    );
    if (index < 0) return false;
    final SoftDeletable item = list[index];
    _audit(
      _purgeActionOf(kind),
      _targetTypeOf(kind),
      item.id,
      auditSnapshotOf(item.snapshot()),
      null,
      actor,
    );
    list.removeAt(index);
    _persist();
    return true;
  }

  /// 清理**已过期**（满 90 天）的回收站条目，返回清掉的条数 —— 修 C9。
  ///
  /// **只在 UI 显式调用时执行**（回收站页的“清理已过期”按钮）：
  /// 到期不等于必须删 —— 见 docs/design/08 §3.5（判定是纯函数，动作由产品决定）。
  int purgeExpiredTrash(
      {DateTime? now, ActorContext actor = const ActorContext()}) {
    final DateTime time = now ?? DateTime.now();
    int purged = 0;
    void sweep(List<SoftDeletable> list, TrashKind kind) {
      // 先摘出清单再删：边遍历边删会撞上并发修改异常（与 JS 同罪）
      final List<SoftDeletable> expired = list
          .where(
            (SoftDeletable item) =>
                item.status == RecordStatus.deleted &&
                isTrashExpired(item.deletedAt, now: time),
          )
          .toList();
      for (final SoftDeletable item in expired) {
        _audit(
          _purgeActionOf(kind),
          _targetTypeOf(kind),
          item.id,
          auditSnapshotOf(item.snapshot()),
          null,
          actor,
        );
        list.remove(item);
        purged += 1;
      }
    }

    sweep(_ruleList, TrashKind.pointRule);
    sweep(_wishList, TrashKind.wish);
    sweep(_habitList, TrashKind.habit);
    if (purged > 0) _persist();
    return purged;
  }

  /// 删除首页习惯 —— **软删**（进回收站，90 天内可恢复），修 C9。
  void removeHabit(Habit habit, {ActorContext actor = const ActorContext()}) {
    final Habit? live = _findById(_habitList, habit.id);
    if (live == null) return;
    if (_softDelete(live, TrashKind.habit, actor)) _persist();
  }

  /// 从回收站恢复某个习惯 —— 修 C9。
  bool restoreHabit(Habit habit, {ActorContext actor = const ActorContext()}) =>
      restoreTrash(TrashKind.habit, habit.id, actor: actor);

  // ============================================ 回收站：服务端读写（W5-F）

  /// 拉取回收站（`GET /trash`）—— **进回收站页时**调用，不进首页刷新。
  ///
  /// 失败**不清空**上一次成功的结果：把列表清成「回收站是空的」会让用户
  /// 以为东西已经被彻底删了，那是最坏的一种谎言。错误经 [trashError] 上报，
  /// 页面照实显示（403 = 没有查看资格）。
  Future<void> refreshTrash() async {
    final ReadApiClient? api = _readApi;
    // 纯本地预览（`readApi == null`）：回收站来自本地列表，没有可拉的东西。
    //
    // 这里**刻意不看** `_usingPreview`：那个标志的含义是「首页还没成功拉过一次」，
    // 首页拉失败 / 还没拉完时回收站照样可以独立请求 —— 否则回收站页会停在
    // 「加载中」或直接空白，把一次首页故障放大成两页不可用。
    if (api == null || _disposed) return;
    final int epoch = ++_trashReadEpoch;
    _trashReadStatus = ReadStatus.loading;
    _trashError = null;
    _notify();
    try {
      final TrashListDto dto = await api.fetchTrash();
      if (_disposed || api != _readApi || epoch != _trashReadEpoch) return;
      _trashItems
        ..clear()
        ..addAll(mapTrash(dto));
      _trashReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi || epoch != _trashReadEpoch) return;
      _trashError = error;
      _trashReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi || epoch != _trashReadEpoch) return;
      _trashError = ReadApiException.network(error);
      _trashReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _readApi && epoch == _trashReadEpoch) {
        _notify();
      }
    }
  }

  /// 删除首页习惯（服务端写入口，`DELETE /habits/:id`）—— 修 C9 / W5-F。
  ///
  /// 软删：服务端只改 `status='deleted'` + `deletedAt`，**不碰流水**，
  /// 因此卡片上的历史打卡仍能回指这条习惯。本地镜像立刻跟上，随后刷新。
  Future<String?> submitRemoveHabit(
    Habit habit, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) {
      removeHabit(habit, actor: actor);
      return null;
    }
    final WriteApi? api = _writeApi;
    if (api == null) return habitReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      await api.deleteHabit(
        habit.id,
        idempotencyKey: _newIdempotencyKey('habit-delete'),
      );
      if (_disposed) return null;
      // 先让本地镜像跟上：即使随后的刷新失败，也不会留一条「已删却还在首页」
      // 的习惯（`deletedAt` 用本地时间，刷新成功后以服务端为准）。
      final Habit? local = _findById(_habitList, habit.id);
      if (local != null && local.status != RecordStatus.deleted) {
        local.status = RecordStatus.deleted;
        local.deletedAt = DateTime.now();
        _persist();
      }
      await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '删除请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 从回收站恢复一条（`POST /trash/:kind/:id/restore`）—— W5-F。
  ///
  /// 返回 null 才是成功；字符串是**要展示给用户的失败原因**（409
  /// `TRASH_PARENT_RULE_DELETED` 之类的服务端判定，客户端不自己编）。
  Future<String?> submitRestoreTrash(
    TrashItem item, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) {
      return restoreTrash(item.kind, item.id, actor: actor)
          ? null
          : '这条内容已经不在了，请刷新回收站。';
    }
    final WriteApi? api = _writeApi;
    if (api == null) return trashReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      await api.restoreTrashItem(item.kind.wireName, item.id);
      if (_disposed) return null;
      // 恢复会改变首页 / 规则页 / 心愿页的可见集合 ⇒ 读状态与回收站都要刷新。
      await Future.wait(<Future<void>>[refreshFromServer(), refreshTrash()]);
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '恢复请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 彻底删除一条（`DELETE /trash/:kind/:id`）—— **不可逆**，W5-F。
  ///
  /// 服务端拒绝时（还有流水引用 / 根本没软删）原样返回原因 ——
  /// 这两种「拒绝」都是正确行为，不能当成功。
  Future<String?> submitPurgeTrash(
    TrashItem item, {
    ActorContext actor = const ActorContext(),
  }) async {
    if (!isLiveMode) {
      return purgeTrash(item.kind, item.id, actor: actor)
          ? null
          : '这条内容已经不在回收站里了，请刷新后重试。';
    }
    final WriteApi? api = _writeApi;
    if (api == null) return trashReadOnlyWriteMessage;
    if (_writeInFlight) return '上一次操作正在保存中，请稍候…';

    _writeInFlight = true;
    try {
      await api.purgeTrashItem(item.kind.wireName, item.id);
      if (_disposed) return null;
      _trashItems.removeWhere(
        (TrashItem row) => row.kind == item.kind && row.id == item.id,
      );
      _notify();
      await refreshTrash();
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } catch (error) {
      return '彻底删除请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _writeInFlight = false;
    }
  }

  /// 清理**已过期**（满 90 天）的回收站条目 —— W5-F。
  ///
  /// 批量是**逐条**调的，所以如实把「清掉几条 / 几条没清掉」报回去
  /// （[TrashPurgeOutcome]）：第 3 条失败时前 2 条真的已经删了，
  /// 只说成功或只说失败都是在骗人。
  Future<TrashPurgeOutcome> submitPurgeExpiredTrash({
    DateTime? now,
    ActorContext actor = const ActorContext(),
  }) async {
    final DateTime time = now ?? DateTime.now();
    final List<TrashItem> expired = trashItems(now: time)
        .where((TrashItem item) => item.expired)
        .toList(growable: false);
    if (expired.isEmpty) return const TrashPurgeOutcome(purged: 0);
    if (!isLiveMode) {
      return TrashPurgeOutcome(
        purged: purgeExpiredTrash(now: time, actor: actor),
      );
    }
    final WriteApi? api = _writeApi;
    if (api == null) {
      return TrashPurgeOutcome(purged: 0, error: trashReadOnlyWriteMessage);
    }

    int purged = 0;
    int failed = 0;
    String? firstError;
    for (final TrashItem item in expired) {
      try {
        await api.purgeTrashItem(item.kind.wireName, item.id);
        purged += 1;
        _trashItems.removeWhere(
          (TrashItem row) => row.kind == item.kind && row.id == item.id,
        );
      } on WriteApiException catch (error) {
        failed += 1;
        firstError ??= error.userMessage;
      } catch (error) {
        failed += 1;
        firstError ??= '请求已发出，但结果无法确认。请刷新后查看。';
      }
      if (_disposed) break;
    }
    if (!_disposed && purged > 0) {
      _notify();
      await refreshTrash();
    }
    return TrashPurgeOutcome(
      purged: purged,
      failed: failed,
      error: firstError,
    );
  }

  // ========================================== 家庭成员：服务端读写（W5-H）

  /// 拉取成员列表（`GET /members`）—— **打开成员面板时**调用。
  ///
  /// 失败**不清空**上一次成功的结果：把列表清成「没有成员」会让家长以为
  /// 家人都被移出了；错误经 [membersError] 上报，页面照实显示。
  Future<void> refreshMembers() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) return;
    final int epoch = ++_membersReadEpoch;
    _membersReadStatus = ReadStatus.loading;
    _membersError = null;
    _notify();
    try {
      final MemberListDto dto = await api.fetchMembers();
      if (_disposed || api != _readApi || epoch != _membersReadEpoch) return;
      _members
        ..clear()
        ..addAll(mapMembers(dto));
      _membersReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi || epoch != _membersReadEpoch) return;
      _membersError = error;
      _membersReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi || epoch != _membersReadEpoch) return;
      _membersError = ReadApiException.network(error);
      _membersReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _readApi && epoch == _membersReadEpoch) {
        _notify();
      }
    }
  }

  /// 改成员角色（`PATCH /members/:id`，W5-H）。成功返回 null。
  ///
  /// 目标角色只从**这一行**推出来（家长 ⇄ 孩子）；`viewer` 没有可切目标 ——
  /// 后端也只接受 `guardian` / `child`。
  ///
  /// 不预先校验「我是不是家长」：那条判断来自可能已经过时的列表，
  /// 服务端 403 才是权威 —— 但它会给出一句可执行的中文原因，原样展示。
  Future<String?> submitChangeMemberRole(FamilyMember member) async {
    if (!isLiveMode) return '预览模式没有真实的家庭成员，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) return memberReadOnlyWriteMessage;
    if (_busyMemberId != null) return '上一次成员操作正在保存中，请稍候…';

    if (member.isSelf) {
      return '不能修改自己的家庭成员身份，这次操作没有保存。请让另一位家长来处理。';
    }
    if (!member.isActive) {
      return '这个成员已经被移出家庭了，请刷新成员列表。';
    }
    final MemberRole? target = member.switchableRole;
    if (target == null) {
      return '访客不能改成家长或孩子，这次操作没有保存。';
    }

    _busyMemberId = member.memberId;
    _notify();
    try {
      final MemberDto written = await api.changeMemberRole(
        member.memberId,
        target,
      );
      if (_disposed) return null;
      _replaceMember(written);
      _notify();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 409 / 404：本地这一行已经过时了（别人先改过 / 已被移出）。
      // 刷新后界面才与服务端一致，否则家长会对着一条点不动的行反复点。
      if (error.kind == WriteFailureKind.conflict ||
          error.kind == WriteFailureKind.notFound) {
        await refreshMembers();
      }
      return error.userMessage;
    } catch (error) {
      return '改角色请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _busyMemberId = null;
      _notify();
    }
  }

  /// 移出成员（`DELETE /members/:id`，W5-H）。成功返回 null。
  ///
  /// 服务端只做软删并保留会话，因此这里成功后直接把该行从列表里去掉，
  /// 不需要额外重拉 —— DELETE 回包已经确认了「哪一行、什么时候被移出」。
  Future<String?> submitRemoveMember(FamilyMember member) async {
    if (!isLiveMode) return '预览模式没有真实的家庭成员，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) return memberReadOnlyWriteMessage;
    if (_busyMemberId != null) return '上一次成员操作正在保存中，请稍候…';

    if (member.isSelf) {
      return '不能移出自己，这次操作没有保存。请让另一位家长来处理。';
    }
    if (!member.isActive) {
      return '这个成员已经被移出家庭了，请刷新成员列表。';
    }

    _busyMemberId = member.memberId;
    _notify();
    try {
      final MemberRemoveDto written = await api.removeMember(member.memberId);
      if (_disposed) return null;
      if (written.memberId != member.memberId) {
        // 客户端已经在 API 层校验过；这里再守一次，避免「删了别人」被当成功。
        await refreshMembers();
        return '服务端返回的成员与这次操作不一致，请刷新成员列表确认。';
      }
      _members.removeWhere(
        (FamilyMember row) => row.memberId == member.memberId,
      );
      _notify();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.kind == WriteFailureKind.conflict ||
          error.kind == WriteFailureKind.notFound) {
        await refreshMembers();
      }
      return error.userMessage;
    } catch (error) {
      return '移出请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _busyMemberId = null;
      _notify();
    }
  }

  /// 用写接口回包刷新本地那一行（服务端是权威值：角色 / 昵称 / 时间）。
  void _replaceMember(MemberDto dto) {
    for (int index = 0; index < _members.length; index++) {
      if (_members[index].memberId == dto.memberId) {
        _members[index] = mapMember(dto);
        return;
      }
    }
    // 本行还不在列表里（例如面板没拉过）—— 不凭空造行，交给下一次刷新。
  }

  // ========================================== 邀请码：服务端读写（W5-I）

  /// 拉取邀请码列表（`GET /invites`）—— **打开邀请码面板时**调用。
  ///
  /// 只有家长能看（`invite_member` guardian ALLOW）；调用方先用
  /// [canManageInvites] 判断，孩子视角不要发这个请求。
  ///
  /// 失败**不清空**上一次成功的结果：把列表清空会变成「邀请码都没了」，
  /// 而实际可能只是断网；错误经 [invitesError] 上报。
  Future<void> refreshInvites() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) return;
    final int epoch = ++_invitesReadEpoch;
    _invitesReadStatus = ReadStatus.loading;
    _invitesError = null;
    _notify();
    try {
      final InviteListDto dto = await api.fetchInvites();
      if (_disposed || api != _readApi || epoch != _invitesReadEpoch) return;
      _invites
        ..clear()
        ..addAll(mapInvites(dto));
      _invitesReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi || epoch != _invitesReadEpoch) return;
      _invitesError = error;
      _invitesReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi || epoch != _invitesReadEpoch) return;
      _invitesError = ReadApiException.network(error);
      _invitesReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _readApi && epoch == _invitesReadEpoch) {
        _notify();
      }
    }
  }

  /// 生成邀请码（`POST /invites`，W5-I）。成功返回 null。
  ///
  /// 回包是**新码全量行**，直接插到列表头 —— 不重拉整页：重拉会让「刚生成
  /// 的那个码」排到服务端顺序里的某个位置，用户复制错了就是别人的码。
  ///
  /// 参数范围在 `WriteApiClient.createInvite` 里先拦一次（与后端 DTO 同口径），
  /// 这里只做「现在能不能写」的判断。
  Future<String?> submitCreateInvite({
    required MemberRole role,
    required int maxUses,
    required int expiresInDays,
  }) async {
    if (!isLiveMode) return '预览模式没有真实的邀请码，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) return inviteReadOnlyWriteMessage;
    if (isInviteWriteBusy) return '上一次邀请码操作正在保存中，请稍候…';
    if (role != MemberRole.guardian && role != MemberRole.child) {
      return '邀请码只能邀请「孩子」或「家长」，这次没有提交。';
    }

    _creatingInvite = true;
    _notify();
    try {
      final InviteDto written = await api.createInvite(
        role: role,
        maxUses: maxUses,
        expiresInDays: expiresInDays,
      );
      if (_disposed) return null;
      _invites.insert(0, mapInvite(written));
      _notify();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 403（不是家长）/ 409（撞码）：列表的「当前身份」或内容可能需要重看，
      // 刷新一次比让家长对着旧状态再点一次更省事。
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict) {
        await refreshInvites();
      }
      return error.userMessage;
    } catch (error) {
      return '生成邀请码的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _creatingInvite = false;
      _notify();
    }
  }

  /// 吊销邀请码（`POST /invites/:id/revoke`，W5-I）。成功返回 null。
  ///
  /// 服务端构造幂等（已吊销再吊销仍是 200、不写第二条审计），所以这里
  /// 成功后只把这一行标成吊销 —— 不重拉、也不提示「已吊销过一次」。
  Future<String?> submitRevokeInvite(InviteCode invite) async {
    if (!isLiveMode) return '预览模式没有真实的邀请码，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) return inviteReadOnlyWriteMessage;
    if (isInviteWriteBusy) return '上一次邀请码操作正在保存中，请稍候…';
    if (invite.revoked) return '这个邀请码已经吊销过了，不需要重复吊销。';

    _busyInviteId = invite.id;
    _notify();
    try {
      final InviteRevokeDto written = await api.revokeInvite(invite.id);
      if (_disposed) return null;
      if (written.id != invite.id) {
        // API 层已验过；这里再守一次，避免「吊销了别的码」被当成功。
        await refreshInvites();
        return '服务端返回的邀请码与这次操作不一致，请刷新邀请码列表确认。';
      }
      for (int index = 0; index < _invites.length; index++) {
        if (_invites[index].id == invite.id) {
          _invites[index] = _invites[index].revokedCopy();
          break;
        }
      }
      _notify();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 404：这一行已经不在了（别的设备删过 / 不属于这个孩子）。
      if (error.kind == WriteFailureKind.notFound ||
          error.kind == WriteFailureKind.conflict) {
        await refreshInvites();
      }
      return error.userMessage;
    } catch (error) {
      return '吊销请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _busyInviteId = null;
      _notify();
    }
  }

  // ========================================== 监护人同意：服务端读写（W7-B）

  /// 拉取同意状态（`GET /consent`）—— **打开同意面板时**调用。
  ///
  /// 只有家长能看（`view_consent` guardian ALLOW / child DENY）；调用方先用
  /// [canManageConsent] 判断，孩子视角不要发这个请求（否则每次都是 403）。
  ///
  /// 失败**不清空**上一次成功的结果：把状态改写成「未同意」是最坏的一种
  /// 谎言 —— 家长会以为同意丢了，孩子会看到一个假的按钮。错误经
  /// [consentError] 上报，面板照实显示。
  Future<void> refreshConsent() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) return;
    final int epoch = ++_consentReadEpoch;
    _consentReadStatus = ReadStatus.loading;
    _consentError = null;
    _notify();
    try {
      final ConsentStateDto dto = await api.fetchConsent();
      if (_disposed || api != _readApi || epoch != _consentReadEpoch) return;
      _consent = mapConsent(dto);
      _consentReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi || epoch != _consentReadEpoch) return;
      _consentError = error;
      _consentReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi || epoch != _consentReadEpoch) return;
      _consentError = ReadApiException.network(error);
      _consentReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _readApi && epoch == _consentReadEpoch) {
        _notify();
      }
    }
  }

  /// 作出同意（`POST /consent`，W7-B）。成功返回 null。
  ///
  /// 服务端构造幂等（已同意再调仍是 200、`grantedAt` 保持第一次的时间），
  /// 因此成功后直接用回包替换本地快照 —— 不重拉整份状态，也不提示
  /// 「已经同意过一次」。
  Future<String?> submitGrantConsent() async {
    if (!isLiveMode) return '预览模式没有真实的同意记录，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) return consentReadOnlyWriteMessage;
    if (_consentWriteBusy) return '上一次同意操作正在保存中，请稍候…';

    _consentWriteBusy = true;
    _notify();
    try {
      final ConsentStateDto written = await api.grantConsent();
      if (_disposed) return null;
      _consent = mapConsent(written);
      _consentReadStatus = ReadStatus.ready;
      _consentError = null;
      _notify();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 403 / 409：本地快照可能已经过时（角色被降级 / 另一台设备刚撤回）。
      // 拉一次真状态，比让家长对着旧状态再点一次更诚实。
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict) {
        await refreshConsent();
      }
      return error.userMessage;
    } catch (error) {
      return '同意请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _consentWriteBusy = false;
      _notify();
    }
  }

  /// 撤回同意（`POST /consent/withdraw`，W7-B）。成功返回 null。
  ///
  /// 撤回后写动作会被 `ConsentGuard` 拦成 403 `CONSENT_REQUIRED`；读取与
  /// 重新同意不受影响 —— 面板必须把这句话说出来，否则家长会以为
  /// 「撤回 = 数据被删了」。
  ///
  /// 回包状态是 `withdrawn`（曾同意过）或 `none`（从没同意过）：两种都
  /// 可以用同一个快照替换，界面按 `statusLabel` 区分。
  Future<String?> submitWithdrawConsent() async {
    if (!isLiveMode) return '预览模式没有真实的同意记录，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) return consentReadOnlyWriteMessage;
    if (_consentWriteBusy) return '上一次同意操作正在保存中，请稍候…';
    if (_consent.isWithdrawn) return '同意已经撤回过了，不需要重复撤回。';

    _consentWriteBusy = true;
    _notify();
    try {
      final ConsentStateDto written = await api.withdrawConsent();
      if (_disposed) return null;
      _consent = mapConsent(written);
      _consentReadStatus = ReadStatus.ready;
      _consentError = null;
      _notify();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict) {
        await refreshConsent();
      }
      return error.userMessage;
    } catch (error) {
      return '撤回请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _consentWriteBusy = false;
      _notify();
    }
  }

  // ============================================ 首启引导：服务端读写（W8-B）

  /// 拉取引导状态与模板库（`GET /onboarding`）—— **启动时**调用一次。
  ///
  /// 与同意 / 导出不同，它不是「打开面板才拉」：`onboardedAt` 是权威状态，
  /// 客户端不缓存（`04` §3）。闸门（`OnboardingGate`）靠它决定进首页还是进引导。
  ///
  /// 失败**不清空**上一次的快照：一次断网不该把「已完成引导」说成「未引导」，
  /// 也不该让已经走完的流程重新出现。错误经 [onboardingError] 上报，
  /// 闸门在「状态未知」时放行到首页（宁可少拦一次，也不要把应用锁死）。
  Future<void> refreshOnboarding() async {
    final OnboardingApi? api = _onboardingApi;
    if (api == null || _disposed) return;
    final int epoch = ++_onboardingReadEpoch;
    _onboardingReadStatus = ReadStatus.loading;
    _onboardingError = null;
    _notify();
    try {
      final OnboardingViewDto dto = await api.fetch();
      if (_disposed || api != _onboardingApi || epoch != _onboardingReadEpoch) {
        return;
      }
      _onboarding = mapOnboardingView(dto);
      _onboardingReadStatus = ReadStatus.ready;
    } on WriteApiException catch (error) {
      if (_disposed || api != _onboardingApi || epoch != _onboardingReadEpoch) {
        return;
      }
      _onboardingError = error.userMessage;
      _onboardingReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _onboardingApi || epoch != _onboardingReadEpoch) {
        return;
      }
      _onboardingError = '读取引导状态时发生意外错误。请重试。';
      _onboardingReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _onboardingApi && epoch == _onboardingReadEpoch) {
        _notify();
      }
    }
  }

  /// 保存第③④步的草稿（`PATCH /onboarding/profile`）。成功返回 null。
  ///
  /// 三种意图必须可分（与后端 DTO 逐字同义）：
  ///   · 都不传                ⇒ 什么都没改（本地直接返回 null，**不发请求**）；
  ///   · `clearAgeBand = true` ⇒ 显式清空学段；
  ///   · `focusAreas = []`     ⇒ 「一个都不选」。
  ///
  /// 失败时**不改本地快照**：让界面继续显示「上次真正落库的值」，
  /// 家长可以重试；把失败当成成功会把第⑤步的排序解释成另一套。
  Future<String?> saveOnboardingDraft({
    AgeBand? ageBand,
    bool clearAgeBand = false,
    List<String>? focusAreas,
  }) async {
    final OnboardingApi? api = _onboardingApi;
    if (api == null) return '当前没有接入后端，这次没有保存。';
    if (!clearAgeBand && ageBand == null && focusAreas == null) return null;
    if (_onboardingWriteBusy) return '上一次保存正在提交，请稍候…';

    _onboardingWriteBusy = true;
    _notify();
    try {
      final OnboardingStateDto dto = await api.saveProfile(
        ageBand: ageBand,
        clearAgeBand: clearAgeBand,
        focusAreas: focusAreas,
      );
      if (_disposed) return null;
      final OnboardingStateDraft draft = mapOnboardingState(dto);
      final OnboardingView? current = _onboarding;
      if (current == null) {
        // 没有模板快照时无法合并（第⑤步会一条约定都画不出来）—— 重拉一次整体状态。
        await refreshOnboarding();
      } else {
        _onboarding = current.withDraft(
          ageBand: draft.ageBand,
          clearAgeBand: draft.ageBand == null,
          focusAreas: draft.focusAreas,
        );
      }
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 403（没同意 / 不是家长）/ 409（已经完成过）：本地快照可能已过时。
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict) {
        await refreshOnboarding();
      }
      return error.userMessage;
    } catch (error) {
      return '保存请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _onboardingWriteBusy = false;
      _notify();
    }
  }

  /// 完成引导（`POST /onboarding/complete`）：采纳模板 + 可选 PIN。成功返回 null。
  ///
  /// ── 为什么还要逐个「加入今日习惯」 ──────────────────────────────────────────
  ///   `complete` 只把模板复制成 `PointRule`（`04` §3「复制而非引用」），
  ///   而首页打卡用的是 `Habit`。`04` §6 4.3 要求「首页出现 3 个习惯」——
  ///   因此这里用**既有**端点 `POST /point-rules/:id/habits` 逐条生成，
  ///   扣分约定按 A1 的规则**不加**（它本来也不该成为孩子主动打卡的习惯）。
  ///   单条失败不回滚已完成引导：把已成功的规则说成没成功才是更大的谎。
  ///
  /// ── 为什么最后要 `refreshFromServer()` ──────────────────────────────────────
  ///   首页的余额 / 习惯 / 规则全部来自服务端快照；引导刚建了 N 条规则与若干习惯，
  ///   不刷新就会进到一个「已完成引导但首页还是空的」页面。
  Future<String?> completeOnboarding({
    required List<String> templateSlugs,
    AgeBand? ageBand,
    List<String>? focusAreas,
    String? parentPin,
  }) async {
    final OnboardingApi? api = _onboardingApi;
    if (api == null) return '当前没有接入后端，引导无法完成。';
    if (_onboardingWriteBusy) return '上一次提交正在保存中，请稍候…';

    _onboardingWriteBusy = true;
    _notify();
    try {
      final OnboardingResultDto dto = await api.complete(
        templateSlugs: templateSlugs,
        ageBand: ageBand,
        focusAreas: focusAreas,
        parentPin: parentPin,
      );
      if (_disposed) return null;
      final OnboardingResult result = mapOnboardingResult(dto);
      _lastOnboardingResult = result;
      _lastOnboardingHabitCount = 0;
      _lastOnboardingManualTitles = <String>[];

      final OnboardingView? current = _onboarding;
      _onboarding = current == null
          ? OnboardingView(
              childId: result.childId,
              onboarded: true,
              onboardedAt: result.onboardedAt,
              ageBand: ageBand,
              focusAreas: focusAreas ?? const <String>[],
              templates: const <RuleTemplate>[],
            )
          : current
              .markCompleted(result.onboardedAt)
              .withDraft(ageBand: ageBand, focusAreas: focusAreas);

      await _attachOnboardingHabits(result.rules);
      if (!_disposed) await refreshFromServer();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 409 `ONBOARDING_ALREADY_COMPLETED`：另一台设备 / 上一次请求其实成功了。
      // 拉一次真状态，让闸门按服务端事实放行，而不是把用户卡在引导里重试。
      if (error.kind == WriteFailureKind.conflict ||
          error.kind == WriteFailureKind.forbidden) {
        await refreshOnboarding();
      }
      return error.userMessage;
    } catch (error) {
      return '完成引导的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _onboardingWriteBusy = false;
      _notify();
    }
  }

  /// 把刚采纳的规则逐条变成首页习惯。
  ///
  /// 409 `HABIT_ALREADY_EXISTS` 视为**已在习惯里**（可能是重试 / 另一台设备刚加过），
  /// 计成功；扣分约定与其它失败进 [lastOnboardingManualTitles]，由第⑦步如实列出。
  Future<void> _attachOnboardingHabits(
    List<OnboardingCreatedRule> rules,
  ) async {
    final WriteApi? api = _writeApi;
    final List<String> manual = <String>[];
    int created = 0;
    for (final OnboardingCreatedRule rule in rules) {
      if (rule.isPenalty) {
        // A1：扣分规则不能变成「孩子打卡加分」的习惯，服务端也会拒绝。
        manual.add(rule.title);
        continue;
      }
      if (api == null) {
        manual.add(rule.title);
        continue;
      }
      try {
        final HabitDto dto = await api.addHabitFromRule(
          rule.ruleId,
          idempotencyKey: _newIdempotencyKey('onboarding-habit'),
        );
        if (_disposed) return;
        _applyHabitDto(dto);
        created++;
      } on WriteApiException catch (error) {
        if (error.kind == WriteFailureKind.conflict) {
          // 已经在习惯里 —— 对家长来说结果一样，不列进「需要手动处理」。
          created++;
          continue;
        }
        manual.add(rule.title);
      } catch (error) {
        manual.add(rule.title);
      }
    }
    _lastOnboardingHabitCount = created;
    _lastOnboardingManualTitles = manual;
    _notify();
  }


  // ========================================== 家庭数据导出：服务端读取（W7-C）

  /// 下载家庭数据导出文件（`GET /export`）—— **打开导出面板时**调用。
  ///
  /// 只有家长能导出（`export_family_data` 在矩阵里 guardian ALLOW / child DENY）；
  /// 调用方先用 [canExportFamilyData] 判断，孩子视角不要发这个请求 ——
  /// 否则每次都是 403，还会把「没有权限」画成「加载失败」。
  ///
  /// ── 与同意状态的**关键差别** ────────────────────────────────────────────────
  ///   导出**不受** `ConsentGuard` 管辖：撤回同意后仍然必须可用
  ///   （04 §5 的可携带权 —— 家长撤回后想把自己提供的数据取走，
  ///   正是这个权利最典型的场景）。因此这里刻意**不读** `_consent`：
  ///   任何「先确认同意生效」的前置判断都会把「撤回」变成「数据扣留」。
  ///
  /// 失败**不清空**上一次成功的结果（家长可能刚复制过一份，界面不该突然说
  /// 「没有文件」）；错误经 [exportError] 上报，面板照实显示。
  Future<void> loadExport() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) {
      // 预览模式没有服务端数据 —— 直接进入 ready 空态，而不是发一个只会 401
      // 的请求再把 401 说成「网络错误」。
      _familyExport = null;
      _exportReadStatus = ReadStatus.ready;
      _exportError = null;
      _notify();
      return;
    }
    // 单飞：连点只会拿到**一份**文件。因此这里不需要 epoch ——
    // 同一时刻不存在两个在途请求，也就没有「旧响应覆盖新响应」的问题。
    if (_exportBusy) return;
    _exportBusy = true;
    _exportReadStatus = ReadStatus.loading;
    _exportError = null;
    _notify();
    try {
      final FamilyExportDto dto = await api.fetchExport();
      if (_disposed || api != _readApi) return;
      _familyExport = mapFamilyExport(dto);
      _exportReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi) return;
      _exportError = error;
      _exportReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi) return;
      _exportError = ReadApiException.network(error);
      _exportReadStatus = ReadStatus.error;
    } finally {
      _exportBusy = false;
      if (!_disposed && api == _readApi) _notify();
    }
  }

  // ========================================== 家庭数据删除：服务端读写（W7-D）

  /// 拉取删除状态（`GET /family-deletion`）—— **打开删除面板时**调用。
  ///
  /// 只有家长能看（`view_family_deletion` 在矩阵里 guardian ALLOW / child DENY）；
  /// 调用方先用 [canManageFamilyDeletion] 判断，孩子视角不要发这个请求。
  ///
  /// 失败**不清空**上一次成功的结果（家长可能正对着「将于 X 日删除」做决定，
  /// 界面不该因为一次断网突然说「从未申请」）；错误经 [deletionError] 上报。
  Future<void> loadFamilyDeletion() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) {
      // 预览模式没有服务端删除状态 —— 进入 ready 空态，而不是发一个只会 401 的请求。
      _familyDeletion = null;
      _deletionReadStatus = ReadStatus.ready;
      _deletionError = null;
      _notify();
      return;
    }
    final int epoch = ++_deletionReadEpoch;
    _deletionReadStatus = ReadStatus.loading;
    _deletionError = null;
    _notify();
    try {
      final FamilyDeletionStateDto dto = await api.fetchFamilyDeletion();
      if (_disposed || api != _readApi || epoch != _deletionReadEpoch) return;
      _familyDeletion = mapFamilyDeletion(dto);
      _deletionReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi || epoch != _deletionReadEpoch) return;
      _deletionError = error;
      _deletionReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi || epoch != _deletionReadEpoch) return;
      _deletionError = ReadApiException.network(error);
      _deletionReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _readApi && epoch == _deletionReadEpoch) {
        _notify();
      }
    }
  }

  /// 申请删除（`POST /family-deletion`，`{confirmed: true}`）。成功返回 null。
  ///
  /// ★ 二次确认在**界面**完成（家长要先展开警告、再点「确认删除」）；
  ///   这个方法的调用本身就是「已经确认过」的表达，但它仍然显式发送
  ///   `confirmed: true` —— 服务端不接受「默认同意」，客户端也不假装它接受。
  ///
  /// 构造幂等：已在冷却期再调仍是 200、回同一条请求（`requestedAt` 不变），
  /// 因此成功后直接用回包替换本地状态，不提示「已经申请过一次」。
  Future<String?> requestFamilyDeletion() async {
    if (!isLiveMode) return '预览模式没有真实的家庭数据，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) {
      return '只读模式：删除状态暂时写不进去（写客户端未就绪），这次没有提交到服务器。';
    }
    if (_deletionBusy) return '上一次删除操作正在提交中，请稍候…';

    _deletionBusy = true;
    _notify();
    try {
      final FamilyDeletionStateDto written = await api.requestFamilyDeletion();
      if (_disposed) return null;
      _familyDeletion = mapFamilyDeletion(written);
      _deletionReadStatus = ReadStatus.ready;
      _deletionError = null;
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 403 / 409：本地状态可能已经过时（角色被降级 / 另一台设备刚执行了删除）。
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict) {
        await loadFamilyDeletion();
      }
      return error.userMessage;
    } catch (error) {
      return '删除申请已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _deletionBusy = false;
      _notify();
    }
  }

  /// 撤销待执行的删除（`POST /family-deletion/cancel`）。成功返回 null。
  ///
  /// 没有 pending 时服务端回 409 `FAMILY_DELETION_NOT_PENDING` —— 那不是
  /// 「现在不能撤销」而是「没有可撤销的对象」；这里照实上报并刷新状态，
  /// 让界面显示真实状态，而不是把按钮留在那里继续骗人。
  Future<String?> cancelFamilyDeletion() async {
    if (!isLiveMode) return '预览模式没有真实的家庭数据，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) {
      return '只读模式：删除状态暂时写不进去（写客户端未就绪），这次没有提交到服务器。';
    }
    if (_deletionBusy) return '上一次删除操作正在提交中，请稍候…';
    final FamilyDeletion? current = _familyDeletion;
    if (current != null && !current.canCancel) {
      return '当前没有可以撤销的删除请求。';
    }

    _deletionBusy = true;
    _notify();
    try {
      final FamilyDeletionStateDto written = await api.cancelFamilyDeletion();
      if (_disposed) return null;
      _familyDeletion = mapFamilyDeletion(written);
      _deletionReadStatus = ReadStatus.ready;
      _deletionError = null;
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict) {
        await loadFamilyDeletion();
      }
      return error.userMessage;
    } catch (error) {
      return '撤销请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _deletionBusy = false;
      _notify();
    }
  }

  // ========================================== 站内通知：服务端读写（W5-L）

  /// 拉取通知第一页（`GET /notifications`）—— **打开通知面板时**调用。
  ///
  /// 预览模式没有真实的站内通知（行由服务端在审批出结果时写入）——
  /// 直接进入 `ready` 空态：面板据此说「预览模式没有消息」，而不是发一个
  /// 只会 401 的请求，再把 401 说成「网络错误」。
  ///
  /// 失败**不清空**上一次成功的结果：把列表清空会变成「消息都没了」，
  /// 而实际可能只是断网；错误经 [notificationsError] 上报。
  Future<void> refreshNotifications() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) {
      _notifications.clear();
      _notificationsReadStatus = ReadStatus.ready;
      _notificationsError = null;
      _notificationsCursor = null;
      _notificationsHasMore = false;
      _unreadNotificationCount = 0;
      _notify();
      return;
    }
    final int epoch = ++_notificationsReadEpoch;
    _notificationsReadStatus = ReadStatus.loading;
    _notificationsError = null;
    _notify();
    try {
      final NotificationsPageDto dto = await api.fetchNotifications(
        limit: _notificationsPageSize,
      );
      if (_disposed || api != _readApi || epoch != _notificationsReadEpoch) {
        return;
      }
      // 列表刷新拿到的是整页 + 整份未读数：同时让在途的「红点单查」失效，
      // 否则一个更早的红点响应可能把刚拉到的未读数盖回旧值。
      _notificationBadgeEpoch++;
      _notifications
        ..clear()
        ..addAll(dto.items);
      _notificationsCursor = dto.nextCursor;
      _notificationsHasMore = dto.hasMore;
      _unreadNotificationCount = dto.unreadCount;
      _notificationsReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi || epoch != _notificationsReadEpoch) {
        return;
      }
      _notificationsError = error;
      _notificationsReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi || epoch != _notificationsReadEpoch) {
        return;
      }
      _notificationsError = ReadApiException.network(error);
      _notificationsReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _readApi && epoch == _notificationsReadEpoch) {
        _notify();
      }
    }
  }

  /// 拉下一页（面板滚到底时调用）。没有下一页 / 上一页还在途时**直接返回**，
  /// 不发一个游标为空的请求（那会被服务端判成第一页，把列表打乱）。
  Future<void> loadMoreNotifications() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) return;
    final String? cursor = _notificationsCursor;
    if (!_notificationsHasMore || cursor == null || cursor.isEmpty) return;
    if (_notificationsReadStatus == ReadStatus.loading) return;

    // 不自增 epoch：这是同一个「列表会话」的下一页，不该作废第一页。
    final int epoch = _notificationsReadEpoch;
    _notificationsReadStatus = ReadStatus.loading;
    _notificationsError = null;
    _notify();
    try {
      final NotificationsPageDto dto = await api.fetchNotifications(
        limit: _notificationsPageSize,
        cursor: cursor,
      );
      if (_disposed || api != _readApi || epoch != _notificationsReadEpoch) {
        return;
      }
      // 去重：两次请求之间若有新通知写入，键集分页可能让同一行出现在两页。
      final Set<String> seen =
          _notifications.map((NotificationDto item) => item.id).toSet();
      for (final NotificationDto item in dto.items) {
        if (seen.add(item.id)) _notifications.add(item);
      }
      _notificationsCursor = dto.nextCursor;
      _notificationsHasMore = dto.hasMore;
      _unreadNotificationCount = dto.unreadCount;
      _notificationsReadStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (_disposed || api != _readApi || epoch != _notificationsReadEpoch) {
        return;
      }
      _notificationsError = error;
      _notificationsReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _readApi || epoch != _notificationsReadEpoch) {
        return;
      }
      _notificationsError = ReadApiException.network(error);
      _notificationsReadStatus = ReadStatus.error;
    } finally {
      if (!_disposed && api == _readApi && epoch == _notificationsReadEpoch) {
        _notify();
      }
    }
  }

  /// 只刷新未读红点（`GET /notifications?limit=1`）—— 进「我的」页时调用。
  ///
  /// ★ 为什么单独一条：红点要出现在通知入口上，而列表只在面板打开时才需要。
  ///   只用 `limit=1` 换 `unreadCount`，不覆盖列表现有内容。
  ///
  /// ★ 失败**保持上一次的值**，绝不把「取不到」画成「没有未读」——
  ///   红点消失比红点迟到更糟（用户会以为已经看完了）。
  Future<void> refreshUnreadNotificationCount() async {
    final ReadApiClient? api = _readApi;
    if (api == null || _disposed) return;
    final int epoch = ++_notificationBadgeEpoch;
    try {
      final NotificationsPageDto dto = await api.fetchNotifications(limit: 1);
      if (_disposed || api != _readApi || epoch != _notificationBadgeEpoch) {
        return;
      }
      _unreadNotificationCount = dto.unreadCount;
      _notify();
    } catch (_) {
      // 红点是提示性信息：静默失败即可（面板打开时还有一次完整列表可重试）。
    }
  }

  /// 标记一条通知已读（`PATCH /notifications/:id/read`，W5-L）。成功返回 null。
  ///
  /// 只把**这一行**改成本地已读，并把未读数减一 —— 不重拉整页：
  /// 重拉会让「刚点开的那条」在列表里跳位置，用户会以为点错了行。
  /// `readAt` 用**服务端**回包（已读再调时是第一次的时间）。
  ///
  /// 404 = 这条通知已经不在（服务端清过 / 不是发给我的）：刷新列表，
  /// 让界面与服务端一致，而不是留一条点不动的行。
  Future<String?> markNotificationRead(NotificationDto notification) async {
    if (!isLiveMode) return '预览模式没有真实的站内通知，这次没有提交。';
    final WriteApi? api = _writeApi;
    if (api == null) return notificationReadOnlyWriteMessage;
    if (!notification.isUnread) return null;
    if (_busyNotificationId != null) return '上一条通知正在标记，请稍候…';

    _busyNotificationId = notification.id;
    _notify();
    try {
      final NotificationReadDto written =
          await api.markNotificationRead(notification.id);
      if (_disposed) return null;
      if (written.id != notification.id) {
        // API 层已验过；这里再守一次，避免「标记了别人那条」被当成功。
        await refreshNotifications();
        return '服务端返回的通知与这次操作不一致，请刷新消息列表确认。';
      }
      _applyNotificationRead(written);
      _notify();
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.kind == WriteFailureKind.notFound) {
        await refreshNotifications();
      }
      return error.userMessage;
    } catch (error) {
      return '标记已读的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _busyNotificationId = null;
      _notify();
    }
  }

  /// 把服务端的已读结果写到本地那一行，并同步未读数。
  void _applyNotificationRead(NotificationReadDto dto) {
    for (int index = 0; index < _notifications.length; index++) {
      if (_notifications[index].id != dto.id) continue;
      final bool wasUnread = _notifications[index].isUnread;
      _notifications[index] = _notifications[index].markedRead(dto.readAt);
      if (wasUnread && _unreadNotificationCount > 0) {
        _unreadNotificationCount--;
      }
      return;
    }
    // 这一行不在本地列表里（例如只刷新过红点）：不凭空造行，未读数也不猜 ——
    // 交给下一次 `refreshNotifications()`（它带整份 unreadCount）。
  }

  // =================================================== 规则编辑（修 C10）

  /// 某条规则**当前**的版本号（规则不在体系里时 null）。
  int? _currentRuleVersion(String? ruleId) {
    if (ruleId == null) return null;
    for (final PointRule rule in _ruleList) {
      if (rule.id == ruleId) return rule.currentVersion;
    }
    return null;
  }

  /// 编辑规则 —— **四步一笔**（docs/design/02 §5.3：读版本 → 归档版本 →
  /// 更新规则 → 写审计），修 C10。
  ///
  /// 四件事在**一次调用里做完、只 `_persist()` 一次**：分成两次调用就会留下
  /// “改了但没记”的窗口 —— 那正是 C10 ＋ C11 要一起防的东西。
  ///
  /// 时间线语义（§3.2 / `02` §5.4）：**历史不可回溯、未来从新规**。
  /// 已发生流水的 `points` / `ruleVersion` **一字不动**；由这条规则派生的
  /// 首页习惯跟着新规走，于是“今日剩余额度”自然按新规重算（A3 的派生设计）。
  ///
  /// 成功返回 null，失败返回提示文案（与 [addRule] 同约定）。
  String? updateRule(
    PointRule rule, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    // 变更说明，写进版本记录（家长回看“为什么改”）
    String changeNote = '',
    ActorContext actor = const ActorContext(),
  }) {
    final PointRule? live = _findById(_ruleList, rule.id);
    if (live == null) return '这条规则已经不在了';
    if (live.status == RecordStatus.deleted) {
      return '“${live.title}”在回收站里，先恢复再改';
    }
    if (!isDailyLimitValid(dailyLimit)) {
      return '每天次数只能是 $dailyLimitMin–$dailyLimitMax 之间的整数';
    }
    final String nextTitle = title.trim().isEmpty ? live.title : title.trim();
    final String nextCondition =
        condition.trim().isEmpty ? '家长约定' : condition.trim();
    if (nextTitle == live.title &&
        nextCondition == live.condition &&
        dailyLimit == live.dailyLimit &&
        points == live.points) {
      return '没有改动，规则保持原样';
    }

    final DateTime time = DateTime.now();
    final AuditSnapshot changed = auditSnapshotOf(live.snapshot());
    final int version = live.currentVersion + 1;

    // ① 先归档新版本（装的**是**新值）—— 顺序不能反：先改 `PointRule` 再补版本，
    //    中间那一瞬 `currentVersion` 会指向一条不存在的版本记录（回放即见空档）。
    ruleVersions.add(
      RuleVersion(
        id: _newId('rv'),
        ruleId: live.id,
        version: version,
        title: nextTitle,
        condition: nextCondition,
        dailyLimit: dailyLimit,
        points: points,
        changedByRole: actor.role,
        changedAt: time,
        changeNote: changeNote.trim(),
      ),
    );

    // ② 原地更新规则本体 —— **`id` 不变**（改价不等于换对象，否则历史断裂）
    live.title = nextTitle;
    live.condition = nextCondition;
    live.dailyLimit = dailyLimit;
    live.points = points;
    live.currentVersion = version;

    // ③ 派生同步：由这条规则生成的首页习惯跟着新规走（§3.2「未来从新规」）。
    //    习惯是规则的**派生**，不单独记审计 —— 否则一次改动会产生两条审计，
    //    回放时会把“同步”误读成一次独立变更。
    for (final Habit habit in _habitList) {
      if (habit.ruleId != live.id) continue;
      habit.title = live.title;
      habit.condition = live.condition;
      habit.dailyLimit = live.dailyLimit;
      habit.points = live.points;
      habit.iconName = live.iconName;
      habit.color = live.color;
    }

    // ④ 记一条审计（`before` / `after` 是真快照）
    _audit(
      AuditAction.pointRuleUpdate,
      AuditTargetType.pointRule,
      live.id,
      changed,
      auditSnapshotOf(live.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  ///
  /// 今日“这条规则”已经产生几次表扬流水 —— 给 §3.3 的影响提示用（修 C10）。
  /// 直接复用 [checkedCountTodayByRule] 的同一口径，别在页面里另算一遍。
  int checkedCountTodayOfRule(PointRule rule, {DateTime? now}) =>
      checkedCountTodayByRule(records, rule.id, now: now);

  // ==================================== 家长模式 ＋ 家长 PIN（W8-C）

  /// 拉当前家长模式状态（`GET /auth/parent-mode`）。
  ///
  /// 打开面板时调用；App 冷启动**不**调用 —— 孩子每天打开 App 都多发一次请求
  /// 没有收益，而入口在「我的」页，点开时再问一次就够。
  ///
  /// 失败**不清空**上一次成功的快照：家长可能刚看到「还剩 4:12」，
  /// 一次超时把倒计时抹成空白，会让人以为模式已经掉了。
  Future<void> refreshParentMode() async {
    final ParentModeApi? api = _parentModeApi;
    if (api == null || _disposed) {
      _parentModeReadStatus = ReadStatus.ready;
      _parentModeError = null;
      _notify();
      return;
    }
    _parentModeReadStatus = ReadStatus.loading;
    _parentModeError = null;
    _notify();
    try {
      final ParentModeDto dto = await api.fetch();
      if (_disposed || api != _parentModeApi) return;
      _applyParentModeDto(dto);
      _parentModeReadStatus = ReadStatus.ready;
      _parentModeError = null;
    } on WriteApiException catch (error) {
      if (_disposed || api != _parentModeApi) return;
      _parentModeError = error.userMessage;
      _parentModeReadStatus = ReadStatus.error;
    } catch (error) {
      if (_disposed || api != _parentModeApi) return;
      _parentModeError = '读取家长模式状态时发生意外错误。请重试。';
      _parentModeReadStatus = ReadStatus.error;
    }
    _notify();
  }

  /// 用 PIN 进入家长模式（`POST /auth/parent-mode`）。成功返回 null。
  ///
  /// ── 三类失败必须分开说 ──────────────────────────────────────────────────────
  ///   · 格式错 ⇒ 本地就拒（后端 `400` 且**不计次**，手滑不该消耗尝试机会）；
  ///   · 值不对 ⇒ `403` + `remainingAttempts` 已递减，文案要带「还剩 N 次」；
  ///   · 锁定   ⇒ `429` + `retryAfterSeconds`，文案要带「还要等多久」。
  ///   把三者都说成「切换失败」会让家长反复乱试，最后把自己锁 15 分钟。
  ///
  /// 成功后**只更新家长模式快照**，不整体刷新首页：角色切换改变的是「哪些入口
  /// 可写」，首页数据（余额 / 习惯）与角色无关，多刷一次只会多一次失败机会。
  Future<String?> enterParentMode(String pin) async {
    final ParentModeApi? api = _parentModeApi;
    if (api == null) return '当前没有接入后端，无法切换家长模式。';
    if (_parentModeBusy) return '正在切换，请稍候…';
    final String trimmed = pin.trim();
    if (trimmed.isEmpty) return '请输入家长 PIN。';
    final String? invalid = validateParentPin(trimmed);
    if (invalid != null) return invalid;

    _parentModeBusy = true;
    _parentModeError = null;
    _notify();
    try {
      final ParentModeDto dto = await api.enter(trimmed);
      if (_disposed) return null;
      _applyParentModeDto(dto);
      _parentModeReadStatus = ReadStatus.ready;
      _parentPinLockSeconds = 0;
      // 刚输对了 PIN ⇒ 本机锁也一并打开（否则用户会紧接着再被问一次）。
      _appUnlocked = true;
      _relockPending = false;
      return null;
    } on ParentPinLockException catch (error) {
      if (_disposed) return error.userMessage;
      _parentPinLockSeconds = error.retryAfterSeconds;
      // 锁定是**服务端事实**（成员级计数），本地快照可能还是旧的 —— 拉一次把
      // `lockedUntil` / `remainingAttempts` 对齐，重开面板就不用再试错。
      await refreshParentMode();
      return error.userMessage;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.unauthenticated) {
        // 403 `PARENT_PIN_INVALID` 已经改了服务端的失败计数；
        // 401 说明会话没了 —— 两种都该重新对齐快照。
        await refreshParentMode();
      }
      return error.userMessage;
    } catch (error) {
      return '切换家长模式的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _parentModeBusy = false;
      _notify();
    }
  }

  /// 主动退出家长模式（`DELETE /auth/parent-mode`）。成功返回 null。
  ///
  /// **不需要 PIN**：降级永远允许（`02` §7）—— 孩子拿着手机时，家长必须能
  /// 立刻把权限收回去。也因此这是**幂等**的：本来就不在家长模式时也回 200，
  /// 界面不该把它当失败（那只是在重复一件已经成立的事）。
  ///
  /// 锁定期间同样可用：`429` 只拦「进」，不拦「出」。
  Future<String?> exitParentMode() async {
    final ParentModeApi? api = _parentModeApi;
    if (api == null) return '当前没有接入后端，无法退出家长模式。';
    if (_parentModeBusy) return '正在切换，请稍候…';

    _parentModeBusy = true;
    _parentModeError = null;
    _notify();
    try {
      final ParentModeDto dto = await api.exit();
      if (_disposed) return null;
      _applyParentModeDto(dto);
      _parentModeReadStatus = ReadStatus.ready;
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 401：会话已经不在了 —— 那本来就不是家长模式了，拉一次说真话。
      if (error.kind == WriteFailureKind.unauthenticated) {
        await refreshParentMode();
      }
      return error.userMessage;
    } catch (error) {
      return '退出家长模式的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _parentModeBusy = false;
      _notify();
    }
  }

  /// 开孩子模式（`POST /auth/kid-mode`，W14）。成功返回 null。
  ///
  /// ── 为什么本地先判一次 [isParentMode] ──────────────────────────────────────
  ///   服务端会回 `403 KID_MODE_REQUIRES_PARENT_MODE`（真正的门），但界面在
  ///   **非家长模式**下根本不显示这个区块；真走到这里只可能是快照过期。
  ///   本地拦一下能直接说「先进入家长模式」，而不是一句 HTTP 403。
  ///
  /// ── 时长 1–30 分钟由家长输入 ───────────────────────────────────────────────
  ///   默认 15（不是 30）：产品意图是「先写在纸上、想清楚再填」，
  ///   默认即上限会让"少用一会儿"变成额外操作。
  Future<String?> enterKidMode(int durationMinutes) async {
    final ParentModeApi? api = _parentModeApi;
    if (api == null) return '当前没有接入后端，无法开启孩子模式。';
    if (_parentModeBusy) return '正在切换，请稍候…';

    final String? invalid = validateKidModeMinutes(durationMinutes);
    if (invalid != null) return invalid;

    // 已经开着（或到期未收回）⇒ 先结束这一次，不静默续期。
    // 快照为 null = 还没拉到，交给服务端判（本地不猜"你不在家长模式"）。
    if (_parentMode != null) {
      if (isKidMode || isKidModeExpired) {
        return '孩子模式已经开着：请先输入家长 PIN 结束这一次，再重新设置时长。';
      }
      if (!isParentMode) {
        return '请先输入家长 PIN 进入家长模式，再给孩子开启时间。';
      }
    }

    _parentModeBusy = true;
    _parentModeError = null;
    _notify();
    try {
      final ParentModeDto dto = await api.enterKidMode(durationMinutes);
      if (_disposed) return null;
      _applyParentModeDto(dto);
      _parentModeReadStatus = ReadStatus.ready;
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 409（已经开着 / 没设 PIN）与 403（不在家长模式）都说明快照该对齐了。
      if (error.kind == WriteFailureKind.conflict ||
          error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.badRequest) {
        await refreshParentMode();
      }
      return error.userMessage;
    } catch (error) {
      return '开启孩子模式的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _parentModeBusy = false;
      _notify();
    }
  }

  /// 用家长 PIN 收回孩子模式（`DELETE /auth/kid-mode`，W14）。成功返回 null。
  ///
  /// **到期后也走这一条**：A 方案下到点不会自动回家长模式，
  /// 所以「结束孩子模式」是家长唯一能拿回权限的动作，PIN 必须验。
  Future<String?> exitKidMode(String pin) async {
    final ParentModeApi? api = _parentModeApi;
    if (api == null) return '当前没有接入后端，无法结束孩子模式。';
    if (_parentModeBusy) return '正在切换，请稍候…';

    final String trimmed = pin.trim();
    if (trimmed.isEmpty) return '请输入家长 PIN。';
    final String? invalid = validateParentPin(trimmed);
    if (invalid != null) return invalid;

    _parentModeBusy = true;
    _parentModeError = null;
    _notify();
    try {
      final ParentModeDto dto = await api.exitKidMode(trimmed);
      if (_disposed) return null;
      _applyParentModeDto(dto);
      _parentModeReadStatus = ReadStatus.ready;
      _parentPinLockSeconds = 0;
      // 收回孩子模式 = 家长刚证明过自己 ⇒ 本机锁同时打开。
      _appUnlocked = true;
      _relockPending = false;
      return null;
    } on ParentPinLockException catch (error) {
      if (_disposed) return error.userMessage;
      _parentPinLockSeconds = error.retryAfterSeconds;
      await refreshParentMode();
      return error.userMessage;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict ||
          error.kind == WriteFailureKind.badRequest ||
          error.kind == WriteFailureKind.unauthenticated) {
        await refreshParentMode();
      }
      return error.userMessage;
    } catch (error) {
      return '结束孩子模式的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _parentModeBusy = false;
      _notify();
    }
  }

  /// 首次设置 / 修改家长 PIN（`POST /auth/parent-pin`）。成功返回 null。
  ///
  /// ── 为什么改 PIN 需要 `currentPin` ──────────────────────────────────────────
  ///   否则任何拿到已解锁手机的孩子都能把 PIN 改掉，5 分钟家长模式就形同虚设。
  ///   这也解释了为什么这个端点在矩阵里是 `manage_parent_pin`（**child DENY**）：
  ///   孩子模式会话里改 PIN 一律 403，必须先拿 PIN 进家长模式再改。
  ///
  /// `currentPin` 为 null ⇒ 「服务端还没有 PIN」（首次设置）。若其实已有 PIN，
  /// 后端回 `400`（`PARENT_PIN_CURRENT_REQUIRED`），这里把文案原样交出去。
  Future<String?> setParentPin({
    required String pin,
    String? currentPin,
  }) async {
    final ParentModeApi? api = _parentModeApi;
    if (api == null) return '当前没有接入后端，无法保存家长 PIN。';
    if (_parentPinBusy) return '上一次保存正在提交，请稍候…';

    final String trimmed = pin.trim();
    if (trimmed.isEmpty) return '请输入新的家长 PIN。';
    final String? invalid = validateParentPin(trimmed);
    if (invalid != null) return invalid;
    if (currentPin != null && currentPin.trim().isEmpty) {
      return '请输入当前家长 PIN。';
    }

    _parentPinBusy = true;
    _parentModeError = null;
    _notify();
    try {
      final ParentPinDto dto = await api.setPin(
        pin: trimmed,
        currentPin: currentPin?.trim(),
      );
      if (_disposed) return null;
      _lastParentPinResult = mapParentPinResult(dto);
      // 只改**这几个**字段：PIN 变了不代表角色 / TTL 变了。
      _parentMode = (_parentMode ?? ParentMode.unknown).copyWith(
        pinConfigured: dto.pinConfigured,
        remainingAttempts: dto.remainingAttempts,
        clearLockedUntil: true,
      );
      _parentPinLockSeconds = 0;
      _parentModeReadStatus = ReadStatus.ready;
      // 刚设完 PIN（输了两遍）⇒ 不必立刻再让家长解一次锁。
      _appUnlocked = true;
      _relockPending = false;
      return null;
    } on ParentPinLockException catch (error) {
      if (_disposed) return error.userMessage;
      _parentPinLockSeconds = error.retryAfterSeconds;
      await refreshParentMode();
      return error.userMessage;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      // 403（旧 PIN 错，已计次）/ 400（缺 currentPin）/ 409 都改变了服务端事实。
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.badRequest ||
          error.kind == WriteFailureKind.conflict) {
        await refreshParentMode();
      }
      return error.userMessage;
    } catch (error) {
      return '保存家长 PIN 的请求已发出，但结果无法确认。请刷新后查看。';
    } finally {
      _parentPinBusy = false;
      _notify();
    }
  }

  /// 把 DTO 落进快照 —— 三处调用共用，免得哪一处漏掉字段，
  /// 出现「模式已进、pinConfigured 还是旧值」。
  void _applyParentModeDto(ParentModeDto dto) {
    _parentMode = mapParentMode(dto);
    if (!dto.parentMode) _parentPinLockSeconds = 0;
  }

  // ==================================== 本机 PIN 锁（2026-11-04，替代日期码闸门）

  /// 退到后台 ⇒ 立刻上锁（回到前台要重新输 PIN）。
  ///
  /// 三条「不锁」的例外都写在这里（界面不许各自判断，否则早晚出现分歧）：
  ///   · 没接后端 / **不知道**有没有 PIN（`parentMode == null`）⇒ 没有「谁来
  ///     判定对错」，锁上就是一块砖；
  ///   · 孩子模式**窗口内** ⇒ 手机本来就是给孩子用的，锁上会让孩子切一次应用
  ///     就再也回不来；改成记一笔 [_relockPending]，回来时窗口若已结束就补锁；
  ///   · 本来就锁着 ⇒ 幂等。
  void lockAppForBackground() {
    if (!hasParentPinLock) return;
    if (!isParentPinConfigured) return;
    if (isKidModeActiveAt(DateTime.now())) {
      _relockPending = true;
      return;
    }
    _relockPending = false;
    if (!_appUnlocked) return;
    _appUnlocked = false;
    _appLockError = null;
    _notify();
  }

  /// 回到前台时调用（`AppLifecycleState.resumed`）：孩子模式如果在后台期间
  /// 结束了，把锁补上。
  void settleAppLockAfterResume() {
    if (!_relockPending) return;
    if (isKidModeActiveAt(DateTime.now())) return;
    _relockPending = false;
    if (!_appUnlocked) return;
    _appUnlocked = false;
    _appLockError = null;
    _notify();
  }

  /// 只校验一次家长 PIN（`POST /auth/parent-pin/verify`）。成功返回 null。
  ///
  /// ── 与 [unlockAppWithPin] 的分工 ───────────────────────────────────────────
  ///   这里**只回答「这个 PIN 对不对」**，不碰 `isAppUnlocked`：
  ///   设置 / 修改 PIN 的「请输入当前 PIN」那一步问的是「你确实知道旧 PIN 吗」，
  ///   与「谁拿着手机」是两件事。
  ///
  /// ── 旧服务端的降级（`404`）────────────────────────────────────────────
  ///   服务端还没有这条只读路由（<= 1.0.5 的镜像）时退回 `enterParentMode()`：
  ///   功能可用，但那台设备会变成 5 分钟家长窗口。宁可降级，
  ///   也不能让用户永远停在锁屏 / 设置页。
  Future<String?> checkParentPin(String pin) async {
    final ParentModeApi? api = _parentModeApi;
    if (api == null) return '当前没有接入后端，无法校验家长 PIN。';
    if (_appLockBusy) return '正在校验，请稍候…';

    final String trimmed = pin.trim();
    if (trimmed.isEmpty) return '请输入家长 PIN。';
    final String? invalid = validateParentPin(trimmed);
    if (invalid != null) return invalid;

    _appLockBusy = true;
    _appLockError = null;
    _notify();
    try {
      final PinVerifyResult result = await api.verifyPin(trimmed);
      if (_disposed) return null;
      _parentMode = (_parentMode ?? ParentMode.unknown)
          .copyWith(remainingAttempts: result.remainingAttempts);
      _parentPinLockSeconds = 0;
      _appLockError = null;
      return null;
    } on WriteApiException catch (error) {
      if (_disposed) return error.userMessage;
      if (error.statusCode == 404) {
        return await _unlockByEnteringParentMode(trimmed);
      }
      _appLockError = error.userMessage;
      if (error is ParentPinLockException) {
        _parentPinLockSeconds = error.retryAfterSeconds;
      }
      // 403（PIN 被改）/ 409（PIN 被移除 / 成员变了）⇒ 服务端事实变了，对齐一次。
      if (error.kind == WriteFailureKind.forbidden ||
          error.kind == WriteFailureKind.conflict) {
        await refreshParentMode();
      }
      return error.userMessage;
    } catch (error) {
      const String message = '校验请求已发出，但结果无法确认。请重试。';
      if (_disposed) return message;
      _appLockError = message;
      return message;
    } finally {
      _appLockBusy = false;
      _notify();
    }
  }

  /// 用家长 PIN 解锁本机（冷启动 / 从后台回来）。
  Future<String?> unlockAppWithPin(String pin) async {
    if (_appUnlocked) return null;
    final String? failure = await checkParentPin(pin);
    if (failure != null || _disposed) return failure;
    _appUnlocked = true;
    _relockPending = false;
    _appLockError = null;
    _notify();
    return null;
  }

  /// 旧服务端（没有 verify 路由）的降级路径：用「进入家长模式」代替校验。
  Future<String?> _unlockByEnteringParentMode(String pin) async {
    final String? failure = await enterParentMode(pin);
    if (_disposed) return failure;
    if (failure != null) {
      _appLockError = failure;
      return failure;
    }
    return null;
  }

  // ------------------------------------------------------------ 内部工具

  void _persist() => notifyListeners();

  String _newId(String prefix) =>
      '$prefix-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  // （原先这里有个 _isToday()：现统一用 habit.dart 的 isSameDay()，
  //   与 Taro 侧同一个判据，避免“两端各自实现、各自漂移”）
}
