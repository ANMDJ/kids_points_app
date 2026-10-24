import type { DevicePlatform } from '@prisma/client'

/**
 * 设备推送 token 的**行 / 契约形状**（W6-A，2026-10-24）。
 *
 * ── 为什么单独的模块，而不是继续塞在 notifications 里 ─────────────────────
 *   `push.port.ts` 回答的是「消息怎么发出去」；这一层回答的是
 *   「**发给谁**」—— 收件人 → 设备 token 的映射。两件事的写权限、生命周期、
 *   失效来源完全不同（消息是一次性的，token 会长期存在且会过期 / 被注销），
 *   混在一起会让「推送适配器」悄悄拥有写库的能力。
 *
 * ── `DeviceToken` 表 W0 就有，本阶段只补上**写入口** ────────────────────────
 *   `28-w5k-handoff.md` §5.1 把「设备 token 上报接口」列为接真实渠道的前置项：
 *   没有它，任何适配器都只能回 `no_device_token`。
 *
 * ── 三个刻意的设计取舍 ────────────────────────────────────────────────────
 *   ① **响应里不回显 `token`**：它不是密码，但它是**可直接用来推送的凭据**，
 *      回显只会让它出现在日志 / 截图 / 崩溃上报里。客户端自己刚发过来的值，
 *      不需要服务端再说一遍。
 *   ② **`childId` 只是「最近一次上报时所处的档案」**，不是归属键：
 *      推送的收件人是 `userId`（一个家长可能有两个孩子）；
 *      若按 `childId` 收口，孩子换一个档案就得重新上报。
 *   ③ **一个用户最多 10 个 active token**（LRU）：网关每次要收全部 token，
 *      不设上限就变成放大器的入口（注册接口本身就是「谁都能多写几行」）。
 */

/** 与 Prisma `enum DevicePlatform` 必须逐一对应（`test/device-tokens.test.ts` 静态对账）。 */
export const DEVICE_PLATFORMS = ['weapp', 'ios', 'android'] as const

/** 平台标识。`weapp` = 微信小程序（订阅消息），`ios` / `android` = APNs / FCM。 */
export type DevicePlatformName = (typeof DEVICE_PLATFORMS)[number]

/**
 * 平台名字面量与 Prisma 枚举的一致性由类型系统兜住一半：
 *   `DevicePlatform` 多一个值（例如加了 `harmony`）而这里没跟上 ⇒ 下面这行**编译失败**；
 *   反过来这里多一个值 ⇒ 同样编译失败。
 * 运行期的另一半（schema 文本）由用例读 `schema.prisma` 对账 —— 与权限矩阵同一手法。
 */
const _platformParity: Record<DevicePlatform, DevicePlatformName> = {
  weapp: 'weapp',
  ios: 'ios',
  android: 'android'
}
/** 反方向：本文件多写一个 Prisma 没有的平台 ⇒ 编译失败。 */
const _platformExhaustive: readonly DevicePlatform[] = DEVICE_PLATFORMS
void _platformParity
void _platformExhaustive

/** 单用户 active token 上限（见文件头 ③）。注册时按 `lastSeenAt` 淘汰最旧的。 */
export const MAX_ACTIVE_TOKENS_PER_USER = 10

/** 端口行：只含「这次操作的结果」，不含 `token`（见文件头 ①）。 */
export interface DeviceTokenRow {
  id: string
  platform: DevicePlatformName
  active: boolean
  lastSeenAt: Date
  createdAt: Date
  revokedAt: Date | null
}

export interface RegisterDeviceTokenInput {
  /** 会话 actor —— **绝不**取请求体。 */
  userId: string
  /** 会话上下文（仅作记录，见文件头 ②）。 */
  childId: string | null
  platform: DevicePlatformName
  /** 已 trim；长度 / 空白由 DTO 与 service 双重把关。 */
  token: string
}

/**
 * 注册结果。
 *
 * ★ `owned_by_other` **不是** 500 也不是 409 以外的兜底：一个 token 只能属于一个账号。
 *   若允许「同 token 换主人」，前一个账号的推送就会被静默转给后一个账号 ——
 *   共享平板上换人登录是真实场景，但那必须由**前一个账号先注销**（或由运维清理），
 *   不能让「后一次注册」悄悄接管。见 29 号交接单 §2.3。
 */
export type RegisterDeviceTokenResult =
  | { kind: 'ok'; row: DeviceTokenRow; created: boolean }
  | { kind: 'owned_by_other' }

export type RevokeDeviceTokenResult =
  | { kind: 'ok'; row: DeviceTokenRow }
  | { kind: 'not_found' }

/** 推送网关需要的最小事实：**只**有 token 与平台，没有 userId / childId。 */
export interface ActivePushToken {
  token: string
  platform: DevicePlatformName
}

/** `POST /device-tokens` 与 `POST /device-tokens/revoke` 的响应（同一个形状）。 */
export interface DeviceTokenDto {
  id: string
  platform: DevicePlatformName
  active: boolean
  lastSeenAt: string
  createdAt: string
  /** `active=false` 时必有值；注册回来恒为 `null`。 */
  revokedAt: string | null
}
