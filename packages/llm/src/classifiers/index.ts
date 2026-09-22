import { classifyHttp, validateHttpLimits } from './http.ts'
import { classifySemIfBatch } from './semif.ts'
import { classifierProfileSchema, classifierRequestSchema } from './schemas.ts'
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
  const parsedProfile = classifierProfileSchema.safeParse(profile)
  if (!parsedProfile.success) {
    throw new ClassifierError('invalid-request', 'Invalid classifier profile or request.')
  }
  profile = parsedProfile.data
  const validated: ClassifierRequest[] = []
  for (const request of requests) {
    const parsed = classifierRequestSchema.safeParse(request)
    if (!parsed.success)
      throw new ClassifierError('invalid-request', 'Invalid classifier profile or request.')
    if (profile.connection.type === 'http') validateHttpLimits(profile, parsed.data)
    validated.push(parsed.data)
  }
  if (requests.length === 0) return []
  if (profile.connection.type === 'semif') return classifySemIfBatch(profile, validated, options)
  const results: ClassifierResult[] = []
  for (const request of validated) results.push(await classifyHttp(profile, request, options))
  return results
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
