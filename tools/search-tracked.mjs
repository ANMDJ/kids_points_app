#!/usr/bin/env node
/**
 * search-tracked.mjs —— 「只搜会被提交的文件」的仓库级检索（编译产物天然不在其中）
 *
 * 存在理由（2026-11-02 实测）：
 *   ① 内置 `search_codebase` 工具**没有路径过滤参数**，它自己的遍历器只认一份硬编码黑名单
 *      `["node_modules","vendor",".git","dist","build",".next","coverage","__pycache__",
 *        ".venv","venv",".cache",".turbo",".output","out","target","bin","obj"]`
 *      —— 里面**没有** `.dart_tool`、`.widget_preview`、`ios/Flutter/ephemeral`。
 *   ② `.ignore` / `.gitignore` 对它无效（同一查询实测：`flutter_build|package_config` 的
 *      17 条命中全部落在 `.widget_preview/.dart_tool/**` 与 `ios/Flutter/ephemeral/**`）。
 *   ③ 它报「Searched 1519 files」，而 `git ls-files --cached --others --exclude-standard`
 *      只有 793 个 —— 差额 726 个几乎全是生成物。
 *
 * 由此确立口径：**git 不会提交的东西，就不是查问题的证据**。
 *   · 构建产物（build/、.dart_tool/、dist/、node_modules/）—— 从 .gitignore 出来，搜它只有噪音；
 *   · 真正要查的是**源文件 + 报错原文 + 配置**，这三样一个都在版本库里。
 *
 * 本脚本 = 把这条口径做成命令：
 *   文件集 = `git ls-files --cached --others --exclude-standard`
 *            （= 已跟踪 ＋ 未跟踪但未被忽略；正好是「未来 commit 可能包含的全部文件」）
 *   再叠一层**硬黑名单**兜底：万一有人 `git add -f` 把产物塞进库里，这里也跳过并告警。
 *
 * 用法：
 *   node tools/search-tracked.mjs <正则>                 # 默认：忽略大小写、2 行上下文、最多 100 条
 *   node tools/search-tracked.mjs <正则> --case-sensitive
 *   node tools/search-tracked.mjs <正则> --context 0 --max 20
 *   node tools/search-tracked.mjs <正则> --files-only     # 只看命中的文件清单
 *   node tools/search-tracked.mjs --self-test             # 自检：产物一条不许进、源码一条不许漏
 *
 * 退出码：0 = 有命中；1 = 无命中；2 = 用法错误。自检失败一律退出码 1。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const SELF_DIR = resolve(import.meta.dirname, '..')

/** 兜底黑名单：即使被 `git add -f` 入库，也不当证据。写成相对仓库根的路径片段。 */
const FORBIDDEN = [
  '.dart_tool/',
  '.widget_preview/',
  'node_modules/',
  '/dist/',
  '/build/',
  'ios/Pods/',
  'ios/Flutter/ephemeral/',
  '/.gradle/',
  '/.next/',
  '/coverage/',
]

const MAX_LINE_CHARS = 400
const MAX_FILE_BYTES = 2 * 1024 * 1024

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })

function repoRoot() {
  try {
    return git(SELF_DIR, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
}

/** 归一成 posix 风格，供黑名单匹配（Windows 上 git 给的是 `/` 分隔，兜底统一一次）。 */
const toPosix = (rel) => rel.split(sep).join('/')

function isForbidden(rel) {
  const norm = `/${toPosix(rel)}`
  return FORBIDDEN.some((frag) => norm.includes(frag))
}

/** = 「未来 commit 可能包含的全部文件」；产物按 .gitignore 早已不在其中。 */
function committedFileList(root) {
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return [...new Set(out.split('\0').filter(Boolean))].sort()
}

function readText(abs) {
  const buf = readFileSync(abs)
  if (buf.subarray(0, 8192).includes(0)) return null // 二进制
  return buf.toString('utf8')
}

function buildContext(lines, index, contextLines) {
  if (contextLines <= 0) return []
  const from = Math.max(0, index - contextLines)
  const to = Math.min(lines.length - 1, index + contextLines)
  const out = []
  for (let i = from; i <= to; i += 1) {
    const mark = i === index ? '>' : ' '
    out.push(`${mark} ${i + 1}: ${lines[i].slice(0, MAX_LINE_CHARS)}`)
  }
  return out
}

function search(root, pattern, options) {
  const re = new RegExp(pattern, options.ignoreCase ? 'gi' : 'g')
  const files = committedFileList(root)
  const hits = []
  const skipped = []
  let scanned = 0

  for (const rel of files) {
    if (isForbidden(rel)) {
      skipped.push(rel) // 兜底：真的被 add -f 过，也不当证据
      continue
    }
    const abs = join(root, rel)
    if (!existsSync(abs)) continue // `--cached` 会带出「已删但仍在索引」的条目
    let size
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      size = st.size
    } catch {
      continue
    }
    if (size > MAX_FILE_BYTES) continue

    const text = readText(abs)
    if (text === null) continue
    scanned += 1

    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (hits.length >= options.max) break
      re.lastIndex = 0
      let m
      while ((m = re.exec(lines[i])) !== null) {
        if (hits.length >= options.max) break
        hits.push({
          file: rel,
          line: i + 1,
          column: m.index + 1,
          context: buildContext(lines, i, options.context),
        })
        if (m.index === re.lastIndex) re.lastIndex += 1
      }
    }
    if (hits.length >= options.max) break
  }

  return { hits, scanned, total: files.length, skipped }
}

function parseArgs(argv) {
  const options = { ignoreCase: true, context: 2, max: 100, filesOnly: false, selfTest: false }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--self-test') options.selfTest = true
    else if (arg === '--files-only') options.filesOnly = true
    else if (arg === '--case-sensitive') options.ignoreCase = false
    else if (arg === '--ignore-case') options.ignoreCase = true
    else if (arg === '--context') options.context = Number.parseInt(argv[(i += 1)], 10)
    else if (arg === '--max') options.max = Number.parseInt(argv[(i += 1)], 10)
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    else rest.push(arg)
  }
  if (Number.isNaN(options.context) || options.context < 0) throw new Error('--context 必须是 >= 0 的整数')
  if (Number.isNaN(options.max) || options.max < 1) throw new Error('--max 必须是 >= 1 的整数')
  return { options, pattern: rest[0], extra: rest.slice(1) }
}

function render(result, pattern, options, root) {
  const { hits, scanned, total, skipped } = result
  const lines = []
  const scope = `Searched ${scanned} files（git 跟踪 ＋ 未忽略的新文件，文件集共 ${total} 个；编译产物 / 依赖不在其中）`

  if (hits.length === 0) {
    lines.push(`No results found for pattern: ${pattern}`, scope, '')
  } else if (options.filesOnly) {
    const files = [...new Set(hits.map((h) => h.file))]
    lines.push(`Found ${hits.length} match(es) in ${files.length} file(s) for pattern: ${pattern}`, scope, '')
    lines.push(...files, '')
  } else {
    lines.push(`Found ${hits.length} result${hits.length === 1 ? '' : 's'} for pattern: ${pattern}`, scope, '')
    for (const hit of hits) {
      lines.push(`${hit.file}:${hit.line}:${hit.column}`)
      lines.push(...hit.context, '')
    }
    if (hits.length >= options.max) {
      lines.push(`(Showing first ${options.max} results. 用更具体的 pattern，或调大 --max。)`)
    }
  }

  if (skipped.length > 0) {
    lines.push(
      `⚠ 跳过了 ${skipped.length} 个「已被 git 跟踪的产物路径」（被 add -f 过？）：${skipped.slice(0, 5).join(', ')}${
        skipped.length > 5 ? ' …' : ''
      }`,
      `  它们不该入库：请在 ${root} 里从索引移除，见 .gitignore / .ignore。`
    )
  }
  return lines.join('\n').trimEnd()
}

/** 自检：产物一条不许进（反例必须空），源码一条不许漏（控制例必须有）。 */
function selfTest(root) {
  const SELF = 'tools/search-tracked.mjs'
  const base = { ignoreCase: true, context: 0, max: 50, filesOnly: true }
  const outOfSelf = (r) => r.hits.filter((h) => h.file !== SELF) // 本脚本的注释里会写这些 token，自检要排除自己
  const cases = []

  // 反例：这两个 token 只出现在生成物里（.dart_tool/package_config.json / ios/Flutter/ephemeral）
  for (const pattern of ['configVersion', 'FLUTTER_BUILD_DIR']) {
    const hits = outOfSelf(search(root, pattern, base))
    cases.push({
      name: `反例「${pattern}」必须 0 命中（它只存在于编译产物）`,
      ok: hits.length === 0,
      detail: hits.map((h) => h.file).join(', '),
    })
  }

  // 控制例：产品里到处都是的请求头名 —— 证明过滤没把源码一起滤掉
  const control = outOfSelf(search(root, 'x-kp-device-id', base))
  cases.push({
    name: '控制例「x-kp-device-id」必须命中源码（.ts）',
    ok: control.some((h) => h.file.endsWith('.ts')),
    detail: control.map((h) => h.file).slice(0, 5).join(', '),
  })

  let failed = 0
  for (const c of cases) {
    if (!c.ok) failed += 1
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : ` —— 实际命中：${c.detail}`}`)
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : `FAILED ${failed} 项`}  （共 ${cases.length} 项自检）`)
  return failed === 0
}

const USAGE =
  '用法：node tools/search-tracked.mjs <正则> [--case-sensitive] [--context N] [--max N] [--files-only] | --self-test'

function main() {
  const root = repoRoot()
  if (!root) {
    console.error('不在 git 仓库里：本脚本靠 `git ls-files` 取文件集，没有 git 就没有「提交口径」。')
    process.exitCode = 2
    return
  }

  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`)
    process.exitCode = 2
    return
  }

  if (parsed.options.selfTest) {
    process.exitCode = selfTest(root) ? 0 : 1
    return
  }
  if (!parsed.pattern || parsed.extra.length > 0) {
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  const result = search(root, parsed.pattern, parsed.options)
  console.log(render(result, parsed.pattern, parsed.options, root))
  process.exitCode = result.hits.length > 0 ? 0 : 1
}

main()
