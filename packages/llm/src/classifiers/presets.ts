import type {
  ClassifierProfile,
  ClassifierRequest,
  HttpClassifierConnection,
} from './types.ts'

/** Defaults are editable; aliases are recorded alongside returned model versions in results. */
export const CLASSIFIER_PRESETS: readonly ClassifierProfile[] = [
  {
    id: 'typesafe',
    label: 'TypeSafe / Jev',
    model: 'jev-latest',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      auth: 'bearer',
      apiKeyEnv: 'TYPESAFE_API_KEY',
    },
  },
  {
    id: 'kev',
    label: 'Kev (local)',
    model: 'kev-latest',
    timeoutMs: 120_000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'http://127.0.0.1:8009/v1',
      auth: 'none',
    },
  },
  {
    id: 'semif',
    label: 'SemIf (local)',
    model: 'Qwen/Qwen3.5-4B',
    timeoutMs: 300_000,
    connection: {
      type: 'semif',
      executable: 'semif-score',
      backend: 'torch',
      revision: '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',
      mode: 'direct',
      device: 'auto',
    },
  },
  {
    id: 'featherless',
    label: 'Featherless / Simple Jev',
    model: 'featherless-ai/gemma-4-26B-A4B-classifier',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'featherless',
      baseUrl: 'https://api.featherless.ai/v1',
      auth: 'bearer',
      apiKeyEnv: 'FEATHERLESS_API_KEY',
    },
  },
]

/** Classifier keys share the provider-key store; chat-provider slugs may not use this prefix. */
export const CLASSIFIER_CREDENTIAL_PREFIX = 'classifier-'

export function classifierCredentialId(id: string): string {
  if (!/^[a-z0-9-]{1,53}$/.test(id)) throw new Error('Invalid classifier profile ID')
  return `${CLASSIFIER_CREDENTIAL_PREFIX}${id}`
}

/** Hosted preset endpoints: first-party provider hosts, and the only homes for preset key variables. */
export function hostedClassifierPresets(): HttpClassifierConnection[] {
  return CLASSIFIER_PRESETS.flatMap(({ connection }) =>
    connection.type === 'http' && connection.auth === 'bearer' ? [connection] : [],
  )
}

/** Compare classifier endpoints by URL, ignoring trailing slashes. Profiles carry no query or hash. */
export function classifierEndpointKey(baseUrl: string): string {
  return new URL(baseUrl).href.replace(/\/+$/, '')
}

export const CLASSIFIER_TEST_REQUEST: ClassifierRequest = {
  state: 'The bicycle is red.',
  questions: {
    color: {
      type: 'choice',
      instructions: 'What color is the bicycle?',
      options: { red: null, blue: null },
    },
  },
}
