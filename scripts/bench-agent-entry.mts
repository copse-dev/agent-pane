// Invocation entry for the headless bench harness. Kept separate from
// bench-agent-lib.mts (which only exports) so the lib can be imported by unit
// tests without triggering a benchmark run — mirroring the
// terminal-bench-agent-entry.mts / terminal-bench-agent-lib.mts split.
import { runBench } from './bench-agent-lib.mts'

runBench().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
