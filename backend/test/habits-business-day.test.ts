/**
 * habits-business-day.test.ts —— 业务日边界（W4-D）
 *
 * 每日上限是家长看得见的承诺；边界算错不会报错，只会**默默多给/少给一次**。
 * 这里用精确到毫秒的 UTC 瞬间钉住北京时间的两侧：
 *   2026-10-18T15:59:59.999Z = 北京时间 10-18 23:59:59.999
 *   2026-10-18T16:00:00.000Z = 北京时间 10-19 00:00:00.000
 * 这正是「UTC 日」与「家里墙上的日」分道扬镳的那一秒。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  businessDayOf,
  DEFAULT_BUSINESS_TIME_ZONE,
  resolveBusinessTimeZone
} from '../src/habits/business-day'

describe('businessDayOf —— Asia/Shanghai（默认）', () => {
  it('默认时区就是 Asia/Shanghai（不是 UTC）', () => {
    assert.equal(DEFAULT_BUSINESS_TIME_ZONE, 'Asia/Shanghai')
  })

  it('UTC 15:59:59.999 仍属于 10-18；UTC 16:00:00.000 已进入 10-19', () => {
    const before = businessDayOf(new Date('2026-10-18T15:59:59.999Z'))
    const after = businessDayOf(new Date('2026-10-18T16:00:00.000Z'))

    assert.equal(before.day, '2026-10-18')
    assert.equal(after.day, '2026-10-19')
    assert.equal(before.end.getTime(), after.start.getTime())
  })

  it('[start, end) 正好是北京时间当天 00:00 → 次日 00:00（UTC 16:00）', () => {
    const day = businessDayOf(new Date('2026-10-19T03:04:05.000Z'))
    assert.equal(day.start.toISOString(), '2026-10-18T16:00:00.000Z')
    assert.equal(day.end.toISOString(), '2026-10-19T16:00:00.000Z')
    assert.equal(day.end.getTime() - day.start.getTime(), 24 * 60 * 60 * 1000)
    assert.equal(day.timeZone, 'Asia/Shanghai')
  })

  it('左闭右开：start 属于当天，end 属于次日', () => {
    const day = businessDayOf(new Date('2026-10-19T03:04:05.000Z'))
    assert.equal(businessDayOf(day.start).day, '2026-10-19')
    assert.equal(businessDayOf(day.end).day, '2026-10-20')
  })

  it('非法 Date ⇒ RangeError（绝不按“现在”兜底）', () => {
    assert.throws(() => businessDayOf(new Date('nope')), RangeError)
    assert.throws(() => businessDayOf(new Date(NaN)), RangeError)
  })
})

describe('businessDayOf —— 可配置时区', () => {
  it('UTC 时区：瞬间与日历日一一对应，start 就是当天 00:00Z', () => {
    const day = businessDayOf(new Date('2026-10-19T23:30:00.000Z'), 'UTC')
    assert.equal(day.day, '2026-10-19')
    assert.equal(day.start.toISOString(), '2026-10-19T00:00:00.000Z')
    assert.equal(day.end.toISOString(), '2026-10-20T00:00:00.000Z')
  })

  it('America/New_York：夏令时当天跨度 23 小时也不会被自检拦下', () => {
    // 2026-03-08 02:00 美东进入夏令时（当天只有 23 小时）。
    const day = businessDayOf(new Date('2026-03-08T17:00:00.000Z'), 'America/New_York')
    assert.equal(day.day, '2026-03-08')
    assert.equal(day.end.getTime() - day.start.getTime(), 23 * 60 * 60 * 1000)
  })

  it('未知时区 ⇒ RangeError（不是悄悄退回 UTC）', () => {
    assert.throws(() => businessDayOf(new Date(), 'Mars/Olympus'), RangeError)
  })
})

describe('resolveBusinessTimeZone —— 装配期校验', () => {
  it('未设置 / 空白 ⇒ 默认 Asia/Shanghai', () => {
    assert.equal(resolveBusinessTimeZone(undefined), 'Asia/Shanghai')
    assert.equal(resolveBusinessTimeZone('   '), 'Asia/Shanghai')
  })

  it('合法 IANA 名称原样返回（去掉首尾空白）', () => {
    assert.equal(resolveBusinessTimeZone(' UTC '), 'UTC')
    assert.equal(resolveBusinessTimeZone('America/New_York'), 'America/New_York')
  })

  it('非法 IANA 名称 ⇒ 立刻抛错（启动失败，而不是第一笔打卡时才发现）', () => {
    assert.throws(() => resolveBusinessTimeZone('Asia/Shanghia'), RangeError)
  })
})
