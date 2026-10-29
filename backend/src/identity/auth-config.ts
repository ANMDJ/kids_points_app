/**
 * 认证层的**启动期配置判据**（W9-A，2026-10-29 / `docs/design/40-login-and-session-design.md` §9.4、§12.2）。
 *
 * ── 这个文件存在的唯一理由：一条旁路不能在某个 `.env` 里活到线上 ──────────────
 *   改造期间允许"没有 Bearer、只有 `x-kp-device-id`"的旧路径继续工作（双读期），
 *   否则 19 个 `test/**` ＋ 14 个 `test-db/**` 文件必须一次性重写 ——
 *   那种大爆炸迁移一旦半途出问题，最可能的处置是"先把它关掉"，于是整套改造停摆。
 *   但旁路同时是**唯一一条"改造完成却仍不安全"的路径** ⇒ 必须有一处 fail-closed：
 *
 *     NODE_ENV=production 且 AUTH_DEVICE_ID_FALLBACK=1  ⇒ **启动即抛错**（不进事件循环）
 *
 *   这样它无法"悄悄地"生效：进程起不来，日志里有明确的一句话。
 *
 * ── 三条口径（以及为什么默认值是这样）──────────────────────────────────────
 *   ① 生产：`x-kp-device-id` **永远是设备标识，不是凭据** —— 无论开关写什么；
 *   ② 非生产：**默认开**（`=0` 可关）。默认开不是"偷懒"：用例数量是既成事实，
 *      而"默认需要显式打开"会让每个开发者第一次跑测试都撞 19 处 401，
 *      然后**在测试装配里**打开它 —— 结果一样，但多了一次"改配置让测试变绿"的肌肉记忆；
 *   ③ 开关值只接受 `0` / `1`（缺省视为 `1`）。写 `true` / `yes` / `on` ⇒ **抛错**：
 *      配置拼错时"猜它的意思"是最坏的选择（猜错的方向决定它是洞还是故障）。
 *
 * ── 与 `APP_ENV` 无关 ───────────────────────────────────────────────────────
 *   只看 `NODE_ENV`。引入第二个"环境名"会让"生产"有两个定义，
 *   而两个定义的交集永远比想象的小（部署时少写一个变量就够了）。
 */
export const AUTH_DEVICE_ID_FALLBACK_ENV = 'AUTH_DEVICE_ID_FALLBACK'

/** 启动期配置错误 —— 与运行期 401/500 区分开：它意味着**进程不该起来**。 */
export class AuthBootConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthBootConfigError'
  }
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production'
}

type Flag = 'on' | 'off'

/** 只认 `0` / `1`（缺省 `1`）；其它值 ⇒ 抛错，不猜。 */
function readFallbackFlag(env: NodeJS.ProcessEnv): Flag {
  const raw = env[AUTH_DEVICE_ID_FALLBACK_ENV]
  if (raw === undefined || raw.trim() === '') return 'on'
  const value = raw.trim()
  if (value === '1') return 'on'
  if (value === '0') return 'off'
  throw new AuthBootConfigError(
    `${AUTH_DEVICE_ID_FALLBACK_ENV} 只能是 "0" 或 "1"，现在是 ${JSON.stringify(value)}。` +
      '★ 不猜它的意思：这个开关打开时，`x-kp-device-id` 会被当成凭据（生产即提权后门）—— ' +
      '而猜错的方向决定它是"洞"还是"故障"，两者都不能靠运气。'
  )
}

/**
 * 双读期是否允许"只带 `x-kp-device-id`"的旧路径。
 *
 * ★ 生产恒 `false`（先判环境，再读开关）—— 即使有人把 `AUTH_DEVICE_ID_FALLBACK`
 *   设成 `1`，本函数也不会放行；那种配置会在 `assertAuthBootConfig()` 里**直接崩**。
 */
export function deviceIdFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProduction(env)) return false
  return readFallbackFlag(env) === 'on'
}

/**
 * 启动自检（`main.ts` 第一行、以及 `test/auth-boot-config.test.ts`）。
 *
 * 只做**会成为洞**的检查：
 *   · 生产 + 旁路打开 ⇒ 抛错（`40` §9.4 第 2 条）；
 *   · 开关值拼错 ⇒ 抛错（上面 `readFallbackFlag`）。
 * 不检查"生产有没有配微信凭据"：那会让"没配 secret 的预发环境"起不来，
 * 而它的正确表现是请求时 503 `WECHAT_NOT_CONFIGURED`（可观测、不影响其它端点）。
 */
export function assertAuthBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  const flag = readFallbackFlag(env)
  if (isProduction(env) && flag === 'on') {
    throw new AuthBootConfigError(
      '生产环境禁止 AUTH_DEVICE_ID_FALLBACK=1：`x-kp-device-id` 是客户端自报的**设备标识**，' +
        '把它当凭据等于"任何人改一个请求头就能以别人的身份操作"（`40` §9.2）。' +
        '要临时排查请用非生产环境；生产只有 Bearer token 一条路。'
    )
  }
}
