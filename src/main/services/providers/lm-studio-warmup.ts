import { z } from 'zod'
import { DEFAULT_APP_CHAT_MODEL, preferIpv4LoopbackUrl } from '@shared/lm-studio-defaults.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { getLmStudioApiKey, getSetting } from '../storage/settings.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'
import { resolveDynamicModelId } from './dynamic-model.ts'
import { describeProvider } from './provider-selection.ts'
import { lmStudioOrigin } from './lm-studio-models.ts'
import type { ProviderDescription } from './provider-description.ts'

interface WarmupDependencies {
  resolveModel: (selection?: string) => Promise<string>
  describeProvider: (model: string) => Promise<ProviderDescription>
  apiKey: () => string
  fetch: typeof fetch
}

const defaultDependencies: WarmupDependencies = {
  resolveModel: async (selection) => {
    // Mock runs must never load a real model, even when their fixture names one.
    if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') return ''
    return resolveDynamicModelId(selection ?? getSetting<string>('model', DEFAULT_APP_CHAT_MODEL))
  },
  describeProvider,
  apiKey: getLmStudioApiKey,
  fetch: (...args) => fetch(...args),
}

const modelsSchema = z.object({
  models: z.array(
    z.object({
      type: z.string(),
      key: z.string(),
      loaded_instances: z.array(z.object({ id: z.string() })),
    }),
  ),
})

/**
 * Best-effort loading only: no inference, downloads, unloads, or load-config
 * overrides. Share in-flight requests, but recheck the server on later sends:
 * LM Studio can evict an idle model independently of Copse.
 */
export function createLmStudioWarmup(
  dependencies: WarmupDependencies = defaultDependencies,
): (selection?: string) => Promise<void> {
  const flights = new Map<string, Promise<void>>()

  async function load(url: string, model: string, apiKey: string): Promise<void> {
    const headers = { Authorization: `Bearer ${apiKey}` }
    const catalog = await dependencies.fetch(`${url}/api/v1/models`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelList),
      // As with model discovery, never forward credentials to a redirect.
      redirect: 'manual',
    })
    if (!catalog.ok) {
      await catalog.body?.cancel()
      return
    }
    const models = safeJsonParse(await catalog.text(), decodeWithSchema(modelsSchema))
    if (!models) return
    // The picker may name a custom loaded instance rather than its catalog key.
    const entry = models.models.find(
      (candidate) =>
        candidate.key === model ||
        candidate.loaded_instances.some((instance) => instance.id === model),
    )
    if (!entry || entry.type !== 'llm' || entry.loaded_instances.length > 0) return

    const response = await dependencies.fetch(`${url}/api/v1/models/load`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: entry.key }),
      signal: AbortSignal.timeout(FETCH_TIMEOUTS.modelLoad),
      redirect: 'manual',
    })
    // This optimization has no persistent success state. A failure (including
    // an older server without this endpoint) leaves normal inference in charge.
    await response.body?.cancel()
  }

  return async (selection) => {
    try {
      const model = await dependencies.resolveModel(selection)
      if (model !== 'lm-studio' && !model.startsWith('lmstudio:')) return
      // Reuse inference's alias/default/URL resolution and model-maker policy.
      const description = await dependencies.describeProvider(model)
      if (description.kind !== 'lm-studio') return
      const url = lmStudioOrigin(preferIpv4LoopbackUrl(description.url))
      const apiKey = dependencies.apiKey()
      const key = JSON.stringify([url, description.model, apiKey])
      const existing = flights.get(key)
      if (existing) {
        await existing
        return
      }
      const pending = load(url, description.model, apiKey)
      flights.set(key, pending)
      try {
        await pending
      } finally {
        flights.delete(key)
      }
    } catch {
      // A speculative warm-up must never reject a submitted task. Inference
      // will retry model acquisition and surface any actionable provider error.
    }
  }
}

export const warmupLmStudioModel = createLmStudioWarmup()
