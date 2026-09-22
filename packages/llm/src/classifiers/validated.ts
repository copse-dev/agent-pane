import { classifyHttpValidated } from './http.ts'
import { classifySemIfBatchValidated } from './semif.ts'
import type {
  ClassifierCallOptions,
  ClassifierProfile,
  ClassifierRequest,
  ClassifierResult,
} from './types.ts'

/**
 * @internal Dispatch only normalized copies returned by parseClassifierBatch.
 * Hosts may redact text in those copies before calling this function, but must
 * preserve their validated structure and identifiers. Untrusted callers must
 * use the public classify/classifyBatch entry points instead.
 */
export async function runValidatedClassifierBatch(
  profile: ClassifierProfile,
  requests: readonly ClassifierRequest[],
  options: ClassifierCallOptions = {},
): Promise<ClassifierResult[]> {
  if (requests.length === 0) return []
  if (profile.connection.type === 'semif') {
    return classifySemIfBatchValidated(profile, requests, options)
  }
  const results: ClassifierResult[] = []
  for (const request of requests)
    results.push(await classifyHttpValidated(profile, request, options))
  return results
}
