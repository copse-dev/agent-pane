import type { LLMMessage, UserContent } from '@copse/llm/wire-types.ts'
import { clipStart } from './clip-text.ts'

export const WORKING_BRIEF_MAX_LEN = 2000

/** Derive storable brief text from a user turn (text blocks only). */
export function workingBriefFromUserContent(content: UserContent): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? clipStart(trimmed, WORKING_BRIEF_MAX_LEN) : null
  }
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text ? clipStart(text, WORKING_BRIEF_MAX_LEN) : null
}

/** Fallback when no persisted thread working brief is available. */
export function extractParentGoal(messages: LLMMessage[], userPrompt: UserContent): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (lastUser && typeof lastUser.content === 'string') {
    return clipStart(lastUser.content, WORKING_BRIEF_MAX_LEN)
  }
  if (typeof userPrompt === 'string') return clipStart(userPrompt, WORKING_BRIEF_MAX_LEN)
  return '(complex user input)'
}

/** Prefer persisted thread goal; fall back to last user message per run. */
export function resolveParentGoal(
  workingBrief: string | undefined,
  messages: LLMMessage[],
  userPrompt: UserContent,
): string {
  return workingBrief ?? extractParentGoal(messages, userPrompt)
}

/**
 * Set working brief on the first user message; leave unchanged on follow-ups until
 * an explicit goal update API exists.
 */
export function nextWorkingBrief(
  current: string | undefined,
  userContent: UserContent,
): string | undefined {
  if (current) return current
  return workingBriefFromUserContent(userContent) ?? undefined
}
