import { parseModelSelection } from './model-selection.ts'
import { CHATGPT_PLAN_MODEL_PREFIX } from './reserved-prefixes.ts'

export function chatGptPlanModelValue(clientId: string, model: string): string {
  return `${CHATGPT_PLAN_MODEL_PREFIX}${clientId}#${model}`
}

export function parseChatGptPlanModel(value: string): { clientId: string; model: string } | null {
  const selection = parseModelSelection(value)
  if (selection.namespace !== 'chatgpt-plan') return null
  if (!selection.agent || !selection.id) throw new Error('Choose a ChatGPT account and model.')
  return { clientId: selection.agent, model: selection.id }
}

/**
 * Whether `value` selects a ChatGPT plan model, complete or not. Such a model
 * signs in with OAuth, and a refresh may rotate the refresh token, so only a
 * process that can save the profile's settings may run it.
 */
export function isChatGptPlanModel(value: string): boolean {
  return parseModelSelection(value).namespace === 'chatgpt-plan'
}
