import type { UserContent } from '@shared/types'
import type { AgentRunPayload } from '@shared/types/skills.ts'

export function parseAgentRunPayload(rawPrompt: string): {
  userContent: UserContent
  invokedSkills: string[]
} {
  try {
    const parsed = JSON.parse(rawPrompt) as AgentRunPayload | UserContent
    if (parsed && typeof parsed === 'object' && 'content' in parsed) {
      const payload = parsed as AgentRunPayload
      return {
        userContent: payload.content,
        invokedSkills: payload.invokedSkills ?? [],
      }
    }
    return { userContent: parsed as UserContent, invokedSkills: [] }
  } catch {
    return { userContent: rawPrompt, invokedSkills: [] }
  }
}
