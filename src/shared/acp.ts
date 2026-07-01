import type { AcpAgentConfig } from './types/acp.ts'

/**
 * Model-picker plumbing for the ACP **client** role: Copse drives an external,
 * locally-spawned ACP agent (Gemini CLI, Codex, Cline, …). Each configured agent
 * is surfaced as a model value `acp:<id>`, parsed back to its id when a turn runs
 * so it routes to {@link runAcpAgentFromSettings} instead of the built-in loop.
 *
 * An agent may also expose several models (discovered from `session/new`). A
 * specific model is encoded after a `#`: `acp:<id>#<modelValue>`. The model half
 * is a `SessionConfigValueId` applied via `session/set_config_option`; it may
 * contain `[]`, `,`, `=` (e.g. `composer-2.5[fast=true]`) but not `#`, so a
 * first-`#` split is unambiguous.
 *
 * The ids match {@link AcpAgentConfig.id}; see `acp-agent-registry.ts` for the
 * settings-backed lookup that turns an id into a spawn config.
 */
export const ACP_MODEL_PREFIX = 'acp:'
const ACP_MODEL_SEP = '#'

/** An `acp:<id>` model value decoded into its agent id and optional model. */
export interface AcpModelSelection {
  id: string
  /** The chosen `SessionConfigValueId`, or undefined for the agent's default. */
  model?: string
}

/** Build the model value the picker stores for an ACP agent id (+ optional model). */
export function acpModelValue(id: string, model?: string): string {
  return model ? `${ACP_MODEL_PREFIX}${id}${ACP_MODEL_SEP}${model}` : `${ACP_MODEL_PREFIX}${id}`
}

/** The agent id encoded in an `acp:<id>` model value, or `null` for other models. */
export function parseAcpModel(model: string): string | null {
  return parseAcpModelSelection(model)?.id ?? null
}

/**
 * Decode an `acp:<id>` / `acp:<id>#<model>` value into `{ id, model? }`, or
 * `null` for a non-ACP model or the empty-id edge case (`acp:` / `acp:#…`).
 */
export function parseAcpModelSelection(model: string): AcpModelSelection | null {
  if (!model.startsWith(ACP_MODEL_PREFIX)) return null
  const rest = model.slice(ACP_MODEL_PREFIX.length)
  const sep = rest.indexOf(ACP_MODEL_SEP)
  const id = sep === -1 ? rest : rest.slice(0, sep)
  if (id.length === 0) return null
  const chosen = sep === -1 ? '' : rest.slice(sep + 1)
  return chosen ? { id, model: chosen } : { id }
}

export function isAcpModel(model: string): boolean {
  return parseAcpModel(model) !== null
}

/**
 * Model-picker group heading for an ACP agent — e.g. `Cursor Client (ACP)`.
 * Each agent gets its own heading (rather than a shared "ACP agents" group) so
 * its models can be listed bare underneath without a redundant `Title —` prefix.
 */
export function acpGroupLabel(title: string): string {
  return `${title} Client (ACP)`
}

/**
 * Picker label for an `acp:<id>` model, given the configured agents. Includes
 * the model name (`Title — Model`) when a specific model is selected, resolving
 * the label from the agent's cached `availableModels` when known.
 */
export function acpModelDisplayLabel(model: string, agents: readonly AcpAgentConfig[]): string {
  const selection = parseAcpModelSelection(model)
  if (selection === null) return model
  const agent = agents.find((candidate) => candidate.id === selection.id)
  const title = agent?.title ?? selection.id
  if (!selection.model) return title
  const label = agent?.availableModels?.find((m) => m.value === selection.model)?.label
  return `${title} — ${label ?? selection.model}`
}
