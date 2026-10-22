import { request } from '@tarojs/taro'

import { ReadApiException } from './read_api_errors'
import {
  ApprovalsPageDto,
  HomeDto,
  InviteListDto,
  MemberListDto,
  RecordsPageDto,
  TrashListDto
} from './read_dto'

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

/**
 * 收件箱 / 我的申请共用的查询串：两个端点同一条线格式，参数规则也只该有一份。
 *
 * `limit` 在**发请求之前**按后端 DTO 判掉（1–100）：越界一定 400，白跑一趟。
 * `status` 为 null / undefined 时不带 —— 「全部」不是某个枚举值。
 */
function approvalPageQuery(input: {
  status?: string | null
  limit?: number
  cursor?: string | null
}): Record<string, string> {
  const limit = input.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw ReadApiException.malformed(
      'limit',
      '必须在 1–100 之间（后端 DTO 同口径）'
    )
  }
  const query: Record<string, string> = { limit: String(limit) }
  if (input.status !== undefined && input.status !== null) {
    query.status = input.status
  }
  if (
    input.cursor !== undefined &&
    input.cursor !== null &&
    input.cursor !== ''
  ) {
    query.cursor = input.cursor
  }
  return query
}

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
      return '未配置 TARO_APP_KP_DEVICE_ID：请求需要设备身份（401 之前就拦下）。'
    }
    if (this.childId.trim() === '') {
      return '未配置 TARO_APP_KP_CHILD_ID：请求必须指明操作哪个孩子。'
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

  /**
   * 家长审批收件箱（W5-D）。
   *
   * 与流水同一把键集游标：第一页 `cursor: null`，之后把 `nextCursor` 原样带回。
   * `status` 不传 = 全部；**绝不**在客户端过滤 —— 本地只过滤已加载的一页
   * 会漏掉后面同状态的申请（那是假「共 N 条」）。
   *
   * 只有家长 / 管理员调得通：孩子角色的设备会拿到 403（页面据此说明
   * 「没有批准申请的权限」，而不是显示成「没有待审批」）。
   */
  async fetchApprovals(
    input: {
      status?: string | null
      limit?: number
      cursor?: string | null
    } = {}
  ): Promise<ApprovalsPageDto> {
    return ApprovalsPageDto.fromJson(
      await this.get('/approvals', approvalPageQuery(input))
    )
  }

  /**
   * 我提交的申请（`GET /approvals/mine`，W5-J）。
   *
   * 与收件箱**同一条线格式**（同一个 `ApprovalsPageDto`），但语义不同：
   *   · 收件箱 = 需要我处理的（家长视角，child 会 403）；
   *   · 我的申请 = 我提交的（任何角色都能看自己那几条）。
   * 因此两个列表**各自分页、各自缓存**：把 mine 写进收件箱会互相污染游标。
   *
   * `status` 不传 = 全部（默认展示全部，撤回按钮按行禁用）。
   */
  async fetchMyApprovals(
    input: {
      status?: string | null
      limit?: number
      cursor?: string | null
    } = {}
  ): Promise<ApprovalsPageDto> {
    return ApprovalsPageDto.fromJson(
      await this.get('/approvals/mine', approvalPageQuery(input))
    )
  }

  /**
   * 回收站（`GET /trash`，W5-F）：被软删的规则 / 心愿 / 习惯。
   *
   * 孩子也能看（权限矩阵 `view_trash` 对 child 是 ALLOW）——「我删掉的
   * 那张卡去哪了」是孩子会问的问题。不分页：低频、小集合。
   */
  async fetchTrash(): Promise<TrashListDto> {
    return TrashListDto.fromJson(await this.get('/trash'))
  }

  /**
   * 家庭成员（`GET /members`，W5-H）：当前孩子的**活跃**成员位。
   *
   * 孩子也能看（矩阵 `view_members` child ALLOW）：列表只含昵称 / 角色 /
   * 时间，不含手机号、`openId`、PIN。不分页 —— 单孩子量小，被移出的人
   * 不会出现在列表里（只能在审计里看到）。
   *
   * 写入口（改角色 / 移出）在 `WriteApi` 上；响应里**没有**
   * `canChangeRole` / `canRemove` 这类结论字段，谁能对谁做什么由服务端判定。
   */
  async fetchMembers(): Promise<MemberListDto> {
    return MemberListDto.fromJson(await this.get('/members'))
  }

  /**
   * 邀请码列表（`GET /invites`，W5-I）：本孩子下所有未被删除的邀请码。
   *
   * **只有家长能看**（矩阵 `invite_member` 对 child 是 DENY）—— 调用方必须
   * 先确认 `canManageInvites`，不要用一次注定 403 的请求去「探测」角色。
   *
   * 不分页：小集合，且返回的是**凭据**本身，翻页只会让「刚生成的码在哪」
   * 更难找。响应用不下发「能不能用」的结论（`expired` / `usable`），
   * 状态由 `inviteStatusOf` 现算。
   */
  async fetchInvites(): Promise<InviteListDto> {
    return InviteListDto.fromJson(await this.get('/invites'))
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
