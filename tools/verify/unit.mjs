#!/usr/bin/env node
/**
 * Unit checks for the adapter's pure helpers (no Docker, no browser).
 * Kept dependency-free so it runs in the bundle CI job.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ctx = { window: {}, console, Date, JSON, Math, isFinite, isNaN, encodeURIComponent, Promise }
ctx.window = ctx
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/js/compat/memosApi.js'), 'utf8'), ctx)
const A = ctx.MemosApiAdapter

let failures = 0
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`)
  if (!ok) failures++
}

const v = (raw) => A.parseVersion(raw)
eq('parse 0.15.0', [v('0.15.0').major, v('0.15.0').minor, v('0.15.0').patch], [0, 15, 0])
eq('parse v0.31.0 tag', [v('v0.31.0').major, v('v0.31.0').minor], [0, 31])
eq('parse 26.10-rc.1', [v('26.10-rc.1').major, v('26.10-rc.1').minor], [26, 10])
eq('parse garbage', v('build-abc'), null)

eq('era 0.15', A.eraOfVersion(v('0.15.0')), 'legacy')
eq('era 0.21', A.eraOfVersion(v('0.21.0')), 'legacy')
eq('era 0.22', A.eraOfVersion(v('0.22.3')), 'v1-filter')
eq('era 0.23', A.eraOfVersion(v('0.23.1')), 'v1-filter')
eq('era 0.24', A.eraOfVersion(v('0.24.0')), 'v1-modern')
eq('era 0.31', A.eraOfVersion(v('0.31.0')), 'v1-modern')
eq('era 26.10', A.eraOfVersion(v('26.10-rc.1')), 'v2')
eq('flavor legacy', A.flavorOf('legacy'), 'v020-v021')
eq('flavor v1-filter', A.flavorOf('v1-filter'), 'v023')
eq('flavor v2', A.flavorOf('v2'), 'modern')

eq('memoRef numeric only', A.memoRef({ id: 7 }), 'memo/7')
eq('memoRef modern name', A.memoRef({ name: 'memos/abc', uid: 'abc' }), 'memos/abc')
eq('memoRef legacy bare uid', A.memoRef({ id: 3, name: 'bareUid' }), 'memo/3')
eq('memoRef uid only', A.memoRef({ uid: 'abc' }), 'memos/abc')
eq('memoRef numeric name', A.memoNumericId({ name: 'memos/12' }), 12)
eq('memoNumericId uid name', A.memoNumericId({ name: 'memos/abc' }), null)

const err = (status, body) => A.errorInfo({ status, responseJSON: body, statusText: '' })
eq('error 403 public', err(403, { code: 7, message: 'disable public memos system setting is enabled' }).hint, 'publicForbidden')
eq('error 410', err(410, { code: 12, message: 'API v1 has been removed' }).hint, 'apiRemoved')
eq('error 401', err(401, { message: 'authentication required' }).hint, 'auth')
eq('error 0', err(0, null).kind, 'network')
eq('error 500', err(500, { message: 'boom' }).kind, 'server')

eq(
  'tags from property',
  A.extractTags({ content: 'x', property: { tags: ['a', 'b'] } }),
  ['a', 'b']
)
eq('tags from content', A.extractTags({ content: 'hi #tag1 #tag2!' }), ['tag1', 'tag2'])
eq(
  'normalize attachment',
  (() => {
    const r = A.normalizeResource({ attachment: { name: 'attachments/u1', filename: 'a.png', type: 'image/png' } })
    return [r.name, r.filename, r.type]
  })(),
  ['attachments/u1', 'a.png', 'image/png']
)
eq(
  'normalize legacy resource',
  (() => {
    const r = A.normalizeResource({ id: 5, filename: 'b.png' })
    return [r.id, r.name]
  })(),
  [5, 'resources/5']
)

console.log(`\n${failures === 0 ? 'all unit checks passed' : failures + ' unit checks failed'}`)
process.exit(failures === 0 ? 0 : 1)
