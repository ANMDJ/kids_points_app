/**
 * wish-cover-style.test.ts —— 心愿配色的**唯一算法**（W5-B，2026-10-20 / 修 03 E16）
 *
 * 被钉住的四条性质：
 *   ① 有空格 ⇒ 取**第一个**空档（新增不与既有活动心愿撞色）；
 *   ② 四个占满 ⇒ 按 `id` 哈希取值（允许撞色，但**永不漂移**）；
 *   ③ 结果**与列表长度 / 插入顺序无关** —— 删掉中间一个心愿，既有的不会变色；
 *   ④ 同一 `id` 反复算 ⇒ 同一结果（客户端重绘、服务端重算必须一致）。
 *
 * ★ 回归靶子是旧实现 `backgroundIndex = wishes.length % 4`：
 *   `taken = [A, C, D]`（中间删了 B）时，旧算式给出 `3 % 4 = D` —— 与既有心愿撞色。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { WishCoverStyle } from '@prisma/client'

import {
  pickCoverStyle,
  WISH_COVER_STYLES,
  wishCoverHash
} from '../src/contracts/wish-cover-style'

/** 少打字：把字面量收窄成 `WishCoverStyle`（否则 TS 认为是 `string[]`，正是要防的漂移）。 */
function styles(...values: WishCoverStyle[]): WishCoverStyle[] {
  return values
}

describe('pickCoverStyle：空档优先', () => {
  it('没有心愿 ⇒ A', () => {
    assert.equal(pickCoverStyle([], 'wish-1'), 'A')
  })

  it('A 已占 ⇒ B；A/B 已占 ⇒ C；A/B/C 已占 ⇒ D', () => {
    assert.equal(pickCoverStyle(styles('A'), 'wish-2'), 'B')
    assert.equal(pickCoverStyle(styles('A', 'B'), 'wish-3'), 'C')
    assert.equal(pickCoverStyle(styles('A', 'B', 'C'), 'wish-4'), 'D')
  })

  it('回归：taken=[A,C,D]（中间删了 B）⇒ 补空档 B，而不是 length % 4 = D', () => {
    const style = pickCoverStyle(styles('A', 'C', 'D'), 'wish-5')
    assert.equal(style, 'B')
    assert.notEqual(style, 'D', '回到了旧算法 wishes.length % 4 —— 会与既有心愿撞色')
  })

  it('空档优先于哈希：只剩 A 空着时，哪怕哈希指向 D 也返回 A', () => {
    // `wish:hash-A` 的哈希落在下标 3（D）—— 它**不会**被采用，因为空档分支先命中。
    const id = 'wish:hash-A'
    assert.equal(WISH_COVER_STYLES[wishCoverHash(id) % WISH_COVER_STYLES.length], 'D')
    assert.equal(pickCoverStyle(styles('B', 'C', 'D'), id), 'A')
  })
})

describe('pickCoverStyle：四色占满后的稳定兜底', () => {
  const ALL = styles('A', 'B', 'C', 'D')

  it('结果等于 `WISH_COVER_STYLES[hash(id) % 4]`（与客户端同一算式）', () => {
    for (const id of ['wish-1', 'wish-2', 'cuid_like_abc123', '心愿-9']) {
      assert.equal(
        pickCoverStyle(ALL, id),
        WISH_COVER_STYLES[wishCoverHash(id) % WISH_COVER_STYLES.length]
      )
    }
  })

  it('同一 id 反复算 ⇒ 同一结果（重绘 / 重算不漂移）', () => {
    const first = pickCoverStyle(ALL, 'wish-stable')
    for (let i = 0; i < 20; i += 1) {
      assert.equal(pickCoverStyle(ALL, 'wish-stable'), first)
    }
  })

  it('结果与「谁先谁后」无关：同一个集合的不同排列给出同一答案', () => {
    const id = 'wish-order'
    assert.equal(
      pickCoverStyle(styles('A', 'B', 'C', 'D'), id),
      pickCoverStyle(styles('D', 'B', 'A', 'C'), id)
    )
  })

  it('返回值恒是四个稳定枚举之一（不会是 undefined / 空串）', () => {
    for (let i = 0; i < 50; i += 1) {
      const style = pickCoverStyle(ALL, `id-${i}`)
      assert.ok(WISH_COVER_STYLES.includes(style), `越界配色：${String(style)}`)
    }
  })
})


describe('wishCoverHash：跨端同源的形状', () => {
  it('恒为非负整数（三端都按 % 4 取值，负数会让下标变 undefined）', () => {
    for (const id of ['', 'a', 'wish-1', '🎁', 'x'.repeat(200)]) {
      const hash = wishCoverHash(id)
      assert.ok(Number.isInteger(hash), `hash 不是整数：${hash}`)
      assert.ok(hash >= 0, `hash 为负：${hash}`)
    }
  })

  it('固定输入 ⇒ 固定输出（钉死算式，改动即失败 —— 否则三端会各算各的颜色）', () => {
    // 这些值是**锁定值**：Flutter / Taro 的同一算式必须算出同样的数字。
    assert.equal(wishCoverHash(''), 0)
    assert.equal(wishCoverHash('A'), 65)
    assert.equal(wishCoverHash('AB'), 65 * 31 + 66)
  })
})
