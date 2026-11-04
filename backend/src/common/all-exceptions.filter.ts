import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter
} from '@nestjs/common'
import type { ServerResponse } from 'node:http'

import { REQUEST_ID_HEADER, type TracedRequest } from './request-id'

/**
 * 全局异常过滤器（P2，2026-11-04）—— `43` §5「requestId ＋ 全局异常过滤器」。
 *
 * ── 它解决的是什么 ──────────────────────────────────────────────────────────
 *   Nest 默认把**未预期异常**（不是 `HttpException`，例如 Prisma 报错、
 *   `TypeError`、某个 service 里的 `undefined.foo`）转成 500，但：
 *     · 日志里只有堆栈，**没有**请求 id；
 *     · 报文体只有 `Internal server error`，用户截图无法对上日志。
 *   上线后第一次真正的 500 就会变成「无法定位」，所以这一步不提前做，事故现场就是一次性的。
 *
 * ── 为什么不改写 4xx 的报文形状（这是一个刻意的硬约束）─────────────────────
 *   本仓库的 4xx 是**契约**：`{ code, message }` 被双端 `write_api_errors` 逐条映射
 *   （`WEAK_PASSWORD` / `INVITE_CODE_MALFORMED` / `APPROVAL_REQUIRED`…），
 *   66 个后端用例文件里有大量 `assert.equal(body.code, ...)`。
 *   如果这里「顺手」给所有报文加上 `requestId`，等于每一处断言都变成两份真相的赌注。
 *   ⇒ **4xx：报文一个字节都不改**（Nest 默认行为原样复刻）；只有 5xx 未预期错误
 *   才用带 `requestId` 的新信封。追踪 id 对**所有**响应都存在 —— 在响应头里。
 *
 * ── 为什么自己实现，不 `extends BaseExceptionFilter` ────────────────────────
 *   `BaseExceptionFilter` 需要一个 `HttpServer` 适配器（构造参数），
 *   而本文件只做「三种形状」的判定（对象 / 字符串 / 空）。自己写 30 行
 *   比在 66 个文件的测试装配里多传一个 adapter 更不容易错。
 */

/** 5xx 未预期错误的响应体（**唯一**会带 `requestId` 的 body）。 */
export interface InternalErrorEnvelope {
  statusCode: number
  code: 'INTERNAL_ERROR'
  message: string
  requestId: string
}

/**
 * 生产环境的 500 报文体**不**回显内部错误原文。
 *
 * 理由与 `health.controller` 的 `redactProbeDetail()` 同源：异常消息里可能带
 * SQL 片段 / 连接串 / 文件路径。原文只进日志（运维看得见），不出公网。
 * `KP_EXPOSE_ERROR_DETAIL=1` 只给联调环境用（默认关闭 —— fail-closed）。
 */
export function internalErrorMessage(exposeDetail: boolean): string {
  return exposeDetail
    ? '服务器处理请求时出错（详情见服务端日志，按 requestId 检索）。'
    : '服务器处理请求时出错，请把这条提示里的编号（requestId）发给管理员。'
}

/** 是否回显内部错误原文；只认显式 `1`，其余一律不回显。 */
export function shouldExposeErrorDetail(raw: string | undefined): boolean {
  return raw === '1'
}

/**
 * 把任意异常压成 500 信封。
 *
 * ★ `requestId` 是**必填**：调用方拿不到 id 说明 `requestIdMiddleware` 没挂
 *   （装配错误）—— 那时宁可写 `unknown`，也不静默生成一个新的（那样日志与响应
 *   会对不上，正好毁掉这个功能的意义）。
 */
export function toInternalErrorEnvelope(
  error: unknown,
  requestId: string,
  exposeDetail: boolean
): InternalErrorEnvelope {
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    message: internalErrorMessage(exposeDetail),
    requestId
  }
}

/**
 * 一行式错误日志（便于 grep）。**id 在最前**：终端里 `grep <id>` 一条就能捞全。
 *
 * 不把 `error.message` 之外的字段（请求体 / 头）写进来：头里有 `authorization`，
 * 请求体里有家庭数据 —— 日志不是第二个数据库。
 */
export function formatErrorLog(input: {
  requestId: string
  method: string
  url: string
  error: unknown
}): string {
  const detail = input.error instanceof Error ? input.error.message : String(input.error)
  return `[${input.requestId}] ${input.method} ${input.url} ⇒ ${detail}`
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException')

  constructor(
    /** 只在构造时读一次环境变量：运行中改 env 不该改变报文形状（测试也好钉）。 */
    private readonly exposeDetail: boolean = shouldExposeErrorDetail(
      process.env.KP_EXPOSE_ERROR_DETAIL
    )
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const res = http.getResponse<ServerResponse>()
    const req = http.getRequest<TracedRequest>()
    const requestId = req.requestId ?? 'unknown'

    // ★ 已经回了头（例如流式响应写到一半才抛）⇒ 不能再改状态码 / 再写 body。
    //   这时唯一能做的是记日志；由连接关闭告诉客户端「这次不完整」。
    if (res.headersSent) {
      this.logger.error(
        formatErrorLog({ requestId, method: req.method ?? 'UNKNOWN', url: describeUrl(req), error: exception })
      )
      return
    }

    if (exception instanceof HttpException) {
      this.replyHttpException(exception, res, requestId)
      return
    }

    this.logger.error(
      formatErrorLog({
        requestId,
        method: req.method ?? 'UNKNOWN',
        url: describeUrl(req),
        error: exception
      }),
      exception instanceof Error ? exception.stack : undefined
    )
    const body = toInternalErrorEnvelope(exception, requestId, this.exposeDetail)
    res.statusCode = body.statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader(REQUEST_ID_HEADER, requestId)
    res.end(JSON.stringify(body))
  }

  /**
   * 复刻 Nest 默认的 `HttpException` 序列化，**逐字节一致**：
   *   · `getResponse()` 是对象 ⇒ 原样返回（本仓库所有 `code/message` 走这条）；
   *   · 是字符串 ⇒ `{ statusCode, message }`；
   *   · 其它 ⇒ `{ statusCode }`。
   * 唯一新增的是 `x-request-id` 响应头（中间件通常已写，这里兜底）。
   */
  private replyHttpException(exception: HttpException, res: ServerResponse, requestId: string): void {
    const status = exception.getStatus()
    const payload = exception.getResponse()
    const body =
      typeof payload === 'string'
        ? { statusCode: status, message: payload }
        : typeof payload === 'object' && payload !== null
          ? payload
          : { statusCode: status }

    res.statusCode = status
    if (!res.hasHeader(REQUEST_ID_HEADER)) res.setHeader(REQUEST_ID_HEADER, requestId)
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
}

/** `originalUrl`（有 query）优先，其次 `url`；两者都没有时给 `/`。 */
function describeUrl(req: TracedRequest): string {
  return req.originalUrl ?? req.url ?? '/'
}
