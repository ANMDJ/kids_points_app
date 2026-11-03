import {
  kAuthorizationHeader,
  sharedAuthTokens
} from './auth_token_holder'
import {
  ReadApiConfig,
  kChildIdHeader,
  kDeviceIdHeader,
  type ReadEnvironment
} from './read_api'
import { ReadApiException } from './read_api_errors'
import { readCompiledEnvironment } from './compiled_env'
import {
  readBool,
  readInt,
  readObject,
  readOptionalDate,
  readOptionalString,
  readString
} from './read_dto'
import { WriteApiException } from './write_api_errors'
import type { WriteHttpResponse, WriteMethod, WriteTransport } from './write_api'
import { TaroWriteTransport } from './write_api'

/**
 * 家长模式 ＋ 家长 PIN 的**客户端能力**（W8-C，2026-10-27 / `02` §7、§9.18）。
 *
 * ── 为什么又是独立文件 ──────────────────────────────────────────────────────
 *   与 Flutter 侧 `lib/data/parent_mode_{api,dto,mapper}.dart` 同一分工，也与
 *   `onboarding.ts` 同理：四条路由横跨三个方法（GET / POST / DELETE），塞进
 *   `read_api`（只发 GET）或 `write_api`（打卡 / 撤销那两类写）都会让那一边
 *   多出「不该由它负责」的方法。独立客户端还有个好处：测试只注入这一个接口，
 *   不必伪造整份 `ReadApi`。
 *
 * ── 明文 PIN 的边界 ────────────────────────────────────────────────────────
 *   明文只出现在本文件的请求体里：不进 store、不进日志、不进 `detail`。
 *   后端同理（只存 `scrypt$…` 哈希）。任何一个环节把 PIN 记进异常详情，
 *   事后都能在崩溃报告里读到它。
 *
 * ── 为什么**没有**本地倒计时状态 ───────────────────────────────────────────
 *   TTL 由服务端持有（`DeviceSession.expiresAt`）。客户端若从「5:00」自己往下
 *   数，三件事会让它说谎：手机时间不准、小程序切后台（定时器暂停）、家长手动
 *   改系统时间。所以快照里存的是**绝对时刻** `expiresAt`，界面每次重绘都用
 *   [parentModeRemainingSeconds] 现算；服务端的 `remainingSeconds` 只是快照。
 */

/** `guardian` / `child` / `viewer`。 */
export type ParentRole = 'guardian' | 'child' | 'viewer'

/** 家长模式最长 5 分钟（`02` §7）—— 超过它说明**不是** PIN 换来的。 */
export const PARENT_MODE_MAX_TTL_SECONDS = 300

/**
 * 登录会话自带的家长权限，剩余时间上界：一年。
 *
 * 只用来抓「毫秒当秒」这类单位错误 —— 邀请码加入的家长设备是 30 天会话，
 * 换算成 2 592 000 秒必须合法。
 */
export const PARENT_MODE_MAX_SESSION_TTL_SECONDS = 366 * 24 * 60 * 60

/**
 * 孩子模式（W14，2026-11-03 / `docs/design/51-kid-mode-window.md`）。
 *
 * ★ 三端副本必须逐字一致（后端 `kid-mode.policy.ts` / Flutter `kid_mode.dart` /
 *   本文件）；`tools/kid-mode-check.mjs` 守着，别只改一边。
 */
export const KID_MODE_MIN_MINUTES = 1
export const KID_MODE_MAX_MINUTES = 30
export const KID_MODE_DEFAULT_MINUTES = 15

/** 面板上的快捷时长（5 的倍数 + 上限）。 */
export const KID_MODE_DURATION_CHOICES: readonly number[] = [5, 10, 15, 20, 25, 30]

/** 整数 1–30 才合法；`null` = 合法（与 Flutter `validateKidModeMinutes` 同口径）。 */
export function validateKidModeMinutes(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes < KID_MODE_MIN_MINUTES || minutes > KID_MODE_MAX_MINUTES) {
    return `给孩子用的时长要在 ${KID_MODE_MIN_MINUTES}–${KID_MODE_MAX_MINUTES} 分钟之间。`
  }
  return null
}

/**
 * 家长权限（`activeRole === 'guardian'`）的**来源**。
 *
 * 服务端只有一行 `DeviceSession.activeRole`，但「为什么是 guardian」有两种，
 * 界面说法完全不同：
 *   * `pin`     —— 刚才输了家长 PIN，换来 5 分钟（`02` §7 的 TTL）；
 *   * `session` —— 这台设备本来就是用邀请码加入的家长设备，30 天登录会话自带
 *                  guardian 权限。它不是「5 分钟后自动收回」，而是「下次登录前
 *                  一直有效」。
 *
 * 服务端按剩余时间派生（≤5 分钟 ⇒ `pin`，否则 ⇒ `session`），客户端不许自己猜。
 */
export type ParentModeSource = 'pin' | 'session'

/** 连错几次锁 15 分钟；5 = 一次都没错。 */
export const PARENT_PIN_MAX_ATTEMPTS = 5

/** 家长模式快照 —— 只存服务端事实，不存本地倒计时。 */
export interface ParentMode {
  readonly activeRole: ParentRole
  /** 这台设备**当前**是否处于家长模式（服务端判定，不是 UI 开关）。 */
  readonly parentMode: boolean
  /** guardian 的来源（`pin` / `session`）；不在家长模式时为 null。 */
  readonly modeSource: ParentModeSource | null
  /** 到期**绝对时刻**（epoch ms）；不在家长模式时为 null。 */
  readonly expiresAt: number | null
  /** 拉取那一刻服务端算出的剩余秒数（快照，已知偏大）。 */
  readonly remainingSeconds: number
  /** 当前账号是否已经设过 PIN（决定按钮写「输入 PIN」还是「先设置 PIN」）。 */
  readonly pinConfigured: boolean
  /** 还允许输错几次（0 = 已锁定）。 */
  readonly remainingAttempts: number
  /** 锁定到什么时候（epoch ms）；未锁定为 null。 */
  readonly lockedUntil: number | null
  /** 孩子模式正在窗口内（W14）。 */
  readonly kidMode: boolean
  /** 孩子模式已到点、等家长 PIN 收回（W14；A 方案，到期**不**回家长模式）。 */
  readonly kidModeExpired: boolean
  /** 孩子模式的到期绝对时刻（epoch ms）。 */
  readonly kidModeUntil: number | null
  /** 孩子模式剩余秒数（快照，只用于首帧）。 */
  readonly kidModeRemainingSeconds: number
}

/**
 * 预览模式 / 还没拉到过任何服务端状态时的占位值。
 *
 * `pinConfigured: false` + `parentMode: false` 表示「还不知道」，界面据此
 * **不显示**「先设置 PIN」这类会误导的引导（store 用 `parentMode === null`
 * 表达「还没拉到」，这个常量只给非空字段做兜底）。
 */
export const PARENT_MODE_UNKNOWN: ParentMode = {
  activeRole: 'child',
  parentMode: false,
  modeSource: null,
  expiresAt: null,
  remainingSeconds: 0,
  pinConfigured: false,
  remainingAttempts: PARENT_PIN_MAX_ATTEMPTS,
  lockedUntil: null,
  kidMode: false,
  kidModeExpired: false,
  kidModeUntil: null,
  kidModeRemainingSeconds: 0
}

/** `POST /auth/parent-pin` 的结果（设 / 改家长 PIN）。 */
export interface ParentPinResult {
  readonly pinConfigured: boolean
  /** true = **修改**了已有 PIN；false = 首次设置。 */
  readonly changed: boolean
  /** PIN 落库时刻（服务端事实）。 */
  readonly pinSetAt: number | null
  /** 成功后清零的失败次数（后端返回 5）。 */
  readonly remainingAttempts: number
}

/**
 * `GET/POST/DELETE /auth/parent-mode` 的线格式解析。
 *
 * 与其它 DTO 同一口径：缺字段 / 类型不对 / 形状自相矛盾一律 `malformed`，
 * 绝不 `?? 0` 猜一个默认值。这里判的五类「自相矛盾」：
 *   ① `parentMode` 必须等于 `activeRole === 'guardian'` —— 服务端就是按它派生的；
 *      不一致说明版本漂移，界面会同时显示「家长模式」和「孩子角标」；
 *   ② `expiresAt` 与 `parentMode` 必须同真同假：在家长模式却没有到期时刻 =
 *      倒计时无从算起；不在家长模式却有到期时刻 = 迟早被误用；
 *   ③ `modeSource` 与 `parentMode` 同真同假，且只允许 `pin` / `session`；
 *   ④ `remainingSeconds` 必须与**来源**对得上：不在家长模式 ⇒ 0；
 *      `pin` ⇒ 1–300；`session` ⇒ 301–一年。
 *      ★ 这里**不能**统一按「0–300」卡：用邀请码加入的家长设备，会话一上来就是
 *      `guardian`、TTL 是 30 天，`remainingSeconds` 会是 2 592 000。按 5 分钟硬卡
 *      会让家长本机的第一屏变成「数据格式不符合预期」—— 这正是 W8-C 验收抓到的
 *      缺陷（`modeSource` 就是它的修复）。
 *   ⑤ 锁定态：`lockedUntil !== null` ⇒ `remainingAttempts === 0`；
 *      未锁定时 `remainingAttempts` 必须在 1–5 之间。
 */
export function parseParentMode(raw: unknown, path = '$'): ParentMode {
  const json = readObject(raw, path)
  const activeRole = readString(json, 'activeRole', `${path}.activeRole`)
  if (
    activeRole !== 'guardian' &&
    activeRole !== 'child' &&
    activeRole !== 'viewer'
  ) {
    throw ReadApiException.malformed(
      `${path}.activeRole`,
      `未知角色：${activeRole}`
    )
  }

  const parentMode = readBool(json, 'parentMode', `${path}.parentMode`)
  const modeSource = readOptionalString(
    json,
    'modeSource',
    `${path}.modeSource`
  )
  const expiresAt = readOptionalDate(
    json,
    'parentModeExpiresAt',
    `${path}.parentModeExpiresAt`
  )
  const remainingSeconds = readInt(
    json,
    'remainingSeconds',
    `${path}.remainingSeconds`
  )
  const pinConfigured = readBool(json, 'pinConfigured', `${path}.pinConfigured`)
  const remainingAttempts = readInt(
    json,
    'remainingAttempts',
    `${path}.remainingAttempts`
  )
  const lockedUntil = readOptionalDate(
    json,
    'lockedUntil',
    `${path}.lockedUntil`
  )
  // W14：孩子模式（与 Flutter `ParentModeDto` 同一套四类矛盾校验）。
  const kidMode = readBool(json, 'kidMode', `${path}.kidMode`)
  const kidModeExpired = readBool(
    json,
    'kidModeExpired',
    `${path}.kidModeExpired`
  )
  const kidModeUntil = readOptionalDate(
    json,
    'kidModeUntil',
    `${path}.kidModeUntil`
  )
  const kidModeRemainingSeconds = readInt(
    json,
    'kidModeRemainingSeconds',
    `${path}.kidModeRemainingSeconds`
  )

  if (parentMode !== (activeRole === 'guardian')) {
    throw ReadApiException.malformed(
      `${path}.parentMode`,
      `parentMode=${parentMode} 与 activeRole=${activeRole} 自相矛盾`
    )
  }
  if (parentMode && expiresAt === null) {
    throw ReadApiException.malformed(
      `${path}.parentModeExpiresAt`,
      '处于家长模式但没有到期时刻 —— 倒计时无从算起'
    )
  }
  if (!parentMode && expiresAt !== null) {
    throw ReadApiException.malformed(
      `${path}.parentModeExpiresAt`,
      '不在家长模式却给了到期时刻'
    )
  }
  if (!parentMode) {
    if (modeSource !== null) {
      throw ReadApiException.malformed(
        `${path}.modeSource`,
        `不在家长模式却给了来源：${modeSource}`
      )
    }
    if (remainingSeconds !== 0) {
      throw ReadApiException.malformed(
        `${path}.remainingSeconds`,
        `不在家长模式时剩余秒数必须为 0：${remainingSeconds}`
      )
    }
  } else if (modeSource === 'pin') {
    if (
      remainingSeconds < 1 ||
      remainingSeconds > PARENT_MODE_MAX_TTL_SECONDS
    ) {
      throw ReadApiException.malformed(
        `${path}.remainingSeconds`,
        `PIN 换来的家长模式剩余秒数越界（1–${PARENT_MODE_MAX_TTL_SECONDS}）：${remainingSeconds}`
      )
    }
  } else if (modeSource === 'session') {
    if (
      remainingSeconds <= PARENT_MODE_MAX_TTL_SECONDS ||
      remainingSeconds > PARENT_MODE_MAX_SESSION_TTL_SECONDS
    ) {
      throw ReadApiException.malformed(
        `${path}.remainingSeconds`,
        `登录会话的剩余秒数越界（${PARENT_MODE_MAX_TTL_SECONDS}–${PARENT_MODE_MAX_SESSION_TTL_SECONDS}）：${remainingSeconds}`
      )
    }
  } else {
    throw ReadApiException.malformed(
      `${path}.modeSource`,
      `处于家长模式但来源缺失/未知：${String(modeSource)}`
    )
  }
  if (lockedUntil !== null) {
    if (remainingAttempts !== 0) {
      throw ReadApiException.malformed(
        `${path}.remainingAttempts`,
        `已锁定但剩余次数不是 0：${remainingAttempts}`
      )
    }
  } else if (
    remainingAttempts < 1 ||
    remainingAttempts > PARENT_PIN_MAX_ATTEMPTS
  ) {
    throw ReadApiException.malformed(
      `${path}.remainingAttempts`,
      `未锁定时剩余次数必须在 1–${PARENT_PIN_MAX_ATTEMPTS} 之间：${remainingAttempts}`
    )
  }

  // ── W14：孩子模式的四类自相矛盾（与 Flutter DTO 逐条对齐）───────────────
  // ① 同一个时间戳不可能同时"进行中"和"已到期"；
  // ② 孩子模式与家长模式互斥（服务端按 kidModeUntil 降级，两者同真说明没算）；
  // ③ 有状态就必须有绝对时刻；
  // ④ 剩余秒数必须与状态对得上：进行中 ⇒ 1..1800；已到期 / 未开 ⇒ 0。
  const maxKidModeSeconds = KID_MODE_MAX_MINUTES * 60
  if (kidMode && kidModeExpired) {
    throw ReadApiException.malformed(
      `${path}.kidModeExpired`,
      'kidMode 与 kidModeExpired 同时为 true'
    )
  }
  if ((kidMode || kidModeExpired) && parentMode) {
    throw ReadApiException.malformed(
      `${path}.parentMode`,
      '孩子模式与家长模式同时为 true（服务端未把 kidModeUntil 计入 effectiveRole）'
    )
  }
  if (kidMode || kidModeExpired) {
    if (kidModeUntil === null) {
      throw ReadApiException.malformed(
        `${path}.kidModeUntil`,
        '孩子模式有状态却没有到期时刻'
      )
    }
    if (
      kidMode &&
      (kidModeRemainingSeconds < 1 ||
        kidModeRemainingSeconds > maxKidModeSeconds)
    ) {
      throw ReadApiException.malformed(
        `${path}.kidModeRemainingSeconds`,
        `孩子模式剩余秒数越界（1–${maxKidModeSeconds}）：${kidModeRemainingSeconds}`
      )
    }
    if (kidModeExpired && kidModeRemainingSeconds !== 0) {
      throw ReadApiException.malformed(
        `${path}.kidModeRemainingSeconds`,
        `已到期的孩子模式剩余秒数必须为 0：${kidModeRemainingSeconds}`
      )
    }
  } else {
    if (kidModeUntil !== null) {
      throw ReadApiException.malformed(
        `${path}.kidModeUntil`,
        '没有孩子模式却给了到期时刻'
      )
    }
    if (kidModeRemainingSeconds !== 0) {
      throw ReadApiException.malformed(
        `${path}.kidModeRemainingSeconds`,
        `没有孩子模式时剩余秒数必须为 0：${kidModeRemainingSeconds}`
      )
    }
  }

  return {
    activeRole: activeRole as ParentRole,
    parentMode,
    modeSource: modeSource as ParentModeSource | null,
    expiresAt,
    remainingSeconds,
    pinConfigured,
    remainingAttempts,
    lockedUntil,
    kidMode,
    kidModeExpired,
    kidModeUntil,
    kidModeRemainingSeconds
  }
}

/**
 * `POST /auth/parent-pin` 的回包解析。
 *
 * `changed` 与 `pinConfigured` 是**两个**布尔：前者说「这次是改还是设」，
 * 后者说「现在有没有 PIN」。合并成一个会让「修改成功」看起来像「首次设置
 * 成功」（家长会以为别的设备上的旧 PIN 还能用）。
 */
export function parseParentPinResult(
  raw: unknown,
  path = '$'
): ParentPinResult {
  const json = readObject(raw, path)
  const pinConfigured = readBool(json, 'pinConfigured', `${path}.pinConfigured`)
  const changed = readBool(json, 'changed', `${path}.changed`)
  const pinSetAt = readOptionalDate(json, 'pinSetAt', `${path}.pinSetAt`)
  const remainingAttempts = readInt(
    json,
    'remainingAttempts',
    `${path}.remainingAttempts`
  )

  // 这个端点的成功语义就是「PIN 现在存在」：false 只可能是服务端写丢了。
  if (!pinConfigured) {
    throw ReadApiException.malformed(
      `${path}.pinConfigured`,
      '设置 PIN 成功后 pinConfigured 必须为 true'
    )
  }
  if (remainingAttempts < 0 || remainingAttempts > PARENT_PIN_MAX_ATTEMPTS) {
    throw ReadApiException.malformed(
      `${path}.remainingAttempts`,
      `剩余次数越界（0–${PARENT_PIN_MAX_ATTEMPTS}）：${remainingAttempts}`
    )
  }

  return { pinConfigured, changed, pinSetAt, remainingAttempts }
}

/** 当前的家长权限是**登录会话自带**的吗（决定不显示 5 分钟倒计时）。 */
export function isParentModeSessionBacked(mode: ParentMode | null): boolean {
  return mode !== null && mode.parentMode && mode.modeSource === 'session'
}

/** 当前的家长权限是**PIN 换来的 5 分钟**吗（只有这种才有倒计时）。 */
export function isParentModePinBacked(mode: ParentMode | null): boolean {
  return mode !== null && mode.parentMode && mode.modeSource === 'pin'
}

/** 距离家长模式结束还有几秒（**向上取整**，与后端 `remainingSeconds()` 同口径）。 */
export function parentModeRemainingSeconds(
  mode: ParentMode | null,
  now: number
): number {
  if (mode === null || !mode.parentMode || mode.expiresAt === null) return 0
  const ms = mode.expiresAt - now
  return ms <= 0 ? 0 : Math.ceil(ms / 1000)
}

/** 孩子模式**此刻**是否还在窗口内（W14；按绝对时刻现算，不信快照里的布尔）。 */
export function isKidModeActiveAt(mode: ParentMode | null, now: number): boolean {
  if (mode === null || !mode.kidMode || mode.kidModeUntil === null) return false
  return mode.kidModeUntil > now
}

/**
 * 孩子模式是否处于「时间到了、等家长输 PIN」。
 *
 * ★ 服务端已明确 `kidModeExpired`，或本地时钟已越过 `kidModeUntil` —— 两者取或。
 *   界面不能停在一个已经过期的倒计时上。
 */
export function isKidModeExpiredAt(mode: ParentMode | null, now: number): boolean {
  if (mode === null) return false
  if (mode.kidModeExpired) return true
  return mode.kidMode && mode.kidModeUntil !== null && !isKidModeActiveAt(mode, now)
}

/** 孩子模式还剩几秒（向上取整；未开 / 已到期都 0）。 */
export function kidModeRemainingSeconds(mode: ParentMode | null, now: number): number {
  if (mode === null || mode.kidModeUntil === null) return 0
  const ms = mode.kidModeUntil - now
  return ms <= 0 ? 0 : Math.ceil(ms / 1000)
}

/** 是否处于锁定中（锁定期间后端连 scrypt 都不跑，客户端不该再发请求）。 */
export function isParentPinLockedAt(
  mode: ParentMode | null,
  now: number
): boolean {
  if (mode === null || mode.lockedUntil === null) return false
  return mode.lockedUntil > now
}

/** 锁定还剩几秒（0 = 未锁定）。 */
export function parentPinLockSecondsAt(
  mode: ParentMode | null,
  now: number
): number {
  if (mode === null || mode.lockedUntil === null) return 0
  const ms = mode.lockedUntil - now
  return ms <= 0 ? 0 : Math.ceil(ms / 1000)
}

/**
 * PIN 的本地预检：4–6 位数字（与后端 `PIN_PATTERN` 同口径）。
 *
 * 空串返回 null —— 这里的职责只是「格式对不对」，「空」在调用方有各自的
 * 文案（进入时要「请输入家长 PIN」，设置时要「请输入新的家长 PIN」）。
 */
export function validateParentPin(raw: string): string | null {
  const pin = raw.trim()
  if (pin === '') return null
  return /^\d{4,6}$/.test(pin) ? null : '家长 PIN 必须是 4–6 位数字。'
}

/** 秒 → `4:57`（分钟不补零，秒补零）。 */
export function mmss(seconds: number): string {
  const safe = seconds < 0 ? 0 : seconds
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

/**
 * 秒 → 「14 分 59 秒」/「59 秒」/「15 分钟」。
 *
 * 锁定时长是 15 分钟，用 `14:59` 会让人误读成「倒计时之外的一段时间」，
 * 所以锁定文案用文字。
 */
export function humanizeSeconds(seconds: number): string {
  const safe = seconds < 0 ? 0 : Math.floor(seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe % 60
  if (minutes === 0) return `${rest} 秒`
  if (rest === 0) return `${minutes} 分钟`
  return `${minutes} 分 ${rest} 秒`
}

export interface ParentModeApi {
  /** `GET /auth/parent-mode`：我现在是不是家长模式、还剩多少秒。 */
  fetch(): Promise<ParentMode>
  /**
   * `POST /auth/parent-mode`：用 PIN 换 5 分钟家长模式。
   *
   * 失败语义（与后端逐字对应，客户端不重新解释）：
   *   · `400 PARENT_PIN_FORMAT_INVALID` ⇒ 格式错，**不计次**；
   *   · `403 PARENT_PIN_INVALID`        ⇒ 值不对，`remainingAttempts` 已递减；
   *   · `409 PARENT_PIN_NOT_SET`        ⇒ 还没设过 PIN；
   *   · `429 PARENT_PIN_LOCKED`         ⇒ 锁定（[ParentPinLockException]）。
   */
  enter(pin: string): Promise<ParentMode>
  /** `DELETE /auth/parent-mode`：主动退出（**不需要** PIN，幂等）。 */
  exit(): Promise<ParentMode>
  /** `POST /auth/parent-pin`：首次设置 / 修改家长 PIN。 */
  setPin(input: { pin: string; currentPin?: string }): Promise<ParentPinResult>
  /**
   * `POST /auth/kid-mode`：把手机交给孩子用 `durationMinutes` 分钟（W14，1–30）。
   *
   * 失败语义（服务端逐字对应）：
   *   · `403 KID_MODE_REQUIRES_PARENT_MODE` ⇒ 当前不在家长模式，先输 PIN；
   *   · `409 KID_MODE_REQUIRES_PIN`        ⇒ 还没设 PIN（到点收不回来）；
   *   · `409 KID_MODE_ALREADY_ACTIVE`      ⇒ 已经开着，先结束这一次。
   */
  enterKidMode(durationMinutes: number): Promise<ParentMode>
  /**
   * `DELETE /auth/kid-mode`：用家长 PIN 收回孩子模式（W14）。
   *
   * **到期后也走这一条**：A 方案下到点不会自动回家长模式，必须验 PIN。
   */
  exitKidMode(pin: string): Promise<ParentMode>
  close?(): void
}

/**
 * PIN 锁定期（`429 PARENT_PIN_LOCKED`）。
 *
 * 单独一个类型是因为界面要**把剩余秒数显示出来**（「请 14 分 32 秒后再试」），
 * 而 [WriteApiException] 只有 `detail` 字符串。它仍然是 `conflict` 的一个特例：
 * 所有既有的 `instanceof WriteApiException` 分支都能接住它，只有想知道
 * 「还要等多久」的地方才需要再判一次类型。
 */
export class ParentPinLockException extends WriteApiException {
  readonly retryAfterSeconds: number

  constructor(input: { retryAfterSeconds: number; userMessage: string }) {
    super('conflict', input.userMessage, {
      statusCode: 429,
      code: 'PARENT_PIN_LOCKED'
    })
    this.name = 'ParentPinLockException'
    this.retryAfterSeconds = input.retryAfterSeconds
  }
}

/** `PARENT_*` 业务码的兜底文案（服务端没有给 `message` 时用）。 */
const PARENT_FALLBACK_MESSAGES: Record<string, string> = {
  PARENT_PIN_FORMAT_INVALID:
    '家长 PIN 必须是 4–6 位数字（这次没有计入错误次数）。',
  PARENT_PIN_CURRENT_REQUIRED: '修改家长 PIN 需要先输入当前 PIN。',
  PARENT_PIN_NOT_SET:
    '这个账号还没有家长 PIN：请先用家长账号进入一次家长模式，再设置 PIN。',
  PARENT_PIN_INVALID: '家长 PIN 不正确，这次操作没有保存。',
  PARENT_MODE_MEMBER_NOT_ACTIVE:
    '这台设备的会话与家庭成员位对不上，请重新登录后再试。',
  PARENT_MODE_REQUIRES_GUARDIAN: '只有家长才能进入家长模式。',
  PARENT_PIN_REQUIRES_GUARDIAN: '只有家长才能设置家长 PIN。'
}

/** 基于 `Taro.request`（复用写层 transport）的实现。 */
export class ParentModeApiClient implements ParentModeApi {
  private readonly config: ReadApiConfig
  private readonly transport: WriteTransport
  private readonly timeoutMs: number

  constructor(input: {
    config: ReadApiConfig
    transport?: WriteTransport
    timeoutMs?: number
  }) {
    this.config = input.config
    this.transport = input.transport ?? new TaroWriteTransport()
    this.timeoutMs = input.timeoutMs ?? 15000
  }

  async fetch(): Promise<ParentMode> {
    const decoded = await this.send('GET', '/auth/parent-mode', null)
    return parseParentMode(decoded)
  }

  async enter(pin: string): Promise<ParentMode> {
    const normalized = this.requirePin(pin)
    const decoded = await this.send('POST', '/auth/parent-mode', {
      pin: normalized
    })
    return parseParentMode(decoded)
  }

  async exit(): Promise<ParentMode> {
    const decoded = await this.send('DELETE', '/auth/parent-mode', null)
    return parseParentMode(decoded)
  }

  async enterKidMode(durationMinutes: number): Promise<ParentMode> {
    // 本地只挡"注定 400"的输入；服务端仍会 clampKidModeMinutes() 再夹一次。
    const invalid = validateKidModeMinutes(durationMinutes)
    if (invalid !== null) {
      throw new WriteApiException('badRequest', invalid, {
        code: 'KID_MODE_DURATION_INVALID'
      })
    }
    const decoded = await this.send('POST', '/auth/kid-mode', {
      durationMinutes
    })
    return parseParentMode(decoded)
  }

  async exitKidMode(pin: string): Promise<ParentMode> {
    const normalized = this.requirePin(pin)
    const decoded = await this.send('DELETE', '/auth/kid-mode', {
      pin: normalized
    })
    return parseParentMode(decoded)
  }

  async setPin(input: {
    pin: string
    currentPin?: string
  }): Promise<ParentPinResult> {
    const normalized = this.requirePin(input.pin)
    // `currentPin` 三态：`undefined` = 「我没有旧 PIN」；空串 = 客户端 bug。
    let currentPin: string | undefined
    if (input.currentPin !== undefined) {
      const trimmed = input.currentPin.trim()
      if (trimmed === '') {
        throw new Error('currentPin 不能是空串：没有旧 PIN 请省略这个字段。')
      }
      currentPin = this.requirePin(trimmed)
    }
    const decoded = await this.send('POST', '/auth/parent-pin', {
      pin: normalized,
      ...(currentPin !== undefined ? { currentPin } : {})
    })
    return parseParentPinResult(decoded)
  }

  close(): void {
    this.transport.close?.()
  }

  /**
   * PIN 的本地预检：4–6 位数字。
   *
   * ★ 这里**不发请求**就拒：格式错在后端是 `400`（不计次），但用户看到的会是
   *   「请求失败」这种模糊说法。本地拒绝能直接说「必须是 4–6 位数字」。
   */
  private requirePin(raw: string): string {
    const pin = raw.trim()
    if (pin === '') throw new Error('PIN 不能为空。')
    const invalid = validateParentPin(pin)
    if (invalid !== null) throw new Error(invalid)
    return pin
  }

  private async send(
    method: WriteMethod,
    path: string,
    body: Record<string, unknown> | null
  ): Promise<unknown> {
    const configError = this.config.validationError
    if (configError !== null) {
      throw new WriteApiException('badRequest', configError, {
        code: 'CLIENT_NOT_CONFIGURED'
      })
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      [kDeviceIdHeader]: this.config.effectiveDeviceId,
      [kChildIdHeader]: this.config.effectiveChildId
    }
    // W9-A：家长模式四条路由同样要 Bearer（它们属于「登录之后」的请求）。
    const authorization = sharedAuthTokens.authorizationHeader()
    if (authorization !== null) headers[kAuthorizationHeader] = authorization
    // GET 绝不声明 Content-Type：严格后端会拒绝「GET 带 JSON 空体」。
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }

    let response: WriteHttpResponse
    try {
      response = await withTimeout(
        this.transport.send(
          this.config.uri(path),
          headers,
          body,
          this.timeoutMs,
          method
        ),
        this.timeoutMs
      )
    } catch (error) {
      if (error instanceof WriteApiException) throw error
      throw WriteApiException.network(error)
    }

    const decoded = decodeBody(response.body)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw this.fromHttp(response.statusCode, decoded)
    }
    if (decoded === null) {
      throw WriteApiException.malformed(
        '$',
        `HTTP ${response.statusCode} 但响应体为空`
      )
    }
    return decoded
  }

  /**
   * `!2xx` → 异常。
   *
   * 与 Flutter `ParentModeApiClient._fromHttp` 同口径，只做两件
   * `WriteApiException.fromHttp` 不认识的事：
   *   ① **429** —— 本项目此前没有任何端点会回它，通用分支会说成「服务器开小差」，
   *      而家长真正需要知道的是「还要等多久、不是网络坏了」；
   *   ② `PARENT_*` 业务码 —— 服务端的 `message` 已经写得比本地文案更具体
   *      （比如「还剩 4 次机会」），原样交出；本地只兜服务端没给 message 的情况。
   */
  private fromHttp(statusCode: number, body: unknown): WriteApiException {
    const map =
      body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : null
    const rawCode = map?.code
    const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : null

    if (statusCode === 429) {
      const rawSeconds = map?.retryAfterSeconds
      const seconds =
        typeof rawSeconds === 'number' && Number.isFinite(rawSeconds)
          ? Math.max(0, Math.floor(rawSeconds))
          : 0
      return new ParentPinLockException({
        retryAfterSeconds: seconds,
        userMessage:
          seconds > 0
            ? `家长 PIN 已连续输错，暂时锁定。请 ${humanizeSeconds(seconds)}后再试。`
            : '家长 PIN 已连续输错，暂时锁定。请稍后再试（不是网络问题）。'
      })
    }

    if (code !== null && code.startsWith('PARENT_')) {
      const message =
        typeof map?.message === 'string' && map.message.trim() !== ''
          ? map.message
          : null
      const kind =
        statusCode === 400
          ? 'badRequest'
          : statusCode === 403
            ? 'forbidden'
            : statusCode === 409
              ? 'conflict'
              : statusCode === 404
                ? 'notFound'
                : 'server'
      return new WriteApiException(
        kind,
        message ??
          PARENT_FALLBACK_MESSAGES[code] ??
          '家长模式操作失败，这次没有生效。',
        { statusCode, code, detail: message }
      )
    }

    return WriteApiException.fromHttp({ statusCode, body })
  }
}

export function createParentModeApiFromEnvironment(
  env: ReadEnvironment = defaultEnvironment()
): ParentModeApi | null {
  const config = ReadApiConfig.fromEnvironment(env)
  return config.isConfigured ? new ParentModeApiClient({ config }) : null
}

function defaultEnvironment(): ReadEnvironment {
  // ★ 同上：`process.env` 整体在小程序里是空 polyfill，必须逐键静态读。
  return readCompiledEnvironment()
}

/** `Taro.request` 已带超时，但部分平台不遵守它 —— 客户端再兜一层。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(WriteApiException.timeout(timeoutMs))
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function decodeBody(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw
}
