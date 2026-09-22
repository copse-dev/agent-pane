import { ClassifierError } from './error.ts'
import { classifierProfileSchema, classifierRequestSchema } from './schemas.ts'
import type { ClassifierProfile, ClassifierRequest } from './types.ts'

export interface ValidatedClassifierBatch {
  profile: ClassifierProfile
  requests: ClassifierRequest[]
}

function validateHttpLimits(profile: ClassifierProfile, request: ClassifierRequest): void {
  if (profile.connection.type !== 'http')
    throw new ClassifierError('unsupported-capability', 'This adapter requires an HTTP classifier.')
  const featherless = profile.connection.protocol === 'featherless'
  for (const question of Object.values(request.questions)) {
    if (
      question.type === 'choice' &&
      Object.keys(question.options).length > (featherless ? 50 : 255)
    ) {
      throw new ClassifierError('invalid-request', 'Too many options for this classifier protocol.')
    }
    if (question.type === 'score' && question.levels.length > (featherless ? 50 : 10)) {
      throw new ClassifierError(
        'invalid-request',
        'Too many score levels for this classifier protocol.',
      )
    }
  }
}

/**
 * The public request boundary: return normalized copies after validating the
 * entire batch, before any request can be billed or any scorer is started.
 * Hosts may redact these copies and pass them to the internal dispatch without
 * repeating the recursive schema walks.
 */
export function parseClassifierBatch(
  profile: ClassifierProfile,
  requests: readonly ClassifierRequest[],
): ValidatedClassifierBatch {
  const parsedProfile = classifierProfileSchema.safeParse(profile)
  if (!parsedProfile.success) {
    throw new ClassifierError('invalid-request', 'Invalid classifier profile or request.')
  }
  return {
    profile: parsedProfile.data,
    requests: parseClassifierRequests(parsedProfile.data, requests),
  }
}

/** Validate requests against an already validated profile, such as a saved eval session. */
export function parseClassifierRequests(
  profile: ClassifierProfile,
  requests: readonly ClassifierRequest[],
): ClassifierRequest[] {
  const validated: ClassifierRequest[] = []
  for (const request of requests) {
    const parsed = classifierRequestSchema.safeParse(request)
    if (!parsed.success) {
      throw new ClassifierError('invalid-request', 'Invalid classifier profile or request.')
    }
    if (profile.connection.type === 'http') {
      validateHttpLimits(profile, parsed.data)
    }
    validated.push(parsed.data)
  }
  return validated
}
