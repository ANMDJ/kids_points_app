import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import type { RecordCategory } from '@prisma/client'

import { toHomeResponse, toRecordsResponse, type HomeResponse, type RecordsResponse } from './read.mapper'
import { READ_REPOSITORY, type ReadPort } from './read.repository'

/**
 * 只读端点的业务层（W4-A）。
 *
 * 它只做三件事：调端口 → 把「查不到孩子」翻成 404 → 把行映射成响应契约。
 * **没有**角色判断、**没有**展示串拼接 —— 那两件事分别属于 HTTP 屏障与客户端派生。
 */
@Injectable()
export class ReadService {
  constructor(@Inject(READ_REPOSITORY) private readonly port: ReadPort) {}

  async home(childId: string): Promise<HomeResponse> {
    const row = await this.port.loadHome(childId)
    if (row === null) throw childNotFound(childId)
    return toHomeResponse(row)
  }

  async records(
    childId: string,
    category: RecordCategory | undefined,
    limit: number
  ): Promise<RecordsResponse> {
    const page = await this.port.listRecords({ childId, category, limit })
    // ★ 与 /home 同一条兜底：孩子已软删时**两个端点都答 404**。
    //   若这里返回空页，客户端会显示「还没有任何记录」—— 又一个「把失败装成正常」。
    if (page === null) throw childNotFound(childId)
    return toRecordsResponse(page, limit)
  }
}

/** 孩子不存在 / 已软删 —— 两个读端点共用的 404 形状（code 必须一致）。 */
function childNotFound(childId: string): NotFoundException {
  return new NotFoundException({
    code: 'CHILD_NOT_FOUND',
    message: `孩子 ${childId} 不存在或已删除 —— 没有可读取的数据。`
  })
}
