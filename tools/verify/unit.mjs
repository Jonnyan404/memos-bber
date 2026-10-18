#!/usr/bin/env node
/**
 * Unit checks for the adapter's pure helpers (no Docker, no browser).
 * Kept dependency-free so it runs in the bundle CI job.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ctx = { window: {}, console, Date, JSON, Math, isFinite, isNaN, encodeURIComponent, Promise }
ctx.window = ctx
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/js/compat/memosApi.js'), 'utf8'), ctx)
const A = ctx.MemosApiAdapter

let failures = 0
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
  if (!ok) failures++
}

const v = (raw) => A.parseVersion(raw)
eq('parse 0.15.0', [v('0.15.0').major, v('0.15.0').minor, v('0.15.0').patch], [0, 15, 0])
eq('parse v0.31.0 tag', [v('v0.31.0').major, v('v0.31.0').minor], [0, 31])
eq('parse 26.10-rc.1', [v('26.10-rc.1').major, v('26.10-rc.1').minor], [26, 10])
eq('parse garbage', v('build-abc'), null)

eq('era 0.15', A.eraOfVersion(v('0.15.0')), 'legacy')
eq('era 0.21', A.eraOfVersion(v('0.21.0')), 'legacy')
eq('era 0.22', A.eraOfVersion(v('0.22.3')), 'v1-filter')
eq('era 0.23', A.eraOfVersion(v('0.23.1')), 'v1-filter')
eq('era 0.24', A.eraOfVersion(v('0.24.0')), 'v1-modern')
eq('era 0.31', A.eraOfVersion(v('0.31.0')), 'v1-modern')
eq('era 26.10', A.eraOfVersion(v('26.10-rc.1')), 'v2')
eq('flavor legacy', A.flavorOf('legacy'), 'v020-v021')
eq('flavor v1-filter', A.flavorOf('v1-filter'), 'v023')
eq('flavor v2', A.flavorOf('v2'), 'modern')

eq('memoRef numeric only', A.memoRef({ id: 7 }), 'memo/7')
eq('memoRef modern name', A.memoRef({ name: 'memos/abc', uid: 'abc' }), 'memos/abc')
eq('memoRef legacy bare uid', A.memoRef({ id: 3, name: 'bareUid' }), 'memo/3')
eq('memoRef uid only', A.memoRef({ uid: 'abc' }), 'memos/abc')
eq('memoRef numeric name', A.memoNumericId({ name: 'memos/12' }), 12)
eq('memoNumericId uid name', A.memoNumericId({ name: 'memos/abc' }), null)

const err = (status, body) => A.errorInfo({ status, responseJSON: body, statusText: '' })
eq('error 403 public', err(403, { code: 7, message: 'disable public memos system setting is enabled' }).hint, 'publicForbidden')
eq('error 410', err(410, { code: 12, message: 'API v1 has been removed' }).hint, 'apiRemoved')
eq('error 401', err(401, { message: 'authentication required' }).hint, 'auth')
eq('error 0', err(0, null).kind, 'network')
eq('error 500', err(500, { message: 'boom' }).kind, 'server')

eq(
  'tags from property',
  A.extractTags({ content: 'x', property: { tags: ['a', 'b'] } }),
  ['a', 'b']
)
eq('tags from content', A.extractTags({ content: 'hi #tag1 #tag2!' }), ['tag1', 'tag2'])
eq(
  'normalize attachment',
  (() => {
    const r = A.normalizeResource({ attachment: { name: 'attachments/u1', filename: 'a.png', type: 'image/png' } })
    return [r.name, r.filename, r.type]
  })(),
  ['attachments/u1', 'a.png', 'image/png']
)
eq(
  'normalize legacy resource',
  (() => {
    const r = A.normalizeResource({ id: 5, filename: 'b.png' })
    return [r.id, r.name]
  })(),
  [5, 'resources/5']
)

// ------------------------------------------------------------- background.js
// The menu handlers are the part of the extension that cannot be driven from a
// popup harness, so they run here against a chrome mock: a real listener, real
// dispatch, and the storage write inspected afterwards.
function createChromeMock(options = {}) {
  const state = {
    menus: [],
    badges: [],
    openedPopups: 0,
    tabs: [],
    setCalls: [],
    selectionTargets: [],
    storage: Object.assign({}, options.storage || {}),
    listeners: { installed: [], clicked: [], storage: [], command: [], startup: [] },
    popupFails: Boolean(options.popupFails),
    selection: options.selection || '',
    withMenus: options.withMenus !== false,
    withCommands: options.withCommands !== false
  }

  const chrome = {
    runtime: {
      id: 'memos-bber@test',
      getURL: (p) => 'moz-extension://test/' + p,
      lastError: undefined,
      onInstalled: { addListener: (fn) => state.listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => state.listeners.startup.push(fn) }
    },
    storage: {
      sync: {
        get: (defaults, cb) => {
          const out = Object.assign({}, defaults)
          for (const key of Object.keys(defaults)) {
            if (state.storage[key] !== undefined) out[key] = state.storage[key]
          }
          cb(out)
        },
        set: (items, cb) => {
          state.setCalls.push(items)
          Object.assign(state.storage, items)
          if (cb) cb()
        }
      },
      onChanged: { addListener: (fn) => state.listeners.storage.push(fn) }
    },
    i18n: { getMessage: (key) => 'i18n:' + key },
    action: {
      openPopup: (options, cb) => {
        if (state.popupFails) {
          chrome.runtime.lastError = { message: 'no gesture' }
          if (cb) cb()
          chrome.runtime.lastError = undefined
          return
        }
        state.openedPopups++
        if (cb) cb()
      },
      setBadgeText: (options) => state.badges.push(options.text),
      setBadgeBackgroundColor: () => {}
    },
    tabs: { create: (options) => state.tabs.push(options) },
    scripting: {
      executeScript: (injection, cb) => {
        state.selectionTargets.push(injection.target)
        cb([{ result: state.selection }])
      }
    }
  }

  if (state.withMenus) {
    chrome.contextMenus = {
      removeAll: (cb) => {
        state.menus = []
        if (cb) cb()
      },
      create: (options, cb) => {
        state.menus.push(options)
        if (cb) cb()
      },
      update: (id, update, cb) => {
        const menu = state.menus.find((m) => m.id === id)
        if (menu) menu.title = update.title
        if (cb) cb()
      },
      onClicked: { addListener: (fn) => state.listeners.clicked.push(fn) }
    }
  }

  if (state.withCommands) {
    chrome.commands = { onCommand: { addListener: (fn) => state.listeners.command.push(fn) } }
  }

  return { chrome, state }
}

function loadBackground(options) {
  const mock = createChromeMock(options)
  const sandbox = {
    chrome: mock.chrome,
    console,
    Promise,
    JSON,
    Date,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('no network in unit test'))
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'firefox/js/background.js'), 'utf8'), sandbox)
  return mock
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

function quiet(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err
  }
}

async function click(mock, info, tab = { id: 1, windowId: 1 }) {
  mock.state.listeners.clicked[0](info, tab)
  await flush()
  return mock.state
}

const desktop = loadBackground()
eq('bg desktop registers onInstalled', desktop.state.listeners.installed.length, 1)
eq('bg desktop registers context menu clicks', desktop.state.listeners.clicked.length, 1)
eq('bg desktop registers command listener', desktop.state.listeners.command.length, 1)
eq('bg desktop onInstalled throw', quiet(() => desktop.state.listeners.installed[0]()), null)
await flush()
eq(
  'bg desktop creates four menus',
  desktop.state.menus.map((m) => m.id),
  ['Memos-send-selection', 'Memos-send-link', 'Memos-send-page', 'Memos-send-image']
)
eq('bg selection menu contexts', desktop.state.menus[0].contexts, ['selection'])
eq('bg page and link are separate items', [desktop.state.menus[1].contexts, desktop.state.menus[2].contexts], [['link'], ['page']])

// page: appends the URL, acknowledges with a badge and opens the popup
{
  const mock = loadBackground()
  mock.state.listeners.installed[0]()
  await flush()
  const state = await click(mock, { menuItemId: 'Memos-send-page', pageUrl: 'https://example.com/a?b=1' })
  eq('bg page appends url', state.storage.open_content, 'https://example.com/a?b=1\n')
  eq('bg page opens popup', state.openedPopups, 1)
  eq('bg page badge', state.badges.filter(Boolean), ['✓'])
}

// link: a URL with parentheses must stay intact
{
  const mock = loadBackground()
  const state = await click(mock, { menuItemId: 'Memos-send-link', linkUrl: 'https://wiki.test/Foo_(bar)' })
  eq('bg link keeps parentheses', state.storage.open_content, 'https://wiki.test/Foo_(bar)\n')
}

// selection: CRLF normalised, reference link appended with angle brackets
{
  const mock = loadBackground({ selection: 'line1\r\nline2\r\n', storage: { open_content: 'existing' } })
  const state = await click(mock, { menuItemId: 'Memos-send-selection', pageUrl: 'https://wiki.test/Foo_(bar)', frameId: 3 })
  eq(
    'bg selection block',
    state.storage.open_content,
    'existing\n\nline1\nline2\n\n[Reference Link](<https://wiki.test/Foo_(bar)>)\n'
  )
  eq('bg selection uses the clicked frame', state.selectionTargets[0].frameIds, [3])
}

// image: markdown image with an angle-bracket destination when needed
{
  const mock = loadBackground()
  const state = await click(mock, { menuItemId: 'Memos-send-image', srcUrl: 'https://img.test/a_(1).png' })
  eq('bg image markdown', state.storage.open_content, '![](<https://img.test/a_(1).png>)\n')
}

// mid-upload clicks must not race the uploader
{
  const mock = loadBackground({ storage: { open_action: 'upload_image', open_content: 'draft' } })
  const state = await click(mock, { menuItemId: 'Memos-send-link', linkUrl: 'https://x.test/' })
  eq('bg upload guard keeps storage', state.setCalls.length, 0)
  eq('bg upload guard badge', state.badges.filter(Boolean), ['!'])
  eq('bg upload guard no popup', state.openedPopups, 0)
}

// unknown menu id is ignored
{
  const mock = loadBackground()
  const state = await click(mock, { menuItemId: 'something-else' })
  eq('bg unknown id ignored', state.setCalls.length, 0)
}

// keyboard command opens the popup; falls back to the full-tab editor
{
  const mock = loadBackground()
  mock.state.listeners.command[0]('open-extension')
  await flush()
  eq('bg command opens popup', mock.state.openedPopups, 1)

  const failing = loadBackground({ popupFails: true })
  failing.state.listeners.command[0]('open-extension')
  await flush()
  eq('bg command falls back to a tab', failing.state.tabs.map((t) => t.url), ['moz-extension://test/popup.html?mode=full'])
}

// Android: no context menus, no commands
{
  const mock = loadBackground({ withMenus: false, withCommands: false })
  eq('bg android onInstalled throw', quiet(() => mock.state.listeners.installed[0]()), null)
  eq('bg android creates no menus', mock.state.menus.length, 0)
  eq('bg android no click listener', mock.state.listeners.clicked.length, 0)
}

console.log(`\n${failures === 0 ? 'all unit checks passed' : failures + ' unit checks failed'}`)
process.exit(failures === 0 ? 0 : 1)
