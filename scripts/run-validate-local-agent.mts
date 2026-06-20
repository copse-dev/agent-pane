import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const out = resolve('dist-test/validate-local-agent-lib.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/validate-local-agent-lib.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  alias: { '@shared': resolve('./src/shared') },
})

const result = spawnSync('node', [out], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    COPSE_PANEL_MOCK_LLM: '',
  },
})
process.exit(result.status ?? 1)
