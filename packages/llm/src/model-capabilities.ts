// `modelCapabilities(selection)` — the single typed answer to "what can this model
// selection do, and which wire does it take?".
//
// Everything that used to be decided by matching a model-id string —
// provider family, Responses-vs-Chat transport, strict tools, `text.verbosity`,
// `parallel_tool_calls`, server-side compaction, `apply_patch`, operator-message
// placement — reads from here. The matching itself lives in `model-families.ts`
// (see its header for the resolution rules and the unknown-model contract); this
// module attaches the two answers that other tables own, so nothing is duplicated:
//
//   - `parameters` is `modelParameterSupport` verbatim — reasoning levels and
//     sampling knobs. It stays the source of truth for those.
//   - `contextWindow` comes from the generated catalog, including for dated
//     snapshots of a catalogued model.
//
// Takes a stored selection (`claude-opus-5`, `openrouter:openai/gpt-5`,
// `lmstudio:…`), never a bare id that has already lost its namespace: the
// namespace is what keeps an aggregator's `gpt-5` off the first-party path.

import { getModelInfo } from './model-catalog.ts'
import {
  firstPartyProviderOf,
  resolveModelFamily,
  undatedModelId,
  type FirstPartyProvider,
  type ModelFeatures,
  type ModelTransport,
} from './model-families.ts'
import { modelParameterSupport, type ModelParameterSupport } from './model-parameters.ts'
import { parseModelSelection, type ModelNamespace } from './model-selection.ts'

export { firstPartyProviderOf }
export type { FirstPartyProvider, ModelTransport }

export interface ModelCapabilities extends ModelFeatures {
  readonly namespace: ModelNamespace
  /** The wire a request takes. */
  readonly transport: ModelTransport
  /** The first-party provider a request goes to; `null` for every other route. */
  readonly provider: FirstPartyProvider | null
  /** Canonical family key (`gpt-5`, `claude-opus-5`); `null` when no entry matched. */
  readonly family: string | null
  /**
   * False when no family entry matched. Every optional flag is then off and
   * `parameters` is the conservative set — a model we have not reviewed gets
   * nothing beyond the basics.
   */
  readonly known: boolean
  /** Reasoning levels and sampling knobs this selection accepts. */
  readonly parameters: ModelParameterSupport
  /** Context window in tokens for a catalogued first-party model; `null` when not known. */
  readonly contextWindow: number | null
}

export function modelCapabilities(model: string): ModelCapabilities {
  const selection = parseModelSelection(model)
  const resolved = resolveModelFamily(selection)
  const info =
    selection.namespace === 'cloud'
      ? (getModelInfo(selection.modelId) ?? getModelInfo(undatedModelId(selection.modelId)))
      : null
  return {
    ...resolved,
    parameters: modelParameterSupport(model),
    contextWindow: info?.contextWindow ?? null,
  }
}
