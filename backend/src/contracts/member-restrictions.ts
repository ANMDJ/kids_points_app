/**
 * ChildMemberRestrictions —— 屏障三「成员级收紧」的**唯一权威形状**（docs/design/02 §3；06 §3.1 决策 D3b）
 *
 * ── 这一步在修什么 ───────────────────────────────────────────────
 * `ChildMember.restrictions` 是**裸 `Json`**：形状只写在 `schema.prisma` 的注释里
 * （`/// 形状：{ childCannotUndoCheckIn?, ... }`），**编译器不比对**。
 * 谁往里塞 `{ childCannotUndoCheckIn: 'yes' }` 或把键名拼错成 `childCannotAddwis`，
 * 编译期与运行期都**没有东西会拦**，而限制会**静默失效**（比报错更危险）。
 *
 * 与 D1b（`relation` 升枚举 `RelationKind`）同构：真相原来只在注释里。
 * 区别在于：Prisma **无法表达 `Json` 的内部形状**，所以定形只能落在应用层 ——
 *   ① **类型**：下面的 class（`ChildMemberRestrictions`）
 *   ② **运行时守卫**：`validateRestrictions()`（fail-closed，多余键也拒 —— 形状=集合封闭）
 *   ③ **守门人**：`npm run restrictions:check`（本文件是权威，闸门比对另两处手抄）
 *
 * ── 三处手抄（与 D1b 完全同构，改键名必须同时改三处）────────────────
 *   ① 本文件的 `RESTRICTION_KEYS`（**可执行**，权威）
 *   ② `backend/prisma/schema.prisma` 里 `restrictions` 上方那行 `/// 形状：{ ... }` 注释
 *   ③ `docs/design/02-rbac-and-approval.md` §3 屏障三的代码块
 * 由 `tools/restrictions-check.mjs` 逐字比对（`npm run restrictions:check`）。
 *
 * ── 方向性约束（02 §3 屏障三）───────────────────────────────────────
 * `restrictions` 只能把矩阵的 `ALLOW` **收紧**为 `REQUIRE_APPROVAL` / `DENY`，
 * **永远不能把 `DENY` 放宽**：最终判定 = `min(矩阵判定, 成员级限制)`，
 * 严苛度 `DENY > REQUIRE_APPROVAL > ALLOW`（`contracts/permission-matrix.ts` 的 `stricter()`）。
 * 收紧的**实现**就是下面的 `tightenVerdict()`（W1-B 加的）。
 *
 * ── 本文件的两个阶段（都把话写清楚，免得被读成"已验收"）────────────────
 *   · **D-b（2026-10-13）＝ 定形**：`RESTRICTION_KEYS` ＋ `validateRestrictions()`。
 *     当时全仓 `restrictions` 引用 **0 处** —— 本文件没有被任何请求路径调用。
 *   · **W1-B（2026-10-15）＝ 判定 ＋ 接线**：新增 `tightenVerdict()`（屏障三的判定核），
 *     并由 `PermissionsGuard` 在请求路径上调用；`validateRestrictions()` 也终于有了
 *     **请求路径上的调用方**（`MembershipGuard` 读成员位时校验裸 `Json`，不合格 → 500）。
 *   ⚠️ **仍未落地**：`requireApprovalForBonusOver` 需要**金额**才判得动，而当前唯一调用方
 *     拿不到金额（它属 dispatcher 的 payload，`02` §6 尚未落地）—— 该键此刻在 HTTP 路径上
 *     **不会生效**，这一点有专门的用例钉着（不是"假装在拦"）。
 */

import 'reflect-metadata'

import { plainToInstance } from 'class-transformer'
import { IsBoolean, IsInt, IsOptional, Min, validateSync } from 'class-validator'

import { stricter, type ActionType, type Role, type Verdict } from './permission-matrix'

/**
 * 允许出现的键 —— **可执行的形状清单**（闸门比对的就是它）。
 * 顺序即 `schema.prisma` 注释与 `02` §3 代码块里的书写顺序：三处**逐字逐序**相等。
 */
export const RESTRICTION_KEYS = [
  'childCannotUndoCheckIn',
  'childCannotAddWish',
  'requireApprovalForBonusOver'
] as const

export type RestrictionKey = (typeof RESTRICTION_KEYS)[number]

/**
 * Q15（02 §3）：`requireApprovalForBonusOver` 的**产品默认阈值** = ±50 分。
 * ⚠️ 这只是"默认值本身"：何时套用该默认、以及正负号如何判定，属于写入路径落地时的事，
 *    本阶段只把形状钉住 —— 不假装屏障三的判定已经实现。
 */
export const DEFAULT_REQUIRE_APPROVAL_FOR_BONUS_OVER = 50

/**
 * 形状：三个键**全部可选**（`@default("{}")` 必须是合法输入），
 * 但**每个键都有运行时类型约束**，且**集合封闭**（多余键被 `forbidNonWhitelisted` 拒绝）。
 *
 * `@IsOptional() + @IsBoolean()`：布尔开关类限制（选了才生效）。
 * `@IsOptional() + @IsInt() + @Min(0)`：阈值类限制（负数/小数/字符串数字都不合法）。
 */
export class ChildMemberRestrictions {
  /** 02 §3：孩子不能撤销自己的打卡（把矩阵的 `ALLOW` 收紧） */
  @IsOptional()
  @IsBoolean()
  childCannotUndoCheckIn?: boolean

  /** 02 §3：孩子不能自己添加心愿（`add_wish` 本来已是 `REQUIRE_APPROVAL`，这里是逐孩子再加严） */
  @IsOptional()
  @IsBoolean()
  childCannotAddWish?: boolean

  /** 02 §3 ／ Q15：超过 N 分的加分需审批（默认阈值见 `DEFAULT_REQUIRE_APPROVAL_FOR_BONUS_OVER`） */
  @IsOptional()
  @IsInt()
  @Min(0)
  requireApprovalForBonusOver?: number
}

/** `restrictions Json @default("{}")` 对应的空形状（合法输入之一，也是 A 段自检的基准）。 */
export const DEFAULT_RESTRICTIONS: ChildMemberRestrictions = {}

/** 错误信息里的"实际收到了什么"：`typeof null === 'object'`、数组也是 `object`，必须分开说。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return '数组'
  return typeof value
}

/**
 * 运行时守卫 —— **fail-closed**：非对象、多余键、类型不对、越界，一律返回非空错误数组。
 *
 * 为什么"多余键也拒"：`restrictions` 的病就是形状不明 —— 允许未知键等于把裸 `Json`
 * 换个地方继续裸着（`childCannotAddWish` 拼成 `childCannotAddwis` 时静默通过 = 限制悄悄失效）。
 * 这与 `main.ts` 全局 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` 同一口径，
 * 但**必须能被离线脚本直接调用**（不能只藏在 HTTP 管道里，否则裸 `Json` 入库的路径它管不到）。
 *
 * ★ 传入裸对象（不是 class 实例）时，装饰器不会自动生效 —— 所以先 `plainToInstance()`。
 *
 * @returns 错误信息数组；空数组表示形状合法（与 `validateTemplates()` 同款契约）
 */
export function validateRestrictions(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [
      `restrictions 必须是对象（收到 ${describe(value)}）—— 形状为 { ${RESTRICTION_KEYS.map(
        (k) => `${k}?`
      ).join(', ')} }`
    ]
  }
  const instance = plainToInstance(ChildMemberRestrictions, value)
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true
  })
  return errors.flatMap((e) =>
    Object.entries(e.constraints ?? {}).map(([rule, message]) => `${e.property}：${message}（${rule}）`)
  )
}

/**
 * 屏障三的输入：**被判定的动作** ＋ 会话角色（＋ 金额类限制需要的业务参数）。
 */
export interface TighteningInput {
  action: ActionType
  /**
   * 会话角色（`02` §7 的角色模式）。
   * ★ 与 `Actor.role` **同类型**（含 `'viewer'`）：收紧规则全部挂在 `child` 上，
   *   而 `viewer` 在矩阵里已一律 `DENY`（它也不可能是任何孩子的成员位 —— `MemberRole`
   *   只有 guardian / child）—— 于是"给它收紧"这件事不存在，**不成立**比**没有**更准确。
   *   ⚠️ 若把它窄化成 `Role`，调用方就得在 Guard 里加一次**无意义的类型断言** ——
   *      那种断言正是将来 `viewer` 真的出现时会被静默骗过去的东西。
   */
  role: Role | 'viewer'
  /** 申请金额（加分：`request_points_bonus`）。拿不到就不判 —— 见 `tightenVerdict()` 的说明。 */
  amount?: number
}

/**
 * 屏障三：成员级收紧的**判定核**（`02` §3 / §9.22）。
 *
 *     最终判定 = min(矩阵判定, 成员级限制)      // 严苛度 DENY > REQUIRE_APPROVAL > ALLOW
 *
 * ── 方向性由 `stricter()` **结构性**保证 ─────────────────────────────────
 *   返回值恒为 `stricter(矩阵判定, 限制判定)`，而限制判定从 `ALLOW`（= 不额外收紧）出发，
 *   之后每次赋值都经由 `stricter(...)` —— 于是「限制**只能更严**」不是一句约定，
 *   而是这段代码的形状：`matrixVerdict = 'DENY'` 时返回值**必然**是 `DENY`（§9.22）。
 *   写两句 `memberVerdict = 'X'` 而不用 `stricter` 也能过用例，但那把方向性押在
 *   "三条规则恰好作用于三个不同的动作"这个**当下成立、将来会变**的巧合上。
 *
 * ── 三条规则的适用范围（来自键名本身，不是凭空约定）──────────────────────
 *   `childCannotUndoCheckIn`  child ＋ `undo_check_in`        ⇒ DENY
 *       ⚠️ 对**当前**矩阵这**不改变结果**（`undo_check_in.child` 已是 `DENY`）。
 *          它防的是将来矩阵被放宽 —— 那时这条成员级约定仍然拦得住（这正是 §9.22 的意义）。
 *   `childCannotAddWish`      child ＋ `add_wish`             ⇒ DENY
 *       （矩阵里是 `REQUIRE_APPROVAL` ⇒ 这是**真的**收紧：从"要家长点头"变成"不许"）
 *   `requireApprovalForBonusOver: N`
 *                             child ＋ `request_points_bonus` ＋ 金额 ⇒ REQUIRE_APPROVAL
 *       ⚠️ **需要金额**。当前唯一调用方（`PermissionsGuard`）拿不到金额 ⇒ 该键在 HTTP 路径上
 *          **不生效**。它真正的接入点是 `02` §6 的 dispatcher（把孩子 `adjust_points(delta>0)`
 *          归一化为 `request_points_bonus` 时会带上金额），由 dispatcher 调本函数并传 `amount`。
 *          `membership-http.test.ts` 有一条用例**把这个现状钉住**（免得被误读成"已经在拦了"）。
 *
 * ★ 为什么取**绝对值**：`amount > N` 在收到负数时会**静默不收紧**（fail-open）——
 *   而 `02` §3 / Q15 讲的是"超过 N 分"（写作 ±50，指的是**幅度**）。
 *   用 `Math.abs` 是这里唯一 fail-closed 的写法。
 */
export function tightenVerdict(
  matrixVerdict: Verdict,
  restrictions: ChildMemberRestrictions,
  input: TighteningInput
): Verdict {
  // 起步 = 不额外收紧；此后**只经由 `stricter()`** 变严。
  let memberVerdict: Verdict = 'ALLOW'

  if (input.role === 'child') {
    if (input.action === 'undo_check_in' && restrictions.childCannotUndoCheckIn === true) {
      memberVerdict = stricter(memberVerdict, 'DENY')
    }

    if (input.action === 'add_wish' && restrictions.childCannotAddWish === true) {
      memberVerdict = stricter(memberVerdict, 'DENY')
    }

    const threshold = restrictions.requireApprovalForBonusOver
    if (
      input.action === 'request_points_bonus' &&
      threshold !== undefined &&
      input.amount !== undefined &&
      Math.abs(input.amount) > threshold
    ) {
      memberVerdict = stricter(memberVerdict, 'REQUIRE_APPROVAL')
    }
  }

  return stricter(matrixVerdict, memberVerdict)
}
