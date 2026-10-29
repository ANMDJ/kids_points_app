import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable
} from '@nestjs/common'

import { hashPin, verifyPin } from '../common/pin-hash'
import { isPinFormatValid } from '../common/pin-format'
import type { Role } from '../contracts/permission-matrix'
import { effectiveRole } from '../device-session/session.gate'
import {
  AUTH_REPOSITORY,
  type AuthOperator,
  type AuthPort,
  type ModeStateRow,
  type ParentPinState
} from './auth.repository'
import type { EnterParentModeDto } from './dto/enter-parent-mode.dto'
import type { SetParentPinDto } from './dto/set-parent-pin.dto'
import {
  PIN_LOCK_MS,
  PIN_MAX_FAILURES,
  isPinLocked,
  lockRemainingSeconds,
  parentModeExpiresAt,
  parentModeSourceOf,
  remainingAttempts,
  remainingSeconds,
  type ParentModeSource
} from './parent-mode.policy'

/**
 * `GET/POST/DELETE /auth/parent-mode` 的回包 —— **家长模式的现状**。
 *
 * ★ 每个字段都对应客户端的一个具体像素，没有"顺手多给"：
 *   · `activeRole`       → 顶栏是否显示「家长模式」角标；
 *   · `parentMode`       → 家长专属入口是否可点；
 *   · `parentModeExpiresAt` / `remainingSeconds` → 「还剩 4:57」的倒计时
 *       （★ 倒计时**必须**以服务端给的绝对时刻为基准，客户端不能自己从 5:00 数 —— 
 *        手机时间不准、后台挂起都会让它说谎）；
 *   · `pinConfigured`    → 显示「输入 PIN」还是「先设置 PIN」；
 *   · `remainingAttempts` → 「还剩 N 次」；
 *   · `lockedUntil`      → 锁定态文案。
 * ── 为什么有 `modeSource` ────────────────────────────────────────────────────
 *   `parentMode:true` 有两种截然不同的来路，界面的说法也不同：
 *     · `pin`     —— 刚用 PIN 换来的 5 分钟（"还剩 4:57，到期自动收回"）；
 *     · `session` —— 这台设备以家长身份登录（邀请码加入，会话 30 天）。
 *   只给 `remainingSeconds` 而不说来源，客户端会把 2 592 000 秒显示成
 *   "43200:00 后自动收回"，或者干脆把它当成坏数据（W8-C 的 DTO 曾硬校验 ≤300）。
 */
export interface ParentModeView {
  activeRole: Role | 'viewer'
  parentMode: boolean
  /** `pin` / `session`；不在家长模式时为 `null`。 */
  modeSource: ParentModeSource | null
  parentModeExpiresAt: string | null
  remainingSeconds: number
  pinConfigured: boolean
  remainingAttempts: number
  lockedUntil: string | null
}

/** `POST /auth/parent-pin` 的回包：PIN 这一件事 + 重置后的剩余次数。 */
export interface ParentPinView extends ParentPinState {
  remainingAttempts: number
}

/**
 * 家长模式切换 / 家长 PIN 的业务层（W8-C，2026-10-27 / `02` §7、§9.18）。
 *
 * ── 三条路由各自回答什么 ────────────────────────────────────────────────────
 *   `GET    /auth/parent-mode`  我现在是不是家长模式、还剩多少秒
 *   `POST   /auth/parent-mode`  用 PIN 换 5 分钟家长模式（`switch_role_mode`）
 *   `DELETE /auth/parent-mode`  主动退出（**不需要** PIN）
 *   `POST   /auth/parent-pin`   首次设置 / 修改家长 PIN（`manage_parent_pin`）
 *
 * ── 这一层负责的四件事 ──────────────────────────────────────────────────────
 *   ① 顺序：先判**能不能试**（成员位 / PIN 已设 / 是否锁定），再判**这次对不对** ——
 *      顺序反了会出现"锁定期内还去跑 scrypt"（白烧 CPU，也能被用来打服务）；
 *   ② 明文 PIN 的生命周期**止于本文件**：`verifyPin()` / `hashPin()` 都在这里调用，
 *      端口签名里只有 `pinHash`，没有任何能接收明文的参数；
 *   ③ 把纯算术的结果翻成 HTTP 语义（403 值错 / 429 锁定 / 400 格式错）；
 *   ④ 回包一律用**写完之后的库状态**（`ModeStateRow`），不在内存里拼"应该是什么"。
 *
 * ── ★ 一处必须说清的"矩阵 ALLOW ≠ 一定能提权"────────────────────────────────
 *   矩阵里 `switch_role_mode` 对 `guardian` 与 `child` **都是 ALLOW**（02 §7：
 *   PIN 就是那道门，谁来按都可以）。但本服务另外要求**会话对应的成员位是家长、
 *   且该成员位上有 PIN** —— 因为 `02` §7 把 PIN 落在 `ChildMember.pinHash` 上，
 *   即"PIN 属于某个成员"。
 *   真实的家庭共用手机场景是：**家长的微信登录着**，`activeRole` 默认 `child`
 *   （手机在孩子手里）；孩子点「家长模式」，把手机递给家长，家长输入 PIN ⇒
 *   这台设备 5 分钟内是家长模式。孩子自己的设备（会话 `userId` 是孩子）
 *   提不了权 —— 那正是应该的。
 *   于是孩子那条会话会拿到 403 `PARENT_MODE_REQUIRES_GUARDIAN`（**不是**矩阵漏了
 *   一行，而是"这个成员位没有钥匙"这一业务事实）。
 */
@Injectable()
export class AuthService {
  constructor(@Inject(AUTH_REPOSITORY) private readonly repository: AuthPort) {}

  async readMode(childId: string, deviceId: string, operator: AuthOperator): Promise<ParentModeView> {
    const row = await this.load(childId, deviceId, operator.userId)
    return viewOf(row, new Date())
  }

  async enterParentMode(
    childId: string,
    deviceId: string,
    dto: EnterParentModeDto,
    operator: AuthOperator
  ): Promise<ParentModeView> {
    const now = new Date()
    const row = await this.load(childId, deviceId, operator.userId)

    // ① 成员位必须是家长（PIN 属于成员，见类注释的"矩阵 ALLOW ≠ 一定能提权"）。
    this.assertGuardianMember(row, 'PARENT_MODE_REQUIRES_GUARDIAN', '只有家长能进入家长模式。')
    // ② 没有 PIN ⇒ 409 而不是 401：身份是好的，"没人设过钥匙"是**状态**问题。
    if (row.pinHash === null) {
      throw new ConflictException({
        code: 'PARENT_PIN_NOT_SET',
        message:
          '这个账号还没有设置家长 PIN —— 请在家长登录的那台设备上设置（或在家长模式下设置）。'
      })
    }
    // ③ 锁定期内**不做**任何校验（连 scrypt 都不跑）：这是防暴力的真正一道门。
    assertNotLocked(row, now)
    // ④ 格式错 ⇒ 400 且**不计次**（手滑不是猜测，见 parent-mode.policy.ts 口径 ②）。
    if (!isPinFormatValid(dto.pin)) {
      throw new BadRequestException({
        code: 'PARENT_PIN_FORMAT_INVALID',
        message: '家长 PIN 是 4–6 位数字（这次没有计入错误次数）。'
      })
    }

    // ⑤ 唯一一次"对不对"的判定。明文到此为止，下面的调用链只拿得到哈希。
    if (!(await verifyPin(dto.pin, row.pinHash))) {
      const failed = await this.repository.recordPinFailure({
        childId,
        userId: operator.userId,
        deviceId,
        now,
        operator
      })
      throw pinRejected(failed, now)
    }

    // ⑥ 写库：`activeRole=guardian` + `expiresAt=now+5min` + 清零计数 + 审计，同一事务。
    const updated = await this.repository.enterParentMode({
      childId,
      userId: operator.userId,
      deviceId,
      expiresAt: parentModeExpiresAt(now),
      operator
    })
    return viewOf(updated, now)
  }

  async exitParentMode(
    childId: string,
    deviceId: string,
    operator: AuthOperator
  ): Promise<ParentModeView> {
    const now = new Date()
    await this.load(childId, deviceId, operator.userId)
    // ★ 退出**不验 PIN、也不要求当前是家长**：降级永远允许（越严越好）。
    //   也不要求"当前真的在家长模式"—— 已经是 child 时再退一次是幂等的 200。
    const updated = await this.repository.exitParentMode({
      childId,
      userId: operator.userId,
      deviceId,
      operator
    })
    return viewOf(updated, now)
  }

  /**
   * 首次设置 / 修改家长 PIN。
   *
   * ── 四条顺序 ────────────────────────────────────────────────────────────────
   *   ① 成员位必须是家长（矩阵 `manage_parent_pin` 对 child 是 DENY，这里是纵深）；
   *   ② 新 PIN 格式合法（4–6 位数字）；
   *   ③ **已有 PIN ⇒ 必须带 `currentPin` 且验证通过**（见 `SetParentPinDto` 的理由）；
   *   ④ 写库：`pinHash` / `pinSetAt` + 清零失败计数与锁定 + 审计，同一事务。
   *
   * ── ★ 已知限制（不粉饰）─────────────────────────────────────────────────────
   *   `02` §7 **没有**定义"忘了 PIN 怎么办"。本端点因此也没有找回通道：
   *   · 记得旧 PIN ⇒ 直接改；
   *   · 忘了旧 PIN ⇒ 只能等 15 分钟锁定结束（若是被锁）后由**另一位家长**用
   *     自己的 PIN 进入家长模式继续管理家庭 —— 但**不能**替对方重设（PIN 是
   *     成员级的，见 `auth.repository.ts` 的 `ModeStateRow.pinHash`）。
   *   这是本轮**故意留着**的缺口：任何"无凭据重置"的通道都会把 PIN 变成装饰品
   *   （重置入口本身就是绕过门）。要补的话应当走"监护人身份再验证"（L2 的正式
   *   登录 / 手机号验证），那是登录链路的活，不属于这里。
   */
  async setParentPin(
    childId: string,
    deviceId: string,
    dto: SetParentPinDto,
    operator: AuthOperator
  ): Promise<ParentPinView> {
    const now = new Date()
    const row = await this.load(childId, deviceId, operator.userId)
    this.assertGuardianMember(row, 'PARENT_PIN_REQUIRES_GUARDIAN', '只有家长能设置家长 PIN。')

    if (!isPinFormatValid(dto.pin)) {
      throw new BadRequestException({
        code: 'PARENT_PIN_FORMAT_INVALID',
        message: '家长 PIN 必须是 4–6 位数字。'
      })
    }

    if (row.pinHash !== null) {
      // 已有 PIN：改它必须证明你握着旧的。缺 `currentPin` 是 400（请求不完整），
      // 不是 403 —— 客户端该提示"请输入当前 PIN"，而不是"你没权限"。
      if (dto.currentPin === undefined) {
        throw new BadRequestException({
          code: 'PARENT_PIN_CURRENT_REQUIRED',
          message: '修改家长 PIN 需要先输入当前 PIN。'
        })
      }
      assertNotLocked(row, now)
      if (!isPinFormatValid(dto.currentPin)) {
        // 当前 PIN 格式错 ⇒ 同样是手滑，不计次（与 enterParentMode ④ 同一条口径）。
        throw new BadRequestException({
          code: 'PARENT_PIN_FORMAT_INVALID',
          message: '当前家长 PIN 是 4–6 位数字（这次没有计入错误次数）。'
        })
      }
      if (!(await verifyPin(dto.currentPin, row.pinHash))) {
        const failed = await this.repository.recordPinFailure({
          childId,
          userId: operator.userId,
          deviceId,
          now,
          operator
        })
        throw pinRejected(failed, now)
      }
    }

    const state = await this.repository.setParentPin({
      childId,
      userId: operator.userId,
      pinHash: await hashPin(dto.pin),
      hadPinBefore: row.pinHash !== null,
      operator
    })
    return { ...state, remainingAttempts: remainingAttempts(0) }
  }

  /**
   * 读成员位 + 会话行；读不到 ⇒ 409。
   *
   * ★ 为什么 409 而不是 403：屏障一（`MembershipGuard`）**已经**在更前面把
   *   "非成员"判成 403 了。走到这里还能读到空，只可能是**会话与成员位不一致**
   *   （刚被移出而会话还没收回 / 装配漏了组件）——那是数据状态冲突，不是权限判定。
   */
  private async load(childId: string, deviceId: string, userId: string): Promise<ModeStateRow> {
    const row = await this.repository.readModeState({ childId, userId, deviceId })
    if (row === null) {
      throw new ConflictException({
        code: 'PARENT_MODE_MEMBER_NOT_ACTIVE',
        message:
          '这台设备的会话与该孩子的成员位对不上（可能刚被移出家庭）。请重新登录后再试。'
      })
    }
    return row
  }

  private assertGuardianMember(row: ModeStateRow, code: string, message: string): void {
    if (row.memberRole !== 'guardian') {
      throw new ForbiddenException({
        code,
        message:
          message +
          '★ 这不是"矩阵漏了一行"：`02` §7 把 PIN 落在 `ChildMember.pinHash` 上 —— ' +
          'PIN 属于某个成员，孩子的成员位上没有钥匙。请在**家长登录的那台设备**上操作。'
      })
    }
  }
}

/**
 * 锁定中 ⇒ 429 + `Retry-After` 语义（`retryAfterSeconds`）。
 *
 * ★ 为什么是 429 而不是 403：403 会被客户端读成"你没有这个权限"（该去找家长），
 *   429 才能被读成"等一会儿再来" —— 而这两件事的界面文案完全不同。
 *   与 `enterParentMode` ⑤ 里"刚触发锁定"的那一次共用**同一个** code，
 *   客户端只需一个分支。
 */
function assertNotLocked(row: ModeStateRow, now: Date): void {
  const lockedUntil = row.pinLockedUntil
  if (lockedUntil === null || !isPinLocked(lockedUntil, now)) return
  throw new HttpException(
    {
      code: 'PARENT_PIN_LOCKED',
      message: `家长 PIN 连续输错 ${PIN_MAX_FAILURES} 次，已锁定 ${PIN_LOCK_MS / 60_000} 分钟。`,
      lockedUntil: lockedUntil.toISOString(),
      retryAfterSeconds: lockRemainingSeconds(lockedUntil, now),
      remainingAttempts: 0
    },
    HttpStatus.TOO_MANY_REQUESTS
  )
}

/** "值不对" ⇒ 403（还有机会）或 429（刚好这次触发了锁定）。 */
function pinRejected(row: ModeStateRow, now: Date): HttpException {
  const lockedUntil = row.pinLockedUntil
  if (lockedUntil !== null && isPinLocked(lockedUntil, now)) {
    return new HttpException(
      {
        code: 'PARENT_PIN_LOCKED',
        message: `家长 PIN 连续输错 ${PIN_MAX_FAILURES} 次，已锁定 ${PIN_LOCK_MS / 60_000} 分钟。`,
        lockedUntil: lockedUntil.toISOString(),
        retryAfterSeconds: lockRemainingSeconds(lockedUntil, now),
        remainingAttempts: 0
      },
      HttpStatus.TOO_MANY_REQUESTS
    )
  }
  const attempts = remainingAttempts(row.pinFailedCount)
  return new ForbiddenException({
    code: 'PARENT_PIN_INVALID',
    message: `家长 PIN 不对（还剩 ${attempts} 次尝试机会）。`,
    remainingAttempts: attempts,
    lockedUntil: null
  })
}

/**
 * 把库里的现状翻成回包。
 *
 * ★ 角色与"是否还在有效期内"**一律复用** `session.gate.ts#effectiveRole()`：
 *   TTL 的边界（`expiresAt === now` 即过期）只允许有一处定义。若这里自己写
 *   `expiresAt > now`，就会出现"设备会话刚过期、家长模式却还显示 1 秒"的错位。
 *   它同时会把形状坏掉的行抛成 `SessionRowShapeError`（守卫翻 500）—— 数据病不伪装成权限病。
 */
function viewOf(row: ModeStateRow, now: Date): ParentModeView {
  const activeRole = effectiveRole(row.session, now)
  const parentMode = activeRole === 'guardian'
  const lockedUntil = row.pinLockedUntil
  const locked = lockedUntil !== null && isPinLocked(lockedUntil, now)

  return {
    activeRole,
    parentMode,
    modeSource: parentMode ? parentModeSourceOf(new Date(row.session.expiresAt), now) : null,
    parentModeExpiresAt: parentMode ? new Date(row.session.expiresAt).toISOString() : null,
    remainingSeconds: parentMode ? remainingSeconds(new Date(row.session.expiresAt), now) : 0,
    pinConfigured: row.pinHash !== null,
    remainingAttempts: locked ? 0 : remainingAttempts(row.pinFailedCount),
    lockedUntil: locked && lockedUntil !== null ? lockedUntil.toISOString() : null
  }
}

