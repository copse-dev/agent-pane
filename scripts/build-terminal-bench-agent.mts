import * as esbuild from 'esbuild'
import { resolve } from 'node:path'

export async function buildTerminalBenchAgentBundle(
  outfile = resolve('dist-test/terminal-bench-agent.cjs'),
): Promise<string> {
  await esbuild.build({
    entryPoints: [resolve('scripts/terminal-bench-agent-entry.mts')],
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

if (process.argv[1]?.endsWith('build-terminal-bench-agent.mts')) {
  const outfile = process.argv[2] ? resolve(process.argv[2]) : undefined
  const built = await buildTerminalBenchAgentBundle(outfile)
  console.log(`bench:terminal bundle=${built}`)
}
