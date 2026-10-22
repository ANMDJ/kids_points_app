/// 写端点（W4-E：打卡 / 撤销）的**失败分类**。
///
/// 与只读错误分开，是因为同一个 HTTP 状态码在两边的语义不同：
///   404 在只读里是「孩子不存在」，在写里更常见的是 `HABIT_NOT_FOUND` /
///   `RECORD_NOT_FOUND`；409 在只读里不会出现，在写里却是**主要**的业务拒绝
///   （已达每日上限、积分不足、已经撤销过）。
///
/// 页面只展示 [userMessage]，不按状态码另编文案 —— 这样后端新增业务码时，
/// 客户端不会把「今天已经完成 2 次」说成「网络错误」。
enum WriteFailureKind {
  /// 401：设备头缺失 / 会话不存在 / 已过期
  unauthenticated,

  /// 403：会话有效，但角色或成员关系不允许这次写
  forbidden,

  /// 404：习惯 / 流水 / 孩子不存在（或跨孩子，后端故意同样回答）
  notFound,

  /// 400：请求形状不被接受（含多传字段）
  badRequest,

  /// 409：业务拒绝（每日上限、积分不足、重复撤销……）
  conflict,

  /// 503：身份/成员依赖未就绪
  unavailable,

  /// 其它 5xx
  server,

  /// 连不上 / 连接被拒 / DNS 失败
  network,

  /// 超时
  timeout,

  /// 2xx 但 JSON 形状不符合契约
  malformed,
}

/// 写端点的统一异常：**永远**带一个可直接展示的中文说明。
class WriteApiException implements Exception {
  WriteApiException(
    this.kind,
    this.userMessage, {
    this.statusCode,
    this.code,
    this.detail,
  });

  factory WriteApiException.malformed(String path, {String? detail}) =>
      WriteApiException(
        WriteFailureKind.malformed,
        '服务器返回的写入结果不符合约定（字段 `$path`）。请确认客户端与服务端版本一致。',
        code: 'MALFORMED_RESPONSE',
        detail: detail,
      );

  factory WriteApiException.network(Object error) => WriteApiException(
        WriteFailureKind.network,
        '连不上服务器，这次操作没有保存。请检查网络后重试。',
        code: 'NETWORK_ERROR',
        detail: error.toString(),
      );

  factory WriteApiException.timeout(Duration timeout) => WriteApiException(
        WriteFailureKind.timeout,
        '请求超时（${timeout.inSeconds} 秒），这次操作可能未保存。请刷新确认后再试。',
        code: 'TIMEOUT',
      );

  /// 把 `!2xx` 响应翻译成异常。
  ///
  /// 业务码优先于状态码：`HABIT_DAILY_LIMIT_REACHED` 比「HTTP 409」对用户有用。
  /// 但解析失败时**绝不丢状态码**（诊断需要它）。
  factory WriteApiException.fromHttp({
    required int statusCode,
    required Object? body,
  }) {
    String? code;
    String? detail;
    if (body is Map) {
      final Object? rawCode = body['code'];
      if (rawCode is String && rawCode.isNotEmpty) code = rawCode;
      final Object? rawMessage = body['message'] ?? body['error'];
      if (rawMessage is String) {
        detail = rawMessage;
      } else if (rawMessage is List) {
        detail = rawMessage.whereType<String>().join('；');
      }
    }

    WriteApiException fail(WriteFailureKind kind, String message) =>
        WriteApiException(
          kind,
          message,
          statusCode: statusCode,
          code: code,
          detail: detail,
        );

    if (statusCode == 401) {
      return fail(
        WriteFailureKind.unauthenticated,
        '设备身份无效或会话不存在（401），这次操作没有保存。请重新配对设备后再试。',
      );
    }
    if (statusCode == 403) {
      if (code == 'APPROVAL_REQUIRED') {
        // 孩子在 `REQUIRE_APPROVAL` 下直接写心愿 / 规则时被拦 —— 这不是故障，
        // 而是约定：同一次操作必须走审批流。文案要给出**下一步**，但**不能**
        // 说“已提交”（403 时并没有生成审批单），否则家长会去审批页找不到任何东西。
        return fail(
          WriteFailureKind.forbidden,
          '这个操作需要家长确认，这次没有保存。请让家长直接操作（或由家长在「审批」里处理后再试）。',
        );
      }
      if (code == 'NOT_REQUESTER') {
        // W5-J：只有申请人本人能撤回。同一家庭里的另一位家长也不行 ——
        // 这是「谁的决定可以撤销」的问题，不是权限高低。
        return fail(
          WriteFailureKind.forbidden,
          '这不是你提交的申请，不能撤回（只有申请人本人可以）。',
        );
      }
      if (code == 'CANNOT_MODIFY_SELF') {
        // W5-H：成员写入口**都不能**作用于自己。降级自己会把自己锁在门外
        // （没有家长能再改回来）；移出自己则等于「退出家庭」——
        // 后端刻意不支持，靠家庭码重新加入才是正路。
        return fail(
          WriteFailureKind.forbidden,
          '不能修改自己的家庭成员身份，这次操作没有保存。请让另一位家长来处理。',
        );
      }
      return fail(
        WriteFailureKind.forbidden,
        '当前账号没有执行这个操作的权限（403），这次操作没有保存。',
      );
    }
    if (statusCode == 404) {
      if (code == 'HABIT_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这个习惯不存在或已被删除，无法打卡。',
        );
      }
      if (code == 'RECORD_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这条打卡记录不存在或已被删除，无法撤销。',
        );
      }
      if (code == 'RULE_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这条规则不存在或已被删除（可能已在别的设备上删掉了）。',
        );
      }
      if (code == 'WISH_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这个心愿不存在或已被删除（可能已在别的设备上删掉了）。',
        );
      }
      if (code == 'APPROVAL_NOT_FOUND') {
        return fail(
          WriteFailureKind.notFound,
          '这条审批请求不存在或已被删除，可能已在别的设备上处理过了。',
        );
      }
      if (code == 'MEMBER_NOT_FOUND') {
        // W5-H：不存在与「属于别的孩子」共用这一个 code —— 后端刻意不区分，
        // 客户端也没必要替它猜。
        return fail(
          WriteFailureKind.notFound,
          '这个成员不存在，或已被移出家庭，请刷新成员列表。',
        );
      }
      if (code == 'INVITE_NOT_FOUND') {
        // W5-I：同上，`INVITE_NOT_FOUND` 同时覆盖「不存在」与「属于别的孩子」，
        // 不替服务端区分（区分它等于给出一个探测别家邀请码的接口）。
        return fail(
          WriteFailureKind.notFound,
          '这个邀请码不存在或不属于当前孩子的档案，请刷新邀请码列表。',
        );
      }
      return fail(
        WriteFailureKind.notFound,
        '要操作的数据不存在或已被删除（404），这次操作没有保存。',
      );
    }
    if (statusCode == 400) {
      // ── 孩子档案（W5-E）：昵称的两条校验失败 ──────────────────────────────
      // 「参数不被接受」对改昵称毫无帮助；用户需要知道的是**改哪里**。
      if (code == 'CHILD_NAME_EMPTY') {
        return fail(
          WriteFailureKind.badRequest,
          '昵称不能为空，这次没有保存。',
        );
      }
      if (code == 'CHILD_NAME_TOO_LONG') {
        return fail(
          WriteFailureKind.badRequest,
          '昵称最多 16 个字符（表情按 1 个算），这次没有保存。',
        );
      }
      return fail(
        WriteFailureKind.badRequest,
        '请求参数不被服务端接受（400），这次操作没有保存。',
      );
    }
    if (statusCode == 409) {
      switch (code) {
        case 'HABIT_DAILY_LIMIT_REACHED':
          return fail(
            WriteFailureKind.conflict,
            '这个习惯今天的次数已经用完啦，明天继续加油～',
          );
        case 'INSUFFICIENT_POINTS':
          return fail(
            WriteFailureKind.conflict,
            '积分不足：这次操作会把余额扣成负数，没有保存。',
          );
        case 'ALREADY_REVERSED':
          return fail(
            WriteFailureKind.conflict,
            '这笔打卡已经撤销过了，不需要重复撤销。',
          );
        case 'NOT_A_HABIT_CHECK_IN':
        case 'CANNOT_REVERSE_REVERSAL':
          return fail(
            WriteFailureKind.conflict,
            '这笔记录不是可撤销的打卡记录。',
          );
        case 'HABIT_POINTS_INVALID':
          return fail(
            WriteFailureKind.conflict,
            '这个习惯的分值配置不正确，暂时不能打卡。',
          );
        case 'RULE_VERSION_CONFLICT':
          return fail(
            WriteFailureKind.conflict,
            '这条规则刚被其他人改动过，请刷新后再改（不会覆盖别人的修改）。',
          );
        case 'WISH_ALREADY_REDEEMED':
          return fail(
            WriteFailureKind.conflict,
            '这个心愿已经兑换过了，再申请一次会重复扣分，所以没有提交。',
          );
        case 'RULE_IS_PENALTY':
          return fail(
            WriteFailureKind.conflict,
            '这是扣分规则，不能加入今天的习惯。',
          );
        case 'HABIT_ALREADY_EXISTS':
          return fail(
            WriteFailureKind.conflict,
            '这个习惯已经在今天的习惯里了。',
          );
        // ── 审批收件箱（W5-D）的三个业务拒绝 ────────────────────────────────
        // 都要说清「列表已经变了，刷新一下」，否则家长会盯着一条已失效的申请反复点。
        case 'ALREADY_DECIDED':
          return fail(
            WriteFailureKind.conflict,
            '这条申请已经被处理过了（可能是在另一台设备上）。刷新一下就能看到最新状态。',
          );
        case 'APPROVAL_EXPIRED':
          return fail(
            WriteFailureKind.conflict,
            '这条申请已超过 72 小时有效期，现在不能再批 / 拒 / 撤回，请让孩子重新提交。',
          );
        case 'APPROVAL_INVALIDATED':
          return fail(
            WriteFailureKind.conflict,
            '这条申请的前提已经变了（心愿被删或积分不够），不能批准；刷新后可选择拒绝。',
          );
        // ── 家庭成员（W5-H）的两个业务拒绝 ──────────────────────────────────
        // 都是「这次改动会把家庭改坏」，必须说清为什么，不能当成网络故障重试。
        case 'LAST_GUARDIAN_PROTECTED':
          return fail(
            WriteFailureKind.conflict,
            '家庭里至少要有一位家长：这次改动会让家长变成 0 位，所以没有保存。请先把另一位成员设为家长。',
          );
        case 'MEMBER_NOT_ACTIVE':
          return fail(
            WriteFailureKind.conflict,
            '这个成员已经被移出家庭了，请刷新成员列表。',
          );
        // ── 邀请码（W5-I）────────────────────────────────────────────────────
        // `INVITE_CODE_GENERATION_FAILED` 是「连续撞码」——极小概率、可重试；
        // **不是**「你没有权限」，所以不能套用通用 409 文案（用户会去反复检查设置）。
        case 'INVITE_CODE_GENERATION_FAILED':
          return fail(
            WriteFailureKind.conflict,
            '连续生成的邀请码都撞上了已有的码（极少见），这次没有创建成功，请再试一次。',
          );
      }
      return fail(
        WriteFailureKind.conflict,
        '当前状态不允许这个操作（409），这次操作没有保存。',
      );
    }
    if (statusCode == 503) {
      return fail(
        WriteFailureKind.unavailable,
        '服务端身份校验未就绪（503），这次操作没有保存。请稍后重试。',
      );
    }
    return fail(
      statusCode >= 500 ? WriteFailureKind.server : WriteFailureKind.badRequest,
      '服务端返回 HTTP $statusCode，这次操作没有保存。请稍后重试。',
    );
  }

  final WriteFailureKind kind;
  final String userMessage;
  final int? statusCode;
  final String? code;
  final String? detail;

  /// 重试**可能**有用：网络、超时、5xx。
  /// 409 是明确的业务拒绝，原样重试只会再被拒一次。
  bool get isRetryable =>
      kind == WriteFailureKind.network ||
      kind == WriteFailureKind.timeout ||
      kind == WriteFailureKind.server ||
      kind == WriteFailureKind.unavailable;

  @override
  String toString() {
    final String status = statusCode == null ? '' : ' http=$statusCode';
    final String serverCode = code == null ? '' : ' code=$code';
    final String extra = detail == null ? '' : ' detail=$detail';
    return 'WriteApiException(${kind.name}$status$serverCode): $userMessage$extra';
  }
}
