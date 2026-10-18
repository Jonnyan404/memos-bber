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

async function readToast(cdp, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await evaluate(cdp, `(document.querySelector('.tip-info') || {}).textContent || ''`).catch(() => '')
    // Skip the transient "sending" toast, keep the final outcome.
    if (text && !/发送中|Sending/i.test(text)) return text
    await sleep(200)
  }
  return ''
}

async function serverMemos() {
  const resp = await fetch(URL_BASE + 'api/v1/memos?pageSize=20', {
    headers: { Authorization: 'Bearer ' + TOKEN }
  })
  const data = await resp.json().catch(() => ({}))
  return Array.isArray(data.memos) ? data.memos : []
}

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
    const target = await openTarget(`chrome-extension://${id}/${PAGE}`)
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
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

    const title = await evaluate(cdp, 'document.title')
    if (!title) throw new Error('popup did not load (extension id mismatch or extension disabled)')
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

    const isSavedExpr = `new Promise((resolve) => chrome.storage.sync.get(['apiUrl','apiTokens','apiVersion','apiBase'], (v) => resolve(Boolean(v.apiUrl && v.apiTokens))))`
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
    const stored = await evaluate(cdp, `new Promise((r) => chrome.storage.sync.get(null, r))`, { awaitPromise: true })
    console.log(`saved: version=${stored.apiVersion || '-'} base=${stored.apiBase || '-'} era=${stored.apiFlavor || '-'}`)

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
      const layout = await evaluate(
        cdp,
        `(() => {
          const doc = document.documentElement
          const body = getComputedStyle(document.querySelector('.body'))
          const lock = document.querySelector('#lock')
          const send = document.querySelector('#content_submit_text')
          const box = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0)
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
            coarse: window.matchMedia('(pointer: coarse)').matches
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
      fs.writeFileSync(png, Buffer.from(PNG_BASE64, 'base64'))
      await cdp.send('DOM.enable')
      const doc = await cdp.send('DOM.getDocument', { depth: -1 })
      const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#inFile' })
      if (!input.nodeId) throw new Error('file input not found')
      await cdp.send('DOM.setFileInputFiles', { files: [png], nodeId: input.nodeId })
      const uploaded = await waitFor(
        cdp,
        `new Promise((r) => chrome.storage.sync.get(['resourceIdList'], (v) => r((v.resourceIdList || []).length > 0)))`,
        15000
      )
      if (!uploaded) throw new Error('attachment was not uploaded')
      console.log('attachment uploaded through the real file input')
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
      const storedText = await evaluate(
        cdp,
        `new Promise((r) => chrome.storage.sync.get(['open_content'], r))`,
        { awaitPromise: true }
      )
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

      const before = await read()
      // Drag the corner 120px right and 80px down with real mouse input.
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.hx, y: before.hy, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.hx + 120, y: before.hy + 80, button: 'left', buttons: 1 })
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
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.hx + 120, y: before.hy + 80, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(250)
      const dragged = await read()
      const persisted = (await storedSize()).popupEditorSize || null
      console.log(
        'resize drag:',
        JSON.stringify({ before: [before.w, before.h], dragged: [dragged.w, dragged.h], persisted, preview: preview.transform })
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
      await evaluate(
        cdp,
        `(() => {
          document.querySelector('#editor-resize-handle').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          return true
        })()`
      )
      await sleep(120)
      const reset = await read()

      const okResize =
        Boolean(preview.transform) &&
        Math.abs(dragged.w - before.w - 120) <= 4 &&
        Math.abs(dragged.h - before.h - 80) <= 4 &&
        persisted &&
        Math.abs(persisted.width - dragged.w) <= 4 &&
        Math.abs(persisted.height - dragged.h) <= 4 &&
        Math.abs(afterKey.w - dragged.w - 24) <= 2 &&
        afterKey.text &&
        Math.abs(reset.w - before.w) <= 2 &&
        Math.abs(reset.h - before.h) <= 2
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
        `new Promise((r) => chrome.storage.sync.get(['resourceIdList'], (v) => r((v.resourceIdList || []).length >= 2)))`,
        20000
      )
      const state = await evaluate(
        cdp,
        `new Promise((r) => chrome.storage.sync.get(['resourceIdList', 'open_content', 'open_action'], r))`,
        { awaitPromise: true }
      )
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

    const toast = await readToast(cdp)
    console.log('toast:', JSON.stringify(toast))

    const memos = await serverMemos()
    const found = memos.filter((m) => String(m.content || '').indexOf(TEXT) !== -1)

    let ok = false
    if (SCENARIO === 'drop-multi') {
      const target = memos.filter((m) => String(m.content || '').indexOf(TEXT) !== -1)
      const count = target.length ? (target[0].attachments || []).length : 0
      ok = count >= 2
      console.log(ok ? `PASS memo carries ${count} attachments` : 'FAIL memo did not carry both attachments')
    } else if (SCENARIO === 'upload') {
      const withAttachment = memos.filter((m) => (m.attachments || []).length > 0)
      ok = withAttachment.length >= 1
      console.log(
        ok
          ? `PASS attachment published (${withAttachment[0].name}, attachments=${withAttachment[0].attachments.length})`
          : 'FAIL no memo with an attachment on the server'
      )
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
