// Decides whether the user has *any* available chat model with a usable context
// window. Powers the startup warning: local servers (LM Studio et al.) reload
// models at a tiny default context after a reboot, and if that's the only thing
// configured, every chat/agent run over-trims history. We surface a one-time
// advisory pointing at the fix rather than silently degrading.
//
// "Available" mirrors the model picker's own gating (see model-options.ts):
//   - cloud catalog models, only when their provider key is configured;
//   - extra providers (Mistral/Gemini/DeepSeek/customs + local Ollama/llama.cpp/…)
//     with their known per-model / fallback windows;
//   - LM Studio's loaded models, using the context length the server reports.
// The decision itself is the shared `hasDecentContextWindow` predicate so the
// threshold lives in one place.

import {
  RECOMMENDED_MIN_CONTEXT_WINDOW,
  bestKnownContextWindow,
  hasDecentContextWindow,
} from '@shared/context-window-advice.ts'
import { CLOUD_MODELS, getModelInfo } from '@copse/llm/model-catalog.ts'
import { DEFAULT_LM_STUDIO_URL } from '@shared/lm-studio-defaults.ts'
import { getResolvedExtraProviders } from './extra-providers-store.ts'
import { fetchLmStudioModelsCached } from './lm-studio-models.ts'
import { getSetting, isProviderAvailable } from '../storage/settings.ts'

export interface ChatDefaultContextHealth {
  /** True when at least one available chat model reaches the recommended window. */
  hasDecentChatDefault: boolean
  /** The recommended minimum context window used for the check. */
  minimum: number
  /** Largest known context window among available chat models, or null if none. */
  bestAvailableContext: number | null
}

// OpenRouter and Cursor front frontier models (Claude/GPT-class), whose windows
// are all far above the minimum. We can't cheaply resolve which model the user
// would pick, so a configured key counts as a large-context default. 128K is a
// conservative floor for those catalogs.
const REPRESENTATIVE_CLOUD_CONTEXT = 128_000
const CLOUD_ACCESS_PROVIDERS = ['openrouter', 'cursor'] as const

/** Context windows of every cloud model reachable with a configured provider key. */
function availableCloudContextWindows(): number[] {
  const out: number[] = []
  for (const [id, , provider] of CLOUD_MODELS) {
    if (!isProviderAvailable(provider)) continue
    const ctx = getModelInfo(id)?.contextWindow
    if (typeof ctx === 'number') out.push(ctx)
  }
  for (const provider of CLOUD_ACCESS_PROVIDERS) {
    if (isProviderAvailable(provider)) out.push(REPRESENTATIVE_CLOUD_CONTEXT)
  }
  return out
}

/**
 * Context windows contributed by extra providers. A cloud preset counts only
 * when its key is set; a local server always counts but contributes only the
 * windows its models actually report (an un-fetched local server contributes
 * nothing, so it can't mask a genuinely low-context setup).
 */
function availableExtraProviderContextWindows(): number[] {
  const out: number[] = []
  for (const provider of getResolvedExtraProviders()) {
    const available = provider.local ? true : isProviderAvailable(provider.id)
    if (!available) continue
    for (const model of provider.models) {
      out.push(model.contextWindow ?? provider.fallbackContextWindow)
    }
    // A configured cloud preset with no curated shortlist (e.g. Hugging Face)
    // still offers models at its fallback window.
    if (!provider.local && provider.models.length === 0) {
      out.push(provider.fallbackContextWindow)
    }
  }
  return out
}

/** Context lengths LM Studio reports for its currently-loaded models. */
async function loadedLmStudioContextWindows(): Promise<number[]> {
  const url = getSetting<string>('localServerUrl', DEFAULT_LM_STUDIO_URL)
  const result = await fetchLmStudioModelsCached(url)
  if (!result.ok) return []
  const out: number[] = []
  for (const model of result.models) {
    if (model.contextLength) out.push(model.contextLength)
  }
  return out
}

/**
 * Whether a usable chat default exists across every configured provider. Used at
 * startup to decide if the low-context warning should show. Network-touching
 * only for LM Studio, which is cached (60s) and fails soft to "no windows".
 */
export async function evaluateChatDefaultContext(): Promise<ChatDefaultContextHealth> {
  // The mock LLM (dev / e2e) answers for any model regardless of context, so a
  // working chat default effectively exists — don't nag about context there.
  if (process.env['COPSE_PANEL_MOCK_LLM'] === '1') {
    return {
      hasDecentChatDefault: true,
      minimum: RECOMMENDED_MIN_CONTEXT_WINDOW,
      bestAvailableContext: null,
    }
  }
  const windows = [
    ...availableCloudContextWindows(),
    ...availableExtraProviderContextWindows(),
    ...(await loadedLmStudioContextWindows()),
  ]
  return {
    hasDecentChatDefault: hasDecentContextWindow(windows),
    minimum: RECOMMENDED_MIN_CONTEXT_WINDOW,
    bestAvailableContext: bestKnownContextWindow(windows),
  }
}
