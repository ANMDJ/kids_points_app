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
 * ── 方向性约束（02 §3 屏障三，本文件**不实现判定**）──────────────────
 * `restrictions` 只能把矩阵的 `ALLOW` **收紧**为 `REQUIRE_APPROVAL` / `DENY`，
 * **永远不能把 `DENY` 放宽**：最终判定 = `min(矩阵判定, 成员级限制)`，
 * 严苛度 `DENY > REQUIRE_APPROVAL > ALLOW`（`contracts/permission-matrix.ts` 的 `stricter()`）。
 * ⚠️ 本阶段（D-b）只**定形**：写入/读取路径尚未开工（全仓 `restrictions` 引用 0 处），
 *    所以本文件此刻**还没有被任何 HTTP 路径调用** —— 别把它的存在读成"屏障三已验收"。
 */

import 'reflect-metadata'

import { plainToInstance } from 'class-transformer'
import { IsBoolean, IsInt, IsOptional, Min, validateSync } from 'class-validator'

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
