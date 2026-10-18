import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BadRequestException } from '@nestjs/common'

import { decodeRecordCursor, encodeRecordCursor } from '../src/read/read.cursor'

/**
 * `read-cursor.test.ts` —— `/records` 键集游标的**纯函数**用例（W4-B）。
 *
 * 为什么单独测：游标是「跨进程 / 跨版本」的字符串契约。编码与解码只要有一边
 * 宽松，翻页就会**静默**错位（重复或漏行），而 HTTP 用例只看到 200 会全绿。
 */
describe('组 A：游标往返', () => {
  it('encode → decode 原样还原 createdAt（毫秒精度）与 id', () => {
    const createdAt = new Date('2026-10-18T01:02:03.456Z')
    const cursor = encodeRecordCursor({ createdAt, id: 'rec-1' })

    assert.match(cursor, /^[A-Za-z0-9_-]+$/, '游标必须是 URL 安全的 base64url（能直接进 query）')
    assert.deepEqual(decodeRecordCursor(cursor), { createdAt, id: 'rec-1' })
  })

  it('同一毫秒的两条记录：id 不同 ⇒ 游标不同（否则第二页会重复第一页的最后一行）', () => {
    const createdAt = new Date('2026-10-18T01:02:03.000Z')
    assert.notEqual(
      encodeRecordCursor({ createdAt, id: 'rec-a' }),
      encodeRecordCursor({ createdAt, id: 'rec-b' })
    )
  })
})

describe('组 B：非法游标一律 400，绝不静默退回第一页', () => {
  const invalid: [string, string][] = [
    ['空串', ''],
    ['非 base64', 'not a cursor'],
    ['base64 但不是我们的格式', Buffer.from('hello', 'utf8').toString('base64url')],
    ['缺 id', Buffer.from('2026-10-18T01:02:03.000Z|', 'utf8').toString('base64url')],
    ['缺时间', Buffer.from('|rec-1', 'utf8').toString('base64url')],
    [
      '非法日期',
      Buffer.from('2026-13-40T00:00:00.000Z|rec-1', 'utf8').toString('base64url')
    ],
    [
      '日期不是规范 ISO（会被 Date 悄悄改写）',
      Buffer.from('2026-10-18T01:02:03Z|rec-1', 'utf8').toString('base64url')
    ],
    [
      'id 里再带分隔符',
      Buffer.from('2026-10-18T01:02:03.000Z|rec|1', 'utf8').toString('base64url')
    ],
    [
      '带 base64 填充（不是本端点签发的规范写法）',
      `${encodeRecordCursor({
        createdAt: new Date('2026-10-18T01:02:03.000Z'),
        id: 'rec-1'
      })}=`
    ],
    ['超长', 'a'.repeat(257)]
  ]

  for (const [label, cursor] of invalid) {
    it(`${label} ⇒ 400 INVALID_RECORD_CURSOR`, () => {
      assert.throws(
        () => decodeRecordCursor(cursor),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestException, `${label} 抛的不是 400`)
          assert.equal(error.getStatus(), 400)
          assert.equal((error.getResponse() as { code: string }).code, 'INVALID_RECORD_CURSOR')
          return true
        }
      )
    })
  }
})
