// Bundle + run the background-question eval. It drives the product's own
// classify functions and prompt builders, so main-process modules come along.
// Nothing here calls into Electron, and the packages the unit-test bundle keeps
// external (native bindings, ESM-only assets) stay external here too.
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const output = resolve('dist-test/background-question-eval-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/background-question-eval-lib.mts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: {
    '@shared': resolve('./src/shared'),
  },
  external: [
    '@lmstudio/sdk',
    '@anthropic-ai/sandbox-runtime',
    '@mozilla/readability',
    'electron',
    'esbuild',
    'jsdom',
    'mermaid',
    'node-pty',
    'oxfmt',
    'turndown',
    'typescript',
  ],
})

const result = spawnSync('node', [output, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
