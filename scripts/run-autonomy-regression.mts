import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { resolve } from 'node:path'
import { autonomyScenarioSchema } from './lib/autonomy-regression.mts'

const args = process.argv.slice(2)
const ui = args.includes('--ui')
const forwardedArgs = args.filter((arg) => arg !== '--ui')
const scenario = resolve(
  process.env['COPSE_EVAL_SCENARIO'] ?? 'tests/e2e/scenarios/autonomy-regression.json',
)

if (ui) {
  const result = spawnSync('npm', ['run', 'test:e2e:agent-eval', '--', ...forwardedArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      COPSE_EVAL_SCENARIO: scenario,
    },
  })
  process.exit(result.status ?? 1)
}

const out =
  process.env['COPSE_EVAL_BUNDLE_PATH'] ?? resolve('dist-test/copse-autonomy-regression-agent.cjs')
await esbuild.build({
  entryPoints: [resolve('scripts/autonomy-regression-agent.mts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['@anthropic-ai/sandbox-runtime', 'node-pty'],
  alias: {
    '@shared': resolve('./src/shared'),
    '@copse/agent': resolve('./packages/agent/src'),
    '@copse/llm': resolve('./packages/llm/src'),
    '@copse/plan-usage': resolve('./packages/plan-usage/src'),
  },
  define: { __COPSE_TEST_DIRECTIVES__: 'true' },
})

const parsedScenario = autonomyScenarioSchema.parse(
  JSON.parse(readFileSync(scenario, 'utf8')) as unknown,
)
const selectedVariant = process.env['COPSE_EVAL_PROMPT_VARIANT']
const variantIndexes =
  selectedVariant === undefined
    ? parsedScenario.promptVariants.map((_, index) => String(index))
    : [selectedVariant]
let exitCode = 0

for (const variantIndex of variantIndexes) {
  const result = spawnSync('node', [out, ...forwardedArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: {
      ...process.env,
      COPSE_EVAL_SCENARIO: scenario,
      COPSE_EVAL_PROMPT_VARIANT: variantIndex,
      NODE_PATH: [
        resolve('node_modules'),
        ...(process.env['NODE_PATH'] ? [process.env['NODE_PATH']] : []),
      ].join(delimiter),
    },
  })
  if (result.status !== 0) exitCode = result.status ?? 1
}

process.exit(exitCode)
