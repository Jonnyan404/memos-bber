#!/usr/bin/env node
/**
 * Single source of truth for the extension version.
 *
 * VERSION at the repo root is authoritative; the three manifests are generated
 * from it. `node tools/set-version.mjs 2026.11.01` bumps everything at once.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_FILE = path.join(ROOT, 'VERSION')
const MANIFESTS = ['chrome/manifest.json', 'firefox/manifest.json', 'edge/manifest.json']

const argVersion = process.argv[2]
const version = String(argVersion || fs.readFileSync(VERSION_FILE, 'utf8')).trim()

if (!/^\d+(\.\d+){1,3}$/.test(version)) {
  console.error(`invalid version: ${version} (expected 1-4 dot-separated numbers)`)
  process.exit(2)
}

fs.writeFileSync(VERSION_FILE, version + '\n')
for (const rel of MANIFESTS) {
  const file = path.join(ROOT, rel)
  const text = fs.readFileSync(file, 'utf8')
  const next = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
  if (next === text && !text.includes(`"version": "${version}"`)) {
    console.error(`could not update ${rel}`)
    process.exit(1)
  }
  fs.writeFileSync(file, next)
  console.log(`${rel}: ${version}`)
}
