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
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : 'true'
}
const has = (name) => process.argv.includes('--' + name)

const URL_BASE = arg('url', 'http://127.0.0.1:15400/').replace(/\/+$/, '') + '/'
const TOKEN = arg('token', process.env.MEMOS_TOKEN || '')
const EXT_DIR = path.resolve(ROOT, arg('extension', 'chrome'))
const SCENARIO = arg('scenario', 'success')
const HEADLESS = arg('headless', 'true') !== 'false'
const KEEP = has('keep')
const PORT = Number(arg('port', '9444'))
const TEXT = arg('text', 'chrome-ui check ' + new Date().toISOString())

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
  args.push('about:blank')

  const child = spawn(chrome, args, { stdio: 'ignore' })
  const cleanup = () => {
    try {
      child.kill('SIGKILL')
    } catch (_) {
      /* ignore */
    }
    if (!KEEP) fs.rmSync(profile, { recursive: true, force: true })
  }
  process.on('exit', cleanup)

  let cdp = null
  try {
    await waitForEndpoint()
    const id = extensionId(EXT_DIR)
    const target = await openTarget(`chrome-extension://${id}/popup.html`)
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 640, deviceScaleFactor: 1, mobile: false })

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

    // --- choose visibility for the failure scenario
    if (SCENARIO === 'public-forbidden') {
      await evaluate(cdp, `(() => { const el = document.querySelector('#lockPublic'); if (el) el.click(); return true })()`)
    } else {
      await evaluate(cdp, `(() => { const el = document.querySelector('#lockPrivate'); if (el) el.click(); return true })()`)
    }

    // --- send a memo through the real UI
    await evaluate(
      cdp,
      `(() => {
        const area = document.querySelector('textarea[name=text]')
        area.value = ${JSON.stringify(TEXT)}
        area.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('#content_submit_text').click()
        return true
      })()`
    )

    const toast = await (async () => {
      for (let i = 0; i < 80; i++) {
        const text = await evaluate(cdp, `(document.querySelector('.tip-info') || {}).textContent || ''`).catch(() => '')
        // Skip the transient "sending" toast, keep the final outcome.
        if (text && !/发送中|Sending/i.test(text)) return text
        await sleep(200)
      }
      return ''
    })()
    console.log('toast:', JSON.stringify(toast))

    const memos = await serverMemos()
    const found = memos.filter((m) => String(m.content || '').indexOf(TEXT) !== -1)

    let ok = false
    if (SCENARIO === 'public-forbidden') {
      ok = /禁止发布公开|disallows public/i.test(toast) && found.length === 0
      console.log(ok ? 'PASS public memo rejected with a specific reason' : 'FAIL expected a public-forbidden toast and no server memo')
    } else {
      ok = found.length >= 1
      console.log(ok ? `PASS memo created on server (${found[0].name}, visibility=${found[0].visibility})` : 'FAIL memo not found on server')
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
