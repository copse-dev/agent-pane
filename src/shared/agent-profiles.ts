/**
 * Named agent profiles (#1573): a model, an effort level and standing
 * instructions saved under a name the user can start a thread from.
 *
 * A profile is a settings feature, not a persistent agent: choosing one copies
 * its model and effort onto the thread like the composer's own pickers do, and
 * records the profile on the thread so its instructions join every turn's
 * prompt. Editing a profile later changes the instructions its threads get on
 * their next turn; the model and effort a thread already took stay its own.
 */
import { REASONING_LEVELS, type ReasoningLevel } from '@copse/llm/model-parameters.ts'
import { z } from 'zod'

export const AGENT_PROFILES_SETTING = 'agentProfiles'

export const AGENT_PROFILE_NAME_MAX = 64
export const AGENT_PROFILE_INSTRUCTIONS_MAX = 8192
export const AGENT_PROFILES_MAX = 50

export interface AgentProfile {
  /** Stable id; threads reference the profile by it. */
  id: string
  /** What the user calls it, shown in the composer and Settings. */
  name: string
  /** Model selection the profile starts a thread on (any picker value, `acp:` included). */
  model?: string | undefined
  /** Effort the profile sets on the thread; absent leaves the model's own level. */
  reasoning?: ReasoningLevel | undefined
  /** Standing instructions added to each turn of a thread using the profile. */
  instructions?: string | undefined
}

export const agentProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(AGENT_PROFILE_NAME_MAX),
  model: z.string().min(1).max(512).optional(),
  reasoning: z.enum(REASONING_LEVELS).optional(),
  instructions: z.string().max(AGENT_PROFILE_INSTRUCTIONS_MAX).optional(),
})

export const agentProfilesSchema = z
  .array(agentProfileSchema)
  .max(AGENT_PROFILES_MAX)
  .refine((profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length, {
    message: 'profile ids must be unique',
  })

/** The profile a thread names, if it still exists. */
export function findAgentProfile(
  profiles: readonly AgentProfile[] | undefined,
  id: string | undefined,
): AgentProfile | undefined {
  if (id === undefined) return undefined
  return profiles?.find((profile) => profile.id === id)
}

/**
 * The instructions block a turn carries for its profile, or nothing when the
 * profile is gone or has no instructions. Shared by the native system prompt
 * and the guidance an ACP agent receives, so both read the same text.
 */
export function agentProfilePromptBlock(profile: AgentProfile | undefined): string {
  const instructions = profile?.instructions?.trim()
  if (!profile || !instructions) return ''
  return `## Profile instructions: ${profile.name}\n\n${instructions}`
}

/**
 * A fresh id for a new profile, unique among `existing`. Always suffixed, so a
 * profile created after one with the same name was deleted never inherits the
 * old chats still holding that one's id.
 */
export function newAgentProfileId(name: string, existing: readonly AgentProfile[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'profile'
  const taken = new Set(existing.map((profile) => profile.id))
  for (;;) {
    const id = `${slug}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`
    if (!taken.has(id)) return id
  }
}
