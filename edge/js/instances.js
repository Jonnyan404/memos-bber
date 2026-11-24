/**
 * Instance storage, shared by all three bundles.
 *
 * One flat apiUrl/apiTokens pair cannot describe "home + work + a test box",
 * so connections live in a list. They are split across three places on purpose:
 *
 *   memosInstances        connection metadata for every instance (small)
 *   instanceRuntime_<id>  draft, tag filter, open_action (per instance)
 *   instanceFiles_<id>    the uploaded-but-unsent attachment entities
 *
 * chrome.storage.sync caps a single item at 8KB. Keeping the draft and the
 * attachment list inside the shared list would let one big upload fail to save
 * because another instance's metadata was in the same item, so the heavy part
 * gets its own key. Each instance therefore has the same headroom it had when
 * there was only one.
 *
 * Keys inside a connection object keep the names they had as top-level
 * settings (apiUrl, apiTokens ...), which is what lets get_info() in oper.js
 * flatten the active instance into the shape the rest of the popup expects.
 */
;(function () {
  const INSTANCES_KEY = 'memosInstances'
  const ACTIVE_KEY = 'activeInstanceId'
  const RUNTIME_PREFIX = 'instanceRuntime_'
  const FILES_PREFIX = 'instanceFiles_'

  const CONNECTION_KEYS = [
    'apiUrl',
    'apiTokens',
    'apiFlavor',
    'apiVersion',
    'apiBase',
    'userRef',
    'memoUiPath',
    'disallowPublic',
    'userid'
  ]
  const RUNTIME_KEYS = ['open_action', 'open_content', 'hidetag', 'showtag']
  const FILES_KEYS = ['resourceIdList']
  const ALL_KEYS = CONNECTION_KEYS.concat(RUNTIME_KEYS, FILES_KEYS)

  // ------------------------------------------------------------------ utils

  function syncGet(defaults) {
    return new Promise(function (resolve) {
      chrome.storage.sync.get(defaults, function (items) {
        resolve(items || {})
      })
    })
  }

  function syncSet(items) {
    return new Promise(function (resolve) {
      chrome.storage.sync.set(items, function () {
        void chrome.runtime && chrome.runtime.lastError
        resolve()
      })
    })
  }

  function syncRemove(keys) {
    return new Promise(function (resolve) {
      chrome.storage.sync.remove(keys, function () {
        void chrome.runtime && chrome.runtime.lastError
        resolve()
      })
    })
  }

  function newId() {
    return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  // "https://memos.example.com/" becomes "example": short enough for the 24px
  // chip, while the menu shows the full host underneath. IP literals and
  // localhost keep their port, because "127" or "localhost" alone says nothing
  // about which test box it is.
  function defaultName(apiUrl) {
    const raw = String(apiUrl || '')
    try {
      const url = new URL(raw)
      const host = url.hostname
      if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return url.port ? host + ':' + url.port : host
      }
      const bare = host.replace(/^(www|memos)\./, '')
      return bare.split('.')[0] || host || 'memos'
    } catch (_) {
      const stripped = raw.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
      return stripped || 'memos'
    }
  }

  function hostOf(apiUrl) {
    try {
      return new URL(String(apiUrl)).host
    } catch (_) {
      return String(apiUrl || '')
    }
  }

  function runtimeDefaults() {
    const out = {}
    RUNTIME_KEYS.forEach(function (key) {
      out[key] = ''
    })
    return out
  }

  function filesDefaults() {
    const out = {}
    FILES_KEYS.forEach(function (key) {
      out[key] = []
    })
    return out
  }

  function legacyDefaults() {
    const out = {}
    CONNECTION_KEYS.forEach(function (key) {
      out[key] = key === 'memoUiPath' ? 'memos' : ''
    })
    RUNTIME_KEYS.forEach(function (key) {
      out[key] = ''
    })
    FILES_KEYS.forEach(function (key) {
      out[key] = []
    })
    return out
  }

  function splitFields(source) {
    const connection = {}
    const runtime = {}
    const files = {}
    Object.keys(source || {}).forEach(function (key) {
      if (CONNECTION_KEYS.indexOf(key) !== -1) connection[key] = source[key]
      else if (FILES_KEYS.indexOf(key) !== -1) files[key] = source[key]
      else if (RUNTIME_KEYS.indexOf(key) !== -1) runtime[key] = source[key]
    })
    return { connection: connection, runtime: runtime, files: files }
  }

  function hasRuntimeFields(inst) {
    if (!inst) return false
    return RUNTIME_KEYS.concat(FILES_KEYS).some(function (key) {
      return inst[key] !== undefined
    })
  }

  function runtimeKey(id) {
    return RUNTIME_PREFIX + id
  }

  function filesKey(id) {
    return FILES_PREFIX + id
  }

  // ------------------------------------------------------------- migrations

  // Pre-2026.11 installs kept everything flat. Adopt the connection as the
  // first instance, keep the legacy keys in place so a downgrade still finds
  // its server, and move the runtime state to the new per-instance keys.
  async function migrateFlat(items) {
    if (!items.apiUrl && !items.apiTokens) return null
    const id = newId()
    const connection = { id: id, name: defaultName(items.apiUrl) }
    CONNECTION_KEYS.forEach(function (key) {
      if (items[key] !== undefined) connection[key] = items[key]
    })
    const parts = splitFields(items)
    await syncSet({
      [INSTANCES_KEY]: [connection],
      [ACTIVE_KEY]: id,
      [runtimeKey(id)]: Object.assign(runtimeDefaults(), parts.runtime),
      [filesKey(id)]: Object.assign(filesDefaults(), parts.files)
    })
    return connection
  }

  // An interim build stored the draft and the attachment list inside each
  // connection object. Move them out rather than leaving two homes for the
  // same value, otherwise a later save would keep writing the wrong one.
  async function splitLeftoverRuntime(list) {
    const dirty = list.filter(hasRuntimeFields)
    if (!dirty.length) return list
    const writes = {}
    const cleaned = list.map(function (inst) {
      if (!hasRuntimeFields(inst)) return inst
      const parts = splitFields(inst)
      const copy = Object.assign({}, inst)
      RUNTIME_KEYS.concat(FILES_KEYS).forEach(function (key) {
        delete copy[key]
      })
      writes[runtimeKey(inst.id)] = parts.runtime
      writes[filesKey(inst.id)] = parts.files
      return copy
    })
    // Never overwrite a key that already exists: it is newer than the copy
    // still sitting inside the connection object.
    const existing = await syncGet(Object.keys(writes))
    Object.keys(writes).forEach(function (key) {
      const isFiles = key.indexOf(FILES_PREFIX) === 0
      writes[key] = Object.assign(
        {},
        isFiles ? filesDefaults() : runtimeDefaults(),
        writes[key],
        existing[key] || {}
      )
    })
    writes[INSTANCES_KEY] = cleaned
    await syncSet(writes)
    return cleaned
  }

  // ---------------------------------------------------------------- public

  async function load() {
    const items = await syncGet(Object.assign({ [INSTANCES_KEY]: null, [ACTIVE_KEY]: '' }, legacyDefaults()))
    let list = Array.isArray(items[INSTANCES_KEY])
      ? items[INSTANCES_KEY].filter(function (inst) {
          return inst && inst.id
        })
      : []
    if (!list.length) {
      const migrated = await migrateFlat(items)
      if (!migrated) return { instances: [], activeId: '' }
      return { instances: [migrated], activeId: migrated.id }
    }
    list = await splitLeftoverRuntime(list)
    const known = list.some(function (inst) {
      return inst.id === items[ACTIVE_KEY]
    })
    const activeId = known ? items[ACTIVE_KEY] : list[0].id
    if (activeId !== items[ACTIVE_KEY]) await syncSet({ [ACTIVE_KEY]: activeId })
    return { instances: list, activeId: activeId }
  }

  function findActive(state) {
    if (!state || !Array.isArray(state.instances)) return null
    return (
      state.instances.filter(function (inst) {
        return inst.id === state.activeId
      })[0] || null
    )
  }

  async function readRuntime(id) {
    if (!id) return { runtime: runtimeDefaults(), files: filesDefaults() }
    const items = await syncGet([runtimeKey(id), filesKey(id)])
    // Defaults, not "{}": a caller reading an instance that never wrote a draft
    // must still get an empty string and an empty attachment list, otherwise
    // every read site needs its own undefined check.
    return {
      runtime: Object.assign(runtimeDefaults(), items[runtimeKey(id)] || {}),
      files: Object.assign(filesDefaults(), items[filesKey(id)] || {})
    }
  }

  // Writes to the active instance only. Callers pass the same key names they
  // used before (open_content, resourceIdList, hidetag ...); this decides which
  // of the three places each one belongs to.
  async function patch(fields) {
    const state = await load()
    const active = findActive(state)
    if (!active) return null
    const parts = splitFields(fields)
    const writes = {}
    let nextList = state.instances
    if (Object.keys(parts.connection).length) {
      nextList = state.instances.map(function (inst) {
        return inst.id === active.id ? Object.assign({}, inst, parts.connection) : inst
      })
      writes[INSTANCES_KEY] = nextList
    }
    const keys = []
    if (Object.keys(parts.runtime).length) keys.push(runtimeKey(active.id))
    if (Object.keys(parts.files).length) keys.push(filesKey(active.id))
    const existing = keys.length ? await syncGet(keys) : {}
    if (Object.keys(parts.runtime).length) {
      const key = runtimeKey(active.id)
      writes[key] = Object.assign({}, runtimeDefaults(), existing[key] || {}, parts.runtime)
    }
    if (Object.keys(parts.files).length) {
      const key = filesKey(active.id)
      writes[key] = Object.assign({}, filesDefaults(), existing[key] || {}, parts.files)
    }
    if (Object.keys(writes).length) await syncSet(writes)
    return Object.assign({}, active, fields)
  }

  // Creates the first instance, or updates one by id. A new instance becomes
  // active: pressing "add instance" and saving means "connect me to this one".
  async function upsert(id, fields) {
    const state = await load()
    const parts = splitFields(fields)
    let saved = null
    let next = state.instances
    if (id) {
      next = state.instances.map(function (inst) {
        if (inst.id !== id) return inst
        saved = Object.assign({}, inst, parts.connection)
        return saved
      })
    }
    if (!saved) {
      saved = Object.assign({ id: newId(), name: defaultName(parts.connection.apiUrl) }, parts.connection)
      next = state.instances.concat([saved])
    }
    const rtKey = runtimeKey(saved.id)
    const fsKey = filesKey(saved.id)
    const existing = await syncGet([rtKey, fsKey])
    const writes = { [INSTANCES_KEY]: next, [ACTIVE_KEY]: id ? state.activeId : saved.id }
    if (!id || Object.keys(parts.runtime).length) {
      writes[rtKey] = Object.assign({}, runtimeDefaults(), existing[rtKey] || {}, parts.runtime)
    }
    if (!id || Object.keys(parts.files).length) {
      writes[fsKey] = Object.assign({}, filesDefaults(), existing[fsKey] || {}, parts.files)
    }
    await syncSet(writes)
    return saved
  }

  async function remove(id) {
    const state = await load()
    const next = state.instances.filter(function (inst) {
      return inst.id !== id
    })
    const activeId = state.activeId === id ? (next[0] ? next[0].id : '') : state.activeId
    await syncRemove([runtimeKey(id), filesKey(id)])
    await syncSet({ [INSTANCES_KEY]: next, [ACTIVE_KEY]: activeId })
    return { instances: next, activeId: activeId }
  }

  async function setActive(id) {
    await syncSet({ [ACTIVE_KEY]: id })
  }

  // Used by get_info() and by the tests: every instance key plus the active
  // runtime, flattened the way the popup consumes it.
  async function readAll() {
    const all = await syncGet(null)
    const list = Array.isArray(all[INSTANCES_KEY])
      ? all[INSTANCES_KEY].filter(function (inst) {
          return inst && inst.id
        })
      : []
    const active =
      list.filter(function (inst) {
        return inst.id === all[ACTIVE_KEY]
      })[0] || list[0] || {}
    const runtime = Object.assign(runtimeDefaults(), active.id ? all[runtimeKey(active.id)] || {} : {})
    const files = Object.assign(filesDefaults(), active.id ? all[filesKey(active.id)] || {} : {})
    const flat = Object.assign({}, all, active, runtime, files)
    return {
      instances: list,
      activeId: all[ACTIVE_KEY] || '',
      active: active,
      runtime: runtime,
      files: files,
      flat: flat,
      raw: all
    }
  }

  window.MemosInstances = {
    KEYS: {
      instances: INSTANCES_KEY,
      active: ACTIVE_KEY,
      runtimePrefix: RUNTIME_PREFIX,
      filesPrefix: FILES_PREFIX,
      connection: CONNECTION_KEYS.slice(),
      runtime: RUNTIME_KEYS.slice(),
      files: FILES_KEYS.slice(),
      all: ALL_KEYS.slice()
    },
    newId: newId,
    defaultName: defaultName,
    hostOf: hostOf,
    runtimeKey: runtimeKey,
    filesKey: filesKey,
    runtimeDefaults: runtimeDefaults,
    filesDefaults: filesDefaults,
    load: load,
    findActive: findActive,
    readRuntime: readRuntime,
    readAll: readAll,
    patch: patch,
    upsert: upsert,
    remove: remove,
    setActive: setActive
  }
})()
