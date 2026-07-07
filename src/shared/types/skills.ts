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
  skillRoot: string
  disableModelInvocation: boolean
  paths: string[]
}

export interface SkillReadResult {
  name: string
  description: string
  skillRoot: string
  skillPath: string
  body: string
  relativePath: string
}

// The run payload is owned by the agent module (`parseAgentRunPayload` parses
// it back — the loop's run input); re-exported here so `@shared/types`
// consumers are unchanged.
export type { AgentRunPayload } from '@copse/agent/wire-types.ts'
