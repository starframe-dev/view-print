import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// src/version.ts reads ../package.json relative to dist/src, so the metadata must sit in dist/.
copyFileSync(`${root}package.json`, `${root}dist/package.json`)
