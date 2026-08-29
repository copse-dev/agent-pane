/**
 * User-authored subagent definitions discovered from dot-container `agents/`
 * directories (`.copse` / `.cursor` / `.claude`, project and user scope).
 *
 * The format is shared with Claude Code and Cursor: Markdown with YAML
 * frontmatter, where the body is the subagent's system prompt. See
 * docs/plans/custom-subagents.md for the field mapping and precedence rules.
 */

/** Which dot-container a definition came from; decides the filename-`name` rule. */
export type AgentContainer = '.copse' | '.cursor' | '.claude'

/** Where a definition was found. `project` and `plugin` are untrusted authors. */
export type AgentSource = 'project' | 'user' | 'plugin'

/**
 * A frontmatter field Copse parsed but does not act on yet, surfaced per row in
 * Settings. `reason` is user-facing copy: a field ignored silently is
 * indistinguishable from one Copse mishandled.
 */
export interface UnsupportedAgentField {
  field: string
  reason: string
}

export interface AgentSummary {
  name: string
  description: string | null
  source: AgentSource
  container: AgentContainer
  /** Absolute path to the definition file. */
  agentPath: string
  /** Frontmatter fields recognised but not yet honoured. */
  unsupportedFields: UnsupportedAgentField[]
}

export interface AgentMetadata extends AgentSummary {
  /** The Markdown body: this agent's system prompt. */
  body: string
  /** Tool allow-list from `tools`, already translated to Copse tool names. */
  tools: string[] | null
  /** Tool deny-list from `disallowedTools`, translated. Applied before `tools`. */
  disallowedTools: string[]
  /** Raw `model` value (`inherit`, an alias, or an id); resolved at run time. */
  model: string
  /** `readonly: true` (Cursor) or `permissionMode: plan` (Claude Code). */
  readonly: boolean
  /** `maxTurns`, clamped against the loop ceiling at run time. */
  maxTurns: number | null
  color: string | null
}

/**
 * A file under an `agents/` directory that did not become an agent, and why.
 *
 * Surfaced in Settings rather than only logged: for the user who asked for this
 * feature, an agent that silently fails to appear is the worst outcome, and
 * "which of my six roots did this come from" is unanswerable from a console
 * warning they never see.
 */
export interface SkippedAgentFile {
  agentPath: string
  source: AgentSource
  reason: string
}

/** A definition that lost a name collision, kept so Settings can explain the loss. */
export interface ShadowedAgent {
  name: string
  agentPath: string
  source: AgentSource
  /** Path of the definition that won. */
  shadowedBy: string
}

export interface AgentsListResult {
  agents: AgentSummary[]
  skipped: SkippedAgentFile[]
  shadowed: ShadowedAgent[]
}
