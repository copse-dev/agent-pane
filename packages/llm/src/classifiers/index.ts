import { parseClassifierBatch } from './validation.ts'
import { runValidatedClassifierBatch } from './validated.ts'
import { ClassifierError } from './error.ts'
import type {
  ClassifierCallOptions,
  ClassifierProfile,
  ClassifierRequest,
  ClassifierResult,
} from './types.ts'

export * from './types.ts'
export * from './presets.ts'
export * from './schemas.ts'
export * from './error.ts'

/** Node entry point; browser consumers must import types, presets or schemas directly. */
export async function classifyBatch(
  profile: ClassifierProfile,
  requests: readonly ClassifierRequest[],
  options: ClassifierCallOptions = {},
): Promise<ClassifierResult[]> {
  const parsed = parseClassifierBatch(profile, requests)
  return runValidatedClassifierBatch(parsed.profile, parsed.requests, options)
}

export async function classify(
  profile: ClassifierProfile,
  request: ClassifierRequest,
  options: ClassifierCallOptions = {},
): Promise<ClassifierResult> {
  const [result] = await classifyBatch(profile, [request], options)
  if (!result) throw new ClassifierError('invalid-response', 'Classifier returned no result.')
  return result
}
