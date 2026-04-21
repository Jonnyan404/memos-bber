(function (global) {
    'use strict'

    function isNotFoundLikeXhr(jqXhr) {
        const status = jqXhr && jqXhr.status
        return status === 404 || status === 405
    }

    function extractMemosListFromResponse(data) {
        if (!data) return []
        if (Array.isArray(data)) return data
        if (Array.isArray(data.memos)) return data.memos
        if (data.data && Array.isArray(data.data.memos)) return data.data.memos
        if (Array.isArray(data.list)) return data.list
        return []
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

    function requestJson(url, method, headers, body, success, fail) {
        global.$
            .ajax({
                url: url,
                type: method,
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

    function extractUserIdFromAuthResponse(response) {
        if (!response) return null

        const user = response.user || response
        if (!user) return null

        function normalizeUserId(value) {
            if (typeof value === 'number' && Number.isFinite(value)) return String(value)
            if (typeof value !== 'string') return null
            const trimmed = value.trim()
            if (!trimmed) return null
            const last = trimmed.split('/').pop()
            return last ? String(last) : trimmed
        }

        const directId = normalizeUserId(user.id)
        if (directId != null) return directId

        const name = typeof user.name === 'string' ? user.name : ''
        if (name) {
            const fromName = normalizeUserId(name)
            if (fromName != null) return fromName
        }

        return null
    }

    function getCurrentUser(info, success, fail) {
        const headers = { Authorization: 'Bearer ' + info.apiTokens }
        requestGet(info.apiUrl + 'api/v1/auth/me', headers, success, fail)
    }

    function listMemos(info, options, success, fail) {
        const opt = options || {}
        const headers = { Authorization: 'Bearer ' + info.apiTokens }
        const pageSize = opt.pageSize && Number.isFinite(opt.pageSize) ? Math.max(1, Math.min(1000, Math.floor(opt.pageSize))) : 1000
        const state = typeof opt.state === 'string' && opt.state ? opt.state : 'NORMAL'
        const filterExpr = typeof opt.filterExpr === 'string' ? opt.filterExpr : ''
        const orderBy = typeof opt.orderBy === 'string' && opt.orderBy ? opt.orderBy : ''

        let qs = '?pageSize=' + encodeURIComponent(String(pageSize))
        if (state) qs += '&state=' + encodeURIComponent(state)
        if (filterExpr) qs += '&filter=' + encodeURIComponent(filterExpr)
        if (orderBy) qs += '&orderBy=' + encodeURIComponent(orderBy)

        requestGet(
            info.apiUrl + 'api/v1/memos' + qs,
            headers,
            function (data) {
                if (success) success({ memos: extractMemosListFromResponse(data), raw: data })
            },
            function (xhr) {
                const fallbackQs =
                    '?pageSize=' +
                    encodeURIComponent(String(pageSize)) +
                    (filterExpr ? '&filter=' + encodeURIComponent(filterExpr) : '')

                requestGet(
                    info.apiUrl + 'api/v1/memos' + fallbackQs,
                    headers,
                    function (data) {
                        if (success) success({ memos: extractMemosListFromResponse(data), raw: data })
                    },
                    function () {
                        if (fail) fail(xhr)
                    }
                )
            }
        )
    }

    function createMemo(info, body, success, fail) {
        const headers = { Authorization: 'Bearer ' + info.apiTokens }
        const payload = Object.assign({ state: 'NORMAL' }, body || {})

        requestJson(
            info.apiUrl + 'api/v1/memos',
            'POST',
            headers,
            payload,
            function (data) {
                if (success) success(data && data.memo ? data.memo : data)
            },
            function (xhr) {
                const fallbackPayload = Object.assign({}, body || {})
                requestJson(
                    info.apiUrl + 'api/v1/memos',
                    'POST',
                    headers,
                    fallbackPayload,
                    function (data) {
                        if (success) success(data && data.memo ? data.memo : data)
                    },
                    function () {
                        if (fail) fail(xhr)
                    }
                )
            }
        )
    }

    function createAttachment(info, body, success, fail) {
        const headers = { Authorization: 'Bearer ' + info.apiTokens }
        requestJson(info.apiUrl + 'api/v1/attachments', 'POST', headers, body, success, fail)
    }

    function setMemoAttachments(info, memoName, list, success, fail) {
        const headers = { Authorization: 'Bearer ' + info.apiTokens }
        const memoId = typeof memoName === 'string' ? memoName.split('/').pop() : ''
        if (!memoId) {
            if (fail) fail({ status: 400 })
            return
        }

        const attachments = (Array.isArray(list) ? list : [])
            .map(function (item) {
                if (!item) return null
                const name = typeof item.name === 'string' ? item.name : ''
                if (!name) return null
                return { name: name }
            })
            .filter(Boolean)

        requestJson(
            info.apiUrl + 'api/v1/memos/' + encodeURIComponent(memoId) + '/attachments',
            'PATCH',
            headers,
            {
                name: memoName,
                attachments: attachments
            },
            success,
            function (xhr) {
                if (global.MemosApi && typeof global.MemosApi.patchMemoWithAttachmentsOrResources === 'function') {
                    global.MemosApi.patchMemoWithAttachmentsOrResources(info, memoName, list, success, function () {
                        if (fail) fail(xhr)
                    })
                    return
                }
                if (fail) fail(xhr)
            }
        )
    }

    function deleteAttachment(info, attachmentNameOrId, success, fail) {
        const headers = { Authorization: 'Bearer ' + info.apiTokens }
        const raw = attachmentNameOrId != null ? String(attachmentNameOrId).trim() : ''
        if (!raw) {
            if (fail) fail({ status: 400 })
            return
        }

        const attachmentId = raw.indexOf('/') >= 0 ? raw.split('/').pop() : raw
        global.$
            .ajax({
                url: info.apiUrl + 'api/v1/attachments/' + encodeURIComponent(attachmentId),
                type: 'DELETE',
                headers: headers
            })
            .done(function (data) {
                if (success) success(data)
            })
            .fail(function (xhr) {
                // Keep compatibility with deployments still accepting full resource names.
                if (isNotFoundLikeXhr(xhr) && raw.indexOf('/') >= 0) {
                    global.$
                        .ajax({
                            url: info.apiUrl + 'api/v1/' + raw,
                            type: 'DELETE',
                            headers: headers
                        })
                        .done(function (data) {
                            if (success) success(data)
                        })
                        .fail(function (xhr2) {
                            if (fail) fail(xhr2)
                        })
                    return
                }
                if (fail) fail(xhr)
            })
    }

    function probeApiFlavor(apiUrl, apiTokens, callback) {
        const headers = { Authorization: 'Bearer ' + apiTokens }

        requestGet(
            apiUrl + 'api/v1/attachments?pageSize=1',
            headers,
            function () {
                callback({ flavor: 'v027' })
            },
            function () {
                requestGet(
                    apiUrl + 'api/v1/memos?pageSize=1&state=NORMAL',
                    headers,
                    function () {
                        callback({ flavor: 'v027' })
                    },
                    function () {
                        callback({ flavor: 'unknown' })
                    }
                )
            }
        )
    }

    global.MemosApiV027 = {
        extractMemosListFromResponse: extractMemosListFromResponse,
        extractUserIdFromAuthResponse: extractUserIdFromAuthResponse,
        getCurrentUser: getCurrentUser,
        listMemos: listMemos,
        createMemo: createMemo,
        createAttachment: createAttachment,
        setMemoAttachments: setMemoAttachments,
        deleteAttachment: deleteAttachment,
        probeApiFlavor: probeApiFlavor
    }
})(window)