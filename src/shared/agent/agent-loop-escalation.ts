import type { LLMMessage } from '@shared/types'
import { conversationTokenBudget, effectiveConversationTokens } from './trim-history.ts'

export const SOFT_NUDGE_FILL_RATIO = 0.7
export const FORCE_TEXT_FILL_RATIO = 0.85
export const MID_FILL_RATIO = 0.5

export interface EscalationThresholds {
  softNudgeMinToolSteps: number
  forceTextMinToolSteps: number
}

export interface EscalationInput {
  messages: LLMMessage[]
  maxContextTokens: number
  toolSchemaReserveTokens: number
  toolOnlySteps: number
  trimEvents: number
}

export interface ConversationPressure {
  conversationBudget: number
  conversationTokens: number
  fillRatio: number
  thresholds: EscalationThresholds
}

/** Scale step fallbacks with available conversation budget (chars ≈ tokens×4). */
export function escalationThresholds(conversationBudget: number): EscalationThresholds {
  const soft = Math.max(3, Math.floor(conversationBudget / 4000))
  const force = Math.max(soft + 2, Math.floor(conversationBudget / 2500))
  return { softNudgeMinToolSteps: soft, forceTextMinToolSteps: force }
}

export function measureConversationPressure(input: EscalationInput): ConversationPressure {
  const { messages, maxContextTokens, toolSchemaReserveTokens } = input
  const conversationBudget = conversationTokenBudget(messages, maxContextTokens, {
    reserveTokens: toolSchemaReserveTokens,
  })
  const conversationTokens = effectiveConversationTokens(messages)
  const fillRatio = conversationTokens / conversationBudget
  return {
    conversationBudget,
    conversationTokens,
    fillRatio,
    thresholds: escalationThresholds(conversationBudget),
  }
}

export function shouldInjectLoopNudge(
  input: EscalationInput,
  pressure?: ConversationPressure,
): boolean {
  const p = pressure ?? measureConversationPressure(input)
  const { toolOnlySteps, trimEvents } = input
  const { fillRatio, thresholds } = p

  if (trimEvents >= 1 && toolOnlySteps >= 3 && fillRatio >= MID_FILL_RATIO) return true
  if (fillRatio >= SOFT_NUDGE_FILL_RATIO && toolOnlySteps >= 2) return true
  if (fillRatio >= MID_FILL_RATIO && toolOnlySteps >= thresholds.softNudgeMinToolSteps) return true
  if (toolOnlySteps >= thresholds.softNudgeMinToolSteps + 2) return true
  return false
}

export function shouldForceTextAnswer(
  input: EscalationInput,
  pressure?: ConversationPressure,
): boolean {
  const p = pressure ?? measureConversationPressure(input)
  const { toolOnlySteps, trimEvents } = input
  const { fillRatio, thresholds } = p

  if (trimEvents >= 2 && fillRatio >= MID_FILL_RATIO && toolOnlySteps >= 2) return true
  if (fillRatio >= FORCE_TEXT_FILL_RATIO && toolOnlySteps >= thresholds.forceTextMinToolSteps) {
    return true
  }
  if (toolOnlySteps >= thresholds.forceTextMinToolSteps + 1) return true
  return false
}
