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

    /// 服务端已经写好的**给人看的中文**（`code` 与 `message` 一一对应：
    /// `backend/src/identity/account-identifier.ts` 的 `passwordMessage()` /
    /// `identifierMessage()`、`backend/src/identity/identity.service.ts` 的
    /// `INVITE_CODE_MALFORMED` 等）。
    ///
    /// ── 为什么这几支要**取服务端原文**而不是在客户端再写一遍 ────────────────
    ///   注册 / 登录的规则（8 位码形状、密码 8–64 位且不能是纯数字或常见弱口令、
    ///   标识必须像手机号或邮箱）只允许有一份实现。客户端抄一份文案就必然漂移，
    ///   漂移的现场正是 2026-11-03 用户遇到的：服务端返回了
    ///   `{"code":"WEAK_PASSWORD","message":"这个密码太常见了…"}`，
    ///   而 App 只显示「请求参数不被服务端接受（400）」—— 用户无法自查。
    ///
    /// ★ 只给**明确列入下面分支**的业务码用；Nest `ValidationPipe` 的
    ///   通用 400（`message` 是英文数组）仍然走客户端自己的中文兜底。
    String? serverMessage() {
      final String? raw = detail?.trim();
      return raw == null || raw.isEmpty ? null : raw;
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
      // ── 账号密码登录（W9-D）──────────────────────────────────────────────
      // 登录失败与「设备会话不存在」都是 401，但下一步完全不同：
      // 前者去检查手机号/密码（或去小程序重设密码），后者是设备没配对。
      // 以前这里只有后者，结果是**密码输错也会被告知「请重新配对设备」**。
      if (code == 'ACCOUNT_INVALID_CREDENTIALS') {
        return fail(
          WriteFailureKind.unauthenticated,
          serverMessage() ??
              '手机号/邮箱或密码不对（也可能是这个号还没有设置过密码）。'
                  '请重试；忘记密码的话请在小程序「我的 → 登录账号」里重设。',
        );
      }
      return fail(
        WriteFailureKind.unauthenticated,
        '设备身份无效或会话不存在（401），这次操作没有保存。请重新配对设备后再试。',
      );
    }
    if (statusCode == 403) {
      if (code == 'USER_NOT_ACTIVE') {
        // 账号被停用 —— 重试没有意义，要给出「找谁」而不是「稍后再试」。
        return fail(
          WriteFailureKind.forbidden,
          serverMessage() ?? '这个账号已被停用，无法登录。请联系家庭里的其他家长。',
        );
      }
      if (code == 'CURRENT_PASSWORD_INVALID') {
        // 改密码要带当前密码；错了不能退化成「没有权限（403）」——
        // 那会让用户以为自己不是家长。
        return fail(
          WriteFailureKind.forbidden,
          serverMessage() ?? '当前密码不对，这次没有保存。',
        );
      }
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
      // ── 注册 / 登录 / 改绑定（W9-D、W11-A、W12）：形状与强度 ────────────────
      // 这些码的文案**只**在后端有一份（`account-identifier.ts` 的
      // `passwordMessage()` / `identifierMessage()`、`invite-code.ts`、
      // `identity.service.ts` 的 `DEVICE_ID_REQUIRED`）。客户端取原文，
      // 不再抄第二份 —— 抄一份就会漂移成「本地放行、服务端 400」。
      switch (code) {
        case 'INVITE_CODE_MALFORMED':
        case 'WEAK_PASSWORD':
        case 'INVALID_IDENTIFIER':
        case 'INVALID_PHONE':
        case 'INVALID_EMAIL':
        case 'DEVICE_ID_REQUIRED':
        case 'ACCOUNT_NOTHING_TO_UPDATE':
        case 'CURRENT_PASSWORD_REQUIRED':
        case 'CONSENT_NOT_ACCEPTED':
          return fail(
            WriteFailureKind.badRequest,
            serverMessage() ?? '这次提交的内容不被接受（400），请检查后重试。',
          );
      }
      return fail(
        WriteFailureKind.badRequest,
        '请求参数不被服务端接受（400），这次操作没有保存。',
      );
    }
    if (statusCode == 409) {
      switch (code) {
        // ── 注册（W11-A / W12）的两个「换条路走」──────────────────────────
        // 这两个码必须原样把服务端的话给用户：一个说「码不能用，找家长重发」，
        // 一个说「这个号已经注册过，去登录」—— 混成「当前状态不允许这个操作」
        // 等于让人反复重试同一件事。
        case 'INVITE_CODE_UNAVAILABLE':
        case 'IDENTIFIER_TAKEN':
          return fail(
            WriteFailureKind.conflict,
            serverMessage() ?? '这张邀请码现在不能用，或这个手机号/邮箱已经注册过。',
          );
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
        // ── 加入家庭（P0-3，2026-11-03）──────────────────────────────────────
        // 「已经在这个家庭里」不是错误，但它必须**说清**：用户会以为
        // 刚才那次点击没生效，于是再点一次（服务端不会消耗名额，但体验很差）。
        // 文案取服务端原文（`invites.prisma.repository.ts:220`），不另写一份。
        case 'ALREADY_MEMBER':
          return fail(
            WriteFailureKind.conflict,
            serverMessage() ?? '你已经是这个家庭的成员了，这次没有消耗邀请码。',
          );
      }
      return fail(
        WriteFailureKind.conflict,
        '当前状态不允许这个操作（409），这次操作没有保存。',
      );
    }
    if (statusCode == 429) {
      // 登录 / 注册 / 验证码共用一份额度（`backend` 的三条端点同源限流）。
      // 429 是「等一会儿」，**不是**「参数错了」—— 以前它落进 badRequest，
      // 用户看到「请求参数不被服务端接受（429/400）」，然后不停重试。
      return fail(
        WriteFailureKind.conflict,
        serverMessage() ?? '操作太频繁了，请等一会儿再试（不要连续重试）。',
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
