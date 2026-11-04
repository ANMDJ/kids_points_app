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
import { burnPasswordHashCost, verifyPassword } from '../common/password-hash'
import { isPinFormatValid } from '../common/pin-format'
import type { Role } from '../contracts/permission-matrix'
import { effectiveRole } from '../device-session/session.gate'
import { LoginRateLimiter } from '../identity/login-rate-limiter'
import {
  AUTH_REPOSITORY,
  type AuthOperator,
  type AuthPort,
  type ModeStateRow,
  type ParentPinResetState,
  type ParentPinState
} from './auth.repository'
import type { EnterParentModeDto } from './dto/enter-parent-mode.dto'
import type { EnterKidModeDto } from './dto/enter-kid-mode.dto'
import type { ExitKidModeDto } from './dto/exit-kid-mode.dto'
import type { ResetParentPinDto } from './dto/reset-parent-pin.dto'
import type { SetParentPinDto } from './dto/set-parent-pin.dto'
import type { VerifyParentPinDto } from './dto/verify-parent-pin.dto'
import {
  clampKidModeMinutes,
  kidModeExpiresAt,
  kidModeRemainingSeconds,
  kidModeStateOf
} from './kid-mode.policy'
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

  /**
   * W14（2026-11-03）：孩子模式**正在窗口内**（`kidModeUntil > now`）。
   *
   * ★ 为 true 时 `activeRole` 必然是 `child`、`parentMode` 必然是 false ——
   *   孩子模式的判定优先级高于 `activeRole/expiresAt`（`session.gate.ts`）。
   */
  kidMode: boolean

  /**
   * W14：孩子模式**已经到点、但还没有被家长 PIN 收回**（`kidModeUntil <= now`）。
   *
   * ★ 这是 A 方案的核心状态：到期**不**自动回家长模式，设备停在 `child`，
   *   直到家长输入 PIN。界面据此显示「时间到了，请输入家长 PIN」而不是
   *   「家长模式」—— 后者会让家长以为管控失败。
   */
  kidModeExpired: boolean

  /** 孩子模式的到期绝对时刻（`kidMode` / `kidModeExpired` 为 true 时非 null）。 */
  kidModeUntil: string | null

  /** 孩子模式还剩多少秒（**向上取整**；未开或已到期都是 0）。 */
  kidModeRemainingSeconds: number
}

/** `POST /auth/parent-pin` 的回包：PIN 这一件事 + 重置后的剩余次数。 */
export interface ParentPinView extends ParentPinState {
  remainingAttempts: number
}

/**
 * `POST /auth/parent-pin/reset` 的回包（P1-7，2026-11-04）。
 *
 * ★ 仍然**没有** `activeRole` / `parentModeExpiresAt`：重置只换钥匙，
 *   不替用户提权。设备还在不在家长模式，由 `GET /auth/parent-mode` 回答 ——
 *   这里多给一个角色字段，界面就会在"重置成功"之后错误地显示"已进入家长模式"。
 */
export interface ParentPinResetView extends ParentPinResetState {
  remainingAttempts: number
}

/**
 * 重置 PIN 的尝试上限（每个账号每分钟）。
 *
 * 与 `LOGIN_RATE_LIMIT_PER_DEVICE`（10/分钟）分开定一个更小的值：
 * 这一步只该被"忘记 PIN 的家长"调用一次两次，正常人不需要一分钟试 5 次；
 * 而拿到手机的人在这里试的是**账号密码**（8–64 位），5 次/分钟已是减速带。
 */
export const PIN_RESET_ATTEMPTS_PER_MINUTE = 5

/**
 * `POST /auth/parent-pin/verify` 的回包（2026-11-04，本机 PIN 锁）。
 *
 * ★ 这里**没有** `activeRole` / `parentModeExpiresAt` —— 这个端点不改会话行，
 *   回包里放角色字段会让人误以为「验过 PIN 就提权了」。要提权请走
 *   `POST /auth/parent-mode`（那是另一件事，也是另一个按钮）。
 */
export interface ParentPinVerifyView {
  /** 校验通过；失败走 403 / 400 / 409 / 429，绝不回 200 + false。 */
  valid: true
  /** 还能错几次（成功不清零，见 `verifyParentPin()` 的口径）。 */
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
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthPort,
    /**
     * P1-7：重置 PIN 要验**账号密码**，所以必须有减速带。
     * 复用登录那一份滑动窗口实现（同一个类、同一套判据），不另造一套阈值表 ——
     * "两套限流各自漂移"比"没有限流"更难查。
     * 默认值只为直接 `new AuthService(fake)` 的用例方便；Nest 装配时由模块注入。
     */
    private readonly limiter: LoginRateLimiter = new LoginRateLimiter()
  ) {}


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

    // ★ W14（2026-11-03）：孩子模式期间**不走**这条路。
    //
    //   家长真正想做的动作是"结束这次交接"，那是 `DELETE /auth/kid-mode`。
    //   若这里顺手清掉 `kidModeUntil` 并把 expiresAt 压成 now+5 分钟，
    //   一个本来有 30 天家长会话的设备会凭空缩水到 5 分钟；
    //   若什么都不做，家长输对了 PIN 却仍然停在 child（更糟：像是 PIN 错了）。
    //   两种都不行 ⇒ 409 并指明该用哪个入口。
    const kidState = kidModeStateOf(toDateOrNull(row.session.kidModeUntil), now)
    if (kidState !== 'off') {
      throw new ConflictException({
        code: 'KID_MODE_ACTIVE',
        message:
          kidState === 'active'
            ? '这台设备正处在孩子模式里。要提前拿回家长权限，请用「结束孩子模式」并输入家长 PIN。'
            : '孩子模式的时间已经到了，但还没有被收回。请输入家长 PIN 结束孩子模式。'
      })
    }
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

  /**
   * 只校验家长 PIN，**不改变**这台设备的角色 / TTL（2026-11-04）。
   *
   * ── 它为什么必须存在（而不是让 App 用 `POST /auth/parent-mode` 当解锁）──────
   *   App 的「PIN 锁」在本机入口上多了一道门：冷启动 / 从后台回来要输 PIN。
   *   如果解锁直接走 `enterParentMode`，一台**以家长身份登录**的设备
   *   （邀请码加入，会话 30 天）会被压成 5 分钟 —— 家长解锁几次之后
   *   忽然就不再是家长模式了。锁屏是「谁拿着手机」，不是「提权」，
   *   两件事必须能分开调用。
   *
   * ── 五条口径（与 `enterParentMode` 逐条对齐，只有最后一条不同）─────────────
   *   ① 没有 PIN ⇒ 409 `PARENT_PIN_NOT_SET`（身份没问题，「没钥匙」是状态）；
   *   ② 锁定期内 ⇒ 429 且**不跑 scrypt**（防暴力真正的一道门）；
   *   ③ 格式错 ⇒ 400 且**不计次**（手滑不是猜测）；
   *   ④ 值不对 ⇒ 计一次（`recordPinFailure`，成员级，换设备也绕不过）+ 403/429；
   *   ⑤ 值对了 ⇒ **什么也不写**：不改 `activeRole` / `expiresAt`，也**不清零**
   *      `pinFailedCount`。清零点仍然只有 `enterParentMode` / `setParentPin`——
   *      这个端点必须能对「孩子模式进行中」的设备使用（锁屏不该被 409 卡住），
   *      而任何一次写会话行都会与 `kidModeUntil` 的优先级打架。
   *
   * ── 为什么**不**要求成员位是 guardian ──────────────────────────────────────
   *   PIN 落在成员位的 `pinHash` 上。若一位家长被降级成 child（成员角色变更），
   *   他仍然应该能解开自己手机上的锁 —— 这个端点不授予任何权限，只是回答
   *   「PIN 对不对」。要求 guardian 会让那台设备变成**永久打不开**（又一个 D7）。
   */
  async verifyParentPin(
    childId: string,
    deviceId: string,
    dto: VerifyParentPinDto,
    operator: AuthOperator
  ): Promise<ParentPinVerifyView> {
    const now = new Date()
    const row = await this.load(childId, deviceId, operator.userId)

    if (row.pinHash === null) {
      throw new ConflictException({
        code: 'PARENT_PIN_NOT_SET',
        message: '这个账号还没有设置家长 PIN —— 请先在家长登录的设备上设置。'
      })
    }
    assertNotLocked(row, now)
    if (!isPinFormatValid(dto.pin)) {
      throw new BadRequestException({
        code: 'PARENT_PIN_FORMAT_INVALID',
        message: '家长 PIN 是 4–6 位数字（这次没有计入错误次数）。'
      })
    }
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
    return { valid: true, remainingAttempts: remainingAttempts(row.pinFailedCount) }
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
   * 开孩子模式（W14，2026-11-03 / `51-kid-mode-window.md`）。
   *
   * ── 五条顺序（每条都有 HTTP 用例）─────────────────────────────────────────
   *   ① 成员位必须是家长（PIN 属于成员）；
   *   ② 当前必须**已经在家长模式** —— 否则"给孩子用 20 分钟"就是一次
   *      越权操作（孩子自己开的窗口）；
   *   ③ 必须设过 PIN —— 不然到期后没有任何人能收回（见 repository 注释）；
   *   ④ 不能已经开着 —— 409 而不是静默续期；
   *   ⑤ 分钟数先 `clampKidModeMinutes()` 再落库（DTO 已挡 31 分钟，
   *      这一步守住非 HTTP 调用方）。
   *
   * ★ 时长**由家长输入**（1–30，默认 15），不是固定 30：产品意图是
   *   「先让孩子把愿望写在纸上，再给一段有限时间填」，默认即上限会鼓励
   *   "反正也是 30 分钟"。
   */
  async enterKidMode(
    childId: string,
    deviceId: string,
    dto: EnterKidModeDto,
    operator: AuthOperator
  ): Promise<ParentModeView> {
    const now = new Date()
    const row = await this.load(childId, deviceId, operator.userId)

    this.assertGuardianMember(row, 'KID_MODE_REQUIRES_GUARDIAN', '只有家长才能开启孩子模式。')

    const kidState = kidModeStateOf(toDateOrNull(row.session.kidModeUntil), now)
    if (kidState !== 'off') {
      throw new ConflictException({
        code: 'KID_MODE_ALREADY_ACTIVE',
        message:
          kidState === 'active'
            ? '这台设备已经在孩子模式里。请先用家长 PIN 结束当前这一次，再重新设置时长。'
            : '上一次孩子模式还没被收回。请先输入家长 PIN 结束它，再重新设置时长。'
      })
    }

    if (row.pinHash === null) {
      throw new ConflictException({
        code: 'KID_MODE_REQUIRES_PIN',
        message:
          '这个账号还没有家长 PIN：孩子模式到点后必须用 PIN 收回，' +
          '没有 PIN 就等于把手机永久锁在孩子模式里。请先设置家长 PIN。'
      })
    }

    // ② 当前角色必须是 guardian（由服务端会话 + TTL 现算，不看客户端）。
    if (effectiveRole(row.session, now) !== 'guardian') {
      throw new ForbiddenException({
        code: 'KID_MODE_REQUIRES_PARENT_MODE',
        message:
          '请先输入家长 PIN 进入家长模式，再开启孩子模式。' +
          '（孩子模式下不能给自己延长时间 —— 否则这道门就等于不存在。）'
      })
    }

    const minutes = clampKidModeMinutes(dto.durationMinutes)
    const updated = await this.repository.enterKidMode({
      childId,
      userId: operator.userId,
      deviceId,
      kidModeUntil: kidModeExpiresAt(now, minutes),
      durationMinutes: minutes,
      operator
    })
    return viewOf(updated, now)
  }

  /**
   * 用家长 PIN 收回孩子模式（W14）。
   *
   * ── 为什么"收回"必须验 PIN，而"退出家长模式"不用 ──────────────────────────
   *   `DELETE /auth/parent-mode` 是**降级**（越严越好，孩子自己点也无害）；
   *   本方法是**把孩子手里的设备交回家长** —— 它是提权方向。没有 PIN，
   *   孩子自己点一下就能回到家长模式（还能顺手批掉自己的心愿）。
   *
   * ── 失败语义与进入家长模式**逐字一致** ────────────────────────────────────
   *   格式错 ⇒ 400（不计次）；值不对 ⇒ 403（剩 N 次）；锁定 ⇒ 429（等多久）。
   *   复用 `assertNotLocked()` / `pinRejected()`，客户端一个分支就能接住。
   *
   * ★ 幂等：已经收回（或从来没开）时再调一次也是 200 —— 降级永远允许。
   *   但 **PIN 仍然要验**：否则"收回"会变成一个不需要凭据的探测端点。
   */
  async exitKidMode(
    childId: string,
    deviceId: string,
    dto: ExitKidModeDto,
    operator: AuthOperator
  ): Promise<ParentModeView> {
    const now = new Date()
    const row = await this.load(childId, deviceId, operator.userId)

    this.assertGuardianMember(row, 'KID_MODE_REQUIRES_GUARDIAN', '只有家长才能收回孩子模式。')

    if (row.pinHash === null) {
      // 理论上开孩子模式时就要求过 PIN（`KID_MODE_REQUIRES_PIN`）；
      // 走到这里说明 PIN 被另一台设备清掉了，或数据被改过。
      throw new ConflictException({
        code: 'KID_MODE_REQUIRES_PIN',
        message: '这个账号没有家长 PIN，无法收回孩子模式。请用另一位家长设备处理。'
      })
    }

    assertNotLocked(row, now)

    if (!isPinFormatValid(dto.pin)) {
      throw new BadRequestException({
        code: 'PARENT_PIN_FORMAT_INVALID',
        message: '家长 PIN 是 4–6 位数字（这次没有计入错误次数）。'
      })
    }

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

    const updated = await this.repository.exitKidMode({
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
   * 用**账号密码**再验证后重设家长 PIN（P1-7，2026-11-04）。
   *
   * ── 它补的是哪个洞（W14 之后从"可选"变成"硬前置"）───────────────────────────
   *   孩子模式（`51`）到期后 **不**自动回家长模式：设备停在 `child`，唯一出口是
   *   家长 PIN。所以「设过 PIN 但忘了」= 这台设备回不去家长权限，
   *   而 `POST /auth/parent-pin`（改 PIN）又要求先输旧 PIN —— 死锁。
   *   本方法是那条**唯一**被允许的旁路，且它要求比 PIN 更强的证明（账号密码）。
   *
   * ── 五条顺序（每条都有 HTTP 用例）────────────────────────────────────────────
   *   ① 新 PIN 格式错 ⇒ 400（手滑，不消耗限流额度、不算密码尝试）；
   *   ② 每账号每分钟 `PIN_RESET_ATTEMPTS_PER_MINUTE` 次 ⇒ 超了 429
   *      （★ 必须按 `operator.userId`：那是会话里的事实，不是客户端头）；
   *   ③ 成员位 / 会话对不上 ⇒ 走 `load()` 的 403 / 409（与其它几条同一语义）；
   *   ④ 账号没有密码 ⇒ 403 `ACCOUNT_PASSWORD_NOT_SET`（微信登录建的账号可能没设过）；
   *      密码不对 ⇒ 403 `CURRENT_PASSWORD_INVALID`（与「我的 → 登录账号」改密同一个码，
   *      双端错误映射不用再加一条）；
   *   ⑤ 写库：新 `pinHash` + 清零失败计数与锁定 + 审计，同一事务。
   *
   * ── 为什么**不**顺手把会话改回 `guardian` ────────────────────────────────────
   *   改会话就是提权，而这一步的证明只到"你是这个账号"。用户拿着密码应当
   *   自己走 `POST /auth/parent-mode`（现在新 PIN 已经可用），或重新登录 ——
   *   两条路都会留下各自的审计行。这里顺手改角色会让「重置 PIN」变成
   *   「一台被孩子拿着的手机，只要家长打错一次密码就换人」的相邻风险。
   *
   * ── 为什么**不**清空 PIN（而是要求给一个新的）───────────────────────────────
   *   清空之后设备处于"没有钥匙"的状态，而 W14 之后没 PIN 的设备是另一种锁死。
   *   重置的语义是"换一把能用的钥匙"，不是"拆掉锁"。
   */
  async resetParentPin(
    childId: string,
    deviceId: string,
    dto: ResetParentPinDto,
    operator: AuthOperator
  ): Promise<ParentPinResetView> {
    const now = new Date()

    // ① 先判新 PIN 的格式：这是最便宜的一道，且与"猜密码"无关，不该占额度。
    if (!isPinFormatValid(dto.pin)) {
      throw new BadRequestException({
        code: 'PARENT_PIN_FORMAT_INVALID',
        message: '新的家长 PIN 必须是 4–6 位数字（这次没有计入任何错误次数）。'
      })
    }

    // ② 限流：key 用服务端可信的 userId。被拒的请求**不**记账（与登录同一条口径）。
    const verdict = this.limiter.consume(
      `parent-pin-reset:${operator.userId}`,
      PIN_RESET_ATTEMPTS_PER_MINUTE,
      now
    )
    if (!verdict.allowed) {
      throw new HttpException(
        {
          code: 'PIN_RESET_RATE_LIMITED',
          // 给客户端一个可直接显示 / 定时重试的秒数（与登录 429 同一字段名）。
          retryAfterSeconds: verdict.retryAfterSeconds,
          message: `密码尝试太频繁，请 ${verdict.retryAfterSeconds} 秒后再试。`
        },
        HttpStatus.TOO_MANY_REQUESTS
      )
    }

    // ③ 成员位 + 会话（403 / 409 的语义与其它几条完全一致）。
    const row = await this.load(childId, deviceId, operator.userId)
    this.assertGuardianMember(
      row,
      'PARENT_PIN_REQUIRES_GUARDIAN',
      '只有家长能重置家长 PIN。'
    )

    // ④ 账号密码：**不**回显"这个账号存不存在密码"以外的任何东西。
    const stored = await this.repository.readAccountPasswordHash(operator.userId)
    if (stored === null) {
      // ★ 时序：没有密码时也要花掉一次 scrypt 的成本，
      //   否则"有密码 / 没密码"能从响应时间上分辨出来（与登录端点同一条纪律）。
      await burnPasswordHashCost()
      throw new ForbiddenException({
        code: 'ACCOUNT_PASSWORD_NOT_SET',
        message:
          '这个账号还没有设置密码 —— 请先在「我的 → 登录账号」设置密码，再回来重置家长 PIN。'
      })
    }
    if (!(await verifyPassword(dto.password, stored))) {
      throw new ForbiddenException({
        code: 'CURRENT_PASSWORD_INVALID',
        message: '账号密码不正确（这里要的是登录密码，不是家长 PIN）。'
      })
    }

    // ⑤ 写：新哈希 + 清零计数 / 解锁 + 审计（端口内同一事务）。
    const state = await this.repository.resetParentPin({
      childId,
      userId: operator.userId,
      deviceId,
      pinHash: await hashPin(dto.pin),
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

  // W14：孩子模式（含"已到期未收回"）。它优先于 parentMode —— `effectiveRole()`
  // 已经把角色压到 child，这里只需把三态如实翻成三个字段。
  const kidUntil = toDateOrNull(row.session.kidModeUntil)
  const kidState = kidModeStateOf(kidUntil, now)

  return {
    activeRole,
    parentMode,
    modeSource: parentMode ? parentModeSourceOf(new Date(row.session.expiresAt), now) : null,
    parentModeExpiresAt: parentMode ? new Date(row.session.expiresAt).toISOString() : null,
    remainingSeconds: parentMode ? remainingSeconds(new Date(row.session.expiresAt), now) : 0,
    pinConfigured: row.pinHash !== null,
    remainingAttempts: locked ? 0 : remainingAttempts(row.pinFailedCount),
    lockedUntil: locked && lockedUntil !== null ? lockedUntil.toISOString() : null,
    kidMode: kidState === 'active',
    kidModeExpired: kidState === 'locked',
    kidModeUntil: kidUntil === null ? null : kidUntil.toISOString(),
    kidModeRemainingSeconds: kidModeRemainingSeconds(kidUntil, now)
  }
}

/**
 * `Date | string | null | undefined` → `Date | null`。
 *
 * ★ 缺省（`undefined`）与 `null` 同义：「这一列没有值」。它只出现在
 *   旧替身 / 旧用例构造的会话行上（真实 Prisma 行永远是 `Date | null`）。
 *   解析不了的字符串**不在这里**兜底 —— `session.gate.ts#effectiveRole()`
 *   会在任何请求路径上把它抛成 500（数据病不伪装成"没开孩子模式"）。
 */
function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(value)
}

