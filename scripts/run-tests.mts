import * as esbuild from 'esbuild'
import { glob } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const testFiles: string[] = []
for await (const f of glob('src/**/*.test.ts')) testFiles.push(f)
await esbuild.build({
  entryPoints: testFiles,
  outdir: 'dist-test',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  alias: { '@shared': resolve('./src/shared') },
})
const result = spawnSync('node', ['--test', 'dist-test/**/*.test.js'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
