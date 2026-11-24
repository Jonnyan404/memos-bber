#!/usr/bin/env node
/**
 * Real-browser UI verification for the Chrome bundle (zero npm dependencies).
 *
 * It launches Chrome/Chromium with the unpacked extension, opens
 * chrome-extension://<id>/popup.html as a normal tab, drives the real popup UI
 * (settings + send) through the DevTools Protocol, and asserts both the toast
 * text and the state on the server.
 *
 * Prerequisites:
 *   - a Memos instance reachable at --url with a valid access token (--token)
 *   - Chrome for Testing (preferred) or any Chromium with extension support.
 *     Playwright's cached CfT is auto-detected, otherwise set CHROME_PATH.
 *
 * Examples:
 *   node tools/verify/chrome-ui.mjs --url http://127.0.0.1:15400/ --token "$TOKEN"
 *   node tools/verify/chrome-ui.mjs --url ... --token ... --scenario public-forbidden
 *   node tools/verify/chrome-ui.mjs --url ... --token ... --extension firefox --chrome "/path/to/Chrome"
 *
 * Flags: --headless=false to watch it, --keep to leave the browser open.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function arg(name, fallback = '') {
  // Both `--key value` and `--key=value`; the latter avoids quoting problems
  // for values with `?` in them (e.g. popup.html?mode=full on a shell line).
  const inline = process.argv.find((a) => a.startsWith('--' + name + '='))
  if (inline) return inline.slice(name.length + 3)
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : 'true'
}
const has = (name) => process.argv.includes('--' + name)

const TARGET_URL = arg('url', 'http://127.0.0.1:15400/').replace(/\/+$/, '') + '/'
const SUBPATH = arg('subpath', '')
let URL_BASE = TARGET_URL
const TOKEN = arg('token', process.env.MEMOS_TOKEN || '')
const EXT_DIR = path.resolve(ROOT, arg('extension', 'chrome'))
const SCENARIO = arg('scenario', 'success')
const SCREENSHOT = arg('screenshot', '')
// Emulate a phone-width popup (Firefox for Android renders it in a full-width
// panel) and assert the shared layout still fits and stays tappable.
const MOBILE = has('mobile')
// Which page to open: the toolbar popup, or the full-tab editor.
const PAGE = arg('page', 'popup.html')
// Optional explicit viewport, e.g. --viewport 1280x800.
const VIEW = (() => {
  const raw = arg('viewport', '')
  const m = /^(\d+)x(\d+)$/.exec(raw)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
})()
const HEADLESS = arg('headless', 'true') !== 'false'
const KEEP = has('keep')
const PORT = Number(arg('port', '9444'))
const TEXT = arg('text', 'chrome-ui check ' + new Date().toISOString())
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

if (!TOKEN) {
  console.error('missing --token (Memos access token)')
  process.exit(2)
}

function extensionId(dir) {
  const hex = createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  // Prefer Chrome for Testing (branded Chrome may ignore --load-extension).
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache).filter((n) => n.startsWith('chromium-'))) {
      for (const plat of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac']) {
        const bin = path.join(cache, entry, plat, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
        if (fs.existsSync(bin)) return bin
      }
    }
  }
  for (const bin of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ]) {
    if (fs.existsSync(bin)) return bin
  }
  throw new Error('no Chrome/Chromium found; set CHROME_PATH')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Chrome may still be flushing its profile when we kill it; retry a few times
// instead of failing the whole check with ENOTEMPTY.
function removeProfile(dir, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (i === attempts - 1) return
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    }
  }
}

// Serve the Memos instance under a sub-path (e.g. https://host/memos/) so the
// extension's apiUrl-with-prefix handling is exercised, not just root deploys.
async function startSubpathProxy(targetBase, prefix) {
  const target = new URL(targetBase)
  const server = http.createServer(async (req, res) => {
    if (req.url !== prefix && !req.url.startsWith(prefix + '/')) {
      res.writeHead(404)
      res.end('not under ' + prefix)
      return
    }
    const rest = req.url.slice(prefix.length) || '/'
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const headers = { ...req.headers }
    delete headers.host
    delete headers.connection
    try {
      const upstream = await fetch(target.origin + target.pathname.replace(/\/$/, '') + rest, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        redirect: 'manual'
      })
      const responseHeaders = Object.fromEntries(upstream.headers)
      res.writeHead(upstream.status, responseHeaders)
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (err) {
      res.writeHead(502)
      res.end(String(err && err.message ? err.message : err))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, base: `http://127.0.0.1:${port}${prefix}/` }
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error('websocket error: ' + (e.message || 'unknown'))))
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }
  async send(method, params = {}) {
    await this.ready
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try {
      this.ws.close()
    } catch (_) {
      /* ignore */
    }
  }
}

async function httpJson(pathname, options) {
  const resp = await fetch(`http://127.0.0.1:${PORT}${pathname}`, options)
  const text = await resp.text()
  try {
    return JSON.parse(text)
  } catch (_) {
    return { raw: text, status: resp.status }
  }
}

async function waitForEndpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const version = await httpJson('/json/version')
      if (version.webSocketDebuggerUrl) return version
    } catch (_) {
      /* not up */
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools endpoint did not start')
}

async function openTarget(url) {
  // PUT /json/new is the only endpoint that works across versions without CDP.
  const created = await httpJson(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  const targetId = created.id
  for (let i = 0; i < 20; i++) {
    const list = await httpJson('/json/list')
    const target = (Array.isArray(list) ? list : []).find((t) => t.id === targetId)
    if (target && target.webSocketDebuggerUrl) return target
    await sleep(150)
  }
  throw new Error('target did not expose a websocket url')
}

// The DevTools endpoint answers before the freshly started browser registers the
// unpacked extension, so the first popup load can land on
// chrome-error://chromewebdata. That shows up as one random matrix job failing
// per night, so retry and require the real extension origin: an error page still
// has a non-empty title (it is the requested URL), which is why a title check
// alone proves nothing.
async function openPopup(url, attempts = 15) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    const target = await openTarget(url)
    const cdp = new Cdp(target.webSocketDebuggerUrl)
    try {
      await cdp.send('Runtime.enable')
      const state = await cdp.send('Runtime.evaluate', {
        expression: '({ origin: location.protocol, title: document.title, href: location.href })',
        returnByValue: true
      })
      const value = state && state.result ? state.result.value : null
      if (value && value.origin === 'chrome-extension:') return { cdp, title: value.title, href: value.href }
      last = value
    } catch (err) {
      last = { error: err.message }
    }
    cdp.close()
    await httpJson(`/json/close/${target.id}`).catch(() => {})
    await sleep(500)
  }
  throw new Error(
    'popup did not load (extension id mismatch or extension disabled); last=' + JSON.stringify(last)
  )
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true
  })
  if (result.exceptionDetails) {
    throw new Error('page error: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
  }
  return result.result.value
}

async function waitFor(cdp, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // Expressions are usually promises (chrome.storage callbacks); await them.
    const value = await evaluate(cdp, expression, { awaitPromise: true }).catch(() => false)
    if (value) return true
    await sleep(150)
  }
  return false
}

// Per-instance values live in memosInstances / instanceRuntime_<id> /
// instanceFiles_<id> now, so assertions must not read the old top-level keys --
// that would pass only on an install that has not been migrated yet. These
// mirror what get_info() hands to the popup: globals plus the active instance
// and its runtime flattened over them.
function activeInstanceExpr(probe) {
  return `new Promise((r) => chrome.storage.sync.get(null, (all) => {
    const list = Array.isArray(all.memosInstances) ? all.memosInstances : []
    const base = list.filter((x) => x.id === all.activeInstanceId)[0] || list[0] || {}
    const active = Object.assign({}, base,
      base.id ? all['instanceRuntime_' + base.id] || {} : {},
      base.id ? all['instanceFiles_' + base.id] || {} : {})
    r(Boolean(${probe}))
  }))`
}

async function readInstanceState(cdp) {
  return evaluate(
    cdp,
    `new Promise((r) => chrome.storage.sync.get(null, (all) => {
      const list = Array.isArray(all.memosInstances) ? all.memosInstances : []
      const active = list.filter((x) => x.id === all.activeInstanceId)[0] || list[0] || {}
      const runtime = active.id ? all['instanceRuntime_' + active.id] || {} : {}
      const files = active.id ? all['instanceFiles_' + active.id] || {} : {}
      r(Object.assign({}, all, active, runtime, files, {
        instances: list,
        activeId: all.activeInstanceId || '',
        raw: all
      }))
    }))`,
    { awaitPromise: true }
  )
}

async function capture(cdp, file) {
  await cdp.send('Page.enable').catch(() => {})
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log('screenshot:', file)
}

async function waitForToast(cdp, pattern, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const text = await evaluate(cdp, `(document.querySelector('.tip-info') || {}).textContent || ''`).catch(() => '')
    if (text) last = text
    if (text && pattern.test(text)) return text
    await sleep(150)
  }
  return last
}

// Toasts linger ~2s. Waiting for the previous one to clear is what stops a
// stale message being read as the outcome of the next action: the settings
// save confirmation also ends in "Success".
async function waitForToastToClear(cdp, timeoutMs = 4000) {
  await waitFor(
    cdp,
    `(() => {
      const el = document.querySelector('.tip-info')
      return !el || !String(el.textContent || '').trim()
    })()`,
    timeoutMs
  )
}

// `exclude` guards against the same class of mistake: a leftover toast whose
// text happens to match the pattern we are waiting for.
async function readToast(cdp, timeoutMs = 12000, exclude = null) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await evaluate(cdp, `(document.querySelector('.tip-info') || {}).textContent || ''`).catch(() => '')
    // Skip the transient "sending" toast, keep the final outcome.
    if (text && !/发送中|Sending/i.test(text) && !(exclude && exclude.test(text))) return text
    await sleep(200)
  }
  return ''
}

let cachedUserRef = null
async function currentUserRef() {
  if (cachedUserRef !== null) return cachedUserRef
  const attempts = [
    ['GET', 'api/v1/auth/me'],
    ['GET', 'api/auth/me'],
    ['POST', 'api/v1/auth/status'],
    ['POST', 'api/auth/status'],
    ['GET', 'api/v1/user/me'],
    ['GET', 'api/user/me']
  ]
  for (const [method, p] of attempts) {
    try {
      const resp = await fetch(URL_BASE + p, { method, headers: { Authorization: 'Bearer ' + TOKEN } })
      if (!resp.ok) continue
      const data = await resp.json()
      const user = (data && data.user) || data || {}
      const name = String(user.name || '')
      if (name.indexOf('users/') === 0) {
        cachedUserRef = name
        return name
      }
      if (user.username) {
        cachedUserRef = 'users/' + user.username
        return cachedUserRef
      }
      if (user.id != null) {
        cachedUserRef = 'users/' + user.id
        return cachedUserRef
      }
    } catch (_) {
      /* try the next shape */
    }
  }
  cachedUserRef = ''
  return ''
}

async function serverMemos() {
  // 0.23/0.24 hide PRIVATE memos from the plain list, so the creator filter is
  // what actually sees the memo this test just sent. Every path is merged:
  // some builds answer 200 with an empty array for filters they only partly
  // understand, and stopping at the first answer would hide the memo.
  const ref = await currentUserRef()
  const paths = []
  if (ref) {
    // 0.24 applies its creator filter to public memos only, so the user-scoped
    // collection is the reliable way to see what this test just sent.
    const tail = ref.split('/').pop()
    paths.push(`api/v1/users/${tail}/memos?pageSize=20`, `api/users/${tail}/memos?pageSize=20`)
    paths.push(`api/v1/memos?pageSize=20&filter=${encodeURIComponent('creator == ' + JSON.stringify(ref))}`)
  }
  // 0.22+ list at /api/v1/memos and wrap the array in `memos`; 0.15-0.21 use
  // the singular /api/v1/memo and return a bare array; 26.10+ drop the /v1.
  paths.push('api/v1/memos?pageSize=20', 'api/memos?pageSize=20', 'api/v1/memo?limit=20')

  const seen = new Map()
  for (const p of paths) {
    let data = null
    try {
      const resp = await fetch(URL_BASE + p, { headers: { Authorization: 'Bearer ' + TOKEN } })
      if (!resp.ok) continue
      data = await resp.json()
    } catch (_) {
      continue
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.memos) ? data.memos : null
    if (!list) continue
    for (const memo of list) seen.set(String(memo.name || memo.id), memo)
  }
  return [...seen.values()]
}

// The field carrying attachments is renamed twice: resourceList (0.15-0.21),
// resources (0.22-0.24), attachments (0.25+).
const attachmentsOf = (memo) => (memo && (memo.attachments || memo.resources || memo.resourceList)) || []


async function main() {
  const chrome = findChrome()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'memos-ui-'))
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-allow-origins=*',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`
  ]
  if (HEADLESS) args.push('--headless=new')
  // Escape hatch for branded Chrome 137+, which ignores --load-extension unless
  // the switch is re-enabled through --disable-features. CI uses Chrome for
  // Testing and does not need it.
  if (process.env.CHROME_EXTRA_ARGS) {
    args.push(...process.env.CHROME_EXTRA_ARGS.split(/\s+/).filter(Boolean))
  }
  if (process.env.CI) args.push('--no-sandbox', '--disable-dev-shm-usage')
  args.push('about:blank')

  try {
    const stale = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) })
    if (stale.ok) throw new Error(`debug port ${PORT} is already in use; another run may be stuck`)
  } catch (err) {
    if (err && /already in use/.test(err.message)) throw err
  }

  let proxy = null
  if (SUBPATH && SUBPATH !== '/') {
    proxy = await startSubpathProxy(TARGET_URL, SUBPATH.replace(/\/+$/, ''))
    URL_BASE = proxy.base
    console.log('sub-path proxy:', URL_BASE, '->', TARGET_URL)
  }

  const child = spawn(chrome, args, { stdio: 'ignore' })
  const cleanup = () => {
    try {
      child.kill('SIGKILL')
    } catch (_) {
      /* ignore */
    }
    if (proxy) {
      try {
        proxy.server.close()
      } catch (_) {
        /* ignore */
      }
    }
    if (!KEEP) removeProfile(profile)
  }
  process.on('exit', cleanup)

  let cdp = null
  try {
    await waitForEndpoint()
    const id = extensionId(EXT_DIR)
    // The DevTools endpoint answers before the freshly started browser has
    // registered the unpacked extension. Opening the popup at that moment
    // yields chrome-error://chromewebdata, which used to fail one random
    // matrix job per night. Retry instead of trusting the first attempt.
    const opened = await openPopup(`chrome-extension://${id}/${PAGE}`)
    cdp = opened.cdp
    const title = opened.title
    const metrics = VIEW || { width: MOBILE ? 360 : 420, height: MOBILE ? 640 : 640 }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: MOBILE ? 3 : 1,
      mobile: MOBILE
    })
    if (MOBILE) {
      // `pointer: coarse` is what the mobile CSS block keys off.
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [
          { name: 'pointer', value: 'coarse' },
          { name: 'any-pointer', value: 'coarse' }
        ]
      })
    }

    // The popup locks the editor to the width it measures while its scripts run
    // (chrome/js/oper.js: initEditorResize). A metrics override applied after
    // that leaves a base width taken from the real ~800px window while the
    // viewport is 420: on 2026-11-24 the editor stayed 717px wide inside a
    // 420px viewport, its resize handle sat outside the viewport, and the drag
    // landed on nothing. Reload once so the page boots inside the emulated
    // viewport; waitFor() swallows the destroyed-context errors in between.
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Page.reload', { ignoreCache: true }).catch(() => {})
    await sleep(400)

    console.log(`extension ${id} loaded, popup title=${JSON.stringify(title)}`)

    // jQuery handlers are bound while the popup scripts execute; wait until the
    // UI is actually interactive before touching it.
    const ready = await waitFor(
      cdp,
      `Boolean(window.jQuery && window.MemosApiAdapter && document.querySelector('#apiUrl') && document.querySelector('#saveSettings'))`,
      10000
    )
    if (!ready) throw new Error('popup scripts did not initialize')

    // The header links are part of every popup, so check them in every run:
    // each must be revealed, labelled for screen readers, and stay clear of the
    // title on the left and the language / settings controls on the right.
    const header = await evaluate(
      cdp,
      `(() => {
        const read = (id) => {
          const el = document.getElementById(id)
          if (!el) return { missing: true }
          const box = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return {
            hidden: el.hasAttribute('hidden'),
            href: el.href,
            target: el.target,
            rel: el.rel,
            text: (el.textContent || '').trim(),
            aria: el.getAttribute('aria-label') || '',
            title: el.getAttribute('title') || '',
            display: style.display,
            left: Math.round(box.left),
            right: Math.round(box.right),
            width: Math.round(box.width),
            height: Math.round(box.height)
          }
        }
        const rect = (sel) => document.querySelector(sel).getBoundingClientRect()
        return {
          kofi: read('kofi'),
          github: read('github'),
          titleRight: Math.round(rect('.title').right),
          langLeft: Math.round(rect('#lang_switcher').left),
          gearLeft: Math.round(rect('#blog_info_edit').left)
        }
      })()`
    )
    const linkOk = (entry, host) =>
      !entry.missing &&
      entry.hidden === false &&
      entry.display !== 'none' &&
      host.test(entry.href) &&
      entry.target === '_blank' &&
      /noopener/.test(entry.rel) &&
      entry.aria.length > 0 &&
      entry.title.length > 0 &&
      entry.width >= 24 &&
      entry.height >= 24 &&
      entry.left >= header.titleRight &&
      entry.right <= Math.min(header.langLeft, header.gearLeft)
    const headerOk =
      linkOk(header.kofi, /^https:\/\/ko-fi\.com\//) && linkOk(header.github, /^https:\/\/github\.com\//)
    console.log(
      (headerOk ? 'PASS' : 'FAIL') +
        ' header links (Ko-fi + GitHub) are visible, labelled and clear of the other controls',
      JSON.stringify(header)
    )
    if (!headerOk) process.exitCode = 1

    if (SCENARIO === 'header-links') {
      if (!headerOk) return
      // Plain links open the tab on their own, so keyboard and middle-click
      // work without extra code. Verify each tab actually appears.
      for (const [id, host] of [
        ['kofi', 'ko-fi\\.com'],
        ['github', 'github\\.com']
      ]) {
        await evaluate(cdp, `(() => { document.getElementById('${id}').click(); return true })()`)
        const opened = await waitFor(
          cdp,
          `new Promise((r) => chrome.tabs.query({}, (tabs) => r((tabs || []).some((t) => new RegExp('^https:\\\\/\\\\/${host}\\\\/').test(t.url || t.pendingUrl || '')))))`,
          10000
        )
        console.log(opened ? `PASS #${id} opens its configured page` : `FAIL #${id} did not open ${host}`)
        if (!opened) {
          process.exitCode = 1
          return
        }
      }
      if (SCREENSHOT) await capture(cdp, SCREENSHOT)
      return
    }

    // --- settings: fill URL + token, save, wait for storage
    const filled = await evaluate(
      cdp,
      `(() => {
        const setValue = (el, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(el, value)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setValue(document.querySelector('#apiUrl'), ${JSON.stringify(URL_BASE)})
        setValue(document.querySelector('#apiTokens'), ${JSON.stringify(TOKEN)})
        document.querySelector('#saveSettings').click()
        return document.querySelector('#apiUrl').value + '|' + document.querySelector('#apiTokens').value.length
      })()`
    )
    console.log('inputs:', filled)

    if (SCENARIO === 'invalid-token') {
      // The failure toast disappears after ~2s, so read it before any retry.
      const toast = await readToast(cdp, 5000)
      const ok = /令牌|token|url/i.test(toast)
      console.log('toast:', JSON.stringify(toast))
      console.log(ok ? 'PASS invalid token rejected with a specific reason' : 'FAIL expected an auth/url error toast')
      if (!ok) process.exitCode = 1
      return
    }

    const isSavedExpr = activeInstanceExpr('active.apiUrl && active.apiTokens')
    let saved = await waitFor(cdp, isSavedExpr, 8000)
    if (!saved) {
      // A cold container can reject the first detection request; retry once.
      await evaluate(cdp, `(() => { document.querySelector('#saveSettings').click(); return true })()`)
      saved = await waitFor(cdp, isSavedExpr, 8000)
    }
    if (!saved) {
      const toast = await evaluate(cdp, `(document.querySelector('.tip-info') || {}).textContent || ''`).catch(() => '')
      const partial = await evaluate(cdp, `new Promise((r) => chrome.storage.sync.get(null, r))`, { awaitPromise: true })
      throw new Error('settings were not saved; toast=' + JSON.stringify(toast) + ' storage=' + JSON.stringify(partial))
    }
    const stored = await readInstanceState(cdp)
    console.log(`saved: version=${stored.apiVersion || '-'} base=${stored.apiBase || '-'} era=${stored.apiFlavor || '-'}`)

    // Issue #9: the panel has to answer "which extension / which server am I
    // talking to?" without opening a store page.
    const versions = await evaluate(
      cdp,
      `(() => {
        const text = (sel) => {
          const el = document.querySelector(sel)
          return { text: el ? (el.textContent || '').trim() : '', hidden: el ? el.hasAttribute('hidden') : true }
        }
        return {
          ext: text('#extensionVersion'),
          server: text('#serverVersion'),
          manifest: chrome.runtime.getManifest().version
        }
      })()`
    )
    const versionsOk =
      !versions.ext.hidden &&
      versions.ext.text.includes(versions.manifest) &&
      !versions.server.hidden &&
      Boolean(stored.apiVersion) &&
      versions.server.text.includes(stored.apiVersion)
    console.log(
      (versionsOk ? 'PASS' : 'FAIL') + ' settings panel names the extension and the server version',
      JSON.stringify(versions)
    )
    if (!versionsOk) process.exitCode = 1

    if (SCENARIO === 'instances') {
      // The chip is the feature: it has to name the active server, report
      // whether it answers, and list every instance with the current one
      // marked. "Add instance" must open an EMPTY form -- reusing the active
      // values would make the next save silently overwrite that server.
      const readChip = () =>
        evaluate(
          cdp,
          `(() => {
            const toggle = document.getElementById('instanceToggle')
            const name = document.getElementById('instanceName')
            const dot = document.getElementById('instanceDot')
            return {
              exists: Boolean(toggle && name),
              name: name ? name.textContent.trim() : '',
              label: toggle ? toggle.getAttribute('aria-label') || '' : '',
              dot: dot ? dot.className : ''
            }
          })()`
        )

      const snapshot = await evaluate(
        cdp,
        `new Promise((r) => chrome.storage.sync.get({ memosInstances: [], activeInstanceId: '' }, r))`,
        { awaitPromise: true }
      )

      const chip = await readChip()
      console.log('instance chip:', JSON.stringify(chip))
      const okChip = chip.exists && Boolean(chip.name) && Boolean(chip.label) && /\bonline\b/.test(chip.dot)

      await evaluate(cdp, `(() => { document.getElementById('instanceToggle').click(); return true })()`)
      await sleep(150)
      const menu = await evaluate(
        cdp,
        `(() => {
          const panel = document.getElementById('instanceMenu')
          const items = Array.from(document.querySelectorAll('#instanceList [data-instance-id]'))
          const current = items.filter((el) => el.getAttribute('aria-checked') === 'true')
          const host = items.length ? items[0].querySelector('.instance-item-host') : null
          return {
            open: Boolean(panel) && !panel.classList.contains('hidden'),
            count: items.length,
            current: current.length,
            host: host ? host.textContent.trim() : '',
            add: Boolean(document.getElementById('instanceAdd')),
            manage: Boolean(document.getElementById('instanceManage'))
          }
        })()`
      )
      console.log('instance menu:', JSON.stringify(menu))
      const okMenu = menu.open && menu.count >= 1 && menu.current === 1 && Boolean(menu.host) && menu.add && menu.manage

      await evaluate(cdp, `(() => { document.getElementById('instanceAdd').click(); return true })()`)
      await sleep(250)
      const form = await evaluate(
        cdp,
        `(() => {
          const panel = document.getElementById('blog_info')
          const name = document.getElementById('instanceNameInput')
          return {
            visible: Boolean(panel) && panel.offsetParent !== null,
            emptyName: name ? name.value === '' : false,
            emptyUrl: document.getElementById('apiUrl').value === '',
            emptyToken: document.getElementById('apiTokens').value === '',
            focused: document.activeElement === name
          }
        })()`
      )
      console.log('instance add form:', JSON.stringify(form))
      const okForm = form.visible && form.emptyName && form.emptyUrl && form.emptyToken

      await evaluate(
        cdp,
        `(() => {
          const setValue = (el, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(el, value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
          setValue(document.getElementById('instanceNameInput'), 'ci-second')
          setValue(document.getElementById('apiUrl'), ${JSON.stringify(TARGET_URL)})
          setValue(document.getElementById('apiTokens'), ${JSON.stringify(TOKEN)})
          return true
        })()`
      )
      await evaluate(cdp, `(() => { document.getElementById('saveSettings').click(); return true })()`)
      const added = await waitFor(
        cdp,
        `new Promise((r) => chrome.storage.sync.get({ memosInstances: [], activeInstanceId: '' }, (i) => {
          const list = Array.isArray(i.memosInstances) ? i.memosInstances : []
          const active = list.filter((x) => x.id === i.activeInstanceId)[0]
          r(list.length >= 2 && Boolean(active) && active.name === 'ci-second')
        }))`,
        20000
      )
      console.log(added ? 'PASS a second instance is saved and becomes active' : 'FAIL second instance was not saved')

      await evaluate(cdp, `(() => { document.getElementById('instanceToggle').click(); return true })()`)
      await sleep(150)
      const after = await evaluate(
        cdp,
        `(() => {
          const items = Array.from(document.querySelectorAll('#instanceList [data-instance-id]'))
          return {
            count: items.length,
            current: items.filter((el) => el.getAttribute('aria-checked') === 'true').length
          }
        })()`
      )
      console.log('instance menu after add:', JSON.stringify(after))

      // Round trip: type on B, switch to A, type on A, switch back to B.
      // Without per-instance drafts the text either leaks across servers or is
      // lost on the reload that switching performs.
      const readDraft = () => evaluate(cdp, `(() => document.querySelector('textarea[name=text]').value)()`)
      const waitReady = () =>
        waitFor(
          cdp,
          `(() => {
            const name = document.getElementById('instanceName')
            return Boolean(
              window.jQuery &&
                document.getElementById('instanceToggle') &&
                document.querySelector('textarea[name=text]') &&
                name &&
                name.textContent.trim()
            )
          })()`,
          15000
        )
      const switchTo = async (index) => {
        await evaluate(cdp, `(() => { document.getElementById('instanceToggle').click(); return true })()`)
        await sleep(150)
        await evaluate(
          cdp,
          `(() => {
            const items = document.querySelectorAll('#instanceList [data-instance-id]')
            const target = items[${index}]
            if (!target) return false
            target.click()
            return true
          })()`
        )
        await sleep(400)
        return waitReady()
      }
      const draftB = await readDraft()
      const emptyOnB = draftB === ''
      console.log('draft on the new instance:', JSON.stringify(draftB))

      await evaluate(
        cdp,
        `(() => {
          document.querySelector('textarea[name=text]').value = 'draft-on-B'
          return true
        })()`
      )
      const backToA = await switchTo(0)
      const draftA = await readDraft()
      await evaluate(
        cdp,
        `(() => {
          document.querySelector('textarea[name=text]').value = 'draft-on-A'
          return true
        })()`
      )
      const backToB = await switchTo(1)
      const draftBAgain = await readDraft()
      const perInstance = await evaluate(
        cdp,
        `new Promise((r) => chrome.storage.sync.get(null, (all) => {
          const list = Array.isArray(all.memosInstances) ? all.memosInstances : []
          const byName = {}
          list.forEach((inst) => {
            const rt = all['instanceRuntime_' + inst.id] || {}
            byName[inst.name] = rt.open_content
          })
          r(byName)
        }))`,
        { awaitPromise: true }
      )
      console.log(
        'draft round trip:',
        JSON.stringify({ emptyOnB, draftA, backToA, draftBAgain, backToB, perInstance })
      )

      // Leave the profile as it was found: a stale second instance would make
      // the next local run start from the wrong state.
      await evaluate(
        cdp,
        `new Promise((r) => chrome.storage.sync.set(${JSON.stringify({
          memosInstances: snapshot.memosInstances,
          activeInstanceId: snapshot.activeInstanceId
        })}, r))`,
        { awaitPromise: true }
      )

      const okDrafts =
        emptyOnB && backToA && backToB && draftA === '' && draftBAgain === 'draft-on-B' &&
        perInstance['ci-second'] === 'draft-on-B'

      const okInstances =
        okChip && okMenu && okForm && added && after.count >= 2 && after.current === 1 && okDrafts
      console.log(
        okInstances
          ? 'PASS instance chip names the active server, lists all of them, and adds a new one'
          : 'FAIL instance switching regressed'
      )
      if (!okInstances) process.exitCode = 1
      return
    }

    if (SCENARIO === 'migrate') {
      // Installs from before 2026.11 kept every key flat. Seed exactly that
      // shape, reload, and require the popup to adopt it: the token must still
      // connect, and the half-written draft must survive the move.
      const seeded = await evaluate(
        cdp,
        `new Promise((r) => chrome.storage.sync.clear(() => {
          chrome.storage.sync.set({
            apiUrl: ${JSON.stringify(TARGET_URL)},
            apiTokens: ${JSON.stringify(TOKEN)},
            apiVersion: '0.26.1',
            open_content: 'legacy draft',
            hidetag: '#old',
            memo_lock: 'PRIVATE'
          }, () => r(true))
        }))`,
        { awaitPromise: true }
      )
      const beforeReload = await evaluate(cdp, `new Promise((r) => chrome.storage.sync.get(null, r))`, {
        awaitPromise: true
      })
      console.log(
        'migrate seed:',
        JSON.stringify({
          seeded,
          apiUrl: beforeReload.apiUrl || '',
          tokenLength: (beforeReload.apiTokens || '').length,
          draft: beforeReload.open_content || ''
        })
      )
      await evaluate(cdp, `(() => { location.reload(); return true })()`).catch(() => {})
      await sleep(600)
      const chipReady = await waitFor(
        cdp,
        `(() => {
          const name = document.getElementById('instanceName')
          return Boolean(name && name.textContent.trim())
        })()`,
        15000
      )
      const migrated = await readInstanceState(cdp)
      const view = await evaluate(
        cdp,
        `(() => {
          const area = document.querySelector('textarea[name=text]')
          const url = document.getElementById('apiUrl')
          const name = document.getElementById('instanceName')
          return {
            draft: area ? area.value : null,
            apiUrl: url ? url.value : null,
            chip: name ? name.textContent.trim() : ''
          }
        })()`
      )
      const migratedId = migrated.instances[0] ? migrated.instances[0].id : ''
      const migratedRuntime = (migrated.raw && migrated.raw['instanceRuntime_' + migratedId]) || {}
      console.log(
        'migrate:',
        JSON.stringify({
          chipReady,
          count: migrated.instances.length,
          chip: view.chip,
          draft: view.draft,
          runtimeDraft: migratedRuntime.open_content,
          legacyKept: Boolean(migrated.raw && migrated.raw.apiUrl)
        })
      )
      const okMigrate =
        chipReady &&
        migrated.instances.length === 1 &&
        migrated.instances[0].apiUrl === TARGET_URL &&
        Boolean(migrated.instances[0].apiTokens) &&
        migratedRuntime.open_content === 'legacy draft' &&
        migratedRuntime.hidetag === '#old' &&
        view.draft === 'legacy draft' &&
        view.apiUrl === TARGET_URL &&
        Boolean(migrated.raw && migrated.raw.apiUrl)
      console.log(
        okMigrate
          ? 'PASS flat settings become one instance, keeping the token and the draft'
          : 'FAIL migration lost the connection or the draft'
      )
      if (!okMigrate) process.exitCode = 1
      return
    }

    if (SCENARIO === 'settings') {
      // Staging: typing a URL then leaving the popup to copy the token must not
      // lose what was typed. Reloading the page is the same lifetime as
      // reopening the popup (storage.session lives as long as the browser).
      await evaluate(cdp, `(() => { document.querySelector('#blog_info_edit').click(); return true })()`)
      await evaluate(
        cdp,
        `(() => {
          const setValue = (el, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(el, value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
          setValue(document.querySelector('#apiUrl'), 'https://draft.example.com/memos/')
          setValue(document.querySelector('#apiTokens'), 'draft-token-not-saved-yet')
          return true
        })()`
      )
      // The staging write is debounced, so give it a beat to land.
      await sleep(600)
      const staged = await evaluate(cdp, `new Promise((r) => chrome.storage.session.get('settingsDraft', r))`, {
        awaitPromise: true
      })
      const draft = (staged && staged.settingsDraft) || {}
      console.log('draft:', JSON.stringify(draft))
      // Reloading may tear down the execution context mid-call; that is the
      // point of the check, so the throw is expected and ignored.
      await evaluate(cdp, `(() => { location.reload(); return true })()`).catch(() => {})
      const restored = await waitFor(
        cdp,
        `(() => {
          const url = document.querySelector('#apiUrl')
          const token = document.querySelector('#apiTokens')
          if (!url || !token) return false
          return url.value === 'https://draft.example.com/memos/' && token.value === 'draft-token-not-saved-yet'
        })()`,
        15000
      )
      console.log(restored ? 'PASS unsaved URL and token survive a popup reopen' : 'FAIL draft was lost on reopen')
      if (!restored) {
        const now = await evaluate(
          cdp,
          `({ url: (document.querySelector('#apiUrl') || {}).value || '', token: ((document.querySelector('#apiTokens') || {}).value || '').length })`
        )
        console.log('after reload:', JSON.stringify(now))
        process.exitCode = 1
        return
      }
      // Leave no draft behind: the next run starts from the saved binding.
      await evaluate(cdp, `new Promise((r) => chrome.storage.session.remove('settingsDraft', r))`, { awaitPromise: true })
      if (SCREENSHOT) await capture(cdp, SCREENSHOT)
      return
    }

    if (SCENARIO === 'fullscreen-layout') {
      const layout = await evaluate(
        cdp,
        `(() => {
          const doc = document.documentElement
          const editor = document.querySelector('.memo-editor')
          const submit = document.querySelector('#submit')
          const handle = document.querySelector('#editor-resize-handle')
          const full = document.querySelector('#fullscreen')
          const rect = (el) => (el ? el.getBoundingClientRect() : null)
          const submitRect = rect(submit)
          return {
            viewport: [window.innerWidth, window.innerHeight],
            pageScroll: doc.scrollHeight - window.innerHeight,
            editorWidth: editor ? Math.round(editor.getBoundingClientRect().width) : 0,
            editorHeight: editor ? Math.round(editor.getBoundingClientRect().height) : 0,
            submitBottom: submitRect ? Math.round(submitRect.bottom) : 0,
            submitRight: submitRect ? Math.round(submitRect.right) : 0,
            handleHidden: handle ? getComputedStyle(handle).display === 'none' : true,
            lang: (() => {
              const el = document.querySelector('.lang-switcher')
              const r = el ? el.getBoundingClientRect() : null
              return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right)] : null
            })(),
            gear: (() => {
              const el = document.querySelector('#blog_info_edit')
              const r = el ? el.getBoundingClientRect() : null
              return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right)] : null
            })(),
            fullButtonHidden: full ? getComputedStyle(full).display === 'none' : true
          }
        })()`
      )
      console.log('fullscreen layout:', JSON.stringify(layout))
      if (SCREENSHOT) await capture(cdp, SCREENSHOT)

      const okFull =
        layout.pageScroll <= 1 &&
        layout.editorWidth >= 600 &&
        layout.editorWidth <= 900 &&
        layout.editorHeight >= Math.round(layout.viewport[1] * 0.5) &&
        layout.submitBottom <= layout.viewport[1] &&
        // The handle is visible in fullscreen now: it resizes the column.
        !layout.handleHidden &&
        layout.fullButtonHidden &&
        layout.lang && layout.lang[0] >= 0 && layout.lang[2] <= layout.viewport[0] &&
        layout.gear && layout.gear[0] >= 0 && layout.gear[2] <= layout.viewport[0]
      console.log(
        okFull
          ? 'PASS fullscreen fills the viewport without scrolling and keeps the header usable'
          : 'FAIL fullscreen layout regressed'
      )
      if (!okFull) {
        process.exitCode = 1
        return
      }
    }

    if (MOBILE) {
      // A toast is centred and can be wider than a 360px viewport while it is
      // briefly on screen, which showed up once as a phantom 16px overflow.
      await waitForToastToClear(cdp)
      // Let the layout settle before measuring (animations, late fonts).
      await evaluate(
        cdp,
        `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`,
        { awaitPromise: true }
      ).catch(() => {})
      const layout = await evaluate(
        cdp,
        `(() => {
          const doc = document.documentElement
          const body = getComputedStyle(document.querySelector('.body'))
          const lock = document.querySelector('#lock')
          const send = document.querySelector('#content_submit_text')
          const box = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0)
          // Name the culprits when it does overflow, so the next red build is
          // diagnosable from the log alone.
          const wide = []
          document.querySelectorAll('body *').forEach((el) => {
            const r = el.getBoundingClientRect()
            if (r.width && r.right > window.innerWidth + 1) {
              wide.push((el.id ? '#' + el.id : el.className || el.tagName) + ':' + Math.round(r.right))
            }
          })
          return {
            viewport: window.innerWidth,
            scrollWidth: doc.scrollWidth,
            bodyMinWidth: body.minWidth,
            bodyPadding: body.paddingLeft,
            lockHeight: box(lock),
            sendHeight: box(send),
            lockRight: lock ? Math.round(lock.getBoundingClientRect().right) : 0,
            sendLeft: send ? Math.round(send.getBoundingClientRect().left) : 0,
            toolsRight: (() => {
              const tools = document.querySelector('.common-tools-container')
              return tools ? Math.round(tools.getBoundingClientRect().right) : 0
            })(),
            coarse: window.matchMedia('(pointer: coarse)').matches,
            wide: wide.slice(0, 6)
          }
        })()`
      )
      console.log('mobile layout:', JSON.stringify(layout))
      const okMobile =
        layout.coarse &&
        layout.scrollWidth <= layout.viewport + 1 &&
        layout.bodyMinWidth === '0px' &&
        layout.lockHeight >= 40 &&
        layout.sendHeight >= 40 &&
        // Nothing may slide under the send button.
        layout.lockRight <= layout.sendLeft
      console.log(
        okMobile
          ? 'PASS mobile layout fits the viewport with touch-sized targets'
          : 'FAIL mobile layout overflows or has mouse-sized targets'
      )
      if (!okMobile) {
        process.exitCode = 1
        return
      }
    }

    if (SCENARIO === 'upload') {
      const png = path.join(os.tmpdir(), `memos-upload-${Date.now()}.png`)
      // Pad the icon so the upload spans several progress events; a 2 KB file
      // finishes in one event and would make the bar assertions flaky.
      const icon = Buffer.from(PNG_BASE64, 'base64')
      fs.writeFileSync(png, Buffer.concat([icon, Buffer.alloc(3 * 1024 * 1024, 7)]))

      // The upload is over in a few hundred milliseconds, so the bar cannot be
      // sampled from the outside: record every state it passes through.
      const instrumented = await evaluate(
        cdp,
        `(() => {
          const box = document.getElementById('upload-progress')
          const bar = document.getElementById('upload-progress-bar')
          const label = document.getElementById('upload-progress-label')
          if (!box || !bar || !label) return false
          const seen = { visible: false, labels: [], widths: [], barHeight: 0, barWidth: 0 }
          window.__uploadProgress = seen
          const snap = () => {
            if (box.hidden) return
            seen.visible = true
            if (label.textContent) seen.labels.push(label.textContent)
            if (bar.style.width) seen.widths.push(bar.style.width)
            const rect = bar.getBoundingClientRect()
            if (rect.height > seen.barHeight) seen.barHeight = rect.height
            if (rect.width > seen.barWidth) seen.barWidth = rect.width
          }
          new MutationObserver(snap).observe(box, {
            attributes: true,
            subtree: true,
            childList: true,
            characterData: true
          })
          return true
        })()`
      )
      if (!instrumented) throw new Error('upload progress elements not found')

      await cdp.send('DOM.enable')
      const doc = await cdp.send('DOM.getDocument', { depth: -1 })
      const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#inFile' })
      if (!input.nodeId) throw new Error('file input not found')
      await cdp.send('DOM.setFileInputFiles', { files: [png], nodeId: input.nodeId })
      const uploaded = await waitFor(
        cdp,
        activeInstanceExpr('(active.resourceIdList || []).length > 0'),
        15000
      )
      if (!uploaded) throw new Error('attachment was not uploaded')
      console.log('attachment uploaded through the real file input')

      const progress = await evaluate(cdp, 'window.__uploadProgress')
      const counted = (progress?.labels || []).some((text) => /\d+\/\d+/.test(text))
      const percentage = (progress?.widths || []).some((width) => /^\d+%$/.test(width) && width !== '0%')
      // The bar must actually be painted: a zero-height track would still pass
      // the style-only assertions above.
      const painted = (progress?.barHeight || 0) >= 3 && (progress?.barWidth || 0) > 0
      const okProgress = Boolean(progress?.visible) && counted && percentage && painted
      console.log(
        okProgress
          ? 'PASS upload progress bar appeared, painted, with a counter and a byte-based percentage'
          : 'FAIL upload progress bar never rendered a counter, a percentage or any pixels'
      )
      if (!okProgress) {
        console.log('  observed: ' + JSON.stringify(progress))
        process.exitCode = 1
      }

      const collapsed = await waitFor(cdp, `document.getElementById('upload-progress').hidden === true`, 5000)
      console.log(
        collapsed
          ? 'PASS progress bar collapses once the batch is done'
          : 'FAIL progress bar stayed visible after the batch finished'
      )
      if (!collapsed) process.exitCode = 1
    }

    if (SCENARIO === 'preview') {
      // Upload the real 1x1 PNG (not the padded one): the card must decode the
      // exact bytes the server stored, so a broken stream URL shows up as a
      // zero-sized image instead of silently rendering a placeholder.
      const png = path.join(os.tmpdir(), `memos-preview-${Date.now()}.png`)
      fs.writeFileSync(png, Buffer.from(PNG_BASE64, 'base64'))

      await cdp.send('DOM.enable')
      const doc = await cdp.send('DOM.getDocument', { depth: -1 })
      const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#inFile' })
      if (!input.nodeId) throw new Error('file input not found')
      await cdp.send('DOM.setFileInputFiles', { files: [png], nodeId: input.nodeId })

      const uploaded = await waitFor(
        cdp,
        activeInstanceExpr('(active.resourceIdList || []).length > 0'),
        20000
      )
      if (!uploaded) throw new Error('attachment was not uploaded')
      console.log('attachment uploaded for the preview scenario')
    }

    if (SCENARIO === 'upload-fail') {
      const png = path.join(os.tmpdir(), `memos-upload-fail-${Date.now()}.png`)
      fs.writeFileSync(png, Buffer.from(PNG_BASE64, 'base64'))

      await cdp.send('DOM.enable')
      const doc = await cdp.send('DOM.getDocument', { depth: -1 })
      const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#inFile' })
      if (!input.nodeId) throw new Error('file input not found')

      // Settings are already saved, so going offline now only breaks the upload.
      await cdp.send('Network.enable')
      const offline = (value) =>
        cdp.send('Network.emulateNetworkConditions', {
          offline: value,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1
        })

      await offline(true)
      await cdp.send('DOM.setFileInputFiles', { files: [png], nodeId: input.nodeId })

      const failed = await waitFor(
        cdp,
        `(() => {
          const box = document.getElementById('upload-progress')
          const retry = document.getElementById('upload-progress-retry')
          return Boolean(box && !box.hidden && retry && !retry.hidden)
        })()`,
        20000
      )
      console.log(
        failed ? 'PASS failed upload keeps a retry affordance' : 'FAIL no retry affordance after a failed upload'
      )
      if (!failed) {
        process.exitCode = 1
        await offline(false)
        return
      }

      await offline(false)
      await evaluate(cdp, `(() => { document.getElementById('upload-progress-retry').click(); return true })()`)

      const recovered = await waitFor(
        cdp,
        activeInstanceExpr('(active.resourceIdList || []).length > 0'),
        20000
      )
      console.log(
        recovered ? 'PASS retry uploaded the file once the network came back' : 'FAIL retry did not upload the file'
      )
      if (!recovered) process.exitCode = 1
    }

    if (SCENARIO === 'locked-public') {
      const blocked = await waitFor(
        cdp,
        `Boolean(document.querySelector('#lockPublic') && document.querySelector('#lockPublic').classList.contains('lock-blocked'))`,
        8000
      )
      const state = await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector('#lockPublic')
          return {
            cls: el ? el.className : '',
            aria: el ? el.getAttribute('aria-disabled') : '',
            title: el ? el.getAttribute('title') : '',
            cursor: el ? getComputedStyle(el).cursor : '',
            opacity: el ? getComputedStyle(el).opacity : '',
            current: (document.querySelector('#lock-now') || {}).textContent || ''
          }
        })()`
      )
      console.log('public option:', JSON.stringify(state))
      await evaluate(cdp, `(() => { const el = document.querySelector('#lockPublic'); if (el) el.click(); return true })()`)
      const blockToast = await waitForToast(cdp, /禁用|禁止|disallow|cannot|하지|選択できません/i, 6000)
      const after = await evaluate(cdp, `new Promise((r) => chrome.storage.sync.get(['memo_lock'], r))`, { awaitPromise: true })
      console.log('block toast:', JSON.stringify(blockToast), 'memo_lock:', after.memo_lock)
      const okBlocked =
        blocked &&
        state.aria === 'true' &&
        Boolean(state.title) &&
        state.cursor === 'not-allowed' &&
        Number(state.opacity) < 1 &&
        stored.disallowPublic === '1' &&
        after.memo_lock !== 'PUBLIC' &&
        /禁用|禁止|disallow|cannot|하지|選択できません/i.test(blockToast)
      if (!okBlocked) {
        console.log('FAIL public option should be greyed out and refuse selection')
        process.exitCode = 1
        return
      }
      console.log('PASS public option greyed out with a reason and cannot be selected')

      if (SCREENSHOT) {
        // Reveal the selector list (without toggling it off) and let the toast
        // fade so the capture shows the greyed entry itself.
        await sleep(2400)
        await evaluate(
          cdp,
          `(() => { const w = document.querySelector('#lock-wrapper'); if (w) w.classList.remove('!hidden'); return true })()`
        )
        await sleep(400)
        await capture(cdp, SCREENSHOT)
      }
    }

    if (SCENARIO === 'fullscreen-panel') {
      const read = () =>
        evaluate(
          cdp,
          `(() => {
            const e = document.querySelector('.memo-editor')
            const h = document.querySelector('#editor-resize-handle')
            const hr = h.getBoundingClientRect()
            return {
              w: Math.round(e.getBoundingClientRect().width),
              hx: Math.round(hr.left + hr.width / 2),
              hy: Math.round(hr.top + hr.height / 2),
              column: getComputedStyle(document.body).getPropertyValue('--editor-column').trim()
            }
          })()`
        )

      const before = await read()
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.hx, y: before.hy, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.hx + 100, y: before.hy, button: 'left', buttons: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.hx + 100, y: before.hy, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(250)
      const after = await read()
      const stored = await evaluate(cdp, `new Promise((r) => chrome.storage.sync.get(['fullscreenEditorWidth'], r))`, {
        awaitPromise: true
      })

      await evaluate(cdp, `(() => { document.querySelector('#editor-resize-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`)
      await sleep(150)
      const reset = await read()

      // Results must land beside the editor on a wide window, not below it.
      await evaluate(cdp, `showRandomList('<div class="random-item">panel probe</div>')`)
      await sleep(300)
      const panel = await evaluate(
        cdp,
        `(() => {
          const e = document.querySelector('.memo-editor').getBoundingClientRect()
          const r = document.querySelector('#randomlist').getBoundingClientRect()
          return {
            open: document.body.classList.contains('results-open'),
            left: Math.round(r.left),
            right: Math.round(r.right),
            top: Math.round(r.top),
            height: Math.round(r.height),
            editorRight: Math.round(e.right),
            editorBottom: Math.round(e.bottom),
            vw: window.innerWidth,
            vh: window.innerHeight
          }
        })()`
      )
      console.log('fullscreen panel:', JSON.stringify({ before, after, stored, reset, panel }))
      if (SCREENSHOT) await capture(cdp, SCREENSHOT)

      // Wide window: the list sits beside the editor. Narrow: below it, but
      // still on screen (it used to be pushed out of a non-scrolling page).
      const sideBySide = panel.vw >= 1180
      const placementOk = sideBySide
        ? panel.left >= panel.editorRight && panel.right <= panel.vw
        : panel.top >= panel.editorBottom && panel.right <= panel.vw && panel.height <= Math.round(panel.vh * 0.5)
      // A narrow window clamps the column, so assert movement rather than an
      // exact +100.
      const okPanel =
        after.w > before.w &&
        after.w <= Math.min(1200, panel.vw - 96) + 1 &&
        Math.abs(Number(stored.fullscreenEditorWidth) - after.w) <= 4 &&
        Math.abs(reset.w - 880) <= 4 &&
        panel.open &&
        placementOk &&
        panel.height >= 40
      console.log(
        okPanel
          ? 'PASS fullscreen column resizes and persists; results sit beside the editor'
          : 'FAIL fullscreen column or results panel regressed'
      )
      if (!okPanel) process.exitCode = 1
      return
    }

    if (SCENARIO === 'drop-text') {
      const result = await evaluate(
        cdp,
        `(() => {
          const area = document.querySelector('textarea[name=text]')
          area.value = 'existing'
          area.dispatchEvent(new Event('input', { bubbles: true }))
          const editor = document.querySelector('.memo-editor')

          const first = new DataTransfer()
          first.setData('text/uri-list', '# comment\\nhttps://drop.test/a?b=1')
          first.setData('text/plain', 'https://drop.test/a?b=1')
          editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: first }))

          const second = new DataTransfer()
          second.setData('text/plain', '   plain dropped text   ')
          editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: second }))

          return area.value
        })()`
      )
      await sleep(200)
      const storedText = await readInstanceState(cdp)
      const expected = 'existing\n\nhttps://drop.test/a?b=1\n\nplain dropped text\n'
      console.log('drop text value:', JSON.stringify(result))
      const okText = result === expected && storedText.open_content === expected
      console.log(okText ? 'PASS dropped link and text appended to the draft' : 'FAIL dropped text handling regressed')
      if (!okText) process.exitCode = 1
      return
    }

    if (SCENARIO === 'resize') {
      const read = () =>
        evaluate(
          cdp,
          `(() => {
            const e = document.querySelector('.memo-editor')
            const h = document.querySelector('#editor-resize-handle')
            const r = e.getBoundingClientRect()
            const hr = h.getBoundingClientRect()
            return {
              w: Math.round(r.width),
              h: Math.round(r.height),
              hx: Math.round(hr.left + hr.width / 2),
              hy: Math.round(hr.top + hr.height / 2),
              text: h.getAttribute('aria-valuetext') || ''
            }
          })()`
        )
      const storedSize = () =>
        evaluate(cdp, `new Promise((r) => chrome.storage.sync.get(['popupEditorSize'], r))`, { awaitPromise: true })

      // Real mouse input for one full press/move/release cycle. The move has to
      // stay split from the release so the mid-drag preview can be sampled.
      const dragBy = async (from, dx, dy) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.hx, y: from.hy, button: 'left', buttons: 1, clickCount: 1 })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.hx + dx, y: from.hy + dy, button: 'left', buttons: 1 })
        // Mid-drag the size must still be a preview (CSS transform), not a real
        // popup resize on every pointermove.
        const preview = await evaluate(
          cdp,
          `(() => {
            const e = document.querySelector('.memo-editor')
            const r = e.getBoundingClientRect()
            return { transform: e.style.transform || '', width: Math.round(r.width) }
          })()`
        )
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.hx + dx, y: from.hy + dy, button: 'left', buttons: 0, clickCount: 1 })
        await sleep(250)
        return { preview, after: await read() }
      }
      const resetSize = async () => {
        await evaluate(cdp, `(() => { document.querySelector('#editor-resize-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`)
        await sleep(150)
        return read()
      }

      const before = await read()
      // The editor can only grow to min(800, screen.availWidth) - 16, and the
      // width it starts from is whatever the window happened to be when the
      // popup script ran: the emulation override is applied after load, so one
      // night it is a 392px window (editor 360) and the next a 749px one
      // (editor 717). A hardcoded +120 drag silently stopped fitting the moment
      // the start width was 717 under a 784 ceiling, so probe the real ceiling
      // with an oversized drag and size the measured drag to the headroom.
      const capped = (await dragBy(before, 2000, 2000)).after
      const maxW = capped.w
      const maxH = capped.h
      const dx = Math.min(120, Math.max(0, maxW - before.w))
      const dy = Math.min(80, Math.max(0, maxH - before.h))
      const start = await resetSize()
      console.log('resize drag:', JSON.stringify({ before: [before.w, before.h], capped: [maxW, maxH], step: [dx, dy] }))

      if (dx < 8 && dy < 8) {
        // Nothing to drag towards: report it instead of pretending the resize
        // works. This only happens if the window is already at the ceiling.
        console.log('SKIP resize: the window leaves no headroom', JSON.stringify({ before: [before.w, before.h], capped: [maxW, maxH] }))
        return
      }

      const { preview, after: dragged } = await dragBy(start, dx, dy)
      const persisted = (await storedSize()).popupEditorSize || null
      console.log(
        'resize result:',
        JSON.stringify({ dragged: [dragged.w, dragged.h], persisted, preview: preview.transform })
      )

      // Keyboard: focus the handle and press ArrowRight (24px step).
      await evaluate(cdp, `(() => { document.querySelector('#editor-resize-handle').focus(); return true })()`)
      await evaluate(
        cdp,
        `(() => {
          const h = document.querySelector('#editor-resize-handle')
          h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
          return true
        })()`
      )
      await sleep(120)
      const afterKey = await read()

      // Double click resets to the base size.
      const reset = await resetSize()

      // ArrowRight adds 24px, but the ceiling still applies.
      const keyStep = Math.min(24, Math.max(0, maxW - dragged.w))
      const okResize =
        Boolean(preview.transform) &&
        Math.abs(dragged.w - start.w - dx) <= 4 &&
        Math.abs(dragged.h - start.h - dy) <= 4 &&
        persisted &&
        Math.abs(persisted.width - dragged.w) <= 4 &&
        Math.abs(persisted.height - dragged.h) <= 4 &&
        Math.abs(afterKey.w - dragged.w - keyStep) <= 2 &&
        afterKey.text &&
        Math.abs(reset.w - start.w) <= 2 &&
        Math.abs(reset.h - start.h) <= 2
      console.log(
        okResize
          ? 'PASS drag resizes each axis, keyboard nudges, double click resets'
          : 'FAIL resize behaviour regressed'
      )
      if (!okResize) process.exitCode = 1
      return
    }

    if (SCENARIO === 'drop-multi') {
      // Real drop event with two files, dispatched on the editor (not the
      // textarea) to prove the whole editor accepts drops.
      await evaluate(
        cdp,
        `(() => {
          const area = document.querySelector('textarea[name=text]')
          area.value = 'draft kept after upload'
          area.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`
      )
      const active = await evaluate(
        cdp,
        `(() => {
          const editor = document.querySelector('.memo-editor')
          const dt = new DataTransfer()
          const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (c) => c.charCodeAt(0))
          dt.items.add(new File([bytes], 'one.png', { type: 'image/png' }))
          dt.items.add(new File([bytes], 'two.png', { type: 'image/png' }))
          editor.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
          editor.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
          const highlighted = editor.classList.contains('drop-active')
          editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
          return { highlighted, stillActive: editor.classList.contains('drop-active') }
        })()`
      )
      const uploaded = await waitFor(
        cdp,
        activeInstanceExpr('(active.resourceIdList || []).length >= 2'),
        20000
      )
      const state = await readInstanceState(cdp)
      console.log('drop:', JSON.stringify({ ...active, count: (state.resourceIdList || []).length, draft: state.open_content }))

      const okDrop =
        active.highlighted &&
        !active.stillActive &&
        uploaded &&
        (state.resourceIdList || []).length === 2 &&
        state.open_content === 'draft kept after upload'
      console.log(
        okDrop
          ? 'PASS both dropped files uploaded, highlight cleared, draft preserved'
          : 'FAIL drop handling regressed'
      )
      if (!okDrop) {
        process.exitCode = 1
        return
      }
    }

    // --- choose visibility for the failure scenario
    if (SCENARIO === 'public-forbidden') {
      await evaluate(cdp, `(() => { const el = document.querySelector('#lockPublic'); if (el) el.click(); return true })()`)
    } else if (SCENARIO === 'locked-public') {
      // Nothing to click: the blocked option must already be refused above.
    } else {
      await evaluate(cdp, `(() => { const el = document.querySelector('#lockPrivate'); if (el) el.click(); return true })()`)
    }

    // --- send a memo through the real UI
    await waitForToastToClear(cdp)
    await evaluate(
      cdp,
      `(() => {
        const area = document.querySelector('textarea[name=text]')
        area.value = ${SCENARIO === 'upload' ? "''" : JSON.stringify(TEXT)}
        area.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('#content_submit_text').click()
        return true
      })()`
    )

    // The save toast says "Success" too, so it must not be mistaken for the
    // send result if it ever outlives the wait above.
    const toast = await readToast(cdp, 12000, /保存信息|Save Info|已连接|Connected to/i)
    console.log('toast:', JSON.stringify(toast))

    const memos = await serverMemos()
    const found = memos.filter((m) => String(m.content || '').indexOf(TEXT) !== -1)

    let ok = false
    if (SCENARIO === 'drop-multi') {
      const target = memos.filter((m) => String(m.content || '').indexOf(TEXT) !== -1)
      const count = target.length ? attachmentsOf(target[0]).length : 0
      ok = count >= 2
      console.log(ok ? `PASS memo carries ${count} attachments` : 'FAIL memo did not carry both attachments')
    } else if (SCENARIO === 'preview') {
      // The card fetches the attachment with the bearer token and swaps in a
      // blob: URL. A stream URL that is wrong for the detected era shows up
      // here as naturalWidth 0, which is exactly what a user would see as a
      // broken image.
      const loaded = await waitFor(
        cdp,
        `(() => {
          const img = document.querySelector('#randomlist img.random-image')
          if (!img || !img.complete) return false
          return img.naturalWidth > 0 && img.naturalHeight > 0 && String(img.src).indexOf('blob:') === 0
        })()`,
        20000
      )
      const detail = await evaluate(
        cdp,
        `(() => {
          const img = document.querySelector('#randomlist img.random-image')
          if (!img) return null
          return {
            src: String(img.src).slice(0, 24),
            source: String(img.getAttribute('data-auth-src') || '').slice(0, 120),
            width: img.naturalWidth,
            height: img.naturalHeight,
            hydrated: img.getAttribute('data-auth-loaded') || ''
          }
        })()`
      )
      ok = loaded
      console.log(
        ok
          ? `PASS preview image decoded from the server (${detail.width}x${detail.height} via blob url)`
          : `FAIL preview image did not decode (${JSON.stringify(detail)})`
      )

      // Clicking opens the lightbox; it must show the same decoded image.
      if (ok) {
        await evaluate(
          cdp,
          `(() => { const img = document.querySelector('#randomlist img.random-image'); if (img) img.click(); return true })()`
        )
        const opened = await waitFor(
          cdp,
          `(() => {
            const el = document.querySelector('.view-image-lead img')
            return Boolean(el && el.complete && el.naturalWidth > 0)
          })()`,
          8000
        )
        console.log(opened ? 'PASS lightbox shows the same decoded image' : 'FAIL lightbox image did not load')
        if (!opened) ok = false
        await evaluate(
          cdp,
          `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true })()`
        )
      }
    } else if (SCENARIO === 'upload') {
      const withAttachment = memos.filter((m) => attachmentsOf(m).length > 0)
      ok = withAttachment.length >= 1
      console.log(
        ok
          ? `PASS attachment published (${withAttachment[0].name || 'memo/' + withAttachment[0].id}, attachments=${attachmentsOf(withAttachment[0]).length})`
          : 'FAIL no memo with an attachment on the server'
      )
    } else if (SCENARIO === 'upload-fail') {
      const withAttachment = memos.filter((m) => attachmentsOf(m).length > 0)
      ok = withAttachment.length >= 1
      console.log(ok ? 'PASS retried attachment published with the memo' : 'FAIL retried attachment missing from the memo')
    } else if (SCENARIO === 'locked-public') {
      ok =
        found.length >= 1 &&
        String(found[0].visibility || '') !== 'PUBLIC' &&
        /成功|success/i.test(toast)
      console.log(
        ok
          ? `PASS memo published as ${found[0].visibility} while PUBLIC stays blocked`
          : `FAIL expected a non-public memo and a success toast (visibility=${found[0] && found[0].visibility})`
      )
    } else if (SCENARIO === 'public-forbidden') {
      ok = /禁止发布公开|disallows public/i.test(toast) && found.length === 0
      console.log(ok ? 'PASS public memo rejected with a specific reason' : 'FAIL expected a public-forbidden toast and no server memo')
    } else {
      ok = found.length >= 1
      console.log(ok ? `PASS memo created on server (${found[0].name}, visibility=${found[0].visibility})` : 'FAIL memo not found on server')

      // Sending renders a card from the returned memo: catch a broken renderer
      // (it builds DOM nodes now, so a throw would leave the list empty).
      const card = await evaluate(
        cdp,
        `(() => {
          const item = document.querySelector('#randomlist .random-item')
          return item
            ? {
                text: (item.querySelector('.random-content') || {}).textContent || '',
                images: item.querySelectorAll('img').length,
                icons: item.querySelectorAll('.random-link svg, .random-delete svg').length
              }
            : null
        })()`
      )
      const okCard = Boolean(card && card.text.indexOf(TEXT) !== -1 && card.icons === 2)
      console.log(okCard ? 'PASS sent memo renders as a card' : `FAIL memo card missing (${JSON.stringify(card)})`)
      if (!okCard) process.exitCode = 1
    }

    if (!ok) process.exitCode = 1
  } finally {
    if (cdp) cdp.close()
    await sleep(KEEP ? 0 : 300)
    cleanup()
  }
}

main().catch((err) => {
  console.error('ERROR', err && err.message ? err.message : err)
  process.exitCode = 1
})
