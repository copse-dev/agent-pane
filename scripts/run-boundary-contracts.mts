import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Bundle the production-boundary contract runner (scripts/boundary-contracts.mts)
// into one CJS file, then run it. Bundling is what lets plain Node load the app
// modules the contracts call — `src/shared/*.ts` and the `@shared` alias — the
// same way run-probe-acp-agents.mts does. See docs/boundary-contracts.md.
const out = resolve('dist-test/boundary-contracts.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/boundary-contracts.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  alias: { '@shared': resolve('./src/shared') },
  // The runner finds its entrypoint by `__filename` in this bundle, so the empty
  // `import.meta` esbuild warns about is expected.
  logOverride: { 'empty-import-meta': 'silent' },
})

const result = spawnSync('node', ['--enable-source-maps', out, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})
process.exit(result.status ?? 1)
