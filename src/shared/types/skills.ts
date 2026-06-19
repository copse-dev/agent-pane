export type SkillSource = 'project' | 'user' | 'plugin' | 'plugin-path'

export interface SkillSummary {
  name: string
  description: string
  source: SkillSource
  skillPath: string
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

import type { UserContent } from './llm.ts'

export interface AgentRunPayload {
  content: UserContent
  invokedSkills?: string[]
}
