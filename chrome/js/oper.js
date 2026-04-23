dayjs.extend(window.dayjs_plugin_relativeTime)
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

function initProportionalEditorResize() {
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

    // Lock the base size. Scaling will be applied by setting width/height.
    editor.style.width = `${baseW}px`
    editor.style.height = `${baseH}px`
    editor.style.minWidth = `${baseW}px`
    editor.style.minHeight = `${baseH}px`

    const storageKey = 'popupEditorScale'

    const nonEditorHeight = Math.max(0, Math.ceil(document.body.scrollHeight - initialRect.height))
    let maxScale = 1
    let currentScale = 1
    let dragging = false
    let dragStartX = 0
    let dragStartY = 0
    let dragStartScale = 1

    const clampScale = (scale) => {
      if (!Number.isFinite(scale)) return 1
      return Math.min(Math.max(scale, 1), maxScale)
    }

    const applyScale = (scale) => {
      currentScale = clampScale(scale)
      editor.style.width = `${Math.round(baseW * currentScale)}px`
      editor.style.height = `${Math.round(baseH * currentScale)}px`
    }

    const persistScale = () => {
      try {
        if (window.localStorage) window.localStorage.setItem(storageKey, String(currentScale))
      } catch (_) {}

      try {
        if (chrome.storage && chrome.storage.sync) {
          chrome.storage.sync.set({ [storageKey]: currentScale })
        }
      } catch (_) {
        // ignore
      }
    }

    const computeMaxScale = () => {
      // In popup mode, allow scaling up to Chrome's max popup size.
      // Do not clamp by current window.innerWidth/innerHeight, otherwise the popup can't grow to the max.
      const viewportW = 800
      const viewportH = 600
      const toolsRect = tools.getBoundingClientRect()
      const toolsStyle = window.getComputedStyle(tools)
      const toolsMarginTop = parseFloat(toolsStyle.marginTop || '0') || 0
      const extraWidth = safety * 2
      const extraHeight = nonEditorHeight + Math.ceil(toolsRect.height + toolsMarginTop) + safety
      const widthScale = (viewportW - extraWidth) / baseW
      const heightScale = (viewportH - extraHeight) / baseH
      maxScale = Math.max(1, Math.min(widthScale, heightScale))
      applyScale(currentScale)
    }

    const endDrag = () => {
      if (!dragging) return
      dragging = false
      handle.classList.remove('dragging')
      persistScale()
    }

    const onPointerMove = (ev) => {
      if (!dragging) return
      const dx = ev.clientX - dragStartX
      const dy = ev.clientY - dragStartY
      const widthScale = (baseW * dragStartScale + dx) / baseW
      const heightScale = (baseH * dragStartScale + dy) / baseH
      applyScale(Math.max(widthScale, heightScale))
    }

    const startDrag = (ev) => {
      ev.preventDefault()
      dragging = true
      dragStartX = ev.clientX
      dragStartY = ev.clientY
      dragStartScale = currentScale
      handle.classList.add('dragging')
      if (typeof handle.setPointerCapture === 'function') {
        try {
          handle.setPointerCapture(ev.pointerId)
        } catch (_) {
          // Ignore capture failures.
        }
      }
    }

    computeMaxScale()

    try {
      const localValue = window.localStorage ? Number(window.localStorage.getItem(storageKey)) : NaN
      if (Number.isFinite(localValue) && localValue >= 1) {
        applyScale(localValue)
      }
    } catch (_) {
      // ignore
    }

    try {
      chrome.storage.sync.get({ [storageKey]: 1 }, (items) => {
        const savedScale = Number(items && items[storageKey])
        if (Number.isFinite(savedScale) && savedScale >= 1) {
          applyScale(savedScale)
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
    window.addEventListener('resize', computeMaxScale)
  } catch (_) {
    // best-effort only
  }
}

function msg(key) {
  if (typeof window.t === 'function') return window.t(key)
  return chrome.i18n.getMessage(key) || ''
}

function applyDayjsLocaleByUiLanguage(uiLang) {
  const lang = String(uiLang || 'auto')
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

  if (lang === 'de') {
    dayjs.locale('de')
    return
  }

  // auto: best-effort infer from browser UI language
  const ui = String(chrome.i18n.getUILanguage ? chrome.i18n.getUILanguage() : '').toLowerCase()
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
  if (ui.startsWith('de')) {
    dayjs.locale('de')
    return
  }
  dayjs.locale('en')
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

window.addEventListener('i18n:changed', (ev) => {
  applyDayjsLocaleByUiLanguage(ev && ev.detail ? ev.detail.lang : 'auto')
  updateLockNowText(currentMemoLock)
  renderUploadList(relistNow)
})

let relistNow = []

const API_FLAVOR_V020_V021 = 'v020-v021'

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
  return ''
}

get_info(function (info) {
  if (info.status) {
    //已经有绑定信息了，折叠
    $('#blog_info').hide()
  }
  var memoNow = info.memo_lock
  if (memoNow == '') {
    chrome.storage.sync.set(
      { memo_lock: 'PUBLIC' }
    )
    memoNow = 'PUBLIC'
  }
  currentMemoLock = memoNow
  updateLockNowText(memoNow)
  $('#apiUrl').val(info.apiUrl)
  $('#apiTokens').val(info.apiTokens)
  $('#hideInput').val(info.hidetag)
  $('#showInput').val(info.showtag)
  $('#attachmentOnlyDefaultText').val(info.attachmentOnlyDefaultText)
  if (info.open_action === 'upload_image') {
    //打开的时候就是上传图片
    uploadImage(info.open_content)
  } else {
    const $textarea = $("textarea[name=text]")
    $textarea.val(info.open_content)
    focusTextareaToEnd($textarea)
  }

  relistNow = Array.isArray(info.resourceIdList) ? info.resourceIdList : []
  renderUploadList(relistNow)
  initProportionalEditorResize()
  //从localstorage 里面读取数据
  setTimeout(get_info, 1)
})

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName !== 'sync') return
  if (!changes.resourceIdList) return
  relistNow = Array.isArray(changes.resourceIdList.newValue)
    ? changes.resourceIdList.newValue
    : []
  renderUploadList(relistNow)
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

function initDrag() {
  var file = null
  var obj = $("textarea[name=text]")[0]
  obj.ondragenter = function (ev) {
    if (ev.target.className === 'common-editor-inputer') {
      $.message({
        message: msg('picDrag'),
        autoClose: false
      })
      $('body').css('opacity', 0.3)
    }
    ev.dataTransfer.dropEffect = 'copy'
  }
  obj.ondragover = function (ev) {
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'copy'
  }
  obj.ondrop = function (ev) {
    $('body').css('opacity', 1)
    ev.preventDefault()
    var files = ev.dataTransfer.files || ev.target.files
    for (var i = 0; i < files.length; i++) {
      file = files[i]
    }
    uploadImage(file)
  }
  obj.ondragleave = function (ev) {
    ev.preventDefault()
    if (ev.target.className === 'common-editor-inputer') {
      $.message({
        message: msg('picCancelDrag')
      })
      $('body').css('opacity', 1)
    }
  }
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

  function isImageResource(r) {
    if (!r) return false
    const t = typeof r.type === 'string' ? r.type.toLowerCase() : ''
    if (t.startsWith('image/')) return true
    const fn = typeof r.filename === 'string' ? r.filename.toLowerCase() : ''
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/.test(fn)
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

  // Legacy versions (e.g. v0.18) may only expose numeric `id` without `uid/name`.
  const idRaw = resource.id != null ? resource.id : resource.ID != null ? resource.ID : resource.Id
  const id = typeof idRaw === 'number' && Number.isFinite(idRaw)
    ? String(Math.floor(idRaw))
    : typeof idRaw === 'string' && idRaw.trim() !== '' && !Number.isNaN(Number(idRaw))
      ? String(Math.floor(Number(idRaw)))
      : ''
  if (id) return buildStreamUrl(id)

  // Fallback for older resource shapes.
  const name = typeof resource.name === 'string' ? resource.name : ''

  // In some memo payloads, the uid may appear as `name` directly.
  // Example: name="ETU6hjuR..." should map to /o/r/:uid, not /file/:name/:filename.
  if (isProbablyUid(name)) return buildStreamUrl(name.trim())

  const fileId = resource.publicId || resource.filename
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
  return dayjs(normalized).fromNow()
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
  relistNow = Array.isArray(nextList) ? nextList : []
  chrome.storage.sync.set({ resourceIdList: relistNow }, callback)
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

  const next = (Array.isArray(relistNow) ? relistNow : []).slice()
  if (fromIndex >= next.length || toIndex >= next.length) return
  const moved = next.splice(fromIndex, 1)[0]
  next.splice(toIndex, 0, moved)

  saveUploadList(next, function () {
    renderUploadList(relistNow)
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
        const next = (Array.isArray(relistNow) ? relistNow : []).filter(function (x) {
          return x && x.name !== name
        })
        saveUploadList(next, function () {
          $.message({ message: msg('attachmentDeleteSuccess') })
          renderUploadList(relistNow)
        })
      },
      function () {
        $.message({ message: msg('attachmentDeleteFailed') })
      }
    )
  })
})

function uploadImage(file) {
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
          relistNow.push(entity)
          chrome.storage.sync.set({ open_action: '', open_content: '', resourceIdList: relistNow }, function () {
            $.message({ message: msg('picSuccess') })
            renderUploadList(relistNow)
          })
          return
        }
        chrome.storage.sync.set({ open_action: '', open_content: '' }, function () {
          $.message({ message: msg('picFailed') })
        })
      },
      function () {
        chrome.storage.sync.set({ open_action: '', open_content: '' }, function () {
          $.message({ message: msg('picFailed') })
        })
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

  window.MemosApiModern.authWithFallback(apiUrl, apiTokens, function (auth) {
    if (!auth || auth.userId == null) {
      $.message({ message: msg('invalidToken') })
      return
    }

    chrome.storage.sync.set(
      Object.assign({}, customSettings, {
        apiUrl: apiUrl,
        apiTokens: apiTokens,
        userid: auth.userId,
        memoUiPath: auth.uiPath || 'memos',
        apiFlavor: ''
      }),
      function () {
        $.message({ message: msg('saveSuccess') })
        $('#blog_info').hide()

        // Auto-detect API flavor once; keep default behavior when unknown.
        if (window.MemosApiAdapter && typeof window.MemosApiAdapter.probeFlavor === 'function') {
          window.MemosApiAdapter.probeFlavor(apiUrl, apiTokens, function (res) {
            const flavor = res && res.flavor ? res.flavor : ''
            if (window.MemosApiAdapter.KNOWN_FLAVORS.indexOf(flavor) !== -1) {
              chrome.storage.sync.set({ apiFlavor: flavor })
            }
          })
        }
      }
    )
  })
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
    if (info.apiUrl) {
      var tagDom = "";
      const adapter = getApiAdapter(info)

      const renderTags = function (tags) {
        const uniTags = [...new Set((Array.isArray(tags) ? tags : []).filter(Boolean))]
        $.each(uniTags, function (_, tag) {
          tagDom += '<span class="item-container">#' + tag + '</span>';
        });
        tagDom += '<svg id="hideTag" class="hidetag" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M78.807 362.435c201.539 314.275 666.962 314.188 868.398-.241 16.056-24.99 13.143-54.241-4.04-62.54-17.244-8.377-40.504 3.854-54.077 24.887-174.484 272.338-577.633 272.41-752.19.195-13.573-21.043-36.874-33.213-54.113-24.837-17.177 8.294-20.06 37.545-3.978 62.536z" fill="#fff"/><path d="M894.72 612.67L787.978 494.386l38.554-34.785 106.742 118.251-38.554 34.816zM635.505 727.51l-49.04-147.123 49.255-16.41 49.054 147.098-49.27 16.435zm-236.18-12.001l-49.568-15.488 43.29-138.48 49.557 15.513-43.28 138.455zM154.49 601.006l-38.743-34.565 95.186-106.732 38.763 34.566-95.206 106.731z" fill="#fff"/></svg>'
        $("#taglist").html(tagDom).slideToggle(500)
      }

      adapter.listTags(renderTags, function () {
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
  $("#lock-wrapper").toggleClass( "!hidden", 1000 );
  $("#lock-now").text($(this).text())
    _this = $(this)[0].dataset.type;
    currentMemoLock = _this
    chrome.storage.sync.set(
      {memo_lock: _this}
    )
})

$('#search').click(function () {
  get_info(function (info) {
  const pattern = $("textarea[name=text]").val()
  if (info.status) {
    $("#randomlist").html('').hide()
    var searchDom = ""
    if(pattern){
      const adapter = getApiAdapter(info)

      adapter.searchMemos(
        pattern,
        function (searchData) {
          if(searchData.length == 0){
            $.message({
              message: msg('searchNone')
            })
          }else{
            for(var i=0;i < searchData.length;i++){
              var memosID = getMemoUid(searchData[i])
              var timeText = memoFromNow(searchData[i])
              searchDom += '<div class="random-item"><div class="random-time"><span id="random-link" data-uid="'+memosID+'"><svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M864 640a32 32 0 0 1 64 0v224.096A63.936 63.936 0 0 1 864.096 928H159.904A63.936 63.936 0 0 1 96 864.096V159.904C96 124.608 124.64 96 159.904 96H384a32 32 0 0 1 0 64H192.064A31.904 31.904 0 0 0 160 192.064v639.872A31.904 31.904 0 0 0 192.064 864h639.872A31.904 31.904 0 0 0 864 831.936V640zm-485.184 52.48a31.84 31.84 0 0 1-45.12-.128 31.808 31.808 0 0 1-.128-45.12L815.04 166.048l-176.128.736a31.392 31.392 0 0 1-31.584-31.744 32.32 32.32 0 0 1 31.84-32l255.232-1.056a31.36 31.36 0 0 1 31.584 31.584L924.928 388.8a32.32 32.32 0 0 1-32 31.84 31.392 31.392 0 0 1-31.712-31.584l.736-179.392L378.816 692.48z" fill="#666" data-spm-anchor-id="a313x.7781069.0.i12" class="selected"/></svg></span><span id="random-delete" data-name="'+searchData[i].name+'" data-id="'+(searchData[i].id != null ? searchData[i].id : '')+'" data-uid="'+memosID+'"><svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M224 322.6h576c16.6 0 30-13.4 30-30s-13.4-30-30-30H224c-16.6 0-30 13.4-30 30 0 16.5 13.5 30 30 30zm66.1-144.2h443.8c16.6 0 30-13.4 30-30s-13.4-30-30-30H290.1c-16.6 0-30 13.4-30 30s13.4 30 30 30zm339.5 435.5H394.4c-16.6 0-30 13.4-30 30s13.4 30 30 30h235.2c16.6 0 30-13.4 30-30s-13.4-30-30-30z" fill="#666"/><path d="M850.3 403.9H173.7c-33 0-60 27-60 60v360c0 33 27 60 60 60h676.6c33 0 60-27 60-60v-360c0-33-27-60-60-60zm-.1 419.8l-.1.1H173.9l-.1-.1V464l.1-.1h676.2l.1.1v359.7z" fill="#666"/></svg></span>'+timeText+'</div><div class="random-content">'+(searchData[i].content || '').replace(/!\[.*?\]\((.*?)\)/g,' <img class="random-image" src="$1"/> ').replace(/\[(.*?)\]\((.*?)\)/g,' <a href="$2" target="_blank">$1</a> ')+'</div>'
              var resources = (searchData[i].attachments && searchData[i].attachments.length > 0) ? searchData[i].attachments : ((searchData[i].resources && searchData[i].resources.length > 0) ? searchData[i].resources : (searchData[i].resourceList || []));
              if(resources && resources.length > 0){
                for(var j=0;j < resources.length;j++){
                  var restype = (resources[j].type || '').slice(0,5);
                  var resexlink = resources[j].externalLink
                  var resLink = '',fileId=''
                  if(resexlink){
                    resLink = resexlink
                  }else{
                    resLink = buildV1ResourceStreamUrl(info, resources[j])
                }
                  if (!resLink) {
                    continue
                  }
                  if(restype == 'image'){
                    if (adapter.needsAuthenticatedImagePreview()) {
                      searchDom += '<img class="random-image" data-auth-src="'+resLink+'"/>'
                    } else {
                      searchDom += '<img class="random-image" src="'+resLink+'"/>'
                    }
                  }
                  if(restype !== 'image'){
                    searchDom += '<a target="_blank" rel="noreferrer" href="'+resLink+'">'+resources[j].filename+'</a>'
                  }
                }
              }
              searchDom += '</div>'
            }
            window.ViewImage && ViewImage.init('.random-image')
            $("#randomlist").html(searchDom).slideDown(500);
            hydrateV1PreviewImages(info)
          }
        },
        function (xhr) {
          $.message({ message: msg('searchNone') })
        }
      )
    }else{
      $.message({
        message: msg('searchNow')
      })
    }
  } else {
    $.message({
      message: msg('placeApiUrl')
    })
  }
})
})

$('#random').click(function () {
  get_info(function (info) {
    if (info.status) {
      $("#randomlist").html('').hide()
      const adapter = getApiAdapter(info)

      adapter.listRandomMemos(
        function (memos) {
          let randomNum = Math.floor(Math.random() * (memos.length));
          var randomData = memos[randomNum]
          randDom(randomData)
        },
        function () {
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

function randDom(randomData){
  get_info(function (info) {
    const adapter = getApiAdapter(info)
  var memosID = getMemoUid(randomData)
  var timeText = memoFromNow(randomData)
  var randomDom = '<div class="random-item"><div class="random-time"><span id="random-link" data-uid="'+memosID+'"><svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M864 640a32 32 0 0 1 64 0v224.096A63.936 63.936 0 0 1 864.096 928H159.904A63.936 63.936 0 0 1 96 864.096V159.904C96 124.608 124.64 96 159.904 96H384a32 32 0 0 1 0 64H192.064A31.904 31.904 0 0 0 160 192.064v639.872A31.904 31.904 0 0 0 192.064 864h639.872A31.904 31.904 0 0 0 864 831.936V640zm-485.184 52.48a31.84 31.84 0 0 1-45.12-.128 31.808 31.808 0 0 1-.128-45.12L815.04 166.048l-176.128.736a31.392 31.392 0 0 1-31.584-31.744 32.32 32.32 0 0 1 31.84-32l255.232-1.056a31.36 31.36 0 0 1 31.584 31.584L924.928 388.8a32.32 32.32 0 0 1-32 31.84 31.392 31.392 0 0 1-31.712-31.584l.736-179.392L378.816 692.48z" fill="#666" data-spm-anchor-id="a313x.7781069.0.i12" class="selected"/></svg></span><span id="random-delete" data-uid="'+memosID+'" data-name="'+randomData.name+'" data-id="'+(randomData && randomData.id != null ? randomData.id : '')+'"><svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M224 322.6h576c16.6 0 30-13.4 30-30s-13.4-30-30-30H224c-16.6 0-30 13.4-30 30 0 16.5 13.5 30 30 30zm66.1-144.2h443.8c16.6 0 30-13.4 30-30s-13.4-30-30-30H290.1c-16.6 0-30 13.4-30 30s13.4 30 30 30zm339.5 435.5H394.4c-16.6 0-30 13.4-30 30s13.4 30 30 30h235.2c16.6 0 30-13.4 30-30s-13.4-30-30-30z" fill="#666"/><path d="M850.3 403.9H173.7c-33 0-60 27-60 60v360c0 33 27 60 60 60h676.6c33 0 60-27 60-60v-360c0-33-27-60-60-60zm-.1 419.8l-.1.1H173.9l-.1-.1V464l.1-.1h676.2l.1.1v359.7z" fill="#666"/></svg></span>'+timeText+'</div><div class="random-content">'+(randomData && randomData.content ? randomData.content : '').replace(/!\[.*?\]\((.*?)\)/g,' <img class="random-image" src="$1"/> ').replace(/\[(.*?)\]\((.*?)\)/g,' <a href="$2" target="_blank">$1</a> ')+'</div>'
  var resources = (randomData.attachments && randomData.attachments.length > 0) ? randomData.attachments : ((randomData.resources && randomData.resources.length > 0) ? randomData.resources : (randomData.resourceList || []));
  if(resources && resources.length > 0){
    for(var j=0;j < resources.length;j++){
      var restype = (resources[j].type || '').slice(0,5);
      var resexlink = resources[j].externalLink
      var resLink = '',fileId=''
      if(resexlink){
        resLink = resexlink
      }else{
        resLink = buildV1ResourceStreamUrl(info, resources[j])
      }
      if (!resLink) {
        continue
      }
      if(restype == 'image'){
        if (adapter.needsAuthenticatedImagePreview()) {
          randomDom += '<img class="random-image" data-auth-src="'+resLink+'"/>'
        } else {
          randomDom += '<img class="random-image" src="'+resLink+'"/>'
        }
      }
      if(restype !== 'image'){
        randomDom += '<a target="_blank" rel="noreferrer" href="'+resLink+'">'+resources[j].filename+'</a>'
      }
    }
  }
  randomDom += '</div>'
  window.ViewImage && ViewImage.init('.random-image')
  $("#randomlist").html(randomDom).slideDown(500);
  hydrateV1PreviewImages(info)
  })
}

$(document).on("click","#random-link",function () {
  var memoUid = $("#random-link").data('uid');
  get_info(function (info) {
    const path = (info.memoUiPath || 'memos').replace(/^\/+|\/+$/g, '')
    chrome.tabs.create({url:info.apiUrl + path + "/" + memoUid})
  })
})

$(document).on("click","#random-delete",function () {
get_info(function (info) {
  var memosName = $("#random-delete").data('name');
  var memoId = $("#random-delete").data('id');

  const adapter = getApiAdapter(info)
  adapter.archiveMemo(
    { name: memosName, id: memoId },
    function () {
      $("#randomlist").html('').hide()
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
  add(tagHtml);
})

$('#newtodo').click(function () {
  var tagHtml = "\n- [ ] "
  add(tagHtml);
})

$('#getlink').click(function () {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    var linkHtml = " ["+tab.title+"]("+tab.url+") "
    if(tab.url){
      add(linkHtml);
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

function add(str) {
  var tc = document.getElementById("content");
  var tclen = tc.value.length;
  tc.focus();
  if(typeof document.selection != "undefined"){
    document.selection.createRange().text = str;
  }else{
    tc.value = 
      tc.value.substr(0, tc.selectionStart) +
      str +
      tc.value.substring(tc.selectionStart, tclen);
  }
}

$('#blog_info_edit').click(function () {
  $('#blog_info').slideToggle()
})

$('#content_submit_text').click(function () {
  var contentVal = $("textarea[name=text]").val()
  var contentToSend = resolveSendContent(
    contentVal,
    relistNow,
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

function getOne(memosId){
  get_info(function (info) {
  if (info.apiUrl) {
    $("#randomlist").html('').hide()
        const adapter = getApiAdapter(info)
        adapter.getMemo(memosId, function (memoEntity) {
          randDom(memoEntity)
        })
  } else {
    $.message({
      message: msg('placeApiUrl')
    })
  }
  })
}

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
              relistNow = []
              renderUploadList(relistNow)
              randDom(data)
            }
          )
        },
        function () {
          chrome.storage.sync.set(
            { open_action: '', open_content: '', resourceIdList: [] },
            function () {
              $.message({ message: msg('memoFailed') })
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