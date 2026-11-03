import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards
} from '@nestjs/common'

import { DEVICE_ID_HEADER, DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import type { AuthOperator } from './auth.repository'
import {
  AuthService,
  type ParentModeView,
  type ParentPinVerifyView,
  type ParentPinView
} from './auth.service'
import { EnterKidModeDto } from './dto/enter-kid-mode.dto'
import { EnterParentModeDto } from './dto/enter-parent-mode.dto'
import { ExitKidModeDto } from './dto/exit-kid-mode.dto'
import { SetParentPinDto } from './dto/set-parent-pin.dto'
import { VerifyParentPinDto } from './dto/verify-parent-pin.dto'

/**
 * 家长模式 / 家长 PIN 的 HTTP 入口（W8-C，2026-10-27 / `docs/design/02` §7、§9.18）。
 *
 * ── 四条路由 ────────────────────────────────────────────────────────────────
 *   `GET    /auth/parent-mode`  `switch_role_mode`  我现在是不是家长模式、还剩多少秒
 *   `POST   /auth/parent-mode`  `switch_role_mode`  用 PIN 换 5 分钟家长模式
 *   `DELETE /auth/parent-mode`  `switch_role_mode`  主动退出（不需要 PIN）
 *   `POST   /auth/parent-pin`   `manage_parent_pin` 首次设置 / 修改家长 PIN
 *   `POST   /auth/parent-pin/verify` `switch_role_mode` 只校验 PIN，不改角色（2026-11-04，
 *      App 本机 PIN 锁：解锁不能顺手把 30 天家长会话压成 5 分钟）
 *
 * ── W14（2026-11-03）新增孩子模式的两条 ─────────────────────────────────────
 *   `POST   /auth/kid-mode`     `switch_role_mode`  把手机交给孩子用 1–30 分钟
 *   `DELETE /auth/kid-mode`     `switch_role_mode`  用家长 PIN 收回（到期也要收）
 *
 *   为什么挂在**同一个控制器**：它们改的是同一行 `DeviceSession`
 *   （`activeRole` / `expiresAt` / `kidModeUntil`），共用 `this.load()` 的
 *   409 语义与同一套 PIN 校验；拆成两个控制器会把"这台设备现在是什么模式"
 *   这件事切成两个互不知道的端点。
 *
 *   为什么 `DELETE` 带请求体：收回要 PIN。`DELETE /auth/parent-mode` 不带体
 *   是因为退出是降级（不需要凭据）；这里方向相反，凭据必须进请求体
 *   （绝不进 URL —— 那会出现在访问日志里）。
 *
 * ── 为什么是四条而不是 `02` §7 表格里的"一条切换" ───────────────────────────
 *   · `GET`：客户端要显示「还剩 4:57」。没有它，App 重启后就**不知道**自己还在不在
 *     家长模式 —— 只能靠本地计时器猜，而本地计时器在后台挂起 / 改系统时间后全是错的。
 *   · `DELETE`：5 分钟的 TTL 是**上限**，不是承诺。家长把手机递回给孩子时需要一个
 *     "现在就退出"的动作；否则孩子手里还有最多 4 分多钟的家长窗口，而界面上的倒计时
 *     不会拦住他。
 *   · `POST /auth/parent-pin`：`02` §7 要求"切 guardian / 改 PIN"，而改 PIN 在矩阵里
 *     是**另一个**动作（`manage_parent_pin`，guardian 专属）—— 它不能靠
 *     `switch_role_mode` 混过去（那对孩子是 ALLOW，见 `permission-matrix.ts` 的注释）。
 *
 * ── 为什么**不**挂 `ConsentGuard`（与 onboarding / members 不同）──────────────
 *   `switch_role_mode` 与 `manage_parent_pin` 在 `contracts/consent-policy.ts` 里
 *   **都是豁免动作**（⑤ / ⑥）：切家长模式不写儿童数据，而 PIN 是家长自己的凭据。
 *   更关键的是方向：撤回同意后家长**必须仍能进入家长模式**，否则"重新同意"这个
 *   动作（guardian 专属、需要家长模式）就永远做不到了 —— 那是死锁，
 *   而豁免是它的解药（`06` §3 D3 的原文理由）。
 *   挂一个对这四个 action 全部放行的 Guard 只会让读者以为这里有闸门。
 *
 * ── 为什么 `POST` 回 200 而不是 201 ─────────────────────────────────────────
 *   没有任何"资源"被创建：改的是这台设备**已有**的会话行。201 会暗示
 *   "又多了一个会话"，而库里的行数根本没变。
 */
@Controller('auth')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Get('parent-mode')
  @RequireAction('switch_role_mode')
  async readMode(
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<ParentModeView> {
    return await this.service.readMode(this.childIdOf(req), this.deviceIdOf(deviceId), this.actorOf(req))
  }

  @Post('parent-mode')
  @HttpCode(200)
  @RequireAction('switch_role_mode')
  async enterParentMode(
    @Body() dto: EnterParentModeDto,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<ParentModeView> {
    return await this.service.enterParentMode(
      this.childIdOf(req),
      this.deviceIdOf(deviceId),
      dto,
      this.actorOf(req)
    )
  }

  @Delete('parent-mode')
  @HttpCode(200)
  @RequireAction('switch_role_mode')
  async exitParentMode(
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<ParentModeView> {
    return await this.service.exitParentMode(
      this.childIdOf(req),
      this.deviceIdOf(deviceId),
      this.actorOf(req)
    )
  }

  @Post('parent-pin')
  @HttpCode(200)
  @RequireAction('manage_parent_pin')
  async setParentPin(
    @Body() dto: SetParentPinDto,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<ParentPinView> {
    return await this.service.setParentPin(
      this.childIdOf(req),
      this.deviceIdOf(deviceId),
      dto,
      this.actorOf(req)
    )
  }

  /**
   * 只校验家长 PIN，不改变角色 / TTL（2026-11-04，App 本机 PIN 锁）。
   *
   * ★ 权限用 `switch_role_mode` 而不是 `manage_parent_pin`：
   *   它不设置 / 不修改任何东西，只回答「这个 PIN 对不对」——
   *   与「按一下家长模式按钮」是同一类动作（矩阵对孩子也 ALLOW）。
   *   用 `manage_parent_pin`（孩子 DENY）会让锁屏在**孩子模式进行中**
   *   解不开，而那正是最需要解锁的时刻。
   */
  @Post('parent-pin/verify')
  @HttpCode(200)
  @RequireAction('switch_role_mode')
  async verifyParentPin(
    @Body() dto: VerifyParentPinDto,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<ParentPinVerifyView> {
    return await this.service.verifyParentPin(
      this.childIdOf(req),
      this.deviceIdOf(deviceId),
      dto,
      this.actorOf(req)
    )
  }

  /**
   * 开孩子模式（W14）：家长在**家长模式**下把手机交给孩子用 1–30 分钟。
   *
   * ★ 权限用的是 `switch_role_mode` 而不是新动作：矩阵对这一条给 child 也
   *   ALLOW（孩子必须能把手机递给家长输 PIN）。真正的门在业务层 ——
   *   `enterKidMode` 要求**当前角色是 guardian**，孩子自己调只会拿到 403
   *   `KID_MODE_REQUIRES_PARENT_MODE`。改矩阵要多一份 contracts + 三端同步，
   *   而这里没有任何新的"谁能做"语义。
   */
  @Post('kid-mode')
  @HttpCode(200)
  @RequireAction('switch_role_mode')
  async enterKidMode(
    @Body() dto: EnterKidModeDto,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<ParentModeView> {
    return await this.service.enterKidMode(
      this.childIdOf(req),
      this.deviceIdOf(deviceId),
      dto,
      this.actorOf(req)
    )
  }

  /**
   * 用家长 PIN 收回孩子模式（W14）—— **到期后也走这一条**（A 方案）。
   *
   * 200 而不是 204：回包是"收回之后的模式现状"，界面直接拿它刷新倒计时
   * （与 `DELETE /auth/parent-mode` 同一个形状、同一份 DTO）。
   */
  @Delete('kid-mode')
  @HttpCode(200)
  @RequireAction('switch_role_mode')
  async exitKidMode(
    @Body() dto: ExitKidModeDto,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<ParentModeView> {
    return await this.service.exitKidMode(
      this.childIdOf(req),
      this.deviceIdOf(deviceId),
      dto,
      this.actorOf(req)
    )
  }


  /** Guard 已保证 `kpActor` 存在；断言只为编译期收窄（缺失 = 装配错误）。 */
  private actorOf(req: RequestWithActor): AuthOperator {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error('AuthController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）')
    }
    // 矩阵里 viewer **没有列** ⇒ 一律 DENY，`PermissionsGuard` 会先拦掉。
    // 这里再挡一次是防御纵深：真走到这儿说明 Guard 被摘掉了，不能默默当成 child。
    if (actor.role === 'viewer') {
      throw new ForbiddenException({
        code: 'AUTH_ACTOR_ROLE_INVALID',
        message: '只读分享成员不能切换家长模式，也不能设置家长 PIN。'
      })
    }
    return { userId: actor.userId, role: actor.role }
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过；绝不从请求体 / 路径取。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error('AuthController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）')
    }
    return req.kpChildId
  }

  /**
   * 设备 id：**必需**（不是"有就用"）。
   *
   * 与 `members.controller.ts` 不同 —— 那里的 deviceId 只进审计，缺了留 null；
   * 这里它是 `DeviceSession` 的**复合主键一半**，没有它就没有"哪一行"可写。
   * 身份 Guard 已经先挡过缺失（401），所以能到这里的缺失只可能是装配漏了 Guard。
   */
  private deviceIdOf(deviceId: string | undefined): string {
    if (typeof deviceId !== 'string' || deviceId.trim() === '') {
      throw new Error(
        `AuthController 缺少 ${DEVICE_ID_HEADER}：身份 Guard 应已保证它存在（装配错误）`
      )
    }
    return deviceId.trim()
  }
}
