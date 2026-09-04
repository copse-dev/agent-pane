import type {
  AcpAgentConfig,
  AcpConfigCategory,
  AcpConfigOption,
  AcpModelChoice,
} from './types/acp.ts'
import {
  canonicalAcpAgentId,
  KNOWN_ACP_AGENTS,
  RETIRED_ACP_AGENTS,
  type KnownAcpAgent,
} from './acp-known-agents.ts'
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
import { canonicalModelLabel } from '@copse/llm/model-label.ts'

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

/**
 * Categories the ACP spec reserves. Anything else — absent, `_vendor`-prefixed,
 * or a name added to a later spec revision — normalizes to `'other'`, which the
 * UI still renders (just without a category-specific label or shortcut).
 */
const KNOWN_CONFIG_CATEGORIES: ReadonlySet<string> = new Set([
  'mode',
  'model',
  'model_config',
  'thought_level',
])

/** Normalize an ACP `category` value; unknown/absent becomes `'other'`. */
export function acpConfigCategory(value: unknown): AcpConfigCategory {
  if (typeof value !== 'string' || !KNOWN_CONFIG_CATEGORIES.has(value)) return 'other'
  // The set membership above is the guard; re-narrowing keeps this total without
  // a cast (`no-unsafe-type-assertion` is enforced repo-wide).
  switch (value) {
    case 'mode':
      return 'mode'
    case 'model':
      return 'model'
    case 'model_config':
      return 'model_config'
    default:
      return 'thought_level'
  }
}

/**
 * Fallback display label for a config option, used when the agent's own `name`
 * is missing. Agents supply a `name` in practice, so this is belt-and-braces.
 */
export function acpConfigCategoryLabel(category: AcpConfigCategory): string {
  switch (category) {
    case 'mode':
      return 'Mode'
    case 'model':
      return 'Model'
    case 'model_config':
      return 'Model setting'
    case 'thought_level':
      return 'Thinking effort'
    default:
      return 'Option'
  }
}

/** Validate a cached config-option list read across the IPC/storage boundary. */
export function parseAcpConfigOptions(value: unknown): AcpConfigOption[] {
  return recordArrayOrEmpty(value).flatMap((entry) => {
    const configId = entry['configId']
    const currentValue = entry['currentValue']
    if (typeof configId !== 'string' || typeof currentValue !== 'string') return []
    const name = entry['name']
    const category = acpConfigCategory(entry['category'])
    const option: AcpConfigOption = {
      configId,
      name: typeof name === 'string' && name ? name : acpConfigCategoryLabel(category),
      category,
      currentValue,
      choices: parseChoices(entry['choices'], true),
    }
    if (typeof entry['description'] === 'string') option.description = entry['description']
    return [option]
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
    // Configs written before an agent was renamed still carry the old id.
    // Normalising here means every consumer — picker, spawn, seatbelt —
    // sees one id, and the next write persists it.
    const agent: AcpAgentConfig = { id: canonicalAcpAgentId(id), title, command, enabled }
    if (Array.isArray(entry['args']) && entry['args'].every((arg) => typeof arg === 'string')) {
      agent.args = entry['args']
    }
    if (isRecord(entry['env'])) agent.env = stringRecordOrEmpty(entry['env'])
    if (typeof entry['model'] === 'string') agent.model = entry['model']
    if (Array.isArray(entry['availableModels'])) {
      agent.availableModels = parseChoices(entry['availableModels'], true)
    }
    if (typeof entry['modelsProbedAt'] === 'number') agent.modelsProbedAt = entry['modelsProbedAt']
    if (typeof entry['permissionMode'] === 'string') agent.permissionMode = entry['permissionMode']
    if (Array.isArray(entry['availablePermissionModes'])) {
      agent.availablePermissionModes = parseChoices(entry['availablePermissionModes'], true)
    }
    if (isRecord(entry['configOptions'])) {
      agent.configOptions = stringRecordOrEmpty(entry['configOptions'])
    }
    if (Array.isArray(entry['availableConfigOptions'])) {
      agent.availableConfigOptions = parseAcpConfigOptions(entry['availableConfigOptions'])
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
 * How to recognise a set of catalog adapters from a spawn config: the bare
 * commands they install, the npm packages that ship those commands (what a
 * runner such as `npx` names instead), and their canonical ids.
 */
interface AcpAdapterSignature {
  commands: ReadonlySet<string>
  /** {@link commands} plus each entry's `installPackage`. */
  names: ReadonlySet<string>
  ids: ReadonlySet<string>
}

function adapterSignature(entries: readonly KnownAcpAgent[]): AcpAdapterSignature {
  const commands = new Set(entries.map((agent) => agent.command))
  const packages = entries.flatMap((agent) =>
    agent.installPackage === undefined ? [] : [agent.installPackage],
  )
  return {
    commands,
    names: new Set([...commands, ...packages]),
    ids: new Set(entries.map((agent) => canonicalAcpAgentId(agent.id))),
  }
}

/**
 * Retired agents count. Someone who configured `claude-code-acp` before it was
 * withdrawn still has a working Claude wrapper, and dropping it out of the
 * catalog scan would silently demote them to the API-billed path in the picker.
 */
const ACP_CATALOG: readonly KnownAcpAgent[] = [...KNOWN_ACP_AGENTS, ...RETIRED_ACP_AGENTS]

/**
 * Adapters whose parent client is Claude. A configured agent that spawns one of
 * these drives Claude through the user's *own* `claude` login (or ANTHROPIC_API_KEY)
 * over ACP, rather than the API-billed Claude Cloud (managed) agent.
 */
const CLAUDE_ADAPTERS = adapterSignature(
  ACP_CATALOG.filter((agent) => agent.requiresClient === 'claude'),
)

const CODEX_ADAPTERS = adapterSignature(
  ACP_CATALOG.filter((agent) => canonicalAcpAgentId(agent.id) === 'codex-acp'),
)

/**
 * The bare program a spawn command names. An agent registered by absolute path
 * (`/opt/homebrew/bin/claude-agent-acp`), quoted for a space in that path, or
 * through a platform shim (`claude-agent-acp.cmd`) launches the same adapter as
 * the catalog's bare `claude-agent-acp`, and losing the match over that
 * spelling costs the user their plan billing path.
 */
function commandProgram(command: string): string {
  const unquoted = command.trim().replace(/^"(.*)"$/, '$1')
  const base = unquoted.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(?:cmd|bat|exe|ps1)$/i, '')
}

/**
 * Runners that launch a program named in `args` rather than an adapter of their
 * own, keyed by program with the subcommands that make them one (`pnpm dlx`,
 * not `pnpm install`). `node` is handled separately: its operand is a script
 * path, not a package spec.
 */
const PACKAGE_RUNNERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['npx', []],
  ['bunx', []],
  ['pnpm', ['dlx', 'exec']],
  ['yarn', ['dlx']],
])

/** The first argument that is not a flag (`-y`, `--yes`, `--package=…`). */
function firstOperand(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'))
}

/** The package spec (or bin name) a package runner launches; `undefined` when `program` is not one. */
function runnerPackage(program: string, args: readonly string[]): string | undefined {
  const subcommands = PACKAGE_RUNNERS.get(program)
  if (subcommands === undefined) return undefined
  if (subcommands.length === 0) return firstOperand(args)
  const [subcommand, ...rest] = args
  return subcommand !== undefined && subcommands.includes(subcommand)
    ? firstOperand(rest)
    : undefined
}

/** `@scope/name@1.2.3` → `@scope/name`; a bare name passes through. */
function packageName(spec: string): string {
  const version = spec.indexOf('@', 1)
  return version === -1 ? spec : spec.slice(0, version)
}

/** Whether a script path has a segment (or scoped pair of segments) naming one of `names`. */
function scriptPathNames(script: string, names: ReadonlySet<string>): boolean {
  const path = `/${script.replace(/\\/g, '/')}/`
  for (const name of names) if (path.includes(`/${name}/`)) return true
  return false
}

/**
 * Whether an agent's spawn command launches one of `adapter`'s programs. The
 * command itself is the primary evidence, by bare name, path, or platform shim;
 * an agent wrapped in a runner (`npx -y @agentclientprotocol/claude-agent-acp`,
 * `node …/claude-agent-acp/dist/index.js`) hides it, so the package or script
 * the runner names is read as well.
 */
function launchesAdapter(agent: AcpAgentIdentity, adapter: AcpAdapterSignature): boolean {
  const program = commandProgram(agent.command)
  if (adapter.commands.has(agent.command) || adapter.commands.has(program)) return true
  const args = agent.args ?? []
  if (program === 'node') {
    const script = firstOperand(args)
    return script !== undefined && scriptPathNames(script, adapter.names)
  }
  const spec = runnerPackage(program, args)
  return spec !== undefined && adapter.names.has(packageName(spec))
}

/**
 * Whether an agent launches one of a known set of adapters — see {@link
 * launchesAdapter}. A custom label or a legacy id can still launch the
 * plan-backed adapter, so the command is checked first; a canonical id from the
 * catalog counts as well, for a wrapper the command scan cannot see through.
 */
function isKnownAcpAgent(agent: AcpAgentIdentity, adapter: AcpAdapterSignature): boolean {
  if (launchesAdapter(agent, adapter)) return true
  return agent.id !== undefined && adapter.ids.has(canonicalAcpAgentId(agent.id))
}

/**
 * Whether an agent's spawn command actually launches `entry`'s adapter. Used to
 * tell a custom agent that borrowed a catalog id from one that runs the real
 * thing under it; the id itself is deliberately not evidence here.
 */
export function launchesAcpCatalogEntry(agent: AcpAgentIdentity, entry: KnownAcpAgent): boolean {
  return launchesAdapter(agent, adapterSignature([entry]))
}

export type AcpPlanProvider = 'claude' | 'codex'

/**
 * What an agent must carry to be recognised. `id` is optional so callers that
 * only hold a command (agent detection, setup probes) keep working.
 */
type AcpAgentIdentity = Pick<AcpAgentConfig, 'command' | 'args'> &
  Partial<Pick<AcpAgentConfig, 'id'>>

/** Whether a configured ACP agent wraps Claude — see {@link isKnownAcpAgent}. */
export function isClaudeAcpAgent(agent: AcpAgentIdentity): boolean {
  return isKnownAcpAgent(agent, CLAUDE_ADAPTERS)
}

/**
 * Subscription provider used by a known ACP agent, or `null` for agents whose
 * billing path Copse cannot identify. An unidentified agent is more expensive
 * than it looks: it is left out of the routable frontier, so every `auto:`
 * selector settles for a paid API route while the picker goes on listing the
 * plan one.
 */
export function acpPlanProvider(agent: AcpAgentIdentity): AcpPlanProvider | null {
  if (isClaudeAcpAgent(agent)) return 'claude'
  if (isKnownAcpAgent(agent, CODEX_ADAPTERS)) return 'codex'
  return null
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
 * The versioned model name an ACP agent keeps in a choice's `description`
 * rather than its label. Claude Code labels its models by family alone ("Opus",
 * "Sonnet") and describes them as "Opus 5 with 1M context · Best for everyday,
 * complex tasks" — so the leading phrase, minus any variant tail the label
 * already carries, is the name the user expects to see.
 *
 * Null when there is no description, or when it reads as prose rather than a
 * name: only a short phrase carrying a version number qualifies, so agents that
 * describe models in a sentence keep their label untouched.
 */
export function acpModelVersionName(description: string | undefined): string | null {
  if (description === undefined) return null
  const [lead = ''] = description.split('·')
  const [name = ''] = lead.split(/\s+with\s+/i)
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 40) return null
  const words = trimmed.split(/\s+/)
  if (words.length > 3 || !/\d/.test(trimmed)) return null
  return trimmed
}

/**
 * Picker label for one of an agent's model choices, with the version folded in
 * when the agent hides it in the description: "Sonnet" → "Claude Sonnet 5",
 * "Opus (1M context)" → "Claude Opus 5 (1M context)". A label that names
 * something other than the model family ("Default (recommended)") gets the
 * resolved model appended instead, and a choice whose label is already
 * versioned keeps it. The result is spelled the way the app spells the same
 * model everywhere else — the agent's own house style ("Opus 4.8") would
 * otherwise read as a different vendor's model next to a "Claude Opus 4.8" row.
 */
export function acpModelChoiceLabel(choice: AcpModelChoice): string {
  const name = acpModelVersionName(choice.description)
  if (name === null || choice.label.includes(name)) return canonicalModelLabel(choice.label)
  const [family = ''] = name.split(/\s+/)
  const sharesFamily =
    choice.label.toLowerCase().startsWith(family.toLowerCase()) &&
    !/[a-z0-9]/i.test(choice.label.charAt(family.length))
  // The family merge runs on the agent's spelling (its label and the described
  // name share a family there); only the finished label is renamed.
  if (!sharesFamily) return `${choice.label} — ${canonicalModelLabel(name)}`
  const rest = choice.label.slice(family.length).trim()
  return canonicalModelLabel(rest ? `${name} ${rest}` : name)
}

/**
 * Picker label for an `acp:<id>` model, given the configured agents. Includes
 * the model name (`Title — Model`) when a specific model is selected, resolving
 * the label from the agent's cached `availableModels` when known.
 */
export function acpModelDisplayLabel(model: string, agents: readonly AcpAgentConfig[]): string {
  const selection = parseAcpModelSelection(model)
  if (selection === null) return model
  // Canonicalise both sides: the model value is history and the configured list
  // may have been built without going through `parseAcpAgentConfigs`.
  const selectedId = canonicalAcpAgentId(selection.id)
  const agent = agents.find((candidate) => canonicalAcpAgentId(candidate.id) === selectedId)
  // A thread that ran a since-retired agent still names it; fall back to the
  // recorded title so old transcripts read as a product name, not a slug.
  const retired = RETIRED_ACP_AGENTS.find((candidate) => candidate.id === selectedId)
  const title = agent?.title ?? retired?.title ?? selection.id
  if (!selection.model) return title
  const choice = agent?.availableModels?.find((m) => m.value === selection.model)
  return `${title} — ${choice ? acpModelChoiceLabel(choice) : canonicalModelLabel(selection.model)}`
}
