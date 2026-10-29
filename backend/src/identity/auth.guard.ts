import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import type { RequestWithActor } from '../permissions/actor'
import { deviceIdFallbackEnabled } from './auth-config'
import {
  AuthSessionShapeError,
  hashToken,
  readBearerToken,
  resolveAuthSession,
  type AuthMethod
} from './auth-session.gate'
import { AUTH_SESSION_REPOSITORY, type AuthSessionPort } from './auth-session.repository'
import { IS_PUBLIC_KEY } from './public.decorator'

/**
 * **认证守卫**（W9-A，2026-10-29 / `40` §9.1–§9.3）—— 第 0 位，全链最先跑。
 *
 * ```
 * AuthGuard → DeviceSessionGuard → MembershipGuard → PermissionsGuard → ConsentGuard
 * ```
 *
 * ── ★ 为什么它可以（也必须）注册成 `APP_GUARD`，而另外三道不可以 ─────────────
 *   另外三道都是**授权**守卫：它们需要"这个人是谁"作为输入（`kpActor`），
 *   顺序由控制器上的 `@UseGuards(...)` 决定。`permissions.guard.ts` 明确写过
 *   "不能注册成 APP_GUARD"，因为全局守卫会在 `@UseGuards` 的**前面**运行 ——
 *   对授权守卫来说那就是"在拿到身份之前判权限"。
 *   本守卫是**认证**守卫：它**产出**身份、不消费身份，所以必须排在最前；
 *   而 `APP_GUARD` 正好由 Nest 在控制器级守卫之前执行（同一个 `ExecutionContext`，
 *   全局 → 控制器 → 路由）。⇒ 全局注册**修正**了顺序，而不是破坏它。
 *
 * ── 四种 401 必须能被客户端区分（§9.3 的表）──────────────────────────────────
 *   `UNAUTHENTICATED`   没有 Authorization（≠ "token 不对"：前者是"没登"，后者是"掉登"）
 *   `TOKEN_INVALID`     形状不对 / 查不到 / 已撤销 ⇒ 清 token，进登录页
 *   `TOKEN_EXPIRED`     到期 ⇒ **静默重登一次**再重放原请求（只一次）
 *   以及 500 `SESSION_SHAPE_INVALID`：身份行的形状坏了（`method` 不在白名单、
 *   时间戳解析不出、适配器查错键）。**它不是权限问题**，报成 401 会让用户
 *   反复重新登录，而病在数据。
 *
 * ── 双读期（`40` §12.2）────────────────────────────────────────────────────
 *   没有 `Authorization` 时：非生产且 `AUTH_DEVICE_ID_FALLBACK` 未关 ⇒ **放行**，
 *   由 `DeviceSessionGuard` 按旧路径（`x-kp-device-id`）解析。
 *   生产恒不放行（`deviceIdFallbackEnabled()` 先判环境），且生产 + 开关=1 会在
 *   `assertAuthBootConfig()` 里**启动即崩**。
 *   ★ 带 token 的请求**永不**回落到旧路径：token 说你是谁，就以它为准；
 *     回落的唯一后果是"拿一个坏 token 也能用设备 id 进来"。
 *
 * ── `lastSeenAt` 的更新是**异步**的 ──────────────────────────────────────────
 *   每个请求 +1 次 UPDATE 不值得进关键路径（登录后第一次请求会明显变慢）。
 *   失败也不影响判定（它不参与过期计算），故 `void ... .catch()`：
 *   **吞掉写失败，但不吞掉判定失败**。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name)

  constructor(
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionPort,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass()
      ]) === true
    if (isPublic) return true

    const request = context.switchToHttp().getRequest<RequestWithActor>()

    // ★ 已经解析过就直接放行：本守卫**同时**以 `APP_GUARD`（全局）和
    //   `@UseGuards(AuthGuard)`（路由级，见 `identity.controller.ts`）存在，
    //   两处都会跑。没有这一行就会**每个请求查两次** `AuthSession`。
    //   （只读一个属性，代价 0；而且它不让任何判定变宽松 —— `kpAuth` 只有这里会写。）
    if (request.kpAuth !== undefined) return true

    const bearer = readBearerToken(request.headers['authorization'])

    if (bearer.kind === 'MISSING') {
      if (deviceIdFallbackEnabled()) {
        // 双读期旧路径：**不写** kpAuth，让 DeviceSessionGuard 知道"没有登录身份"。
        return true
      }
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: '这个请求没有携带登录凭据（Authorization: Bearer <token>）。请先登录。'
      })
    }

    if (bearer.kind === 'MALFORMED') {
      throw new UnauthorizedException({
        code: 'TOKEN_INVALID',
        message: `登录凭据无法解析：${bearer.reason}。请清掉本地 token 后重新登录。`
      })
    }

    const tokenHash = hashToken(bearer.token)
    const now = new Date()

    try {
      const row = await this.sessions.findByTokenHash(tokenHash)
      const verdict = resolveAuthSession(row, tokenHash, now)

      if (verdict.kind === 'DENY') {
        throw new UnauthorizedException({
          code: verdict.code,
          message:
            verdict.code === 'TOKEN_EXPIRED'
              ? '登录已过期（认证会话有效期 7 天，不因使用而延长）。请重新登录后重试。'
              : '登录凭据无效或已被撤销。请清掉本地 token 后重新登录。'
        })
      }

      // ★ 这里的两个 `as`/`new Date()` 都**不做判定**：
      //   `resolveAuthSession()` 已经校验过 method 在白名单内、expiresAt 可解析
      //   （否则上面就抛 500 了）。此处只是把"已校验"的事实变成类型。
      request.kpAuth = {
        userId: verdict.row.userId,
        sessionId: verdict.row.id,
        tokenHash,
        method: verdict.row.method as AuthMethod,
        expiresAt: new Date(verdict.row.expiresAt)
      }

      void this.sessions.touch(tokenHash, now).catch((error: unknown) => {
        this.logger.warn(
          `lastSeenAt 更新失败（不影响判定）：${error instanceof Error ? error.message : String(error)}`
        )
      })

      return true
    } catch (error) {
      if (error instanceof AuthSessionShapeError) {
        // ★ 500：这是数据/实现问题，不是权限问题（§9.3 最后一行）。
        this.logger.error(`认证会话形状错误 [${error.code}]：${error.message}`)
        throw new InternalServerErrorException({
          code: 'SESSION_SHAPE_INVALID',
          detail: error.code,
          message:
            '服务端的认证会话数据形状不对，已拒绝本次请求。' +
            '★ 这不是"你掉线了"：重新登录不会修好它 —— 请把它报给开发者（日志里有 detail）。'
        })
      }
      throw error
    }
  }
}
