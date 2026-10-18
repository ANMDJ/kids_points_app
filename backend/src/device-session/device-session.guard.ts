import {
  Inject,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext
} from '@nestjs/common'

import type { RequestWithActor } from '../permissions/actor'
import { DEVICE_SESSION_REPOSITORY, type DeviceSessionPort } from './device-session.repository'
import { resolveSession, SessionRowShapeError, toSessionActor } from './session.gate'

/**
 * ★ W1-C（2026-10-15）：**设备凭据**的临时替身。
 *
 * 最终设计里，客户端出示的是**登录后拿到的会话凭据**（微信 `code2session` → openId →
 * 会话 token，`02` §7 / §1）。而 L2（小程序主体认证 + 正式 AppID）**仍是阻塞项**
 * （`project.config.json` 还是 `touristappid`，见 `05` §6），登录链路今天无法落地。
 * 故此处先让客户端出示 `deviceId`，由服务端去查**这台设备在这份档案上的会话**。
 *
 * ★★ 它比 W1-A/W1-B 的三个头强在哪（**这是本阶段的全部意义**）：
 *     · 客户端**不再被允许自报角色**（`x-kp-role`）—— 角色由 `DeviceSession.activeRole` 给出；
 *     · 客户端**不再被允许自报 userId**（`x-kp-user-id`）—— 身份由会话行给出。
 *   即：**"我是谁 / 我是什么角色"从"客户端说"变成了"服务端查"。**
 *
 * ★★ 它**还没解决**什么（不许粉饰 —— 见守卫里的生产闸门）：
 *    `deviceId` 本身**没有可验证性**：谁都能报一个别人的 deviceId。
 *    所以这一层目前是「**身份由服务端确立**，但**设备凭据尚未认证**」——
 *    真正的解药是 L2 之后的会话 token（签名/一次性）。在那之前，
 *    `NODE_ENV=production` 一律 **503**，禁止这套口径上线。
 */
export const DEVICE_ID_HEADER = 'x-kp-device-id'

/**
 * 孩子上下文（W1-B 引入，W1-C 从 `temporary-role.guard.ts` 搬来）。
 *
 * 为什么必须现在就有：屏障一（成员资格门）问的是
 * `ChildMember(childId, userId).status === 'active'` —— 没有 childId，这道门**问不出问题**。
 * 它在最终设计里来自会话（`DeviceSession(deviceId, childId, …)`，`02` §7），
 * 而 `(deviceId, childId)` 恰好就是会话表的唯一键（一台设备可以对着多个孩子各有一份会话）——
 * 所以客户端这里**只是选择器**：选哪个孩子的档案，而**不是**在声明自己是谁。
 * 选择错了的后果是**查不到会话**（401），不是"换个孩子的身份"。
 */
export const CHILD_ID_HEADER = 'x-kp-child-id'

/**
 * ⚠️ 已被**废弃**、但仍被显式点名的两个头（防止有人"顺手加回来"）：
 *   `x-kp-role` / `x-kp-user-id`。
 * 它们不再被任何代码读取。**客户端送它们也不会改变任何判定** ——
 * 这条不是"忘了删"，而是本阶段的核心性质，`test/device-session-http.test.ts`
 * 有专门用例钉住（自报 `x-kp-role: guardian` 仍然只能拿到 child 权限）。
 * 若将来需要它们回来，那意味着身份又变回"客户端说了算"，必须先推翻本文件的设计。
 */

/**
 * 身份解析 —— 三道屏障的**第一个** Guard（`02` §3 的"身份"那一格，W1-C 落地）。
 *
 *     请求 → **[本 Guard：解析会话 → 填 kpActor / kpChildId]** → 屏障一 → 屏障二/三 → 业务层
 *
 * ── 它替换掉的是什么 ────────────────────────────────────────────────────
 *   `temporary-role.guard.ts`（B4 的临时物，**本阶段删除**）：角色与 userId 由客户端
 *   通过请求头自报。那个文件自己写着「W1 到位后：本文件**删除**，改用 DeviceSession
 *   解析出来的 actor」—— 本文件就是那句话的落地。
 *
 * ── 四处 fail-closed ────────────────────────────────────────────────────
 *   ① **缺 `x-kp-device-id` / `x-kp-child-id` ⇒ 401**（`UNAUTHENTICATED`）——
 *      不默认、不猜测。缺孩子上下文**绝不**退化成"跳过检查"（那会把屏障一变成可选，
 *      与 W1-B 同一条理由）。
 *   ② **会话查不到 ⇒ 401 `SESSION_NOT_FOUND`** —— 由纯内核给出（`session.gate.ts`）。
 *      ★ 这里**不是**"当作匿名 child 放行"：没有身份就没有后续三道屏障，
 *      放行等于把整条权限链变成可选。
 *   ③ **会话行形状坏（角色不在枚举内 / expiresAt 解析不出 / childId 不同源）⇒ 500** ——
 *      那是**数据/实现**问题，不是权限问题。混报成 403 会让"库里存了个非法角色"
 *      被当成"这个人没权限"排查很久（D3b 与屏障一同一条纪律）。
 *   ④ **`NODE_ENV === 'production'` ⇒ 503 `IDENTITY_NOT_IMPLEMENTED`** ——
 *      ★ 这条**故意保留**：角色/身份已经由服务端确立了，但**设备凭据仍不可验证**
 *      （`x-kp-device-id` 可以被随便伪造 ⇒ 直接冒充别人的会话）。
 *      所以"身份层已完成"这句话**现在还不能说**；能说的是"角色不再由客户端自选"。
 *      真正的解药是 L2（正式 AppID）之后的会话 token，届时应把这条闸门换成
 *      "凭据无效 ⇒ 401"，并同步改 `approvals-http.test.ts` 的那条用例。
 *
 * ── 顺序（与 02 §3 一致）────────────────────────────────────────────────
 *   Nest 的 Guard 顺序是「全局 → 控制器 → 同一层级按数组顺序」，
 *   故控制器上写 `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`。
 *   本 Guard **不能**注册成 `APP_GUARD`（那会让屏障先于身份执行，拿到空 actor —— 理由见
 *   `permissions.guard.ts` 的"顺序"一节）。
 *
 * ⚠️ 仍未落地（与"已完成"分开记）：
 *   · **会话刷新**（`02` §7「每次 guardian 操作刷新 TTL」）**未实现** —— 本 Guard **只读**；
 *     写 TTL 需要一个"抬升/刷新"的端点，那是后续阶段（`expiresAt` 目前连**写的一方**都还没有）；
 *   · **PIN 切换**（`02` §7 / §9.18「连错 5 次锁 15 分钟」）**未实现** ——
 *     没有"切到家长模式"的端点，`ChildMember.pinHash` / `pinLockedUntil` 目前无人使用；
 *   · 会话查询的**真 Prisma 适配器** ✅ 已落地（W2-D，见 `device-session.prisma.repository.ts`，
 *     由 `DeviceSessionModule.register()` 在有库时绑定）—— 但随之而来的诚实标注是：
 *     `x-kp-device-id` 仍**没有可验证性**（谁都能报别人的 deviceId），所以生产 503 那条闸门
 *     继续保留 —— **"能查库了"不等于"没人能冒充了"**。
 */
@Injectable()
export class DeviceSessionGuard implements CanActivate {
  // 显式 `@Inject`：与 `ApprovalsService` / 另两个 Guard 同一口径 ——
  // 不依赖 `emitDecoratorMetadata`（tsx / esbuild 不产出它，靠它注入会在换加载器时静默失败）。
  constructor(@Inject(DEVICE_SESSION_REPOSITORY) private readonly port: DeviceSessionPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException({
        code: 'IDENTITY_NOT_IMPLEMENTED',
        message:
          '身份层的**凭据**尚未可验证：角色的服务端确立已落地（DeviceSession），' +
          '但设备凭据（x-kp-device-id）可被伪造 —— 因此生产环境禁用这套口径（见 device-session.guard.ts）。'
      })
    }

    const req = context.switchToHttp().getRequest<RequestWithActor>()
    const deviceId = singleHeader(req, DEVICE_ID_HEADER)
    const childId = singleHeader(req, CHILD_ID_HEADER)
    if (deviceId === undefined || childId === undefined) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message:
          `缺少身份头：需要 ${DEVICE_ID_HEADER}（设备凭据）与 ${CHILD_ID_HEADER}（在哪个孩子的档案上）。` +
          '★ 与 W1-A/W1-B 不同，`x-kp-role` / `x-kp-user-id` **不再被读取** —— ' +
          '角色与身份一律由服务端会话表给出；客户端自报它们不会改变任何判定。'
      })
    }

    const now = new Date()
    const row = await this.port.findSession(deviceId, childId)

    let resolved: ReturnType<typeof toSessionActor>
    try {
      const verdict = resolveSession(row, childId, now)
      if (verdict.kind === 'DENY') {
        throw new UnauthorizedException({
          code: verdict.code,
          message:
            `设备 ${deviceId} 在孩子 ${childId} 的档案上没有有效会话 —— 没有身份，` +
            '后续三道屏障无从判定（02 §3）。★ 这里**不**默认为匿名 child：' +
            '那会把整条权限链变成可选。'
        })
      }
      resolved = toSessionActor(verdict.row, childId, now)
    } catch (err) {
      if (err instanceof SessionRowShapeError) {
        throw new InternalServerErrorException({ code: err.code, message: err.message })
      }
      throw err
    }

    // ★ 这两个字段是三道屏障的**共同输入**，且都来自服务端（不来自请求头）。
    req.kpActor = resolved.actor
    req.kpChildId = resolved.childId
    return true
  }
}

/**
 * 取单值头。**重复头（数组）一律视为未提供** —— 拼接 / 取首值都会让
 * 「客户端说自己是 A、同时又说自己是 B」这类输入产生歧义，
 * 而歧义的下一步通常是「随便挑一个」，即不可预测的权限。
 */
function singleHeader(req: RequestWithActor, name: string): string | undefined {
  const raw = req.headers[name]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}
