/**
 * lib/fetch.js — 三级网页抓取核心（浏览头条文章的经验载体）。
 *
 * 从工作区脚本 tools/webfetch.mjs 移植为可嵌入 DSH 宿主进程的模块：
 *   1. direct-fetch   —— 静态直连最快（~1s）；域名缓存记住「哪些站必须走浏览器」，跳过试探
 *   2. Edge CDP 常驻  —— 首次冷启动 ~20s 后常驻（默认端口 9333），单次抓取 ~3-6s；
 *                        复用常驻标签页（省 ~4s），禁图 + 屏蔽字节跳动 CDN 加速；
 *                        质询页（安全验证/__ac_signature/acrawler）自动等 reload 宽限窗口
 *   3. dump-dom 兜底  —— CDP 不可用时一次性渲染
 *
 * 与工作区脚本 tools/webfetch.mjs 共享 %TEMP% 下的常驻浏览器
 * （webfetch-edge.pid / webfetch-tab.id / webfetch-profile 同名），脚本与插件
 * 互相加速：任一边冷启动的常驻浏览器，另一边直接复用。
 *
 * 头条经验要点（为什么这样写）：
 *   - 头条静态 HTML 会命中反爬特征（__ac_nonce/__ac_signature/acrawler），
 *     必须真浏览器渲染才拿得到 <article> 正文；
 *   - 解过一次质询后页面可能 reload 一次，所以首见域名保留 1.2s 宽限窗口
 *     再取最终文本（domain cache 记为 solved 后跳过宽限，省 1.2s）；
 *   - 抓头条时图片/字体/埋点请求占大头，Network.setBlockedURLs 屏蔽后明显提速。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 质询/反爬页特征：命中即视为「该域必须走浏览器」。 */
const CHALLENGE =
  /安全验证|滑动验证|__ac_nonce|__ac_signature|acrawler|Just a moment|verify_me|captcha|请开启.*JavaScript|cf-chl/i

/** CDP 阶段屏蔽的请求（图片/字体/视频/统计），禁图是刻意的提速手段。 */
const BLOCKED_URLS = [
  '*.jpg', '*.jpeg', '*.png', '*.gif', '*.webp', '*.avif', '*.mp4', '*.m3u8',
  '*.woff2', '*.woff', '*.ttf', '*.otf',
  '*pstatp*', '*byteimg*', '*bytegoofy*', '*log.snssdk*', '*mcs.snssdk*',
  '*mon.snssdk*', '*doubleclick*', '*googletag*',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findBrowser(override) {
  if (override && fs.existsSync(override)) return override
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

/** HTML → { title, text }：优先 <article>/article-content，再退全文；实体解码 + 空白归一。 */
export function extractText(html) {
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = tm ? tm[1].trim() : '(no title)'
  let body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  let m = body.match(/<article[^>]*class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<\/article>/i)
    || body.match(/<div[^>]*class="[^"]*article-content[^"]*"[^>]*>([\s\S]*?)<div[^>]*class="[^"]*article-footer/i)
    || body.match(/<div[^>]*id="article-content"[^>]*>([\s\S]*?)<\/div>/i)
  if (!m) {
    const arts = [...body.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)].map((x) => x[1]).sort((a, b) => b.length - a.length)
    if (arts.length) m = [null, arts[0]]
  }
  const content = m ? m[1] : body
  const text = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim()
  return { title, text }
}

/**
 * 创建抓取器实例。
 * @param {object} opts
 * @param {number}  opts.cdpPort          CDP 调试端口，默认 9333
 * @param {string}  opts.browserPath      Edge/Chrome 可执行文件覆盖；空则自动探测
 * @param {string}  opts.domainCachePath  域名缓存路径；空则 %TEMP%/webfetch-domains.json
 */
export function createFetcher(opts = {}) {
  const cdpPort = Number(opts.cdpPort) > 0 ? Number(opts.cdpPort) : 9333
  const browserOverride = typeof opts.browserPath === 'string' ? opts.browserPath : ''
  const pidFile = path.join(os.tmpdir(), 'webfetch-edge.pid')
  const profile = path.join(os.tmpdir(), 'webfetch-profile')
  const tabFile = path.join(os.tmpdir(), 'webfetch-tab.id')
  const cachePath =
    typeof opts.domainCachePath === 'string' && opts.domainCachePath.trim()
      ? opts.domainCachePath.trim()
      : path.join(os.tmpdir(), 'webfetch-domains.json')

  const readCache = () => { try { return JSON.parse(fs.readFileSync(cachePath, 'utf8')) } catch { return {} } }
  const writeCache = (c) => { try { fs.writeFileSync(cachePath, JSON.stringify(c, null, 2)) } catch { /* 缓存失败不影响抓取 */ } }

  const aborted = (signal) => { if (signal && signal.aborted) throw new Error('已取消') }

  async function directFetch(u, signal) {
    try {
      const timeout = AbortSignal.timeout(15000)
      const sig = signal ? AbortSignal.any([timeout, signal]) : timeout
      const r = await fetch(u, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: sig, redirect: 'follow',
      })
      return await r.text()
    } catch { return null }
  }

  // ---------- CDP 常驻浏览器 ----------
  async function daemonAlive() {
    try {
      const r = await fetch('http://127.0.0.1:' + cdpPort + '/json/version', { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch { return false }
  }

  async function startDaemon() {
    const browser = findBrowser(browserOverride)
    if (!browser) throw new Error('未找到 Edge/Chrome，可在插件配置 browserPath 指定')
    const child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
      '--disable-blink-features=AutomationControlled',
      '--blink-settings=imagesEnabled=false',
      '--user-data-dir=' + profile,
      '--remote-debugging-port=' + cdpPort,
      '--window-size=1280,3000', 'about:blank',
    ], { detached: true, stdio: 'ignore' })
    child.unref()
    try { fs.writeFileSync(pidFile, String(child.pid)) } catch { /* pid 记录失败只影响手动管理 */ }
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      await sleep(300)
      if (await daemonAlive()) return
    }
    throw new Error('CDP 端点未就绪')
  }

  async function getTab() {
    // 优先复用上次的常驻标签页（省 ~2s 新建 + ~2s 关闭）
    try {
      const savedId = fs.readFileSync(tabFile, 'utf8').trim()
      const list = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list', { signal: AbortSignal.timeout(3000) })).json()
      const found = list.find((t) => t.id === savedId && t.type === 'page')
      if (found) return found
    } catch { /* 落到新建 */ }
    const tab = await newTab()
    try { fs.writeFileSync(tabFile, tab.id) } catch { /* tab 复用只是优化 */ }
    return tab
  }

  async function newTab() {
    for (const method of ['PUT', 'GET']) {
      try {
        const r = await fetch('http://127.0.0.1:' + cdpPort + '/json/new?about:blank', { method, signal: AbortSignal.timeout(5000) })
        if (r.ok) return await r.json()
      } catch { /* 试下一种方法 */ }
    }
    throw new Error('无法新建标签页')
  }

  async function cdpFetch(u, skipGrace, log, signal) {
    const tab = await getTab()
    const ws = new WebSocket(tab.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')) })
    let mid = 0
    const pending = new Map()
    ws.onmessage = (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
      }
    }
    const send = (method, params) => new Promise((resolve, reject) => {
      const i = ++mid; pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
    try {
      const T0 = Date.now()
      const tick = (m) => log('[cdp +' + (Date.now() - T0) + 'ms] ' + m)
      await send('Page.enable')
      tick('page.enabled')
      try {
        await send('Network.enable')
        await send('Network.setBlockedURLs', { urls: BLOCKED_URLS })
      } catch { /* 屏蔽失败不影响主流程 */ }
      await send('Page.navigate', { url: u })
      tick('navigated')
      // 等待策略：质询页(reload) → 真页面。见到正文先留 1.2s 宽限给 reload 窗口，再取 <article> 干净文本
      const EXPR = "(() => { const a = document.querySelector('article'); const x = a ? a.innerText : (document.body ? document.body.innerText : ''); return {t: document.title, x: x, n: x.length, ready: document.readyState}; })()"
      const deadline = Date.now() + 30000
      let text = '', title = '', graceDone = false
      while (Date.now() < deadline) {
        aborted(signal)
        await sleep(250)
        let v
        try {
          const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true })
          v = r.result && r.result.value
        } catch { continue } // 导航/reload 期间上下文销毁，跳过本轮
        if (!v) continue
        text = v.x || ''; title = v.t || ''
        if (!(v.ready === 'complete' && v.n > 500)) { tick('waiting, n=' + v.n); continue } // 质询页/加载中
        if (!graceDone && !skipGrace) { graceDone = true; tick('grace 1.2s'); await sleep(1200); continue }
        break
      }
      tick('done, text ' + text.length + ' chars')
      return { title: (title || '').trim(), text: (text || '').trim() }
    } finally {
      try { ws.close() } catch { /* 标签页保留复用，不关闭 */ }
    }
  }

  // ---------- 兜底：一次性 dump-dom ----------
  async function edgeDump(u, tmpHtml) {
    const browser = findBrowser(browserOverride)
    if (!browser) throw new Error('未找到 Edge/Chrome，无法兜底渲染')
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
      '--disable-blink-features=AutomationControlled',
      '--user-data-dir=' + profile,
      '--virtual-time-budget=8000', '--window-size=1280,3000',
      '--dump-dom', u,
    ]
    const out = fs.openSync(tmpHtml, 'w')
    try {
      // 输出走文件重定向（沙箱/宿主下管道捕获不可靠）；stderr 丢弃——
      // Crashpad/沙箱报错日志曾混入输出被误当正文，这里只留 stdout 的 DOM
      const p = spawn(browser, args, { stdio: ['ignore', out, 'ignore'] })
      const deadline = Date.now() + 40000
      let lastSize = -1, stable = 0
      while (Date.now() < deadline) {
        await sleep(500)
        if (p.exitCode !== null || p.signalCode) break
        let size = 0; try { size = fs.fstatSync(out).size } catch { /* 下一轮再探 */ }
        if (size > 50000 && size === lastSize) { if (++stable >= 2) break } else stable = 0
        lastSize = size
      }
      if (p.exitCode === null && !p.signalCode) {
        try { spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 超时兜底清理 */ }
        await sleep(600)
      }
    } finally { try { fs.closeSync(out) } catch { /* 已尽力 */ } }
    const dom = fs.readFileSync(tmpHtml, 'utf8')
    if (!/<html[\s>]/i.test(dom)) throw new Error('兜底渲染未产出 DOM（浏览器启动失败或被安全软件拦截）')
    return dom
  }

  /**
   * 抓取一篇文章。这是唯一的公开入口。
   * @param {string} url                    http/https 文章 URL
   * @param {object} [o]
   * @param {AbortSignal} [o.signal]        协作式取消信号
   * @param {(m: string) => void} [o.log]   过程日志回调
   * @returns {Promise<{method:'direct-fetch'|'headless-cdp'|'headless-dumpdom', title:string, text:string}>}
   * @throws 全部三级均失败、URL 非法或被取消时抛错
   */
  async function fetchArticle(url, o = {}) {
    const signal = o.signal
    const log = typeof o.log === 'function' ? o.log : () => {}
    if (!/^https?:\/\//i.test(url || '')) throw new Error('仅支持 http/https URL: ' + url)
    const domain = new URL(url).hostname
    const cache = readCache()
    aborted(signal)

    let html = null
    if (cache[domain] == null) {
      log('direct-fetch 试探 ' + domain)
      html = await directFetch(url, signal)
      const bad = !html || html.length < 8000 || CHALLENGE.test(html) || !/<title[^>]*>\S/i.test(html)
      if (bad) { html = null; cache[domain] = 'browser'; writeCache(cache) }
    }

    if (html) {
      const { title, text } = extractText(html)
      return { method: 'direct-fetch', title, text }
    }

    // 浏览器通道：优先 CDP 常驻，失败退回 dump-dom
    try {
      if (!(await daemonAlive())) { log('启动常驻无头浏览器（首次冷启动 ~20s）'); await startDaemon() }
      const { title, text } = await cdpFetch(url, cache[domain] === 'solved', log, signal)
      if (!text || text.length < 100) throw new Error('CDP 内容过短')
      cache[domain] = 'solved'; writeCache(cache)
      return { method: 'headless-cdp', title, text }
    } catch (e) {
      if (signal && signal.aborted) throw new Error('已取消')
      log('CDP 失败(' + (e && e.message ? e.message : e) + ')，退回 dump-dom')
    }

    const tmpHtml = path.join(os.tmpdir(), 'webfetch-dom.html')
    const html2 = await edgeDump(url, tmpHtml)
    const { title, text } = extractText(html2)
    if (!text || text.length < 50) {
      throw new Error('三级策略均未取到正文（可能是视频页、问答页或需要登录的页面）')
    }
    return { method: 'headless-dumpdom', title, text }
  }

  return { fetchArticle }
}
