// Which model answers, and through which door. The CLI is provider-agnostic
// by design (§Packaging: "against any provider including a purely local
// model"), so this resolves a `--provider` / `--model` pair onto `@copse/llm`'s
// factories, reads keys from the environment only, and wraps every remote
// provider in secret redaction so the diff never carries a credential out.
import {
  createLMStudioProvider,
  createLocalOpenAIProvider,
  createOpenRouterProvider,
  createProvider,
} from '@copse/llm/create-provider.ts'
import { withSecretRedaction } from '@copse/llm/redacting-provider.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import { memberOf } from '@copse/std/member-of.ts'
import { droppedHostSecrets } from './isolation.ts'
import { ScriptedProvider, type ScriptedStep } from './scripted-provider.ts'

export const PROVIDER_KINDS = [
  'anthropic',
  'openai',
  'openrouter',
  'lmstudio',
  'openai-compatible',
  'mock',
] as const
export type ProviderKind = (typeof PROVIDER_KINDS)[number]
export const isProviderKind = memberOf(PROVIDER_KINDS)

export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:1234/v1'

export interface ProviderSelection {
  readonly kind?: ProviderKind | undefined
  readonly model?: string | undefined
  readonly baseUrl?: string | undefined
  /** Steps for `mock`. */
  readonly script?: readonly ScriptedStep[] | undefined
}

export interface SelectedProvider {
  readonly kind: ProviderKind
  readonly model: string
  readonly provider: LLMProvider
  /** Whether requests leave the machine (and were therefore wrapped in redaction). */
  readonly remote: boolean
}

/** The provider a model id implies when none was named. */
export function inferProviderKind(model: string | undefined): ProviderKind {
  if (model === undefined) return 'lmstudio'
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai'
  if (model.includes('/')) return 'openrouter'
  return 'lmstudio'
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

export function selectProvider(
  selection: ProviderSelection,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SelectedProvider {
  const kind = selection.kind ?? inferProviderKind(selection.model)
  const secrets = droppedHostSecrets(env)
  const remote = (model: string, provider: LLMProvider): SelectedProvider => ({
    kind,
    model,
    provider: withSecretRedaction(provider, secrets),
    remote: true,
  })
  switch (kind) {
    case 'mock':
      return {
        kind,
        model: selection.model ?? 'mock',
        provider: new ScriptedProvider(selection.script ?? []),
        remote: false,
      }
    case 'anthropic': {
      const model = selection.model ?? 'claude-sonnet-5'
      return remote(
        model,
        createProvider(model, { anthropicApiKey: required(env, 'ANTHROPIC_API_KEY') }),
      )
    }
    case 'openai': {
      const model = selection.model ?? 'gpt-5'
      return remote(model, createProvider(model, { openAiApiKey: required(env, 'OPENAI_API_KEY') }))
    }
    case 'openrouter': {
      const model = selection.model
      if (model === undefined)
        throw new Error('--model is required for openrouter (e.g. anthropic/claude-sonnet-5)')
      return remote(model, createOpenRouterProvider(model, required(env, 'OPENROUTER_API_KEY')))
    }
    case 'lmstudio': {
      const model = selection.model ?? env['LM_STUDIO_MODEL']?.trim()
      if (!model) throw new Error('--model (or LM_STUDIO_MODEL) is required for lmstudio')
      const url = selection.baseUrl ?? env['LM_STUDIO_URL']?.trim() ?? DEFAULT_LOCAL_BASE_URL
      const key = env['LM_STUDIO_API_KEY']?.trim() ?? env['LM_API_TOKEN']?.trim() ?? 'lm-studio'
      return { kind, model, provider: createLMStudioProvider(url, model, key), remote: false }
    }
    case 'openai-compatible': {
      const model = selection.model
      if (model === undefined) throw new Error('--model is required for openai-compatible')
      const url = selection.baseUrl ?? DEFAULT_LOCAL_BASE_URL
      const key = env['COPSE_REVIEW_API_KEY']?.trim() ?? 'lm-studio'
      const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)
      const provider = createLocalOpenAIProvider(url, model, key)
      return local ? { kind, model, provider, remote: false } : remote(model, provider)
    }
  }
}
