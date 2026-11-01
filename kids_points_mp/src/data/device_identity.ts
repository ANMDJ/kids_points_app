import { KeyValueStorage, MemoryKeyValueStorage, TaroKeyValueStorage } from './client_storage'
import { readCompiledEnvironment } from './compiled_env'

/**
 * 设备标识（`x-kp-device-id`）的**来源与持久化**（W9-A / `40` §1.6、§9.2）。
 *
 * ── 它修的是什么 ────────────────────────────────────────────────────────────
 *   W9 之前，deviceId 是**编译期常量**（`TARO_APP_KP_DEVICE_ID`）且**不持久化**：
 *   同一台手机换个包 / 清一次缓存就是"另一台设备"，而后端 `DeviceSession`
 *   的行键正是 `(deviceId, childId)` —— 于是会话行一层层堆起来，
 *   "这台设备的家长窗口"也变得不可复现。
 *
 *   现在：首次运行**生成一次**并写进 storage（`kp_device_id`），之后一直复用。
 *   `TARO_APP_KP_DEVICE_ID` 降级为**开发期覆盖**（想手工复现某条会话时才填）。
 *
 * ── ★ 它不是凭据 ────────────────────────────────────────────────────────────
 *   后端只拿它当**行键 / 审计字段**（`40` §8.1）。伪造它换不到任何权限：
 *   身份来自 Bearer token，角色来自成员位。因此这里不做"防篡改"，
 *   只做"格式合法 + 尽量稳定"。
 *
 * ── 合法字符集为什么这么窄 ──────────────────────────────────────────────────
 *   `1–128` 个 `[A-Za-z0-9._:-]`。理由不是洁癖：HTTP 头的值按 latin-1 传输，
 *   `dev-别人的设备` 这种值在 `fetch`/`Taro.request` 里**发不出去**（这正是
 *   `backend/test/identity-http.test.ts` 踩过的坑）。与其到线上才发现，
 *   不如在生成/解析处就拒绝。
 */

/** storage 键：`kp_device_id`（与 `kp_token` 同一命名前缀）。 */
export const kDeviceIdStorageKey = 'kp_device_id'

/** 编译期覆盖键（`kids_points_mp/.env.local`）。 */
export const kDeviceIdEnvKey = 'TARO_APP_KP_DEVICE_ID'

/** 后端 `readDeviceId()` 的上界口径（128 = 微信 `js_code` 量级，够任何 uuid）。 */
export const kMaxDeviceIdLength = 128

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/** 生成值的前缀：一眼能看出"这是客户端自己造的"，而不是配对流程签发的。 */
export const kGeneratedDeviceIdPrefix = 'kp-dev-'

/** 这个值**现在**从哪来。UI 只在 `generated` 第一次出现时提示一次。 */
export type DeviceIdSource = 'env' | 'storage' | 'generated'

export interface ResolvedDeviceId {
  deviceId: string
  source: DeviceIdSource
  /**
   * 是否**已经**在 storage 里。
   *
   * `false` 只有一种情况：刚生成、但写 storage 失败（配额满 / 平台限制）。
   * 此时本次运行仍可用（内存里有值），但下次冷启动会得到**另一个** id
   * ⇒ 表现为"这台设备的历史不见了"。调用方据此提示，而不是假装成功。
   */
  persisted: boolean
}

/**
 * 形状校验（生成前 / 读 env 前 / 读 storage 后都要过一次）。
 *
 * 非法值的处理在三处**不同**（这是有意的）：
 *   · env 里非法 ⇒ 抛错（配置错误必须当场看见）；
 *   · storage 里非法 ⇒ 丢弃并重新生成（可能是旧版本写进去的，用户无从修改）；
 *   · 生成结果非法 ⇒ 不可能（生成器只产合法字符），断言式抛错。
 */
export function isValidDeviceId(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > kMaxDeviceIdLength) return false
  return DEVICE_ID_PATTERN.test(trimmed)
}

/** 随机源：默认用 `Math.random`（两台设备的 id 相撞在 24 位十六进制下不可能）。 */
export function generateDeviceId(random: () => number = Math.random): string {
  let suffix = ''
  while (suffix.length < 24) {
    // `toString(16)` 可能只有 1 位（0.5 → '0.8'，取小数部分），逐段拼接更稳。
    const chunk = Math.floor(random() * 0x100000000)
      .toString(16)
      .padStart(8, '0')
      .slice(0, 8)
    suffix += chunk
  }
  return `${kGeneratedDeviceIdPrefix}${suffix.slice(0, 24)}`
}

/**
 * 解析出**这次运行**要用的 deviceId。
 *
 * 优先级：env（开发期覆盖）→ storage（正常路径）→ 生成 + 写回。
 * 每一步失败都**不静默**：env 非法抛错；storage 写入失败则 `persisted:false`。
 */
export function resolveDeviceId(input: {
  env?: Record<string, string | undefined>
  storage?: KeyValueStorage
  generate?: () => string
} = {}): ResolvedDeviceId {
  const env = input.env ?? defaultEnvironment()
  const storage = input.storage ?? new TaroKeyValueStorage()
  const generate = input.generate ?? generateDeviceId

  const rawEnv = env[kDeviceIdEnvKey] ?? ''
  if (rawEnv.trim() !== '') {
    const fromEnv = rawEnv.trim()
    if (!isValidDeviceId(fromEnv)) {
      throw new Error(
        `${kDeviceIdEnvKey} 不是合法的设备标识：只允许 1–${kMaxDeviceIdLength} 个 ` +
          `[A-Za-z0-9._:-]（HTTP 头不能带中文/空格）。请改正后重新编译。`
      )
    }
    return { deviceId: fromEnv, source: 'env', persisted: false }
  }

  const stored = storage.read(kDeviceIdStorageKey)
  if (stored !== null && isValidDeviceId(stored)) {
    return { deviceId: stored.trim(), source: 'storage', persisted: true }
  }

  const generated = generate().trim()
  if (!isValidDeviceId(generated)) {
    // 生成器是本地代码，走到这里说明它被改坏了 —— 宁可当场炸，也不要发出
    // 一个后端会静默 trim 成别的值的头。
    throw new Error(`生成的设备标识不合法：${generated}`)
  }
  try {
    storage.write(kDeviceIdStorageKey, generated)
  } catch (error) {
    return { deviceId: generated, source: 'generated', persisted: false }
  }
  return { deviceId: generated, source: 'generated', persisted: true }
}

/**
 * 只读地取当前 deviceId（不发请求、不写 storage）。
 *
 * 给"还没登录就要显示诊断信息"的场景用；取不到返回 null，
 * **不**顺手生成 —— 生成属于 [resolveDeviceId] 的职责。
 */
export function peekDeviceId(storage: KeyValueStorage = new TaroKeyValueStorage()): string | null {
  const stored = storage.read(kDeviceIdStorageKey)
  return stored !== null && isValidDeviceId(stored) ? stored.trim() : null
}

/** 用例 helper：一份"什么都没写过"的 storage。 */
export function emptyDeviceStorage(): KeyValueStorage {
  return new MemoryKeyValueStorage()
}

function defaultEnvironment(): Record<string, string | undefined> {
  // ★ 同上：`process.env` 整体在小程序里是空 polyfill，必须逐键静态读。
  return readCompiledEnvironment()
}
