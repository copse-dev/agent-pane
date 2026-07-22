import { runSkillsBenchAgent } from './skillsbench-agent-lib.mts'

runSkillsBenchAgent().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(`${detail}\n`)
  process.exit(1)
})
