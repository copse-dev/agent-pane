import { runValidatedClassifierBatch } from '@copse/llm/classifiers/validated.ts'
import { parseClassifierRequests } from '@copse/llm/classifiers/validation.ts'
import { classifierProfileSchema } from '@copse/llm/classifiers/schemas.ts'
import {
  classifierCredentialId,
  classifierEndpointKey,
  CLASSIFIER_TEST_REQUEST,
  hostedClassifierPresets,
} from '@copse/llm/classifiers/presets.ts'
import type {
  ClassifierCallOptions,
  ClassifierProfile,
  ClassifierProfileStatus,
  ClassifierQuestion,
  ClassifierRequest,
  ClassifierResult,
  JsonValue,
} from '@copse/llm/classifiers/types.ts'
import { isLocalBaseUrl } from '@copse/llm/extra-providers.ts'
import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import {
  deleteSetting,
  getSetting,
  setSetting,
  updateSetting,
  getApiKey,
  hasApiKey,
  deleteApiKey,
  isApiKeyEncrypted,
  resolveApiKey,
} from '../storage/settings.ts'
import {
  ensureProviderHostApproved,
  assertApprovedProviderHost,
} from '../providers/approved-provider-hosts.ts'
import { getResolvedExtraProviders } from '../providers/extra-providers-store.ts'
import { PROVIDER_ENV_VARS } from '../providers/env-key-detection.ts'
import { getExplicitSettingsProfile } from '../storage/settings-context.ts'
import { firstNonEmptyString } from '@shared/unknown-value.ts'

interface ClassifierConfiguration {
  version: 1
  profiles: ClassifierProfile[]
}

const EMPTY_CONFIGURATION: ClassifierConfiguration = { version: 1, profiles: [] }
const CONFIGURATION_KEY = 'classifierProviders'
const SCREENING_KEY = 'safetyScreeningClassifier'

function configuredProfiles(): ClassifierProfile[] {
  return getSetting<ClassifierConfiguration>(CONFIGURATION_KEY, EMPTY_CONFIGURATION).profiles
}

/**
 * SemIf starts its scorer, and loads weights, for every call: it cannot answer
 * inside the screening budget, and its token limit could cut a snapshot the
 * verdict must cover in full. Screening therefore uses HTTP connections only.
 */
function canScreen(profile: ClassifierProfile): boolean {
  return profile.connection.type === 'http'
}

/**
 * The saved connection that screens shell commands and terminal reads, if one
 * is chosen. A choice naming a connection that no longer exists, or cannot
 * screen, reads as none: screening falls back to the safety model.
 */
export function screeningClassifierId(): string | null {
  const id = getSetting<string>(SCREENING_KEY, '')
  const profile = configuredProfiles().find((entry) => entry.id === id)
  return profile && canScreen(profile) ? id : null
}

function credentialForProfile(id: string): string {
  const credential = classifierCredentialId(id)
  if (getResolvedExtraProviders().some((provider) => provider.id === credential)) {
    throw new Error(
      'This classifier ID conflicts with an existing chat provider. Choose another ID.',
    )
  }
  return credential
}

export function getClassifierProfile(id: string): ClassifierProfile {
  credentialForProfile(id)
  const profile = configuredProfiles().find((entry) => entry.id === id)
  if (!profile) throw new Error('Classifier profile is not configured')
  const parsed = classifierProfileSchema.parse(profile)
  assertEnvironmentKeyAllowed(parsed)
  return parsed
}

function environmentKeyAllowed(profile: ClassifierProfile): boolean {
  const connection = profile.connection
  if (connection.type !== 'http' || connection.auth === 'none' || !connection.apiKeyEnv) return true
  if (/^COPSE_CLASSIFIER_[A-Z0-9_]+$/.test(connection.apiKeyEnv)) return true
  // A preset's provider variable may only travel to that preset's official endpoint.
  const endpoint = classifierEndpointKey(connection.baseUrl)
  return hostedClassifierPresets().some(
    (preset) =>
      preset.apiKeyEnv === connection.apiKeyEnv &&
      preset.protocol === connection.protocol &&
      classifierEndpointKey(preset.baseUrl) === endpoint,
  )
}

function assertEnvironmentKeyAllowed(profile: ClassifierProfile): void {
  if (!environmentKeyAllowed(profile)) {
    throw new Error(
      'This environment variable is not allowed for this classifier endpoint. Save a key, use a COPSE_CLASSIFIER_* variable, or use the provider variable with its official endpoint.',
    )
  }
}

function environmentKey(profile: ClassifierProfile): string | undefined {
  if (getExplicitSettingsProfile() || !environmentKeyAllowed(profile)) return undefined
  const connection = profile.connection
  if (connection.type !== 'http' || connection.auth === 'none' || !connection.apiKeyEnv)
    return undefined
  return firstNonEmptyString(process.env[connection.apiKeyEnv]?.trim())
}

function profileKey(profile: ClassifierProfile): string | undefined {
  if (profile.connection.type !== 'http' || profile.connection.auth === 'none') return undefined
  return getApiKey(classifierCredentialId(profile.id)) ?? environmentKey(profile)
}

export function listClassifierProfiles(): ClassifierProfileStatus[] {
  return configuredProfiles().map((profile) => ({
    profile,
    hasKey: hasApiKey(classifierCredentialId(profile.id)) || !!environmentKey(profile),
    encrypted: isApiKeyEncrypted(classifierCredentialId(profile.id)),
  }))
}

/**
 * Choose which saved connection screens shell commands and terminal reads, or
 * pass `null` to hand screening back to the Instruct / safety model. Choosing
 * makes no inference call; the host was approved when the connection was saved.
 */
export async function setScreeningClassifier(id: string | null): Promise<string | null> {
  if (id === null) {
    await deleteSetting(SCREENING_KEY)
    return null
  }
  if (!canScreen(getClassifierProfile(id))) {
    throw new Error(
      'SemIf starts its scorer for every call and cannot screen within the time limit. Choose an HTTP classifier.',
    )
  }
  await setSetting(SCREENING_KEY, id)
  return screeningClassifierId()
}

export async function saveClassifierProfile(
  raw: ClassifierProfile,
): Promise<ClassifierProfileStatus[]> {
  const profile = classifierProfileSchema.parse(raw)
  assertEnvironmentKeyAllowed(profile)
  const credential = credentialForProfile(profile.id)
  if (profile.connection.type === 'http') {
    await ensureProviderHostApproved(profile.connection.baseUrl)
  }
  await updateSetting<ClassifierConfiguration>(
    CONFIGURATION_KEY,
    EMPTY_CONFIGURATION,
    (current) => {
      const previous = current.profiles.find((entry) => entry.id === profile.id)
      if (previous && credentialScope(previous) !== credentialScope(profile)) {
        // Clear before publishing the new destination. A failed replacement key
        // save must never leave the old vendor's credential attached to it.
        deleteApiKey(credential)
      }
      return {
        version: 1,
        profiles: previous
          ? current.profiles.map((entry) => (entry.id === profile.id ? profile : entry))
          : [...current.profiles, profile],
      }
    },
  )
  return listClassifierProfiles()
}

export async function removeClassifierProfile(id: string): Promise<ClassifierProfileStatus[]> {
  const credential = credentialForProfile(id)
  await updateSetting<ClassifierConfiguration>(
    CONFIGURATION_KEY,
    EMPTY_CONFIGURATION,
    (current) => ({
      version: 1,
      profiles: current.profiles.filter((profile) => profile.id !== id),
    }),
  )
  deleteApiKey(credential)
  // Removing the screening connection hands screening back to the safety model.
  if (getSetting<string>(SCREENING_KEY, '') === id) await deleteSetting(SCREENING_KEY)
  return listClassifierProfiles()
}

function credentialScope(profile: ClassifierProfile): string {
  const connection = profile.connection
  return connection.type === 'semif'
    ? 'semif'
    : JSON.stringify([
        connection.protocol,
        connection.auth,
        classifierEndpointKey(connection.baseUrl),
      ])
}

function knownSecrets(): string[] {
  const slugs = new Set([
    ...Object.keys(PROVIDER_ENV_VARS),
    ...getResolvedExtraProviders().map((provider) => provider.id),
  ])
  const keys = [...slugs].map((slug) => resolveApiKey(slug))
  for (const profile of configuredProfiles()) {
    // A dormant saved key still needs redaction when authentication is disabled.
    keys.push(getApiKey(classifierCredentialId(profile.id)))
    keys.push(environmentKey(profile) ?? null)
  }
  return keys.filter((key) => typeof key === 'string').filter((key) => key.length > 0)
}

function redactValue(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === 'string') return redactSecrets(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets)]),
    )
  }
  return value
}

function redactQuestion(
  question: ClassifierQuestion,
  secrets: readonly string[],
): ClassifierQuestion {
  const instructions = redactSecrets(question.instructions, secrets)
  if (question.type === 'choice') {
    return {
      ...question,
      instructions,
      options: Object.fromEntries(
        Object.entries(question.options).map(([id, description]) => [
          id,
          description === null ? null : redactSecrets(description, secrets),
        ]),
      ),
    }
  }
  if (question.type === 'score') {
    return {
      ...question,
      instructions,
      levels: question.levels.map((level) => redactSecrets(level, secrets)),
    }
  }
  return {
    ...question,
    instructions,
    ...(question.criteria
      ? {
          criteria: Object.fromEntries(
            Object.entries(question.criteria).map(([key, value]) => [
              key,
              redactSecrets(value, secrets),
            ]),
          ),
        }
      : {}),
  }
}

function redactRequest(request: ClassifierRequest, secrets: readonly string[]): ClassifierRequest {
  const state = request.state
  return {
    state:
      typeof state === 'string'
        ? redactSecrets(state, secrets)
        : Array.isArray(state)
          ? state.map((entry) => redactValue(entry, secrets))
          : Object.fromEntries(
              Object.entries(state).map(([key, entry]) => [key, redactValue(entry, secrets)]),
            ),
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        redactQuestion(question, secrets),
      ]),
    ),
  }
}

export interface ClassifierSession {
  /** Non-secret copy of the configuration frozen for this run. */
  profile: ClassifierProfile
  invokeBatch(
    requests: ClassifierRequest[],
    options?: Pick<ClassifierCallOptions, 'signal' | 'timeoutMs'>,
  ): Promise<ClassifierResult[]>
}

/**
 * Resolve credentials once for an explicit run. No global cache: a new session
 * observes changed keys/settings, and one eval never mixes credential snapshots.
 * The internal configuration stays private; callers receive a separate copy.
 */
export function createClassifierSession(id: string): ClassifierSession {
  const profile = getClassifierProfile(id)
  const remote = profile.connection.type === 'http' && !isLocalBaseUrl(profile.connection.baseUrl)
  if (profile.connection.type === 'http') assertApprovedProviderHost(profile.connection.baseUrl)
  const apiKey = profileKey(profile)
  const secrets = remote ? knownSecrets() : []
  return {
    profile: structuredClone(profile),
    async invokeBatch(requests, options = {}): Promise<ClassifierResult[]> {
      if (requests.length < 1 || requests.length > 1000)
        throw new Error('Provide 1–1000 classifier requests')
      let validated = parseClassifierRequests(profile, requests)
      // Recheck this process's approval policy before each batch. Separate eval
      // processes retain their startup settings snapshot.
      if (profile.connection.type === 'http') assertApprovedProviderHost(profile.connection.baseUrl)
      if (remote) validated = validated.map((request) => redactRequest(request, secrets))
      return runValidatedClassifierBatch(profile, validated, {
        ...options,
        ...(apiKey ? { apiKey } : {}),
      })
    },
  }
}

/** A one-off app call resolves fresh settings and keys each time. */
export async function invokeClassifierBatch(
  id: string,
  requests: ClassifierRequest[],
  options: Pick<ClassifierCallOptions, 'signal' | 'timeoutMs'> = {},
): Promise<ClassifierResult[]> {
  return createClassifierSession(id).invokeBatch(requests, options)
}

export async function testClassifierProfile(id: string): Promise<ClassifierResult> {
  const result = (await invokeClassifierBatch(id, [CLASSIFIER_TEST_REQUEST]))[0]
  if (!result) throw new Error('Classifier returned no result')
  return result
}
