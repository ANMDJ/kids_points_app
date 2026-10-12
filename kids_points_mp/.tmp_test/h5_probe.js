/**
 * 临时脚本：用无头 Chrome（CDP over ws）真实渲染 H5 构建产物，量出「新增心愿」悬浮按钮的实际计算样式。
 *
 * 用法：
 *   1) node .tmp_test/h5_serve.js          # 另开一个终端，提供 http://127.0.0.1:10086
 *   2) node .tmp_test/h5_probe.js [标签]    # 标签用于截图命名，默认 now
 *
 * 输出：每个视口/状态打印一份 JSON，并截图到 .tmp_test/<标签>-<视口>.png
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const WebSocket = require('ws')

const CHROME =
  process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9333)
const BASE = `http://127.0.0.1:${process.env.H5_PORT || 10086}`
const PROFILE = path.join(__dirname, 'chrome-profile')
const TAG = process.argv[2] || 'now'

/** 两个视口：矮屏（列表可滚动 → 收起成圆形） / 高屏（列表比视口短 → 直接展开） */
const VIEWS = [
  { name: 'short650', width: 390, height: 650 },
  { name: 'tall900', width: 390, height: 900 }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (r) => {
        let data = ''
        r.on('data', (c) => (data += c))
        r.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (error) {
            reject(error)
          }
        })
      })
      .on('error', reject)
  })
}

async function waitEndpoint() {
  for (let i = 0; i < 100; i += 1) {
    try {
      return await httpGetJson(`http://127.0.0.1:${PORT}/json/list`)
    } catch (error) {
      await sleep(200)
    }
  }
  throw new Error('Chrome remote debugging 未就绪')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id)
        pending.delete(msg.id)
        entry.resolve(msg)
      }
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        send(method, params = {}) {
          const id = (seq += 1)
          return new Promise((res) => {
            pending.set(id, { resolve: res })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        close() {
          ws.close()
        }
      })
    )
  })
}

async function evaluate(client, expression) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  const payload = res.result || {}
  if (payload.exceptionDetails) {
    throw new Error(JSON.stringify(payload.exceptionDetails).slice(0, 500))
  }
  return payload.result ? payload.result.value : undefined
}

async function exists(client, selector, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = await evaluate(client, `!!document.querySelector(${JSON.stringify(selector)})`)
    if (found) return true
    await sleep(300)
  }
  return false
}

/** 页面内探头：把和悬浮按钮有关的计算样式 + 布局矩形都取出来 */
const PROBE = `(() => {
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const pick = (el, props) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const out = {}
    props.forEach((p) => (out[p] = cs[p]))
    return out
  }
  const fab = document.querySelector('.kp-fab')
  if (!fab) return { ok: false, reason: 'no .kp-fab' }
  const wrap = document.querySelector('.kp-wishlist__fab')
  const label = document.querySelector('.kp-fab__label')
  const iconWrap = document.querySelector('.kp-fab__icon')
  const icon = document.querySelector('.kp-fab .kp-icon')
  const scroller = document.querySelector('.kp-wishlist__scroll')
  return {
    ok: true,
    href: location.href,
    expanded: fab.className.indexOf('is-expanded') >= 0,
    fabInlineStyle: fab.getAttribute('style'),
    fabRect: rect(fab),
    fab: pick(fab, ['width', 'height', 'borderRadius', 'boxShadow', 'opacity', 'backgroundImage', 'overflow', 'display', 'justifyContent']),
    wrapRect: rect(wrap),
    wrap: pick(wrap, ['position', 'right', 'bottom', 'zIndex']),
    label: pick(label, ['display', 'width', 'maxWidth', 'opacity', 'fontSize', 'paddingRight']),
    labelRect: rect(label),
    labelText: label && label.textContent,
    iconWrapRect: rect(iconWrap),
    iconWrap: pick(iconWrap, ['transform', 'marginRight', 'transition']),
    iconInlineStyle: icon && icon.getAttribute('style'),
    iconRect: rect(icon),
    icon: pick(icon, ['width', 'height', 'backgroundImage']),
    scroller: scroller ? { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, className: scroller.className } : null,
    title: (document.querySelector('.kp-wishlist__title') || {}).textContent,
    points: (document.querySelector('.kp-wishlist__points') || {}).textContent,
    firstCardIconRect: rect(document.querySelector('.kp-wishlist__grid .kp-icon')),
    bodyText: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 80)
  }
})()`

async function scrollToBottom(client) {
  return evaluate(
    client,
    `(() => {
      const scroller = document.querySelector('.kp-wishlist__scroll')
      if (!scroller) return { scrollable: false }
      const target = scroller.scrollHeight > scroller.clientHeight ? scroller : scroller.querySelector('*')
      if (!target || target.scrollHeight <= target.clientHeight) return { scrollable: false }
      target.scrollTop = target.scrollHeight
      target.dispatchEvent(new Event('scroll', { bubbles: true }))
      return { scrollable: true, scrollTop: target.scrollTop, scrollHeight: target.scrollHeight, clientHeight: target.clientHeight }
    })()`
  )
}

async function shot(client, name) {
  const res = await client.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(__dirname, `${TAG}-${name}.png`)
  fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'))
  return file
}

function report(title, data, file) {
  console.log(`\n===== ${title} =====`)
  console.log(JSON.stringify(data, null, 2))
  if (file) console.log(`截图: ${file}`)
}

async function loadWishlist(client) {
  const candidates = [`${BASE}/#/pages/wishlist/index`, `${BASE}/pages/wishlist/index`, `${BASE}/`]
  for (const url of candidates) {
    await client.send('Page.navigate', { url })
    if (await exists(client, '.kp-fab', 12000)) return url
  }
  throw new Error('三种路由都没渲染出 .kp-fab')
}

;(async () => {
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  try {
    const list = await waitEndpoint()
    const page = list.find((t) => t.type === 'page')
    if (!page) throw new Error('没有可用的 page target')
    const client = await connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')

    for (const view of VIEWS) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: view.width,
        height: view.height,
        deviceScaleFactor: 1,
        mobile: true
      })
      const url = await loadWishlist(client)
      await sleep(1500) // 等 useReady 的 measure() 与首帧动画稳定
      report(
        `视口 ${view.width}x${view.height}（${url}）加载后`,
        await evaluate(client, PROBE),
        await shot(client, view.name)
      )

      const scrolled = await scrollToBottom(client)
      if (scrolled.scrollable) {
        await sleep(900) // 等 340ms 补间动画结束
        report(
          `视口 ${view.width}x${view.height} 滚到底后`,
          { scrolled, probe: await evaluate(client, PROBE) },
          await shot(client, `${view.name}-scrolled`)
        )
      } else {
        console.log(`\n[${view.name}] 列表不可滚动：${JSON.stringify(scrolled)}`)
      }
    }
    client.close()
  } finally {
    chrome.kill()
  }
})().catch((error) => {
  console.error('probe 失败: ' + error.message)
  process.exitCode = 1
})
