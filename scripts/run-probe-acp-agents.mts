import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const settingsShim = resolve('src/main/services/storage/settings.test-shim.ts')
const storageShim = resolve('src/main/services/storage/storage.test-shim.ts')

// Bundle the Tier-1 ACP capability-probe runner (which imports app modules that
// use the `@shared` alias and `.ts` extensions) into a single CJS file, then
// run it. Mirrors run-validate-local-agent.mts. Provider keys are left in the
// env: the probe sends no prompt, but some adapters need auth to complete
// `initialize`, and the agent brings its own credentials.
const out = resolve('dist-test/probe-acp-agents-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/probe-acp-agents-lib.mts')],
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
        build.onResolve({ filter: /\/settings\.ts$/ }, (args) => {
          if (!args.path.includes('settings.test-shim')) return { path: settingsShim }
          return undefined
        })
        build.onResolve({ filter: /\/storage\.ts$/ }, (args) => {
          if (!args.path.includes('storage.test-shim')) return { path: storageShim }
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
