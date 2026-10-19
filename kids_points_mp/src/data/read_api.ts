import { request } from '@tarojs/taro'

import { ReadApiException } from './read_api_errors'
import { HomeDto, RecordsPageDto } from './read_dto'

/**
 * 设备身份的**两个请求头** —— 与后端 Guard 的常量必须一致
 * （`backend/src/device-session/device-session.guard.ts` 的 `DEVICE_ID_HEADER` /
 * `CHILD_ID_HEADER`）。
 *
 * `childId` 只是「会话要作用在哪个孩子上」，**不是**授权凭据：后端会用会话行反查，
 * 对不上就 500/403。因此客户端改这个头不会串到别人家。
 */
export const kDeviceIdHeader = 'x-kp-device-id'
export const kChildIdHeader = 'x-kp-child-id'

export interface ReadEnvironment {
  [key: string]: string | undefined
}

/**
 * 只读 API 的连接配置。
 *
 * 配置来源**只有**编译期环境变量（Taro 的 `TARO_APP_*`，见 `.env.example`）：
 * 设备身份是配对流程产出的凭据，不能由用户随手在界面上填。
 */
export class ReadApiConfig {
  constructor(
    readonly baseUrl: string,
    readonly deviceId: string,
    readonly childId: string
  ) {}

  static fromEnvironment(
    env: ReadEnvironment = defaultEnvironment()
  ): ReadApiConfig {
    return new ReadApiConfig(
      env.TARO_APP_KP_API_BASE_URL ?? '',
      env.TARO_APP_KP_DEVICE_ID ?? '',
      env.TARO_APP_KP_CHILD_ID ?? ''
    )
  }

  /** 三项都齐才接后端 —— 少一项就退回预览数据，**绝不**发一个会 401 的请求。 */
  get isConfigured(): boolean {
    return this.validationError === null
  }

  /** 配置不完整时的**可执行**说明；完整时为 null。 */
  get validationError(): string | null {
    const base = this.baseUrl.trim()
    if (base === '') {
      return (
        '未配置 TARO_APP_KP_API_BASE_URL：现在显示的是本地预览数据。\n' +
        '接后端请在 kids_points_mp/.env.local 填 TARO_APP_KP_API_BASE_URL=http://127.0.0.1:3000。'
      )
    }
    if (!/^https?:\/\/[^/\s]+/i.test(base)) {
      return `TARO_APP_KP_API_BASE_URL 不是合法的 http(s) 地址：${base}。`
    }
    if (this.deviceId.trim() === '') {
      return '未配置 TARO_APP_KP_DEVICE_ID：只读接口需要设备身份（401 之前就拦下）。'
    }
    if (this.childId.trim() === '') {
      return '未配置 TARO_APP_KP_CHILD_ID：只读接口必须指明读哪个孩子。'
    }
    return null
  }

  /** 拼出请求地址：`baseUrl` 的尾斜杠与 `path` 的首斜杠都不会重复。 */
  uri(path: string, query: Record<string, string> = {}): string {
    const base = this.baseUrl.trim().replace(/\/+$/, '')
    const suffix = path.startsWith('/') ? path : `/${path}`
    const pairs = Object.keys(query)
      .filter((key) => query[key] !== '')
      .map(
        (key) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`
      )
    return pairs.length === 0
      ? `${base}${suffix}`
      : `${base}${suffix}?${pairs.join('&')}`
  }
}

/** 传输层的一行响应 —— 测试替身只需要造这个，不必起真的 HTTP 服务。 */
export interface ReadHttpResponse {
  statusCode: number
  body: unknown
}

/** 传输层接口（GET 专用）。默认实现是 `TaroReadTransport`。 */
export interface ReadTransport {
  send(
    uri: string,
    headers: Record<string, string>,
    timeoutMs: number
  ): Promise<ReadHttpResponse>
  close?(): void
}


/** 基于 `Taro.request` 的最小实现。 */
export class TaroReadTransport implements ReadTransport {
  async send(
    uri: string,
    headers: Record<string, string>,
    timeoutMs: number
  ): Promise<ReadHttpResponse> {
    try {
      const response = await request({
        url: uri,
        method: 'GET',
        header: headers,
        dataType: 'json',
        timeout: timeoutMs
      })
      return { statusCode: response.statusCode, body: response.data }
    } catch (error) {
      const text = errorText(error).toLowerCase()
      if (text.indexOf('timeout') >= 0 || text.indexOf('超时') >= 0) {
        throw ReadApiException.timeout(timeoutMs)
      }
      throw ReadApiException.network(error)
    }
  }
}

/** `GET /home` 与 `GET /records` 的客户端。 */
export class ReadApiClient {
  readonly config: ReadApiConfig
  readonly timeoutMs: number
  private readonly transport: ReadTransport

  constructor(input: {
    config: ReadApiConfig
    transport?: ReadTransport
    timeoutMs?: number
  }) {
    this.config = input.config
    this.timeoutMs = input.timeoutMs ?? 10000
    this.transport = input.transport ?? new TaroReadTransport()
  }

  async fetchHome(): Promise<HomeDto> {
    return HomeDto.fromJson(await this.get('/home'))
  }

  /**
   * 第一页传 `cursor: null`；之后把响应里的 `nextCursor` **原样**传回来。
   * 游标不是 offset，客户端不许自己拼。
   */
  async fetchRecords(
    input: {
      category?: string | null
      limit?: number
      cursor?: string | null
    } = {}
  ): Promise<RecordsPageDto> {
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw ReadApiException.malformed(
        'limit',
        '必须在 1–200 之间（后端 DTO 同口径）'
      )
    }
    const query: Record<string, string> = { limit: String(limit) }
    if (input.category !== undefined && input.category !== null) {
      query.category = input.category
    }
    if (
      input.cursor !== undefined &&
      input.cursor !== null &&
      input.cursor !== ''
    ) {
      query.cursor = input.cursor
    }
    return RecordsPageDto.fromJson(await this.get('/records', query))
  }

  private async get(
    path: string,
    query: Record<string, string> = {}
  ): Promise<unknown> {
    const configError = this.config.validationError
    if (configError !== null) {
      throw new ReadApiException('badRequest', configError, {
        code: 'CLIENT_NOT_CONFIGURED'
      })
    }

    const uri = this.config.uri(path, query)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [kDeviceIdHeader]: this.config.deviceId.trim(),
      [kChildIdHeader]: this.config.childId.trim()
    }

    let response: ReadHttpResponse
    try {
      response = await withTimeout(
        this.transport.send(uri, headers, this.timeoutMs),
        this.timeoutMs
      )
    } catch (error) {
      if (error instanceof ReadApiException) throw error
      throw ReadApiException.network(error)
    }

    const body = decodeBody(response.body)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ReadApiException.fromHttp({
        statusCode: response.statusCode,
        body
      })
    }
    return body
  }
}


/**
 * 配置齐全时才构造客户端；否则返回 null，`store` 继续使用本地预览数据。
 * 不抛错、不偷偷发请求：缺配置是**正常**的本地开发状态。
 */
export function createReadApiFromEnvironment(
  env: ReadEnvironment = defaultEnvironment()
): ReadApiClient | null {
  const config = ReadApiConfig.fromEnvironment(env)
  return config.isConfigured ? new ReadApiClient({ config }) : null
}

function defaultEnvironment(): ReadEnvironment {
  if (typeof process !== 'undefined' && process.env) {
    return process.env as ReadEnvironment
  }
  return {}
}

/**
 * 超时是**客户端**的承诺：Taro.request 的 timeout 在部分平台不生效，
 * 这层 `race` 保证页面不会永远停在「正在读取」。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(ReadApiException.timeout(timeoutMs))
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

/** 文本 / 已解析对象都接受；空体或坏 JSON 交给 DTO 报 `malformed`。 */
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const errMsg = (error as Record<string, unknown>).errMsg
    if (typeof errMsg === 'string') return errMsg
  }
  return String(error)
}
