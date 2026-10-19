import { request } from '@tarojs/taro'

import {
  ReadApiConfig,
  kChildIdHeader,
  kDeviceIdHeader,
  type ReadEnvironment
} from './read_api'
import { ReadApiException } from './read_api_errors'
import { HabitDto, RuleDto } from './read_dto'
import { WriteApiException } from './write_api_errors'
import { WrittenRecordDto } from './write_dto'

/** 写端点用到的 HTTP 方法（与后端 REST 语义一致，幂等哈希按真实方法算）。 */
export type WriteMethod = 'POST' | 'PATCH' | 'DELETE'

/** 写传输层的一行响应 —— 测试替身只需要造这个。 */
export interface WriteHttpResponse {
  statusCode: number
  body: unknown
}

/**
 * 写传输层接口。
 *
 * 刻意与只读的 `ReadTransport` 分开：写请求必须带 body / Content-Type，
 * 且**不允许**自动重试（重试要靠幂等键）。
 *
 * `body` 允许为 null：DELETE 没有请求体，目标已经在路径里。
 */
export interface WriteTransport {
  send(
    uri: string,
    headers: Record<string, string>,
    body: Record<string, unknown> | null,
    timeoutMs: number,
    method?: WriteMethod
  ): Promise<WriteHttpResponse>
  close?(): void
}

/** 基于 `Taro.request` 的最小实现。 */
export class TaroWriteTransport implements WriteTransport {
  async send(
    uri: string,
    headers: Record<string, string>,
    body: Record<string, unknown> | null,
    timeoutMs: number,
    method: WriteMethod = 'POST'
  ): Promise<WriteHttpResponse> {
    try {
      const response = await request({
        url: uri,
        // Taro 的方法联合类型没有导出，这里按同一份字符串转一次，
        // 避免为了 PATCH 去 `as any` 把整条请求的类型安全一起丢掉。
        method: method as Parameters<typeof request>[0]['method'],
        header: headers,
        data: body ?? undefined,
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

  /**
   * 新建规则。`points` 带符号（负 = 扣分），服务端落库时拆成
   * 「正数分值 + direction」，回包仍是带符号的分值。
   */
  createRule(input: {
    title: string
    condition: string
    dailyLimit: number
    points: number
    icon: string
    color: string
    idempotencyKey?: string
  }): Promise<RuleDto>

  /**
   * 更新规则。`expectedVersion` 是**客户端看到的版本号**：与服务端不一致
   * ⇒ 409 `RULE_VERSION_CONFLICT`，绝不静默覆盖别人刚改的内容。
   */
  updateRule(
    ruleId: string,
    input: {
      title: string
      condition: string
      dailyLimit: number
      points: number
      expectedVersion: number
      idempotencyKey?: string
    }
  ): Promise<RuleDto>

  /** 软删规则（进回收站）。返回服务端确认删除的 `ruleId`。 */
  deleteRule(ruleId: string, idempotencyKey?: string): Promise<string>

  /** 按规则生成首页习惯。返回与 `GET /home` 的 `habits[]` 同构的行。 */
  addHabitFromRule(ruleId: string, idempotencyKey?: string): Promise<HabitDto>
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
    return this.send(
      'POST',
      '/records/check-in',
      { habitId: id },
      parseWrittenRecord,
      idempotencyKey
    )
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
    return this.send(
      'POST',
      `/records/${encodeURIComponent(id)}/reverse`,
      note === '' ? {} : { note },
      parseWrittenRecord,
      input.idempotencyKey
    )
  }

  async createRule(input: {
    title: string
    condition: string
    dailyLimit: number
    points: number
    icon: string
    color: string
    idempotencyKey?: string
  }): Promise<RuleDto> {
    const title = input.title.trim()
    if (title === '') {
      throw new Error('title 不能为空')
    }
    return this.send(
      'POST',
      '/point-rules',
      {
        title,
        condition: input.condition.trim(),
        dailyLimit: input.dailyLimit,
        // 带符号原样发出：扣分由服务端转成「正数 + direction」，
        // 客户端再取反一次就会把扣分变加分。
        points: input.points,
        icon: input.icon,
        color: input.color
      },
      (raw) => this.parseRule(raw),
      input.idempotencyKey
    )
  }

  async updateRule(
    ruleId: string,
    input: {
      title: string
      condition: string
      dailyLimit: number
      points: number
      expectedVersion: number
      idempotencyKey?: string
    }
  ): Promise<RuleDto> {
    const id = this.requireId(ruleId, 'ruleId')
    const title = input.title.trim()
    if (title === '') {
      throw new Error('title 不能为空')
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('expectedVersion 必须 ≥ 1')
    }
    return this.send(
      'PATCH',
      `/point-rules/${encodeURIComponent(id)}`,
      {
        title,
        condition: input.condition.trim(),
        dailyLimit: input.dailyLimit,
        points: input.points,
        // 乐观锁：客户端只声明「我改的是第几版」，版本递增由服务端做。
        expectedVersion: input.expectedVersion
      },
      (raw) => this.parseRule(raw),
      input.idempotencyKey
    )
  }

  async deleteRule(ruleId: string, idempotencyKey?: string): Promise<string> {
    const id = this.requireId(ruleId, 'ruleId')
    const decoded = await this.send<unknown>(
      'DELETE',
      `/point-rules/${encodeURIComponent(id)}`,
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      (raw) => raw,
      idempotencyKey
    )
    const returned =
      typeof decoded === 'object' && decoded !== null
        ? (decoded as Record<string, unknown>).ruleId
        : undefined
    if (returned !== id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        '$.ruleId',
        `删除回包的 ruleId 与请求不一致：${String(returned)} != ${id}`
      )
    }
    return id
  }

  async addHabitFromRule(
    ruleId: string,
    idempotencyKey?: string
  ): Promise<HabitDto> {
    const id = this.requireId(ruleId, 'ruleId')
    return this.send(
      'POST',
      `/point-rules/${encodeURIComponent(id)}/habits`,
      null,
      (raw) => this.parseHabit(raw),
      idempotencyKey
    )
  }

  private requireId(value: string, name: string): string {
    const id = value.trim()
    if (id === '') throw new Error(`${name} 不能为空`)
    return id
  }

  /**
   * 严格解析失败（`ReadApiException`）也必须归一到写异常：
   * 页面只处理一种错误类型，不必知道「这次是读 DTO 报的错」。
   */
  private parseRule(raw: unknown): RuleDto {
    try {
      return RuleDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseHabit(raw: unknown): HabitDto {
    try {
      return HabitDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private async send<T>(
    method: WriteMethod,
    path: string,
    body: Record<string, unknown> | null,
    parse: (raw: unknown) => T,
    idempotencyKey?: string
  ): Promise<T> {
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
      [kDeviceIdHeader]: this.config.deviceId.trim(),
      [kChildIdHeader]: this.config.childId.trim()
    }
    // 没有请求体就不声明 Content-Type：DELETE 带空 JSON 会被严格后端拒掉。
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }
    if (key !== '') headers['idempotency-key'] = key

    let response: WriteHttpResponse
    try {
      response = await withTimeout(
        this.transport.send(uri, headers, body, this.timeoutMs, method),
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
    return parse(decoded)
  }
}

/** 写回包 → 流水 DTO 的解析（把读层异常归一成写异常）。 */
function parseWrittenRecord(raw: unknown): WrittenRecordDto {
  return WrittenRecordDto.fromJson(raw)
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
