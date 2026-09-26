// Bundle + run the thread-title eval so workspace aliases and native TypeScript
// behave consistently with the other model-backed eval launchers.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const output = resolve('dist-test/thread-title-eval-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/thread-title-eval-lib.mts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: {
    '@shared': resolve('./src/shared'),
  },
  external: ['@lmstudio/sdk'],
})

const result = spawnSync('node', [output, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
