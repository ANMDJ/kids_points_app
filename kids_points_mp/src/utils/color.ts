/**
 * 颜色工具：Flutter 的 Color.withAlpha(0..255) 语义转成 CSS 的 rgba()。
 */

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((char) => char + char)
          .join('')
      : clean
  const num = parseInt(full, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

/** hex 颜色 + 透明度（0~1，对应 Flutter withAlpha(/255)）→ rgba() 字符串。 */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`
}
