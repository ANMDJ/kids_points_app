import { Injectable, NotImplementedException } from '@nestjs/common'

import type { Role } from '../contracts/permission-matrix'
import type { SessionLookupRow } from '../device-session/session.gate'

/**
 * 家长模式 / 家长 PIN 的**持久化端口**（W8-C，2026-10-27 / `02` §7）。
 *
 * ── 它管两行数据 ────────────────────────────────────────────────────────────
 *   · `DeviceSession`（`activeRole` + `expiresAt`）：谁是家长模式、还剩多久；
 *   · `ChildMember`（`pinHash` / `pinSetAt` / `pinFailedCount` / `pinLockedUntil`）：
 *     那把钥匙长什么样、猜错了几次、锁到什么时候。
 *   两者**必须**在同一个事务里改 —— 见 `auth.prisma.repository.ts` 的说明。
 *
 * ── 为什么返回值是 `ModeStateRow`（读回来的现状）而不是 `void` ─────────────────
 *   `enterParentMode` / `exitParentMode` / `recordPinFailure` 都返回**写完之后**的
 *   状态。理由是"回包必须说事实"：客户端拿到的 `parentModeExpiresAt` 应当是库里
 *   那一行的时间戳，而不是 service 里算出来的一个"应该等于它"的值。
 *   两者一旦漂移（例如适配器用了不同的 now / 时钟），用户看到的倒计时就是假的。
 *
 * ── 为什么"计数 + 锁定 + 审计"也在这个端口里（而不是 service 分开调三次）─────
 *   连错计数、锁定时间与审计行是**一件事**：拆成三个调用就会出现
 *   "计数写了、审计没写"或"锁定了、但审计里没有这条"的半成品状态。
 *   端口的一个方法 = 一个事务（与 `onboarding.prisma.repository.ts` 同一条纪律）。
 *   纯算术（该加到几、锁多久）留在 `parent-mode.policy.ts`，
 *   本端口收的是**算好的结果**（`PinFailureOutcome`）—— 于是"算错"可以离线穷举，
 *   "写歪"由真库用例盯住。
 */

/** Nest 注入令牌（用 unique symbol 避免字符串撞名）。 */
export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY')

/** 写审计行需要的最小操作者信息（与会话 actor 同源，绝不来自请求体）。 */
export interface AuthOperator {
  userId: string
  role: Role
}

/** 一次"读当前模式"要定位的三样东西（全部来自服务端：会话 + 成员位）。 */
export interface ReadModeStateInput {
  childId: string
  userId: string
  deviceId: string
}

/**
 * 成员位 + 会话行的**原始**快照。
 *
 * ★ 字段故意宽松（`memberRole` / `session.activeRole` 都是 `string`）：
 *   它们来自数据库枚举，**未经验证**。角色白名单校验由
 *   `session.gate.ts#effectiveRole()` 与 service 各自完成 —— 适配器不做判定。
 */
export interface ModeStateRow {
  memberId: string
  /** 原始 `MemberRole`（guardian | child | viewer）。 */
  memberRole: string
  /**
   * ★ **本文件里唯一的秘密字段**：`ChildMember.pinHash`（自描述 scrypt 串）。
   *
   *   存在理由：校验只能在 service 里做（`verifyPin()` 是异步 scrypt），
   *   而它需要原哈希。**绝不**写日志、**绝不**进审计快照、**绝不**进 HTTP 回包
   *   （对外只有 `pinConfigured: pinHash !== null`）。
   *   `select` 也只取成员位那一行 —— 不借机把整行成员数据带进请求上下文。
   */
  pinHash: string | null
  /** `ChildMember.pinLockedUntil`。 */
  pinLockedUntil: Date | null
  /** `ChildMember.pinFailedCount`（给"还剩 N 次"）。 */
  pinFailedCount: number
  /** 这台设备在这个孩子档案上的会话行（内核要用的列；W14 起含 `kidModeUntil`）。 */
  session: SessionLookupRow
}

export interface EnterParentModeInput {
  childId: string
  userId: string
  deviceId: string
  /** `now + 5 分钟`（由 `parentModeExpiresAt()` 算好）。 */
  expiresAt: Date
  operator: AuthOperator
}

export interface ExitParentModeInput {
  childId: string
  userId: string
  deviceId: string
  operator: AuthOperator
}

export interface RecordPinFailureInput {
  childId: string
  userId: string
  /** 哪台设备上尝试的（只进审计的 `deviceId` 列，与 §7「记 deviceId」同一口径）。 */
  deviceId: string
  /**
   * 用**这一个** `now` 算新的计数与锁定时间。
   *
   * ★ 为什么端口收 `now` 而不是收算好的 `PinFailureOutcome`：
   *   计数必须在**锁内**基于库里那一行现算。若 service 拿读到的快照先算再写，
   *   两次并发错误会各自读到 `failedCount=4` 并都写成 `0 + 锁定` 或都写成 `5`，
   *   于是"连错 5 次才锁"变成"错 4 次就锁"或"错 8 次才锁"。
   *   算术仍然是**同一个**纯函数 `nextPinFailureState()`（适配器与 service 共用），
   *   所以不存在"两套阈值"的风险 —— 差别只在于**用哪个基数**算。
   */
  now: Date
  operator: AuthOperator
}

export interface SetParentPinInput {
  childId: string
  userId: string
  /** 已经 `hashPin()` 过的自描述哈希 —— 端口签名里**没有**能接收明文的参数。 */
  pinHash: string
  /** 改之前有没有 PIN（只进审计的 `before.pinSet`，不是判定依据）。 */
  hadPinBefore: boolean
  operator: AuthOperator
}

/**
 * 用**账号密码**再验证后重置家长 PIN（P1-7，2026-11-04）。
 *
 * ── 它与 `SetParentPinInput` 的区别（别把两者混成一个方法）───────────────────
 *   · `SetParentPinInput`：调用方已经证明「握着**旧 PIN**」（service 里验的），
 *     入口权限是 `manage_parent_pin`（孩子 DENY）；
 *   · `ResetParentPinInput`：调用方**不知道旧 PIN**（否则就走修改而不是重置），
 *     证明的是「握着**账号密码**」。入口权限只能是 `switch_role_mode`
 *     —— 因为要救的那台设备正停在 `child`（W14 孩子模式到期 / 忘记 PIN），
 *     `manage_parent_pin` 对它是 DENY，用那条会在最需要重置时把门焊死。
 *
 *   两道证明谁更弱，由业务层回答：密码是账号级的（跨设备、跨孩子），
 *   PIN 是成员级的 4–6 位数字 —— 所以**密码足够重设 PIN**，反之不成立。
 *
 * ★ 仍然要求成员位是 guardian（适配器里复核）：密码证明"你是这个账号"，
 *   成员位证明"这个账号在这个孩子上是家长"。两者都要，缺一个都 409。
 */
export interface ResetParentPinInput {
  childId: string
  userId: string
  deviceId: string
  /** 新 PIN 的哈希（明文只在 service 的调用栈里）。 */
  pinHash: string
  operator: AuthOperator
}

/** `POST /auth/parent-pin/reset` 的结果：新 PIN 这一件事 ＋ 顺带说清解锁了什么。 */
export interface ParentPinResetState extends ParentPinState {
  /** 被清掉的错误次数（重置前库里的值；给界面说"之前的 N 次错误作废"）。 */
  clearedFailures: number
  /** 重置前是否处于锁定状态（true ⇒ 现在已解锁）。 */
  wasLocked: boolean
}

/**
 * 开一次孩子模式（W14，2026-11-03 / `51-kid-mode-window.md`）。
 *
 * ★ 端口只收**算好的** `kidModeUntil`（与 `EnterParentModeInput.expiresAt` 同一条
 *   纪律）：把「夹到 1–30 分钟」留给 `kid-mode.policy.ts`，于是"上限是多少"
 *   只有一处可改，也能离线穷举。
 */
export interface EnterKidModeInput {
  childId: string
  userId: string
  deviceId: string
  /** `now + N 分钟`（已由 `kidModeExpiresAt()` 夹在 1–30）。 */
  kidModeUntil: Date
  /** 写进审计的原始分钟数（只作证据，不参与判定）。 */
  durationMinutes: number
  operator: AuthOperator
}

/**
 * 用家长 PIN 收回孩子模式（W14）。
 *
 * ★ 刻意**不带** `kidModeUntil`：收回就是把那一列清成 NULL。写一个"过去的时间"
 *   会留下"已经到期但没被收回"的痕迹，与本端口要表达的事实相反。
 */
export interface ExitKidModeInput {
  childId: string
  userId: string
  deviceId: string
  operator: AuthOperator
}

/** `POST /auth/parent-pin` 的结果（只描述 PIN 这一件事，不含会话状态）。 */
export interface ParentPinState {
  pinConfigured: true
  /** ISO 时间串；`pinSetAt` 的落库值。 */
  pinSetAt: string
  /** 本次是"改"（之前有 PIN）还是"设"（之前没有）。 */
  changed: boolean
}

export interface AuthPort {
  /**
   * 读 `(childId, userId)` 的成员位 + `(deviceId, childId)` 的会话行。
   *
   * ★ 查不到就返回 `null`，**不抛异常** —— 「这个人在这个孩子上没有成员位」
   *   是**正常分支**（屏障一已挡过一次，走到这里说明会话与成员位不一致），
   *   由 service 决定回 403 还是 409。抛 404 会把数据不一致伪装成"资源不存在"。
   */
  readModeState(input: ReadModeStateInput): Promise<ModeStateRow | null>

  /** 切到家长模式（写 `activeRole=guardian` + 新 `expiresAt` + 审计，同一事务）。 */
  enterParentMode(input: EnterParentModeInput): Promise<ModeStateRow>

  /** 退出家长模式（写 `activeRole=child` + `expiresAt=now` + 审计，同一事务）。 */
  exitParentMode(input: ExitParentModeInput): Promise<ModeStateRow>

  /** 记一次"格式合法但值不对"的尝试（计数 / 锁定 / 审计，同一事务）。 */
  recordPinFailure(input: RecordPinFailureInput): Promise<ModeStateRow>

  /** 首次设置 / 修改 PIN（写 `pinHash` / `pinSetAt` / 清零计数 / 审计，同一事务）。 */
  setParentPin(input: SetParentPinInput): Promise<ParentPinState>

  /**
   * 读账号的**密码哈希**（P1-7 重置 PIN 的再验证凭据）。
   *
   * ★ 只给 service 做 `verifyPassword()` 用：明文不进端口，哈希不出 service 调用栈
   *   （与 `ModeStateRow.pinHash` 同一纪律）。查不到 / 账号停用 ⇒ `null`，
   *   **不抛** —— "这个账号没有密码"是正常分支（微信登录建出来的账号可能没设过）。
   */
  readAccountPasswordHash(userId: string): Promise<string | null>

  /**
   * 用账号密码再验证后**重设** PIN（P1-7）：
   * 写新 `pinHash` / `pinSetAt` + 清零失败计数与锁定 + 审计，同一事务。
   *
   * ★ 适配器里复核「成员位是 guardian」——密码只证明"你是这个账号"，
   *   不能证明"你在这个孩子上是家长"。
   */
  resetParentPin(input: ResetParentPinInput): Promise<ParentPinResetState>

  /**
   * 开孩子模式（W14）：写 `DeviceSession.kidModeUntil` + 审计，同一事务。
   *
   * ★ **不改** `activeRole` / `expiresAt`：孩子模式是一个"覆盖层"，
   *   收回（`exitKidMode`）之后家长设备应当回到**原来的**窗口（30 天会话或
   *   5 分钟 PIN 窗口）。若这里把 `activeRole` 改成 child，收回时就必须猜
   *   "原来是什么"，而那一刻的信息已经丢了。
   */
  enterKidMode(input: EnterKidModeInput): Promise<ModeStateRow>

  /** 用 PIN 收回孩子模式（`kidModeUntil = NULL` + 审计，同一事务）。 */
  exitKidMode(input: ExitKidModeInput): Promise<ModeStateRow>
}

/**
 * **无库装配**时的实现：**一律 501**。
 *
 * 与 `NotImplementedDeviceSessionRepository` / `NotImplementedOnboardingRepository`
 * 同一口径：没有库的时候，"家长模式切换没有实现"必须**响亮**。
 *
 * ⚠️ 特别说明为什么**不能**返回一个"看起来切成功了"的假状态：
 *   那会把"这台设备现在是家长模式"变成一个**仅存在于回包里**的事实 ——
 *   下一次请求仍由 `DeviceSession` 判定（还是 child），于是用户看到
 *   "切换成功，但什么都点不了"，而排查方向会指向权限矩阵（错的）。
 */
@Injectable()
export class NotImplementedAuthRepository implements AuthPort {
  private fail(method: string): never {
    throw new NotImplementedException({
      code: 'PARENT_MODE_NOT_IMPLEMENTED',
      message:
        `当前进程没有 DATABASE_URL（无库装配）⇒ 家长模式不可用：${method} 没有实现。` +
        '有库装配走的是 PrismaAuthRepository（真写 DeviceSession / ChildMember / AuditLog）。' +
        '这里**拒绝**而不是假装切换成功：回一个"已切到家长模式"的假状态会让下一次请求' +
        '（仍按 DeviceSession 判定）表现为"切了但没权限"，把故障指向错误的层。'
    })
  }

  readModeState(_input: ReadModeStateInput): Promise<ModeStateRow | null> {
    return Promise.resolve(this.fail('readModeState'))
  }

  enterParentMode(_input: EnterParentModeInput): Promise<ModeStateRow> {
    return Promise.resolve(this.fail('enterParentMode'))
  }

  exitParentMode(_input: ExitParentModeInput): Promise<ModeStateRow> {
    return Promise.resolve(this.fail('exitParentMode'))
  }

  recordPinFailure(_input: RecordPinFailureInput): Promise<ModeStateRow> {
    return Promise.resolve(this.fail('recordPinFailure'))
  }

  setParentPin(_input: SetParentPinInput): Promise<ParentPinState> {
    return Promise.resolve(this.fail('setParentPin'))
  }

  readAccountPasswordHash(_userId: string): Promise<string | null> {
    return Promise.resolve(this.fail('readAccountPasswordHash'))
  }

  resetParentPin(_input: ResetParentPinInput): Promise<ParentPinResetState> {
    return Promise.resolve(this.fail('resetParentPin'))
  }

  enterKidMode(_input: EnterKidModeInput): Promise<ModeStateRow> {
    return Promise.resolve(this.fail('enterKidMode'))
  }

  exitKidMode(_input: ExitKidModeInput): Promise<ModeStateRow> {
    return Promise.resolve(this.fail('exitKidMode'))
  }
}
