import { AsyncLocalStorage } from 'node:async_hooks'
import type { ModelUsage, StreamChunk } from '@shared/types'
import { runExploreSubagent, type RunExploreSubagentOptions } from './subagent-service.ts'
import type { LLMProvider } from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { addSubagentUsage } from './subagent-usage.ts'
import {
  exploreFallbackNotice,
  toolCircuitBreaker,
  type ToolCircuitBreaker,
} from './tool-circuit-breaker.ts'

/** Where one explore run executes: a provider plus its budget and ledger id. */
export interface ExploreTarget {
  provider: LLMProvider
  contextWindow: number
  toolSchemaReserve: number
  usageModel: string
}

/**
 * Exploration was routed to a task-role model other than the parent's. If
 * that model fails unrecoverably (LM Studio not running, sign-in needed), the
 * thread's breaker opens on `selection` and the call is re-run on `fallback`
 * — the parent model, as when local routing is unavailable at turn start.
 */
export interface ExploreRoute {
  threadId: string
  /** The role selection that chose the routed model (the breaker's key). */
  selection: string
  /** Whether the routed model runs on a local server. */
  localServer: boolean
  fallback: ExploreTarget
}

export interface ExploreSubagentRunnerContext {
  parentToolCallId: string
  parentGoal: string
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  onChunk: (chunk: StreamChunk) => void
  usageModel: string
  /** Local subagent routing was requested but unavailable; run uses the cloud model. */
  localFallback?: boolean
  /** Set when `provider` is a routed task-role model rather than the parent's. */
  route?: ExploreRoute
}

export type ExploreSubagentRunner = (opts: {
  query: string
  paths?: string[] | undefined
  signal: AbortSignal
}) => Promise<{ summary: string; text: string; usage: ModelUsage }>

/**
 * Context travels via AsyncLocalStorage, not a module-global slot: the parent
 * loop runs several `explore` tool calls concurrently (see
 * `startLeadingParallelExplores`), and a single slot would hand one call's
 * parentToolCallId/provider to a sibling. Each `runWithExploreSubagentContext`
 * scope sees only its own context.
 */
const contextStorage = new AsyncLocalStorage<ExploreSubagentRunnerContext>()

export function runWithExploreSubagentContext<T>(
  ctx: ExploreSubagentRunnerContext,
  fn: () => Promise<T>,
): Promise<T> {
  return contextStorage.run(ctx, fn)
}

export interface ExploreSubagentRunnerDeps {
  run: typeof runExploreSubagent
  breaker: ToolCircuitBreaker
  addUsage: typeof addSubagentUsage
}

const DEFAULT_DEPS: ExploreSubagentRunnerDeps = {
  run: runExploreSubagent,
  breaker: toolCircuitBreaker,
  addUsage: addSubagentUsage,
}

export function getExploreSubagentRunner(): ExploreSubagentRunner | null {
  const ctx = contextStorage.getStore()
  return ctx ? createExploreSubagentRunner(ctx) : null
}

/** The runner for one `explore` call's context (exported for unit tests). */
export function createExploreSubagentRunner(
  ctx: ExploreSubagentRunnerContext,
  deps: ExploreSubagentRunnerDeps = DEFAULT_DEPS,
): ExploreSubagentRunner {
  return async ({ query, paths, signal }) => {
    const options = (
      target: ExploreTarget,
      localFallback?: boolean,
    ): RunExploreSubagentOptions => ({
      parentToolCallId: ctx.parentToolCallId,
      query,
      ...(paths !== undefined ? { paths } : {}),
      parentGoal: ctx.parentGoal,
      provider: target.provider,
      registry: ctx.registry,
      contextWindow: target.contextWindow,
      toolSchemaReserve: target.toolSchemaReserve,
      signal,
      onChunk: ctx.onChunk,
      usageModel: target.usageModel,
      ...(localFallback !== undefined ? { localFallback } : {}),
    })
    const result = await deps.run(options(ctx, ctx.localFallback))
    deps.addUsage(ctx.usageModel, result.usage)
    const { route } = ctx
    if (result.error === undefined || !route || signal.aborted) return result
    const trip = deps.breaker.record(route.threadId, 'explore', {
      selection: route.selection,
      model: ctx.usageModel,
      localServer: route.localServer,
      error: new Error(result.error),
    })
    if (!trip) return result
    // The routed model will not recover in this thread: answer this call from
    // the parent model now (the card is replaced and marked as a fallback), and
    // the turn builder skips the route for the rest of the thread.
    const retried = await deps.run(options(route.fallback, true))
    deps.addUsage(route.fallback.usageModel, retried.usage)
    const notice = exploreFallbackNotice(trip)
    return {
      summary: `${notice}\n\n${retried.summary}`,
      text: `${notice}\n\n${retried.text}`,
      usage: {
        inputTokens: result.usage.inputTokens + retried.usage.inputTokens,
        outputTokens: result.usage.outputTokens + retried.usage.outputTokens,
      },
    }
  }
}
