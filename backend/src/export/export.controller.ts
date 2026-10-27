import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import type { RequestWithActor } from '../permissions/actor'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { ExportDocument } from './export.document'
import { ExportService } from './export.service'

/**
 * 家庭数据导出 HTTP 入口（W7-C，2026-10-27）：`GET /export`。
 *
 * ── 它兑现的是哪句承诺 ──────────────────────────────────────────────────────
 *   02 §9.20 / 04 §5 的「可携带」：家长随时能把这一个孩子的全部数据带走
 *   （档案 / 成员 / 规则与版本 / 习惯 / 心愿 / 流水 / 审批 / 同意记录 / 审计）。
 *   在此之前，这些数据只存在于库里与逐屏接口里 —— 那是「能看」，不是「能带走」。
 *
 * ── 屏障与动作 ──────────────────────────────────────────────────────────────
 *   `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)` —— 与
 *   `/home` 同一顺序（身份 → 资格 → 矩阵＋收紧）。
 *   · 动作 `export_family_data`：guardian ALLOW、child DENY。
 *     ★ 为什么不复用 `view_records`：那个孩子也能用；一次导出包含全家成员
 *       与全部流水，把它挂在孩子可用的读动作上等于让「看一眼自己的分」
 *       顺带等于「批量带走全家数据」。
 *
 * ── 为什么它不受同意门（ConsentGuard）管辖 ──────────────────────────────────
 *   导出不改变任何一行，且**撤回同意后仍必须可用**：家长撤回同意后想把自己
 *   已经提供的数据取走，正是可携带权最典型的场景。若导出也要求「同意生效中」，
 *   撤回同意就等于「数据被扣住」，与 04 §5 直接冲突。
 *   这条豁免钉在 `contracts/consent-policy.ts` 的豁免集合里，并有离线断言。
 *
 * ── 响应 ────────────────────────────────────────────────────────────────────
 *   · 200 `application/json`，`Content-Disposition: attachment; filename="…"`
 *     —— 浏览器 / WebView 直接落盘成 `.json`；双端走 HTTP 时只读 body。
 *   · `Cache-Control: no-store`：这份文件含全家信息，绝不能被中间层缓存。
 *   · 401 / 403 / 404 与 `/home` 一致；501 `EXPORT_MODEL_NOT_IMPLEMENTED`
 *     仅出现在无库装配（**绝不**返回空文档冒充成功）。
 *
 * ★ 绝不从 query 取 `childId`：孩子上下文只能由身份 Guard 填入，且屏障一
 *   已经对着它查过成员位 —— 否则等于让客户端指定导谁的数据。
 */
@Controller('export')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class ExportController {
  constructor(@Inject(ExportService) private readonly service: ExportService) {}

  @Get()
  @RequireAction('export_family_data')
  async family(
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown }
  ): Promise<ExportDocument> {
    const document = await this.service.family(this.childIdOf(req))
    const day = document.generatedAt.slice(0, 10)
    // 文件名只用 ASCII：`Content-Disposition` 里的非 ASCII 需要 RFC 5987 编码，
    // 而孩子昵称恰恰常常是中文 —— 用 `childId` 保证跨平台不出现乱码文件名。
    res.setHeader('Content-Disposition', `attachment; filename="family-export-${document.child.id}-${day}.json"`)
    res.setHeader('Cache-Control', 'no-store')
    return document
  }

  /** 孩子上下文由身份 Guard 填入（同 `ReadController`）。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'ExportController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}
