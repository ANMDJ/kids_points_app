/**
 * request-id-http.test.ts —— 请求追踪 id ＋ 全局异常过滤器（P2，2026-11-04；真起 Nest ＋ 真发 HTTP）
 *
 * ── 这一批用例在钉什么（每条都能失败）──────────────────────────────────────────
 *   ① 每个响应都带 `x-request-id`：没有它，用户截图里的那条 500 在日志里无从检索。
 *   ② 客户端 / 反代传来的**合法** id 要原样回显（否则 App → Caddy → API 的链路断裂，
 *      追踪变成「每一跳各生成一个 id」）。
 *   ③ **不合法**的 id 必须被丢弃并重新生成：`x-request-id: "a\n[ERROR] 伪造"`
 *      会制造一行假日志（日志注入）。超长（>64）同样不认 —— 响应头有长度上限。
 *   ④ 未预期异常（`new Error`）⇒ `500 + { statusCode, code:'INTERNAL_ERROR',
 *      message, requestId }`，且 `body.requestId === 响应头`。
 *   ⑤ **4xx 报文形状一个字节都不改**：`{ code, message }` 原样返回，不许多出
 *      `requestId` 字段 —— 双端 `write_api_errors` 与 66 个后端用例文件都按这个形状断言。
 *   ⑥ 500 报文体**不回显内部原文**（异常消息里可能有 SQL / 连接串）：原文只进日志。
 *
 * ── 诚实标注 ────────────────────────────────────────────────────────────────
 *   · 这里没有真的数据库，异常是 `new Error()` 造出来的；本文件证明的是
 *     「过滤器的形状与 id 传递」，不是「Prisma 报错长什么样」。
 *   · 日志内容用纯函数 `formatErrorLog()` 断言（不捕获 Logger 输出）：
 *     只验证「id / 方法 / 路径 / 原因同一行」，不验证 Nest 的日志落盘行为。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { BadRequestException, Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { formatErrorLog } from '../src/common/all-exceptions.filter'
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_MAX_LENGTH,
  REQUEST_ID_PATTERN,
  pickRequestId
} from '../src/common/request-id'
import { applyGlobalPipes, applyHttpFoundation } from '../src/app.setup'

interface HttpResult {
  status: number
  requestId: string | null
  body: Record<string, unknown>
}

/** 探针控制器：三个端点分别是 200 / 未预期 500 / 契约化 400。 */
@Controller('_probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true }
  }

  @Get('boom')
  boom(): never {
    // 故意抛一个**不是** HttpException 的错误：模拟 Prisma / TypeError 这一类。
    throw new Error('数据库连接断了 postgresql://kids:secret@pg18/kids')
  }

  @Get('bad')
  bad(): never {
    // 本仓库 4xx 的真实形状（对象响应体 ⇒ 原样返回）。
    throw new BadRequestException({ code: 'DEMO_INVALID', message: '示例校验失败' })
  }
}

async function call(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, { headers })
  const text = await res.text()
  const body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  return { status: res.status, requestId: res.headers.get(REQUEST_ID_HEADER), body }
}

describe('requestId ＋ 全局异常过滤器', () => {
  let app: INestApplication
  let baseUrl: string

  before(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = moduleRef.createNestApplication()
    // ★ 与 main.ts 同一装配（两条都在 `applyHttpFoundation` 里）。
    applyHttpFoundation(app)
    applyGlobalPipes(app)
    await app.listen(0, '127.0.0.1')
    baseUrl = await app.getUrl()
  })

  after(async () => {
    await app.close()
  })

  it('① 正常响应也带 x-request-id，且两次请求不是同一个 id', async () => {
    const first = await call(baseUrl, '/_probe/ok')
    const second = await call(baseUrl, '/_probe/ok')

    assert.equal(first.status, 200)
    assert.match(String(first.requestId), REQUEST_ID_PATTERN)
    assert.match(String(second.requestId), REQUEST_ID_PATTERN)
    assert.notEqual(first.requestId, second.requestId, '每次请求必须有自己的 id')
  })

  it('② 客户端传来的合法 id 原样回显（链路追踪不能每跳重生成）', async () => {
    const result = await call(baseUrl, '/_probe/ok', { [REQUEST_ID_HEADER]: 'req-abc_123.4' })
    assert.equal(result.requestId, 'req-abc_123.4')
  })

  it('③ 超长 / 非法的 id 被丢弃并重新生成（防日志注入与响应头溢出）', async () => {
    // ★ 换行注入只能在纯函数层验证（`fetch` 自己就会拒绝构造非法头值）——
    //   这里验 HTTP 路径能验的那一半：超长值不被回显。
    const tooLong = 'x'.repeat(REQUEST_ID_MAX_LENGTH + 1)
    const result = await call(baseUrl, '/_probe/ok', { [REQUEST_ID_HEADER]: tooLong })
    assert.notEqual(result.requestId, tooLong)
    assert.match(String(result.requestId), REQUEST_ID_PATTERN)

    const spaced = await call(baseUrl, '/_probe/ok', { [REQUEST_ID_HEADER]: 'a b c' })
    assert.notEqual(spaced.requestId, 'a b c')
    assert.match(String(spaced.requestId), REQUEST_ID_PATTERN)
  })

  it('④ 未预期异常 ⇒ 500 + INTERNAL_ERROR + body.requestId 与响应头一致', async () => {
    const result = await call(baseUrl, '/_probe/boom')

    assert.equal(result.status, 500)
    assert.equal(result.body.code, 'INTERNAL_ERROR')
    assert.equal(result.body.statusCode, 500)
    assert.equal(result.body.requestId, result.requestId)
    assert.match(String(result.requestId), REQUEST_ID_PATTERN)
  })

  it('⑤ 4xx 报文形状不变：只有 code / message，不许多出 requestId', async () => {
    const result = await call(baseUrl, '/_probe/bad')

    assert.equal(result.status, 400)
    assert.deepEqual(result.body, { code: 'DEMO_INVALID', message: '示例校验失败' })
    // 但 id 仍要在头里 —— 4xx 同样要能被检索到。
    assert.match(String(result.requestId), REQUEST_ID_PATTERN)
  })

  it('⑥ 500 报文体不回显内部原文（连接串 / SQL 不许出公网）', async () => {
    const result = await call(baseUrl, '/_probe/boom')
    const message = String(result.body.message)
    assert.equal(message.includes('postgresql://'), false)
    assert.equal(message.includes('secret'), false)
    assert.equal(message.includes('数据库连接断了'), false)
  })

  it('⑦ 日志行 = id + 方法 + 路径 + 原因（grep 一个 id 能捞全）', () => {
    const line = formatErrorLog({
      requestId: 'req-42',
      method: 'POST',
      url: '/records/adjust?x=1',
      error: new Error('boom')
    })
    assert.equal(line, '[req-42] POST /records/adjust?x=1 ⇒ boom')
  })
})

describe('pickRequestId（纯函数边界）', () => {
  it('接受 UUID / 雪花 / 带点号下划线连字符的组合', () => {
    assert.equal(
      pickRequestId('123e4567-e89b-12d3-a456-426614174000'),
      '123e4567-e89b-12d3-a456-426614174000'
    )
    assert.equal(pickRequestId('1800000000000000001'), '1800000000000000001')
    assert.equal(pickRequestId(' trace.a_1-2 '), 'trace.a_1-2')
  })

  it('拒绝：空串 / 空格 / 换行 / 中文 / 数组 / 超长', () => {
    assert.equal(pickRequestId(''), undefined)
    assert.equal(pickRequestId('  '), undefined)
    assert.equal(pickRequestId('a b'), undefined)
    assert.equal(pickRequestId('a\nb'), undefined)
    assert.equal(pickRequestId('请求一'), undefined)
    assert.equal(pickRequestId(['a', 'b']), undefined)
    assert.equal(pickRequestId('x'.repeat(REQUEST_ID_MAX_LENGTH + 1)), undefined)
  })
})
