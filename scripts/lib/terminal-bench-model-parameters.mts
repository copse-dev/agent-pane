import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLMStudioProvider } from '@copse/llm/create-provider.ts'
import {
  recommendedModelParameters,
  resolvedOutputCeiling,
  type ModelParameters,
} from '@copse/llm/model-parameters.ts'
import { OpenAIProvider } from '@copse/llm/openai-provider.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'

/**
 * Which sampling the benchmark agent sends.
 *
 * - `client` applies the curated per-model recipe the product applies by default
 *   (`recommendedModelParameters`). Stored user settings are never read: a
 *   benchmark must be reproducible from the repository alone.
 * - `server` sends no sampling fields, so LM Studio's own defaults apply. This is
 *   how every run before this switch was made; keep it selectable so those
 *   results stay comparable.
 *
 * The default is `server`, which is what every earlier run used, so adopting this
 * switch changes no result. `client` is opt-in: in paired Terminal-Bench runs on
 * `qwen3.6-35b-a3b` it lowered the runaway rate on one task but showed no better
 * outcomes, and it used up to 4.5x the tokens on two tasks the `server` runs
 * passed (3 of 3 passed with `server` sampling against 1 of 3 with the recipe;
 * one run each, and the baseline itself flipped on all three tasks between two
 * runs, so this is a hint, not a result). Every trial writes
 * `model-parameters.json`, so runs from either mode stay identifiable.
 */
export const TERMINAL_MODEL_PARAMETER_MODES = ['client', 'server'] as const
export type TerminalModelParametersMode = (typeof TERMINAL_MODEL_PARAMETER_MODES)[number]
export const DEFAULT_TERMINAL_MODEL_PARAMETERS_MODE: TerminalModelParametersMode = 'server'
export const TERMINAL_MODEL_PARAMETERS_ENV = 'COPSE_TERMINAL_MODEL_PARAMETERS'
export const TERMINAL_MODEL_PARAMETERS_ARTIFACT = 'model-parameters.json'
export const TERMINAL_MAX_OUTPUT_TOKENS_ENV = 'COPSE_TERMINAL_MAX_OUTPUT_TOKENS'

/**
 * Optional per-request output ceiling. The Qwen3.6 recipe publishes 81,920 and
 * the SDK transport applies it by model id even in `server` mode. The loop's
 * stream caps cannot see a tool call's arguments growing (the SDK delivers a
 * tool call as one chunk when it ends), so one runaway call can generate to the
 * ceiling: about 19 minutes at 70 tokens/s. A lower ceiling bounds that.
 */
export function terminalMaxOutputTokens(raw: string | undefined): number | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${TERMINAL_MAX_OUTPUT_TOKENS_ENV} must be a positive integer, received '${value}'.`,
    )
  }
  return parsed
}

export function terminalModelParametersMode(raw: string | undefined): TerminalModelParametersMode {
  const value = raw?.trim()
  if (!value) return DEFAULT_TERMINAL_MODEL_PARAMETERS_MODE
  for (const mode of TERMINAL_MODEL_PARAMETER_MODES) {
    if (mode === value) return mode
  }
  throw new Error(
    `${TERMINAL_MODEL_PARAMETERS_ENV} must be one of ${TERMINAL_MODEL_PARAMETER_MODES.join(', ')}, received '${value}'.`,
  )
}

export interface TerminalModelParametersRecord {
  schemaVersion: 1
  mode: TerminalModelParametersMode
  model: string
  /** The stored-selection form the recipe was resolved against. */
  selection: string
  /** The curated recipe's label and source when one applied; null otherwise. */
  recipe: { label: string; source: string } | null
  /** Exactly the parameters handed to the providers (empty in `server` mode). */
  params: ModelParameters
  /** `max_tokens` the OpenAI-compatible transport sends, if any. */
  outputCeiling: number | null
}

function lmStudioSelection(model: string): string {
  return model.startsWith('lmstudio:') ? model : `lmstudio:${model}`
}

export function resolveTerminalModelParameters(
  mode: TerminalModelParametersMode,
  model: string,
  maxOutputTokens?: number,
): TerminalModelParametersRecord {
  const cap = maxOutputTokens === undefined ? {} : { maxOutputTokens }
  if (mode === 'server') {
    const selection = lmStudioSelection(model)
    return {
      schemaVersion: 1,
      mode,
      model,
      selection,
      recipe: null,
      params: cap,
      // `max_tokens` on the OpenAI-compatible transport: none unless a cap is set.
      // (The native SDK transport still applies the card's ceiling by model id.)
      outputCeiling: maxOutputTokens ?? null,
    }
  }
  // The recipe's support table is keyed by a stored model selection, and a bare
  // id is the `cloud` namespace, which only accepts temperature and top_p. The
  // bench always talks to LM Studio, so resolve it as the product does for an
  // LM Studio model: `lmstudio:<id>`.
  const selection = lmStudioSelection(model)
  const recommendation = recommendedModelParameters(selection)
  const params = { ...(recommendation?.params ?? {}), ...cap }
  return {
    schemaVersion: 1,
    mode,
    model,
    selection,
    recipe: recommendation ? { label: recommendation.label, source: recommendation.source } : null,
    params,
    outputCeiling: resolvedOutputCeiling(selection, params) ?? null,
  }
}

export function writeTerminalModelParametersRecord(
  agentDirectory: string,
  record: TerminalModelParametersRecord,
): void {
  mkdirSync(agentDirectory, { recursive: true })
  writeFileSync(
    join(agentDirectory, TERMINAL_MODEL_PARAMETERS_ARTIFACT),
    `${JSON.stringify(record, null, 2)}\n`,
  )
}

export interface TerminalProviders {
  base: LLMProvider
  /** Present only for profiles that force the requested-output write on recovery. */
  forcedWrite: LLMProvider | undefined
}

/**
 * Build the benchmark's providers. Both OpenAI-compatible paths receive the same
 * parameters and output ceiling, so recovery turns are sampled like ordinary ones.
 * In `server` mode the construction is exactly what the bench did before.
 */
export function buildTerminalProviders(options: {
  baseUrl: string
  model: string
  apiKey: string
  forcesRequestedOutputRecovery: boolean
  record: TerminalModelParametersRecord
  reasoningSuppressionBody?: Readonly<Record<string, unknown>>
}): TerminalProviders {
  const { baseUrl, model, apiKey, forcesRequestedOutputRecovery, record } = options
  const params = record.params
  const applied = record.mode === 'client'
  const openAi = (extraBody?: Record<string, unknown>): OpenAIProvider => {
    const ceiling =
      applied || record.params.maxOutputTokens !== undefined
        ? (record.outputCeiling ?? undefined)
        : undefined
    return new OpenAIProvider(model, {
      baseURL: baseUrl,
      apiKey,
      includeUsage: true,
      ...(options.reasoningSuppressionBody
        ? { reasoningSuppressionBody: options.reasoningSuppressionBody }
        : {}),
      ...(applied ? { params } : {}),
      ...(ceiling === undefined ? {} : { maxOutputTokens: ceiling }),
      ...(extraBody ? { extraBody } : {}),
    })
  }
  if (!forcesRequestedOutputRecovery) {
    return {
      base: createLMStudioProvider(baseUrl, model, apiKey, params),
      forcedWrite: undefined,
    }
  }
  return {
    base: openAi(),
    forcedWrite: openAi({ tool_choice: { type: 'function', function: { name: 'write_file' } } }),
  }
}
