import 'read_dto.dart';
import 'read_api_errors.dart';
import 'write_api_errors.dart';

/// `POST /records/check-in` 与 `POST /records/:id/reverse` 的 201 响应。
///
/// 线格式：
/// ```json
/// { "record": { ...与 GET /records 的行同构... }, "executedRecordId": "..." }
/// ```
///
/// `executedRecordId` 是**本次真正写下**的那条流水（撤销时是冲正记录）。
/// 它与 `record.id` 必须一致；不一致说明服务端契约漂移，客户端宁可显式失败，
/// 也不能拿一个无法对账的 id 去更新界面。
class WrittenRecordDto {
  WrittenRecordDto({
    required this.record,
    required this.executedRecordId,
  });

  factory WrittenRecordDto.fromJson(Object? raw, [String path = r'$']) {
    final Map<String, Object?> json = readObject(raw, path);
    final RecordDto record;
    try {
      record = RecordDto.fromJson(json['record'], '$path.record');
    } on ReadApiException catch (error) {
      // 读取层的严格解析失败也必须归一到写异常，页面只处理一种错误类型。
      throw WriteApiException.malformed(
        '$path.record',
        detail: error.detail ?? error.userMessage,
      );
    }
    final Object? rawExecutedRecordId = json['executedRecordId'];
    if (rawExecutedRecordId is! String) {
      throw WriteApiException.malformed(
        '$path.executedRecordId',
        detail: '期望字符串，实际 ${rawExecutedRecordId.runtimeType}',
      );
    }
    final String executedRecordId = rawExecutedRecordId;
    if (executedRecordId.isEmpty) {
      throw WriteApiException.malformed(
        '$path.executedRecordId',
        detail: 'executedRecordId 不能为空',
      );
    }
    if (executedRecordId != record.id) {
      throw WriteApiException.malformed(
        '$path.executedRecordId',
        detail:
            'executedRecordId=$executedRecordId 与 record.id=${record.id} 不一致',
      );
    }
    return WrittenRecordDto(
      record: record,
      executedRecordId: executedRecordId,
    );
  }

  final RecordDto record;

  /// 本次真正写下的流水 id（与 [record] 的 id 相同）。
  final String executedRecordId;
}

/// `POST /approvals` 的响应（`02` §4.3 / §9.3：孩子申请 → 202 + `pending`）。
///
/// 只放界面真正需要的字段 —— 审批的**判定**（谁能批、批完做什么）全在后端，
/// 客户端只负责「把状态如实讲给用户听」：
///   · `pending` ⇒ 已提交，等家长确认（**还没有**扣分，也**还没有**兑换）；
///   · `approved` ⇒ 已生效，可以刷新快照；
///   · `rejected` / `withdrawn` / `invalidated` ⇒ 没成，[autoReason] 说明哪条前提消失。
///
/// 刻意**不**把 `status` 收成枚举：后端将来加状态时，客户端应当能读出未知值并
/// 说「暂时无法确认」，而不是在解析层就崩掉（那时连提示都给不出）。
class ApprovalDto {
  ApprovalDto({
    required this.id,
    required this.action,
    required this.status,
    required this.executedRecordId,
    required this.autoReason,
  });

  factory ApprovalDto.fromJson(Object? raw, [String path = r'$']) {
    final Map<String, Object?> json = readObject(raw, path);
    return ApprovalDto(
      id: readString(json, 'id', path),
      action: readString(json, 'action', path),
      status: readString(json, 'status', path),
      executedRecordId: readOptionalString(json, 'executedRecordId', path),
      autoReason: readOptionalString(json, 'autoReason', path),
    );
  }

  final String id;
  final String action;

  /// `pending` / `approved` / `rejected` / `withdrawn` / `invalidated`。
  final String status;

  /// 批准那一刻真正落下的流水 id（`pending` / 被拒时为 null）。
  final String? executedRecordId;

  /// `invalidated` 的具体原因（`WISH_DELETED` / `INSUFFICIENT_POINTS` …），否则 null。
  final String? autoReason;
}

/// `PATCH /child` 的 200 响应（W5-E，2026-10-21）：`{ "childId": "...", "name": "..." }`。
///
/// 为什么回包要带 `childId`：改名是**跨设备可见**的事实，客户端必须能确认
/// 「服务端改的确实是我们正在显示的这个孩子」。若回包 id 与配置里的不一致，
/// 说明会话被打到了别的孩子上（后端 bug 或串号），此时把名字写到本地档案上
/// 就是给错误的孩子改名 —— 宁可显式失败（由 [WriteApiClient] 抛 malformed）。
///
/// [name] 以**服务端返回值**为准，而不是客户端输入：服务端会 trim、可能将来
/// 还会做敏感词替换，本地照抄输入就会显示一个库里不存在的昵称。
class ChildProfileDto {
  ChildProfileDto({required this.childId, required this.name});

  factory ChildProfileDto.fromJson(Object? raw, [String path = r'$']) {
    final Map<String, Object?> json = readObject(raw, path);
    final String childId = readString(json, 'childId', path);
    final String name = readString(json, 'name', path);
    if (childId.isEmpty) {
      throw WriteApiException.malformed(
        '$path.childId',
        detail: 'childId 不能为空',
      );
    }
    if (name.isEmpty) {
      throw WriteApiException.malformed(
        '$path.name',
        detail: 'name 不能为空（服务端不应保存空白昵称）',
      );
    }
    return ChildProfileDto(childId: childId, name: name);
  }

  final String childId;
  final String name;
}

/// `POST /trash/:kind/:id/restore` 与 `DELETE /trash/:kind/:id` 的响应（W5-F）。
///
/// 回包必须指向**刚操作的那一条**：`kind` / `id` 任一不一致 ⇒ malformed。
/// 不能拿一个别的条目去更新界面 —— 那会让家长以为恢复了 A，实际动了 B。
class TrashTargetDto {
  const TrashTargetDto({required this.kind, required this.id});

  factory TrashTargetDto.fromJson(
    Object? raw,
    String path, {
    required String expectedKind,
    required String expectedId,
  }) {
    final Map<String, Object?> json = readObject(raw, path);
    final String kind = readString(json, 'kind', '$path.kind');
    final String id = readString(json, 'id', '$path.id');
    if (kind != expectedKind) {
      throw WriteApiException.malformed(
        '$path.kind',
        detail: '回包 kind=$kind 与请求 $expectedKind 不一致',
      );
    }
    if (id != expectedId) {
      throw WriteApiException.malformed(
        '$path.id',
        detail: '回包 id=$id 与请求 $expectedId 不一致',
      );
    }
    return TrashTargetDto(kind: kind, id: id);
  }

  /// 线值（`point_rule` / `wish` / `habit`）
  final String kind;
  final String id;
}

// ───────────────────────────── 成员移出（W5-H） ─────────────────────────────

/// `DELETE /members/:id` 的 200 响应。
///
/// 服务端用 200（不是 204）就是为了让回包与请求**验明正身**：`memberId`
/// 必须等于被移出的那一行，`status` 必须是 `removed`。没有 body 的话，
/// 客户端只能靠「没报错」猜自己删对了人。
class MemberRemoveDto {
  MemberRemoveDto({
    required this.memberId,
    required this.status,
    required this.removedAt,
  });

  factory MemberRemoveDto.fromJson(
    Object? raw,
    String path, {
    required String expectedMemberId,
  }) {
    final Map<String, Object?> json = readObject(raw, path);
    final String memberId = readString(json, 'memberId', '$path.memberId');
    final String status = readString(json, 'status', '$path.status');
    final DateTime removedAt = readDate(json, 'removedAt', '$path.removedAt');
    if (memberId != expectedMemberId) {
      throw WriteApiException.malformed(
        '$path.memberId',
        detail: '回包 memberId=$memberId 与请求 $expectedMemberId 不一致',
      );
    }
    if (status != 'removed') {
      // `PATCH` 的冲突码是 `MEMBER_NOT_ACTIVE`；删除若回别的状态，
      // 说明契约漂移 —— 不能把它当成功从界面移除。
      throw WriteApiException.malformed(
        '$path.status',
        detail: '回包 status=$status 不是 expected removed',
      );
    }
    return MemberRemoveDto(
      memberId: memberId,
      status: status,
      removedAt: removedAt,
    );
  }

  final String memberId;
  final String status;
  final DateTime removedAt;
}

/// `POST /invites/:id/revoke` 的 200 响应：`{ "id": "...", "revoked": true }`。
///
/// 服务端对「已经吊销过的码」也回同一个 200（幂等，且不写第二条审计）。
/// 客户端因此**不能**把 200 当成「这次真的改了一行」—— UI 只需要把这一行
/// 标成已吊销（`InviteCode.revokedCopy()`）；回包的 `id` 必须等于请求的那一条，
/// `revoked` 必须是 `true`，否则说明契约漂移（拿错行的回包更新界面，
/// 会让家长以为吊销了 A，实际动的是 B）。
class InviteRevokeDto {
  InviteRevokeDto({required this.id, required this.revoked});

  factory InviteRevokeDto.fromJson(
    Object? raw,
    String path, {
    required String expectedInviteId,
  }) {
    final Map<String, Object?> json = readObject(raw, path);
    final String id = readString(json, 'id', '$path.id');
    final bool revoked = readBool(json, 'revoked', '$path.revoked');
    if (id != expectedInviteId) {
      throw WriteApiException.malformed(
        '$path.id',
        detail: '回包 id=$id 与请求 $expectedInviteId 不一致',
      );
    }
    if (!revoked) {
      // 200 却说「没吊销」= 后端没做成，却也没报错：说成功就是在骗用户。
      throw WriteApiException.malformed(
        '$path.revoked',
        detail: '回包 revoked=false，吊销未生效',
      );
    }
    return InviteRevokeDto(id: id, revoked: revoked);
  }

  final String id;
  final bool revoked;
}

/// `PATCH /notifications/:id/read` 的回包（W5-L）。
///
/// 只有 `{id, readAt}` 两个字段：
///   · `id` 必须等于请求的 id —— 指向别的通知说明会话串号 / 后端 bug，
///     把「已读」写到另一条上是会让人错过消息的错；
///   · `readAt` 是**服务端**的时间（已读再调时是**第一次**的时间），
///     客户端不要用 `DateTime.now()` 覆盖它。
class NotificationReadDto {
  NotificationReadDto({required this.id, required this.readAt});

  factory NotificationReadDto.fromJson(
    Object? raw,
    String path, {
    required String expectedNotificationId,
  }) {
    final Map<String, Object?> json = readObject(raw, path);
    final String id = readString(json, 'id', '$path.id');
    final DateTime readAt = readDate(json, 'readAt', '$path.readAt');
    if (id != expectedNotificationId) {
      throw WriteApiException.malformed(
        '$path.id',
        detail: '回包 id=$id 与请求 $expectedNotificationId 不一致',
      );
    }
    return NotificationReadDto(id: id, readAt: readAt);
  }

  final String id;
  final DateTime readAt;
}

