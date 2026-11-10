import { ReadApiException } from './read_api_errors'

/**
 * 后端只读端点的**线格式**（wire DTO）—— 只负责「像不像」，不负责「画成什么」。
 *
 * 与 UI 模型（`Habit` / `PointRule` / `Wish` / `PointRecord`）刻意分开：
 * 前者跟 `backend/src/read/read.mapper.ts` 的 JSON 一一对应，后者是本地渲染用的。
 * 中间那层映射在 `read_mapper.ts` —— 服务端字段改名时只改这里和映射，UI 不动。
 *
 * 所有读取都**严格**：缺字段 / 类型不对 ⇒ `ReadApiException.malformed`，
 * 不做 `?? 0` / `?? ''` 那种「猜一个默认值」（那会让契约漂移静默通过）。
 */

export class HomeDto {
  constructor(
    readonly childId: string,
    readonly childName: string,
    readonly pointsBalance: number,
    readonly goodHabitCount: number,
    readonly rewardCount: number,
    readonly habits: HabitDto[],
    readonly rules: RuleDto[],
    readonly wishes: WishDto[]
  ) {}

  static fromJson(raw: unknown): HomeDto {
    const json = readObject(raw, '$')
    const child = readObject(json.child, 'child')
    return new HomeDto(
      readString(child, 'id', 'child.id'),
      readString(child, 'name', 'child.name'),
      readInt(child, 'pointsBalance', 'child.pointsBalance'),
      readInt(json, 'goodHabitCount', 'goodHabitCount'),
      readInt(json, 'rewardCount', 'rewardCount'),
      readList(json, 'habits', 'habits').map((item, index) =>
        HabitDto.fromJson(item, `habits[${index}]`)
      ),
      readList(json, 'rules', 'rules').map((item, index) =>
        RuleDto.fromJson(item, `rules[${index}]`)
      ),
      readList(json, 'wishes', 'wishes').map((item, index) =>
        WishDto.fromJson(item, `wishes[${index}]`)
      )
    )
  }
}

export class HabitDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly points: number,
    readonly icon: string,
    readonly color: string,
    readonly condition: string,
    readonly dailyLimit: number,
    readonly ruleId: string | null
  ) {}

  static fromJson(raw: unknown, path: string): HabitDto {
    const json = readObject(raw, path)
    return new HabitDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'points', `${path}.points`),
      readString(json, 'icon', `${path}.icon`),
      readString(json, 'color', `${path}.color`),
      readString(json, 'condition', `${path}.condition`),
      readInt(json, 'dailyLimit', `${path}.dailyLimit`),
      readOptionalString(json, 'ruleId', `${path}.ruleId`)
    )
  }
}

export class RuleDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly points: number,
    readonly direction: string,
    readonly icon: string,
    readonly color: string,
    readonly condition: string,
    readonly dailyLimit: number,
    readonly currentVersion: number
  ) {}

  static fromJson(raw: unknown, path: string): RuleDto {
    const json = readObject(raw, path)
    return new RuleDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'points', `${path}.points`),
      readString(json, 'direction', `${path}.direction`),
      readString(json, 'icon', `${path}.icon`),
      readString(json, 'color', `${path}.color`),
      readString(json, 'condition', `${path}.condition`),
      readInt(json, 'dailyLimit', `${path}.dailyLimit`),
      readInt(json, 'currentVersion', `${path}.currentVersion`)
    )
  }
}

export class WishDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly cost: number,
    readonly emoji: string,
    readonly coverStyle: string,
    readonly redeemed: boolean
  ) {}

  static fromJson(raw: unknown, path: string): WishDto {
    const json = readObject(raw, path)
    return new WishDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'cost', `${path}.cost`),
      readString(json, 'emoji', `${path}.emoji`),
      readString(json, 'coverStyle', `${path}.coverStyle`),
      readBool(json, 'redeemed', `${path}.redeemed`)
    )
  }
}

export class RecordDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly points: number,
    readonly category: string,
    readonly source: string,
    readonly operatorRole: string | null,
    readonly note: string,
    readonly habitId: string | null,
    readonly ruleId: string | null,
    readonly ruleVersion: number | null,
    readonly wishId: string | null,
    readonly reversesRecordId: string | null,
    readonly reversedAt: number | null,
    readonly balanceAfter: number,
    readonly createdAt: number
  ) {}

  static fromJson(raw: unknown, path: string): RecordDto {
    const json = readObject(raw, path)
    return new RecordDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'points', `${path}.points`),
      readString(json, 'category', `${path}.category`),
      readString(json, 'source', `${path}.source`),
      readOptionalString(json, 'operatorRole', `${path}.operatorRole`),
      readString(json, 'note', `${path}.note`),
      readOptionalString(json, 'habitId', `${path}.habitId`),
      readOptionalString(json, 'ruleId', `${path}.ruleId`),
      readOptionalInt(json, 'ruleVersion', `${path}.ruleVersion`),
      readOptionalString(json, 'wishId', `${path}.wishId`),
      readOptionalString(json, 'reversesRecordId', `${path}.reversesRecordId`),
      readOptionalDate(json, 'reversedAt', `${path}.reversedAt`),
      readInt(json, 'balanceAfter', `${path}.balanceAfter`),
      readDate(json, 'createdAt', `${path}.createdAt`)
    )
  }
}

export class RecordsPageDto {
  constructor(
    readonly records: RecordDto[],
    readonly limit: number,
    readonly hasMore: boolean,
    readonly nextCursor: string | null
  ) {}

  static fromJson(raw: unknown): RecordsPageDto {
    const json = readObject(raw, '$')
    const records = readList(json, 'records', 'records').map((item, index) =>
      RecordDto.fromJson(item, `records[${index}]`)
    )
    const hasMore = readBool(json, 'hasMore', 'hasMore')
    const nextCursor = readOptionalString(json, 'nextCursor', 'nextCursor')

    // 两个字段必须自洽：否则客户端要么提前停，要么对着 null 死循环。
    if (hasMore && (nextCursor === null || nextCursor === '')) {
      throw ReadApiException.malformed(
        'nextCursor',
        'hasMore=true 但没有游标，客户端无法取下一页'
      )
    }
    if (!hasMore && nextCursor !== null) {
      throw ReadApiException.malformed(
        'nextCursor',
        'hasMore=false 却给了游标'
      )
    }

    return new RecordsPageDto(
      records,
      readInt(json, 'limit', 'limit'),
      hasMore,
      nextCursor
    )
  }
}


// ─────────────────────── 家长审批收件箱（W5-D） ───────────────────────

/**
 * `summary` 的线格式：按 `kind` 分派的三元联合。
 *
 * 服务端**不**下发展示串（`02` §4.3 / `approval-inbox.mapper.ts`）：
 * 文案要随客户端语言与排版变化，塞进响应就会两端口径漂移。
 */
export type ApprovalSummaryDto =
  | { kind: 'redeem'; wishId: string; title: string; cost: number }
  | {
      kind: 'bonus'
      amount: number
      reason: string
      ruleId: string | null
      habitId: string | null
      basisTitle: string | null
    }
  | { kind: 'add_wish'; title: string; cost: number; emoji: string }

/**
 * `GET /approvals` 的一行。
 *
 * ★ 与 `ApprovalDto`（写回包）**不合并**：写回包只带判定结果，列表行带
 *   `summary` / `createdAt` / `expiresAt`。合并会让写路径被迫读一堆用不上的
 *   字段，也会让「列表多读一个字段」变成对写端点的契约要求。
 */
export class ApprovalInboxItemDto {
  constructor(
    readonly id: string,
    readonly action: string,
    readonly status: string,
    readonly requesterUserId: string,
    readonly decidedByUserId: string | null,
    readonly executedRecordId: string | null,
    readonly autoReason: string | null,
    readonly createdAt: number,
    readonly decidedAt: number | null,
    readonly expiresAt: number,
    /** `null` = payload 读不懂，或 `kind` 比客户端新 —— 一律显示「内容无法识别」。 */
    readonly summary: ApprovalSummaryDto | null,
    /**
     * 申请人建请求时的成员位（`guardian` / `child`）。
     *
     * ★ P1-3（2026-11-10）：只有详情接口（`GET /approvals/:id`）会下发；
     *   列表 / 老服务端没有 ⇒ `null`。界面兜底成「家庭成员提交」，**不猜**。
     */
    readonly requesterRole: string | null = null
  ) {}

  static fromJson(raw: unknown, path: string): ApprovalInboxItemDto {
    const json = readObject(raw, path)
    return new ApprovalInboxItemDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'action', `${path}.action`),
      readString(json, 'status', `${path}.status`),
      readString(json, 'requesterUserId', `${path}.requesterUserId`),
      readOptionalString(json, 'decidedByUserId', `${path}.decidedByUserId`),
      readOptionalString(json, 'executedRecordId', `${path}.executedRecordId`),
      readOptionalString(json, 'autoReason', `${path}.autoReason`),
      readDate(json, 'createdAt', `${path}.createdAt`),
      readOptionalDate(json, 'decidedAt', `${path}.decidedAt`),
      readDate(json, 'expiresAt', `${path}.expiresAt`),
      readApprovalSummary(json.summary, `${path}.summary`),
      readOptionalString(json, 'requesterRole', `${path}.requesterRole`)
    )
  }
}

/**
 * `summary` 的宽松读取：`null` / 未知 `kind` 返回 `null`，**不抛**。
 *
 * 为什么：服务端把「payload 读不懂」定义成 `summary: null`（合法响应），
 * 未知 `kind` 是「服务端比客户端新」的正常情况 —— 这两种都不该让整页失败：
 * 客户端仍然能列出来、能拒绝，只是不能批准。
 * 已知 `kind` 的字段缺失 / 类型不对**仍然**抛 malformed（契约漂移必须响）。
 */
export function readApprovalSummary(
  raw: unknown,
  path: string
): ApprovalSummaryDto | null {
  if (raw === undefined || raw === null) return null
  const json = readObject(raw, path)
  const kind = readString(json, 'kind', `${path}.kind`)
  switch (kind) {
    case 'redeem':
      return {
        kind,
        wishId: readString(json, 'wishId', `${path}.wishId`),
        title: readString(json, 'title', `${path}.title`),
        cost: readInt(json, 'cost', `${path}.cost`)
      }
    case 'bonus':
      return {
        kind,
        amount: readInt(json, 'amount', `${path}.amount`),
        reason: readString(json, 'reason', `${path}.reason`),
        ruleId: readOptionalString(json, 'ruleId', `${path}.ruleId`),
        habitId: readOptionalString(json, 'habitId', `${path}.habitId`),
        basisTitle: readOptionalString(
          json,
          'basisTitle',
          `${path}.basisTitle`
        )
      }
    case 'add_wish':
      return {
        kind,
        title: readString(json, 'title', `${path}.title`),
        cost: readInt(json, 'cost', `${path}.cost`),
        emoji: readString(json, 'emoji', `${path}.emoji`)
      }
    default:
      return null
  }
}

/**
 * `GET /approvals` 的一页。
 *
 * 与 [RecordsPageDto] 同一纪律：`hasMore` 与 `nextCursor` 必须自洽，
 * 否则客户端要么提前停、要么对着 null 死循环。
 */
export class ApprovalsPageDto {
  constructor(
    readonly items: ApprovalInboxItemDto[],
    readonly hasMore: boolean,
    readonly nextCursor: string | null
  ) {}

  static fromJson(raw: unknown): ApprovalsPageDto {
    const json = readObject(raw, '$')
    const items = readList(json, 'items', 'items').map((item, index) =>
      ApprovalInboxItemDto.fromJson(item, `items[${index}]`)
    )
    const hasMore = readBool(json, 'hasMore', 'hasMore')
    const nextCursor = readOptionalString(json, 'nextCursor', 'nextCursor')

    if (hasMore && (nextCursor === null || nextCursor === '')) {
      throw ReadApiException.malformed(
        'nextCursor',
        'hasMore=true 但没有游标，客户端无法取下一页'
      )
    }
    if (!hasMore && nextCursor !== null) {
      throw ReadApiException.malformed('nextCursor', 'hasMore=false 却给了游标')
    }

    return new ApprovalsPageDto(items, hasMore, nextCursor)
  }
}

// ───────────────────────────── 站内通知（W5-L） ─────────────────────────────

/**
 * `GET /notifications` 的一行。
 *
 * `payload` 刻意**宽松**读取：它是「回到对应页面」的不透明夹带（目前只有
 * `approvalId`），将来后端加别的键时，老客户端应当照常把这条列出来 ——
 * 标题 / 正文本来就自解释。读不懂就存 null，由 `notificationApprovalId`
 * 决定「有没有可跳转的目标」。
 *
 * `type` 也**不**枚举：服务端加新类型时不能整页失败（见 `mapNotification`）。
 */
export class NotificationDto {
  constructor(
    readonly id: string,
    readonly type: string,
    readonly title: string,
    readonly body: string,
    readonly payload: unknown,
    /** 未读 ⇒ null；已读 ⇒ 具体时间。界面据此画红点 / 灰化。 */
    readonly readAt: number | null,
    readonly createdAt: number
  ) {}

  /** 未读 = 服务端没给 `readAt`。**只**从这一个字段推导。 */
  get isUnread(): boolean {
    return this.readAt === null
  }

  static fromJson(raw: unknown, path = '$'): NotificationDto {
    const json = readObject(raw, path)
    const id = readString(json, 'id', `${path}.id`)
    if (id.trim() === '') {
      throw ReadApiException.malformed(`${path}.id`, '通知 id 不能为空')
    }
    return new NotificationDto(
      id,
      readString(json, 'type', `${path}.type`),
      readString(json, 'title', `${path}.title`),
      readString(json, 'body', `${path}.body`),
      json.payload,
      readOptionalDate(json, 'readAt', `${path}.readAt`),
      readDate(json, 'createdAt', `${path}.createdAt`)
    )
  }
}

/**
 * `GET /notifications` 的一页。
 *
 * 与 [ApprovalsPageDto] 同一纪律：`hasMore` 与 `nextCursor` 必须自洽。
 * 多出来的 `unreadCount` 是**整份**未读数（不是本页）—— 红点用它，
 * 客户端不要自己对 `items` 求和（本页之外的未读会被漏掉）。
 */
export class NotificationsPageDto {
  constructor(
    readonly items: NotificationDto[],
    readonly hasMore: boolean,
    readonly nextCursor: string | null,
    readonly unreadCount: number
  ) {}

  static fromJson(raw: unknown): NotificationsPageDto {
    const json = readObject(raw, '$')
    const items = readList(json, 'items', 'items').map((item, index) =>
      NotificationDto.fromJson(item, `items[${index}]`)
    )
    const hasMore = readBool(json, 'hasMore', 'hasMore')
    const nextCursor = readOptionalString(json, 'nextCursor', 'nextCursor')
    const unreadCount = readInt(json, 'unreadCount', 'unreadCount')

    if (hasMore && (nextCursor === null || nextCursor === '')) {
      throw ReadApiException.malformed(
        'nextCursor',
        'hasMore=true 但没有游标，客户端无法取下一页'
      )
    }
    if (!hasMore && nextCursor !== null) {
      throw ReadApiException.malformed('nextCursor', 'hasMore=false 却给了游标')
    }
    if (unreadCount < 0) {
      // 负数只可能是契约漂移；画成 0 会把「红点没了」说成正常。
      throw ReadApiException.malformed(
        'unreadCount',
        `未读数不能为负：${unreadCount}`
      )
    }

    return new NotificationsPageDto(items, hasMore, nextCursor, unreadCount)
  }
}

/**
 * `GET /trash` 的一行（W5-F）。
 *
 * 服务端只下发**事实**（`deletedAt`）；`expired` / 「还能恢复几天」由
 * `isTrashExpired` / `trashRetentionText` 现算。线格式里再塞一个 `expiresAt`
 * 就等于多一份 90 天常量 —— 界面与接口迟早给出两个互相矛盾的答案。
 */
export class TrashItemDto {
  constructor(
    /** 线值：`point_rule` / `wish` / `habit`（由 `mapTrash` 严格校验） */
    readonly kind: string,
    readonly id: string,
    readonly title: string,
    /** ISO-8601 解析后的 epoch 毫秒。 */
    readonly deletedAt: number
  ) {}

  static fromJson(raw: unknown, path: string): TrashItemDto {
    const json = readObject(raw, path)
    return new TrashItemDto(
      readString(json, 'kind', `${path}.kind`),
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      // 后端下发 ISO-8601 串；`readDate` 严格解析（不是「猜 now」）。
      readDate(json, 'deletedAt', `${path}.deletedAt`)
    )
  }
}

/**
 * `GET /trash` 的响应体。
 *
 * 不分页：回收站是低频、小集合（用户主动删的东西不会多到需要游标）。
 */
export class TrashListDto {
  constructor(readonly items: TrashItemDto[]) {}

  static fromJson(raw: unknown): TrashListDto {
    const json = readObject(raw, '$')
    return new TrashListDto(
      readList(json, 'items', 'items').map((item, index) =>
        TrashItemDto.fromJson(item, `items[${index}]`)
      )
    )
  }
}

// ───────────────────────────── 家庭成员（W5-H） ─────────────────────────────

/**
 * `GET /members` 的一行。
 *
 * 线格式**只下发事实**：`role` / `status` / `isSelf`，没有
 * `canChangeRole` / `canRemove` 之类的结论 —— 谁能对谁做什么由服务端屏障二
 * 判定；客户端按「我是家长 ⇒ 显示入口」渲染，被拒绝时再按 403 的 `code`
 * 解释原因（`25-w5h-handoff.md` §2.6）。
 *
 * `role` / `status` 故意保留**线值字符串**：枚举校验集中在
 * `mapMember`（不认识的值显式抛错），DTO 层不替界面猜。
 */
export class MemberDto {
  constructor(
    readonly memberId: string,
    readonly userId: string,
    readonly displayName: string | null,
    /** 线值：`guardian` / `child` / `viewer`（由 `mapMember` 严格转换） */
    readonly role: string,
    /** 线值：`active` / `removed` */
    readonly status: string,
    readonly joinedAt: number,
    readonly removedAt: number | null,
    /** 服务端算的「这一行是不是我」—— 客户端不知道自己的 userId。 */
    readonly isSelf: boolean
  ) {}

  static fromJson(raw: unknown, path = '$'): MemberDto {
    const json = readObject(raw, path)
    return new MemberDto(
      readString(json, 'memberId', `${path}.memberId`),
      readString(json, 'userId', `${path}.userId`),
      readOptionalString(json, 'displayName', `${path}.displayName`),
      readString(json, 'role', `${path}.role`),
      readString(json, 'status', `${path}.status`),
      readDate(json, 'joinedAt', `${path}.joinedAt`),
      readOptionalDate(json, 'removedAt', `${path}.removedAt`),
      readBool(json, 'isSelf', `${path}.isSelf`)
    )
  }
}

/**
 * `GET /members` 的响应体。
 *
 * 不分页、也不含 `removed`：单孩子量小，被移出的人只能在审计里看到
 * （`25-w5h-handoff.md` §5）。
 */
export class MemberListDto {
  constructor(readonly items: MemberDto[]) {}

  static fromJson(raw: unknown): MemberListDto {
    const json = readObject(raw, '$')
    return new MemberListDto(
      readList(json, 'items', 'items').map((item, index) =>
        MemberDto.fromJson(item, `items[${index}]`)
      )
    )
  }
}

/**
 * `GET /invites` 的一行 / `POST /invites` 的回包（W5-I）。
 *
 * 与成员 DTO 同样只下发**事实**：`usedCount` / `maxUses` / `expiresAt` /
 * `revoked`，没有 `expired` / `usable` 这类结论字段 —— 「还能不能用」由
 * `inviteStatusOf` 在渲染时现算（弹窗开着跨过有效期时，缓存的布尔值会说谎）。
 *
 * `role` 故意保留**线值字符串**：枚举校验集中在 `mapInvite`
 * （`viewer` 显式抛错），DTO 层不替界面猜。
 */
export class InviteDto {
  constructor(
    readonly id: string,
    readonly code: string,
    /** 线值：`child` / `guardian`（由 `mapInvite` 严格转换） */
    readonly role: string,
    readonly maxUses: number,
    readonly usedCount: number,
    readonly expiresAt: number,
    readonly revoked: boolean,
    readonly createdAt: number
  ) {}

  static fromJson(raw: unknown, path = '$'): InviteDto {
    const json = readObject(raw, path)
    return new InviteDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'code', `${path}.code`),
      readString(json, 'role', `${path}.role`),
      readInt(json, 'maxUses', `${path}.maxUses`),
      readInt(json, 'usedCount', `${path}.usedCount`),
      readDate(json, 'expiresAt', `${path}.expiresAt`),
      readBool(json, 'revoked', `${path}.revoked`),
      readDate(json, 'createdAt', `${path}.createdAt`)
    )
  }
}

/**
 * `GET /invites` 的响应体（`{ items: [...] }`）。
 *
 * 不分页：一个孩子的邀请码是小集合，且列表里给的是**凭据**本身，
 * 翻页只会让「我刚才那个码在哪」更难找。
 */
export class InviteListDto {
  constructor(readonly items: InviteDto[]) {}

  static fromJson(raw: unknown): InviteListDto {
    const json = readObject(raw, '$')
    return new InviteListDto(
      readList(json, 'items', 'items').map((item, index) =>
        InviteDto.fromJson(item, `items[${index}]`)
      )
    )
  }
}

// ─────────────────────────── 监护人同意（W7-B） ───────────────────────────

/**
 * `GET /consent` 的响应体。
 *
 * 线值（`backend/src/contracts/consent-policy.ts` 的 `CONSENT_STATUSES`）：
 * `granted` / `withdrawn` / `none`。`status` 在这里**只保证是字符串**，
 * 认识的枚举交给 `mapConsent` —— 与 `MemberDto.role` 同一条原则：
 * DTO 负责形状，mapper 负责语义。
 *
 * 三个可选字段的**形状一致性**也在这里校验（后端一定满足，校验是为了
 * 契约漂移时显式失败，而不是在界面上画出「已同意但没有版本号」）：
 *   · `granted` ⇒ `consentVersion` 与 `grantedAt` 都必须有；
 *   · `withdrawn` ⇒ `withdrawnAt` 必须有；
 *   · `none` ⇒ 三个字段都为 null。
 */
export class ConsentStateDto {
  constructor(
    readonly childId: string,
    readonly status: string,
    readonly consentVersion: string | null,
    readonly grantedAt: number | null,
    readonly withdrawnAt: number | null
  ) {
    if (childId.trim() === '') {
      throw ReadApiException.malformed('$.childId', 'childId 不能为空')
    }
    switch (status) {
      case 'granted':
        if ((consentVersion ?? '').trim() === '') {
          throw ReadApiException.malformed(
            '$.consentVersion',
            'status=granted 时必须带协议版本'
          )
        }
        if (grantedAt === null) {
          throw ReadApiException.malformed(
            '$.grantedAt',
            'status=granted 时必须带同意时间'
          )
        }
        break
      case 'withdrawn':
        if (withdrawnAt === null) {
          throw ReadApiException.malformed(
            '$.withdrawnAt',
            'status=withdrawn 时必须带撤回时间'
          )
        }
        break
      case 'none':
        if (
          consentVersion !== null ||
          grantedAt !== null ||
          withdrawnAt !== null
        ) {
          throw ReadApiException.malformed(
            '$.status',
            'status=none 时 consentVersion / grantedAt / withdrawnAt 必须为 null'
          )
        }
        break
      default:
        // 未知状态不在这里判：DTO 只保证形状，`mapConsent` 才决定
        // 「认不认识」—— 与 `MemberDto.role` 同一条分工。
        break
    }
  }

  static fromJson(raw: unknown, path = '$'): ConsentStateDto {
    const json = readObject(raw, path)
    return new ConsentStateDto(
      readString(json, 'childId', `${path}.childId`),
      readString(json, 'status', `${path}.status`),
      readOptionalString(json, 'consentVersion', `${path}.consentVersion`),
      readOptionalDate(json, 'grantedAt', `${path}.grantedAt`),
      readOptionalDate(json, 'withdrawnAt', `${path}.withdrawnAt`)
    )
  }
}

// ─────────────────────────── 家庭数据导出（W7-C） ───────────────────────────

/**
 * `GET /export` 文件的**头与摘要**（不是九个数据段）。
 *
 * 导出文件是给家长带走的 `.json`，客户端只取「这份文件里有什么」这一层：
 * `schemaVersion` / `generatedAt` / `child` / `summary`。九个数据段**故意**
 * 不解析成模型 —— 界面不消费它们，解析只会多一份必须跟着后端同步的形状。
 *
 * `rawJson` 是**服务端原样下发的文本**：复制 / 落盘都给家长同一份文件，
 * 而不是按本地模型重新序列化出来的近似物。
 *
 * 形状校验里还有两条「诚实性」断言（后端一定满足，校验是为了契约漂移时
 * 显式失败，而不是在界面上画出「文件完整」但实际被截断）：
 *   · `truncated === (truncatedSections.length > 0)`
 *   · 任何一段的条数都不为负
 */
export class FamilyExportDto {
  constructor(
    readonly rawJson: string,
    readonly schemaVersion: number,
    readonly generator: string,
    readonly generatedAt: number,
    readonly childId: string,
    readonly childName: string,
    readonly pointsBalance: number,
    readonly counts: Record<string, number>,
    readonly totals: Record<string, number>,
    readonly truncated: boolean,
    readonly truncatedSections: string[]
  ) {
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw ReadApiException.malformed(
        '$.schemaVersion',
        `文件格式版本必须是正整数，实际 ${schemaVersion}`
      )
    }
    if (generator.trim() === '') {
      throw ReadApiException.malformed('$.generator', 'generator 不能为空')
    }
    if (childId.trim() === '') {
      throw ReadApiException.malformed('$.child.id', 'child.id 不能为空')
    }
    if (truncated && truncatedSections.length === 0) {
      throw ReadApiException.malformed(
        '$.summary.truncatedSections',
        'truncated=true 时必须说明哪几段被截断'
      )
    }
    if (!truncated && truncatedSections.length > 0) {
      throw ReadApiException.malformed(
        '$.summary.truncated',
        'truncatedSections 非空时 truncated 必须为 true'
      )
    }
  }

  static fromJson(
    raw: unknown,
    rawJson: string,
    path = '$'
  ): FamilyExportDto {
    const json = readObject(raw, path)
    const child = readObject(json.child, `${path}.child`)
    const summary = readObject(json.summary, `${path}.summary`)
    return new FamilyExportDto(
      rawJson,
      readInt(json, 'schemaVersion', `${path}.schemaVersion`),
      readString(json, 'generator', `${path}.generator`),
      readDate(json, 'generatedAt', `${path}.generatedAt`),
      readString(child, 'id', `${path}.child.id`),
      readString(child, 'name', `${path}.child.name`),
      readInt(child, 'pointsBalance', `${path}.child.pointsBalance`),
      readCountMap(summary, 'counts', `${path}.summary.counts`),
      readCountMap(summary, 'totals', `${path}.summary.totals`),
      readBool(summary, 'truncated', `${path}.summary.truncated`),
      readList(
        summary,
        'truncatedSections',
        `${path}.summary.truncatedSections`
      ).map((item) => {
        if (typeof item === 'string') return item
        throw ReadApiException.malformed(
          `${path}.summary.truncatedSections`,
          `期望字符串数组，实际元素 ${typeName(item)}`
        )
      })
    )
  }
}

// ───────────────────────────── 严格读取助手 ─────────────────────────────

export function readObject(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw ReadApiException.malformed(path, `期望对象，实际 ${typeName(value)}`)
}

export function readList(
  json: Record<string, unknown>,
  key: string,
  path: string
): unknown[] {
  const value = json[key]
  if (Array.isArray(value)) return value
  throw ReadApiException.malformed(path, `期望数组，实际 ${typeName(value)}`)
}

export function readString(
  json: Record<string, unknown>,
  key: string,
  path: string
): string {
  const value = json[key]
  if (typeof value === 'string') return value
  throw ReadApiException.malformed(
    path,
    `期望字符串，实际 ${typeName(value)}`
  )
}

export function readOptionalString(
  json: Record<string, unknown>,
  key: string,
  path: string
): string | null {
  const value = json[key]
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw ReadApiException.malformed(
    path,
    `期望字符串或 null，实际 ${typeName(value)}`
  )
}

export function readInt(
  json: Record<string, unknown>,
  key: string,
  path: string
): number {
  const value = json[key]
  // JSON 里大整数可能被解成 5.0；只接受**无损**整数，避免悄悄取整。
  if (typeof value === 'number' && Number.isInteger(value)) return value
  throw ReadApiException.malformed(path, `期望整数，实际 ${typeName(value)}`)
}

export function readOptionalInt(
  json: Record<string, unknown>,
  key: string,
  path: string
): number | null {
  if (json[key] === undefined || json[key] === null) return null
  return readInt(json, key, path)
}

export function readBool(
  json: Record<string, unknown>,
  key: string,
  path: string
): boolean {
  const value = json[key]
  if (typeof value === 'boolean') return value
  throw ReadApiException.malformed(
    path,
    `期望布尔值，实际 ${typeName(value)}`
  )
}

/** ISO-8601 → epoch 毫秒；交给 `Date` 渲染成本地时间。 */
export function readDate(
  json: Record<string, unknown>,
  key: string,
  path: string
): number {
  const raw = readString(json, key, path)
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) {
    throw ReadApiException.malformed(path, `不是 ISO-8601 时间：${raw}`)
  }
  return parsed
}

export function readOptionalDate(
  json: Record<string, unknown>,
  key: string,
  path: string
): number | null {
  if (json[key] === undefined || json[key] === null) return null
  return readDate(json, key, path)
}

/**
 * 读一个「段名 → 条数」的字典：键保持下发顺序，值必须是非负整数。
 *
 * `parent[key]` 必须先是一个对象 —— `undefined` / `null` / 数组都算形状错误，
 * 而不是「空字典」：把缺失的 `counts` 当成 0 会让面板画出「文件里有 0 条」，
 * 那是比报错更糟的假象。
 */
export function readCountMap(
  parent: Record<string, unknown>,
  key: string,
  path: string
): Record<string, number> {
  const raw = readObject(parent[key], path)
  const result: Record<string, number> = {}
  for (const name of Object.keys(raw)) {
    const value = readInt(raw, name, `${path}.${name}`)
    if (value < 0) {
      throw ReadApiException.malformed(
        `${path}.${name}`,
        `条数不能为负：${value}`
      )
    }
    result[name] = value
  }
  if (Object.keys(result).length === 0) {
    throw ReadApiException.malformed(path, '至少要有一段')
  }
  return result
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// ─────────────────────────── 家庭数据删除（W7-D） ───────────────────────────

/** 执行摘要的线格式：十个行数字段缺一个就 `malformed`。 */
export class FamilyDeletionSummaryDto {
  constructor(
    readonly coolingDays: number,
    readonly redacted: Record<string, number>,
    readonly keptRecords: number,
    readonly keptPointsBalance: number,
    readonly note: string
  ) {
    const keys = [
      'child',
      'members',
      'rules',
      'ruleVersions',
      'habits',
      'wishes',
      'records',
      'approvals',
      'consents',
      'notifications'
    ]
    for (const key of keys) {
      const value = redacted[key]
      if (typeof value !== 'number') {
        throw ReadApiException.malformed(
          `$.summary.redacted.${key}`,
          '摘要缺少这一类行数'
        )
      }
    }
    if (!Number.isInteger(coolingDays) || coolingDays < 1) {
      throw ReadApiException.malformed(
        '$.summary.coolingDays',
        `冷却期天数必须是正整数，实际 ${coolingDays}`
      )
    }
    if (!Number.isInteger(keptRecords) || keptRecords < 0) {
      throw ReadApiException.malformed(
        '$.summary.kept.records',
        `保留流水条数不能为负，实际 ${keptRecords}`
      )
    }
    if (note.trim() === '') {
      throw ReadApiException.malformed('$.summary.note', 'note 不能为空')
    }
  }

  static fromJson(raw: unknown, path = '$'): FamilyDeletionSummaryDto {
    const json = readObject(raw, path)
    const redacted = readObject(json.redacted, `${path}.redacted`)
    const kept = readObject(json.kept, `${path}.kept`)
    const counts: Record<string, number> = {}
    for (const key of Object.keys(redacted)) {
      const value = readInt(redacted, key, `${path}.redacted.${key}`)
      if (value < 0) {
        throw ReadApiException.malformed(
          `${path}.redacted.${key}`,
          `行数不能为负：${value}`
        )
      }
      counts[key] = value
    }
    return new FamilyDeletionSummaryDto(
      readInt(json, 'coolingDays', `${path}.coolingDays`),
      counts,
      readInt(kept, 'records', `${path}.kept.records`),
      readInt(kept, 'pointsBalance', `${path}.kept.pointsBalance`),
      readString(json, 'note', `${path}.note`)
    )
  }
}

/**
 * `GET /family-deletion` 的回包（W7-D）。
 *
 * 形状校验盯着「自相矛盾」：pending 必须答得出「还剩几天 / 能不能撤销」，
 * executed 必须带执行摘要，非 executed 带摘要则说明拼错了孩子的历史。
 */
export class FamilyDeletionStateDto {
  constructor(
    readonly childId: string,
    readonly status: string,
    readonly requestedAt: number | null,
    readonly scheduledFor: number | null,
    readonly cancelledAt: number | null,
    readonly executedAt: number | null,
    readonly daysRemaining: number | null,
    readonly canCancel: boolean,
    readonly summary: FamilyDeletionSummaryDto | null
  ) {
    if (childId.trim() === '') {
      throw ReadApiException.malformed('$.childId', 'childId 不能为空')
    }
    switch (status) {
      case 'none':
        if (requestedAt !== null || scheduledFor !== null) {
          throw ReadApiException.malformed(
            '$.requestedAt',
            'status=none 时不应带申请时间'
          )
        }
        break
      case 'pending':
        if (requestedAt === null || scheduledFor === null) {
          throw ReadApiException.malformed(
            '$.scheduledFor',
            'status=pending 时必须带申请时间与执行时刻'
          )
        }
        if (daysRemaining === null) {
          throw ReadApiException.malformed(
            '$.daysRemaining',
            'status=pending 时必须给出剩余天数（客户端不猜）'
          )
        }
        if (!canCancel) {
          throw ReadApiException.malformed(
            '$.canCancel',
            'status=pending 时应当可以撤销'
          )
        }
        break
      case 'cancelled':
        if (cancelledAt === null) {
          throw ReadApiException.malformed(
            '$.cancelledAt',
            'status=cancelled 时必须带撤销时间'
          )
        }
        break
      case 'executed':
        if (executedAt === null || summary === null) {
          throw ReadApiException.malformed(
            '$.executedAt',
            'status=executed 时必须带执行时间与摘要 —— 否则「删了什么」无从回答'
          )
        }
        break
      default:
        throw ReadApiException.malformed('$.status', `未知删除状态：${status}`)
    }

    if (status !== 'pending' && canCancel) {
      throw ReadApiException.malformed(
        '$.canCancel',
        `status=${status} 时不可能还能撤销`
      )
    }
    if (status !== 'executed' && summary !== null) {
      throw ReadApiException.malformed(
        '$.summary',
        `status=${status} 时不应带执行摘要`
      )
    }
  }

  static fromJson(raw: unknown, path = '$'): FamilyDeletionStateDto {
    const json = readObject(raw, path)
    return new FamilyDeletionStateDto(
      readString(json, 'childId', `${path}.childId`),
      readString(json, 'status', `${path}.status`),
      readOptionalDate(json, 'requestedAt', `${path}.requestedAt`),
      readOptionalDate(json, 'scheduledFor', `${path}.scheduledFor`),
      readOptionalDate(json, 'cancelledAt', `${path}.cancelledAt`),
      readOptionalDate(json, 'executedAt', `${path}.executedAt`),
      readOptionalInt(json, 'daysRemaining', `${path}.daysRemaining`),
      readBool(json, 'canCancel', `${path}.canCancel`),
      json.summary === null || json.summary === undefined
        ? null
        : FamilyDeletionSummaryDto.fromJson(json.summary, `${path}.summary`)
    )
  }
}

