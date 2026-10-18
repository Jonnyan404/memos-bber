#!/usr/bin/env node
/**
 * Live check for the context menus and the keyboard command.
 *
 * The unit checks run background.js against a chrome mock; this one attaches to
 * the real service worker of a real Chrome so the parts that only exist in the
 * browser (menu registration, `chrome.commands`) are asserted for real:
 *
 *   1. the worker exposes the new globals (it loaded without throwing)
 *   2. all four menu ids are registered (re-creating one must report a
 *      duplicate id)
 *   3. the `open-extension` command is registered
 *   4. a real menu click appends to the draft through chrome.storage
 *
 * Usage: node tools/verify/background-live.mjs [--extension chrome]
 * Requires: Chrome for Testing (CHROME_PATH or the Playwright cache).
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
const EXT_DIR = path.resolve(ROOT, args[args.indexOf('--extension') + 1] || 'chrome')
const PORT = Number(process.env.DEBUG_PORT || 9462)
const EXPECTED_MENUS = ['Memos-send-selection', 'Memos-send-link', 'Memos-send-page', 'Memos-send-image']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
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
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]) {
    if (fs.existsSync(bin)) return bin
  }
  throw new Error('no Chrome/Chromium found; set CHROME_PATH')
}

// Same derivation Chrome uses for an unpacked extension.
function extensionId(dir) {
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32)
  return [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

function removeProfile(dir, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    } catch (_) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    }
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('websocket error')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || 'cdp error'))
        else resolve(msg.result)
        return
      }
      if (msg.method) this.events.push(msg)
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
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

async function main() {
  const chrome = findChrome()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'memos-bg-'))
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  let cdp = null
  let failures = 0
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`)
    if (!ok) failures++
  }

  try {
    const id = extensionId(EXT_DIR)
    let target = null
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(300)
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target = list.find((t) => t.type === 'service_worker' && t.url.includes(id))
      } catch (_) {
        /* not up yet */
      }
    }
    if (!target) throw new Error('service worker target never appeared')

    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')
    await sleep(600)

    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails).slice(0, 200))
      }
      return res.result.value
    }

    const globals = await evaluate(
      `JSON.stringify({ menus: typeof buildMenus, click: typeof handleMenuClick, list: Array.isArray(MENUS) && MENUS.length })`
    )
    const parsed = JSON.parse(globals)
    check(
      'background loaded without throwing',
      parsed.menus === 'function' && parsed.click === 'function' && parsed.list === 4,
      globals
    )

    // Re-creating an existing id fails with "duplicate id"; that is the only
    // way to observe registration from inside the browser.
    for (const menuId of EXPECTED_MENUS) {
      const duplicate = await evaluate(`new Promise((resolve) => {
        chrome.contextMenus.create({ id: ${JSON.stringify(menuId)}, title: 'probe', contexts: ['page'] }, () => {
          resolve(String((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'created'))
        })
      })`)
      check(`menu registered: ${menuId}`, /duplicate/i.test(duplicate), duplicate)
    }

    const commands = await evaluate(`new Promise((resolve) => {
      chrome.commands.getAll((list) => resolve(JSON.stringify((list || []).map((c) => c.name))))
    })`)
    check('keyboard command registered', JSON.parse(commands).includes('open-extension'), commands)

    const appended = await evaluate(`(async () => {
      await new Promise((r) => chrome.storage.sync.set({ open_action: 'save_text', open_content: '' }, r))
      await handleMenuClick({ menuItemId: 'Memos-send-page', pageUrl: 'https://live.test/a?b=1' }, { id: 1, windowId: 1 })
      const items = await new Promise((r) => chrome.storage.sync.get(['open_content'], r))
      await new Promise((r) => chrome.storage.sync.set({ open_content: '' }, r))
      return JSON.stringify(items)
    })()`)
    check(
      'menu click appends the page url',
      JSON.parse(appended).open_content === 'https://live.test/a?b=1\n',
      appended
    )

    const badge = await evaluate(`new Promise((resolve) => {
      chrome.action.setBadgeText({ text: '' }, () => resolve(String((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'ok')))
    })`)
    check('badge can be cleared', badge === 'ok', badge)

    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    check('no runtime exceptions', exceptions.length === 0, String(exceptions.length))
  } finally {
    if (cdp) cdp.close()
    try {
      child.kill('SIGKILL')
    } catch (_) {
      /* ignore */
    }
    await sleep(300)
    removeProfile(profile)
  }

  console.log(failures === 0 ? '\nall background checks passed' : `\n${failures} background checks failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('ERROR', err && err.message ? err.message : err)
  process.exit(1)
})
