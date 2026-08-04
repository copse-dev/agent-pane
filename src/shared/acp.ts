import type { AcpAgentConfig } from './types/acp.ts'
import { KNOWN_ACP_AGENTS } from './acp-known-agents.ts'
import { isRecord, recordArrayOrEmpty, stringRecordOrEmpty } from './unknown-value.mts'

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
// Canonical definitions live in the LLM module, which owns the model-id
// namespacing vocabulary; re-exported here so ACP consumers keep their existing
// import path and the literal never drifts between the two.
export { ACP_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { ACP_MODEL_PREFIX, AGENT_MODEL_SEP } from '@copse/llm/reserved-prefixes.ts'
import { parseModelSelection } from '@copse/llm/model-selection.ts'

/**
 * ACP agents are local stdio processes. SSH workspaces do not remount them on
 * the remote host (and must not silently run against a remote path as cwd).
 */
export const ACP_UNSUPPORTED_ON_SSH_MESSAGE =
  'ACP agents run locally on this device and are not available in SSH workspaces. Switch to a local folder or pick a cloud/local model.'

function parseChoices(
  value: unknown,
  includeDescription: boolean,
): NonNullable<AcpAgentConfig['availableModels']> {
  return recordArrayOrEmpty(value).flatMap((entry) => {
    const choiceValue = entry['value']
    const label = entry['label']
    if (typeof choiceValue !== 'string' || typeof label !== 'string') return []
    const description = entry['description']
    return [
      includeDescription && typeof description === 'string'
        ? { value: choiceValue, label, description }
        : { value: choiceValue, label },
    ]
  })
}

/** Validate ACP agent settings read across the IPC/storage boundary. */
export function parseAcpAgentConfigs(value: unknown): AcpAgentConfig[] {
  return recordArrayOrEmpty(value).flatMap((entry) => {
    const id = entry['id']
    const title = entry['title']
    const command = entry['command']
    const enabled = entry['enabled']
    if (
      typeof id !== 'string' ||
      typeof title !== 'string' ||
      typeof command !== 'string' ||
      typeof enabled !== 'boolean'
    ) {
      return []
    }
    const agent: AcpAgentConfig = { id, title, command, enabled }
    if (Array.isArray(entry['args']) && entry['args'].every((arg) => typeof arg === 'string')) {
      agent.args = entry['args']
    }
    if (isRecord(entry['env'])) agent.env = stringRecordOrEmpty(entry['env'])
    if (typeof entry['model'] === 'string') agent.model = entry['model']
    if (Array.isArray(entry['availableModels'])) {
      agent.availableModels = parseChoices(entry['availableModels'], false)
    }
    if (typeof entry['modelsProbedAt'] === 'number') agent.modelsProbedAt = entry['modelsProbedAt']
    if (typeof entry['permissionMode'] === 'string') agent.permissionMode = entry['permissionMode']
    if (Array.isArray(entry['availablePermissionModes'])) {
      agent.availablePermissionModes = parseChoices(entry['availablePermissionModes'], true)
    }
    const sandbox = entry['sandbox']
    if (sandbox === false) {
      agent.sandbox = false
    } else if (
      isRecord(sandbox) &&
      Array.isArray(sandbox['allowedDomains']) &&
      sandbox['allowedDomains'].every((domain) => typeof domain === 'string')
    ) {
      agent.sandbox = { allowedDomains: sandbox['allowedDomains'] }
      if (
        Array.isArray(sandbox['homeDirs']) &&
        sandbox['homeDirs'].every((dir) => typeof dir === 'string')
      ) {
        agent.sandbox.homeDirs = sandbox['homeDirs']
      }
      if (
        Array.isArray(sandbox['scratchPaths']) &&
        sandbox['scratchPaths'].every((path) => typeof path === 'string')
      ) {
        agent.sandbox.scratchPaths = sandbox['scratchPaths']
      }
    }
    return [agent]
  })
}

/** An `acp:<id>` model value decoded into its agent id and optional model. */
export interface AcpModelSelection {
  id: string
  /** The chosen `SessionConfigValueId`, or undefined for the agent's default. */
  model?: string
}

/** Build the model value the picker stores for an ACP agent id (+ optional model). */
export function acpModelValue(id: string, model?: string): string {
  return model ? `${ACP_MODEL_PREFIX}${id}${AGENT_MODEL_SEP}${model}` : `${ACP_MODEL_PREFIX}${id}`
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
  const selection = parseModelSelection(model)
  if (selection.namespace !== 'acp' || selection.agent.length === 0) return null
  return selection.id ? { id: selection.agent, model: selection.id } : { id: selection.agent }
}

export function isAcpModel(model: string): boolean {
  return parseAcpModel(model) !== null
}

/**
 * Model-picker group heading for a device agent, e.g. `Cursor on this device`.
 * Each agent gets its own heading (rather than one shared group) so its models
 * can be listed bare underneath without a redundant `Title:` prefix. "ACP" is
 * the wire protocol and stays out of the product copy.
 */
export function acpGroupLabel(title: string): string {
  return `${title} on this device`
}

/**
 * Commands from the known-agents catalog whose parent client is Claude
 * (`claude-agent-acp`, `claude-code-acp`). A configured agent that spawns one of
 * these drives Claude through the user's *own* `claude` login (or ANTHROPIC_API_KEY)
 * over ACP, rather than the API-billed Claude Cloud (managed) agent.
 */
const CLAUDE_ACP_COMMANDS: ReadonlySet<string> = new Set(
  KNOWN_ACP_AGENTS.filter((agent) => agent.requiresClient === 'claude').map(
    (agent) => agent.command,
  ),
)

/** Whether a configured ACP agent wraps Claude, matched by its spawn command. */
export function isClaudeAcpAgent(agent: Pick<AcpAgentConfig, 'command'>): boolean {
  return CLAUDE_ACP_COMMANDS.has(agent.command)
}

/**
 * The first enabled Claude ACP agent, or `undefined`. When one is present the
 * user can drive Claude through their own `claude` login (ACP) instead of the
 * API-billed Claude Cloud (managed) agent — so the model picker prefers ACP:
 * it lists the ACP agent ahead of the Claude Cloud Agent and flags that option
 * as API-billed. Only enabled agents count; a disabled Claude ACP agent does
 * not change the ordering.
 */
export function enabledClaudeAcpAgent(
  agents: readonly AcpAgentConfig[],
): AcpAgentConfig | undefined {
  return agents.find((agent) => agent.enabled && isClaudeAcpAgent(agent))
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
