/**
 * BENCHMARK-ONLY tuning for the Harbor container worker
 * (`benchmarks/terminal_bench/TUNING.md`, `docs/plans/thread-in-container.md`, A20).
 *
 * A tuning object lets a benchmark trial run the product worker with different
 * loop limits, recovery cap, sampling and context window, so candidate product
 * defaults can be measured. It travels `COPSE_HARBOR_TUNING` (Python agent) ->
 * driver flag -> `tuning.json` in the run directory -> read ONLY by
 * `worker-entry-harbor.ts` and the host driver.
 *
 * Nothing the product ships imports this file, and nothing here is a product
 * setting: `worker-entry-gating.test.ts` fails if the product entry, its import
 * graph or its bundle can reach it. The schema is strict on purpose: a key with
 * no seam behind it is rejected, never accepted and ignored.
 */
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/** The file the host driver writes into the container's run directory. */
export const HARBOR_TUNING_FILE = 'tuning.json'
/** What the entry (and then the driver) record as applied, next to `result.json`. */
export const HARBOR_TUNING_APPLIED_FILE = 'tuning.applied.json'

const positiveInt = z.number().int().positive()

/** Loop bounds, in the shape of the product loop's host-declared limits. */
const loopLimitsSchema = z.strictObject({
  maxSteps: positiveInt.optional(),
  maxLlmCalls: positiveInt.optional(),
  adaptiveExtensions: z.boolean().optional(),
})

/** Keys the worker (inside the task container) reads. */
const workerShape = {
  loopLimits: loopLimitsSchema.optional(),
  /** Token cap for the one recovery stream after a reasoning circle is cut. */
  reasoningRecoveryMaxTokens: positiveInt.optional(),
}

/**
 * Sampling the host sends with every provider request. A number sets the field;
 * leaving a field out leaves it as the base mode (`modelParametersMode`) sends it.
 */
const samplingSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).max(1).optional(),
  topK: positiveInt.optional(),
  minP: z.number().min(0).max(1).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  repetitionPenalty: z.number().gt(0).max(3).optional(),
  maxOutputTokens: positiveInt.optional(),
})

/** Keys only the host driver reads. */
const hostShape = {
  /** `server` sends no sampling fields (LM Studio defaults); `client` sends the curated recipe. */
  modelParametersMode: z.enum(['client', 'server']).optional(),
  sampling: samplingSchema.optional(),
  /** The context window the loop is told the model has. */
  contextWindow: positiveInt.optional(),
}

export const harborWorkerTuningSchema = z.strictObject(workerShape)
export const harborTuningSchema = z.strictObject({ ...workerShape, ...hostShape })

export type HarborWorkerTuning = z.infer<typeof harborWorkerTuningSchema>
export type HarborTuning = z.infer<typeof harborTuningSchema>
export type HarborSampling = z.infer<typeof samplingSchema>

/** The full tuning from JSON text; `null` when it is not valid JSON or not the schema. */
export function decodeHarborTuning(text: string): HarborTuning | null {
  return safeJsonParse(text, decodeWithSchema(harborTuningSchema))
}

/** The worker's slice of a tuning, from the file the driver wrote. */
export function decodeHarborWorkerTuning(text: string): HarborWorkerTuning | null {
  return safeJsonParse(text, decodeWithSchema(harborWorkerTuningSchema))
}

/** The keys the worker reads, split off a full tuning. */
export function workerTuningOf(tuning: HarborTuning): HarborWorkerTuning {
  return {
    ...(tuning.loopLimits === undefined ? {} : { loopLimits: tuning.loopLimits }),
    ...(tuning.reasoningRecoveryMaxTokens === undefined
      ? {}
      : { reasoningRecoveryMaxTokens: tuning.reasoningRecoveryMaxTokens }),
  }
}

/** The keys only the host reads, split off a full tuning. */
export function hostTuningOf(tuning: HarborTuning): Omit<HarborTuning, keyof HarborWorkerTuning> {
  return {
    ...(tuning.modelParametersMode === undefined
      ? {}
      : { modelParametersMode: tuning.modelParametersMode }),
    ...(tuning.sampling === undefined ? {} : { sampling: tuning.sampling }),
    ...(tuning.contextWindow === undefined ? {} : { contextWindow: tuning.contextWindow }),
  }
}
