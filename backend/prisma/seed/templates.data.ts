/**
 * 规则模板数据（docs/design/04 §3 / §4）
 *
 * ★ P2 决策（用户 2026-10-12 裁定）：**不追求 90 条**，以当前设计内容为模板开发。
 *   原计划 O1 的「90 条模板 / 2.0 人日」按此决策降级。
 *
 * ★ 关键澄清（一处必须对齐的语义）：
 *   04 §4 的分值规范把扣分写作「−1 ~ −3」，而 schema 规定 `points` **恒为正**、
 *   正负由 `direction` 表达（这是修 A1 的根源 —— 原实现用 `Math.abs()` 把负分抹平成加分）。
 *   因此：**扣分模板写作 `points: 2, direction: 'penalty'`**，
 *   展示值 = `direction === 'penalty' ? -points : points`。
 *   绝不允许为了「看起来直观」而存负值 —— 那会让 A1 有第二条复发路径。
 *
 * ★ 图标名必须来自 kids_points_mp/src/components/Icon/icons.ts 的 ICONS 键集合，
 *   配色必须来自既有主题色板。写错名字在编译期不报错，只会在渲染时静默缺失。
 *   本文件的 `validateTemplates()` 会拦住这类错误。
 *   **修 D9**：下面这份名单是**手抄**的（后端不能 import 小程序的 TS），所以它必须与
 *   `ICONS` 的键集合、Flutter 侧 `lib/theme/app_icons.dart` 的 `appIcons` 键集合**逐字相等** ——
 *   由 `npm run icons:check`（`tools/icon-names-check.mjs`）比对：手抄漂移就红。
 */

export const ICON_NAMES = [
  'home',
  'homeFill',
  'heart',
  'heartFill',
  'smile',
  'book',
  'stories',
  'backpack',
  'clipboard',
  'gift',
  'palette',
  'music',
  'basketball',
  'spray',
  'trophy',
  'star',
  'starFill',
  'plus',
  'minus',
  'check',
  'pencil',
  'editNote',
  'chevronLeft',
  'chevronRight',
  'copy',
  'close',
  'listCheck',
  'trash',
  // 修 D9：兜底占位（白名单之外的名字画它）—— 与 icons.ts / app_icons.dart 的 `unknown` 同名。
  // 放进白名单而不是另立一份，是为了让「三份名单相等」这条闸门一句话说得清。
  'unknown'
] as const

/** 既有主题色板（lib/theme/app_colors.dart + kids_points_mp/src/data/seed.ts 实际取值） */
export const PALETTE = [
  '#7fbf55', // primaryDeep 绿
  '#7bb0e8', // 蓝
  '#f5a24b', // orange
  '#8fbf6a', // 浅绿
  '#f6c64a', // starYellow
  '#e9834b' // pointSpend 深橙
] as const

export const AGE_BANDS = ['preschool', 'primary_low', 'primary_high', 'junior_high'] as const
export const FOCUS_AREAS = ['作业专注', '生活习惯', '阅读', '运动', '情绪管理', '家务'] as const

export type AgeBandName = (typeof AGE_BANDS)[number]
export type FocusAreaName = (typeof FOCUS_AREAS)[number]
export type IconName = (typeof ICON_NAMES)[number]

export interface RuleTemplateSeed {
  slug: string
  title: string
  /** 结构字段：可判定的达成条件（「专注 25 分钟」可判定；「好好学习」不可判定 —— 04 §4） */
  condition: string
  /** 结构字段：频次上限（数字，不是自由文本 —— 修 A2 / E15） */
  dailyLimit: number
  /** 恒为正；奖惩由 direction 表达 */
  points: number
  direction: 'reward' | 'penalty'
  icon: IconName
  color: string
  ageBand: AgeBandName
  focusAreas: FocusAreaName[]
  sortWeight: number
}

/** 04 §4 分值规范：日常小习惯 1–2 / 日常任务 2–3 / 持续投入 3–5 / 周频次 5–10 / 扣分 1–3 */
export const RULE_TEMPLATES: RuleTemplateSeed[] = [
  // ── 作业专注 ────────────────────────────────────────────────
  { slug: 'pomodoro-homework', title: '番茄钟写作业', condition: '专注 25 分钟', dailyLimit: 2, points: 3, direction: 'reward', icon: 'pencil', color: '#7bb0e8', ageBand: 'primary_high', focusAreas: ['作业专注'], sortWeight: 100 },
  { slug: 'homework-start-in-1h', title: '先完成作业再玩', condition: '放学后 1 小时内开始写作业', dailyLimit: 1, points: 2, direction: 'reward', icon: 'clipboard', color: '#7bb0e8', ageBand: 'primary_low', focusAreas: ['作业专注'], sortWeight: 90 },
  { slug: 'self-check-homework', title: '自己检查作业', condition: '逐题检查并订正错题', dailyLimit: 1, points: 3, direction: 'reward', icon: 'check', color: '#7bb0e8', ageBand: 'primary_high', focusAreas: ['作业专注'], sortWeight: 86 },
  { slug: 'practice-piano-30min', title: '练琴 30 分钟', condition: '连续练习 30 分钟', dailyLimit: 1, points: 4, direction: 'reward', icon: 'music', color: '#f5a24b', ageBand: 'primary_high', focusAreas: ['作业专注'], sortWeight: 82 },

  // ── 阅读 ───────────────────────────────────────────────────
  { slug: 'read-20min', title: '自主阅读 20 分钟', condition: '连续阅读 20 分钟', dailyLimit: 1, points: 3, direction: 'reward', icon: 'book', color: '#7fbf55', ageBand: 'primary_low', focusAreas: ['阅读'], sortWeight: 95 },
  { slug: 'read-aloud-10min', title: '朗读绘本 10 分钟', condition: '朗读 10 分钟', dailyLimit: 1, points: 2, direction: 'reward', icon: 'stories', color: '#7fbf55', ageBand: 'preschool', focusAreas: ['阅读'], sortWeight: 80 },

  // ── 生活习惯 ────────────────────────────────────────────────
  { slug: 'wake-up-on-time', title: '按时起床', condition: '闹钟响后 10 分钟内起床', dailyLimit: 1, points: 1, direction: 'reward', icon: 'smile', color: '#f6c64a', ageBand: 'primary_low', focusAreas: ['生活习惯'], sortWeight: 85 },
  { slug: 'brush-teeth-twice', title: '早晚刷牙', condition: '每次刷满 2 分钟', dailyLimit: 2, points: 1, direction: 'reward', icon: 'spray', color: '#7bb0e8', ageBand: 'primary_low', focusAreas: ['生活习惯'], sortWeight: 70 },
  { slug: 'pack-schoolbag', title: '自己收书包', condition: '整理好第二天要带的东西', dailyLimit: 1, points: 2, direction: 'reward', icon: 'backpack', color: '#f5a24b', ageBand: 'primary_low', focusAreas: ['生活习惯', '家务'], sortWeight: 75 },
  { slug: 'sleep-on-time', title: '按时睡觉', condition: '21:30 前上床', dailyLimit: 1, points: 2, direction: 'reward', icon: 'star', color: '#7bb0e8', ageBand: 'primary_low', focusAreas: ['生活习惯'], sortWeight: 78 },

  // ── 运动 ───────────────────────────────────────────────────
  { slug: 'exercise-30min', title: '运动 30 分钟', condition: '连续运动 30 分钟', dailyLimit: 1, points: 4, direction: 'reward', icon: 'basketball', color: '#f5a24b', ageBand: 'primary_high', focusAreas: ['运动'], sortWeight: 88 },
  { slug: 'jump-rope-300', title: '跳绳 300 个', condition: '完成 300 个跳绳', dailyLimit: 1, points: 2, direction: 'reward', icon: 'basketball', color: '#8fbf6a', ageBand: 'primary_low', focusAreas: ['运动'], sortWeight: 60 },

  // ── 情绪管理 ────────────────────────────────────────────────
  { slug: 'share-feelings', title: '说出今天的心情', condition: '睡前用一句话描述今天的感受', dailyLimit: 1, points: 2, direction: 'reward', icon: 'heart', color: '#7bb0e8', ageBand: 'primary_low', focusAreas: ['情绪管理'], sortWeight: 76 },
  { slug: 'deep-breath-when-angry', title: '生气时先深呼吸', condition: '主动使用深呼吸 3 次', dailyLimit: 2, points: 2, direction: 'reward', icon: 'smile', color: '#7fbf55', ageBand: 'primary_low', focusAreas: ['情绪管理'], sortWeight: 74 },

  // ── 家务 ───────────────────────────────────────────────────
  { slug: 'help-with-chores', title: '帮忙做家务', condition: '完成一件家务（摆碗筷 / 浇花 / 叠衣服）', dailyLimit: 1, points: 2, direction: 'reward', icon: 'listCheck', color: '#8fbf6a', ageBand: 'primary_low', focusAreas: ['家务'], sortWeight: 72 },
  { slug: 'weekend-cleaning', title: '周末大扫除', condition: '参与 30 分钟家庭大扫除', dailyLimit: 1, points: 6, direction: 'reward', icon: 'spray', color: '#8fbf6a', ageBand: 'primary_high', focusAreas: ['家务', '生活习惯'], sortWeight: 68 },

  // ── 扣分约定（points 恒为正，方向由 direction 表达）──────────
  // 04 §4「−1 ~ −3」在此表达为 points: 1–3 + direction: 'penalty'。
  // 04 §6 用例 4.5：采纳的扣分模板**不能**加入今日习惯（与 A1 的修复保持一致）。
  { slug: 'penalty-talk-back', title: '顶嘴', condition: '对家人说难听的话', dailyLimit: 1, points: 2, direction: 'penalty', icon: 'close', color: '#e9834b', ageBand: 'primary_low', focusAreas: ['情绪管理'], sortWeight: 50 },
  { slug: 'penalty-late-sleep', title: '不按时睡觉', condition: '超过约定时间仍未上床', dailyLimit: 1, points: 1, direction: 'penalty', icon: 'minus', color: '#e9834b', ageBand: 'primary_low', focusAreas: ['生活习惯'], sortWeight: 45 }
]

/**
 * 离线自检 —— **不需要数据库**。
 *
 * 存在意义：这些约束（图标名是否真实存在、分值是否越界、slug 是否重复）在
 * TypeScript 编译期**不会报错**，只会在运行时静默失效（图标不显示 / 积分体系失衡）。
 * 一个不会失败的检查等于没有检查（D12 / D13 的同类教训）。
 *
 * @returns 错误信息数组；空数组表示全部通过
 */
export function validateTemplates(list: RuleTemplateSeed[] = RULE_TEMPLATES): string[] {
  const errors: string[] = []
  const seen = new Set<string>()

  for (const t of list) {
    const where = `[${t.slug}]`
    if (seen.has(t.slug)) errors.push(`${where} slug 重复`)
    seen.add(t.slug)

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.slug)) errors.push(`${where} slug 必须是 kebab-case`)
    if (t.title.trim() === '') errors.push(`${where} title 为空`)
    if (t.condition.trim() === '') errors.push(`${where} condition 为空（结构字段，不可省略）`)

    // 04 §4 约束：单条模板 points ≤ 10（超出会让积分体系失去「积累感」）
    if (!Number.isInteger(t.points) || t.points < 1 || t.points > 10) {
      errors.push(`${where} points=${t.points} 越界（必须为 1–10 的整数；扣分也用正值 + direction）`)
    }
    if (!Number.isInteger(t.dailyLimit) || t.dailyLimit < 1 || t.dailyLimit > 5) {
      errors.push(`${where} dailyLimit=${t.dailyLimit} 不合理（必须为 1–5 的整数）`)
    }
    if (!(ICON_NAMES as readonly string[]).includes(t.icon)) {
      errors.push(`${where} icon="${t.icon}" 不在真实图标集合中（渲染时会静默缺失）`)
    }
    if (!(PALETTE as readonly string[]).includes(t.color)) {
      errors.push(`${where} color="${t.color}" 不在主题色板中（会造成配色漂移）`)
    }
    if (!(AGE_BANDS as readonly string[]).includes(t.ageBand)) {
      errors.push(`${where} ageBand="${t.ageBand}" 非法`)
    }
    if (t.focusAreas.length === 0) {
      errors.push(`${where} focusAreas 为空（会导致模板无法被筛选出来）`)
    }
    for (const f of t.focusAreas) {
      if (!(FOCUS_AREAS as readonly string[]).includes(f)) errors.push(`${where} focusArea="${f}" 非法`)
    }
    if (t.direction === 'penalty' && t.points > 3) {
      errors.push(`${where} 扣分模板 points=${t.points} 超出 04 §4 规范的 1–3`)
    }
  }

  // 覆盖度：6 个关注点都必须至少有一条模板，否则引导第⑤步会出现空分组
  for (const area of FOCUS_AREAS) {
    if (!list.some((t) => t.focusAreas.includes(area))) {
      errors.push(`关注点「${area}」没有任何模板 —— 引导会出现空分组`)
    }
  }

  return errors
}
