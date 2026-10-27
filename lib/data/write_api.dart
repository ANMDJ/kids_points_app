import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../models/invite.dart' show kMaxInviteTtlDays, kMaxInviteUses;
import '../models/point_record.dart' show MemberRole;
import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'read_api_errors.dart';
import 'read_dto.dart';
import 'write_api_errors.dart';
import 'write_dto.dart';

/// 写传输层的一行响应 —— 测试替身只需要造这个。
class WriteHttpResponse {
  WriteHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

/// 写传输层接口。
///
/// 刻意与只读的 `ReadTransport` 分开：
///   · 写请求必须带 body / Content-Type，且**不允许**自动重试（重试要靠幂等键）；
///   · 让只读传输层保持极小面，不会因为加写入口而改到已经在跑的读路径。
///
/// [method] 默认 POST；规则编辑走 PATCH、删除走 DELETE。**不要**把方法塞进
/// body 或用 `_method` 覆盖 —— 后端是标准 REST 语义，幂等哈希也按真实方法计算。
abstract class WriteTransport {
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  });

  void close() {}
}

/// 基于 `dart:io HttpClient` 的最小实现。
class IoWriteTransport implements WriteTransport {
  IoWriteTransport({Duration connectionTimeout = const Duration(seconds: 10)})
      : _client = HttpClient()..connectionTimeout = connectionTimeout;

  final HttpClient _client;

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    final HttpClientRequest request = await _client.openUrl(method, uri);
    headers.forEach(request.headers.set);
    if (body.isNotEmpty) request.write(body);
    final HttpClientResponse response = await request.close();
    final String text = await utf8.decoder.bind(response).join();
    return WriteHttpResponse(statusCode: response.statusCode, body: text);
  }

  @override
  void close() => _client.close(force: true);
}

/// AppStore 依赖的写能力（测试可注入自己的实现，不必起 HTTP 服务）。
abstract class WriteApi {
  /// 打卡。返回服务端真正写入的流水。
  Future<WrittenRecordDto> checkIn(
    String habitId, {
    String? idempotencyKey,
  });

  /// 撤销一条打卡。返回**冲正记录**（不是原记录）。
  Future<WrittenRecordDto> reverse(
    String recordId, {
    String? idempotencyKey,
    String? note,
  });

  /// 「记一笔」（`adjust_points`）：家长手动加 / 扣分。
  ///
  /// [points] **带符号**（负 = 扣分），与 [WrittenRecordDto] 的回包同构 ——
  /// 调用方不需要再取反；服务端按锁内余额算 `balanceAfter` 并落一条
  /// `category='adjust'` 的流水（同一事务里还写审计）。
  Future<WrittenRecordDto> adjust({
    required String title,
    required int points,
    String? note,
    String? idempotencyKey,
  });

  /// 新建规则。`points` 带符号（负 = 扣分），服务端落库时拆成
  /// 「正数分值 + direction」，回包仍是带符号的分值。
  Future<RuleDto> createRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String icon,
    required String color,
    String? idempotencyKey,
  });

  /// 更新规则。[expectedVersion] 是**客户端看到的版本号**：与服务端不一致
  /// ⇒ 409 `RULE_VERSION_CONFLICT`，绝不静默覆盖别人刚改的内容。
  Future<RuleDto> updateRule(
    String ruleId, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required int expectedVersion,
    String? idempotencyKey,
  });

  /// 软删规则（进回收站）。返回服务端确认删除的 `ruleId`。
  Future<String> deleteRule(
    String ruleId, {
    String? idempotencyKey,
  });

  /// 按规则生成首页习惯。返回与 `GET /home` 的 `habits[]` 同构的行。
  Future<HabitDto> addHabitFromRule(
    String ruleId, {
    String? idempotencyKey,
  });

  /// 新增心愿（`add_wish`）。
  ///
  /// 家长 ⇒ 直接落库；孩子的权限矩阵若为 `REQUIRE_APPROVAL`，服务端回
  /// 403 `APPROVAL_REQUIRED` —— 这里**不吞**该业务码，由 store 翻成
  /// 「需要家长确认」，界面据此提示去审批，而不是假装保存成功。
  Future<WishDto> createWish({
    required String title,
    required int cost,
    required String emoji,
    String? idempotencyKey,
  });

  /// 软删心愿（`delete_wish`，进回收站）。返回服务端确认删除的 `wishId`。
  ///
  /// 删除**不碰流水**：已发生的兑换记录继续带 `wishId` 回指这条心愿（修 C9）。
  Future<String> deleteWish(
    String wishId, {
    String? idempotencyKey,
  });

  /// 软删首页习惯（`delete_habit`，进回收站）—— W5-F。返回确认删除的 `habitId`。
  ///
  /// 与删规则 / 删心愿同语义：只把 `status` 改成 `deleted`，历史打卡流水继续带
  /// `habitId` 回指（修 C9）。矩阵里孩子 `DENY`，服务端会回 403 —— 这里不吞。
  Future<String> deleteHabit(
    String habitId, {
    String? idempotencyKey,
  });

  /// 从回收站恢复一条（`restore_trash_item`）—— W5-F。
  ///
  /// [kind] 用**线值**（`point_rule` / `wish` / `habit`）：恢复是按类型的，
  /// 用错类型只会得到 404，不会“顺手恢复了隔壁”。
  ///
  /// 恢复本身幂等（重复调用回同一个 `{kind,id}`、不写第二条审计），
  /// 因此不需要幂等键。习惯的来源规则还在回收站时，服务端回
  /// 409 `TRASH_PARENT_RULE_DELETED` —— 必须原样展示（先恢复规则）。
  Future<TrashTargetDto> restoreTrashItem(String kind, String id);

  /// 彻底删除回收站里的一条（`purge_trash_item`）—— **不可逆**，W5-F。
  ///
  /// 服务端会拒绝两种情况（都不能当成功）：
  ///   · 409 `TRASH_ITEM_REFERENCED` —— 还有流水引用它（删了历史就断链）
  ///   · 409 `TRASH_ITEM_NOT_DELETED` —— 它其实还在列表上（没先软删）
  /// 重复调用得到 404：这一项真的不在了，这正是应当给出的答案。
  Future<TrashTargetDto> purgeTrashItem(String kind, String id);

  /// 申请兑换心愿（`POST /approvals`，`action='redeem'`）。
  ///
  /// 后端**没有**独立的「兑换」路由：`redeem` 在权限矩阵里对两个角色都是
  /// `REQUIRE_APPROVAL`，所以唯一的正确路径就是建一条审批请求。
  /// `costSnapshot` **不由客户端提交** —— 服务端按心愿当前价格快照，
  /// 客户端说了不算（否则改一个数字就能少扣分）。
  ///
  /// 回包 [ApprovalDto.status] 为 `pending` 时**还没有扣分**：界面必须说
  /// 「已提交，等家长确认」，不能说「兑换成功」。
  Future<ApprovalDto> requestRedeem(
    String wishId, {
    String? idempotencyKey,
  });

  /// 批准 / 拒绝一条申请（`POST /approvals/:id/decide`，家长收件箱，W5-D）。
  ///
  /// [approve] 只映射成两个终态（`approved` / `rejected`）—— 撤回是申请人的
  /// 另一个端点，客户端这里不许「顺手」写 `withdrawn`。
  ///
  /// 常见业务拒绝（都必须原样展示，不能让界面假装成功）：
  ///   · 409 `ALREADY_DECIDED` —— 另一台设备已经处理过（双击 / 并发）
  ///   · 409 `APPROVAL_EXPIRED` —— 超过 72h
  ///   · 409 `APPROVAL_INVALIDATED` —— 前提消失（心愿被删 / 积分不够）
  Future<ApprovalDto> decideApproval(
    String approvalId, {
    required bool approve,
    String? idempotencyKey,
  });

  /// 撤回**自己**提的申请（`POST /approvals/:id/withdraw`，W5-J）。
  ///
  /// 撤回是申请人的动作，不是「批准」的一种：服务端不会写流水、不动余额，
  /// 只把 `pending → withdrawn`。
  ///
  /// 常见业务拒绝（都必须原样展示）：
  ///   · 403 `NOT_REQUESTER` —— 这条不是你提的（同一家庭里的其他成员也不行）
  ///   · 409 `ALREADY_DECIDED` —— 已被家长批 / 拒，或已经撤回过了
  ///   · 409 `APPROVAL_EXPIRED` —— 超过 72h，服务端先惰性置 `expired`
  ///
  /// 需要幂等键：双击「撤回」不该变成两次请求（第二次会拿到 409）。
  Future<ApprovalDto> withdrawApproval(
    String approvalId, {
    String? idempotencyKey,
  });

  /// 改孩子昵称（`PATCH /child`，W5-E）。
  ///
  /// [name] 原样提交即可 —— trim 与「≤16 个字符」由**服务端**判定，客户端只做
  /// 输入框层面的提示（`maxLength`）。回包 [ChildProfileDto.name] 才是权威值。
  ///
  /// 常见业务拒绝：
  ///   · 403 `FORBIDDEN` —— 孩子设备没有 `edit_child_profile`（矩阵里 child DENY）
  ///   · 400 `CHILD_NAME_EMPTY` / `CHILD_NAME_TOO_LONG` —— 服务端校验兜底
  ///   · 404 `CHILD_NOT_FOUND` —— 孩子已被删除
  ///
  /// **不需要**幂等键：PATCH 是幂等的，同名重复提交在服务端命中「无变化」分支，
  /// 既不改库也不写审计。
  Future<ChildProfileDto> renameChild(String name);

  /// 改成员角色（`PATCH /members/:id`，`change_member_role`，W5-H）。
  ///
  /// [role] 只接受 `guardian` / `child`：`viewer` 不是合法目标角色
  /// （邀请码也建不出它），传进来在**发请求之前**就拒绝。
  ///
  /// 常见业务拒绝（都必须原样展示，不能让界面假装成功）：
  ///   · 403 `CANNOT_MODIFY_SELF` —— 两条写路由都禁止作用于自己
  ///     （自我降级 = 把自己锁在门外，而没有家长能救你）
  ///   · 403 `FORBIDDEN` —— 当前角色不是家长
  ///   · 409 `LAST_GUARDIAN_PROTECTED` —— 会把这个孩子降成 0 位家长
  ///   · 409 `MEMBER_NOT_ACTIVE` —— 目标成员位已被移出
  ///   · 404 `MEMBER_NOT_FOUND` —— 不存在 / 属于别的孩子（同一句话）
  ///
  /// 同角色重复提交在服务端是**构造幂等**（200、不写第二条审计），
  /// 因此不需要幂等键。回包 [MemberDto.role] 必须等于请求的角色 ——
  /// 不一致说明契约漂移，宁可显式失败。
  Future<MemberDto> changeMemberRole(String memberId, MemberRole role);

  /// 移出成员（`DELETE /members/:id`，`remove_member`，W5-H）。
  ///
  /// 服务端只做**软删**（`status='removed'`）并**保留会话**：删会话会把
  /// 「你被移出」伪装成「你没登录」（401）。重复调用是构造幂等
  /// （200、`removedAt` 保持第一次的值）。
  ///
  /// 403 `CANNOT_MODIFY_SELF`（不能移出自己 ⇒ 没有自助「退出家庭」）、
  /// 403 `FORBIDDEN`、409 `LAST_GUARDIAN_PROTECTED` 都按原样展示。
  /// 回包 [MemberRemoveDto.memberId] 必须等于请求的 id。
  Future<MemberRemoveDto> removeMember(String memberId);

  /// 生成邀请码（`POST /invites`，`invite_member`，W5-I）。
  ///
  /// [role] 只接受 `guardian` / `child`（`viewer` 在发请求前就拒绝）；
  /// [maxUses] 1..[kMaxInviteUses]；[expiresInDays] 1..[kMaxInviteTtlDays] ——
  /// 与后端 `CreateInviteDto` 的 `@Min/@Max` 同口径，越界在本地就拦下，
  /// 不让界面先等一次必然 400 的往返。
  ///
  /// 回包是**新码的全量行**（含 `code` 本身），可以直接插到列表头；
  /// 不需要幂等键：每次调用本来就应该产生一个新码。
  ///
  /// 常见业务拒绝：403 `FORBIDDEN`（孩子没有 `invite_member`）、
  /// 400 `INVITE_ROLE_INVALID` / 409 `INVITE_CODE_GENERATION_FAILED`。
  Future<InviteDto> createInvite({
    required MemberRole role,
    required int maxUses,
    required int expiresInDays,
  });

  /// 吊销邀请码（`POST /invites/:id/revoke`，`invite_member`，W5-I）。
  ///
  /// 构造幂等：已经吊销过的码再吊销仍是 200（且不写第二条审计）。
  /// 404 `INVITE_NOT_FOUND` = 不存在或不属于这个孩子（同一句话，不泄露别家 id）。
  ///
  /// 回包只有 `{id, revoked}` —— 服务端不再回整行，客户端不要把「200」
  /// 理解成「多吊销了一次」。
  Future<InviteRevokeDto> revokeInvite(String inviteId);

  /// 作出同意（`POST /consent`，`manage_consent`，W7-B）。
  ///
  /// 请求体**只有** `{accepted: true}`：协议版本由服务端决定
  /// （`CONSENT_TEXT_VERSION`），客户端不能自报「我同意的是 v9」。
  ///
  /// 构造幂等：已同意再调仍是 200、`grantedAt` 保持第一次的时间 ——
  /// 因此不需要幂等键。
  ///
  /// 常见业务拒绝（都必须原样展示，不能让界面假装成功）：
  ///   · 403 `FORBIDDEN` —— 孩子设备没有 `manage_consent`（矩阵里 child DENY）
  ///   · 400 `CONSENT_NOT_ACCEPTED` —— `accepted !== true`
  ///   · 500 `CONSENT_VERSION_MISSING` —— 服务端配置缺失（契约漂移）
  Future<ConsentStateDto> grantConsent();

  /// 撤回同意（`POST /consent/withdraw`，`manage_consent`，W7-B）。
  ///
  /// **没有请求体**：撤回的只有「当前这一份同意」，对象由会话决定。
  /// 构造幂等：未同意 / 已撤回再调仍是 200 ——「撤回一个不存在的同意」
  /// 的正确答案就是「它现在不是同意状态」，不必报错制造焦虑。
  ///
  /// 撤回后写动作会被 `ConsentGuard`（W7-A 第四道屏障）拦成 403
  /// `CONSENT_REQUIRED`；读取与重新同意不受影响。
  Future<ConsentStateDto> withdrawConsent();

  /// 标记一条通知已读（`PATCH /notifications/:id/read`，`read_notifications`，W5-L）。
  ///
  /// **没有 body**：要改的只有「读了」这一个事实，路径里已经有 id。
  /// 服务端按会话收件人收口：别人的 / 不存在的 id 一律 404 `NOTIFICATION_NOT_FOUND`
  /// （同一句话，不泄露别家 id）。
  ///
  /// 构造幂等：已读再调仍是 200，`readAt` 是**第一次**的时间 ——
  /// 因此不需要幂等键，也不能用本地时间覆盖回包。
  /// 回包 [NotificationReadDto.id] 必须等于请求的 id。
  Future<NotificationReadDto> markNotificationRead(String notificationId);

  /// 申请删除家庭数据（`POST /family-deletion`，`manage_family_deletion`，W7-D）。
  ///
  /// 请求体**只有** `{confirmed: true}`：删除对象来自会话，冷却期由服务端政策
  /// 决定。`confirmed` 必须是**布尔真值** —— 后端不把「没带字段」读成同意，
  /// 客户端也不提供「默认确认」的调用方式。
  ///
  /// 构造幂等：已在冷却期再调仍是 200、返回**同一条**请求（`requestedAt` 不变），
  /// 不会插出第二条冷却期，也不会重复写审计。
  ///
  /// 常见业务拒绝（都必须原样展示）：
  ///   · 403 `FORBIDDEN` —— 孩子没有 `manage_family_deletion`
  ///   · 400 `FAMILY_DELETION_NOT_CONFIRMED` —— 没带显式确认
  ///   · 409 `FAMILY_DELETION_ALREADY_EXECUTED` —— 已经删过，不可重复
  ///   · 404 `CHILD_NOT_FOUND` —— 孩子已删 / 不存在
  Future<FamilyDeletionStateDto> requestFamilyDeletion();

  /// 撤销待执行的删除（`POST /family-deletion/cancel`，`manage_family_deletion`）。
  ///
  /// **没有请求体**：撤销的只有「当前这条 pending 请求」。
  /// 构造幂等**不成立**：没有 pending 时回 409 `FAMILY_DELETION_NOT_PENDING` ——
  /// 那不是「本来就没申请」，而是「这个动作此刻没有对象」，界面应据此刷新状态。
  Future<FamilyDeletionStateDto> cancelFamilyDeletion();

  void close() {}
}

/// `POST /records/check-in` 与 `POST /records/:id/reverse` 的客户端。
///
/// 身份头与只读端完全一致（设备 id + 孩子 id）；`childId` 仍然只是
/// 「会话作用在哪个孩子上」，真正的授权由后端 Guard 判定。
class WriteApiClient implements WriteApi {
  WriteApiClient({
    required this.config,
    WriteTransport? transport,
    this.timeout = const Duration(seconds: 10),
  }) : _transport = transport ?? IoWriteTransport(connectionTimeout: timeout);

  final ReadApiConfig config;
  final Duration timeout;
  final WriteTransport _transport;

  @override
  Future<WrittenRecordDto> checkIn(
    String habitId, {
    String? idempotencyKey,
  }) async {
    if (habitId.trim().isEmpty) {
      throw ArgumentError.value(habitId, 'habitId', '不能为空');
    }
    final Object? decoded = await _send(
      'POST',
      '/records/check-in',
      <String, Object?>{'habitId': habitId.trim()},
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, WrittenRecordDto.fromJson);
  }

  @override
  Future<WrittenRecordDto> reverse(
    String recordId, {
    String? idempotencyKey,
    String? note,
  }) async {
    final String id = recordId.trim();
    if (id.isEmpty) {
      throw ArgumentError.value(recordId, 'recordId', '不能为空');
    }
    final String? trimmedNote = note?.trim();
    final Object? decoded = await _send(
      'POST',
      '/records/${Uri.encodeComponent(id)}/reverse',
      <String, Object?>{
        if (trimmedNote != null && trimmedNote.isNotEmpty) 'note': trimmedNote,
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, WrittenRecordDto.fromJson);
  }

  @override
  Future<WrittenRecordDto> adjust({
    required String title,
    required int points,
    String? note,
    String? idempotencyKey,
  }) async {
    final String trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty) {
      throw ArgumentError.value(title, 'title', '不能为空');
    }
    // 0 没有语义（一笔「0 分的调整」无法解释余额为何不变），后端也会 400 ——
    // 在这里就拦下，不为一个必然失败的请求等一次往返。
    if (points == 0) {
      throw ArgumentError.value(points, 'points', '不能为 0');
    }
    final String? trimmedNote = note?.trim();
    final Object? decoded = await _send(
      'POST',
      '/records/adjust',
      <String, Object?>{
        'title': trimmedTitle,
        'points': points,
        if (trimmedNote != null && trimmedNote.isNotEmpty) 'note': trimmedNote,
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, WrittenRecordDto.fromJson);
  }

  @override
  Future<RuleDto> createRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String icon,
    required String color,
    String? idempotencyKey,
  }) async {
    final String trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty) {
      throw ArgumentError.value(title, 'title', '不能为空');
    }
    final Object? decoded = await _send(
      'POST',
      '/point-rules',
      <String, Object?>{
        'title': trimmedTitle,
        'condition': condition.trim(),
        'dailyLimit': dailyLimit,
        'points': points,
        'icon': icon,
        'color': color,
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, RuleDto.fromJson);
  }

  @override
  Future<RuleDto> updateRule(
    String ruleId, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required int expectedVersion,
    String? idempotencyKey,
  }) async {
    final String id = _requireId(ruleId, 'ruleId');
    final String trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty) {
      throw ArgumentError.value(title, 'title', '不能为空');
    }
    if (expectedVersion < 1) {
      throw ArgumentError.value(expectedVersion, 'expectedVersion', '必须 ≥ 1');
    }
    final Object? decoded = await _send(
      'PATCH',
      '/point-rules/${Uri.encodeComponent(id)}',
      <String, Object?>{
        'title': trimmedTitle,
        'condition': condition.trim(),
        'dailyLimit': dailyLimit,
        'points': points,
        // 乐观锁：客户端只声明「我改的是第几版」，版本递增由服务端做。
        'expectedVersion': expectedVersion,
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, RuleDto.fromJson);
  }

  @override
  Future<String> deleteRule(String ruleId, {String? idempotencyKey}) async {
    final String id = _requireId(ruleId, 'ruleId');
    final Object? decoded = await _send(
      'DELETE',
      '/point-rules/${Uri.encodeComponent(id)}',
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      idempotencyKey: idempotencyKey,
    );
    final Object? returned = decoded is Map ? decoded['ruleId'] : null;
    if (returned != id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        r'$.ruleId',
        detail: '删除回包的 ruleId 与请求不一致：$returned != $id',
      );
    }
    return id;
  }

  @override
  Future<HabitDto> addHabitFromRule(
    String ruleId, {
    String? idempotencyKey,
  }) async {
    final String id = _requireId(ruleId, 'ruleId');
    final Object? decoded = await _send(
      'POST',
      '/point-rules/${Uri.encodeComponent(id)}/habits',
      null,
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, HabitDto.fromJson);
  }

  @override
  Future<WishDto> createWish({
    required String title,
    required int cost,
    required String emoji,
    String? idempotencyKey,
  }) async {
    final String trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty) {
      throw ArgumentError.value(title, 'title', '不能为空');
    }
    if (cost < 1) {
      throw ArgumentError.value(cost, 'cost', '必须 ≥ 1');
    }
    final String trimmedEmoji = emoji.trim();
    if (trimmedEmoji.isEmpty) {
      throw ArgumentError.value(emoji, 'emoji', '不能为空');
    }
    final Object? decoded = await _send(
      'POST',
      '/wishes',
      <String, Object?>{
        'title': trimmedTitle,
        'cost': cost,
        'emoji': trimmedEmoji,
        // 配色**不传**：由服务端按「空档优先，否则 id 哈希」决定，
        // 避免客户端和服务端各算一次而给出两个颜色。
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, WishDto.fromJson);
  }

  @override
  Future<String> deleteWish(
    String wishId, {
    String? idempotencyKey,
  }) async {
    final String id = _requireId(wishId, 'wishId');
    final Object? decoded = await _send(
      'DELETE',
      '/wishes/${Uri.encodeComponent(id)}',
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      idempotencyKey: idempotencyKey,
    );
    final Object? returned = decoded is Map ? decoded['wishId'] : null;
    if (returned != id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        r'$.wishId',
        detail: '删除回包的 wishId 与请求不一致：$returned != $id',
      );
    }
    return id;
  }

  @override
  Future<String> deleteHabit(String habitId, {String? idempotencyKey}) async {
    final String id = _requireId(habitId, 'habitId');
    final Object? decoded = await _send(
      'DELETE',
      '/habits/${Uri.encodeComponent(id)}',
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      idempotencyKey: idempotencyKey,
    );
    final Object? returned = decoded is Map ? decoded['habitId'] : null;
    if (returned != id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        r'$.habitId',
        detail: '删除回包的 habitId 与请求不一致：$returned != $id',
      );
    }
    return id;
  }

  @override
  Future<TrashTargetDto> restoreTrashItem(String kind, String id) async {
    final String safeKind = _trashKind(kind);
    final String safeId = _requireId(id, 'id');
    final Object? decoded = await _send(
      'POST',
      '/trash/$safeKind/${Uri.encodeComponent(safeId)}/restore',
      null,
    );
    return _parse(
      decoded,
      (Object? raw, String path) => TrashTargetDto.fromJson(
        raw,
        path,
        expectedKind: safeKind,
        expectedId: safeId,
      ),
    );
  }

  @override
  Future<TrashTargetDto> purgeTrashItem(String kind, String id) async {
    final String safeKind = _trashKind(kind);
    final String safeId = _requireId(id, 'id');
    final Object? decoded = await _send(
      'DELETE',
      '/trash/$safeKind/${Uri.encodeComponent(safeId)}',
      null,
    );
    return _parse(
      decoded,
      (Object? raw, String path) => TrashTargetDto.fromJson(
        raw,
        path,
        expectedKind: safeKind,
        expectedId: safeId,
      ),
    );
  }

  /// 回收站只认三个线值；拼错的类型**在发请求之前**就报错 ——
  /// 否则服务端会回 400 `TRASH_KIND_INVALID`，用户看到一条本可避免的错误。
  static const Set<String> _trashKinds = <String>{
    'point_rule',
    'wish',
    'habit',
  };

  String _trashKind(String kind) {
    final String value = kind.trim();
    if (!_trashKinds.contains(value)) {
      throw ArgumentError.value(value, 'kind', '不在回收站类型列表里');
    }
    return value;
  }

  @override
  Future<ApprovalDto> requestRedeem(
    String wishId, {
    String? idempotencyKey,
  }) async {
    final String id = _requireId(wishId, 'wishId');
    final Object? decoded = await _send(
      'POST',
      '/approvals',
      <String, Object?>{
        'action': 'redeem',
        'targetId': id,
        // `autoApprove` **不发**：那是「申请人要求自批」的显式勾选，
        // 孩子没有批准资格 ⇒ 只会换来 400；家长也不该被这个界面代勾。
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, ApprovalDto.fromJson);
  }

  @override
  Future<ApprovalDto> decideApproval(
    String approvalId, {
    required bool approve,
    String? idempotencyKey,
  }) async {
    final String id = _requireId(approvalId, 'approvalId');
    final Object? decoded = await _send(
      'POST',
      '/approvals/$id/decide',
      <String, Object?>{'decision': approve ? 'approved' : 'rejected'},
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, ApprovalDto.fromJson);
  }

  @override
  Future<ApprovalDto> withdrawApproval(
    String approvalId, {
    String? idempotencyKey,
  }) async {
    final String id = _requireId(approvalId, 'approvalId');
    // 没有请求体：操作对象已经在路径里，申请人由服务端会话决定。
    final Object? decoded = await _send(
      'POST',
      '/approvals/$id/withdraw',
      null,
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, ApprovalDto.fromJson);
  }

  @override
  Future<ChildProfileDto> renameChild(String name) async {
    final String trimmed = name.trim();
    // 空白昵称必然 400：在本地就拦下，不浪费一次往返，也不让界面「等一会儿再报错」。
    if (trimmed.isEmpty) {
      throw ArgumentError.value(name, 'name', '不能为空');
    }
    // 不做长度校验：`maxLength` 数的是输入框里的字符，而服务端按码点判定；
    // 两边若在这里各判一次，「16 个 emoji」这种边界就会出现两套答案。
    final Object? decoded = await _send(
      'PATCH',
      '/child',
      <String, Object?>{'name': trimmed},
    );
    final ChildProfileDto dto = _parse(decoded, ChildProfileDto.fromJson);
    final String expected = config.childId.trim();
    if (expected.isNotEmpty && dto.childId != expected) {
      // 回包指向别的孩子 ⇒ 会话串号 / 后端 bug。把名字写到本地档案上就是
      // 给错误的孩子改名，宁可显式失败。
      throw WriteApiException.malformed(
        r'$.childId',
        detail: '回包 childId=${dto.childId} 与当前会话 $expected 不一致',
      );
    }
    return dto;
  }

  @override
  Future<MemberDto> changeMemberRole(String memberId, MemberRole role) async {
    final String id = _requireId(memberId, 'memberId');
    if (role != MemberRole.guardian && role != MemberRole.child) {
      // `viewer` 不是合法目标角色（后端 DTO 用 @IsIn(['child','guardian'])）。
      // 在本地就拒绝，不浪费一次必然 400 的往返。
      throw ArgumentError.value(role, 'role', '只能是 guardian / child');
    }
    final Object? decoded = await _send(
      'PATCH',
      '/members/$id',
      <String, Object?>{'role': role.name},
    );
    final MemberDto dto = _parse(decoded, MemberDto.fromJson);
    if (dto.memberId != id) {
      // 回包指向别的成员 ⇒ 会话串号 / 后端 bug。把别人的角色改掉是权限事故。
      throw WriteApiException.malformed(
        r'$.memberId',
        detail: '回包 memberId=${dto.memberId} 与请求 $id 不一致',
      );
    }
    if (dto.role != role.name) {
      // 请求降级、回包仍是家长 ⇒ 界面会以为降级成功。不能把结论抄错。
      throw WriteApiException.malformed(
        r'$.role',
        detail: '回包 role=${dto.role} 与请求 ${role.name} 不一致',
      );
    }
    return dto;
  }

  @override
  Future<MemberRemoveDto> removeMember(String memberId) async {
    final String id = _requireId(memberId, 'memberId');
    final Object? decoded = await _send('DELETE', '/members/$id', null);
    return _parse(
      decoded,
      (Object? raw, String path) =>
          MemberRemoveDto.fromJson(raw, path, expectedMemberId: id),
    );
  }

  @override
  Future<InviteDto> createInvite({
    required MemberRole role,
    required int maxUses,
    required int expiresInDays,
  }) async {
    if (role != MemberRole.guardian && role != MemberRole.child) {
      // `viewer` 不是可邀请的角色（后端 DTO：@IsIn(['child','guardian'])）。
      throw ArgumentError.value(role, 'role', '只能是 guardian / child');
    }
    if (maxUses < 1 || maxUses > kMaxInviteUses) {
      throw ArgumentError.value(
        maxUses,
        'maxUses',
        '必须在 1–$kMaxInviteUses 之间（后端 @Max 同口径）',
      );
    }
    if (expiresInDays < 1 || expiresInDays > kMaxInviteTtlDays) {
      throw ArgumentError.value(
        expiresInDays,
        'expiresInDays',
        '必须在 1–$kMaxInviteTtlDays 之间（后端 @Max 同口径）',
      );
    }
    final Object? decoded = await _send(
      'POST',
      '/invites',
      <String, Object?>{
        'role': role.name,
        'maxUses': maxUses,
        // 只发天数：绝对时刻由服务端算（客户端不能指定 `expiresAt`）。
        'expiresInDays': expiresInDays,
      },
    );
    final InviteDto dto = _parse(decoded, InviteDto.fromJson);
    if (dto.role != role.name) {
      // 要一张「孩子」票、回包是「家长」票 ⇒ 权限边界画错，不能当成功插进列表。
      throw WriteApiException.malformed(
        r'$.role',
        detail: '回包 role=${dto.role} 与请求 ${role.name} 不一致',
      );
    }
    if (dto.code.trim().isEmpty) {
      // 没有码的邀请码是废票：不能让界面显示「已生成」却没法复制。
      throw WriteApiException.malformed(r'$.code', detail: '回包 code 为空');
    }
    return dto;
  }

  @override
  Future<InviteRevokeDto> revokeInvite(String inviteId) async {
    final String id = _requireId(inviteId, 'inviteId');
    final Object? decoded = await _send('POST', '/invites/$id/revoke', null);
    return _parse(
      decoded,
      (Object? raw, String path) =>
          InviteRevokeDto.fromJson(raw, path, expectedInviteId: id),
    );
  }

  @override
  Future<ConsentStateDto> grantConsent() async {
    // 显式 `accepted: true`：后端 `@IsDefined()` 拒绝空 body，
    // 但这里仍然写全 —— 让「同意」这件事在客户端代码里也是显式的。
    final Object? decoded = await _send(
      'POST',
      '/consent',
      <String, Object?>{'accepted': true},
    );
    final ConsentStateDto dto = _parse(
      decoded,
      (Object? raw, String _) => ConsentStateDto.fromJson(raw),
    );
    // 服务端说没同意 ⇒ 界面不能显示「已同意」（比如它悄悄走了另一个分支）。
    if (dto.status != 'granted') {
      throw WriteApiException.malformed(
        r'$.status',
        detail: '同意回包 status=${dto.status}，期望 granted',
      );
    }
    return dto;
  }

  @override
  Future<ConsentStateDto> withdrawConsent() async {
    final Object? decoded = await _send('POST', '/consent/withdraw', null);
    final ConsentStateDto dto = _parse(
      decoded,
      (Object? raw, String _) => ConsentStateDto.fromJson(raw),
    );
    // 撤回回包必须是 withdrawn / none（从未同意）：`granted` 说明没生效。
    if (dto.status == 'granted') {
      throw WriteApiException.malformed(
        r'$.status',
        detail: '撤回回包 status=granted —— 撤回没有生效',
      );
    }
    return dto;
  }

  @override
  Future<FamilyDeletionStateDto> requestFamilyDeletion() async {
    // ★ 请求体只有这一个布尔真值：冷却期、孩子、操作人全部由服务端决定。
    final Object? decoded = await _send('POST', '/family-deletion', <String, Object?>{
      'confirmed': true,
    });
    final FamilyDeletionStateDto dto = _parse(
      decoded,
      (Object? raw, String _) => FamilyDeletionStateDto.fromJson(raw),
    );
    // 申请成功的回包必须是 pending：`none` 说明什么都没发生（服务端没落库），
    // `executed` 说明它已经在删了 —— 两种都不该被界面显示成「已申请」。
    if (dto.status != 'pending') {
      throw WriteApiException.malformed(
        r'$.status',
        detail: '申请删除的回包 status=${dto.status}，期望 pending',
      );
    }
    return dto;
  }

  @override
  Future<FamilyDeletionStateDto> cancelFamilyDeletion() async {
    final Object? decoded =
        await _send('POST', '/family-deletion/cancel', null);
    final FamilyDeletionStateDto dto = _parse(
      decoded,
      (Object? raw, String _) => FamilyDeletionStateDto.fromJson(raw),
    );
    if (dto.status != 'cancelled') {
      throw WriteApiException.malformed(
        r'$.status',
        detail: '撤销删除的回包 status=${dto.status}，期望 cancelled',
      );
    }
    return dto;
  }

  @override
  Future<NotificationReadDto> markNotificationRead(String notificationId) async {
    final String id = _requireId(notificationId, 'notificationId');
    final Object? decoded = await _send('PATCH', '/notifications/$id/read', null);
    return _parse(
      decoded,
      (Object? raw, String path) =>
          NotificationReadDto.fromJson(raw, path, expectedNotificationId: id),
    );
  }

  String _requireId(String value, String name) {
    final String id = value.trim();
    if (id.isEmpty) throw ArgumentError.value(value, name, '不能为空');
    return id;
  }

  /// 严格解析失败（`ReadApiException`）也必须归一到写异常：
  /// 页面只处理一种错误类型，不必知道「这次是读 DTO 报的错」。
  T _parse<T>(Object? decoded, T Function(Object?, String) parse) {
    try {
      return parse(decoded, r'$');
    } on ReadApiException catch (error) {
      throw WriteApiException.malformed(
        r'$',
        detail: error.detail ?? error.userMessage,
      );
    }
  }

  Future<Object?> _send(
    String method,
    String path,
    Map<String, Object?>? body, {
    String? idempotencyKey,
  }) async {
    final String? configError = config.validationError;
    if (configError != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final String? key = idempotencyKey?.trim();
    if (key != null && key.length > 200) {
      throw ArgumentError.value(
        idempotencyKey,
        'idempotencyKey',
        '不能超过 200 字符（后端同口径）',
      );
    }

    final Uri uri = config.uri(path);
    final Map<String, String> headers = <String, String>{
      HttpHeaders.acceptHeader: 'application/json',
      if (body != null)
        HttpHeaders.contentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
      if (key != null && key.isNotEmpty) 'idempotency-key': key,
    };
    final String encoded = body == null ? '' : jsonEncode(body);

    final WriteHttpResponse response;
    try {
      response = await _transport
          .send(uri, headers, encoded, method: method)
          .timeout(timeout);
    } on TimeoutException {
      throw WriteApiException.timeout(timeout);
    } on IOException catch (error) {
      throw WriteApiException.network(error);
    }

    Object? decoded;
    if (response.body.trim().isNotEmpty) {
      try {
        decoded = jsonDecode(response.body);
      } on FormatException {
        decoded = null;
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw WriteApiException.fromHttp(
        statusCode: response.statusCode,
        body: decoded,
      );
    }
    if (decoded == null && body != null) {
      throw WriteApiException.malformed(
        r'$',
        detail: 'HTTP ${response.statusCode} 但响应体为空',
      );
    }
    return decoded;
  }

  @override
  void close() => _transport.close();
}
