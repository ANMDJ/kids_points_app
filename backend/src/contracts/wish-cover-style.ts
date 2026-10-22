import type { WishCoverStyle } from '@prisma/client'

/**
 * 心愿插画配色的**唯一算法**（`docs/design/03` E16 / PRD FR-04）。
 *
 * ── 这一步在修什么 ────────────────────────────────────────────────────────
 *   原实现是 `backgroundIndex = wishes.length % 4`：配色由**插入那一刻的列表长度**
 *   决定。删掉中间一个心愿后，后续新增会与既有心愿撞色，既有心愿的配色也可能跳变。
 *
 * ── 现在的规则（与双端本地实现逐字同源）──────────────────────────────────
 *   ① 还有空档：按 A → D 补**第一个**空档（新增不与既有撞色）；
 *   ② 四个都占满：由 `id` 的稳定哈希取值 —— 允许撞色，但**永不漂移**。
 *
 * ★ 三端各有一份实现（这里 / `lib/models/wish.dart` / `kids_points_mp/src/data/types.ts`），
 *   这是**刻意**的：客户端要在离线（预览模式）下立刻算出同一个颜色，服务端要在落库时
 *   给出最终值。三处的算式必须一字不差；`backend/test/wish-cover-style.test.ts`
 *   钉住了服务端这一份的形状（含空档优先与哈希兜底）。
 */
export const WISH_COVER_STYLES: readonly WishCoverStyle[] = ['A', 'B', 'C', 'D']

/**
 * id → 稳定哈希（跨端同源：Flutter `wishCoverHash` / Taro `wishCoverHash` 用同一算式）。
 * 取模前的 `% 1000003` 只为避免大数，与配色语义无关。
 */
export function wishCoverHash(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 1_000_003
  }
  return hash
}

/**
 * 挑一个配色 —— **与列表长度无关**，所以删项不会让既有心愿变色。
 *
 * @param taken 当前**活动**心愿已占用的配色（回收站里的不参与：它们不在列表上，配色可回收）
 * @param id    这条心愿自己的 id（只在四个都占满时用到）
 */
export function pickCoverStyle(
  taken: readonly WishCoverStyle[],
  id: string
): WishCoverStyle {
  const used = new Set<WishCoverStyle>(taken)
  const free = WISH_COVER_STYLES.find((style) => !used.has(style))
  if (free !== undefined) return free
  return WISH_COVER_STYLES[wishCoverHash(id) % WISH_COVER_STYLES.length]
}
