import { AsyncLocalStorage } from 'node:async_hooks'
import type { LLMMessage, StreamChunk } from '@shared/types'

/**
 * Context needed by the client-side advisor tool for one executor call.
 * Async-local storage keeps simultaneous native and bridged calls isolated:
 * a process-global mutable slot can leak one thread's transcript into another.
 */
export interface AdvisorRunnerContext {
  advisorModel: string
  executorModel: string
  getTranscript: () => LLMMessage[]
  /** Emits the advisor's dedicated usage line on the run's chunk stream (#566). */
  onChunk: (chunk: StreamChunk) => void
}

const advisorContext = new AsyncLocalStorage<AdvisorRunnerContext>()

export function runWithAdvisorContext<T>(context: AdvisorRunnerContext, run: () => T): T {
  return advisorContext.run(context, run)
}

export function getAdvisorContext(): AdvisorRunnerContext | null {
  return advisorContext.getStore() ?? null
}
