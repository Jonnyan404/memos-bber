(function (global) {
  'use strict'

  function isNotFoundLikeXhr(jqXhr) {
    const status = jqXhr && jqXhr.status
    return status === 404 || status === 405
  }

  function extractMemoListFromResponse(data) {
    if (!data) return []
    if (Array.isArray(data)) return data
    if (Array.isArray(data.memos)) return data.memos
    if (data.data && Array.isArray(data.data.memos)) return data.data.memos
    if (Array.isArray(data.list)) return data.list
    return []
  }

  function extractMemoEntityFromResponse(data) {
    if (!data) return data
    if (data.memo) return data.memo
    if (data.data && data.data.memo) return data.data.memo
    if (data.data && (data.data.id != null || data.data.name || data.data.content)) return data.data
    return data
  }

  function extractResourceEntityFromResponse(data) {
    if (!data) return data
    if (data.resource) return data.resource
    if (data.data && data.data.resource) return data.data.resource
    if (data.data && (data.data.id != null || data.data.name || data.data.filename)) return data.data
    return data
  }

  function requestGet(url, headers, success, fail) {
    global.$
      .ajax({
        url: url,
        type: 'GET',
        contentType: 'application/json',
        dataType: 'json',
        headers: headers
      })
      .done(function (data) {
        if (success) success(data)
      })
      .fail(function (xhr) {
        if (fail) fail(xhr)
      })
  }

  function requestPostJson(url, headers, body, success, fail) {
    global.$
      .ajax({
        url: url,
        type: 'POST',
        contentType: 'application/json',
        dataType: 'json',
        data: body != null ? JSON.stringify(body) : null,
        headers: headers
      })
      .done(function (data) {
        if (success) success(data)
      })
      .fail(function (xhr) {
        if (fail) fail(xhr)
      })
  }

  function requestPatchJson(url, headers, body, success, fail) {
    global.$
      .ajax({
        url: url,
        type: 'PATCH',
        contentType: 'application/json',
        dataType: 'json',
        data: body != null ? JSON.stringify(body) : null,
        headers: headers
      })
      .done(function (data) {
        if (success) success(data)
      })
      .fail(function (xhr) {
        if (fail) fail(xhr)
      })
  }

  // v1 memo list: GET /api/v1/memo
  // Query params (v0.20/v0.21): limit/offset/rowStatus/content/tag (best-effort)
  function listMemos(info, options, success, fail) {
    const opt = options || {}
    const headers = { Authorization: 'Bearer ' + info.apiTokens }

    const limit = opt.limit && Number.isFinite(opt.limit) ? Math.max(1, Math.floor(opt.limit)) : 1000
    const offset = opt.offset && Number.isFinite(opt.offset) ? Math.max(0, Math.floor(opt.offset)) : null
    const rowStatus = typeof opt.rowStatus === 'string' && opt.rowStatus ? opt.rowStatus : 'NORMAL'

    const content = typeof opt.contentSearch === 'string' ? opt.contentSearch : ''
    const tag = typeof opt.tagSearch === 'string' ? opt.tagSearch : ''

    let qs = '?limit=' + encodeURIComponent(String(limit))
    if (offset != null) qs += '&offset=' + encodeURIComponent(String(offset))
    if (rowStatus) qs += '&rowStatus=' + encodeURIComponent(String(rowStatus))
    if (content) qs += '&content=' + encodeURIComponent(String(content))
    if (tag) qs += '&tag=' + encodeURIComponent(String(tag).replace(/^#/, ''))

    requestGet(
      info.apiUrl + 'api/v1/memo' + qs,
      headers,
      function (data) {
        if (success) success({ memos: extractMemoListFromResponse(data) })
      },
      function (xhr) {
        // Some builds might expose plural `/api/v1/memos`; try as a last resort (still v1).
        if (isNotFoundLikeXhr(xhr)) {
          requestGet(
            info.apiUrl + 'api/v1/memos' + qs,
            headers,
            function (data2) {
              if (success) success({ memos: extractMemoListFromResponse(data2) })
            },
            fail
          )
          return
        }
        if (fail) fail(xhr)
      }
    )
  }

  function createMemo(info, body, success, fail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }
    requestPostJson(
      info.apiUrl + 'api/v1/memo',
      headers,
      body,
      function (data) {
        if (success) success(extractMemoEntityFromResponse(data))
      },
      function (xhr) {
        // Last resort: plural route.
        if (isNotFoundLikeXhr(xhr)) {
          requestPostJson(
            info.apiUrl + 'api/v1/memos',
            headers,
            body,
            function (data2) {
              if (success) success(extractMemoEntityFromResponse(data2))
            },
            fail
          )
          return
        }
        if (fail) fail(xhr)
      }
    )
  }

  function patchMemo(info, memoId, patch, success, fail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }
    const id = memoId != null ? String(memoId) : ''
    if (!id) {
      if (fail) fail({ status: 400 })
      return
    }

    requestPatchJson(
      info.apiUrl + 'api/v1/memo/' + encodeURIComponent(id),
      headers,
      patch,
      function (data) {
        if (success) success(extractMemoEntityFromResponse(data))
      },
      fail
    )
  }

  function getTagList(info, success, fail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }
    requestGet(
      info.apiUrl + 'api/v1/tag',
      headers,
      function (data) {
        const list = Array.isArray(data) ? data : Array.isArray(data.tags) ? data.tags : []
        const out = list
          .map(function (t) {
            if (!t) return ''
            if (typeof t === 'string') return t
            if (typeof t.name === 'string') return t.name
            if (typeof t.tag === 'string') return t.tag
            return ''
          })
          .map(function (s) {
            return String(s).replace(/^#/, '').trim()
          })
          .filter(Boolean)
        if (success) success(out)
      },
      fail
    )
  }

  function getTagSuggestion(info, success, fail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }

    function normalizeTagList(data) {
      const list = Array.isArray(data) ? data : Array.isArray(data.tags) ? data.tags : []
      return list
        .map(function (t) {
          if (!t) return ''
          if (typeof t === 'string') return t
          if (typeof t.name === 'string') return t.name
          if (typeof t.tag === 'string') return t.tag
          return ''
        })
        .map(function (s) {
          return String(s).replace(/^#/, '').trim()
        })
        .filter(Boolean)
    }

    function normalizeSuggestionList(data) {
      const list = Array.isArray(data) ? data : []
      return list
        .map(function (s) {
          return String(s).replace(/^#/, '').trim()
        })
        .filter(Boolean)
    }

    function mergeUnique(a, b) {
      return [...new Set((a || []).concat(b || []))]
    }

    let suggestionList = []
    let listList = []
    let pending = 2

    function finish() {
      if (--pending !== 0) return
      if (success) success(mergeUnique(suggestionList, listList))
    }

    requestGet(
      info.apiUrl + 'api/v1/tag/suggestion',
      headers,
      function (data) {
        suggestionList = normalizeSuggestionList(data)
        finish()
      },
      function (xhr) {
        // Ignore failures from the suggestion endpoint; the list endpoint may still work.
        if (xhr && xhr.status !== 404 && xhr.status !== 405 && fail) fail(xhr)
        else finish()
      }
    )

    requestGet(
      info.apiUrl + 'api/v1/tag',
      headers,
      function (data) {
        listList = normalizeTagList(data)
        finish()
      },
      function (xhr) {
        if (isNotFoundLikeXhr(xhr)) {
          finish()
          return
        }
        if (fail) fail(xhr)
      }
    )
  }

  function uploadResourceBlob(info, file, meta, success, fail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }
    const url = info.apiUrl + 'api/v1/resource/blob'

    const m = meta || {}
    const filename = String(m.filename || (file && file.name) || 'upload')

    const form = new FormData()
    if (file) form.append('file', file, filename)

    global.$
      .ajax({
        url: url,
        type: 'POST',
        data: form,
        processData: false,
        contentType: false,
        dataType: 'json',
        headers: headers
      })
      .done(function (data) {
        if (success) success(extractResourceEntityFromResponse(data))
      })
      .fail(function (xhr) {
        if (fail) fail(xhr)
      })
  }

  function deleteResource(info, resourceId, success, fail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }
    const id = resourceId != null ? String(resourceId) : ''
    if (!id) {
      if (fail) fail({ status: 400 })
      return
    }

    global.$
      .ajax({
        url: info.apiUrl + 'api/v1/resource/' + encodeURIComponent(id),
        type: 'DELETE',
        headers: headers
      })
      .done(function (data) {
        if (success) success(data)
      })
      .fail(function (xhr) {
        if (fail) fail(xhr)
      })
  }

  global.MemosApiV020V021 = {
    listMemos: listMemos,
    createMemo: createMemo,
    patchMemo: patchMemo,
    getTagList: getTagList,
    getTagSuggestion: getTagSuggestion,
    uploadResourceBlob: uploadResourceBlob,
    deleteResource: deleteResource
  }
})(window)
