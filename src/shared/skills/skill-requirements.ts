import { z } from 'zod'

const names = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.:-]+$/),
  )
  .max(32)

/** Explicit requirements only; descriptive compatibility/allowed-tools never grants authority. */
export const skillRequirementsSchema = z.strictObject({
  tools: names.optional(),
  agents: names.optional(),
  executors: z
    .array(z.enum(['native', 'acp', 'subagent']))
    .min(1)
    .max(3)
    .optional(),
})

export type SkillRequirements = z.infer<typeof skillRequirementsSchema>
export type SkillExecutor = 'native' | 'acp' | 'subagent'
export type SkillCapabilityState =
  | 'supported'
  | 'unavailable'
  | 'disabled'
  | 'unsupported'
  | 'untested'

export interface SkillCapabilityCheck {
  kind: 'tool' | 'agent' | 'dependency' | 'executor' | 'supporting-file'
  name: string
  state: SkillCapabilityState
  reason: string
}

export interface SkillPreflightResult {
  /** Satisfying declarations never establishes end-to-end model/workflow compatibility. */
  status: 'blocked' | 'untested'
  checks: SkillCapabilityCheck[]
}
