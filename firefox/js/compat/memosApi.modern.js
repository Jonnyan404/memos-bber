(function (global) {
  'use strict'

  function extractUserIdFromAuthResponse(response) {
    if (!response) return null

    const user = response.user || response

    if (typeof user.id === 'number' && Number.isFinite(user.id)) return user.id
    if (typeof user.id === 'string' && user.id.trim() !== '' && !Number.isNaN(Number(user.id))) {
      return Number(user.id)
    }

    if (typeof user.username === 'string' && user.username.trim() !== '') {
      return user.username.trim()
    }

    const name = user.name || (user.user && user.user.name)
    if (typeof name === 'string') {
      const m = name.match(/\busers\/(\d+)\b/)
      if (m) return Number(m[1])
      const last = name.split('/').pop()
      if (last) {
        if (!Number.isNaN(Number(last))) return Number(last)
        if (last.trim() !== '') return last.trim()
      }
    }

    return null
  }

  function extractMemosListFromResponse(data) {
    if (!data) return []
    if (Array.isArray(data)) return data
    if (Array.isArray(data.memos)) return data.memos
    if (data.data && Array.isArray(data.data.memos)) return data.data.memos
    if (Array.isArray(data.list)) return data.list
    return []
  }

  function isNotFoundLikeXhr(jqXhr) {
    const status = jqXhr && jqXhr.status
    return status === 404 || status === 405
  }

  function authWithFallback(apiUrl, apiTokens, callback) {
    const headers = { Authorization: 'Bearer ' + apiTokens }

    // v0.26+: GET auth/me
    // older:  POST/GET auth/status
    const tries = [
      { method: 'GET', path: 'api/v1/auth/me', uiPath: 'memos' },
      // v0.25: session-based auth service still accepts bearer tokens and returns { user: ... }.
      { method: 'GET', path: 'api/v1/auth/sessions/current', uiPath: 'memos' },
      // v0.20: current user endpoint.
      { method: 'GET', path: 'api/v1/user/me', uiPath: 'm' },
      { method: 'POST', path: 'api/v1/auth/status', uiPath: 'm' },
      { method: 'GET', path: 'api/v1/auth/status', uiPath: 'm' }
    ]

    function runAt(index) {
      if (index >= tries.length) {
        callback(null)
        return
      }

      const t = tries[index]
      global.$
        .ajax({
          async: true,
          crossDomain: true,
          url: apiUrl + t.path,
          method: t.method,
          headers: headers
        })
        .done(function (response) {
          const userId = extractUserIdFromAuthResponse(response)
          if (userId != null) callback({ userId: userId, uiPath: t.uiPath, raw: response })
          else runAt(index + 1)
        })
        .fail(function () {
          runAt(index + 1)
        })
    }

    runAt(0)
  }

  function fetchMemosWithFallback(info, query, success, fail) {
    const qs = query || ''
    const headers = { Authorization: 'Bearer ' + info.apiTokens }

    // v0.24: `GET /api/v1/memos` tends to behave like a public feed (private memos excluded).
    // For an authenticated user, `GET /api/v1/users/{id}/memos` is the safe way to retrieve
    // the full set (including private), which affects tag extraction.
    // Newer versions may not expose the user-scoped endpoint, so we fallback by 404/405.
    const urlUserScoped = info.userid
      ? info.apiUrl + 'api/v1/users/' + encodeURIComponent(String(info.userid)) + '/memos' + qs
      : null
    const urlGlobal = info.apiUrl + 'api/v1/memos' + qs

    const urlPrimary = urlUserScoped || urlGlobal
    const urlFallback = urlUserScoped ? urlGlobal : null

    global.$
      .ajax({
        url: urlPrimary,
        type: 'GET',
        contentType: 'application/json',
        dataType: 'json',
        headers: headers
      })
      .done(function (data) {
        success(data)
      })
      .fail(function (xhr) {
        const status = xhr && xhr.status
        const canFallback = Boolean(urlFallback) && (isNotFoundLikeXhr(xhr) || status === 400)
        if (!canFallback) {
          if (fail) fail(xhr)
          return
        }

        global.$
          .ajax({
            url: urlFallback,
            type: 'GET',
            contentType: 'application/json',
            dataType: 'json',
            headers: headers
          })
          .done(function (data) {
            success(data)
          })
          .fail(function (xhr2) {
            if (fail) fail(xhr2)
          })
      })
  }

  function uploadAttachmentOrResource(info, payload, onSuccess, onFail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }
    const urlAttachments = info.apiUrl + 'api/v1/attachments'
    const urlResources = info.apiUrl + 'api/v1/resources'

    function stripVisibility(p) {
      if (!p || typeof p !== 'object') return p
      if (!Object.prototype.hasOwnProperty.call(p, 'visibility')) return p
      const copy = Object.assign({}, p)
      delete copy.visibility
      return copy
    }

    function uploadResource() {
      global.$
        .ajax({
          url: urlResources,
          data: JSON.stringify(payload),
          type: 'POST',
          cache: false,
          processData: false,
          contentType: 'application/json',
          dataType: 'json',
          headers: headers
        })
        .done(function (data) {
          onSuccess(data, 'resources')
        })
        .fail(function (xhr) {
          if (!xhr || xhr.status !== 400) {
            if (onFail) onFail(xhr)
            return
          }

          global.$
            .ajax({
              url: urlResources,
              data: JSON.stringify(stripVisibility(payload)),
              type: 'POST',
              cache: false,
              processData: false,
              contentType: 'application/json',
              dataType: 'json',
              headers: headers
            })
            .done(function (data) {
              onSuccess(data, 'resources')
            })
            .fail(function (xhr2) {
              if (onFail) onFail(xhr2)
            })
        })
    }

    // Attachment visibility was removed in Memos v0.26. Send the current
    // attachment shape first and retain the resource endpoint as a legacy fallback.
    global.$
      .ajax({
        url: urlAttachments,
        data: JSON.stringify(stripVisibility(payload)),
        type: 'POST',
        cache: false,
        processData: false,
        contentType: 'application/json',
        dataType: 'json',
        headers: headers
      })
      .done(function (data) {
        onSuccess(data, 'attachments')
      })
      .fail(function (xhr) {
        if (isNotFoundLikeXhr(xhr)) {
          uploadResource()
          return
        }
        if (onFail) onFail(xhr)
      })
  }

  function patchMemoWithAttachmentsOrResources(info, memoName, list, onSuccess, onFail) {
    const headers = { Authorization: 'Bearer ' + info.apiTokens }
    const url = info.apiUrl + 'api/v1/' + memoName
    const items = Array.isArray(list) ? list : []

    const hasResourceNames = items.some(function (x) {
      return x && typeof x.name === 'string' && x.name.indexOf('resources/') === 0
    })
    const hasAttachmentNames = items.some(function (x) {
      return x && typeof x.name === 'string' && x.name.indexOf('attachments/') === 0
    })

    function doPatchAttachments() {
      const attachments = items
        .map(function (x) {
          if (!x) return null
          const n = x.name
          if (!n) return null
          if (hasAttachmentNames && typeof n === 'string' && n.indexOf('attachments/') !== 0) return null
          return { name: n }
        })
        .filter(Boolean)

      // Prefer the dedicated subresource endpoint when available.
      global.$
        .ajax({
          url: url + '/attachments',
          type: 'PATCH',
          data: JSON.stringify({ name: memoName, attachments: attachments }),
          contentType: 'application/json',
          dataType: 'json',
          headers: headers
        })
        .done(function (data) {
          onSuccess(data, 'attachments')
        })
        .fail(function (xhr0) {
          // If the endpoint doesn't exist, try UpdateMemo-style patching.
          if (isNotFoundLikeXhr(xhr0)) {
            // continue
          } else if (xhr0 && xhr0.status && xhr0.status !== 400) {
            // continue; some gateways may reject body shape here.
          }

          // Some versions accept a loose patch, others require updateMask.
          const attachmentsPayloadLoose = {
            name: memoName,
            attachments: attachments
          }

          global.$
            .ajax({
              url: url,
              type: 'PATCH',
              data: JSON.stringify(attachmentsPayloadLoose),
              contentType: 'application/json',
              dataType: 'json',
              headers: headers
            })
            .done(function (data) {
              onSuccess(data, 'attachments')
            })
            .fail(function (xhr) {
              // v0.25 requires update mask when updating attachments.
              if (!isNotFoundLikeXhr(xhr) && xhr && xhr.status !== 400) {
                if (onFail) onFail(xhr)
                return
              }

              // If the server doesn't support attachments at all, fallback to resources flow.
              if (isNotFoundLikeXhr(xhr)) {
                doPatchResources()
                return
              }

              const attachmentsPayloadV025 = {
                name: memoName,
                attachments: attachments
              }

              const updateUrl1 = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'updateMask=attachments'
              global.$
                .ajax({
                  url: updateUrl1,
                  type: 'PATCH',
                  data: JSON.stringify(attachmentsPayloadV025),
                  contentType: 'application/json',
                  dataType: 'json',
                  headers: headers
                })
                .done(function (data) {
                  onSuccess(data, 'attachments')
                })
                .fail(function (xhr2) {
                  if (isNotFoundLikeXhr(xhr2)) {
                    doPatchResources()
                    return
                  }
                  // Some grpc-gateway setups prefer updateMask.paths.
                  if (xhr2 && xhr2.status === 400) {
                    const updateUrl2 =
                      url + (url.indexOf('?') >= 0 ? '&' : '?') + 'updateMask.paths=attachments'
                    global.$
                      .ajax({
                        url: updateUrl2,
                        type: 'PATCH',
                        data: JSON.stringify(attachmentsPayloadV025),
                        contentType: 'application/json',
                        dataType: 'json',
                        headers: headers
                      })
                      .done(function (data) {
                        onSuccess(data, 'attachments')
                      })
                      .fail(function (xhr3) {
                        if (isNotFoundLikeXhr(xhr3)) {
                          doPatchResources()
                          return
                        }
                        if (onFail) onFail(xhr3)
                      })
                    return
                  }
                  if (onFail) onFail(xhr2)
                })
            })
        })
    }

    function doPatchResources() {
      const resources = items
        .map(function (x) {
          if (!x) return null
          const n = x.name
          if (!n) return null
          if (hasResourceNames && typeof n === 'string' && n.indexOf('resources/') !== 0) return null
          return { name: n }
        })
        .filter(Boolean)

      // Prefer the dedicated subresource endpoint when available.
      global.$
        .ajax({
          url: url + '/resources',
          type: 'PATCH',
          data: JSON.stringify({ name: memoName, resources: resources }),
          contentType: 'application/json',
          dataType: 'json',
          headers: headers
        })
        .done(function (data) {
          onSuccess(data, 'resources')
        })
        .fail(function (xhr0) {
          if (!isNotFoundLikeXhr(xhr0) && xhr0 && xhr0.status && xhr0.status !== 400) {
            // continue; try UpdateMemo flow below.
          }

      // Try a loose PATCH first (some versions accept this).
      const resourcesPayloadLoose = { resources: resources }

      global.$
        .ajax({
          url: url,
          type: 'PATCH',
          data: JSON.stringify(resourcesPayloadLoose),
          contentType: 'application/json',
          dataType: 'json',
          headers: headers
        })
        .done(function (data) {
          onSuccess(data, 'resources')
        })
        .fail(function (xhr2) {
          // v0.24 expects UpdateMemo with an update mask when modifying resources.
          // The gateway commonly accepts `updateMask=resources` as a query param and a
          // Memo body containing `name` + `resources`.
          if (!isNotFoundLikeXhr(xhr2) && xhr2 && xhr2.status !== 400) {
            if (onFail) onFail(xhr2)
            return
          }

          const updateUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'updateMask=resources'
          const resourcesPayloadV024 = {
            name: memoName,
            resources: resources
          }

          global.$
            .ajax({
              url: updateUrl,
              type: 'PATCH',
              data: JSON.stringify(resourcesPayloadV024),
              contentType: 'application/json',
              dataType: 'json',
              headers: headers
            })
            .done(function (data) {
              onSuccess(data, 'resources')
            })
            .fail(function (xhr3) {
              if (onFail) onFail(xhr3)
            })
        })
        })
    }

    // If the list clearly contains v0.24-style resource names, go directly to the
    // resource linking flow. If it contains attachment names, go attachment flow.
    if (hasResourceNames && !hasAttachmentNames) {
      doPatchResources()
      return
    }
    if (hasAttachmentNames && !hasResourceNames) {
      doPatchAttachments()
      return
    }

    // Default to attachments first, then fallback to resources.
    doPatchAttachments()
  }

  global.MemosApiModern = {
    extractUserIdFromAuthResponse: extractUserIdFromAuthResponse,
    extractMemosListFromResponse: extractMemosListFromResponse,
    isNotFoundLikeXhr: isNotFoundLikeXhr,
    authWithFallback: authWithFallback,
    fetchMemosWithFallback: fetchMemosWithFallback,
    uploadAttachmentOrResource: uploadAttachmentOrResource,
    patchMemoWithAttachmentsOrResources: patchMemoWithAttachmentsOrResources
  }
})(window)
