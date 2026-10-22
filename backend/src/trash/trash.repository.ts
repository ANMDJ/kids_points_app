import { Injectable, NotImplementedException } from '@nestjs/common'

import type { TrashItemRow, TrashKind } from './trash.types'

/** Nest 注入令牌（与仓库其它端口一致，用唯一 symbol 防撞名）。 */
export const TRASH_REPOSITORY = Symbol('TRASH_REPOSITORY')

/**
 * 回收站仓储的**唯一契约**（W5-F，2026-10-21）。
 *
 * 三个动作正好对应三条权限：
 *   · `listTrash`    → `view_trash`
 *   · `restoreTrash` → `restore_trash_item`
 *   · `purgeTrash`   → `purge_trash_item`
 * 权限判定不在这里（屏障二已做），这里只回答「库里到底发生了什么」。
 */

/** 指向回收站里某一项的入参。 */
export interface TrashTargetInput {
  childId: string
  kind: TrashKind
  id: string
  operatorUserId: string
  operatorRole: 'guardian' | 'child'
}

export interface TrashPort {
  /**
   * 列出某个孩子回收站里的条目（三类合并、按删除时间倒序）。
   *
   * ★ 只列 `status='deleted'` 的行 —— 回收站不是「全部配置」的另一个视图。
   */
  listTrash(childId: string): Promise<TrashItemRow[]>

  /**
   * 恢复一项（`status` 回到 `active`、`deletedAt` 清空）。
   *
   * 失败语义：
   *   · 404 `TRASH_ITEM_NOT_FOUND`（不存在 / 不属于这个孩子 / 已被彻底删除）；
   *   · 409 `TRASH_PARENT_RULE_DELETED`（习惯的来源规则还在回收站里）；
   *   · 幂等：本来就没删 ⇒ 原样返回，不写第二条审计。
   */
  restoreTrash(input: TrashTargetInput): Promise<{ kind: TrashKind; id: string }>

  /**
   * **彻底**删除一项（不可恢复）。
   *
   * 失败语义：
   *   · 404 `TRASH_ITEM_NOT_FOUND`；
   *   · 409 `TRASH_ITEM_NOT_DELETED`（还在用，必须先软删 —— 屏障在前，避免误删）；
   *   · 409 `TRASH_ITEM_REFERENCED`（还有流水指着它，删了会让历史对不上账）。
   */
  purgeTrash(input: TrashTargetInput): Promise<{ kind: TrashKind; id: string }>
}

/**
 * 无库装配的默认实现：三个方法**全部 501**。
 * ★ 绝不返回空列表冒充"回收站是空的" —— 那会让家长以为"东西真的没了"。
 */
@Injectable()
export class NotImplementedTrashRepository implements TrashPort {
  async listTrash(): Promise<TrashItemRow[]> {
    throw new NotImplementedException({
      code: 'TRASH_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '回收站读取尚未接线（无数据库装配）—— 拒绝返回空列表：' +
        '那会被误读成"删掉的东西已经不在了"。请配置 DATABASE_URL 后重启。'
    })
  }

  async restoreTrash(): Promise<{ kind: TrashKind; id: string }> {
    throw new NotImplementedException({
      code: 'TRASH_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '恢复尚未接线（无数据库装配）—— 拒绝假装成功：清单上会多出一张库里并不存在的卡。' +
        '请配置 DATABASE_URL 后重启。'
    })
  }

  async purgeTrash(): Promise<{ kind: TrashKind; id: string }> {
    throw new NotImplementedException({
      code: 'TRASH_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '彻底删除尚未接线（无数据库装配）—— 拒绝假装成功：界面说删了，库里还在。' +
        '请配置 DATABASE_URL 后重启。'
    })
  }
}
