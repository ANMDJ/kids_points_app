import { Inject, Injectable, NotFoundException } from '@nestjs/common'

import { buildExportDocument, type ExportDocument } from './export.document'
import { EXPORT_LIMITS, EXPORT_REPOSITORY, type ExportPort } from './export.repository'

/**
 * 家庭数据导出的业务层（W7-C，2026-10-27）。
 *
 * 只做三件事：调端口 → 把「查不到孩子」翻成 404 → 拼成导出文件。
 * **没有**角色判断（那是 `PermissionsGuard` + 矩阵的 `export_family_data`）、
 * **没有** consent 判断（导出在豁免集合里，撤回同意后仍然可用）。
 *
 * ── 为什么不写审计 ──────────────────────────────────────────────────────────
 *   导出是**读**；按 02 §5 的口径读路径不写审计（否则每次刷新首页都会写一行）。
 *   真正需要留痕的是「谁改了什么」，而导出本身不改变任何一行。
 *   若将来合规要求「导出行为留痕」，那应当是一条独立的 `data.export` 审计，
 *   且必须由产品 / 法务决定保留期 —— 不在这里顺手加。
 */
@Injectable()
export class ExportService {
  constructor(@Inject(EXPORT_REPOSITORY) private readonly port: ExportPort) {}

  async family(childId: string): Promise<ExportDocument> {
    const snapshot = await this.port.collect(childId, EXPORT_LIMITS)
    // ★ 与 `ReadService` 同一条兜底：孩子已软删 ⇒ 404，**不是**空文档。
    //   空文档会被家长当成「孩子的数据都没了」，而真实原因是档案已被删。
    if (snapshot === null) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: `孩子 ${childId} 不存在或已删除 —— 没有可导出的数据。`
      })
    }
    return buildExportDocument(snapshot, new Date())
  }
}
