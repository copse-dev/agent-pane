import { AsyncLocalStorage } from 'node:async_hooks'
import {
  readFileLimitsFromConversationBudget,
  READ_FILE_LIMITS_CEILING,
  type ReadFileLimits,
} from '@copse/agent/read-file-limits.ts'

const store = new AsyncLocalStorage<ReadFileLimits>()

export function runWithAgentRunReadFileLimits<T>(limits: ReadFileLimits, fn: () => T): T {
  return store.run(limits, fn)
}

export function getAgentRunReadFileLimits(): ReadFileLimits {
  return store.getStore() ?? READ_FILE_LIMITS_CEILING
}

export { readFileLimitsFromConversationBudget }
