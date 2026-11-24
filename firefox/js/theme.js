/**
 * Light / dark / system theme for the popup.
 *
 * The mode lives in storage.sync so it follows the Chrome profile, and is
 * mirrored into localStorage: storage.sync is asynchronous, so without a
 * synchronous copy the popup paints one light frame before it can switch.
 *
 * Three states rather than two: "auto" follows the OS and is what most people
 * want, and a toggle that can only flip light/dark has no way back to it.
 */
;(function () {
  const KEY = 'uiTheme'
  const MODES = ['auto', 'light', 'dark']
  const LABELS = { auto: 'themeAuto', light: 'themeLight', dark: 'themeDark' }
  let mode = 'auto'
  let media = null

  function normalize(value) {
    return MODES.indexOf(value) === -1 ? 'auto' : value
  }

  function label(key) {
    return typeof window.t === 'function' ? window.t(key) : ''
  }

  function resolved() {
    if (mode !== 'auto') return mode
    return media && media.matches ? 'dark' : 'light'
  }

  function paint() {
    const root = document.documentElement
    root.dataset.theme = resolved()
    root.dataset.themeMode = mode
    const toggle = document.getElementById('themeToggle')
    if (!toggle) return
    toggle.dataset.mode = mode
    const text = label(LABELS[mode]) || mode
    toggle.setAttribute('title', text)
    toggle.setAttribute('aria-label', text)
  }

  function remember(next) {
    mode = normalize(next)
    try {
      window.localStorage.setItem(KEY, mode)
    } catch (_) {
      // A private window can refuse localStorage; the synced copy still works.
    }
    try {
      chrome.storage.sync.set({ [KEY]: mode })
    } catch (_) {
      // best-effort only
    }
    paint()
  }

  function cycle() {
    remember(MODES[(MODES.indexOf(mode) + 1) % MODES.length])
  }

  function init() {
    media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
    // Paint from the cached value first (synchronous, no flash), then reconcile
    // with the synced one in case another profile changed it.
    try {
      const cached = window.localStorage.getItem(KEY)
      if (cached) mode = normalize(cached)
    } catch (_) {
      // ignore
    }
    paint()

    try {
      chrome.storage.sync.get({ [KEY]: 'auto' }, function (items) {
        const stored = normalize(items && items[KEY])
        if (stored === mode) return
        mode = stored
        paint()
      })
    } catch (_) {
      // ignore
    }

    const toggle = document.getElementById('themeToggle')
    if (toggle) toggle.addEventListener('click', cycle)

    if (media) {
      const onChange = function () {
        if (mode === 'auto') paint()
      }
      if (media.addEventListener) media.addEventListener('change', onChange)
      else if (media.addListener) media.addListener(onChange)
    }

    // A language switch changes the label, not the theme.
    window.addEventListener('i18n:changed', paint)
  }

  window.setUiTheme = remember
  window.getUiTheme = function () {
    return mode
  }
  init()
})()
