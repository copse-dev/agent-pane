export type SkillSource = 'project' | 'user' | 'plugin' | 'plugin-path' | 'bundled'

export interface SkillSummary {
  name: string
  description: string
  source: SkillSource
  skillPath: string
  /** Unique external hostnames the skill's SKILL.md references (http/https). */
  externalLinks: string[]
}

export interface SkillMetadata extends SkillSummary {
  /** Absence in legacy snapshots means manually invocable. */
  userInvocable?: boolean
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  /** Compatibility information only. Never authorizes or auto-approves tools. */
  allowedTools?: string
  skillRoot: string
  disableModelInvocation: boolean
  paths: string[]
  /**
   * Name of the plugin that ships this skill (a bundled or installed Cursor
   * plugin, or an Agent Plugins package). Absent for skills installed directly
   * under a skills tree. Lets `read_skill` resolve `plugin/skill` and tell a
   * caller that a bare plugin name is a set of skills, not one skill.
   */
  plugin?: string
  /**
   * Bundle-relative paths (`references/…`, `scripts/…`, `assets/…`) the
   * skill's SKILL.md mentions but that do not exist under `skillRoot`.
   * Computed once at discovery time so a broken bundle is flagged before the
   * model hits the missing file mid-run.
   */
  missingReferences: string[]
}

export interface SkillDiagnostic {
  kind: 'invalid' | 'shadowed' | 'compatibility' | 'unsupported'
  skillPath: string
  source: SkillSource
  name: string
  reason: string
  shadowedBy?: string
}

export interface SkillsSourcesResult {
  skills: SkillMetadata[]
  diagnostics: SkillDiagnostic[]
  /** User-configured extra roots, in effective precedence order. */
  extraRoots: string[]
  reload: 'manual'
}

export interface SkillReadResult {
  name: string
  description: string
  skillRoot: string
  skillPath: string
  body: string
  relativePath: string
  /** See {@link SkillMetadata.missingReferences}. */
  missingReferences: string[]
}

// The run payload is owned by the agent module (`parseAgentRunPayload` parses
// it back — the loop's run input); re-exported here so `@shared/types`
// consumers are unchanged.
export type { AgentRunPayload } from '@copse/agent/wire-types.ts'
