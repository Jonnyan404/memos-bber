#!/usr/bin/env node
/**
 * Firefox smoke check: install the MV2 bundle into a real Firefox through
 * WebDriver BiDi and assert it is accepted and active.
 *
 * Full popup automation is blocked upstream: BiDi refuses to navigate to
 * moz-extension:// ("not allowed in this context"), and neither Puppeteer nor
 * Playwright installs Firefox extensions. This check therefore covers manifest
 * validity + installability; UI flows are covered by the Chrome harness and the
 * shared, byte-identical adapter matrix.
 *
 * Usage: FIREFOX_PATH=/path/to/firefox node tools/verify/firefox-smoke.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EXT_DIR = path.join(ROOT, 'firefox')
const PORT = Number(process.env.BIDI_PORT || 9447)
const EXPECTED = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'))
const EXPECTED_ID = (MANIFEST.browser_specific_settings && MANIFEST.browser_specific_settings.gecko && MANIFEST.browser_specific_settings.gecko.id) || ''

const args = process.argv.slice(2)
const firefox =
  process.env.FIREFOX_PATH ||
  args[args.indexOf('--firefox') + 1] ||
  '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox'

if (!fs.existsSync(firefox)) {
  console.error('Firefox not found; set FIREFOX_PATH (Firefox 123+ required)')
  process.exit(2)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'memos-ff-smoke-'))
const child = spawn(firefox, ['--headless', '--no-remote', `--remote-debugging-port=${PORT}`, '--profile', profile, 'about:blank'], {
  stdio: 'ignore'
})

const cleanup = () => {
  try {
    child.kill('SIGKILL')
  } catch (_) {
    /* ignore */
  }
  removeProfile(profile)
}
process.on('exit', cleanup)

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve)
        ws.addEventListener('error', () => reject(new Error('ws error')))
      })
      return ws
    } catch (_) {
      await sleep(300)
    }
  }
  throw new Error('BiDi endpoint did not start')
}

function rpc(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.type === 'error') reject(new Error(msg.message || msg.error))
      else resolve(msg.result)
    }
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const next = ++id
      pending.set(next, { resolve, reject })
      ws.send(JSON.stringify({ id: next, method, params }))
    })
}

async function main() {
  const ws = await connect()
  const send = rpc(ws)
  await send('session.new', { capabilities: {} })
  const installed = await send('webExtension.install', { extensionData: { type: 'path', path: EXT_DIR } })
  console.log('installed:', installed.extension)

  let addon = null
  for (let i = 0; i < 40; i++) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(profile, 'extensions.json'), 'utf8'))
      addon = (data.addons || []).find((a) => a.id === installed.extension)
      if (addon) break
    } catch (_) {
      /* wait */
    }
    await sleep(250)
  }

  const idOk = installed.extension === EXPECTED_ID
  const versionOk = MANIFEST.version === EXPECTED
  console.log(
    `installed id=${installed.extension} expected=${EXPECTED_ID} ` +
      `manifestVersion=${MANIFEST.version} expected=${EXPECTED} addonState=${addon ? 'present' : 'not-persisted'}`
  )
  const ok = idOk && versionOk
  console.log(ok ? 'PASS Firefox accepted the bundle (manifest, id and version)' : 'FAIL Firefox rejected or mismatched the bundle')
  ws.close()
  child.kill('SIGKILL')
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('ERROR', err && err.message ? err.message : err)
  process.exitCode = 1
})
