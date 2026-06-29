// Auto-detection for local OpenAI-compatible servers, used by the onboarding
// wizard to give first-run users a one-glance view of what's already running.
// The probe is the generic /v1/models listing (api.lmStudio.test works against
// any OpenAI-compatible server, not just LM Studio), so it covers every local
// preset without bespoke per-server logic.

import type { ApiClient } from '../../../preload/api.d.ts'
import { BUILTIN_EXTRA_PROVIDERS } from '@shared/llm/extra-providers.ts'
import { DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'

export interface LocalServerTarget {
  /** Provider slug (e.g. 'ollama'); 'lmstudio' for the LM Studio default URL. */
  id: string
  label: string
  baseUrl: string
}

export interface LocalServerResult extends LocalServerTarget {
  reachable: boolean
  models: string[]
  error?: string
}

/**
 * The local endpoints worth probing on first run: LM Studio plus every built-in
 * local preset. Sourced from the provider registry so adding a preset there
 * automatically extends detection.
 */
export function localServerTargets(): LocalServerTarget[] {
  const presets = BUILTIN_EXTRA_PROVIDERS.filter((p) => p.local).map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
  }))
  return [{ id: 'lmstudio', label: 'LM Studio', baseUrl: DEFAULT_LM_STUDIO_URL }, ...presets]
}

/** Probe every known local endpoint concurrently; never rejects (errors → unreachable). */
export async function detectLocalServers(api: ApiClient): Promise<LocalServerResult[]> {
  return Promise.all(
    localServerTargets().map(async (target): Promise<LocalServerResult> => {
      try {
        const res = await api.lmStudio.test(target.baseUrl)
        return {
          ...target,
          reachable: res.ok,
          models: res.models ?? [],
          ...(res.error ? { error: res.error } : {}),
        }
      } catch (err) {
        return {
          ...target,
          reachable: false,
          models: [],
          error: err instanceof Error ? err.message : 'probe failed',
        }
      }
    }),
  )
}

/**
 * Persist the discovered models for a reachable built-in preset so they show up
 * in the model picker and routing selects immediately. LM Studio is skipped — it
 * has its own dedicated server/model wiring (localServerUrl + lmstudio: prefix).
 *
 * A re-scan MERGES rather than replaces: any models the user already curated for
 * this provider (with their labels/context windows) are preserved, and only
 * freshly-probed ids that aren't already saved are appended. This stops a second
 * detection run from clobbering a hand-tuned shortlist.
 */
export async function importDetectedPreset(
  api: ApiClient,
  result: LocalServerResult,
): Promise<void> {
  if (result.id === 'lmstudio' || !result.reachable || result.models.length === 0) return
  const existing = (await api.settings.extraProviders()).find((p) => p.id === result.id)
  const existingModels = existing?.models ?? []
  const seen = new Set(existingModels.map((m) => m.id))
  const added = result.models.filter((id) => !seen.has(id)).map((id) => ({ id }))
  await api.settings.saveExtraProvider({
    slug: result.id,
    models: [...existingModels, ...added],
  })
}
