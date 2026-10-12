/**
 * 临时脚本：把 H5 构建产物（dist/）以 HTTP 方式提供出来，供 h5_probe.js 用无头 Chrome 实测。
 * 用法：node .tmp_test/h5_serve.js   （默认端口 10086）
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', 'dist')
const PORT = Number(process.env.PORT || 10086)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
}

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    const file = path.join(ROOT, urlPath)
    if (!file.startsWith(ROOT)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(fs.readFileSync(file))
      return
    }
    // 路由（history 模式）落到 index.html
    const index = path.join(ROOT, 'index.html')
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(fs.readFileSync(index))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`)
  })
