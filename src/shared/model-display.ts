// One display label for every model-selection surface.
//
// Copse stores a chosen model as a single namespaced string (`claude-opus-4-8`,
// `lmstudio:qwen/…`, `acp:gemini-cli#gemini-2.5-pro`, …), and four surfaces —
// the picker, transcript labels, subagent badges, and advisor attribution —
// each reformatted it their own way and disagreed: `lmstudio:` got a `· local`
// suffix on the transcript but not the picker; ACP rendered `id (ACP)` on the
// advisor and a bare id on the transcript; subagent badges wrote `session.model`
// verbatim for everything but local. This module owns the whole string so they
// cannot drift again.
//
// It lives in `src/shared` (not `packages/llm`) because dispatching the
// agent-shaped namespaces (`acp:`, `remote-agent:`) needs their title-resolving
// helpers, which sit above the browser-safe LLM module. The model-*name* half is
// still normalised through the existing house-style labelers (`canonicalModelLabel`
// et al.) so vendor casing on proper nouns — `Claude Opus 4.8`, `GPT-5 mini` —
// is preserved exactly as elsewhere.

import { cloudModelDisplayLabel } from '@copse/llm/model-catalog.ts'
import { extraProviderDisplayLabel } from '@copse/llm/extra-providers.ts'
import { openRouterDisplayLabel } from '@copse/llm/openrouter.ts'
import { dynamicModelLabel } from '@copse/llm/dynamic-model.ts'
import { modelDisplayName } from '@copse/llm/model-label.ts'
import { parseModelSelection } from '@copse/llm/model-selection.ts'
import { acpModelDisplayLabel } from '@shared/acp.ts'
import { remoteAgentDisplayLabel } from '@shared/remote-agent.ts'
import { parsePluginModelSelection } from '@shared/plugin-model.ts'
import { BEST_VALUE_CHAT_MODEL_LABEL, isBestValueChatModel } from '@shared/lm-studio-defaults.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'

/** Suffix applied to every LM Studio selection, regardless of surface. */
export const LOCAL_MODEL_SUFFIX = ' · local'

/**
 * Context a caller can pass to let the shared labeler resolve agent titles and
 * live catalog labels. Callers without it (the transcript, subagent badges) are
 * still routed through the same function — they degrade to the id-fallback shape
 * inside the agent-helpers instead of receiving a raw `acp:…` / `remote-agent:…`
 * id, so every surface keeps the same structure even without context.
 */
export interface ModelDisplayContext {
  /** Configured ACP agents, to resolve `acp:<id>` titles. */
  acpAgents?: readonly AcpAgentConfig[]
  /** Live remote-agent catalog, to resolve `remote-agent:<provider>#<model>` model labels. */
  remoteCatalog?: ReadonlyArray<{ id: string; label: string }>
}

/**
 * The one display label for a model selection, uniform across every surface:
 *
 * - `lmstudio:<id>` → `<id> · local` (the suffix the transcript already used,
 *   now applied by the picker and subagent badge too).
 * - `acp:<id>` / `acp:<id>#<model>` → `Title — Model` (title alone when no model
 *   is chosen). With {@link ModelDisplayContext.acpAgents} the title resolves
 *   from the agent's configured `title`; without it the id stands in for the
 *   title so the shape stays `id — Model` rather than a raw prefixed string.
 * - `remote-agent:<provider>` / `…#<model>` → `Title — Model` the same way,
 *   using the provider's group label as the title.
 * - `plugin-model:…` → the decoded route id (the picker's existing behaviour).
 * - `openrouter:…` / extra-provider `…:` → their existing display labelers.
 * - `auto:` selectors → their rule labels (`Best value`, `Most capable`, …).
 * - the best-value chat sentinel → `Best value (plan / price)`.
 * - a bare cloud id → the shared house-style cloud label.
 *
 * The model-name half always runs through the house-style labelers, so vendor
 * casing on proper nouns is preserved; only structure and separators are unified.
 */
export function displayModelLabel(model: string, context?: ModelDisplayContext): string {
  if (isBestValueChatModel(model)) return BEST_VALUE_CHAT_MODEL_LABEL
  const dynamic = dynamicModelLabel(model)
  if (dynamic) return dynamic

  const selection = parseModelSelection(model)
  switch (selection.namespace) {
    case 'lmstudio':
      // Local weight ids are the hyphen-heaviest names in the app; spelling
      // them keeps the transcript reading the same as the picker row.
      return `${modelDisplayName(selection.id)}${LOCAL_MODEL_SUFFIX}`
    case 'acp':
      // With agents context, titles and cached model labels resolve; without it
      // the helper degrades to `id — canonicalModelLabel(model)` (or `id`),
      // which still beats the raw `acp:…` id the transcript and badge used to
      // render.
      return acpModelDisplayLabel(model, context?.acpAgents ?? [])
    case 'remote-agent':
      return remoteAgentDisplayLabel(model, context?.remoteCatalog ?? [])
    case 'plugin-model':
      return pluginLabel(model)
    case 'openrouter':
      return openRouterDisplayLabel(model)
    case 'extra-provider':
      return modelDisplayName(extraProviderDisplayLabel(model))
    default:
      return cloudModelDisplayLabel(model)
  }
}

/** `plugin-model:<pluginId>:<routeId>` → the decoded route id (picker behaviour). */
function pluginLabel(model: string): string {
  const plugin = parsePluginModelSelection(model)
  return plugin ? plugin.routeId : model
}
