import { BadRequestException, Inject, Injectable } from '@nestjs/common'

import type { DeletionOperator, DeletionPort, FamilyDeletionState } from './deletion.repository'
import { DELETION_REPOSITORY } from './deletion.repository'
import type { RequestDeletionDto } from './dto/request-deletion.dto'

/**
 * 家庭数据删除的**业务层**（W7-D，2026-10-27）。
 *
 * ── 这一层只做两件事 ────────────────────────────────────────────────────────
 *   ① **二次确认的守门**：`POST /family-deletion` 必须显式带 `confirmed: true`。
 *      缺了就是 400 —— 不能把「没带字段」读成「用户同意删」。这与 W7-A
 *      `accepted: true` 同一口径：**同意/确认必须是显式的布尔真值**。
 *   ② **注入时钟**：`new Date()` 只出现在这里（以及控制器读状态时），
 *      让仓储与策略保持「不读时钟」的可测形状。
 *
 * 冷却期的存在感不在这层：它是 `scheduledFor` 这个落库时刻与 worker 的事。
 * 本层**不**提供「立即执行」的入口 —— 那会让二次确认形同虚设。
 */
@Injectable()
export class DeletionService {
  constructor(@Inject(DELETION_REPOSITORY) private readonly port: DeletionPort) {}

  async read(childId: string): Promise<FamilyDeletionState> {
    return await this.port.readState(childId, new Date())
  }

  async request(
    childId: string,
    dto: RequestDeletionDto,
    operator: DeletionOperator
  ): Promise<FamilyDeletionState> {
    // ★ 只认 `=== true`：`"true"` / `1` / 缺省一律拒绝。
    //   宽松解析会让「手滑重放一个旧请求体」变成一次删除申请。
    if (dto.confirmed !== true) {
      throw new BadRequestException({
        code: 'FAMILY_DELETION_NOT_CONFIRMED',
        message:
          '申请家庭数据删除必须显式确认（请求体 `{ "confirmed": true }`）。' +
          '删除会不可逆地匿名化整个家庭的描述性数据，不接受默认同意。'
      })
    }
    return await this.port.requestDeletion({ childId, operator, now: new Date() })
  }

  async cancel(childId: string, operator: DeletionOperator): Promise<FamilyDeletionState> {
    return await this.port.cancelDeletion({ childId, operator, now: new Date() })
  }
}
