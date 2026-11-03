import {
  RecordDto,
  readBool,
  readDate,
  readObject,
  readOptionalString,
  readString
} from './read_dto'
import { ReadApiException } from './read_api_errors'
import { WriteApiException } from './write_api_errors'

/**
 * `POST /records/check-in` 与 `POST /records/:id/reverse` 的 201 响应线格式。
 *
 * `executedRecordId` 是**本次真正写下**的那条流水（撤销时是冲正记录）。
 * 它必须与 `record.id` 一致；不一致说明契约漂移，宁可显式失败，
 * 也不能拿一个无法对账的 id 去更新界面。
 */
export class WrittenRecordDto {
  constructor(
    readonly record: RecordDto,
    readonly executedRecordId: string
  ) {}

  static fromJson(raw: unknown, path = '$'): WrittenRecordDto {
    const json = readObject(raw, path)
    let record: RecordDto
    try {
      record = RecordDto.fromJson(json.record, `${path}.record`)
    } catch (error) {
      // 读取层的严格解析失败也必须归一到写异常，页面只处理一种错误类型。
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed(
          `${path}.record`,
          error.detail ?? undefined
        )
      }
      throw error
    }
    const rawExecutedRecordId = json.executedRecordId
    if (typeof rawExecutedRecordId !== 'string') {
      throw WriteApiException.malformed(
        `${path}.executedRecordId`,
        `期望字符串，实际 ${typeof rawExecutedRecordId}`
      )
    }
    const executedRecordId = rawExecutedRecordId
    if (executedRecordId === '') {
      throw WriteApiException.malformed(
        `${path}.executedRecordId`,
        'executedRecordId 不能为空'
      )
    }
    if (executedRecordId !== record.id) {
      throw WriteApiException.malformed(
        `${path}.executedRecordId`,
        `executedRecordId=${executedRecordId} 与 record.id=${record.id} 不一致`
      )
    }
    return new WrittenRecordDto(record, executedRecordId)
  }
}

/**
 * `POST /approvals` 的响应（`02` §4.3 / §9.3：孩子申请 → 202 + `pending`）。
 *
 * 只放界面真正需要的字段 —— 审批的**判定**（谁能批、批完做什么）全在后端，
 * 客户端只负责「把状态如实讲给用户听」：
 *   · `pending` ⇒ 已提交，等家长确认（**还没有**扣分，也**还没有**兑换）；
 *   · `approved` ⇒ 已生效，可以刷新快照；
 *   · `rejected` / `withdrawn` / `invalidated` ⇒ 没成，`autoReason` 说明哪条前提消失。
 *
 * 刻意**不**把 `status` 收成枚举：后端将来加状态时，客户端应当能读出未知值并
 * 说「暂时无法确认」，而不是在解析层就崩掉（那时连提示都给不出）。
 */
export class ApprovalDto {
  constructor(
    readonly id: string,
    readonly action: string,
    /** `pending` / `approved` / `rejected` / `withdrawn` / `invalidated`。 */
    readonly status: string,
    /** 批准那一刻真正落下的流水 id（`pending` / 被拒时为 null）。 */
    readonly executedRecordId: string | null,
    /** `invalidated` 的具体原因（`WISH_DELETED` / `INSUFFICIENT_POINTS` …），否则 null。 */
    readonly autoReason: string | null
  ) {}

  static fromJson(raw: unknown, path = '$'): ApprovalDto {
    const json = readObject(raw, path)
    return new ApprovalDto(
      readString(json, 'id', path),
      readString(json, 'action', path),
      readString(json, 'status', path),
      readOptionalString(json, 'executedRecordId', path),
      readOptionalString(json, 'autoReason', path)
    )
  }
}

/**
 * `PATCH /child` 的 200 响应（W5-E：改孩子昵称）。
 *
 * 两个字段都是**服务端权威值**：
 *   · `name` 是服务端 trim（将来还可能做敏感词替换）后真正落库的值 ——
 *     本地照抄输入就会显示一个库里并不存在的昵称；
 *   · `childId` 必须等于当前会话的孩子：对不上说明这次改名落到了别人头上，
 *     宁可显式失败，也不能写进本地档案（那是两个家庭的串号事故）。
 */
export class ChildProfileDto {
  constructor(
    readonly childId: string,
    readonly name: string
  ) {}

  static fromJson(raw: unknown, path = '$'): ChildProfileDto {
    const json = readObject(raw, path)
    const childId = readString(json, 'childId', path)
    const name = readString(json, 'name', path)
    if (childId === '') {
      throw WriteApiException.malformed(`${path}.childId`, 'childId 不能为空')
    }
    if (name === '') {
      throw WriteApiException.malformed(
        `${path}.name`,
        'name 不能为空（服务端不应保存空白昵称）'
      )
    }
    return new ChildProfileDto(childId, name)
  }
}

/**
 * `POST /trash/:kind/:id/restore` 与 `DELETE /trash/:kind/:id` 的响应（W5-F）。
 *
 * 回包必须指向**刚操作的那一条**：`kind` / `id` 任一不一致 ⇒ malformed。
 * 不能拿一个别的条目去更新界面 —— 那会让家长以为恢复了 A，实际动了 B。
 */
export class TrashTargetDto {
  constructor(
    /** 线值（`point_rule` / `wish` / `habit`） */
    readonly kind: string,
    readonly id: string
  ) {}

  static fromJson(
    raw: unknown,
    path: string,
    expectedKind: string,
    expectedId: string
  ): TrashTargetDto {
    const json = readObject(raw, path)
    const kind = readString(json, 'kind', `${path}.kind`)
    const id = readString(json, 'id', `${path}.id`)
    if (kind !== expectedKind) {
      throw WriteApiException.malformed(
        `${path}.kind`,
        `回包 kind=${kind} 与请求 ${expectedKind} 不一致`
      )
    }
    if (id !== expectedId) {
      throw WriteApiException.malformed(
        `${path}.id`,
        `回包 id=${id} 与请求 ${expectedId} 不一致`
      )
    }
    return new TrashTargetDto(kind, id)
  }
}

// ───────────────────────────── 成员移出（W5-H） ─────────────────────────────

/**
 * `DELETE /members/:id` 的 200 响应。
 *
 * 服务端用 200（不是 204）就是为了让回包与请求**验明正身**：`memberId`
 * 必须等于被移出的那一行，`status` 必须是 `removed`。没有 body 的话，
 * 客户端只能靠「没报错」猜自己删对了人。
 */
export class MemberRemoveDto {
  constructor(
    readonly memberId: string,
    readonly status: string,
    readonly removedAt: number
  ) {}

  static fromJson(
    raw: unknown,
    path: string,
    expectedMemberId: string
  ): MemberRemoveDto {
    const json = readObject(raw, path)
    const memberId = readString(json, 'memberId', `${path}.memberId`)
    const status = readString(json, 'status', `${path}.status`)
    const removedAt = readDate(json, 'removedAt', `${path}.removedAt`)
    if (memberId !== expectedMemberId) {
      throw WriteApiException.malformed(
        `${path}.memberId`,
        `回包 memberId=${memberId} 与请求 ${expectedMemberId} 不一致`
      )
    }
    if (status !== 'removed') {
      // `PATCH` 的冲突码是 `MEMBER_NOT_ACTIVE`；删除若回别的状态，
      // 说明契约漂移 —— 不能把它当成功从界面移除。
      throw WriteApiException.malformed(
        `${path}.status`,
        `回包 status=${status} 不是 expected removed`
      )
    }
    return new MemberRemoveDto(memberId, status, removedAt)
  }
}

/**
 * `POST /invites/:id/revoke` 的回包（W5-I）：`{ id, revoked: true }`。
 *
 * 服务端只在**吊销**这一条路上省掉了整行，因此客户端必须自己守两件事：
 *   · 回包 `id` 必须等于请求的那一条 —— 拿错行的回包更新界面，会让家长
 *     以为吊销了 A，实际动的是 B；
 *   · `revoked` 必须是 `true` —— 200 却说「没吊销」= 后端没做成却也没报错，
 *     把它当成功就是在骗用户。
 *
 * 已吊销的码再吊销仍是同一个 200（幂等，且不写第二条审计），所以客户端
 * **不能**把 200 理解成「这次真的改了一行」。
 */
export class InviteRevokeDto {
  constructor(readonly id: string, readonly revoked: boolean) {}

  static fromJson(
    raw: unknown,
    path: string,
    expectedInviteId: string
  ): InviteRevokeDto {
    const json = readObject(raw, path)
    const id = readString(json, 'id', `${path}.id`)
    const revoked = readBool(json, 'revoked', `${path}.revoked`)
    if (id !== expectedInviteId) {
      throw WriteApiException.malformed(
        `${path}.id`,
        `回包 id=${id} 与请求 ${expectedInviteId} 不一致`
      )
    }
    if (!revoked) {
      throw WriteApiException.malformed(
        `${path}.revoked`,
        '回包 revoked=false，吊销未生效'
      )
    }
    return new InviteRevokeDto(id, revoked)
  }
}

/**
 * `POST /invites/accept` 的 200 响应（P0-3，2026-11-03）。
 *
 * 与 `auth_dto.ts` 的 `ChildSessionResultDto` 同构（服务端两条路由的回包形状
 * 本来就一样：加入家庭 ⇒ 同时签发一条 `DeviceSession`），但这里**不复用**那个类：
 * 它抛的是 `AuthApiException`，而本层（写端点）的调用方只处理
 * `WriteApiException` —— 一次严格解析失败会变成"页面不认识的异常"。
 *
 * 三个字段都要当真：
 *   · `childId` 必须非空 —— 空的回包等于「加入了但没有家」，不能静默采用；
 *   · `role` 只认 `child` / `guardian`（`viewer` 从来不是邀请码的目标角色）；
 *   · `sessionExpiresAt` 是**服务端**签发的到期时刻（epoch ms），本地不能改成"现在 + 30 天"。
 */
export class InviteAcceptDto {
  constructor(
    readonly childId: string,
    readonly role: 'child' | 'guardian',
    readonly sessionExpiresAt: number
  ) {}

  static fromJson(raw: unknown, path = '$'): InviteAcceptDto {
    const json = readObject(raw, path)
    const childId = readString(json, 'childId', `${path}.childId`)
    if (childId === '') {
      throw WriteApiException.malformed(`${path}.childId`, 'childId 不能为空')
    }
    const rawRole = json.role
    if (rawRole !== 'child' && rawRole !== 'guardian') {
      throw WriteApiException.malformed(
        `${path}.role`,
        `期望 child / guardian，实际 ${String(rawRole)}`
      )
    }
    return new InviteAcceptDto(
      childId,
      rawRole,
      readDate(json, 'sessionExpiresAt', `${path}.sessionExpiresAt`)
    )
  }
}

/**
 * `PATCH /notifications/:id/read` 的 200 响应（W5-L）。
 *
 * 只有两个字段，两个都要**当真**：
 *   · `id` 必须等于请求的那一条 —— 把「已读」写到别的消息上是会让人真错过
 *     一条通知的错，宁可显式失败；
 *   · `readAt` 是**服务端**记下的已读时间（重复标记时是第一次的时间），
 *     本地照抄「现在」会让两次调用给出两个版本。
 */
export class NotificationReadDto {
  constructor(
    readonly id: string,
    readonly readAt: number
  ) {}

  static fromJson(
    raw: unknown,
    path = '$',
    expectedId?: string
  ): NotificationReadDto {
    const json = readObject(raw, path)
    const id = readString(json, 'id', `${path}.id`)
    if (expectedId !== undefined && id !== expectedId) {
      throw ReadApiException.malformed(
        `${path}.id`,
        `回包 id=${id} 与请求 ${expectedId} 不一致`
      )
    }
    return new NotificationReadDto(id, readDate(json, 'readAt', `${path}.readAt`))
  }
}
