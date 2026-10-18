const UI_LANGUAGE_STORAGE_KEY = 'uiLanguage'

const SUPPORTED_UI_LANGUAGES = new Set(['auto', 'en', 'zh_CN', 'ja', 'ko'])

// One descriptor list drives creation, title refresh and click dispatch, so the
// three can never drift apart again.
const MENUS = [
  { id: 'Memos-send-selection', key: 'sendTo', contexts: ['selection'] },
  { id: 'Memos-send-link', key: 'sendLinkTo', contexts: ['link'] },
  { id: 'Memos-send-page', key: 'sendPageTo', contexts: ['page'] },
  { id: 'Memos-send-image', key: 'sendImageTo', contexts: ['image'] }
]

const BADGE_OK = '✓'
const BADGE_ERROR = '!'
const BADGE_OK_COLOR = '#16a34a'
const BADGE_ERROR_COLOR = '#dc2626'

function normalizeUiLanguage(value) {
  const lang = String(value || 'auto')
  return SUPPORTED_UI_LANGUAGES.has(lang) ? lang : 'auto'
}

function storageSyncGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(defaults, (items) => resolve(items || {}))
  })
}

// MV3 exposes `action`; MV2 exposed `browserAction`. Keeping both means one
// file works in either manifest, and the fallback is harmless in Chrome.
function actionApi() {
  if (chrome.action) return chrome.action
  if (chrome.browserAction) return chrome.browserAction
  return null
}

function hasContextMenus() {
  return Boolean(chrome.contextMenus && typeof chrome.contextMenus.create === 'function')
}

// A context-menu click has to be acknowledged: the popup may refuse to open
// (inactive window, Firefox for Android), and silently appending text looks
// like nothing happened.
function setBadge(text, color) {
  const api = actionApi()
  if (!api || typeof api.setBadgeText !== 'function') return
  try {
    if (color && typeof api.setBadgeBackgroundColor === 'function') {
      api.setBadgeBackgroundColor({ color: color })
    }
    api.setBadgeText({ text: text || '' })
  } catch (_) {
    // best-effort only
  }
}

function clearBadge() {
  setBadge('')
}

function pageReadSelectionText() {
  try {
    const active = document.activeElement
    const isTextInput =
      active &&
      (active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' &&
          /^(text|search|url|tel|email|password)$/i.test(active.type || 'text')))

    if (isTextInput && typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
      return String(active.value || '').slice(active.selectionStart, active.selectionEnd).replace(/\r\n?/g, '\n')
    }

    const sel = window.getSelection && window.getSelection()
    if (!sel) return ''
    return String(sel.toString() || '').replace(/\r\n?/g, '\n')
  } catch (_) {
    return ''
  }
}

// `frameId` matters: a selection inside an iframe is invisible to the main
// frame, so injecting into `info.frameId` is what makes that case work.
function getSelectionTextFromTab(tab, frameId, fallbackText) {
  return new Promise((resolve) => {
    const fallback = typeof fallbackText === 'string' ? fallbackText : ''
    const tabId = tab && tab.id
    if (!tabId || !chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      resolve(fallback)
      return
    }

    const target = { tabId: tabId }
    if (typeof frameId === 'number' && frameId >= 0) target.frameIds = [frameId]

    try {
      chrome.scripting.executeScript({ target: target, func: pageReadSelectionText }, (results) => {
        if (chrome.runtime.lastError) {
          resolve(fallback)
          return
        }
        const first = Array.isArray(results) ? results[0] : null
        const text = first && typeof first.result === 'string' ? first.result : ''
        resolve(text || fallback)
      })
    } catch (_) {
      resolve(fallback)
    }
  })
}

function tryOpenActionPopup(tab, onFail) {
  const api = actionApi()
  const fail = () => {
    if (typeof onFail === 'function') onFail()
  }
  if (!api || typeof api.openPopup !== 'function') {
    fail()
    return
  }

  try {
    const windowId = tab && typeof tab.windowId === 'number' ? tab.windowId : undefined

    const open = () => {
      try {
        const options = typeof windowId === 'number' ? { windowId: windowId } : {}
        api.openPopup(options, () => {
          // lastError is only populated in the callback form; a throw is
          // caught below and treated the same way.
          if (chrome.runtime.lastError) fail()
        })
      } catch (_) {
        fail()
      }
    }

    // Avoid: "Cannot show popup for an inactive window".
    if (typeof windowId === 'number' && chrome.windows && typeof chrome.windows.update === 'function') {
      chrome.windows.update(windowId, { focused: true }, () => {
        void chrome.runtime.lastError
        open()
      })
      return
    }

    open()
  } catch (_) {
    fail()
  }
}

// ------------------------------------------------------------------ text glue

function normalizeBlock(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

// CommonMark allows `<...>` destinations, which is the only way a URL with
// parentheses (very common on wikis) survives as a link.
function markdownLink(label, url) {
  const href = normalizeBlock(url)
  if (!href) return ''
  const destination = /[)\s]/.test(href) ? '<' + href + '>' : href
  return '[' + label + '](' + destination + ')'
}

function markdownImage(url) {
  const src = normalizeBlock(url)
  if (!src) return ''
  const destination = /[)\s]/.test(src) ? '<' + src + '>' : src
  return '![](' + destination + ')'
}

function joinDraft(existing, block) {
  const body = normalizeBlock(block)
  if (!body) return String(existing == null ? '' : existing)
  const head = String(existing == null ? '' : existing).replace(/\s+$/, '')
  if (!head) return body + '\n'
  return head + '\n\n' + body + '\n'
}

// --------------------------------------------------------------------- menus

let cachedUiLanguage = null
let cachedOverrideMessages = null

async function loadLocaleMessages(locale) {
  if (!locale || locale === 'auto') return null
  try {
    const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`)
    const resp = await fetch(url)
    if (!resp.ok) return null
    return await resp.json()
  } catch (_) {
    return null
  }
}

async function getUiLanguage() {
  const items = await storageSyncGet({ [UI_LANGUAGE_STORAGE_KEY]: 'auto' })
  return normalizeUiLanguage(items[UI_LANGUAGE_STORAGE_KEY])
}

async function t(key) {
  const lang = await getUiLanguage()
  if (lang !== cachedUiLanguage) {
    cachedUiLanguage = lang
    cachedOverrideMessages = await loadLocaleMessages(lang)
  }

  const msg = cachedOverrideMessages && cachedOverrideMessages[key] && cachedOverrideMessages[key].message
  if (typeof msg === 'string' && msg.length > 0) return msg
  return chrome.i18n.getMessage(key) || ''
}

function updateMenuTitle(id, title) {
  if (!hasContextMenus()) return Promise.resolve()
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.update(id, { title: title }, () => {
        void chrome.runtime.lastError
        resolve()
      })
    } catch (_) {
      resolve()
    }
  })
}

// Titles follow the in-extension language override, which `i18n.getMessage`
// alone cannot do.
async function refreshMenuTitles() {
  for (const menu of MENUS) {
    await updateMenuTitle(menu.id, await t(menu.key))
  }
}

// Rebuild instead of create-on-top: an update that renames or drops an item
// would otherwise leave the old entry behind, and `create` with a duplicate id
// fails silently.
function buildMenus() {
  if (!hasContextMenus()) return
  try {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError
      for (const menu of MENUS) {
        try {
          chrome.contextMenus.create(
            {
              id: menu.id,
              type: 'normal',
              title: chrome.i18n.getMessage(menu.key) || menu.key,
              contexts: menu.contexts
            },
            () => void chrome.runtime.lastError
          )
        } catch (_) {
          // best-effort: a single bad item must not abort the rest
        }
      }
      refreshMenuTitles()
    })
  } catch (_) {
    // Context menus are unavailable on Firefox for Android.
  }
}

function openEditorFromCommand() {
  // Chrome only allows openPopup from a user gesture (a command qualifies); if
  // the API is missing or refuses, fall back to the full-tab editor.
  tryOpenActionPopup(null, () => {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?mode=full') })
    } catch (_) {
      // best-effort only
    }
  })
}

// -------------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(() => {
  buildMenus()
})

// Menus survive restarts; the titles may not match a language switched in the
// meantime, so refresh (cheap) without rebuilding.
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    refreshMenuTitles()
  })
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  if (!changes[UI_LANGUAGE_STORAGE_KEY]) return
  cachedUiLanguage = null
  cachedOverrideMessages = null
  refreshMenuTitles()
})

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-extension') openEditorFromCommand()
  })
}

async function handleMenuClick(info, tab) {
  if (!info || !MENUS.some((menu) => menu.id === info.menuItemId)) return
  clearBadge()

  let block = ''
  if (info.menuItemId === 'Memos-send-selection') {
    const selection = await getSelectionTextFromTab(tab, info.frameId, info.selectionText)
    const reference = markdownLink('Reference Link', info.linkUrl || info.pageUrl)
    block = [normalizeBlock(selection), reference].filter(Boolean).join('\n\n')
  } else if (info.menuItemId === 'Memos-send-link') {
    block = normalizeBlock(info.linkUrl)
  } else if (info.menuItemId === 'Memos-send-page') {
    block = normalizeBlock(info.pageUrl)
  } else if (info.menuItemId === 'Memos-send-image') {
    block = markdownImage(info.srcUrl)
  }

  if (!block) {
    setBadge(BADGE_ERROR, BADGE_ERROR_COLOR)
    return
  }

  const items = await storageSyncGet({ open_action: 'save_text', open_content: '' })
  if (items.open_action === 'upload_image') {
    // An upload is mid-flight and will rewrite open_content when it finishes;
    // appending now would be overwritten (or overwrite the uploader's state).
    setBadge(BADGE_ERROR, BADGE_ERROR_COLOR)
    return
  }

  const next = joinDraft(items.open_content, block)
  await new Promise((resolve) => {
    chrome.storage.sync.set({ open_action: 'save_text', open_content: next }, () => {
      void chrome.runtime.lastError
      resolve()
    })
  })

  setBadge(BADGE_OK, BADGE_OK_COLOR)
  tryOpenActionPopup(tab)
}

if (hasContextMenus()) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleMenuClick(info, tab)
  })
}
