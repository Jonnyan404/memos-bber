#!/usr/bin/env node
/**
 * Cross-version verification for the Memos browser extension API adapter.
 *
 * For every supported Memos release it boots a real container, provisions a
 * user/token, then exercises the adapter's real code (chrome/js/compat/memosApi.js)
 * through a jQuery-compatible shim:
 *
 *   detect -> authenticate -> create memo -> search -> tags -> random
 *          -> upload attachment -> create memo with attachment -> archive
 *          -> delete attachment
 *
 * Usage: node tools/verify/memos-api-matrix.mjs [--keep] [--only 0.31.0,26.10-rc.1]
 * Requires: Docker, network access for the first pull.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ADAPTER = path.join(ROOT, 'chrome/js/compat/memosApi.js')
const PORT = 15400
const BASE_URL = `http://127.0.0.1:${PORT}`
const USER = 'tester'
const PASS = 'Passw0rd!123'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const VERSIONS = [
  '0.15.0', '0.16.1', '0.18.2', '0.20.1', '0.21.0',
  '0.22.3', '0.23.1', '0.24.0', '0.25.0', '0.26.1',
  '0.27.1', '0.28.0', '0.29.1', '0.30.0', '0.31.0',
  '26.10-rc.1'
]

const argv = process.argv.slice(2)
const ONLY = (() => {
  const i = argv.indexOf('--only')
  return i >= 0 ? argv[i + 1].split(',') : null
})()
const KEEP = argv.includes('--keep')

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function containerName(version) {
  return 'memos-verify-' + version.replace(/[^a-zA-Z0-9]/g, '-')
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    let up = false
    try {
      const resp = await fetch(BASE_URL + '/api/v1/status', { signal: AbortSignal.timeout(1500) })
      const data = await resp.json().catch(() => null)
      if (resp.ok && data && data.profile && data.profile.version) return
      // 0.23+ removed /status but still serves the SPA from "/".
      if (!resp.ok || (data && data.code === 5)) {
        const root = await fetch(BASE_URL + '/', { signal: AbortSignal.timeout(1500) })
        up = root.ok
      }
    } catch (_) {
      /* not ready */
    }
    if (up) {
      await sleep(1000)
      return
    }
    await sleep(1000)
  }
  throw new Error('server did not become ready')
}

async function startContainer(version) {
  const name = containerName(version)
  try {
    sh('docker', ['rm', '-f', name])
  } catch (_) {
    /* ignore */
  }
  sh('docker', ['run', '-d', '--name', name, '-p', `${PORT}:5230`, `neosmemo/memos:${version}`])
  try {
    await waitReady()
  } catch (err) {
    let logs = ''
    try {
      logs = sh('docker', ['logs', '--tail', '8', name])
    } catch (_) {
      /* ignore */
    }
    stopContainer(name)
    throw new Error(`${err.message}\n${logs}`)
  }
  return name
}

function stopContainer(name) {
  try {
    sh('docker', ['rm', '-f', name])
  } catch (_) {
    /* ignore */
  }
}

async function http(method, urlPath, { token, body, form, raw, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) }
  let payload
  if (form) payload = form
  else if (raw) {
    payload = raw
    headers['Content-Type'] = 'application/octet-stream'
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }
  if (token) headers.Authorization = 'Bearer ' + token
  const resp = await fetch(BASE_URL + urlPath, { method, headers, body: payload, signal: AbortSignal.timeout(15000) })
  const text = await resp.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch (_) {
    json = null
  }
  const setCookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : []
  const cookieHeader = [resp.headers.get('grpc-metadata-set-cookie') || '', ...setCookies].join(';')
  return { status: resp.status, json, text, cookieHeader }
}

function tokenFromCookieHeader(header) {
  const m = /memos\.access-token=([^;]+)/.exec(header || '')
  return m ? m[1] : ''
}

async function login() {
  const attempts = []
  const bases = ['/api/v1', '/api']

  for (const base of bases) {
    // Provision a user. First admin can be created anonymously on 0.26+; older
    // builds only expose sign-up (JSON body 0.15-0.21, query 0.22-0.24).
    await http('POST', `${base}/users`, { body: { username: USER, password: PASS, role: 'ADMIN' } }).catch(() => null)
    await http('POST', `${base}/auth/signup`, { body: { username: USER, password: PASS } }).catch(() => null)
    await http('POST', `${base}/auth/signup?username=${USER}&password=${encodeURIComponent(PASS)}`).catch(() => null)

    const variants = [
      ['signin-json', () => http('POST', `${base}/auth/signin`, { body: { username: USER, password: PASS } })],
      ['signin-creds', () => http('POST', `${base}/auth/signin`, { body: { passwordCredentials: { username: USER, password: PASS } } })],
      ['signin-query', () => http('POST', `${base}/auth/signin?username=${USER}&password=${encodeURIComponent(PASS)}`)],
      ['session-creds', () => http('POST', `${base}/auth/sessions`, { body: { passwordCredentials: { username: USER, password: PASS } } })],
      ['session-flat', () => http('POST', `${base}/auth/sessions`, { body: { username: USER, password: PASS } })]
    ]

    for (const [name, fn] of variants) {
      let r
      try {
        r = await fn()
      } catch (err) {
        attempts.push(`${base} ${name}:network`)
        continue
      }
      attempts.push(`${base} ${name}:${r.status}`)
      let token = (r.json && (r.json.accessToken || (r.json.user && r.json.user.accessToken))) || tokenFromCookieHeader(r.cookieHeader)
      if (token) return { token, attempts }

      // 0.25 returns only a session cookie; exchange it for an access token.
      const session = /user_session=([^;]+)/.exec(r.cookieHeader || '')
      if (session) {
        const userRef = (r.json && r.json.user && r.json.user.name) || 'users/1'
        const id = String(userRef).split('/').pop()
        for (const tokenPath of [`/users/${id}/accessTokens`, `/users/${id}/access_tokens`]) {
          const t = await http('POST', base + tokenPath, {
            body: { description: 'verify' },
            headers: { Cookie: 'user_session=' + session[1] }
          })
          attempts.push(`${base} token${tokenPath}:${t.status}`)
          if (t.json && (t.json.accessToken || t.json.access_token)) {
            return { token: t.json.accessToken || t.json.access_token, attempts }
          }
        }
      }
    }
  }
  return { token: '', attempts }
}

// --------------------------------------------------------------- browser shim

function createShimContext() {
  class FileReaderShim {
    readAsDataURL(file) {
      file
        .arrayBuffer()
        .then((buf) => {
          this.result = `data:${file.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`
          if (this.onload) this.onload({ target: { result: this.result } })
        })
        .catch((err) => {
          if (this.onerror) this.onerror(err)
        })
    }
  }

  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    FormData,
    File,
    Blob,
    FileReader: FileReaderShim,
    dayjs: () => ({ format: () => new Date().toISOString().replace(/\D/g, '').slice(0, 14) })
  }

  ctx.window = ctx
  ctx.$ = {
    ajax(settings) {
      const doneCbs = []
      const failCbs = []
      const chain = {
        done(cb) {
          doneCbs.push(cb)
          return chain
        },
        fail(cb) {
          failCbs.push(cb)
          return chain
        }
      }
      const headers = settings.headers || {}
      let body
      if (settings.data instanceof FormData) body = settings.data
      else if (typeof settings.data === 'string') {
        body = settings.data
        headers['Content-Type'] = settings.contentType || 'application/json'
      }
      fetch(settings.url, { method: settings.type || 'GET', headers, body, signal: AbortSignal.timeout(20000) })
        .then(async (resp) => {
          const text = await resp.text()
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch (_) {
            json = null
          }
          if (!resp.ok) {
            const xhr = { status: resp.status, statusText: resp.statusText, responseText: text, responseJSON: json }
            failCbs.forEach((cb) => cb(xhr))
            return
          }
          if (json === null && text && settings.dataType === 'json') {
            const xhr = { status: resp.status, statusText: 'parsererror', responseText: text, responseJSON: null }
            failCbs.forEach((cb) => cb(xhr))
            return
          }
          doneCbs.forEach((cb) => cb(json))
        })
        .catch((err) => {
          const xhr = { status: 0, statusText: String(err && err.message ? err.message : err), responseText: '', responseJSON: null }
          failCbs.forEach((cb) => cb(xhr))
        })
      return chain
    }
  }
  return ctx
}

const ctx = createShimContext()
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(ADAPTER, 'utf8'), ctx, { filename: ADAPTER })
const A = ctx.MemosApiAdapter

function callWith(method) {
  return new Promise((resolve, reject) => {
    method(
      (value) => resolve(value),
      (err) => reject(err)
    )
  })
}

// --------------------------------------------------------------------- checks

async function runVersion(version) {
  const report = { version, checks: [], notes: [] }
  const name = await startContainer(version)
  try {
    const session = await login()
    report.login = session
    if (!session.token) {
      report.checks.push({ name: 'login', ok: false, detail: session.attempts.join(' ') })
      return report
    }
    const detected = await new Promise((resolve, reject) => {
      A.detect(BASE_URL + '/', session.token, (err, result) => (err ? reject(err) : resolve(result)))
    })
    report.detected = {
      version: detected.version,
      era: detected.era,
      base: detected.base,
      userRef: detected.userRef
    }
    report.checks.push({ name: 'detect', ok: Boolean(detected.era && detected.era !== 'unknown' && detected.userRef), detail: `${detected.version || 'no-version'} ${detected.era} ${detected.base}` })

    const info = {
      apiUrl: BASE_URL + '/',
      apiTokens: session.token,
      apiVersion: detected.version,
      apiBase: detected.base,
      userRef: detected.userRef,
      apiFlavor: detected.flavor
    }
    const api = A.resolve(info)

    const stamp = 'probe-' + Date.now()
    const created = await callWith((ok, bad) =>
      api.createMemo({ content: `adapter check ${stamp} #verifytag`, visibility: 'PRIVATE', resourceIdList: [] }, ok, bad)
    )
    report.checks.push({ name: 'createMemo', ok: Boolean(created && created.content), detail: A.memoRef(created) })

    const tags = await callWith((ok, bad) => api.listTags(ok, bad))
    report.checks.push({ name: 'listTags', ok: Array.isArray(tags) && tags.indexOf('verifytag') !== -1, detail: (tags || []).slice(0, 6).join(',') })

    const search = await callWith((ok, bad) => api.searchMemos(stamp, ok, bad))
    report.checks.push({ name: 'searchMemos', ok: Array.isArray(search) && search.length >= 1, detail: String((search || []).length) })

    const random = await callWith((ok, bad) => api.listRandomMemos(ok, bad))
    report.checks.push({ name: 'listRandomMemos', ok: Array.isArray(random) && random.length >= 1, detail: String((random || []).length) })

    const ref = A.memoRef(created)
    const fetched = await callWith((ok, bad) => api.getMemo(ref, ok, bad))
    report.checks.push({ name: 'getMemo', ok: Boolean(fetched && String(fetched.content || '').indexOf(stamp) !== -1), detail: ref })

    const file = new File([PNG], 'verify.png', { type: 'image/png' })
    const uploaded = await callWith((ok, bad) => api.uploadFile(file, {}, ok, bad))
    report.checks.push({ name: 'uploadFile', ok: Boolean(uploaded && (uploaded.name || uploaded.id != null)), detail: uploaded ? uploaded.name || String(uploaded.id) : 'none' })

    const withAttachment = await callWith((ok, bad) =>
      api.createMemo({ content: `attachment check ${stamp}`, visibility: 'PRIVATE', resourceIdList: uploaded ? [uploaded] : [] }, ok, bad)
    )
    const fetchedAttached = await callWith((ok, bad) => api.getMemo(A.memoRef(withAttachment), ok, bad))
    const attachments =
      (fetchedAttached && (fetchedAttached.attachments || fetchedAttached.resources || fetchedAttached.resourceList)) || []
    report.checks.push({
      name: 'attachToMemo',
      ok: attachments.length >= 1,
      detail: uploaded ? uploaded.name || String(uploaded.id) : 'none'
    })

    const archived = await callWith((ok, bad) => api.archiveMemo(created, ok, bad))
    const fetchedArchived = await callWith((ok, bad) => api.getMemo(ref, ok, bad))
    const state = fetchedArchived ? String(fetchedArchived.state || fetchedArchived.rowStatus || '') : ''
    report.checks.push({ name: 'archiveMemo', ok: /ARCHIVED/i.test(state), detail: state || 'unknown' })

    if (uploaded) {
      await callWith((ok, bad) => api.deleteResource(uploaded, ok, bad))
      report.checks.push({ name: 'deleteResource', ok: true, detail: uploaded.name || String(uploaded.id) })
    }
  } catch (err) {
    report.checks.push({ name: 'exception', ok: false, detail: err && (err.kind || err.status) ? `${err.kind}/${err.status} ${err.message || ''}`.trim() : String(err && err.message ? err.message : JSON.stringify(err)) })
  } finally {
    if (!KEEP) stopContainer(name)
  }
  return report
}

async function main() {
  const versions = ONLY ? VERSIONS.filter((v) => ONLY.includes(v)) : VERSIONS
  const reports = []
  for (const version of versions) {
    process.stdout.write(`\n=== ${version}\n`)
    let report
    try {
      report = await runVersion(version)
    } catch (err) {
      report = { version, checks: [{ name: 'start', ok: false, detail: String(err && err.message ? err.message : err) }] }
    }
    for (const check of report.checks) {
      console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? '  (' + check.detail + ')' : ''}`)
    }
    reports.push(report)
  }

  const out = path.join(ROOT, 'tools/verify/last-run.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(reports, null, 2))
  const failed = reports.filter((r) => r.checks.some((c) => !c.ok))
  console.log(`\n${reports.length - failed.length}/${reports.length} versions fully passing`)
  console.log(`raw report: ${path.relative(ROOT, out)}`)
  process.exitCode = failed.length ? 1 : 0
}

main()
