/**
 * Host-side half of the benchmark-only Harbor tuning
 * (`src/main/services/container-runtime/harbor-tuning.mts`): read and validate the
 * tuning file, resolve the sampling and context window the driver uses, and build
 * the `tuning.applied.json` record. Used by `harbor-container-driver.mts` and the
 * trial runner; never by anything the product ships.
 */
import { readFileSync } from 'node:fs'
import {
  decodeHarborTuning,
  workerTuningOf,
  type HarborTuning,
  type HarborWorkerTuning,
} from '../../src/main/services/container-runtime/harbor-tuning.mts'
import {
  resolveTerminalModelParameters,
  type TerminalModelParametersRecord,
} from './terminal-bench-model-parameters.mts'
import { SAMPLING_FIELDS, type ModelParameters } from '@copse/llm/model-parameters.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'

/** The product loop's default when a run states no context window (the driver's historical default). */
export const DEFAULT_HARBOR_CONTEXT_WINDOW = 262_144

/** Parse and validate tuning JSON text; throws a message naming what was wrong. */
export function parseTuningText(text: string, source: string): HarborTuning {
  const tuning = decodeHarborTuning(text)
  if (tuning === null) {
    throw new Error(
      `${source} is not a valid Harbor tuning (strict schema: unknown keys and bad values are rejected)`,
    )
  }
  return tuning
}

export function readTuningFile(path: string): HarborTuning {
  return parseTuningText(readFileSync(path, 'utf8'), path)
}

/**
 * `COPSE_HARBOR_TUNING`: a JSON object, or `@path` to a file holding one.
 * Returns the validated tuning, or `null` when the variable is unset or empty.
 */
export function tuningFromEnvValue(raw: string | undefined): HarborTuning | null {
  const value = raw?.trim()
  if (value === undefined || value === '') return null
  return value.startsWith('@')
    ? readTuningFile(value.slice(1))
    : parseTuningText(value, 'COPSE_HARBOR_TUNING')
}

export interface HostTuningInput {
  tuning: HarborTuning | null
  model: string
  /** The driver's `--max-steps` flag (from `COPSE_HARBOR_MAX_STEPS`), if any. */
  specMaxSteps: number | null
  /** The driver's `--context-window` flag value. */
  contextWindowFlag: number
}

export interface ResolvedHostTuning {
  record: TerminalModelParametersRecord
  contextWindow: number
}

/**
 * Two ways to set the step limit would make the measured configuration ambiguous,
 * so a tuning that states `loopLimits.maxSteps` refuses the legacy flag.
 */
export function assertNoStepLimitConflict(
  tuning: HarborTuning | null,
  specMaxSteps: number | null,
): void {
  if (specMaxSteps !== null && tuning?.loopLimits?.maxSteps !== undefined) {
    throw new Error(
      'Both --max-steps (COPSE_HARBOR_MAX_STEPS) and tuning loopLimits.maxSteps are set; use only one',
    )
  }
}

/**
 * The sampling the driver sends and the context window it hands the loop.
 * Without a tuning this is exactly the driver's behaviour before tunings existed:
 * the curated `client` recipe and the flag's context window.
 */
export function resolveHostTuning(input: HostTuningInput): ResolvedHostTuning {
  assertNoStepLimitConflict(input.tuning, input.specMaxSteps)
  const mode = input.tuning?.modelParametersMode ?? 'client'
  const sampling = input.tuning?.sampling ?? {}
  const base = resolveTerminalModelParameters(mode, input.model, sampling.maxOutputTokens)
  const params: ModelParameters = { ...base.params }
  for (const field of SAMPLING_FIELDS) {
    const value = sampling[field]
    if (value !== undefined) params[field] = value
  }
  return {
    record: { ...base, params },
    contextWindow: input.tuning?.contextWindow ?? input.contextWindowFlag,
  }
}

export interface AppliedTuning {
  schemaVersion: 1
  /** What was asked for (`null`: no tuning, every default applied). */
  requested: HarborTuning | null
  host: {
    modelParametersMode: 'client' | 'server'
    /** Exactly the sampling parameters handed to the provider. */
    params: TerminalModelParametersRecord['params']
    contextWindow: number
    /** The legacy `--max-steps` flag, if it was the one limiting the loop. */
    specMaxSteps: number | null
  }
  /** What the worker in the container reported it applied; `null` when it left no record. */
  worker: unknown
}

export function buildAppliedTuning(input: {
  tuning: HarborTuning | null
  resolved: ResolvedHostTuning
  specMaxSteps: number | null
  workerAppliedText: string | null
}): AppliedTuning {
  return {
    schemaVersion: 1,
    requested: input.tuning,
    host: {
      modelParametersMode: input.resolved.record.mode,
      params: input.resolved.record.params,
      contextWindow: input.resolved.contextWindow,
      specMaxSteps: input.specMaxSteps,
    },
    worker: input.workerAppliedText === null ? null : safeJsonParse(input.workerAppliedText),
  }
}

/** The container-side file text for a tuning: only the keys the worker reads. */
export function workerTuningFileText(tuning: HarborTuning): string {
  const worker: HarborWorkerTuning = workerTuningOf(tuning)
  return `${JSON.stringify(worker, null, 2)}\n`
}
