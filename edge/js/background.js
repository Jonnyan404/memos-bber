const UI_LANGUAGE_STORAGE_KEY = 'uiLanguage'

const SUPPORTED_UI_LANGUAGES = new Set(['auto', 'en', 'zh_CN', 'ja', 'ko', 'de'])

function normalizeUiLanguage(value) {
  const lang = String(value || 'auto')
  return SUPPORTED_UI_LANGUAGES.has(lang) ? lang : 'auto'
}

function storageSyncGet(defaults) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(defaults, (items) => resolve(items || {}))
  })
}

function updateContextMenu(id, update) {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.update(id, update, () => resolve())
    } catch (_) {
      resolve()
    }
  })
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

function getSelectionTextFromTab(tabId, fallbackText) {
  return new Promise((resolve) => {
    const fallback = typeof fallbackText === 'string' ? fallbackText : ''
    if (!tabId || !chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      resolve(fallback)
      return
    }

    try {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          func: pageReadSelectionText
        },
        (results) => {
          if (chrome.runtime.lastError) {
            resolve(fallback)
            return
          }
          const first = Array.isArray(results) ? results[0] : null
          const text = first && typeof first.result === 'string' ? first.result : ''
          resolve(text || fallback)
        }
      )
    } catch (_) {
      resolve(fallback)
    }
  })
}

function tryOpenActionPopup(tab) {
  try {
    if (!chrome.action || typeof chrome.action.openPopup !== 'function') return
    const windowId = tab && typeof tab.windowId === 'number' ? tab.windowId : undefined

    const open = () => {
      try {
        if (typeof windowId === 'number') {
          chrome.action.openPopup({ windowId }, () => void chrome.runtime.lastError)
        } else {
          chrome.action.openPopup({}, () => void chrome.runtime.lastError)
        }
      } catch (_) {
        // best-effort only
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
    // best-effort only
  }
}

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

async function refreshContextMenus() {
  await updateContextMenu('Memos-send-selection', { title: await t('sendTo') })
  await updateContextMenu('Memos-send-link', { title: await t('sendLinkTo') })
  await updateContextMenu('Memos-send-image', { title: await t('sendImageTo') })
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    type: 'normal',
    title: chrome.i18n.getMessage('sendTo'),
    id: 'Memos-send-selection',
    contexts: ['selection']
  })
  chrome.contextMenus.create({
    type: 'normal',
    title: chrome.i18n.getMessage('sendLinkTo'),
    id: 'Memos-send-link',
    contexts: ['link', 'page']
  })
  chrome.contextMenus.create({
    type: 'normal',
    title: chrome.i18n.getMessage('sendImageTo'),
    id: 'Memos-send-image',
    contexts: ['image']
  })

  // Apply override titles if user selected a fixed language.
  refreshContextMenus()
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return
  if (!changes[UI_LANGUAGE_STORAGE_KEY]) return
  cachedUiLanguage = null
  cachedOverrideMessages = null
  refreshContextMenus()
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const appendContent = (tempCont, { openPopup } = { openPopup: false }) => {
    chrome.storage.sync.get({ open_action: 'save_text', open_content: '' }, function (items) {
      if (items.open_action === 'upload_image') {
        t('picPending').then((m) => alert(m))
        return
      }

      chrome.storage.sync.set(
        {
          open_action: 'save_text',
          open_content: items.open_content + tempCont
        },
        function () {
          if (openPopup) tryOpenActionPopup(tab)
        }
      )
    })
  }

  if (info.menuItemId === 'Memos-send-selection') {
    const ref = info.linkUrl || info.pageUrl
    const tabId = tab && tab.id

    getSelectionTextFromTab(tabId, info.selectionText).then((selectionText) => {
      const tempCont = selectionText + '\n' + `[Reference Link](${ref})` + '\n'
      appendContent(tempCont, { openPopup: true })
    })
    return
  }

  if (info.menuItemId === 'Memos-send-link') {
    appendContent((info.linkUrl || info.pageUrl) + '\n')
    return
  }

  if (info.menuItemId === 'Memos-send-image') {
    appendContent(`![](${info.srcUrl})` + '\n')
  }
})