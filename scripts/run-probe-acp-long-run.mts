import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const userDataFilesShim = resolve('src/main/services/storage/user-data-files.test-shim.ts')

const out = resolve('dist-test/probe-acp-long-run-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/probe-acp-long-run-lib.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  alias: { '@shared': resolve('./src/shared') },
  plugins: [
    {
      name: 'main-services-cli-shims',
      setup(build): void {
        build.onResolve({ filter: /\/user-data-files\.ts$/ }, (args) => {
          if (!args.path.includes('user-data-files.test-shim')) return { path: userDataFilesShim }
          return undefined
        })
      },
    },
  ],
})

const result = spawnSync('node', [out, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
