import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { getModelInfo, inferCloudModelProvider } from '@copse/llm/model-catalog.ts'
import type { LLMProvider, ProviderStreamChunk } from '@shared/types'
import type { ProviderDescription } from '../providers/provider-description.ts'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { storageReadFile, storageWriteFile } from '../storage/user-data-files.ts'
import { runSerialized } from '../storage/write-queue.ts'

const budgetSchema = z.strictObject({
  version: z.literal(1),
  limitMicroUsd: z.number().int().positive(),
  reservedMicroUsd: z.number().int().nonnegative(),
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
 * Pessimistic catalogue cost: a full input window at the highest input/cache
 * rate, plus the capped output. No token heuristic or missing-price=free fallback.
 * This is an estimated model allowance, not an invoice or a tool-spending limit.
 */
function reservationMicroUsd(model: string, maxOutputTokens?: number): number {
  const info = getModelInfo(model)
  if (!info) throw new Error('No catalogue price for this automation model')
  const inputRate = Math.max(
    // Cover cache creation even when the catalogue omitted its separate rate.
    info.inputPricePerMTok * 2,
    info.cacheReadPricePerMTok ?? info.inputPricePerMTok,
    info.cacheCreationPricePerMTok ?? info.inputPricePerMTok,
  )
  const amount = Math.ceil(
    info.contextWindow * inputRate +
      Math.min(info.maxOutputTokens, maxOutputTokens ?? info.maxOutputTokens) *
        info.outputPricePerMTok,
  )
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('No bounded catalogue cost for this automation model')
  }
  return amount
}

async function reserve(path: string, amount: number): Promise<void> {
  await runSerialized(path, async () => {
    const budget = await readBudget(path)
    if (!budget) throw new Error('Automation model allowance is missing. No request was sent.')
    if (amount > budget.limitMicroUsd - budget.reservedMicroUsd) {
      const remaining = (budget.limitMicroUsd - budget.reservedMicroUsd) / 1_000_000
      throw new Error(
        `Automation model allowance exhausted: $${remaining.toFixed(2)} remains; ` +
          `the next request needs a $${(amount / 1_000_000).toFixed(2)} maximum-cost reservation. No request was sent.`,
      )
    }
    // Never refund: errors, cancellation, missing usage and crashes may have
    // incurred cost. Await the atomic write before permitting network activity.
    await storageWriteFile(
      path,
      JSON.stringify({ ...budget, reservedMicroUsd: budget.reservedMicroUsd + amount }),
    )
  })
}

/** Wrap every constructed provider so cached helpers also check the active scope. */
export function guardAutomationProvider(
  provider: LLMProvider,
  description: Pick<ProviderDescription, 'kind' | 'model' | 'params'>,
): LLMProvider {
  const boundPath = scope.getStore()
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
    const amount = reservationMicroUsd(description.model, description.params.maxOutputTokens)
    yield* stream(messages, tools, signal, {
      ...options,
      beforeRequest: async () => {
        signal?.throwIfAborted()
        await reserve(path, amount)
      },
    })
  }
  return provider
}
