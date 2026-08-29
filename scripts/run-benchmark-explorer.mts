#!/usr/bin/env node
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const output = resolve('dist/scripts/benchmark-explorer.mjs')
await mkdir(dirname(output), { recursive: true })
await build({
  entryPoints: [resolve('scripts/benchmark-explorer.mts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
})
await import(`${pathToFileURL(output).href}?built=${String(Date.now())}`)
