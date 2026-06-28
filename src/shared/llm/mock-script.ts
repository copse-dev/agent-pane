import type { LLMTool } from '@shared/types'

/** One step in an ordered mock script (e2e registers these via IPC). */
export interface MockScriptStep {
  /** Case-insensitive RegExp source matched against the latest user message. */
  when: string
  tool?: { name: string; args: Record<string, unknown> }
  text?: string
}

let steps: MockScriptStep[] = []
let cursor = 0

export function setMockScript(script: readonly MockScriptStep[]): void {
  steps = [...script]
  cursor = 0
}

export function clearMockScript(): void {
  steps = []
  cursor = 0
}

/** Test hook — read the script cursor without advancing. */
export function mockScriptCursorForTests(): number {
  return cursor
}

/**
 * When the current script step's `when` matches the user message, consume it and
 * return the step. Steps run in order across separate user turns (multi-turn e2e).
 */
export function takeMockScriptStep(
  userText: string,
  tools: readonly LLMTool[],
): MockScriptStep | null {
  const step = steps[cursor]
  if (!step) return null

  let pattern: RegExp
  try {
    pattern = new RegExp(step.when, 'i')
  } catch {
    return null
  }
  if (!pattern.test(userText.trim())) return null
  if (step.tool && !tools.some((t) => t.name === step.tool!.name)) return null

  cursor++
  return step
}
