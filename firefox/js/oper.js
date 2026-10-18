// A missing plugin file must not brick the popup: the card timestamp falls back
// to an absolute date below.
if (window.dayjs_plugin_relativeTime) {
  dayjs.extend(window.dayjs_plugin_relativeTime)
}
let currentMemoLock = ''

function isFullscreenMode() {
  try {
    const params = new URLSearchParams(window.location.search || '')
    return params.get('mode') === 'full'
  } catch (_) {
    return false
  }
}

function openFullscreenTab() {
  try {
    const url = chrome.runtime.getURL('popup.html?mode=full')
    chrome.tabs.create({ url })
  } catch (_) {
    // best-effort only
  }
}

// Free resize of the editor. Width and height move independently (hold Shift
// to keep the ratio); during the drag only a CSS transform is applied, because
// resizing the real popup on every pointermove makes Chrome jitter. The real
// size is committed on release and persisted.
function initEditorResize() {
  try {
    if (isFullscreenMode()) return

    const editor = document.querySelector('.memo-editor')
    const tools = document.querySelector('.common-tools-wrapper')
    const handle = document.getElementById('editor-resize-handle')
    if (!editor || !tools || !handle) return

    const safety = 8
    const initialRect = editor.getBoundingClientRect()
    const baseW = Math.ceil(initialRect.width)
    const baseH = Math.ceil(initialRect.height)

    // Lock the base size; only width/height change while resizing.
    editor.style.width = `${baseW}px`
    editor.style.height = `${baseH}px`
    editor.style.minWidth = `${baseW}px`
    editor.style.minHeight = `${baseH}px`

    const storageKey = 'popupEditorSize'
    const legacyScaleKey = 'popupEditorScale'

    // Everything that is not the editor and still on screen. Measured live: at
    // first run the settings panel is open, and a cached value would keep the
    // editor from ever growing after the panel collapses.
    const measureChrome = () => {
      let extra = safety
      const bodyStyle = window.getComputedStyle(document.body)
      extra += (parseFloat(bodyStyle.paddingTop) || 0) + (parseFloat(bodyStyle.paddingBottom) || 0)
      Array.prototype.forEach.call(document.body.children, (el) => {
        if (el === editor) return
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') return
        const rect = el.getBoundingClientRect()
        if (!rect.height) return
        extra += rect.height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0)
      })
      return Math.ceil(extra)
    }

    // Chrome caps popups at 800x600; on Android the panel is the screen, so the
    // smaller of the two wins (growing past it would just clip the UI).
    const screenW = (window.screen && window.screen.availWidth) || 800
    const screenH = (window.screen && window.screen.availHeight) || 600
    const viewportW = Math.min(800, screenW)
    const viewportH = Math.min(600, screenH)

    let maxW = baseW
    let maxH = baseH
    let width = baseW
    let height = baseH
    let dragging = false
    let startX = 0
    let startY = 0
    let startW = baseW
    let startH = baseH
    let previewW = baseW
    let previewH = baseH

    const clampW = (value) => Math.min(Math.max(Math.round(value), baseW), maxW)
    const clampH = (value) => Math.min(Math.max(Math.round(value), baseH), maxH)
    const describe = (w, h) => handle.setAttribute('aria-valuetext', `${w} x ${h}`)

    const applySize = (w, h) => {
      width = clampW(w)
      height = clampH(h)
      editor.style.width = `${width}px`
      editor.style.height = `${height}px`
      describe(width, height)
    }

    const clearPreview = () => {
      editor.style.transform = ''
      editor.style.transformOrigin = ''
    }

    const showPreview = (w, h) => {
      previewW = clampW(w)
      previewH = clampH(h)
      editor.style.transformOrigin = 'top left'
      editor.style.transform = `scale(${previewW / width}, ${previewH / height})`
      describe(previewW, previewH)
    }

    const remember = () => {
      try {
        chrome.storage.sync.set({ [storageKey]: { width: width, height: height } })
      } catch (_) {
        // ignore
      }
      try {
        if (window.localStorage) {
          window.localStorage.setItem(storageKey, JSON.stringify({ width: width, height: height }))
        }
      } catch (_) {
        // ignore
      }
    }

    const computeMax = () => {
      if (dragging) return
      const extraWidth = safety * 2
      maxW = Math.max(baseW, Math.floor(viewportW - extraWidth))
      maxH = Math.max(baseH, Math.floor(viewportH - measureChrome()))
      applySize(width, height)
    }

    const endDrag = () => {
      if (!dragging) return
      dragging = false
      handle.classList.remove('dragging')
      clearPreview()
      applySize(previewW, previewH)
      computeMax()
      remember()
    }

    const onPointerMove = (ev) => {
      if (!dragging) return
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (ev.shiftKey) {
        const factor = Math.max((startW + dx) / startW, (startH + dy) / startH)
        showPreview(startW * factor, startH * factor)
        return
      }
      showPreview(startW + dx, startH + dy)
    }

    const startDrag = (ev) => {
      if (typeof ev.button === 'number' && ev.button !== 0) return
      ev.preventDefault()
      computeMax()
      dragging = true
      startX = ev.clientX
      startY = ev.clientY
      startW = width
      startH = height
      previewW = width
      previewH = height
      handle.classList.add('dragging')
      if (typeof handle.setPointerCapture === 'function') {
        try {
          handle.setPointerCapture(ev.pointerId)
        } catch (_) {
          // Ignore capture failures.
        }
      }
    }

    const onKeyDown = (ev) => {
      const amount = ev.shiftKey ? 8 : 24
      if (ev.key === 'ArrowRight') applySize(width + amount, height)
      else if (ev.key === 'ArrowLeft') applySize(width - amount, height)
      else if (ev.key === 'ArrowDown') applySize(width, height + amount)
      else if (ev.key === 'ArrowUp') applySize(width, height - amount)
      else if (ev.key === 'Home') applySize(baseW, baseH)
      else return
      ev.preventDefault()
      remember()
    }

    const resetSize = () => {
      applySize(baseW, baseH)
      remember()
    }

    computeMax()

    try {
      const localRaw = window.localStorage ? window.localStorage.getItem(storageKey) : null
      const local = localRaw ? JSON.parse(localRaw) : null
      if (local && Number(local.width) >= baseW && Number(local.height) >= baseH) {
        applySize(local.width, local.height)
      }
    } catch (_) {
      // ignore
    }

    try {
      chrome.storage.sync.get({ [storageKey]: null, [legacyScaleKey]: null }, (items) => {
        const saved = items && items[storageKey]
        if (saved && Number(saved.width) >= baseW && Number(saved.height) >= baseH) {
          applySize(saved.width, saved.height)
          return
        }
        // Migrate the single-scale value written by older builds.
        const legacy = Number(items && items[legacyScaleKey])
        if (Number.isFinite(legacy) && legacy >= 1) {
          applySize(baseW * legacy, baseH * legacy)
        }
      })
    } catch (_) {
      // ignore
    }

    handle.addEventListener('pointerdown', startDrag)
    window.addEventListener('pointermove', onPointerMove)
    handle.addEventListener('pointerup', endDrag)
    handle.addEventListener('pointercancel', endDrag)
    window.addEventListener('pointerup', endDrag)
    handle.addEventListener('keydown', onKeyDown)
    handle.addEventListener('dblclick', resetSize)
    window.addEventListener('resize', computeMax)
  } catch (_) {
    // best-effort only
  }
}

// Fullscreen has no popup to resize, so the same handle adjusts the reading
// column instead, and remembers that width separately from the popup size.
function initFullscreenColumnResize() {
  if (!isFullscreenMode()) return
  const handle = document.getElementById('editor-resize-handle')
  if (!handle) return

  const storageKey = 'fullscreenEditorWidth'
  const DEFAULT_WIDTH = 880
  const MIN_WIDTH = 480

  let width = DEFAULT_WIDTH
  let maxWidth = DEFAULT_WIDTH
  let dragging = false
  let startX = 0
  let startWidth = DEFAULT_WIDTH
  let pendingWidth = DEFAULT_WIDTH

  const clamp = (value) => Math.min(Math.max(Math.round(value), MIN_WIDTH), maxWidth)
  const describe = (value) => handle.setAttribute('aria-valuetext', `${value}px column`)
  const paint = (value) => document.body.style.setProperty('--editor-column', `${value}px`)

  const apply = (value) => {
    width = clamp(value)
    paint(width)
    describe(width)
  }

  const remember = () => {
    try {
      chrome.storage.sync.set({ [storageKey]: width })
    } catch (_) {
      // best-effort only
    }
  }

  const computeMax = () => {
    maxWidth = Math.max(MIN_WIDTH, Math.min(1200, Math.floor(window.innerWidth - 96)))
    apply(width)
  }

  const startDrag = (ev) => {
    if (typeof ev.button === 'number' && ev.button !== 0) return
    ev.preventDefault()
    dragging = true
    startX = ev.clientX
    startWidth = width
    pendingWidth = width
    handle.classList.add('dragging')
    if (typeof handle.setPointerCapture === 'function') {
      try {
        handle.setPointerCapture(ev.pointerId)
      } catch (_) {
        // Ignore capture failures.
      }
    }
  }

  const onPointerMove = (ev) => {
    if (!dragging) return
    pendingWidth = clamp(startWidth + (ev.clientX - startX))
    paint(pendingWidth)
    describe(pendingWidth)
  }

  const endDrag = () => {
    if (!dragging) return
    dragging = false
    handle.classList.remove('dragging')
    apply(pendingWidth)
    remember()
  }

  const onKeyDown = (ev) => {
    const amount = ev.shiftKey ? 8 : 24
    if (ev.key === 'ArrowRight') apply(width + amount)
    else if (ev.key === 'ArrowLeft') apply(width - amount)
    else if (ev.key === 'Home') apply(DEFAULT_WIDTH)
    else return
    ev.preventDefault()
    remember()
  }

  computeMax()

  try {
    chrome.storage.sync.get({ [storageKey]: DEFAULT_WIDTH }, (items) => {
      const saved = Number(items && items[storageKey])
      if (Number.isFinite(saved) && saved >= MIN_WIDTH) apply(saved)
    })
  } catch (_) {
    // best-effort only
  }

  handle.addEventListener('pointerdown', startDrag)
  window.addEventListener('pointermove', onPointerMove)
  handle.addEventListener('pointerup', endDrag)
  handle.addEventListener('pointercancel', endDrag)
  window.addEventListener('pointerup', endDrag)
  handle.addEventListener('keydown', onKeyDown)
  handle.addEventListener('dblclick', () => {
    apply(DEFAULT_WIDTH)
    remember()
  })
  window.addEventListener('resize', computeMax)
}

// Icons live in <template> elements (popup.html) and are cloned, so the code
// never assigns innerHTML — the AMO validator flags every such assignment.
function cloneIcon(id) {
  const template = document.getElementById(id)
  return template && template.content ? template.content.cloneNode(true) : document.createTextNode('')
}

// Memo content is untrusted (it can come from other users on a shared
// instance). It is rendered as text plus real links/images instead of being
// pasted into innerHTML, which is what used to allow markup injection.
function renderMemoContent(text) {
  const fragment = document.createDocumentFragment()
  const source = String(text == null ? '' : text)
  const pattern = /!\[[^\]]*\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)/g
  let processed = 0
  let match = pattern.exec(source)
  while (match) {
    if (match.index > processed) {
      fragment.appendChild(document.createTextNode(source.slice(processed, match.index)))
    }
    fragment.appendChild(document.createTextNode(' '))
    if (match[1]) {
      const image = document.createElement('img')
      image.className = 'random-image'
      image.src = match[1]
      fragment.appendChild(image)
    } else {
      const link = document.createElement('a')
      link.href = match[3]
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = match[2]
      fragment.appendChild(link)
    }
    fragment.appendChild(document.createTextNode(' '))
    processed = pattern.lastIndex
    match = pattern.exec(source)
  }
  if (processed < source.length) {
    fragment.appendChild(document.createTextNode(source.slice(processed)))
  }
  return fragment
}

// One card builder shared by search and random. It also gives each card its own
// buttons: the old markup repeated `id="random-link"` per card, so every button
// acted on the first memo.
function createMemoCard(memo, info, adapter) {
  const card = document.createElement('div')
  card.className = 'random-item'

  const header = document.createElement('div')
  header.className = 'random-time'

  const uid = getMemoUid(memo)
  const openButton = document.createElement('span')
  openButton.className = 'random-link'
  openButton.dataset.uid = uid
  openButton.appendChild(cloneIcon('iconOpen'))
  header.appendChild(openButton)

  const deleteButton = document.createElement('span')
  deleteButton.className = 'random-delete'
  deleteButton.dataset.uid = uid
  deleteButton.dataset.name = memo && memo.name ? memo.name : ''
  if (memo && memo.id != null) deleteButton.dataset.id = String(memo.id)
  deleteButton.appendChild(cloneIcon('iconDelete'))
  header.appendChild(deleteButton)

  header.appendChild(document.createTextNode(memoFromNow(memo)))
  card.appendChild(header)

  const content = document.createElement('div')
  content.className = 'random-content'
  content.appendChild(renderMemoContent(memo && memo.content ? memo.content : ''))
  card.appendChild(content)

  const attachments =
    memo && Array.isArray(memo.attachments) && memo.attachments.length
      ? memo.attachments
      : memo && Array.isArray(memo.resources) && memo.resources.length
        ? memo.resources
        : (memo && memo.resourceList) || []

  for (const attachment of attachments) {
    const link = attachment && attachment.externalLink ? attachment.externalLink : buildV1ResourceStreamUrl(info, attachment)
    if (!link) continue
    const isImage = String((attachment.type || '')).slice(0, 5) === 'image'
    if (isImage) {
      const image = document.createElement('img')
      image.className = 'random-image'
      if (adapter.needsAuthenticatedImagePreview()) image.dataset.authSrc = link
      else image.src = link
      card.appendChild(image)
    } else {
      const node = document.createElement('a')
      node.href = link
      node.target = '_blank'
      node.rel = 'noopener noreferrer'
      node.textContent = attachment.filename || ''
      card.appendChild(node)
    }
  }

  return card
}

// One place for the "show a list below the editor" animation. The old
// slideDown(500) made the popup look sluggish and jumped the layout.
// `results-open` lets the fullscreen layout move the list beside the editor
// (it would otherwise be pushed below a viewport that does not scroll).
function showRandomList(content) {
  const $list = $('#randomlist').stop(true, true).empty()
  if (typeof content === 'string') $list.html(content)
  else if (content) $list.append(content)
  $list.show()
  document.body.classList.add('results-open')
}

function hideRandomList() {
  $('#randomlist').stop(true, true).html('').hide()
  document.body.classList.remove('results-open')
}

function msg(key) {
  if (typeof window.t === 'function') return window.t(key)
  return chrome.i18n.getMessage(key) || ''
}

// Turn an adapter error ({kind,status,code,message,hint}) into a message that
// tells the user what actually went wrong instead of a generic "failed".
function memoErrorText(err) {
  const info = err || {}
  let key = 'memoFailed'
  if (info.hint === 'publicForbidden') key = 'errPublicForbidden'
  else if (info.status === 410 || info.hint === 'apiRemoved') key = 'errApiRemoved'
  else if (info.kind === 'auth') key = 'errAuth'
  else if (info.kind === 'network') key = 'errNetwork'
  else if (info.kind === 'notfound') key = 'errEndpoint'
  else if (info.kind === 'server') key = 'errServer'
  const head = msg(key) || msg('memoFailed')
  const detail = info.message ? ' · ' + info.message : ''
  return head + detail
}

function applyDayjsLocaleByUiLanguage(uiLang) {
  const lang = String(uiLang || 'auto')
  if (lang === 'de') {
    dayjs.locale('de')
    return
  }

  if (lang === 'fr') {
    dayjs.locale('fr')
    return
  }

  if (lang === 'es') {
    dayjs.locale('es')
    return
  }

  if (lang === 'zh_CN') {
    dayjs.locale('zh-cn')
    return
  }

  if (lang === 'ja') {
    dayjs.locale('ja')
    return
  }

  if (lang === 'ko') {
    dayjs.locale('ko')
    return
  }

  if (lang === 'en') {
    dayjs.locale('en')
    return
  }

  // auto: best-effort infer from browser UI language
  const ui = String(chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : '').toLowerCase()
  if (ui.startsWith('de')) {
    dayjs.locale('de')
    return
  }
  if (ui.startsWith('fr')) {
    dayjs.locale('fr')
    return
  }
  if (ui.startsWith('es')) {
    dayjs.locale('es')
    return
  }
  if (ui.startsWith('zh')) {
    dayjs.locale('zh-cn')
    return
  }
  if (ui.startsWith('ja')) {
    dayjs.locale('ja')
    return
  }
  if (ui.startsWith('ko')) {
    dayjs.locale('ko')
    return
  }
  dayjs.locale('en')
}

// Some servers forbid PUBLIC memos (`disallowPublicVisibility`, 0.15-0.26).
// Reflect that in the selector instead of letting the user hit a 403.
let visibilityPolicy = null

function applyVisibilityPolicy(disallow) {
  visibilityPolicy = typeof disallow === 'boolean' ? disallow : null
  const $public = $('#lockPublic')
  if (!$public.length) return
  if (visibilityPolicy === true) {
    $public.addClass('lock-blocked')
    $public.attr('aria-disabled', 'true')
    $public.attr('title', msg('lockPublicBlocked'))
    if (currentMemoLock === 'PUBLIC') {
      currentMemoLock = 'PRIVATE'
      $('#lock-now').text(msg('lockPrivate'))
      chrome.storage.sync.set({ memo_lock: 'PRIVATE' })
      $.message({ message: msg('lockPublicBlocked') })
    }
  } else {
    $public.removeClass('lock-blocked')
    $public.removeAttr('aria-disabled')
    $public.removeAttr('title')
  }
}

// Refresh silently on popup open: the server setting may have changed since
// the token was saved. Failures keep the last known state.
function refreshVisibilityPolicy(info) {
  if (!info || !info.status) return
  const adapter = getApiAdapter(info)
  if (!adapter || typeof adapter.visibilityPolicy !== 'function') return
  adapter.visibilityPolicy(function (policy) {
    const value = policy && typeof policy.disallowPublic === 'boolean' ? policy.disallowPublic : null
    applyVisibilityPolicy(value)
    chrome.storage.sync.set({
      disallowPublic: value === true ? '1' : value === false ? '0' : ''
    })
  }, function () {})
}

function updateLockNowText(lockType) {
  if (lockType === 'PUBLIC') {
    $('#lock-now').text(msg('lockPublic'))
  } else if (lockType === 'PRIVATE') {
    $('#lock-now').text(msg('lockPrivate'))
  } else if (lockType === 'PROTECTED') {
    $('#lock-now').text(msg('lockProtected'))
  }
}

applyDayjsLocaleByUiLanguage(typeof window.getUiLanguage === 'function' ? window.getUiLanguage() : 'auto')

if (isFullscreenMode()) {
  document.body.classList.add('fullscreen')
}

// The background flags a context-menu click with a badge. Opening the editor is
// the acknowledgement, so clear it here instead of relying on a timer that an
// event page cannot keep alive.
try {
  if (chrome.action && typeof chrome.action.setBadgeText === 'function') {
    chrome.action.setBadgeText({ text: '' })
  }
} catch (_) {
  // best-effort only
}

window.addEventListener('i18n:changed', (ev) => {
  applyDayjsLocaleByUiLanguage(ev && ev.detail ? ev.detail.lang : 'auto')
  updateLockNowText(currentMemoLock)
  renderUploadList(pendingAttachments)
})

let pendingAttachments = []

const DEFAULT_ATTACHMENT_ONLY_TEXT = '#附件 此为默认填充,如需自定义,请在发送附件前填写你的文本内容或者设置项里自定义.'

function getAttachmentOnlyDefaultText(customText) {
  const value = typeof customText === 'string' ? customText.trim() : ''
  return value || DEFAULT_ATTACHMENT_ONLY_TEXT
}

function resolveSendContent(rawContent, resources, customText) {
  const value = typeof rawContent === 'string' ? rawContent : ''
  if (value.trim() !== '') return value
  const items = Array.isArray(resources) ? resources : []
  if (items.length === 0) return ''
  return getAttachmentOnlyDefaultText(customText)
}

function get_info(callback) {
  chrome.storage.sync.get(
    {
      apiUrl: '',
      apiTokens: '',
      apiFlavor: '',
      apiVersion: '',
      apiBase: '',
      userRef: '',
      disallowPublic: '',
      hidetag: '',
      showtag: '',
      memo_lock: '',
      open_action: '',
      open_content: '',
      userid: '',
      memoUiPath: 'memos',
      resourceIdList: [],
      attachmentOnlyDefaultText: ''
    },
    function (items) {
      var flag = false
      var returnObject = {}
      if (items.apiUrl === '' || items.apiTokens === '') {
        flag = false
      } else {
        flag = true
      }
      returnObject.status = flag
      returnObject.apiUrl = items.apiUrl
      returnObject.apiTokens = items.apiTokens
      returnObject.apiFlavor = items.apiFlavor
      returnObject.apiVersion = items.apiVersion
      returnObject.apiBase = items.apiBase
      returnObject.userRef = items.userRef
      returnObject.disallowPublic = items.disallowPublic
      returnObject.hidetag = items.hidetag
      returnObject.showtag = items.showtag
      returnObject.memo_lock = items.memo_lock
      returnObject.open_content = items.open_content
      returnObject.open_action = items.open_action
      returnObject.userid = items.userid
      returnObject.memoUiPath = items.memoUiPath
      returnObject.resourceIdList = items.resourceIdList
      returnObject.attachmentOnlyDefaultText = items.attachmentOnlyDefaultText

      if (callback) callback(returnObject)
    }
  )
}

function getApiAdapter(info) {
  if (window.MemosApiAdapter && typeof window.MemosApiAdapter.resolve === 'function') {
    return window.MemosApiAdapter.resolve(info)
  }
  return null
}

function getMemoUid(memo) {
  if (!memo) return ''
  if (memo.uid != null && memo.uid !== '') return String(memo.uid)
  if (typeof memo.name === 'string' && memo.name) return memo.name.split('/').pop()
  // v0.18.2 only exposes a numeric id.
  if (memo.id != null && memo.id !== '') return String(memo.id)
  return ''
}

get_info(function (info) {
  if (info.status) {
    //已经有绑定信息了，折叠
    $('#blog_info').hide()
  }
  var memoNow = info.memo_lock
  if (memoNow == '') {
    // Never force PUBLIC: private-by-default matches the upstream default and
    // avoids failing on instances that disallow public memos (issue #8).
    chrome.storage.sync.set(
      { memo_lock: 'PRIVATE' }
    )
    memoNow = 'PRIVATE'
  }
  currentMemoLock = memoNow
  updateLockNowText(memoNow)
  applyVisibilityPolicy(
    info.disallowPublic === '1' ? true : info.disallowPublic === '0' ? false : null
  )
  refreshVisibilityPolicy(info)
  $('#apiUrl').val(info.apiUrl)
  $('#apiTokens').val(info.apiTokens)
  $('#hideInput').val(info.hidetag)
  $('#showInput').val(info.showtag)
  $('#attachmentOnlyDefaultText').val(info.attachmentOnlyDefaultText)
  const $textarea = $("textarea[name=text]")
  $textarea.val(info.open_content)
  focusTextareaToEnd($textarea)

  pendingAttachments = Array.isArray(info.resourceIdList) ? info.resourceIdList : []
  renderUploadList(pendingAttachments)
  initEditorResize()
  initFullscreenColumnResize()
})

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'sync') return
  if (!changes.resourceIdList) return
  pendingAttachments = Array.isArray(changes.resourceIdList.newValue)
    ? changes.resourceIdList.newValue
    : []
  renderUploadList(pendingAttachments)
})

// focus is handled after textarea content is set

//监听输入结束，保存未发送内容到本地
$("textarea[name=text]").blur(function () {
  chrome.storage.sync.set(
    { open_action: 'save_text', open_content: $("textarea[name=text]").val() }
  )
})

$("textarea[name=text]").on('keydown', function (ev) {
  if (ev.code === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    $('#content_submit_text').click()
  }
})

$('#fullscreen').on('click', function () {
  if (isFullscreenMode()) return
  openFullscreenTab()
})

//监听拖拽事件，实现拖拽到窗口上传图片
initDrag()

//监听复制粘贴事件，实现粘贴上传图片
document.addEventListener('paste', function (e) {
  let photo = null
  if (e.clipboardData.files[0]) {
    photo = e.clipboardData.files[0]
  } else if (e.clipboardData.items[0] && e.clipboardData.items[0].getAsFile()) {
    photo = e.clipboardData.items[0].getAsFile()
  }

  if (photo != null) {
    uploadImage(photo)
  }
})

// Files can be dropped anywhere on the editor, not only on the textarea. The
// old cue faded the whole page to 30%; highlight the drop zone instead, and
// upload every dropped file (it used to keep only the last one).
function initDrag() {
  const editor = document.querySelector('.memo-editor')
  if (!editor) return

  let depth = 0

  const clearDropState = () => {
    depth = 0
    editor.classList.remove('drop-active')
  }

  const carriesFiles = (ev) => {
    const dt = ev.dataTransfer
    if (!dt) return false
    const types = Array.prototype.slice.call(dt.types || [])
    return types.indexOf('Files') !== -1
  }

  // Dragging a link or a selection is just as valid as dragging an image.
  const carriesText = (ev) => {
    const dt = ev.dataTransfer
    if (!dt) return false
    const types = Array.prototype.slice.call(dt.types || [])
    return types.indexOf('text/uri-list') !== -1 || types.indexOf('text/plain') !== -1
  }

  const isDrop = (ev) => carriesFiles(ev) || carriesText(ev)

  editor.addEventListener('dragenter', (ev) => {
    if (!isDrop(ev)) return
    ev.preventDefault()
    depth++
    editor.classList.add('drop-active')
  })

  editor.addEventListener('dragover', (ev) => {
    if (!isDrop(ev)) return
    ev.preventDefault()
    try {
      ev.dataTransfer.dropEffect = 'copy'
    } catch (_) {}
    editor.classList.add('drop-active')
  })

  editor.addEventListener('dragleave', (ev) => {
    if (!isDrop(ev)) return
    ev.preventDefault()
    // dragleave also fires when crossing child elements; count the nesting so
    // the highlight does not flicker while moving inside the editor.
    depth = Math.max(0, depth - 1)
    if (depth === 0) clearDropState()
  })

  editor.addEventListener('drop', (ev) => {
    if (!isDrop(ev)) return
    ev.preventDefault()
    const dt = ev.dataTransfer
    const files = dt ? dt.files : null
    clearDropState()
    if (files && files.length > 0) {
      uploadFiles(files)
      return
    }
    const uriList = dt ? String(dt.getData('text/uri-list') || '') : ''
    const plain = dt ? String(dt.getData('text/plain') || '') : ''
    // uri-list is comment-prefixed; the first real line is the link.
    const link = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.charAt(0) !== '#')[0]
    appendDroppedText(link || plain)
  })
}

// Dropped text becomes draft content, same normalisation as the context menu.
function appendDroppedText(text) {
  const area = document.querySelector('textarea[name=text]')
  const block = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim()
  if (!area || !block) return
  const current = String(area.value || '').replace(/\s+$/, '')
  area.value = current ? current + '\n\n' + block + '\n' : block + '\n'
  area.dispatchEvent(new Event('input', { bubbles: true }))
  try {
    chrome.storage.sync.set({ open_action: 'save_text', open_content: area.value })
  } catch (_) {
    // best-effort only
  }
  focusTextareaToEnd($(area))
}

// Sequential upload keeps the attachment list in order and avoids racing the
// storage writes that track it.
function uploadFiles(files) {
  const all = Array.prototype.slice.call(files || [])
  const usable = all.filter(function (file) {
    // A dropped folder arrives as a 0-byte entry without a type; uploading it
    // would fail with a confusing server error.
    return file && (file.size > 0 || file.type)
  })
  const skipped = all.length - usable.length

  if (usable.length === 0) {
    $.message({ message: msg('picDropUnsupported') })
    return
  }

  let index = 0
  const next = function () {
    if (index >= usable.length) {
      if (skipped > 0) {
        $.message({ message: msg('picDropSkipped') })
      }
      return
    }
    const file = usable[index++]
    uploadImage(file, next)
  }
  next()
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function focusTextareaToEnd($textarea) {
  try {
    const el = $textarea && $textarea[0]
    if (!el) return
    el.focus()
    const len = typeof el.value === 'string' ? el.value.length : 0
    if (typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(len, len)
    }
  } catch (_) {
    // best-effort only
  }
}

function buildV1ResourceStreamUrl(info, resource) {
  if (!info || !info.apiUrl || !resource) return ''
  // Use the configured apiUrl as the base (may include a reverse-proxy subpath).
  // Do NOT reduce to origin-only, otherwise deployments like https://host/memos/ will break.
  let root = String(info.apiUrl)
  try {
    const u = new URL(root)
    u.hash = ''
    u.search = ''
    root = u.toString()
  } catch (_) {
    // keep as-is
  }
  if (root && !root.endsWith('/')) root += '/'

  if (resource.externalLink) return resource.externalLink

  const isV023 = info.apiFlavor === 'v023'

  const name = typeof resource.name === 'string' ? resource.name.trim() : ''
  const filename = typeof resource.filename === 'string' ? resource.filename : ''

  function isImageResource(r) {
    if (!r) return false
    const t = typeof r.type === 'string' ? r.type.toLowerCase() : ''
    if (t.startsWith('image/')) return true
    const fn = typeof r.filename === 'string' ? r.filename.toLowerCase() : ''
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/.test(fn)
  }

  // v0.23+: resources are served as static files via /file/{name}/{filename}.
  if (isV023) {
    if (resource.externalLink) return resource.externalLink
    const resourceName = name.indexOf('resources/') === 0 ? name : ''
    if (resourceName && filename) {
      const url = root + 'file/' + resourceName + '/' + filename.split('/').map(encodeURIComponent).join('/')
      return isImageResource(resource) ? url + '?thumbnail=true' : url
    }
    return ''
  }

  if (name.indexOf('attachments/') === 0 && filename) {
    const url = root + 'file/' + name.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(filename)
    return isImageResource(resource) ? url + '?thumbnail=true' : url
  }

  function isProbablyUid(s) {
    if (typeof s !== 'string') return false
    const v = s.trim()
    if (!v) return false
    if (v.indexOf('/') !== -1) return false
    if (/^\d+$/.test(v)) return false
    // shortuuid v4 typically uses URL-safe base57-ish; allow a conservative charset.
    return /^[A-Za-z0-9_-]{8,}$/.test(v)
  }

  function buildStreamUrl(uid) {
    const base = root + 'o/r/' + encodeURIComponent(uid)
    return isImageResource(resource) ? base + '?thumbnail=1' : base
  }

  const uidRaw = resource.uid != null ? resource.uid : resource.UID != null ? resource.UID : resource.Uid
  const uid = typeof uidRaw === 'string' ? uidRaw : uidRaw != null ? String(uidRaw) : ''
  if (uid.trim() !== '') return buildStreamUrl(uid.trim())

  // Fallback for older resource shapes.
  // In some memo payloads, the uid may appear as `name` directly.
  // Example: name="ETU6hjuR..." should map to /o/r/:uid, not /file/:name/:filename.
  if (isProbablyUid(name)) return buildStreamUrl(name.trim())

  // Legacy versions (e.g. v0.18) may only expose numeric `id` without `uid/name`.
  const idRaw = resource.id != null ? resource.id : resource.ID != null ? resource.ID : resource.Id
  const id = typeof idRaw === 'number' && Number.isFinite(idRaw)
    ? String(Math.floor(idRaw))
    : typeof idRaw === 'string' && idRaw.trim() !== '' && !Number.isNaN(Number(idRaw))
      ? String(Math.floor(Number(idRaw)))
      : ''
  if (id) return buildStreamUrl(id)

  const fileId = resource.publicId || filename
  if (name && fileId) return root + 'file/' + name + '/' + fileId
  return ''
}

function normalizeUnixTimeToMs(input) {
  if (input == null) return null
  if (typeof input === 'number' && Number.isFinite(input)) {
    // Heuristic: seconds are typically 10 digits; milliseconds are 13 digits.
    if (input > 0 && input < 1e12) return input * 1000
    return input
  }
  if (typeof input === 'string') {
    const s = input.trim()
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      if (!Number.isFinite(n)) return null
      if (n > 0 && n < 1e12) return n * 1000
      return n
    }
    // ISO/RFC3339 etc.
    return s
  }
  return null
}

function memoFromNow(memo) {
  if (!memo) return ''
  const raw = memo.createTime || memo.createdAt || memo.createdTs
  const normalized = normalizeUnixTimeToMs(raw)
  if (!normalized) return ''
  const moment = dayjs(normalized)
  return typeof moment.fromNow === 'function' ? moment.fromNow() : moment.format('YYYY-MM-DD HH:mm')
}

function hydrateV1PreviewImages(info) {
  const adapter = getApiAdapter(info)
  if (!adapter || !adapter.needsAuthenticatedImagePreview()) return
  if (!info || !info.apiUrl) return

  const token = info && info.apiTokens != null ? String(info.apiTokens).trim() : ''
  let root = String(info.apiUrl)
  let apiOrigin = ''
  try {
    const u = new URL(root)
    u.hash = ''
    u.search = ''
    root = u.toString()
    apiOrigin = u.origin
  } catch (_) {
    // keep as-is
  }
  if (root && !root.endsWith('/')) root += '/'
  const nodes = document.querySelectorAll('img.random-image')
  if (!nodes || nodes.length === 0) return

  // Revoke blob URLs on popup unload to avoid leaking memory.
  if (!window.__memosBberObjectUrls) {
    window.__memosBberObjectUrls = []
    window.addEventListener('unload', function () {
      const list = window.__memosBberObjectUrls || []
      for (let i = 0; i < list.length; i++) {
        try { URL.revokeObjectURL(list[i]) } catch (_) {}
      }
      window.__memosBberObjectUrls = []
    })
  }

  const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

  function resolveToAbsoluteUrl(url) {
    const u = String(url || '').trim()
    if (!u) return ''
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('chrome-extension:')) return ''
    if (u.startsWith('#')) return ''
    try {
      return new URL(u, root).toString()
    } catch (_) {
      return ''
    }
  }

  function isSameOrigin(url) {
    if (!apiOrigin) return false
    try {
      return new URL(url).origin === apiOrigin
    } catch (_) {
      return false
    }
  }

  function looksLikeMemosResourceUrl(absUrl) {
    const s = String(absUrl || '')
    return s.indexOf('/o/r/') !== -1 || s.indexOf('/file/') !== -1
  }

  nodes.forEach(function (img) {
    const hasAuthAttr = img.hasAttribute('data-auth-src')
    const url = img.getAttribute('data-auth-src') || img.getAttribute('src')
    if (!url) return
    if (img.getAttribute('data-auth-loaded') === '1') return

    const abs = resolveToAbsoluteUrl(url)
    if (!abs) return
    // Only hydrate same-origin resources that require Authorization.
    if (!isSameOrigin(abs)) return

    // Reduce unnecessary fetches: only hydrate known resource endpoints,
    // or images explicitly marked as auth-required.
    if (!hasAuthAttr && !looksLikeMemosResourceUrl(abs)) return

    img.setAttribute('data-auth-loaded', '1')

    // Prevent a broken-image icon before hydration completes.
    // Only do this for images explicitly marked as auth-required.
    if (hasAuthAttr) {
      const currentSrc = img.getAttribute('src')
      if (!currentSrc || currentSrc === abs) {
        img.setAttribute('src', transparentPixel)
      }
    }

    fetch(abs, {
      method: 'GET',
      credentials: 'include',
      headers: token ? {
        Authorization: 'Bearer ' + token
      } : {}
    })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '0'))
        const ct = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('content-type') || '') : ''
        if (ct && !ct.toLowerCase().startsWith('image/')) throw new Error('Not an image')
        return res.blob()
      })
      .then(function (blob) {
        const objectUrl = URL.createObjectURL(blob)
        window.__memosBberObjectUrls.push(objectUrl)
        img.src = objectUrl
      })
      .catch(function () {
        // Fall back to the original URL so the browser can still try cookie-based auth.
        if (hasAuthAttr) {
          try { img.setAttribute('src', abs) } catch (_) {}
        }
      })
  })
}

function renderUploadList(list) {
  const $wrapper = $('.upload-list-wrapper')
  const $list = $('#uploadlist')
  if ($list.length === 0) return

  const items = Array.isArray(list) ? list : []
  if (items.length === 0) {
    if ($wrapper.length) $wrapper.hide()
    $list.html('')
    return
  }

  if ($wrapper.length) $wrapper.show()

  const tipReorder = escapeHtml(msg('tipReorder'))
  const tipDelete = escapeHtml(msg('tipDeleteAttachment'))

  let html = ''
  for (let i = 0; i < items.length; i++) {
    const att = items[i] || {}
    const name = att.name || ''
    const id = att.id != null ? String(att.id) : ''
    const filename = att.filename || name
    html +=
      '<div class="upload-item" draggable="true" data-index="' +
      i +
      '" data-name="' +
      escapeHtml(name) +
      '" data-id="' +
      escapeHtml(id) +
      '">' +
      '<div class="upload-left">' +
      '<span class="upload-drag" title="' +
      tipReorder +
      '">≡</span>' +
      '<span class="upload-filename">' +
      escapeHtml(filename) +
      '</span>' +
      '</div>' +
      '<button type="button" class="upload-del" data-name="' +
      escapeHtml(name) +
      '" data-id="' +
      escapeHtml(id) +
      '" title="' +
      tipDelete +
      '">×</button>' +
      '</div>'
  }

  $list.html(html)
}

function saveUploadList(nextList, callback) {
  pendingAttachments = Array.isArray(nextList) ? nextList : []
  chrome.storage.sync.set({ resourceIdList: pendingAttachments }, callback)
}

let uploadDragIndex = null

$(document).on('dragstart', '.upload-item', function (e) {
  uploadDragIndex = Number($(this).data('index'))
  const dt = e.originalEvent && e.originalEvent.dataTransfer
  if (dt) {
    dt.effectAllowed = 'move'
    dt.setData('text/plain', String(uploadDragIndex))
  }
})

$(document).on('dragover', '.upload-item', function (e) {
  e.preventDefault()
  $(this).addClass('drag-over')
  const dt = e.originalEvent && e.originalEvent.dataTransfer
  if (dt) dt.dropEffect = 'move'
})

$(document).on('dragleave', '.upload-item', function () {
  $(this).removeClass('drag-over')
})

$(document).on('drop', '.upload-item', function (e) {
  e.preventDefault()
  $('.upload-item.drag-over').removeClass('drag-over')

  const fromIndex =
    uploadDragIndex != null
      ? uploadDragIndex
      : Number(
          (e.originalEvent && e.originalEvent.dataTransfer
            ? e.originalEvent.dataTransfer.getData('text/plain')
            : '') || -1
        )
  const toIndex = Number($(this).data('index'))

  uploadDragIndex = null
  if (!Number.isFinite(fromIndex) || !Number.isFinite(toIndex)) return
  if (fromIndex < 0 || toIndex < 0) return
  if (fromIndex === toIndex) return

  const next = (Array.isArray(pendingAttachments) ? pendingAttachments : []).slice()
  if (fromIndex >= next.length || toIndex >= next.length) return
  const moved = next.splice(fromIndex, 1)[0]
  next.splice(toIndex, 0, moved)

  saveUploadList(next, function () {
    renderUploadList(pendingAttachments)
  })
})

$(document).on('click', '.upload-del', function () {
  const name = $(this).data('name')
  const rid = $(this).data('id')
  if (!name) return

  get_info(function (info) {
    if (!info.status) {
      $.message({ message: msg('placeApiUrl') })
      return
    }

    const adapter = getApiAdapter(info)
    adapter.deleteResource(
      { name: name, id: rid },
      function () {
        const next = (Array.isArray(pendingAttachments) ? pendingAttachments : []).filter(function (x) {
          return x && x.name !== name
        })
        saveUploadList(next, function () {
          $.message({ message: msg('attachmentDeleteSuccess') })
          renderUploadList(pendingAttachments)
        })
      },
      function () {
        $.message({ message: msg('attachmentDeleteFailed') })
      }
    )
  })
})

// Transient, per-browser flag shared with the background: a context-menu click
// must not append text while an upload is rewriting the draft. `session`
// storage is the right area for ephemeral state (it is not synced).
function setUploading(value) {
  try {
    const area = chrome.storage.session || chrome.storage.local
    area.set({ uploading: Boolean(value) })
  } catch (_) {
    // best-effort only
  }
}

function uploadImage(file, done) {
  const finish = function (err) {
    setUploading(false)
    if (typeof done === 'function') done(err)
  }
  setUploading(true)
  $.message({
    message: msg('picUploading'),
    autoClose: false
  });
  get_info(function (info) {
    const adapter = getApiAdapter(info)
    adapter.uploadFile(
      file,
      {
        editorContent: $("textarea[name=text]").val(),
        hideTag: info.hidetag,
        showTag: info.showtag,
        memoLock: info.memo_lock
      },
      function (entity) {
        if (entity) {
          pendingAttachments.push(entity)
          // Keep the draft: clearing it here lost the text if the popup closed
          // right after an upload.
          chrome.storage.sync.set(
            { open_action: '', open_content: $("textarea[name=text]").val(), resourceIdList: pendingAttachments },
            function () {
              $.message({ message: msg('picSuccess') })
              renderUploadList(pendingAttachments)
              finish(null)
            }
          )
          return
        }
        chrome.storage.sync.set(
          { open_action: '', open_content: $("textarea[name=text]").val() },
          function () {
            $.message({ message: msg('picFailed') })
            finish({ kind: 'client', status: 0, message: 'upload failed' })
          }
        )
      },
      function (err) {
        chrome.storage.sync.set(
          { open_action: '', open_content: $("textarea[name=text]").val() },
          function () {
            $.message({ message: memoErrorText(err) })
            finish(err)
          }
        )
      }
    )
  })
};

function buildCustomSettingsPayload() {
  return {
    attachmentOnlyDefaultText: $('#attachmentOnlyDefaultText').val()
  }
}

function saveSettingsPanel() {
  var apiUrl = $('#apiUrl').val()
  if (apiUrl.length > 0 && !apiUrl.endsWith('/')) {
    apiUrl += '/'
  }
  var apiTokens = $('#apiTokens').val()
  var customSettings = buildCustomSettingsPayload()

  if (!apiUrl && !apiTokens) {
    chrome.storage.sync.set(customSettings, function () {
      $.message({ message: msg('saveSuccess') })
      $('#blog_info').slideUp(200)
    })
    return
  }

  const adapter = window.MemosApiAdapter
  if (!adapter || typeof adapter.detect !== 'function') {
    $.message({ message: msg('memoFailed') })
    return
  }

  // One round-trip detects the server version, the working API base
  // (/api/v1 vs /api) and validates the token.
  adapter.detect(apiUrl, apiTokens, function (err, result) {
    if (err || !result) {
      $.message({ message: memoErrorText(err) })
      return
    }

    const known = adapter.KNOWN_ERAS.indexOf(result.era) !== -1
    chrome.storage.sync.set(
      Object.assign({}, customSettings, {
        apiUrl: apiUrl,
        apiTokens: apiTokens,
        userid: result.userId != null ? result.userId : '',
        userRef: result.userRef || '',
        memoUiPath: result.uiPath || 'memos',
        apiFlavor: known ? result.flavor : '',
        apiVersion: result.version || '',
        apiBase: result.base || '',
        disallowPublic: result.disallowPublic === true ? '1' : result.disallowPublic === false ? '0' : ''
      }),
      function () {
        $.message({ message: msg('saveSuccess') })
        $('#blog_info').hide()
        updateServerVersionLabel(result)
        applyVisibilityPolicy(result.disallowPublic)
      }
    )
  })
}

function updateServerVersionLabel(result) {
  const el = document.getElementById('supportedMemosVersion')
  if (!el || !result || !result.version) return
  const era = result.era || ''
  const label = msg('serverVersionLabel')
  const suffix = era === 'v2' ? msg('serverVersionNew') : era === 'unknown' ? msg('serverVersionUnknown') : ''
  el.textContent = label + ' ' + result.version + (suffix ? ' · ' + suffix : '')
}

$('#saveSettings').click(function () {
  saveSettingsPanel()
})

$('#opensite').click(function () {
  get_info(function (info) {
    chrome.tabs.create({url:info.apiUrl})
  })
})

// 0.23.1版本 GET api/v1/{parent}/tags 接口已移除，参考 https://github.com/usememos/memos/issues/4161 
$('#tags').click(function () {
  get_info(function (info) {
    //console.log('[memos-bber] tags click info:', info)
    if (info.apiUrl) {
      var tagDom = "";
      const adapter = getApiAdapter(info)
      if (!adapter) {
        //console.warn('[memos-bber] no adapter for tags')
        return
      }

      const renderTags = function (tags) {
        //console.log('[memos-bber] tags result:', tags)
        const uniTags = [...new Set((Array.isArray(tags) ? tags : []).filter(Boolean))]
        $.each(uniTags, function (_, tag) {
          tagDom += '<span class="item-container">#' + escapeHtml(tag) + '</span>';
        });
        tagDom += '<svg id="hideTag" class="hidetag" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M78.807 362.435c201.539 314.275 666.962 314.188 868.398-.241 16.056-24.99 13.143-54.241-4.04-62.54-17.244-8.377-40.504 3.854-54.077 24.887-174.484 272.338-577.633 272.41-752.19.195-13.573-21.043-36.874-33.213-54.113-24.837-17.177 8.294-20.06 37.545-3.978 62.536z" fill="#fff"/><path d="M894.72 612.67L787.978 494.386l38.554-34.785 106.742 118.251-38.554 34.816zM635.505 727.51l-49.04-147.123 49.255-16.41 49.054 147.098-49.27 16.435zm-236.18-12.001l-49.568-15.488 43.29-138.48 49.557 15.513-43.28 138.455zM154.49 601.006l-38.743-34.565 95.186-106.732 38.763 34.566-95.206 106.731z" fill="#fff"/></svg>'
        $("#taglist").html(tagDom).slideToggle(500)
      }

      adapter.listTags(renderTags, function (err) {
        //console.error('[memos-bber] tags failed:', err)
        $.message({ message: msg('placeApiUrl') })
      })
    } else {
      $.message({
        message: msg('placeApiUrl')
      })
    }
  })
})

$(document).on("click","#hideTag",function () {
  $('#taghide').slideToggle(500)
  $('#hideInput').trigger('focus')
})

$('#saveTag').click(function () {
  chrome.storage.sync.set(
    {
      hidetag: $('#hideInput').val(),
      showtag: $('#showInput').val()
    },
    function () {
      $.message({
        message: msg('saveSuccess')
      })
      $('#taghide').hide()
    }
  )
})

$('#lock').click(function () {
  $("#lock-wrapper").toggleClass( "!hidden", 1000 );
})

$(document).on("click",".item-lock",function () {
  if ($(this).hasClass('lock-blocked')) {
    $("#lock-wrapper").toggleClass( "!hidden", 1000 );
    $.message({ message: msg('lockPublicBlocked') })
    return
  }
  $("#lock-wrapper").toggleClass( "!hidden", 1000 );
  $("#lock-now").text($(this).text())
    const lockType = $(this)[0].dataset.type
    currentMemoLock = lockType
    chrome.storage.sync.set(
      {memo_lock: lockType}
    )
})

$('#search').click(function () {
  get_info(function (info) {
    if (!info.status) {
      $.message({ message: msg('placeApiUrl') })
      return
    }
    hideRandomList()

    const pattern = $("textarea[name=text]").val()
    if (!pattern) {
      $.message({ message: msg('searchNow') })
      return
    }

    const adapter = getApiAdapter(info)
    if (!adapter) return

    adapter.searchMemos(
      pattern,
      function (results) {
        const list = Array.isArray(results) ? results : []
        if (list.length === 0) {
          $.message({ message: msg('searchNone') })
          return
        }
        const fragment = document.createDocumentFragment()
        for (const memo of list) fragment.appendChild(createMemoCard(memo, info, adapter))
        window.ViewImage && ViewImage.init('.random-image')
        showRandomList(fragment)
        hydrateV1PreviewImages(info)
      },
      function () {
        $.message({ message: msg('searchNone') })
      }
    )
  })
})

$('#random').click(function () {
  get_info(function (info) {
    //console.log('[memos-bber] random click info:', info)
    if (info.status) {
      hideRandomList()
      const adapter = getApiAdapter(info)
      if (!adapter) {
        //console.warn('[memos-bber] no adapter for random')
        return
      }

      adapter.listRandomMemos(
        function (memos) {
          if (!memos || memos.length === 0) {
            $.message({ message: msg('randomEmpty') })
            return
          }
          let randomNum = Math.floor(Math.random() * (memos.length));
          var randomData = memos[randomNum]
          renderRandomMemo(randomData)
        },
        function (err) {
          //console.error('[memos-bber] random failed:', err)
          $.message({ message: msg('placeApiUrl') })
        }
      )
    } else {
      $.message({
        message: msg('placeApiUrl')
      })
    }
  })
})

function renderRandomMemo(memo) {
  get_info(function (info) {
    const adapter = getApiAdapter(info)
    if (!adapter) return
    showRandomList(createMemoCard(memo, info, adapter))
    window.ViewImage && ViewImage.init('.random-image')
    hydrateV1PreviewImages(info)
  })
}

$(document).on('click', '.random-link', function () {
  const memoUid = $(this).data('uid')
  if (!memoUid) return
  get_info(function (info) {
    const path = (info.memoUiPath || 'memos').replace(/^\/+|\/+$/g, '')
    chrome.tabs.create({ url: info.apiUrl + path + '/' + memoUid })
  })
})

$(document).on('click', '.random-delete', function () {
  const memoName = $(this).data('name')
  const memoId = $(this).data('id')
  get_info(function (info) {
    const adapter = getApiAdapter(info)
    if (!adapter) return
    adapter.archiveMemo(
      { name: memoName, id: memoId },
      function () {
        hideRandomList()
        $.message({ message: msg('archiveSuccess') })
      },
      function () {
        $.message({ message: msg('archiveFailed') })
      }
    )
  })
})

$(document).on("click",".item-container",function () {
  var tagHtml = $(this).text()+" "
  insertIntoDraft(tagHtml);
})

$('#newtodo').click(function () {
  var tagHtml = "\n- [ ] "
  insertIntoDraft(tagHtml);
})

$('#getlink').click(function () {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    const title = String(tab.title || '').replace(/[[\]]/g, '')
    var linkHtml = " [" + title + "](" + tab.url + ") "
    if(tab.url){
      insertIntoDraft(linkHtml);
    }else{
      $.message({
        message: msg('getTabFailed')
      })
    }
  })
})

$('#upres').click(async function () {
  $('#inFile').click()
})

$('#inFile').on('change', function(data){
  var fileVal = $('#inFile').val();
  var file = null
  if(fileVal == '') {
    return;
  }
  file= this.files[0];
  uploadImage(file)
});

function insertIntoDraft(str) {
  var tc = document.getElementById("content");
  var tclen = tc.value.length;
  tc.focus();
  tc.value =
    tc.value.substr(0, tc.selectionStart) +
    str +
    tc.value.substring(tc.selectionStart, tclen);
}

$('#blog_info_edit').click(function () {
  $('#blog_info').slideToggle()
})

$('#content_submit_text').click(function () {
  var contentVal = $("textarea[name=text]").val()
  var contentToSend = resolveSendContent(
    contentVal,
    pendingAttachments,
    $('#attachmentOnlyDefaultText').val()
  )
  if(contentToSend){
    sendText(contentToSend)
  }else{
    $.message({
      message: msg('placeContent')
    })
  }
})

function sendText(preparedContent) {
  get_info(function (info) {
    if (info.status) {
      $.message({
        message: msg('memoUploading')
      })
      //$("#content_submit_text").attr('disabled','disabled');
      let content = resolveSendContent(
        typeof preparedContent === 'string' ? preparedContent : $("textarea[name=text]").val(),
        info.resourceIdList,
        info.attachmentOnlyDefaultText
      )
      if (!content) {
        $.message({
          message: msg('placeContent')
        })
        return
      }
      var hideTag = info.hidetag
      var showTag = info.showtag
      var nowTag = content.match(/(#[^\s#]+)/)
      var sendvisi = info.memo_lock || ''
      if(nowTag){
        if(nowTag[1] == showTag){
          sendvisi = 'PUBLIC'
        }else if(nowTag[1] == hideTag){
          sendvisi = 'PRIVATE'
        }
      }

      const adapter = getApiAdapter(info)
      adapter.createMemo(
        {
          content: content,
          visibility: sendvisi,
          resourceIdList: info.resourceIdList
        },
        function (data) {
          chrome.storage.sync.set(
            { open_action: '', open_content: '', resourceIdList: [] },
            function () {
              $.message({ message: msg('memoSuccess') })
              $("textarea[name=text]").val('')
              pendingAttachments = []
              renderUploadList(pendingAttachments)
              renderRandomMemo(data)
            }
          )
        },
        function (err) {
          // Keep the draft and the uploaded attachment references so the user
          // can retry after fixing the cause (e.g. visibility not allowed).
          chrome.storage.sync.set(
            { open_action: '', open_content: content },
            function () {
              $.message({ message: memoErrorText(err) })
            }
          )
        }
      )
    } else {
      $.message({
        message: msg('placeApiUrl')
      })
    }
  })
}
