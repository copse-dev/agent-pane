import * as esbuild from 'esbuild'
import { glob } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const settingsShim = resolve('src/main/services/settings.test-shim.ts')
const storageShim = resolve('src/main/services/storage.test-shim.ts')

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
  plugins: [
    {
      name: 'main-services-test-shims',
      setup(build) {
        build.onResolve({ filter: /\/settings\.ts$/ }, (args) => {
          if (!args.path.includes('settings.test-shim')) return { path: settingsShim }
        })
        build.onResolve({ filter: /\/storage\.ts$/ }, (args) => {
          if (!args.path.includes('storage.test-shim')) return { path: storageShim }
        })
      },
    },
  ],
})
const result = spawnSync('node', ['--test', 'dist-test/**/*.test.js'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
