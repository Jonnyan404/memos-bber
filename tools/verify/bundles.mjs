#!/usr/bin/env node
/**
 * Static checks for the three extension bundles (chrome / firefox / edge).
 *
 * Verifies that each bundle is self-contained and that the shared adapter is
 * byte-identical between them, so a change verified in one bundle is really
 * shipped in the other two.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BUNDLES = ['chrome', 'firefox', 'edge']
const problems = []
const rows = []

const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12)
const read = (file) => fs.readFileSync(file, 'utf8')
const exists = (file) => fs.existsSync(file)

function check(bundle, name, ok, detail = '') {
  rows.push({ bundle, name, ok, detail })
  if (!ok) problems.push(`${bundle}: ${name}${detail ? ' (' + detail + ')' : ''}`)
}

for (const bundle of BUNDLES) {
  const dir = path.join(ROOT, bundle)
  const manifestPath = path.join(dir, 'manifest.json')
  let manifest = null
  try {
    manifest = JSON.parse(read(manifestPath))
  } catch (err) {
    check(bundle, 'manifest.json parses', false, err.message)
    continue
  }
  check(bundle, 'manifest.json parses', true)

  const popup =
    (manifest.action && manifest.action.default_popup) ||
    (manifest.browser_action && manifest.browser_action.default_popup) ||
    ''
  check(bundle, 'popup entry exists', Boolean(popup) && exists(path.join(dir, popup)), popup)
  const background = manifest.background || {}
  const bgFile = background.service_worker || (Array.isArray(background.scripts) ? background.scripts[0] : '')
  check(bundle, 'background entry exists', Boolean(bgFile) && exists(path.join(dir, bgFile)), bgFile || '')
  const icons = Object.values(manifest.icons || {})
  check(bundle, 'icons exist', icons.length > 0 && icons.every((icon) => exists(path.join(dir, icon))), icons.join(','))

  // Firefox ships MV3 with an event page: service workers are unsupported on
  // Firefox for Android, so `background.scripts` is the portable choice.
  if (bundle === 'firefox') {
    check(bundle, 'manifest is MV3', manifest.manifest_version === 3, String(manifest.manifest_version))
    check(bundle, 'uses action (not browser_action)', Boolean(manifest.action) && !manifest.browser_action)
    check(
      bundle,
      'background is an event page',
      Array.isArray(manifest.background && manifest.background.scripts) &&
        !(manifest.background && manifest.background.service_worker),
      JSON.stringify(manifest.background || null)
    )
    const hostPermissions = manifest.host_permissions || []
    const apiPermissions = manifest.permissions || []
    check(
      bundle,
      'host permissions separated',
      hostPermissions.length > 0 && !apiPermissions.some((p) => /^https?:\/\//.test(p)),
      apiPermissions.join(',')
    )
    const gecko = (manifest.browser_specific_settings || {}).gecko || {}
    const android = (manifest.browser_specific_settings || {}).gecko_android || {}
    check(bundle, 'declares Firefox id', Boolean(gecko.id), gecko.id || '')
    check(
      bundle,
      'data collection declared',
      Boolean(gecko.data_collection_permissions && gecko.data_collection_permissions.required),
      JSON.stringify(gecko.data_collection_permissions || null)
    )
    check(
      bundle,
      'android support declared',
      Boolean(android.strict_min_version) &&
        Boolean(gecko.strict_min_version) &&
        Number(android.strict_min_version) >= 142 &&
        Number(gecko.strict_min_version) >= 142,
      `desktop=${gecko.strict_min_version || '-'} android=${android.strict_min_version || '-'}`
    )
    check(
      bundle,
      'background handles action/openPopup',
      read(path.join(dir, 'js/background.js')).includes('chrome.action')
    )
    check(
      bundle,
      'mobile CSS guard present',
      read(path.join(dir, 'css/main.css')).includes('pointer: coarse')
    )
  }

  // every <script src> in popup.html must resolve
  const popupPath = popup ? path.join(dir, popup) : ''
  const html = popupPath && exists(popupPath) ? read(popupPath) : ''
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1].replace(/^\.\.\//, ''))
  const missing = scripts.filter((src) => !exists(path.join(dir, src)))
  check(bundle, 'all popup scripts resolve', missing.length === 0, missing.join(','))
  check(bundle, 'loads unified adapter only', scripts.includes('js/compat/memosApi.js') && !scripts.some((s) => /memosApi\.(adapter|modern|v0)/.test(s)), scripts.filter((s) => s.includes('compat')).join(','))

  // syntax-compile the runtime files (parse only)
  for (const file of ['js/oper.js', 'js/compat/memosApi.js', 'js/background.js']) {
    const target = path.join(dir, file)
    if (!exists(target)) {
      check(bundle, file + ' exists', false)
      continue
    }
    try {
      new vm.Script(read(target), { filename: target })
      check(bundle, file + ' parses', true)
    } catch (err) {
      check(bundle, file + ' parses', false, err.message)
    }
  }

  const oper = exists(path.join(dir, 'js/oper.js')) ? read(path.join(dir, 'js/oper.js')) : ''
  const css = exists(path.join(dir, 'css/main.css')) ? read(path.join(dir, 'css/main.css')) : ''
  const adapter = exists(path.join(dir, 'js/compat/memosApi.js')) ? read(path.join(dir, 'js/compat/memosApi.js')) : ''
  check(bundle, 'adapter exposes detect()', /MemosApiAdapter\s*=\s*{[\s\S]*detect: detect/.test(adapter))
  check(bundle, 'settings use adapter.detect()', oper.includes('adapter.detect('))
  check(bundle, 'failures show reason', oper.includes('memoErrorText(') && !/msg\('memoFailed'\)\s*}\)\s*}\s*\)\s*}\s*$/.test(oper))
  check(bundle, 'default visibility is PRIVATE', /memo_lock:\s*'PRIVATE'/.test(oper) && !/memo_lock:\s*'PUBLIC'/.test(oper))
  check(bundle, 'no legacy adapter symbols', !/MemosApi(Modern|V023|V020V021)/.test(oper) && !/memosApi\.(adapter|modern|v0)/.test(html))
  check(
    bundle,
    'fullscreen column is adjustable',
    oper.includes('initFullscreenColumnResize') && oper.includes('--editor-column') && oper.includes('fullscreenEditorWidth')
  )
  check(
    bundle,
    'results get their own panel',
    oper.includes("classList.add('results-open')") && css.includes('.body.fullscreen.results-open')
  )
  check(
    bundle,
    'text drops append to the draft',
    oper.includes('appendDroppedText') && oper.includes("text/uri-list")
  )
  check(
    bundle,
    'editor supports keyboard resize',
    oper.includes("handle.addEventListener('keydown', onKeyDown)") && oper.includes("'ArrowRight'")
  )
  const bg = exists(path.join(dir, 'js/background.js')) ? read(path.join(dir, 'js/background.js')) : ''
  check(
    bundle,
    'context menus rebuilt with guards',
    bg.includes('removeAll') && bg.includes('hasContextMenus()') && bg.includes('Memos-send-page')
  )
  check(bundle, 'menu click acknowledged by badge', bg.includes('setBadgeText') && bg.includes('BADGE_OK'))
  check(
    bundle,
    'keyboard command wired',
    bg.includes('chrome.commands.onCommand.addListener') && bg.includes('openEditorFromCommand')
  )
  check(
    bundle,
    'drop uploads every file',
    oper.includes('function uploadFiles(') && oper.includes('drop-active')
  )
  check(
    bundle,
    'public option can be blocked',
    oper.includes('applyVisibilityPolicy(') &&
      oper.includes("addClass('lock-blocked')") &&
      oper.includes("hasClass('lock-blocked')") &&
      oper.includes('visibilityPolicy(')
  )
  check(bundle, 'blocked visibility is styled', css.includes('.item-lock.lock-blocked'))

  // every locale must carry the new error strings (English fallback is fine,
  // but a missing key would silently show the raw key name)
  for (const locale of ['en', 'zh_CN', 'de', 'es', 'fr', 'ja', 'ko']) {
    const localePath = path.join(dir, '_locales', locale, 'messages.json')
    try {
      const data = JSON.parse(read(localePath))
      const required = [
        'errPublicForbidden',
        'errApiRemoved',
        'errAuth',
        'serverVersionLabel',
        'lockPublicBlocked',
        'picDropUnsupported',
        'sendPageTo'
      ]
      const absent = required.filter((key) => !data[key])
      check(bundle, `${locale} messages`, absent.length === 0, absent.join(','))
    } catch (err) {
      check(bundle, `${locale} messages`, false, err.message)
    }
  }
}

// VERSION at the repo root is the single source of truth for all manifests.
const versionFile = path.join(ROOT, 'VERSION')
const expectedVersion = exists(versionFile) ? read(versionFile).trim() : ''
check('shared', 'VERSION file exists', Boolean(expectedVersion), expectedVersion)
for (const bundle of BUNDLES) {
  let actual = ''
  try {
    actual = JSON.parse(read(path.join(ROOT, bundle, 'manifest.json'))).version || ''
  } catch (_) {
    actual = ''
  }
  check('shared', `${bundle} version matches VERSION`, actual === expectedVersion, `${actual} vs ${expectedVersion}`)
}

// Shared adapter must be identical across bundles.
const adapterHashes = BUNDLES.map((b) => [b, hash(path.join(ROOT, b, 'js/compat/memosApi.js'))])
const unique = new Set(adapterHashes.map(([, h]) => h))
check('shared', 'adapter identical in all bundles', unique.size === 1, adapterHashes.map(([b, h]) => `${b}=${h}`).join(' '))

// The popup is one implementation shared by all three bundles now that the
// Firefox-only drag preview was folded into the common resize code.
const popupFiles = ['js/oper.js', 'js/background.js', 'popup.html', 'css/main.css']
for (const file of popupFiles) {
  const hashes = BUNDLES.map((b) => [b, hash(path.join(ROOT, b, file))])
  check(
    'shared',
    `${file} identical in all bundles`,
    new Set(hashes.map(([, h]) => h)).size === 1,
    hashes.map(([b, h]) => `${b}=${h.slice(0, 8)}`).join(' ')
  )
}

for (const row of rows) {
  console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.bundle.padEnd(7)} ${row.name}${row.detail ? '  (' + row.detail + ')' : ''}`)
}
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} checks passing`)
if (problems.length) {
  console.log('\nProblems:')
  problems.forEach((p) => console.log(' - ' + p))
  process.exitCode = 1
}
