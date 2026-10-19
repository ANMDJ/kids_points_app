import { request } from '@tarojs/taro'

import {
  ReadApiConfig,
  kChildIdHeader,
  kDeviceIdHeader,
  type ReadEnvironment
} from './read_api'
import { WriteApiException } from './write_api_errors'
import { WrittenRecordDto } from './write_dto'

/** 写传输层的一行响应 —— 测试替身只需要造这个。 */
export interface WriteHttpResponse {
  statusCode: number
  body: unknown
}

/**
 * 写传输层接口（当前只有 POST）。
 *
 * 刻意与只读的 `ReadTransport` 分开：写请求必须带 body / Content-Type，
 * 且**不允许**自动重试（重试要靠幂等键）。
 */
export interface WriteTransport {
  send(
    uri: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<WriteHttpResponse>
  close?(): void
}

/** 基于 `Taro.request` 的最小实现。 */
export class TaroWriteTransport implements WriteTransport {
  async send(
    uri: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<WriteHttpResponse> {
    try {
      const response = await request({
        url: uri,
        method: 'POST',
        header: headers,
        data: body,
        dataType: 'json',
        timeout: timeoutMs
      })
      return { statusCode: response.statusCode, body: response.data }
    } catch (error) {
      if (error instanceof WriteApiException) throw error
      throw WriteApiException.network(error)
    }
  }
}

/** AppStore 依赖的写能力（测试可注入自己的实现，不必起 HTTP 服务）。 */
export interface WriteApi {
  /** 打卡。返回服务端真正写入的流水。 */
  checkIn(
    habitId: string,
    idempotencyKey?: string
  ): Promise<WrittenRecordDto>

  /** 撤销一条打卡。返回**冲正记录**（不是原记录）。 */
  reverse(
    recordId: string,
    input?: { idempotencyKey?: string; note?: string }
  ): Promise<WrittenRecordDto>
}

/** `POST /records/check-in` 与 `POST /records/:id/reverse` 的客户端。 */
export class WriteApiClient implements WriteApi {
  readonly config: ReadApiConfig
  readonly timeoutMs: number
  private readonly transport: WriteTransport

  constructor(input: {
    config: ReadApiConfig
    transport?: WriteTransport
    timeoutMs?: number
  }) {
    this.config = input.config
    this.timeoutMs = input.timeoutMs ?? 10000
    this.transport = input.transport ?? new TaroWriteTransport()
  }

  async checkIn(
    habitId: string,
    idempotencyKey?: string
  ): Promise<WrittenRecordDto> {
    const id = habitId.trim()
    if (id === '') {
      throw new Error('habitId 不能为空')
    }
    return this.post('/records/check-in', { habitId: id }, idempotencyKey)
  }

  async reverse(
    recordId: string,
    input: { idempotencyKey?: string; note?: string } = {}
  ): Promise<WrittenRecordDto> {
    const id = recordId.trim()
    if (id === '') {
      throw new Error('recordId 不能为空')
    }
    const note = input.note?.trim() ?? ''
    return this.post(
      `/records/${encodeURIComponent(id)}/reverse`,
      note === '' ? {} : { note },
      input.idempotencyKey
    )
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<WrittenRecordDto> {
    const configError = this.config.validationError
    if (configError !== null) {
      throw new WriteApiException('badRequest', configError, {
        code: 'CLIENT_NOT_CONFIGURED'
      })
    }

    const key = idempotencyKey?.trim() ?? ''
    if (key.length > 200) {
      throw new Error('idempotencyKey 不能超过 200 字符（后端同口径）')
    }

    const uri = this.config.uri(path)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      [kDeviceIdHeader]: this.config.deviceId.trim(),
      [kChildIdHeader]: this.config.childId.trim()
    }
    if (key !== '') headers['idempotency-key'] = key

    let response: WriteHttpResponse
    try {
      response = await withTimeout(
        this.transport.send(uri, headers, body, this.timeoutMs),
        this.timeoutMs
      )
    } catch (error) {
      if (error instanceof WriteApiException) throw error
      throw WriteApiException.network(error)
    }

    const decoded = decodeBody(response.body)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw WriteApiException.fromHttp({
        statusCode: response.statusCode,
        body: decoded
      })
    }
    if (decoded === null) {
      throw WriteApiException.malformed(
        '$',
        `HTTP ${response.statusCode} 但响应体为空`
      )
    }
    return WrittenRecordDto.fromJson(decoded)
  }
}

/**
 * 配置齐全时才构造写客户端；否则返回 null，store 继续使用本地预览数据。
 * 不抛错、不偷偷发请求：缺配置是**正常**的本地开发状态。
 */
export function createWriteApiFromEnvironment(
  env: ReadEnvironment = defaultEnvironment()
): WriteApi | null {
  const config = ReadApiConfig.fromEnvironment(env)
  return config.isConfigured ? new WriteApiClient({ config }) : null
}

function defaultEnvironment(): ReadEnvironment {
  if (typeof process !== 'undefined' && process.env) {
    return process.env as ReadEnvironment
  }
  return {}
}

/** 超时是**客户端**的承诺：部分平台不遵守 Taro.request 的 timeout。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(WriteApiException.timeout(timeoutMs))
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** 文本 / 已解析对象都接受；空体或坏 JSON 交给 DTO 报 malformed。 */
function decodeBody(body: unknown): unknown {
  if (typeof body !== 'string') return body
  const text = body.trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}
