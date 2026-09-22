import { classifyBatch } from '@copse/llm/classifiers/index.ts'
import { classifierProfileSchema, classifierRequestSchema } from '@copse/llm/classifiers/schemas.ts'
import { classifierCredentialId, CLASSIFIER_TEST_REQUEST } from '@copse/llm/classifiers/presets.ts'
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
  getSetting,
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

function configuredProfiles(): ClassifierProfile[] {
  return getSetting<ClassifierConfiguration>(CONFIGURATION_KEY, EMPTY_CONFIGURATION).profiles
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
  return classifierProfileSchema.parse(profile)
}

function environmentKey(profile: ClassifierProfile): string | undefined {
  if (getExplicitSettingsProfile()) return undefined
  const connection = profile.connection
  if (connection.type !== 'http' || connection.auth === 'none' || !connection.apiKeyEnv)
    return undefined
  return firstNonEmptyString(process.env[connection.apiKeyEnv])
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

export async function saveClassifierProfile(
  raw: ClassifierProfile,
): Promise<ClassifierProfileStatus[]> {
  const profile = classifierProfileSchema.parse(raw)
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
  return listClassifierProfiles()
}

function credentialScope(profile: ClassifierProfile): string {
  const connection = profile.connection
  return connection.type === 'semif'
    ? 'semif'
    : JSON.stringify([
        connection.protocol,
        connection.auth,
        new URL(connection.baseUrl).href.replace(/\/+$/, ''),
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

/** Main-process API used by explicit calls and the saved-profile eval entry point. */
export async function invokeClassifierBatch(
  id: string,
  requests: ClassifierRequest[],
  options: Pick<ClassifierCallOptions, 'signal' | 'timeoutMs'> = {},
): Promise<ClassifierResult[]> {
  const profile = getClassifierProfile(id)
  if (requests.length < 1 || requests.length > 1000)
    throw new Error('Provide 1–1000 classifier requests')
  let validated = requests.map((request) => classifierRequestSchema.parse(request))
  if (profile.connection.type === 'http') {
    assertApprovedProviderHost(profile.connection.baseUrl)
    if (!isLocalBaseUrl(profile.connection.baseUrl)) {
      const secrets = knownSecrets()
      validated = validated.map((request) => redactRequest(request, secrets))
    }
  }
  const apiKey = profileKey(profile)
  return classifyBatch(profile, validated, { ...options, ...(apiKey ? { apiKey } : {}) })
}

export async function testClassifierProfile(id: string): Promise<ClassifierResult> {
  const result = (await invokeClassifierBatch(id, [CLASSIFIER_TEST_REQUEST]))[0]
  if (!result) throw new Error('Classifier returned no result')
  return result
}
