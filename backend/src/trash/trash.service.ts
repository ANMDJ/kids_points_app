import { BadRequestException, Inject, Injectable } from '@nestjs/common'

import type { Actor } from '../permissions/actor'
import { TRASH_KINDS, type TrashKind, type TrashListResponse } from './trash.types'
import { TRASH_REPOSITORY, type TrashPort } from './trash.repository'

/** 回收站服务：只做「入参形状」与「线格式」两件事，事实判定在仓储层。 */
@Injectable()
export class TrashService {
  constructor(@Inject(TRASH_REPOSITORY) private readonly port: TrashPort) {}

  /**
   * 列出回收站。
   *
   * ★ 不在这里过滤 90 天：过期条目**仍然列出**（界面标红并只允许彻底删除）。
   *   服务端静默隐藏它们，会让家长以为"东西自己没了"，而事实是过期未清理。
   */
  async list(childId: string): Promise<TrashListResponse> {
    const rows = await this.port.listTrash(childId)
    return {
      items: rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        title: row.title,
        deletedAt: row.deletedAt.toISOString()
      }))
    }
  }

  /** 恢复一项（家长专属，见矩阵 `restore_trash_item`）。 */
  async restore(
    childId: string,
    kind: string,
    id: string,
    actor: Actor
  ): Promise<{ kind: TrashKind; id: string }> {
    return this.port.restoreTrash({
      childId,
      kind: this.parseKind(kind),
      id: this.parseId(id),
      operatorUserId: actor.userId,
      operatorRole: this.operatorRoleOf(actor)
    })
  }

  /** 彻底删除一项（家长专属，见矩阵 `purge_trash_item`）。 */
  async purge(
    childId: string,
    kind: string,
    id: string,
    actor: Actor
  ): Promise<{ kind: TrashKind; id: string }> {
    return this.port.purgeTrash({
      childId,
      kind: this.parseKind(kind),
      id: this.parseId(id),
      operatorUserId: actor.userId,
      operatorRole: this.operatorRoleOf(actor)
    })
  }

  /**
   * `:kind` 只接受三个固定值 —— 不认识的路径段**不是** 404 的借口：
   * 说明客户端拼错了地址，按 400 明确回答（否则会被当成"这条已经没了"）。
   */
  private parseKind(raw: string): TrashKind {
    const found = TRASH_KINDS.find((kind) => kind === raw)
    if (found === undefined) {
      throw new BadRequestException({
        code: 'TRASH_KIND_INVALID',
        message: `未知的回收站类型「${raw}」—— 只支持 ${TRASH_KINDS.join(' / ')}。`
      })
    }
    return found
  }

  private parseId(raw: string): string {
    const id = raw.trim()
    if (id === '' || id.length > 64) {
      throw new BadRequestException({
        code: 'TRASH_ITEM_ID_INVALID',
        message: '条目 id 必须是 1..64 字符（cuid 尺度）。'
      })
    }
    return id
  }

  /**
   * `AuditLog.actorRole` 只有 `guardian` / `child` 两列；`viewer` 走到这里是
   * 装配错误（矩阵一律 DENY，根本到不了业务层）—— 响亮失败而不是记成家长。
   */
  private operatorRoleOf(actor: Actor): 'guardian' | 'child' {
    if (actor.role !== 'guardian' && actor.role !== 'child') {
      throw new Error(
        `TrashService 收到了无法审计的角色「${actor.role}」—— 矩阵本应已拒绝这个请求。`
      )
    }
    return actor.role
  }
}
