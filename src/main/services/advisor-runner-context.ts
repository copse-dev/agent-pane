import { AsyncLocalStorage } from 'node:async_hooks'
import type { LLMMessage } from '@shared/types'

/**
 * Context needed by the client-side advisor tool for one executor call.
 * Async-local storage keeps simultaneous native and bridged calls isolated:
 * a process-global mutable slot can leak one thread's transcript into another.
 */
export interface AdvisorRunnerContext {
  advisorModel: string
  executorModel: string
  getTranscript: () => LLMMessage[]
}

const advisorContext = new AsyncLocalStorage<AdvisorRunnerContext>()

export function runWithAdvisorContext<T>(context: AdvisorRunnerContext, run: () => T): T {
  return advisorContext.run(context, run)
}

export function getAdvisorContext(): AdvisorRunnerContext | null {
  return advisorContext.getStore() ?? null
}
