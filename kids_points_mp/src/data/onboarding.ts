import {
  kAuthorizationHeader,
  sharedAuthTokens
} from './auth_token_holder'
import {
  ReadApiConfig,
  kChildIdHeader,
  kDeviceIdHeader,
  type ReadEnvironment
} from './read_api'
import { ReadApiException } from './read_api_errors'
import { readCompiledEnvironment } from './compiled_env'
import {
  readBool,
  readDate,
  readInt,
  readList,
  readObject,
  readOptionalDate,
  readOptionalString,
  readString
} from './read_dto'
import { WriteApiException } from './write_api_errors'
import type { WriteHttpResponse, WriteMethod, WriteTransport } from './write_api'
import { TaroWriteTransport } from './write_api'

/**
 * 首启引导的**客户端数据层**（W8-B，2026-10-27 / `04` §2–§6）。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────
 *   与 Flutter 侧 `lib/data/onboarding_api.dart` 同一分工：
 *   ① 引导既有读（`GET`）又有写（`PATCH` / `POST`），塞进 `read_api` 或
 *      `write_api` 都会让那一边多出「不该由它负责」的方法；
 *   ② 三端点只在引导期间使用，独立文件让首页刷新路径不必知道引导存在；
 *   ③ 测试可以只注入这一个接口，不必伪造整份 `ReadApi`。
 *
 * ── 学段 / 关注点是**跨端契约** ─────────────────────────────────────────────
 *   下面的取值必须与后端 `backend/src/contracts/onboarding.ts` 逐字一致；
 *   三处手抄由闸门 `npm run onboarding:check` 比对（`tools/onboarding-options-check.mjs`）。
 *   新增关注点 = 改后端 + 双端 + 补模板，然后跑闸门。
 */

/** 学段（与 Prisma `enum AgeBand` 逐字一致）。 */
export const AGE_BAND_OPTIONS = [
  { value: 'preschool', label: '幼儿园', hint: '3–6 岁' },
  { value: 'primary_low', label: '小学低年级', hint: '1–3 年级' },
  { value: 'primary_high', label: '小学高年级', hint: '4–6 年级' },
  { value: 'junior_high', label: '初中', hint: '7–9 年级' }
] as const

export type AgeBandName = (typeof AGE_BAND_OPTIONS)[number]['value']

/** 6 个关注点（`04` §2 第④步）—— 展示用中文标签，不是 slug。 */
export const FOCUS_AREA_OPTIONS = [
  '作业专注',
  '生活习惯',
  '阅读',
  '运动',
  '情绪管理',
  '家务'
] as const

export type FocusAreaName = (typeof FOCUS_AREA_OPTIONS)[number]

export function isAgeBandName(value: string): value is AgeBandName {
  return AGE_BAND_OPTIONS.some((option) => option.value === value)
}

export function isFocusAreaName(value: string): value is FocusAreaName {
  return (FOCUS_AREA_OPTIONS as readonly string[]).includes(value)
}

/** 学段中文标签；未知值返回**原样**（不编一个「小学低年级」出来）。 */
export function ageBandLabel(value: string): string {
  return AGE_BAND_OPTIONS.find((option) => option.value === value)?.label ?? value
}

/** 一张模板卡片（`GET /onboarding.templates[i]`）。 */
export interface RuleTemplate {
  slug: string
  title: string
  condition: string
  /** 每天最多几次（结构字段，不再塞进 condition）。 */
  dailyLimit: number
  /** 分值的**绝对值**；方向由 `isPenalty` 表达。 */
  points: number
  isPenalty: boolean
  /** 图标**名字**（跨端契约）。 */
  icon: string
  color: string
  ageBand: AgeBandName
  focusAreas: string[]
  sortWeight: number
}

/** 引导状态（`PATCH profile` 的回包；`GET /onboarding` 的公共部分）。 */
export interface OnboardingState {
  childId: string
  onboarded: boolean
  onboardedAt: string | null
  ageBand: AgeBandName | null
  focusAreas: string[]
}

/** `GET /onboarding`：状态 + **已由服务端排好序**的模板库。 */
export interface OnboardingView extends OnboardingState {
  templates: RuleTemplate[]
}

/** `POST /onboarding/complete` 回包里的一条新规则。 */
export interface OnboardingCreatedRule {
  ruleId: string
  title: string
  points: number
  isPenalty: boolean
}

export interface OnboardingResult {
  childId: string
  onboardedAt: string
  rules: OnboardingCreatedRule[]
}

export interface SaveProfileInput {
  /** `undefined` = 没改（沿用库里已有值）；`null` = **显式清空**学段。 */
  ageBand?: AgeBandName | null
  /** `undefined` = 没改；`[]` = 一个都不选。 */
  focusAreas?: string[]
}

export interface CompleteOnboardingInput {
  templateSlugs: string[]
  ageBand?: AgeBandName | null
  focusAreas?: string[]
  /** `undefined` = 跳过第⑥步；空串在本地就被拒（后端 DTO 也会 400）。 */
  parentPin?: string
}

export interface OnboardingApi {
  fetch(): Promise<OnboardingView>
  saveProfile(input: SaveProfileInput): Promise<OnboardingState>
  complete(input: CompleteOnboardingInput): Promise<OnboardingResult>
  close?(): void
}

/**
 * `GET /onboarding` 的线格式解析。
 *
 * 形状自相矛盾一律 `malformed`（与 Flutter 侧 `OnboardingViewDto` 同口径）：
 *   · `onboarded` 与 `onboardedAt` 必须一致；
 *   · 模板 slug 非空且不重复；模板库不能为空（空库＝第⑤步无法继续）；
 *   · 模板分值 1–10、方向 `reward|penalty`、每天次数 1–10；
 *   · 学段 / 关注点必须是已知取值 —— 陌生值会让第③④步的排序解释不了。
 */
export function parseOnboardingView(raw: unknown): OnboardingView {
  const path = '$'
  const json = readObject(raw, path)
  const templates = readList(json, 'templates', `${path}.templates`).map(
    (item, index) => parseRuleTemplate(item, `${path}.templates[${index}]`)
  )

  const seen = new Set<string>()
  for (const template of templates) {
    if (seen.has(template.slug)) {
      throw ReadApiException.malformed(
        `${path}.templates`,
        `模板 slug 重复：${template.slug}`
      )
    }
    seen.add(template.slug)
  }
  if (templates.length === 0) {
    throw ReadApiException.malformed(
      `${path}.templates`,
      '模板库为空 —— 引导无法完成（至少需要 1 条 active 模板）'
    )
  }

  return {
    ...parseOnboardingState(json, path),
    templates
  }
}

export function parseOnboardingState(
  raw: unknown,
  path = '$'
): OnboardingState {
  const json = readObject(raw, path)
  const childId = readString(json, 'childId', `${path}.childId`)
  if (childId.trim() === '') {
    throw ReadApiException.malformed(`${path}.childId`, 'childId 不能为空')
  }

  const onboarded = readBool(json, 'onboarded', `${path}.onboarded`)
  const onboardedAt = readOptionalDate(json, 'onboardedAt', `${path}.onboardedAt`)
  if (onboarded !== (onboardedAt !== null)) {
    throw ReadApiException.malformed(
      `${path}.onboarded`,
      `onboarded=${onboarded} 与 onboardedAt=${onboardedAt} 不自洽（服务端按 !== null 派生）`
    )
  }

  const rawAgeBand = readOptionalString(json, 'ageBand', `${path}.ageBand`)
  if (rawAgeBand !== null && !isAgeBandName(rawAgeBand)) {
    throw ReadApiException.malformed(`${path}.ageBand`, `未知学段：${rawAgeBand}`)
  }

  const focusAreas = readList(json, 'focusAreas', `${path}.focusAreas`).map(
    (item, index) => readFocusArea(item, `${path}.focusAreas[${index}]`)
  )

  return {
    childId,
    onboarded,
    onboardedAt: onboardedAt === null ? null : new Date(onboardedAt).toISOString(),
    ageBand: rawAgeBand as AgeBandName | null,
    focusAreas
  }
}

function parseRuleTemplate(raw: unknown, path: string): RuleTemplate {
  const json = readObject(raw, path)
  const slug = readString(json, 'slug', `${path}.slug`)
  const title = readString(json, 'title', `${path}.title`)
  const condition = readString(json, 'condition', `${path}.condition`)
  const dailyLimit = readInt(json, 'dailyLimit', `${path}.dailyLimit`)
  const points = readInt(json, 'points', `${path}.points`)
  const direction = readString(json, 'direction', `${path}.direction`)
  const icon = readString(json, 'icon', `${path}.icon`)
  const color = readString(json, 'color', `${path}.color`)
  const rawAgeBand = readString(json, 'ageBand', `${path}.ageBand`)
  const sortWeight = readInt(json, 'sortWeight', `${path}.sortWeight`)
  const focusAreas = readList(json, 'focusAreas', `${path}.focusAreas`).map(
    (item, index) => readFocusArea(item, `${path}.focusAreas[${index}]`)
  )

  if (slug.trim() === '') {
    throw ReadApiException.malformed(`${path}.slug`, 'slug 不能为空')
  }
  if (title.trim() === '' || condition.trim() === '') {
    throw ReadApiException.malformed(
      `${path}.title`,
      'title / condition 不能为空（模板必须给出可判定的条件）'
    )
  }
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10) {
    throw ReadApiException.malformed(
      `${path}.dailyLimit`,
      `每天次数必须在 1–10 之间：${dailyLimit}`
    )
  }
  // 模板分值恒为正；负数说明服务端把方向揉进了分值（那会让「扣分」变成「加分」）。
  if (!Number.isInteger(points) || points < 1 || points > 10) {
    throw ReadApiException.malformed(
      `${path}.points`,
      `模板分值必须在 1–10 之间（方向单独给）：${points}`
    )
  }
  if (direction !== 'reward' && direction !== 'penalty') {
    throw ReadApiException.malformed(
      `${path}.direction`,
      `未知分值方向：${direction}`
    )
  }
  if (!isAgeBandName(rawAgeBand)) {
    throw ReadApiException.malformed(`${path}.ageBand`, `未知学段：${rawAgeBand}`)
  }
  if (icon.trim() === '') {
    throw ReadApiException.malformed(`${path}.icon`, 'icon 不能为空')
  }

  return {
    slug,
    title,
    condition,
    dailyLimit,
    points,
    isPenalty: direction === 'penalty',
    icon,
    color,
    ageBand: rawAgeBand,
    focusAreas,
    sortWeight
  }
}

/** 关注点必须是 6 个已知值之一（旧数据里的陌生标签会让排序失去解释）。 */
function readFocusArea(value: unknown, path: string): FocusAreaName {
  if (typeof value !== 'string') {
    throw ReadApiException.malformed(path, `期望关注点字符串，实际 ${typeof value}`)
  }
  if (!isFocusAreaName(value)) {
    throw ReadApiException.malformed(path, `未知关注点：${value}`)
  }
  return value
}


/**
 * `POST /onboarding/complete` 的回包。
 *
 * ★ `rules` 为空 ⇒ `malformed`：那正是「引导完成但一条规则都没建」的破损态
 *   （04 §3），首页会是空的，家长会以为引导没生效。宁可在这里红。
 */
export function parseOnboardingResult(raw: unknown): OnboardingResult {
  const path = '$'
  const json = readObject(raw, path)
  const childId = readString(json, 'childId', `${path}.childId`)
  const onboardedAt = readDate(json, 'onboardedAt', `${path}.onboardedAt`)
  const rules = readList(json, 'rules', `${path}.rules`).map((item, index) => {
    const rulePath = `${path}.rules[${index}]`
    const rule = readObject(item, rulePath)
    const ruleId = readString(rule, 'ruleId', `${rulePath}.ruleId`)
    const title = readString(rule, 'title', `${rulePath}.title`)
    const points = readInt(rule, 'points', `${rulePath}.points`)
    const direction = readString(rule, 'direction', `${rulePath}.direction`)

    if (ruleId.trim() === '') {
      throw ReadApiException.malformed(
        `${rulePath}.ruleId`,
        'ruleId 不能为空（否则首页刷新后点不到这条习惯）'
      )
    }
    if (!Number.isInteger(points) || points < 1) {
      throw ReadApiException.malformed(
        `${rulePath}.points`,
        `规则分值必须为正（方向单独给）：${points}`
      )
    }
    if (direction !== 'reward' && direction !== 'penalty') {
      throw ReadApiException.malformed(
        `${rulePath}.direction`,
        `未知分值方向：${direction}`
      )
    }

    return {
      ruleId,
      title,
      points,
      isPenalty: direction === 'penalty'
    }
  })

  if (rules.length === 0) {
    throw ReadApiException.malformed(
      `${path}.rules`,
      '完成引导却没有建出任何规则 —— 拒绝显示「已完成」'
    )
  }

  return { childId, onboardedAt: new Date(onboardedAt).toISOString(), rules }
}


/**
 * 引导客户端（`GET /onboarding` / `PATCH /onboarding/profile` / `POST /onboarding/complete`）。
 *
 * 错误全部归一成 `WriteApiException`：界面只处理一种异常，且
 * `403 CONSENT_REQUIRED` / `409 ONBOARDING_ALREADY_COMPLETED` /
 * `501 …NOT_IMPLEMENTED` 的业务码都能原样取到（`error.code`）。
 */
export class OnboardingApiClient implements OnboardingApi {
  private readonly config: ReadApiConfig
  private readonly transport: WriteTransport
  private readonly timeoutMs: number

  constructor(input: {
    config: ReadApiConfig
    transport?: WriteTransport
    timeoutMs?: number
  }) {
    this.config = input.config
    this.transport = input.transport ?? new TaroWriteTransport()
    this.timeoutMs = input.timeoutMs ?? 15000
  }

  async fetch(): Promise<OnboardingView> {
    return this.send('GET', '/onboarding', null, parseOnboardingView)
  }

  async saveProfile(input: SaveProfileInput): Promise<OnboardingState> {
    const body: Record<string, unknown> = {}
    if ('ageBand' in input) {
      // `null` 是**显式清空**（家长从小学低年级退回「未选择」），
      // 与「没传」是两种意图，必须能区分。
      body.ageBand = input.ageBand ?? null
    }
    if (input.focusAreas !== undefined) {
      body.focusAreas = normalizeFocusAreas(input.focusAreas)
    }
    if (Object.keys(body).length === 0) {
      throw new Error(
        'saveProfile 没有任何要保存的字段：学段与关注点都没传，等于一次无意义往返。'
      )
    }
    return this.send('PATCH', '/onboarding/profile', body, (raw) =>
      parseOnboardingState(raw)
    )
  }

  async complete(input: CompleteOnboardingInput): Promise<OnboardingResult> {
    const slugs = normalizeTemplateSlugs(input.templateSlugs)
    if (slugs.length === 0) {
      throw new Error(
        '至少采纳 1 条约定才能完成引导（04 §6 4.2）—— 这次没有发请求。'
      )
    }
    if (slugs.length > 18) {
      throw new Error(`一次最多采纳 18 条约定（本次 ${slugs.length} 条）。`)
    }

    const pin = input.parentPin?.trim()
    if (pin !== undefined && pin === '') {
      // 空串是客户端 bug，不是「跳过」；跳过请省略这个字段。
      throw new Error('parentPin 不能是空串：不设 PIN 请省略这个字段。')
    }
    if (pin !== undefined && !/^\d{4,6}$/.test(pin)) {
      throw new Error('家长 PIN 必须是 4–6 位数字；不想设置就留空。')
    }

    const body: Record<string, unknown> = { templateSlugs: slugs }
    if (input.ageBand !== undefined && input.ageBand !== null) {
      body.ageBand = input.ageBand
    }
    if (input.focusAreas !== undefined) {
      body.focusAreas = normalizeFocusAreas(input.focusAreas)
    }
    if (pin !== undefined) body.parentPin = pin

    return this.send('POST', '/onboarding/complete', body, (raw) =>
      parseOnboardingResult(raw)
    )
  }

  close(): void {
    this.transport.close?.()
  }

  private async send<T>(
    method: WriteMethod,
    path: string,
    body: Record<string, unknown> | null,
    parse: (raw: unknown) => T
  ): Promise<T> {
    const configError = this.config.validationError
    if (configError !== null) {
      throw new WriteApiException('badRequest', configError, {
        code: 'CLIENT_NOT_CONFIGURED'
      })
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      [kDeviceIdHeader]: this.config.effectiveDeviceId,
      [kChildIdHeader]: this.config.effectiveChildId
    }
    // W9-A：引导期三条路由同样要 Bearer（`POST /onboarding/*` 都在登录之后）。
    const authorization = sharedAuthTokens.authorizationHeader()
    if (authorization !== null) headers[kAuthorizationHeader] = authorization
    // GET 绝不声明 Content-Type：严格后端会拒绝「GET 带 JSON 空体」。
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }

    let response: WriteHttpResponse
    try {
      response = await withTimeout(
        this.transport.send(
          this.config.uri(path),
          headers,
          body,
          this.timeoutMs,
          method
        ),
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
    try {
      return parse(decoded)
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }
}


/** 关注点保序去重 + 白名单（后端 DTO 也会 400，但本地拒绝能省一次往返）。 */
export function normalizeFocusAreas(input: readonly string[]): FocusAreaName[] {
  const seen = new Set<string>()
  const result: FocusAreaName[] = []
  for (const raw of input) {
    const value = raw.trim()
    if (!isFocusAreaName(value)) {
      throw new Error(`「${raw}」不是已知关注点。`)
    }
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** slug 保序去重（与后端 `normalizeTemplateSlugs` 同语义）。 */
export function normalizeTemplateSlugs(input: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of input) {
    const value = raw.trim()
    if (value === '') continue
    if (value.length > 64) {
      throw new Error('模板 slug 不能超过 64 字符')
    }
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export function createOnboardingApiFromEnvironment(
  env: ReadEnvironment = defaultEnvironment()
): OnboardingApi | null {
  const config = ReadApiConfig.fromEnvironment(env)
  return config.isConfigured ? new OnboardingApiClient({ config }) : null
}

function defaultEnvironment(): ReadEnvironment {
  // ★ 同上：`process.env` 整体在小程序里是空 polyfill，必须逐键静态读。
  return readCompiledEnvironment()
}

/** `Taro.request` 已带超时，但部分平台不遵守它 —— 客户端再兜一层。 */
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

function decodeBody(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw
}

