import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { getModelInfo, inferCloudModelProvider } from '@copse/llm/model-catalog.ts'
import type { LLMProvider, ProviderStreamChunk } from '@shared/types'
import type { LLMRequestEstimate, LLMRequestUsage } from '@copse/llm/wire-types.ts'
import type { ProviderDescription } from '../providers/provider-description.ts'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { storageReadFile, storageWriteFile } from '../storage/user-data-files.ts'
import { runSerialized } from '../storage/write-queue.ts'

const budgetSchema = z.strictObject({
  version: z.literal(1),
  limitMicroUsd: z.number().int().positive(),
  // Settled catalogue costs plus the maximum reservations still outstanding.
  reservedMicroUsd: z.number().int().nonnegative(),
  closed: z.literal(true).optional(),
})
type AutomationBudget = z.infer<typeof budgetSchema>
const scope = new AsyncLocalStorage<string>()

function budgetPath(projectId: string, threadId: string): string {
  return `automation-budgets/${projectId}/${threadId}.json`
}

async function readBudget(path: string): Promise<AutomationBudget | null> {
  const text = await storageReadFile(path)
  if (text === null) return null
  const budget = safeJsonParse(text, decodeWithSchema(budgetSchema))
  if (!budget || budget.reservedMicroUsd > budget.limitMicroUsd) {
    throw new Error('Automation model allowance is unreadable. No model request was sent.')
  }
  return budget
}

/** Main creates this immutable allowance before publishing the run thread. */
export async function createAutomationBudget(
  projectId: string,
  threadId: string,
  limitUsd: number,
): Promise<void> {
  const path = budgetPath(projectId, threadId)
  const budget = budgetSchema.parse({
    version: 1,
    limitMicroUsd: Math.floor(limitUsd * 1_000_000),
    reservedMicroUsd: 0,
  })
  await runSerialized(path, async () => {
    if ((await storageReadFile(path)) !== null)
      throw new Error('Automation allowance already exists')
    await storageWriteFile(path, JSON.stringify(budget))
  })
}

/** Later turns and machine continuations share the same persisted run allowance. */
export async function withAutomationBudget<T>(
  projectId: string,
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  const path = budgetPath(projectId, threadId)
  // Native in-loop subagents share this scope. A detached child thread would
  // lose it on restart, so do not admit that route until durable attribution exists.
  const parent = scope.getStore()
  if (parent && parent !== path) {
    throw new Error('An automation model allowance does not support separate worker threads yet')
  }
  if (parent) return run()
  return (await readBudget(path)) === null ? run() : scope.run(path, run)
}

/** Container/VM entry points can bypass the dispatcher; check the durable owner too. */
export async function rejectExternalAutomationBudget(
  projectId: string,
  threadId: string,
): Promise<void> {
  if (scope.getStore() || (await readBudget(budgetPath(projectId, threadId))) !== null) {
    throw new Error('Automation model allowances currently support native desktop runs only')
  }
}

/** Routes hosted outside the native provider cannot enforce this allowance. */
export function assertAutomationBudgetModel(model: string): void {
  if (!scope.getStore()) return
  if (!getModelInfo(model) || inferCloudModelProvider(model) !== 'anthropic') {
    throw new Error(
      'This automation has a model allowance. Choose a catalogue Anthropic API model; external agents and other providers are not supported yet.',
    )
  }
}

/**
 * Pessimistic catalogue cost: the transport's byte bound (full input window for
 * opaque content) at the highest input/cache rate, plus the actual capped output.
 * This is an estimated model allowance, not an invoice or a tool-spending limit.
 */
function reservationMicroUsd(model: string, request: LLMRequestEstimate): number {
  const info = getModelInfo(model)
  if (!info) throw new Error('No catalogue price for this automation model')
  const inputTokens = Math.min(
    info.contextWindow,
    request.inputTokensUpperBound ?? info.contextWindow,
  )
  const outputTokens = Math.min(
    info.maxOutputTokens,
    request.maxOutputTokens ?? info.maxOutputTokens,
  )
  if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('No bounded request size for this automation model')
  }
  const inputRate = Math.max(
    // Cover cache creation even when the catalogue omitted its separate rate.
    info.inputPricePerMTok * 2,
    info.cacheReadPricePerMTok ?? info.inputPricePerMTok,
    info.cacheCreationPricePerMTok ?? info.inputPricePerMTok,
  )
  const amount = Math.ceil(inputTokens * inputRate + outputTokens * info.outputPricePerMTok)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('No bounded catalogue cost for this automation model')
  }
  return amount
}

async function reserve(path: string, amount: number): Promise<void> {
  await runSerialized(path, async () => {
    const budget = await readBudget(path)
    if (!budget) throw new Error('Automation model allowance is missing. No request was sent.')
    if (budget.closed || amount > budget.limitMicroUsd - budget.reservedMicroUsd) {
      const remaining = (budget.limitMicroUsd - budget.reservedMicroUsd) / 1_000_000
      throw new Error(
        `Automation model allowance exhausted: $${remaining.toFixed(2)} remains; ` +
          `the next request needs a $${(amount / 1_000_000).toFixed(2)} maximum-cost reservation. No request was sent.`,
      )
    }
    // Errors, cancellation, missing usage and crashes retain this reservation.
    // Await the atomic write before permitting network activity.
    await storageWriteFile(
      path,
      JSON.stringify({ ...budget, reservedMicroUsd: budget.reservedMicroUsd + amount }),
    )
  })
}

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
})

async function settleReservation(
  path: string,
  model: string,
  reservation: number,
  usage: LLMRequestUsage,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = usageSchema.safeParse(usage)
  if (!parsed.success) return // Malformed provider usage cannot release credit.
  const { inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0 } = parsed.data
  const freshTokens = inputTokens - cacheReadTokens - cacheCreationTokens
  if (freshTokens < 0) return
  const info = getModelInfo(model)
  if (!info) throw new Error('No catalogue price for this automation model')
  const cost = Math.ceil(
    freshTokens * info.inputPricePerMTok +
      cacheReadTokens * (info.cacheReadPricePerMTok ?? info.inputPricePerMTok) +
      cacheCreationTokens * (info.cacheCreationPricePerMTok ?? info.inputPricePerMTok * 2) +
      outputTokens * info.outputPricePerMTok,
  )
  if (!Number.isSafeInteger(cost) || cost < 0) return
  await runSerialized(path, async () => {
    if (signal?.aborted) return
    const budget = await readBudget(path)
    if (budget?.closed) return // Other in-flight receipts cannot reopen a closed allowance.
    if (!budget || budget.reservedMicroUsd < reservation)
      throw new Error('Automation model allowance changed before usage could be recorded')
    if (cost > reservation) {
      // A stale catalogue/bound must not release credit or admit further work.
      await storageWriteFile(
        path,
        JSON.stringify({ ...budget, reservedMicroUsd: budget.limitMicroUsd, closed: true }),
      )
      throw new Error(
        'Automation model usage exceeded its reservation. The remaining allowance is closed.',
      )
    }
    await storageWriteFile(
      path,
      JSON.stringify({ ...budget, reservedMicroUsd: budget.reservedMicroUsd - reservation + cost }),
    )
  })
}

/** Wrap every constructed provider so cached helpers also check the active scope. */
export function guardAutomationProvider(
  provider: LLMProvider,
  description: Pick<ProviderDescription, 'kind' | 'model' | 'params'>,
): LLMProvider {
  const boundPath = scope.getStore()
  // Providers are newly built per caller today. Do not introduce a shared
  // provider cache without separating this run ownership from the instance.
  // Preserve the concrete provider and its live diagnostics/capabilities. Only
  // replace the stream entry point on this newly constructed instance.
  const stream = provider.stream.bind(provider)
  provider.stream = async function* (
    messages,
    tools,
    signal,
    options,
  ): AsyncIterable<ProviderStreamChunk> {
    const path = scope.getStore() ?? boundPath
    if (!path) {
      yield* stream(messages, tools, signal, options)
      return
    }
    // The provider can outlive its constructing async context.
    scope.run(path, () => {
      assertAutomationBudgetModel(description.model)
    })
    if (description.kind !== 'anthropic') {
      throw new Error('This provider cannot enforce an automation model allowance')
    }
    yield* stream(messages, tools, signal, {
      ...options,
      beforeRequest: async (request) => {
        signal?.throwIfAborted()
        const amount = reservationMicroUsd(description.model, request)
        await reserve(path, amount)
        let settled = false
        return async (usage): Promise<void> => {
          if (settled || signal?.aborted) return
          settled = true // One receipt per admitted HTTP attempt, even if writing fails.
          await settleReservation(path, description.model, amount, usage, signal)
        }
      },
    })
  }
  return provider
}
