import type { ClassifierProfile, ClassifierRequest, HttpClassifierConnection } from './types.ts'

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
    id: 'liquid',
    label: 'Liquid / d1',
    model: 'd1:free',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'https://api.liquid.ai/decisions/v1',
      auth: 'bearer',
      apiKeyEnv: 'LIQUID_API_KEY',
    },
  },
  {
    id: 'fastino-glide',
    label: 'Fastino / GLiDE',
    model: 'fastino/glide',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'https://api.fastino.ai/v1',
      auth: 'bearer',
      apiKeyEnv: 'FASTINO_API_KEY',
    },
  },
  {
    id: 'celeris',
    label: 'Celeris-1 Decision',
    model: 'celeris-1-decision',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'https://inference.celeris.ai/celeris-1-decision/v1',
      auth: 'bearer',
      apiKeyEnv: 'CELERIS_API_KEY',
    },
  },
  {
    id: 'microsoft-decision',
    label: 'Microsoft-Decision-1 (OpenRouter)',
    model: 'microsoft/microsoft-decision-1',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'decisions',
      baseUrl: 'https://openrouter.ai/api/alpha',
      auth: 'bearer',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
  },
  {
    id: 'perplexity-decider',
    label: 'Perplexity / Decider v1.3 (OpenRouter)',
    model: 'perplexity/pplx-decider-v1.3',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'decisions',
      baseUrl: 'https://openrouter.ai/api/alpha',
      auth: 'bearer',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
  },
  {
    id: 'perplexity-decider-direct',
    label: 'Perplexity / Decider v1.3',
    model: 'pplx-decider-v1.3',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'decisions',
      baseUrl: 'https://api.perplexity.ai/v1',
      auth: 'bearer',
      apiKeyEnv: 'PERPLEXITY_API_KEY',
    },
  },
  {
    id: 'perplexity-decider-flash',
    label: 'Perplexity / Decider Flash v1.3',
    model: 'pplx-decider-flash-v1.3',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'decisions',
      baseUrl: 'https://api.perplexity.ai/v1',
      auth: 'bearer',
      apiKeyEnv: 'PERPLEXITY_API_KEY',
    },
  },
  {
    id: 'mercury-decide',
    label: 'Inception / Mercury Decide (OpenRouter)',
    model: 'inception/mercury-decide',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'decisions',
      baseUrl: 'https://openrouter.ai/api/alpha',
      auth: 'bearer',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
  },
  {
    id: 'perplexity-decider-local',
    label: 'Perplexity / Decider for Mac (local)',
    model: 'pplx-decider-flash-v1.2',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'decisions',
      baseUrl: 'http://127.0.0.1:8080/v1',
      auth: 'none',
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
    id: 'winnow',
    label: 'Winnow-12B (local)',
    model: 'jev-latest',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      baseUrl: 'http://127.0.0.1:8091/v1',
      auth: 'none',
    },
  },
  {
    id: 'strands-decider',
    label: 'Strands Decider 2B (local)',
    // The server ignores this and reports the checkpoint it serves, without the `StrandsAgents/` owner.
    model: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    timeoutMs: 60_000,
    connection: {
      type: 'http',
      protocol: 'systemone',
      // Not the server's default 8000, which a stray dev server would be mistaken for.
      baseUrl: 'http://127.0.0.1:8011/v1',
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
