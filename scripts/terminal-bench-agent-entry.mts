import { flushAndExit } from './terminal-bench-agent-exit.mts'
import { runTerminalBenchAgent } from './terminal-bench-agent-lib.mts'

runTerminalBenchAgent().then(
  () => {
    // The `result` message is already written. Do not wait for provider handles to drain.
    flushAndExit(0)
  },
  (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`${detail}\n`)
    process.exit(1)
  },
)
