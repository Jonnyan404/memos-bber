/**
 * Memos API adapter (v2)
 * ---------------------------------------------------------------------------
 * One adapter for Memos v0.15.0 -> 26.10+ (and newer).
 *
 * The upstream API changed shape four times. Instead of one branch per release
 * we model four "eras" and derive everything (routes, payloads, listing,
 * uploads) from the era, with runtime fallbacks when detection is wrong:
 *
 *   legacy      0.15 - 0.21  REST, /api/v1/memo (singular), resources as blobs
 *   v1-filter   0.22 - 0.23  protobuf REST, /api/v1/memos, `visibilities == []`
 *   v1-modern   0.24 - 0.31  `visibility in []`, attachments since 0.25
 *   v2          26.10+       no `/v1` marker: /api/memos, /api/attachments
 *
 * Notable upstream changes handled here:
 *   - 0.15: access token is delivered through the `memos.access-token` cookie
 *     header on sign-in; memos only expose a numeric `id`.
 *   - 0.18: memos gain a string `uid`; 0.22 exposes `name` ("memos/{id}").
 *   - 0.22: gRPC-gateway API, `resource` endpoints, `rowStatus` -> `state`
 *     (0.23), memo creation returns `{name, uid}`.
 *   - 0.23: global tag endpoints removed; tags must be derived from memos.
 *   - 0.23/0.24: list filters change from `visibilities == []` to
 *     `visibility in []`; `creator == "users/{ref}"` is stable across both.
 *   - 0.25: `attachments` replace `resources`; sessions auth endpoint.
 *   - 0.26: `/auth/me` + `accessToken` in the sign-in response; attachment
 *     visibility removed; `disallow_public_visibility` still rejects PUBLIC.
 *   - 0.27: the "disallow public memos" setting is gone from the API.
 *   - 0.31: `SPACE` visibility is added (visibility set is no longer closed).
 *   - 26.10: `/api/v1/*` returns 410 Gone; all paths lose the `/v1` marker,
 *     proto package becomes `memos.api`, `Memo.visibility` is required.
 *
 * Design rules:
 *   1. Detect the server version once (`instance/profile`), then cache it.
 *   2. Never trust detection blindly: every request retries the other base
 *      (`/api/v1/` <-> `/api/`) on 404/410 and remembers what worked.
 *   3. Listing/search/tags/random share one "list my memos" primitive and are
 *      filtered client-side, so they do not depend on CEL differences.
 *   4. Failures carry `{kind, status, code, message, hint}` so the UI can show
 *      the real reason instead of "failed".
 */
(function (global) {
  'use strict'

  var ERA_LEGACY = 'legacy'
  var ERA_V1_FILTER = 'v1-filter'
  var ERA_V1_MODERN = 'v1-modern'
  var ERA_V2 = 'v2'
  var ERA_UNKNOWN = 'unknown'

  var BASE_V1 = 'api/v1/'
  var BASE_V2 = 'api/'

  // Stored settings from older builds only know these names.
  var FLAVOR_V020_V021 = 'v020-v021'
  var KNOWN_FLAVORS = [FLAVOR_V020_V021, 'v023', 'modern']
  var KNOWN_ERAS = [ERA_LEGACY, ERA_V1_FILTER, ERA_V1_MODERN, ERA_V2]

  var baseCache = Object.create(null)
  var detectCache = Object.create(null)

  function normalizeApiUrl(url) {
    var value = typeof url === 'string' ? url.trim() : ''
    if (!value) return ''
    if (value.charAt(value.length - 1) !== '/') value += '/'
    return value
  }

  function enc(value) {
    return encodeURIComponent(String(value))
  }

  function parseVersion(raw) {
    var m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(raw == null ? '' : raw))
    if (!m) return null
    return {
      raw: String(raw),
      major: parseInt(m[1], 10),
      minor: parseInt(m[2], 10),
      patch: parseInt(m[3] || '0', 10)
    }
  }

  function eraOfVersion(parsed) {
    if (!parsed) return ERA_UNKNOWN
    // 26.10+ switched to calendar versioning (major >= 20 identifies it).
    if (parsed.major >= 20) return ERA_V2
    if (parsed.minor <= 21) return ERA_LEGACY
    if (parsed.minor <= 23) return ERA_V1_FILTER
    return ERA_V1_MODERN
  }

  function eraOf(info) {
    var cached = info && info.apiUrl ? detectCache[info.apiUrl] : null
    if (info && info.apiVersion) {
      var era = eraOfVersion(parseVersion(info.apiVersion))
      if (era !== ERA_UNKNOWN) return era
    }
    if (cached && cached.era) return cached.era
    var flavor = info && info.apiFlavor
    if (flavor === FLAVOR_V020_V021) return ERA_LEGACY
    if (flavor === 'v023') return ERA_V1_FILTER
    if (flavor === 'modern') return ERA_V1_MODERN
    return ERA_UNKNOWN
  }

  function flavorOf(era) {
    if (era === ERA_LEGACY) return FLAVOR_V020_V021
    if (era === ERA_V1_FILTER) return 'v023'
    if (era === ERA_V1_MODERN || era === ERA_V2) return 'modern'
    return ''
  }

  function baseCandidates(info) {
    var era = eraOf(info)
    var primary = (info && info.apiBase) || baseCache[info && info.apiUrl] || (era === ERA_V2 ? BASE_V2 : BASE_V1)
    var secondary = primary === BASE_V2 ? BASE_V1 : BASE_V2
    return [primary, secondary]
  }

  // --------------------------------------------------------------------- utils

  function errorInfo(xhr) {
    var status = xhr && typeof xhr.status === 'number' ? xhr.status : 0
    var body = xhr && xhr.responseJSON
    if (!body && xhr && typeof xhr.responseText === 'string' && xhr.responseText) {
      try {
        body = JSON.parse(xhr.responseText)
      } catch (_) {
        body = null
      }
    }
    var message = ''
    var code = null
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string') message = body.message
      else if (typeof body.error === 'string') message = body.error
      if (typeof body.code === 'number') code = body.code
    }
    if (!message && xhr && typeof xhr.statusText === 'string') message = xhr.statusText

    var kind = 'error'
    if (!status) kind = 'network'
    else if (status === 401) kind = 'auth'
    else if (status === 403) kind = 'forbidden'
    else if (status === 404) kind = 'notfound'
    else if (status === 410) kind = 'gone'
    else if (status >= 500) kind = 'server'
    else if (status >= 400) kind = 'client'

    var hint = ''
    if (kind === 'gone' || /API v1 has been removed/i.test(message)) hint = 'apiRemoved'
    else if (kind === 'forbidden' && /public|visibility/i.test(message)) hint = 'publicForbidden'
    else if (kind === 'auth') hint = 'auth'
    else if (kind === 'network') hint = 'network'
    else if (kind === 'notfound') hint = 'endpoint'

    return { kind: kind, status: status, code: code, message: message, hint: hint }
  }

  function isRetryableBaseError(err) {
    return err && (err.status === 404 || err.status === 410)
  }

  function request(info, options, success, fail) {
    var opts = options || {}
    var bases = baseCandidates(info)
    var index = 0
    var lastError = null

    function run() {
      var base = bases[index++]
      var url = normalizeApiUrl(info.apiUrl) + base + opts.path
      var settings = {
        url: url,
        type: opts.method || 'GET',
        dataType: (opts.method || 'GET') === 'DELETE' ? 'text' : 'json',
        headers: { Authorization: 'Bearer ' + info.apiTokens }
      }
      if (opts.form) {
        settings.data = opts.form
        settings.processData = false
        settings.contentType = false
      } else if (opts.body != null) {
        settings.data = JSON.stringify(opts.body)
        settings.contentType = 'application/json'
      }

      global.$
        .ajax(settings)
        .done(function (data) {
          info.apiBase = base
          if (info.apiUrl) baseCache[info.apiUrl] = base
          if (success) success(data, base)
        })
        .fail(function (xhr) {
          var err = errorInfo(xhr)
          lastError = err
          if (isRetryableBaseError(err) && index < bases.length) {
            run()
            return
          }
          if (fail) fail(err, xhr)
        })
    }

    run()
  }

  function readFileAsDataUrl(file, callback, fail) {
    try {
      var reader = new global.FileReader()
      reader.onload = function (event) {
        var result = event && event.target && event.target.result ? String(event.target.result) : ''
        var comma = result.indexOf(',')
        callback(comma >= 0 ? result.slice(comma + 1) : '')
      }
      reader.onerror = function () {
        if (fail) fail({ kind: 'client', status: 0, code: null, message: 'read file failed', hint: 'file' })
      }
      reader.readAsDataURL(file)
    } catch (e) {
      if (fail) fail({ kind: 'client', status: 0, code: null, message: String(e && e.message ? e.message : e), hint: 'file' })
    }
  }

  // ------------------------------------------------------------- normalization

  function extractList(data) {
    if (!data) return []
    if (Array.isArray(data)) return data
    if (Array.isArray(data.memos)) return data.memos
    if (data.data && Array.isArray(data.data.memos)) return data.data.memos
    if (Array.isArray(data.list)) return data.list
    return []
  }

  function memoName(memo) {
    if (!memo) return ''
    if (typeof memo.name === 'string' && memo.name) return memo.name
    return ''
  }

  function memoUid(memo) {
    if (!memo) return ''
    if (memo.uid != null && memo.uid !== '') return String(memo.uid)
    var name = memoName(memo)
    if (name) {
      var tail = name.split('/').pop()
      if (tail && !/^\d+$/.test(tail)) return tail
    }
    return ''
  }

  function memoNumericId(memo) {
    if (!memo) return null
    if (typeof memo.id === 'number' && isFinite(memo.id)) return Math.floor(memo.id)
    if (typeof memo.id === 'string' && memo.id.trim() !== '' && !isNaN(Number(memo.id))) return Math.floor(Number(memo.id))
    var name = memoName(memo)
    var tail = name ? name.split('/').pop() : ''
    if (tail && /^\d+$/.test(tail)) return Math.floor(Number(tail))
    return null
  }

  // A stable reference usable with PATCH/GET/DELETE.
  function memoRef(memo) {
    if (!memo) return ''
    var name = memoName(memo)
    // 0.22+ resource names look like "memos/{id|uid}". Older releases expose
    // `name` as a bare uid (0.18-0.21), which is not a valid path segment.
    if (name && name.indexOf('memos/') === 0) return name
    var id = memoNumericId(memo)
    if (id != null) return 'memo/' + id
    if (name) return name
    var uid = memoUid(memo)
    return uid ? 'memos/' + uid : ''
  }

  function memoState(memo) {
    if (!memo) return ''
    return String(memo.state || memo.rowStatus || '')
  }

  function normalizeResource(entity, fallbackFilename) {
    if (!entity) return null
    var item = entity.attachment || entity.resource || entity
    var id = memoNumericId(item)
    var name = typeof item.name === 'string' ? item.name : ''
    if (!name && id != null) name = 'resources/' + id
    if (!name && id == null) return null
    return {
      id: id != null ? id : item.id,
      name: name,
      filename: item.filename || fallbackFilename || name,
      type: item.type,
      uid: item.uid,
      size: item.size,
      externalLink: item.externalLink
    }
  }

  function extractTagsFromMemo(memo) {
    if (!memo) return []
    if (Array.isArray(memo.tags) && memo.tags.length) return memo.tags
    if (memo.property && Array.isArray(memo.property.tags) && memo.property.tags.length) return memo.property.tags
    var content = typeof memo.content === 'string' ? memo.content : ''
    var out = []
    var re = /#([^\s#]+)/g
    var m
    while ((m = re.exec(content))) {
      var tag = String(m[1] || '').replace(/[\]\[\)\(\}\{"'.,;:!?]+$/g, '').replace(/^#+/, '').trim()
      if (tag) out.push(tag)
    }
    return out
  }

  // --------------------------------------------------------------------- auth

  function extractUser(payload) {
    if (!payload) return null
    if (payload.user && typeof payload.user === 'object') return payload.user
    if (payload.data && payload.data.user && typeof payload.data.user === 'object') return payload.data.user
    if (payload.username || payload.name || payload.id != null) return payload
    return null
  }

  function userRef(user) {
    if (!user) return ''
    if (typeof user.name === 'string' && user.name.indexOf('users/') === 0) return user.name
    if (typeof user.username === 'string' && user.username) return 'users/' + user.username
    if (user.id != null) return 'users/' + user.id
    return ''
  }

  // Endpoint order follows the upstream history:
  //   0.26+ /auth/me; 0.25 /auth/sessions/current; 0.22-0.24 POST /auth/status;
  //   0.15-0.21 /user/me. `auth/status` GET is kept as a last resort.
  function authenticate(apiUrl, tokens, callback) {
    var info = { apiUrl: normalizeApiUrl(apiUrl), apiTokens: tokens }
    var attempts = [
      { path: 'auth/me', method: 'GET', eraHint: ERA_V1_MODERN },
      { path: 'auth/sessions/current', method: 'GET', eraHint: ERA_V1_MODERN },
      { path: 'auth/status', method: 'POST', eraHint: ERA_V1_FILTER },
      { path: 'user/me', method: 'GET', eraHint: ERA_LEGACY },
      { path: 'auth/status', method: 'GET', eraHint: ERA_V1_FILTER }
    ]
    var index = 0
    var lastError = null

    function next() {
      if (index >= attempts.length) {
        callback(lastError || { kind: 'auth', status: 401, code: null, message: 'unauthorized', hint: 'auth' }, null)
        return
      }
      var attempt = attempts[index++]
      request(info, { path: attempt.path, method: attempt.method }, function (data) {
        var user = extractUser(data)
        if (!user) {
          next()
          return
        }
        var ref = userRef(user)
        var detected = detectCache[info.apiUrl] || {}
        detected.userRef = ref
        if (!detected.era || detected.era === ERA_UNKNOWN) detected.era = attempt.eraHint
        detectCache[info.apiUrl] = detected
        callback(null, {
          user: user,
          userId: user.id,
          userRef: ref,
          uiPath: 'memos',
          base: info.apiBase || baseCandidates(info)[0],
          era: attempt.eraHint,
          version: detected.version || '',
          endpoint: attempt.method + ' ' + attempt.path
        })
      }, function (err) {
        lastError = err
        if (err.kind === 'auth' && err.status === 401) {
          // Token rejected: no point walking the remaining endpoints.
          callback(err, null)
          return
        }
        next()
      })
    }

    next()
  }

  // `auth/status` only tells us 0.22-0.24. 0.24 introduced the user-scoped
  // memo collection, which is a reliable capability split for that bucket.
  function refineEra(info, auth, done) {
    if (auth.era !== ERA_V1_FILTER) {
      done(auth.era)
      return
    }
    var tail = auth.userRef ? String(auth.userRef).split('/').pop() : ''
    if (!tail) {
      done(auth.era)
      return
    }
    request(info, { path: 'users/' + enc(tail) + '/memos?pageSize=1' }, function () {
      done(ERA_V1_MODERN)
    }, function (err) {
      // 404/400 (or the SPA answering 200 HTML) means the route does not exist.
      done(err && (err.status === 404 || err.status === 400 || err.status === 200) ? ERA_V1_FILTER : auth.era)
    })
  }

  function detect(apiUrl, tokens, callback) {
    var info = { apiUrl: normalizeApiUrl(apiUrl), apiTokens: tokens }
    var profilePaths = ['instance/profile', 'status']
    var pIndex = 0

    function profileDone(version) {
      var parsed = parseVersion(version)
      var era = eraOfVersion(parsed)
      detectCache[info.apiUrl] = {
        version: parsed ? parsed.raw : '',
        era: era,
        base: info.apiBase || baseCandidates(info)[0]
      }
      authenticate(info.apiUrl, tokens, function (err, auth) {
        if (err) {
          callback(err, null)
          return
        }
        refineEra(info, auth, function (finalEra) {
          var cache = detectCache[info.apiUrl] || {}
          cache.era = finalEra
          detectCache[info.apiUrl] = cache
          callback(null, {
            version: parsed ? parsed.raw : '',
            era: era !== ERA_UNKNOWN ? era : finalEra,
            flavor: flavorOf(era !== ERA_UNKNOWN ? era : finalEra),
            base: info.apiBase || baseCandidates(info)[0],
            user: auth.user,
            userId: auth.userId,
            userRef: auth.userRef,
            uiPath: 'memos'
          })
        })
      })
    }

    function tryProfile() {
      if (pIndex >= profilePaths.length) {
        // Very old/odd builds: no profile endpoint, keep auth result only.
        profileDone('')
        return
      }
      var path = profilePaths[pIndex++]
      request(info, { path: path, method: 'GET' }, function (data) {
        var version = ''
        if (data && typeof data.version === 'string') version = data.version
        else if (data && data.profile && typeof data.profile.version === 'string') version = data.profile.version
        profileDone(version)
      }, function () {
        tryProfile()
      })
    }

    tryProfile()
  }

  // -------------------------------------------------------------------- memos

  // Listing is the most version-sensitive call. The plain list hides PRIVATE
  // memos on some releases (0.23/0.24) but includes them on others (0.22/0.26+),
  // and the accepted filter changes twice. We therefore try a short ladder of
  // queries derived from the detected version and stop at the first one that
  // returns data, falling back to a plain list when everything is empty.
  function buildCandidates(info, limit) {
    var era = eraOf(info)
    var ref = info.userRef || (detectCache[info.apiUrl] && detectCache[info.apiUrl].userRef) || ''
    var refTail = ref ? ref.split('/').pop() : ''

    var plain = 'memos?pageSize=' + limit
    var byCreator = ref ? plain + '&filter=' + enc('creator == ' + JSON.stringify(ref)) : ''
    var byVisibility = plain + '&filter=' + enc(
      era === ERA_V1_FILTER
        ? 'visibilities == ["PRIVATE","PUBLIC","PROTECTED"]'
        : 'visibility in ["PRIVATE","PUBLIC","PROTECTED","SPACE"]'
    )
    var userScoped = refTail ? 'users/' + enc(refTail) + '/memos?pageSize=' + limit : ''

    // One ladder for every 0.22+ build. Order chosen so the first query is the
    // cheapest one that includes PRIVATE memos for that generation; empty
    // answers are not trusted because some builds return 200 + [] for queries
    // they only partially understand (0.23 plain list, 0.24 visibility filter).
    var candidates = [byCreator, userScoped, plain, byVisibility].filter(Boolean)
    var cached = detectCache[info.apiUrl] && detectCache[info.apiUrl].listPath
    if (cached && candidates.indexOf(cached) !== -1) {
      candidates = [cached].concat(candidates.filter(function (p) { return p !== cached }))
    }
    return candidates
  }

  function pickListPath(info, limit, success, fail) {
    var candidates = buildCandidates(info, limit)
    var index = 0
    var fallback = ''

    function next() {
      if (index >= candidates.length) {
        success(fallback || '')
        return
      }
      var path = candidates[index++]
      request(info, { path: path }, function (data) {
        var list = extractList(data)
        if (!fallback) fallback = path
        if (list.length > 0) {
          if (info.apiUrl && detectCache[info.apiUrl]) detectCache[info.apiUrl].listPath = path
          success(path)
          return
        }
        next()
      }, function (err) {
        // 400/500: the build does not understand the filter.
        // 200 without JSON: the route is missing and the SPA answered instead.
        if (err.status === 400 || err.status === 500 || err.status === 200) {
          next()
          return
        }
        if (fail) fail(err)
      })
    }
    next()
  }

  function fetchPage(info, path, token, callback, fail) {
    var url = path
    if (token) url += (path.indexOf('?') === -1 ? '?' : '&') + 'pageToken=' + enc(token)
    request(info, { path: url }, function (data) {
      var list = extractList(data)
      var nextToken = data && (data.nextPageToken || data.next_page_token)
      callback(list, typeof nextToken === 'string' ? nextToken : '')
    }, fail)
  }

  function listLegacyPages(info, options, success, fail) {
    var opts = options || {}
    var limit = opts.pageSize && isFinite(opts.pageSize) ? Math.max(1, Math.floor(opts.pageSize)) : 1000
    var maxPages = opts.maxPages && isFinite(opts.maxPages) ? Math.max(1, Math.floor(opts.maxPages)) : 20
    var offset = 0
    var pages = 0
    var out = []

    function next() {
      if (pages >= maxPages) {
        success(out)
        return
      }
      pages++
      request(info, { path: 'memo?limit=' + limit + '&offset=' + offset + '&rowStatus=NORMAL' }, function (data) {
        var list = extractList(data)
        out = out.concat(list)
        if (list.length < limit) {
          success(out)
          return
        }
        offset += list.length
        next()
      }, fail)
    }
    next()
  }

  function listAll(info, options, callback, fail) {
    var opts = options || {}
    var era = eraOf(info)
    var limit = opts.pageSize && isFinite(opts.pageSize) ? Math.max(1, Math.floor(opts.pageSize)) : 1000
    var maxPages = opts.maxPages && isFinite(opts.maxPages) ? Math.max(1, Math.floor(opts.maxPages)) : 20

    if (era === ERA_LEGACY) {
      listLegacyPages(info, opts, callback, fail)
      return
    }

    pickListPath(info, limit, function (path) {
      if (!path) {
        // Undetected pre-0.22 install: no plural collection at all.
        listLegacyPages(info, opts, callback, fail)
        return
      }
      var out = []
      var pages = 0
      var token = ''

      function next() {
        if (pages >= maxPages) {
          callback(out)
          return
        }
        pages++
        fetchPage(info, path, token, function (list, nextToken) {
          out = out.concat(list)
          if (!nextToken || list.length === 0) {
            callback(out)
            return
          }
          token = nextToken
          next()
        }, fail)
      }
      next()
    }, fail)
  }

  function listMemos(info, options, success, fail) {
    listAll(info, Object.assign({ maxPages: 1 }, options || {}), success, fail)
  }

  function createMemo(info, params, success, fail) {
    var payload = params || {}
    var visibility = typeof payload.visibility === 'string' ? payload.visibility : ''
    var era = eraOf(info)

    function createLegacy() {
      var legacyBody = {
        content: payload.content,
        resourceIdList: (payload.resourceIdList || []).map(function (item) {
          var id = item && item.id != null ? item.id : item
          return id != null && !isNaN(Number(id)) ? Math.floor(Number(id)) : null
        }).filter(function (v) { return v != null })
      }
      if (visibility) legacyBody.visibility = visibility
      request(info, { path: 'memo', method: 'POST', body: legacyBody }, function (data) {
        var entity = data && data.memo ? data.memo : data
        success(entity)
      }, fail)
    }

    if (era === ERA_LEGACY) {
      createLegacy()
      return
    }

    var body = { content: payload.content }
    if (visibility) body.visibility = visibility
    if (payload.space) body.space = payload.space

    request(info, { path: 'memos', method: 'POST', body: body }, function (data) {
      var created = data && data.memo ? data.memo : data
      var ref = memoRef(created)
      if (!ref) {
        success(created)
        return
      }
      var items = payload.resourceIdList || []
      function finish() {
        getMemo(info, ref, success, function () {
          success(created)
        })
      }
      linkAttachments(info, ref, items, finish, function () {
        // A failed link must not hide a successfully created memo.
        finish()
      })
    }, function (err) {
      // Undetected legacy install: retry with the singular endpoint.
      if (era === ERA_UNKNOWN && (err.status === 404 || err.status === 405 || err.status === 200)) {
        createLegacy()
        return
      }
      if (fail) fail(err)
    })
  }

  function linkAttachments(info, ref, items, success, fail) {
    var list = Array.isArray(items) ? items.filter(function (x) { return x && x.name }) : []
    if (!list.length) {
      success()
      return
    }
    var isAttachment = list[0].name.indexOf('attachments/') === 0
    var field = isAttachment ? 'attachments' : 'resources'
    var names = list.map(function (x) { return { name: x.name } })

    var attempts = [
      { method: 'PATCH', path: ref + '?updateMask=' + field, body: (function () {
        var b = { name: ref }
        b[field] = names
        return b
      })() },
      { path: ref + '/' + field, method: 'PATCH', body: (function () {
        var b = { name: ref }
        b[field] = names
        return b
      })() },
      { path: ref, method: 'PATCH', body: (function () {
        var b = { name: ref }
        b[field] = names
        return b
      })() }
    ]
    var index = 0
    function next() {
      if (index >= attempts.length) {
        if (fail) fail({ kind: 'client', status: 400, code: null, message: 'link attachments failed', hint: 'attachment' })
        return
      }
      var attempt = attempts[index++]
      request(info, { path: attempt.path, method: 'PATCH', body: attempt.body }, function () {
        // Some builds accept the request but silently ignore the field (0.22
        // answers 200 for updateMask=resources without linking anything).
        getMemo(info, ref, function (memo) {
          var linked = (memo && (memo.attachments || memo.resources || memo.resourceList)) || []
          if (linked.length >= list.length) success()
          else next()
        }, function () {
          next()
        })
      }, function (err) {
        if (err.status === 400 || err.status === 404 || err.status === 405) {
          next()
          return
        }
        if (fail) fail(err)
      })
    }
    next()
  }

  function getMemo(info, ref, success, fail) {
    var era = eraOf(info)
    var target = String(ref == null ? '' : ref)
    if (era === ERA_LEGACY) {
      if (target.indexOf('memo/') === 0) target = target.slice('memo/'.length)
      var loadLegacy = function (id) {
        request(info, { path: 'memo/' + enc(id) }, function (data) {
          var entity = data && data.memo ? data.memo : data
          success(entity)
        }, fail)
      }
      if (/^\d+$/.test(target)) {
        loadLegacy(target)
        return
      }
      // 0.18-0.21 callers may hold a bare uid: resolve it to the numeric id.
      listAll(info, { pageSize: 1000, maxPages: 5 }, function (memos) {
        var hit = (memos || []).filter(function (memo) {
          return memo && (memo.name === target || memo.uid === target)
        })[0]
        var id = memoNumericId(hit)
        if (id == null) {
          if (fail) fail({ kind: 'notfound', status: 404, code: null, message: 'memo not found: ' + target, hint: 'memo' })
          return
        }
        loadLegacy(id)
      }, fail)
      return
    }
    // Callers sometimes hold only the uid (e.g. links built from a random
    // memo); 0.22+ expects the full resource name.
    if (target && target.indexOf('/') === -1) target = 'memos/' + target
    request(info, { path: target }, function (data) {
      var entity = data && data.memo ? data.memo : data
      success(entity)
    }, function (err) {
      if (era === ERA_UNKNOWN && (err.status === 404 || err.status === 400 || err.status === 200)) {
        var id = target.split('/').pop()
        request(info, { path: 'memo/' + enc(id) }, function (data) {
          var entity = data && data.memo ? data.memo : data
          success(entity)
        }, fail)
        return
      }
      if (fail) fail(err)
    })
  }

  function archiveMemo(info, memo, success, fail) {
    var era = eraOf(info)
    if (era === ERA_LEGACY) {
      var id = memoNumericId(memo)
      if (id == null) {
        if (fail) fail({ kind: 'client', status: 400, code: null, message: 'memo id missing', hint: 'memo' })
        return
      }
      request(info, { path: 'memo/' + id, method: 'PATCH', body: { rowStatus: 'ARCHIVED' } }, success, fail)
      return
    }
    var ref = memoRef(memo)
    // 0.23 renamed row_status to state; keep both masks so either build works.
    var attempts = [
      { path: ref + '?updateMask=state', body: { name: ref, state: 'ARCHIVED' } },
      { path: ref + '?updateMask=row_status', body: { name: ref, rowStatus: 'ARCHIVED' } },
      { path: ref + '?updateMask=rowStatus', body: { name: ref, rowStatus: 'ARCHIVED' } }
    ]
    var index = 0
    function next() {
      if (index >= attempts.length) {
        var legacyId = memoNumericId(memo)
        if (era === ERA_UNKNOWN && legacyId != null) {
          request(info, { path: 'memo/' + legacyId, method: 'PATCH', body: { rowStatus: 'ARCHIVED' } }, success, fail)
          return
        }
        if (fail) fail({ kind: 'client', status: 400, code: null, message: 'archive failed', hint: 'memo' })
        return
      }
      var attempt = attempts[index++]
      request(info, { path: attempt.path, method: 'PATCH', body: attempt.body }, success, function (err) {
        if (err.status === 400 || err.status === 404) {
          next()
          return
        }
        if (fail) fail(err)
      })
    }
    next()
  }

  function deleteResource(info, item, success, fail) {
    var era = eraOf(info)
    if (era === ERA_LEGACY) {
      var id = item && item.id != null ? item.id : null
      if (id == null && item && item.name) {
        var tail = String(item.name).split('/').pop()
        if (/^\d+$/.test(tail)) id = Number(tail)
      }
      if (id == null) {
        if (fail) fail({ kind: 'client', status: 400, code: null, message: 'resource id missing', hint: 'attachment' })
        return
      }
      request(info, { path: 'resource/' + Math.floor(Number(id)), method: 'DELETE' }, success, fail)
      return
    }
    var name = item && item.name ? item.name : ''
    if (!name) {
      if (fail) fail({ kind: 'client', status: 400, code: null, message: 'resource name missing', hint: 'attachment' })
      return
    }
    request(info, { path: name, method: 'DELETE' }, success, function (err) {
      var id = item && item.id != null ? item.id : null
      if (era === ERA_UNKNOWN && id != null && (err.status === 404 || err.status === 405 || err.status === 200)) {
        request(info, { path: 'resource/' + Math.floor(Number(id)), method: 'DELETE' }, success, fail)
        return
      }
      if (fail) fail(err)
    })
  }

  function timestampedFilename(file) {
    var source = String(file && file.name ? file.name : 'upload')
    var dot = source.lastIndexOf('.')
    var base = dot > 0 ? source.slice(0, dot) : source
    var ext = dot > 0 ? source.slice(dot) : ''
    var now = global.dayjs ? global.dayjs().format('YYYYMMDDHHmmss') : String(Date.now())
    return base + '_' + now + ext
  }

  function uploadFile(info, file, options, success, fail) {
    var era = eraOf(info)
    var filename = timestampedFilename(file)

    if (era === ERA_LEGACY) {
      var form = new global.FormData()
      form.append('file', file, filename)
      request(info, { path: 'resource/blob', method: 'POST', form: form }, function (data) {
        var entity = data && data.resource ? data.resource : data
        success(normalizeResource(entity, filename))
      }, fail)
      return
    }

    readFileAsDataUrl(file, function (base64) {
      var payload = { content: base64, filename: filename, type: file && file.type ? file.type : '' }

      function uploadLegacyBlob() {
        var form = new global.FormData()
        form.append('file', file, filename)
        request(info, { path: 'resource/blob', method: 'POST', form: form }, function (data) {
          var entity = data && data.resource ? data.resource : data
          success(normalizeResource(entity, filename))
        }, fail)
      }

      function uploadResources() {
        request(info, { path: 'resources', method: 'POST', body: payload }, function (data) {
          success(normalizeResource(data && data.resource ? data.resource : data, filename))
        }, function (err) {
          // Undetected legacy install: 0.15-0.21 only offer multipart blob upload.
          if (era === ERA_UNKNOWN && (err.status === 404 || err.status === 405 || err.status === 200)) {
            uploadLegacyBlob()
            return
          }
          if (fail) fail(err)
        })
      }

      // 0.25+ has /attachments; 0.22-0.24 only /resources. Probing is cheaper
      // and more reliable than guessing from a version string that some
      // releases (0.23-0.25) do not expose at all.
      request(info, { path: 'attachments', method: 'POST', body: payload }, function (data) {
        var entity = data && data.attachment ? data.attachment : data
        success(normalizeResource(entity, filename))
      }, function (err) {
        // 0.22-0.24 have no attachment service; some builds answer unknown
        // routes with the SPA (HTTP 200 HTML) instead of 404, so fall back on
        // any non-auth failure.
        if (err.kind !== 'auth' && err.kind !== 'forbidden') {
          uploadResources()
          return
        }
        if (fail) fail(err)
      })
    }, fail)
  }

  // ------------------------------------------------------- read-only features

  function searchMemos(info, pattern, success, fail) {
    var needle = String(pattern == null ? '' : pattern).toLowerCase()
    listAll(info, {}, function (memos) {
      if (!needle) {
        success(memos)
        return
      }
      success(memos.filter(function (memo) {
        return String(memo && memo.content ? memo.content : '').toLowerCase().indexOf(needle) !== -1
      }))
    }, fail)
  }

  function collectTags(memos) {
    var seen = Object.create(null)
    var out = []
    ;(memos || []).forEach(function (memo) {
      extractTagsFromMemo(memo).forEach(function (tag) {
        var value = String(tag || '').replace(/^#/, '').trim()
        if (!value || seen[value]) return
        seen[value] = true
        out.push(value)
      })
    })
    return out
  }

  function listTags(info, success, fail) {
    listAll(info, {}, function (memos) {
      success(collectTags(memos))
    }, fail)
  }

  function listRandomMemos(info, success, fail) {
    listAll(info, {}, function (memos) {
      success(memos)
    }, fail)
  }

  // ---------------------------------------------------------------- public API

  function resolve(info) {
    var era = eraOf(info)
    return {
      era: era,
      flavor: flavorOf(era),
      version: info && info.apiVersion ? info.apiVersion : '',
      needsAuthenticatedImagePreview: function () {
        return true
      },
      listMemos: function (options, success, fail) {
        listMemos(info, options, success, fail)
      },
      listAllMemos: function (options, success, fail) {
        listAll(info, options || {}, success, fail)
      },
      listTags: function (success, fail) {
        listTags(info, success, fail)
      },
      searchMemos: function (pattern, success, fail) {
        searchMemos(info, pattern, success, fail)
      },
      listRandomMemos: function (success, fail) {
        listRandomMemos(info, success, fail)
      },
      createMemo: function (params, success, fail) {
        createMemo(info, params, success, fail)
      },
      getMemo: function (ref, success, fail) {
        getMemo(info, ref, success, fail)
      },
      archiveMemo: function (memo, success, fail) {
        archiveMemo(info, memo, success, fail)
      },
      deleteResource: function (item, success, fail) {
        deleteResource(info, item, success, fail)
      },
      uploadFile: function (file, options, success, fail) {
        uploadFile(info, file, options, success, fail)
      }
    }
  }

  // Backwards-compatible probe used by the settings panel.
  function probeFlavor(apiUrl, tokens, callback) {
    detect(apiUrl, tokens, function (err, result) {
      if (err) {
        if (callback) callback({ flavor: 'unknown', error: err })
        return
      }
      if (callback) callback({ flavor: result.flavor, version: result.version, base: result.base, era: result.era })
    })
  }

  global.MemosApiAdapter = {
    ERAS: { LEGACY: ERA_LEGACY, V1_FILTER: ERA_V1_FILTER, V1_MODERN: ERA_V1_MODERN, V2: ERA_V2, UNKNOWN: ERA_UNKNOWN },
    KNOWN_ERAS: KNOWN_ERAS.slice(),
    KNOWN_FLAVORS: KNOWN_FLAVORS.slice(),
    FLAVOR_V020_V021: FLAVOR_V020_V021,
    parseVersion: parseVersion,
    eraOfVersion: eraOfVersion,
    eraOf: eraOf,
    flavorOf: flavorOf,
    getFlavor: eraOf,
    normalizeDetectedFlavor: function (flavor) {
      var value = typeof flavor === 'string' ? flavor : ''
      if (value === 'v020' || value === 'v021' || value === 'v1') return FLAVOR_V020_V021
      return value
    },
    detect: detect,
    authenticate: authenticate,
    probeFlavor: probeFlavor,
    resolve: resolve,
    errorInfo: errorInfo,
    memoRef: memoRef,
    memoUid: memoUid,
    memoNumericId: memoNumericId,
    memoState: memoState,
    extractTags: extractTagsFromMemo,
    normalizeResource: normalizeResource,
    extractList: extractList
  }
})(window)
