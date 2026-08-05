(function (global) {
  'use strict'

  const FLAVOR_V020_V021 = 'v020-v021'
  const KNOWN_FLAVORS = [FLAVOR_V020_V021, 'v023', 'modern']

  function requestJson(options, success, fail) {
    global.$
      .ajax(options)
      .done(function (data) {
        if (success) success(data)
      })
      .fail(function (xhr) {
        if (fail) fail(xhr)
      })
  }

  function extractMemos(data) {
    if (global.MemosApiModern && typeof global.MemosApiModern.extractMemosListFromResponse === 'function') {
      return global.MemosApiModern.extractMemosListFromResponse(data)
    }
    return []
  }

  function getFlavor(info) {
    if (!info) return 'legacy'
    if (info.apiFlavor === 'modern' && global.MemosApiV023) return 'modern'
    if (info.apiFlavor === 'v023' && global.MemosApiV023) return 'v023'
    if ((info.apiFlavor === FLAVOR_V020_V021 || info.apiFlavor === 'v1') && global.MemosApiV020V021) {
      return FLAVOR_V020_V021
    }
    return 'legacy'
  }

  function normalizeDetectedFlavor(flavor) {
    const value = typeof flavor === 'string' ? flavor : ''
    if (value === 'v020' || value === 'v021' || value === 'v1') return FLAVOR_V020_V021
    return value
  }

  function looksLikeMemosListPayload(data) {
    if (!data) return false
    if (Array.isArray(data)) return true
    if (Array.isArray(data.memos)) return true
    if (data.data && Array.isArray(data.data.memos)) return true
    if (Array.isArray(data.list)) return true
    if (typeof data.error === 'string' || typeof data.message === 'string') return false
    return false
  }

  function isNotFoundLikeProbeXhr(xhr) {
    const status = xhr && xhr.status
    return status === 404 || status === 405
  }

  function probeFlavor(apiUrl, apiTokens, callback) {
    const headers = { Authorization: 'Bearer ' + apiTokens }
    const modernQ =
      'api/v1/memos?pageSize=1&filter=' +
      encodeURIComponent('visibility in ["PUBLIC","PROTECTED"]')
    const v023Q =
      'api/v1/memos?pageSize=1&filter=' +
      encodeURIComponent('visibilities == ["PUBLIC","PROTECTED"]')
    const v020V021Q = 'api/v1/memo?limit=1&rowStatus=NORMAL'

    function finish(flavor) {
      const normalized = normalizeDetectedFlavor(flavor)
      if (KNOWN_FLAVORS.indexOf(normalized) !== -1) {
        if (callback) callback({ flavor: normalized })
        return
      }
      if (callback) callback({ flavor: 'unknown' })
    }

    function probeV023() {
      global.$
        .ajax({
          url: apiUrl + v023Q,
          method: 'GET',
          headers: headers,
          dataType: 'json'
        })
        .done(function (data) {
          if (looksLikeMemosListPayload(data)) finish('v023')
          else finish('unknown')
        })
        .fail(function () {
          finish('unknown')
        })
    }

    global.$
      .ajax({
        url: apiUrl + modernQ,
        method: 'GET',
        headers: headers,
        dataType: 'json'
      })
      .done(function (data) {
        if (looksLikeMemosListPayload(data)) {
          finish('modern')
          return
        }
        probeV023()
      })
      .fail(function (xhr) {
        if (xhr && xhr.status === 400) {
          probeV023()
          return
        }

        if (isNotFoundLikeProbeXhr(xhr)) {
          global.$
            .ajax({
              url: apiUrl + v020V021Q,
              method: 'GET',
              headers: headers,
              dataType: 'json'
            })
            .done(function (data) {
              if (looksLikeMemosListPayload(data)) finish(FLAVOR_V020_V021)
              else finish('unknown')
            })
            .fail(function () {
              finish('unknown')
            })
          return
        }

        finish('unknown')
      })
  }

  function keepLegacyVisibleMemos(list) {
    const items = Array.isArray(list) ? list : []
    return items.filter(function (memo) {
      if (!memo) return false
      const visibility = typeof memo.visibility === 'string' ? memo.visibility.toUpperCase() : ''
      if (!visibility) return true
      return visibility === 'PUBLIC' || visibility === 'PROTECTED'
    })
  }

  function extractTagsFromGenericMemo(memo) {
    if (!memo) return []
    if (Array.isArray(memo.tags) && memo.tags.length > 0) return memo.tags
    if (Array.isArray(memo.tagList) && memo.tagList.length > 0) return memo.tagList
    if (memo.property && Array.isArray(memo.property.tags) && memo.property.tags.length > 0) {
      return memo.property.tags
    }
    return []
  }

  function collectTags(info, memos) {
    const items = Array.isArray(memos) ? memos : []
    const out = items.flatMap(function (memo) {
      if (!memo) return []
      if (getFlavor(info) === 'v023' && global.MemosApiV023 && typeof global.MemosApiV023.extractTagsFromMemo === 'function') {
        return global.MemosApiV023.extractTagsFromMemo(memo)
      }
      return extractTagsFromGenericMemo(memo)
    })
    return [...new Set(out.filter(Boolean))]
  }

  function buildUploadVisibility(editorContent, hideTag, showTag, memoLock) {
    const content = typeof editorContent === 'string' ? editorContent : ''
    const nowTag = content.match(/(#[^\s#]+)/)
    let visibility = memoLock || ''
    if (nowTag) {
      if (nowTag[1] === showTag) visibility = 'PUBLIC'
      else if (nowTag[1] === hideTag) visibility = 'PRIVATE'
    }
    return visibility
  }

  function buildModernFilter(parts) {
    const p = parts || {}
    const exprs = []

    if (typeof p.contentSearch === 'string' && p.contentSearch.length > 0) {
      exprs.push('content.contains(' + JSON.stringify(String(p.contentSearch)) + ')')
    }

    return exprs.join(' && ')
  }

  function normalizeUploadedItem(entity, fallbackFilename) {
    if (!entity) return null
    entity = entity.attachment || entity.resource || entity
    const inferredId = (function () {
      const value = entity.id != null ? entity.id : entity.ID != null ? entity.ID : entity.Id
      if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Math.floor(Number(value))
      }
      return null
    })()

    const name = entity.name || (inferredId != null ? 'resources/' + String(inferredId) : '')
    if (!name && inferredId == null) return null

    return {
      id: inferredId != null ? inferredId : entity.id,
      name: name,
      filename: entity.filename || fallbackFilename || name,
      createTime: entity.createTime || entity.createdTs || entity.createdAt,
      type: entity.type,
      uid: entity.uid,
      size: entity.size,
      memo: entity.memo,
      externalLink: entity.externalLink
    }
  }

  function unwrapLegacyMemoEntity(data) {
    if (!data) return data
    if (data.memo) return data.memo
    if (data.data && data.data.memo) return data.data.memo
    return data
  }

  function normalizeLegacyResourceIdList(list) {
    const items = Array.isArray(list) ? list : []
    return items
      .map(function (item) {
        if (!item) return null
        if (typeof item.id === 'number' && Number.isFinite(item.id)) return Math.floor(item.id)
        if (typeof item.id === 'string' && item.id.trim() !== '' && !Number.isNaN(Number(item.id))) {
          return Math.floor(Number(item.id))
        }
        const name = typeof item.name === 'string' ? item.name : ''
        const tail = name ? name.split('/').pop() : ''
        if (tail && !Number.isNaN(Number(tail))) return Math.floor(Number(tail))
        return null
      })
      .filter(function (value) {
        return value != null && Number.isFinite(value)
      })
  }

  function resolve(info) {
    const flavor = getFlavor(info)

    function listTags(success, fail) {
      if (flavor === FLAVOR_V020_V021 && global.MemosApiV020V021) {
        global.MemosApiV020V021.getTagSuggestion(info, success, fail)
        return
      }

      if (flavor === 'v023' && global.MemosApiV023) {
        const filterExpr = global.MemosApiV023.buildFilter({
          rowStatus: 'NORMAL',
          creator: 'users/' + info.userid
        })
        global.MemosApiV023.listMemos(
          info,
          { pageSize: 1000, filterExpr: filterExpr },
          function (data) {
            if (success) success(collectTags(info, extractMemos(data)))
          },
          fail
        )
        return
      }

      if (global.MemosApiV023) {
        global.MemosApiV023.listMemos(info, { pageSize: 1000 }, function (data) {
          if (success) success(collectTags(info, extractMemos(data)))
        }, fail)
      }
    }

    function searchMemos(pattern, success, fail) {
      const text = String(pattern || '')
      const patternLiteral = JSON.stringify(text)
      const legacyFilter = '?filter=' + encodeURIComponent('visibility in ["PUBLIC","PROTECTED"] && content.contains(' + patternLiteral + ')')

      if (flavor === 'modern' && global.MemosApiV023) {
        const filterExpr = buildModernFilter({ contentSearch: text })
        global.MemosApiV023.listMemos(info, { pageSize: 1000, filterExpr: filterExpr }, function (data) {
          if (success) success(extractMemos(data))
        }, fail)
        return
      }

      if (flavor === 'v023' && global.MemosApiV023) {
        const filterExpr = global.MemosApiV023.buildFilter({
          visibilities: ['PUBLIC', 'PROTECTED'],
          contentSearch: text
        })
        global.MemosApiV023.listMemos(info, { pageSize: 1000, filterExpr: filterExpr }, function (data) {
          if (success) success(keepLegacyVisibleMemos(extractMemos(data)))
        }, fail)
        return
      }

      if (flavor === FLAVOR_V020_V021 && global.MemosApiV020V021) {
        global.MemosApiV020V021.listMemos(info, { limit: 1000, rowStatus: 'NORMAL', contentSearch: text }, function (data) {
          if (success) success(keepLegacyVisibleMemos(extractMemos(data)))
        }, fail)
        return
      }

      if (global.MemosApiModern) {
        global.MemosApiModern.fetchMemosWithFallback(info, legacyFilter, function (data) {
          if (success) success(keepLegacyVisibleMemos(extractMemos(data)))
        }, fail)
      }
    }

    function listRandomMemos(success, fail) {
      if (flavor === 'modern' && global.MemosApiV023) {
        const filterExpr = global.MemosApiV023.buildFilter({})
        global.MemosApiV023.listMemos(info, { pageSize: 1000, filterExpr: filterExpr }, function (data) {
          if (success) success(extractMemos(data))
        }, fail)
        return
      }

      if (flavor === 'v023' && global.MemosApiV023) {
        const filterExpr = global.MemosApiV023.buildFilter({ visibilities: ['PUBLIC', 'PROTECTED'] })
        global.MemosApiV023.listMemos(info, { pageSize: 1000, filterExpr: filterExpr }, function (data) {
          if (success) success(keepLegacyVisibleMemos(extractMemos(data)))
        }, fail)
        return
      }

      if (flavor === FLAVOR_V020_V021 && global.MemosApiV020V021) {
        global.MemosApiV020V021.listMemos(info, { limit: 1000, rowStatus: 'NORMAL' }, function (data) {
          if (success) success(keepLegacyVisibleMemos(extractMemos(data)))
        }, fail)
        return
      }

      if (global.MemosApiModern) {
        const legacyFilter = '?filter=' + encodeURIComponent('visibility in ["PUBLIC","PROTECTED"]')
        global.MemosApiModern.fetchMemosWithFallback(info, legacyFilter, function (data) {
          if (success) success(keepLegacyVisibleMemos(extractMemos(data)))
        }, fail)
      }
    }

    function deleteResource(item, success, fail) {
      const name = item && item.name ? item.name : ''
      const rid = item && item.id != null ? item.id : ''
      const inferredId = (function () {
        if (rid != null && String(rid).trim() !== '' && !Number.isNaN(Number(rid))) return Math.floor(Number(rid))
        const tail = String(name || '').split('/').pop()
        if (tail && !Number.isNaN(Number(tail))) return Math.floor(Number(tail))
        return null
      })()

      if (flavor === FLAVOR_V020_V021 && global.MemosApiV020V021 && typeof global.MemosApiV020V021.deleteResource === 'function' && inferredId != null) {
        global.MemosApiV020V021.deleteResource(info, inferredId, success, fail)
        return
      }

      requestJson({
        url: info.apiUrl + 'api/v1/' + name,
        type: 'DELETE',
        headers: { Authorization: 'Bearer ' + info.apiTokens }
      }, success, fail)
    }

    function uploadFile(file, options, success, fail) {
      const sourceName = String(file && file.name ? file.name : 'upload')
      const lastDot = sourceName.lastIndexOf('.')
      const filenameBase = lastDot > 0 ? sourceName.slice(0, lastDot) : sourceName
      const fileExt = lastDot > 0 ? sourceName.slice(lastDot) : ''
      const now = global.dayjs().format('YYYYMMDDHHmmss')
      const nextName = filenameBase + '_' + now + fileExt

      if (flavor === FLAVOR_V020_V021 && global.MemosApiV020V021) {
        global.MemosApiV020V021.uploadResourceBlob(
          info,
          file,
          { filename: nextName, type: file.type },
          function (entity) {
            if (success) success(normalizeUploadedItem(entity, nextName))
          },
          fail
        )
        return
      }

      const reader = new FileReader()
      reader.onload = function (e) {
        const base64String = e && e.target && e.target.result ? String(e.target.result).split(',')[1] : ''
        const payload = {
          content: base64String,
          visibility: buildUploadVisibility(options && options.editorContent, options && options.hideTag, options && options.showTag, options && options.memoLock),
          filename: nextName,
          type: file.type
        }

        global.MemosApiModern.uploadAttachmentOrResource(
          info,
          payload,
          function (resp) {
            const entity = (resp && (resp.attachment || resp.resource)) || resp
            if (success) success(normalizeUploadedItem(entity, nextName))
          },
          fail
        )
      }
      reader.onerror = fail
      reader.readAsDataURL(file)
    }

    function archiveMemo(memo, success, fail) {
      const memoId = memo && memo.id != null ? memo.id : ''
      const memoName = memo && memo.name ? memo.name : ''

      if (flavor === FLAVOR_V020_V021 && global.MemosApiV020V021 && memoId !== '') {
        global.MemosApiV020V021.patchMemo(info, memoId, { rowStatus: 'ARCHIVED' }, success, fail)
        return
      }

      requestJson({
        url: info.apiUrl + 'api/v1/' + memoName + '?updateMask=state',
        type: 'PATCH',
        data: JSON.stringify({ name: memoName, state: 'ARCHIVED' }),
        contentType: 'application/json',
        dataType: 'json',
        headers: { Authorization: 'Bearer ' + info.apiTokens }
      }, success, fail)
    }

    function getMemo(memoRef, success, fail) {
      const url = flavor === FLAVOR_V020_V021
        ? info.apiUrl + 'api/v1/memo/' + memoRef
        : info.apiUrl + 'api/v1/' + memoRef

      requestJson({
        url: url,
        type: 'GET',
        contentType: 'application/json',
        dataType: 'json',
        headers: { Authorization: 'Bearer ' + info.apiTokens }
      }, function (data) {
        if (success) success(flavor === FLAVOR_V020_V021 ? unwrapLegacyMemoEntity(data) : data)
      }, fail)
    }

    function createMemo(params, success, fail) {
      const payload = params || {}

      if (flavor === FLAVOR_V020_V021 && global.MemosApiV020V021) {
        global.MemosApiV020V021.createMemo(
          info,
          {
            content: payload.content,
            visibility: payload.visibility,
            resourceIdList: normalizeLegacyResourceIdList(payload.resourceIdList)
          },
          success,
          fail
        )
        return
      }

      const uploadedItems = Array.isArray(payload.resourceIdList) ? payload.resourceIdList : []
      const attachmentReferences = uploadedItems
        .filter(function (item) {
          return item && typeof item.name === 'string' && item.name.indexOf('attachments/') === 0
        })
        .map(function (item) {
          return { name: item.name }
        })
      const canCreateWithAttachments = flavor === 'modern' && attachmentReferences.length === uploadedItems.length

      requestJson({
        url: info.apiUrl + 'api/v1/memos',
        type: 'POST',
        data: JSON.stringify({
          content: payload.content,
          visibility: payload.visibility,
          ...(canCreateWithAttachments ? { attachments: attachmentReferences } : {})
        }),
        contentType: 'application/json',
        dataType: 'json',
        headers: { Authorization: 'Bearer ' + info.apiTokens }
      }, function (data) {
        const createdName = data && data.name ? data.name : data && data.memo && data.memo.name ? data.memo.name : ''
        const resources = uploadedItems
        if (!createdName) {
          if (success) success(data)
          return
        }
        if (resources.length === 0 || canCreateWithAttachments) {
          getMemo(createdName, success, fail)
          return
        }

        global.MemosApiModern.patchMemoWithAttachmentsOrResources(
          info,
          createdName,
          resources,
          function () {
            getMemo(createdName, success, fail)
          },
          function () {
            getMemo(createdName, success, fail)
          }
        )
      }, fail)
    }

    return {
      flavor: flavor,
      needsAuthenticatedImagePreview: function () {
        return true
      },
      listTags: listTags,
      searchMemos: searchMemos,
      listRandomMemos: listRandomMemos,
      deleteResource: deleteResource,
      uploadFile: uploadFile,
      archiveMemo: archiveMemo,
      getMemo: getMemo,
      createMemo: createMemo
    }
  }

  global.MemosApiAdapter = {
    FLAVOR_V020_V021: FLAVOR_V020_V021,
    KNOWN_FLAVORS: KNOWN_FLAVORS.slice(),
    getFlavor: getFlavor,
    normalizeDetectedFlavor: normalizeDetectedFlavor,
    probeFlavor: probeFlavor,
    resolve: resolve
  }
})(window)
