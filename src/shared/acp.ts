import type { AcpAgentConfig } from './types/acp.ts'

/**
 * Model-picker plumbing for the ACP **client** role: Copse drives an external,
 * locally-spawned ACP agent (Gemini CLI, Codex, Cline, …). Each configured agent
 * is surfaced as a model value `acp:<id>`, parsed back to its id when a turn runs
 * so it routes to {@link runAcpAgentFromSettings} instead of the built-in loop.
 *
 * The ids match {@link AcpAgentConfig.id}; see `acp-agent-registry.ts` for the
 * settings-backed lookup that turns an id into a spawn config.
 */
export const ACP_MODEL_PREFIX = 'acp:'

/** Build the model value the picker stores for an ACP agent id. */
export function acpModelValue(id: string): `${typeof ACP_MODEL_PREFIX}${string}` {
  return `${ACP_MODEL_PREFIX}${id}`
}

/** The agent id encoded in an `acp:<id>` model value, or `null` for other models. */
export function parseAcpModel(model: string): string | null {
  if (!model.startsWith(ACP_MODEL_PREFIX)) return null
  const id = model.slice(ACP_MODEL_PREFIX.length)
  return id.length > 0 ? id : null
}

export function isAcpModel(model: string): boolean {
  return parseAcpModel(model) !== null
}

/** Picker label for an `acp:<id>` model, given the configured agents. */
export function acpModelDisplayLabel(model: string, agents: readonly AcpAgentConfig[]): string {
  const id = parseAcpModel(model)
  if (id === null) return model
  return agents.find((agent) => agent.id === id)?.title ?? id
}
