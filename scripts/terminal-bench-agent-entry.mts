import { runTerminalBenchAgent } from './terminal-bench-agent-lib.mts'

runTerminalBenchAgent().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`${detail}\n`)
  process.exit(1)
})
