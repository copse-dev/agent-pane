import * as esbuild from 'esbuild'
import { resolve } from 'node:path'

export async function buildSkillsBenchAgentBundle(
  outfile = resolve('dist-test/skillsbench-agent.cjs'),
): Promise<string> {
  await esbuild.build({
    entryPoints: [resolve('scripts/skillsbench-agent-entry.mts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    alias: {
      '@shared': resolve('./src/shared'),
      '@copse/agent': resolve('./packages/agent/src'),
      '@copse/llm': resolve('./packages/llm/src'),
      '@copse/plan-usage': resolve('./packages/plan-usage/src'),
    },
    define: { __COPSE_TEST_DIRECTIVES__: 'false' },
  })
  return outfile
}

if (process.argv[1]?.endsWith('build-skillsbench-agent.mts')) {
  const outfile = process.argv[2] ? resolve(process.argv[2]) : undefined
  const built = await buildSkillsBenchAgentBundle(outfile)
  console.log(`bench:skills bundle=${built}`)
}
