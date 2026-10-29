/**
 * 运行期**登录凭据持有者**（W9-A / `40` §10.1）。
 *
 * ── 它解决的是一条具体的死路 ────────────────────────────────────────────────
 *   四个 HTTP 客户端（`read_api` / `write_api` / `parent_mode` / `onboarding`）
 *   都在 `AppStore` 构造时一次性建好，而 token 是**运行期**才有的东西
 *   （`wx.login()` → `POST /auth/login` 之后）。若把 token 做成
 *   `ReadApiConfig` 的构造参数，登录成功就得重建四个客户端 + 换掉 store 里
 *   所有引用 —— 那是"为了一个字符串重装一遍应用"。
 *
 * ── 为什么放进**独立文件**（而不是塞进 `auth_session.ts`）────────────────────
 *   `auth_session.ts` 需要 `auth_api.ts`，`auth_api.ts` 需要 `read_api.ts`
 *   的常量；若 `read_api.ts` 反过来 import `auth_session.ts`，就是循环依赖。
 *   这个文件**只依赖类型系统**，谁都可以 import。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 *   ① **不落盘**：落盘是 `AuthTokenStore` 的事（`kp_token`）。这里是"这次运行
 *      用哪个 token"，冷启动时由登录编排从 storage 灌回来。
 *   ② **不进日志 / 不进异常 detail**（`40` §11.2）：`toString()` 特意不输出 token。
 *      任何把它拼进错误信息、上报给监控的写法都是泄漏。
 *   ③ **空串不是"没有 token"**：空串是编程错误（`set('')` 直接抛），因为
 *      `Authorization: Bearer ` 这种半截头会把 401 伪装成"token 无效"。
 */

/** 后端 `AuthGuard` 读的头名（`backend/src/identity/auth.guard.ts`）。 */
export const kAuthorizationHeader = 'Authorization'

/** Bearer 方案（大小写不敏感，但本客户端只发这一种）。 */
export const kBearerPrefix = 'Bearer '

/**
 * 凭据持有者。
 *
 * `set()` / `clear()` 是**同步**的：调用它的一定是登录编排里的同一段 await 链，
 * 中间不存在"并发两个登录"的窗口（登录是用户手势触发的串行动作）。
 */
export class AuthTokenHolder {
  private token: string | null = null

  /** 当前 token；没有就是 null —— 调用方据此决定**要不要**发 Authorization。 */
  current(): string | null {
    return this.token
  }

  has(): boolean {
    return this.token !== null
  }

  /**
   * 装入一条**已从服务端拿到的** token。
   *
   * 只做两件校验，且都是"不装就会出事"的：非空、无空白。
   * 不校验长度 / 字符集：形状由服务端签发（`auth-session.gate.ts`），
   * 客户端再验一遍只会制造第二份真相。
   */
  set(raw: string): void {
    const token = typeof raw === 'string' ? raw.trim() : ''
    if (token === '') {
      throw new Error('token 不能为空：没有凭据时请用 clear()。')
    }
    if (/\s/.test(token)) {
      // 空白字符会让 `Authorization: Bearer <token>` 被中间层截断/判定非法。
      throw new Error('token 里不能有空白字符（那样拼出来的 Authorization 头会被拒绝）。')
    }
    this.token = token
  }

  /** 清空（登出 / `TOKEN_INVALID` / 换账号）。幂等。 */
  clear(): void {
    this.token = null
  }

  /** 拼好的 Authorization 头值；没有 token 时返回 null。 */
  authorizationHeader(): string | null {
    return this.token === null ? null : `${kBearerPrefix}${this.token}`
  }

  /** ★ 故意**不**输出 token：这个对象会出现在日志/调试器/崩溃报告里。 */
  toString(): string {
    return this.token === null ? 'AuthTokenHolder(<empty>)' : 'AuthTokenHolder(<set>)'
  }
}

/**
 * 全进程唯一的那一个（模块级单例）。
 *
 * 为什么允许单例：小程序没有多用户切换（一台设备一个微信），而"两个页面各自
 * 持有一份 token"正是会话固定和"退出后还能点"的来源。测试里可直接
 * `sharedAuthTokens.clear()` 复位，不必重建整个模块。
 */
export const sharedAuthTokens = new AuthTokenHolder()
