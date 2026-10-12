const CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * 把纯 ASCII 字符串编码成 base64。
 *
 * 小程序环境没有 btoa / Buffer，而 iOS 微信对“URL 编码的 SVG data URI”
 * 支持不稳定，base64 才是最稳的写法，所以这里自己实现一份（输入只含 ASCII）。
 */
export function toBase64(input: string): string {
  let output = ''
  for (let i = 0; i < input.length; i += 3) {
    const hasTwo = i + 1 < input.length
    const hasThree = i + 2 < input.length
    const c1 = input.charCodeAt(i) & 0xff
    const c2 = hasTwo ? input.charCodeAt(i + 1) & 0xff : 0
    const c3 = hasThree ? input.charCodeAt(i + 2) & 0xff : 0
    const e1 = c1 >> 2
    const e2 = ((c1 & 3) << 4) | (c2 >> 4)
    const e3 = ((c2 & 15) << 2) | (c3 >> 6)
    const e4 = c3 & 63
    output += CHARS.charAt(e1) + CHARS.charAt(e2)
    output += hasTwo ? CHARS.charAt(e3) : '='
    output += hasThree ? CHARS.charAt(e4) : '='
  }
  return output
}

/** SVG 源码 → `data:image/svg+xml;base64,...`。 */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${toBase64(svg)}`
}
