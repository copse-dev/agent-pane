// The agent-role registry: the *pipeline* axis of model selection — "what job
// does a model do in Copse", as opposed to the *capability* axis ("what is a
// model good at", which lives in `local-model-catalog.ts`).
//
// Roles are pre-seeded but designed to be user-editable: a user assigns a model
// to a role once ("Qwen2.5-Coder is my `coder`") and every feature bound to that
// role uses it. This module is Phase 0 of `docs/plans/model-roles-and-defaults.md`
// — pure data + helpers, no behaviour change yet. Phase 1 makes these roles the
// source of truth for the existing routing settings.
//
// This generalizes the three implicit roles that exist today in
// `src/shared/preferred-models.ts` (`chat` / `smallTasks` / `safety`); see
// {@link LEGACY_ROLE_ALIASES} for how the current settings keys map onto roles.

import type { Benchmark } from './local-model-catalog.ts'

/** Canonical role ids. Stable string keys — persisted and referenced by data. */
export type AgentRoleId =
  | 'coder'
  | 'debugger'
  | 'reviewer'
  | 'security-auditor'
  | 'judge'
  | 'test-gen'
  | 'refactor'
  | 'planner'
  | 'advisor'
  | 'docs'
  | 'research'
  | 'tool-use'
  | 'small-tasks'
  | 'safety'

export interface AgentRole {
  id: AgentRoleId
  /** Short human label for the settings UI. */
  label: string
  /** One line: what job this role does in the pipeline. */
  description: string
  /**
   * Benchmarks that matter for this role, most-important first. Used by
   * {@link recommendLocalModelsForRole} to rank candidates; also documents *why*
   * a model is a good fit for the role. Keys are validated against the catalog's
   * benchmark set in `agent-roles.test.ts`.
   */
  wants: Benchmark[]
}

/**
 * The seeded registry. Order is display order. The list mirrors the "two axes"
 * table in `docs/plans/model-roles-and-defaults.md`.
 */
export const AGENT_ROLES: readonly AgentRole[] = [
  {
    id: 'coder',
    label: 'Coder',
    description: 'Writing new code — the chat default when coding',
    wants: ['swe-bench', 'aider-polyglot', 'aider-edit', 'humaneval-plus', 'livecodebench'],
  },
  {
    id: 'debugger',
    label: 'Debugger',
    description: 'Fixing bugs through careful, iterative analysis',
    wants: ['swe-bench', 'livecodebench', 'gpqa'],
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Post-turn diff review and maintainability',
    wants: ['aider-polyglot', 'mmlu-pro', 'swe-bench'],
  },
  {
    id: 'security-auditor',
    label: 'Security auditor',
    description: 'Finding vulnerabilities with low false negatives',
    wants: ['gpqa', 'mmlu-pro'],
  },
  {
    id: 'judge',
    label: 'Judge',
    description: 'Accept/reject a patch or answer against a rubric',
    wants: ['gpqa', 'mmlu-pro'],
  },
  {
    id: 'test-gen',
    label: 'Test generator',
    description: 'Unit, integration, and property tests',
    wants: ['livecodebench', 'humaneval-plus', 'multipl-e'],
  },
  {
    id: 'refactor',
    label: 'Refactorer',
    description: 'Behaviour-preserving changes',
    wants: ['aider-polyglot', 'aider-edit', 'swe-bench'],
  },
  {
    id: 'planner',
    label: 'Planner',
    description: 'Breaking work into prioritised tasks',
    wants: ['gpqa', 'mmlu-pro', 'arena'],
  },
  {
    id: 'advisor',
    label: 'Advisor',
    description: 'Strategic mid-task guidance to a cheaper executor (advisor strategy)',
    wants: ['gpqa', 'mmlu-pro', 'swe-bench'],
  },
  {
    id: 'docs',
    label: 'Documentation',
    description: 'READMEs, comments, and API docs',
    wants: ['mmlu-pro', 'arena'],
  },
  {
    id: 'research',
    label: 'Research assistant',
    description: 'API/framework lookup and synthesis (exploration subagent)',
    wants: ['mmlu-pro', 'gpqa', 'arena'],
  },
  {
    id: 'tool-use',
    label: 'Tool-use agent',
    description: 'Calling tools correctly with structured output',
    wants: ['tau-bench', 'multipl-e'],
  },
  {
    id: 'small-tasks',
    label: 'Small tasks',
    description: 'Thread titles and other lightweight prompts',
    wants: ['arena'],
  },
  {
    id: 'safety',
    label: 'Instruct / safety',
    description: 'Classifies shell commands when the OS sandbox is off',
    wants: ['arena'],
  },
]

const ROLE_BY_ID: ReadonlyMap<AgentRoleId, AgentRole> = new Map(AGENT_ROLES.map((r) => [r.id, r]))

export function getAgentRole(id: string): AgentRole | null {
  return ROLE_BY_ID.get(id as AgentRoleId) ?? null
}

export const AGENT_ROLE_IDS: readonly AgentRoleId[] = AGENT_ROLES.map((r) => r.id)

/**
 * How today's routing settings map onto roles. Phase 1 turns these into real
 * aliases (a settings migration + role-driven resolution); for now this only
 * documents the intended mapping and lets tests assert the legacy roles are all
 * covered by the registry. Keys are the settings keys from
 * `settings-writable.ts`; values are the role each one becomes.
 */
export const LEGACY_ROLE_ALIASES: Readonly<Record<string, AgentRoleId>> = {
  // `chat` / `localDefaultModel` — the main model, biased toward coding.
  localDefaultModel: 'coder',
  // Exploration subagent that reads the codebase for a cloud chat model.
  subagentModel: 'research',
  // Diff review after an editing turn.
  reviewModel: 'reviewer',
  // Shell-command classifier when the OS sandbox is off.
  safetyModel: 'safety',
  // Titles and other lightweight prompts.
  smallTasksModel: 'small-tasks',
  // Larger model consulted mid-task by the client-side advisor strategy.
  advisorModel: 'advisor',
}
