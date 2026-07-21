import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface TerminalBenchSteering {
  schema_version: 1
  parent_trial_id: string
  diagnosis: string[]
  prompt_patch: string
  nudges: Array<{ trigger: string; message: string }>
  recommended_step_budget?: number
  confidence?: number
}

const MAX_STEERING_BYTES = 64 * 1024
const MAX_PROMPT_PATCH_CHARS = 16_000
const MAX_LIST_ITEMS = 20
const MAX_LIST_ITEM_CHARS = 4_000
const MAX_RECOMMENDED_STEP_BUDGET = 200

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseTerminalBenchSteering(value: unknown): TerminalBenchSteering {
  if (typeof value !== 'object' || value === null) {
    throw new Error('steering must be a JSON object')
  }
  const record = value as Record<string, unknown>
  if (record['schema_version'] !== 1) throw new Error('steering.schema_version must be 1')
  if (!nonEmptyString(record['parent_trial_id'])) {
    throw new Error('steering.parent_trial_id must be a non-empty string')
  }
  if (!Array.isArray(record['diagnosis']) || !record['diagnosis'].every(nonEmptyString)) {
    throw new Error('steering.diagnosis must be an array of non-empty strings')
  }
  if (
    record['diagnosis'].length > MAX_LIST_ITEMS ||
    record['diagnosis'].some((item) => item.length > MAX_LIST_ITEM_CHARS)
  ) {
    throw new Error('steering.diagnosis exceeds its item or character limit')
  }
  if (!nonEmptyString(record['prompt_patch'])) {
    throw new Error('steering.prompt_patch must be a non-empty string')
  }
  if (record['prompt_patch'].length > MAX_PROMPT_PATCH_CHARS) {
    throw new Error(`steering.prompt_patch exceeds ${String(MAX_PROMPT_PATCH_CHARS)} characters`)
  }
  if (
    !Array.isArray(record['nudges']) ||
    !record['nudges'].every(
      (nudge) =>
        typeof nudge === 'object' &&
        nudge !== null &&
        nonEmptyString(Reflect.get(nudge, 'trigger')) &&
        nonEmptyString(Reflect.get(nudge, 'message')),
    )
  ) {
    throw new Error('steering.nudges must contain trigger/message string pairs')
  }
  if (
    record['nudges'].length > MAX_LIST_ITEMS ||
    record['nudges'].some(
      (nudge) =>
        String(Reflect.get(nudge, 'trigger')).length > MAX_LIST_ITEM_CHARS ||
        String(Reflect.get(nudge, 'message')).length > MAX_LIST_ITEM_CHARS,
    )
  ) {
    throw new Error('steering.nudges exceeds its item or character limit')
  }
  const recommendedStepBudget = record['recommended_step_budget']
  if (
    recommendedStepBudget !== undefined &&
    (!Number.isInteger(recommendedStepBudget) ||
      Number(recommendedStepBudget) <= 0 ||
      Number(recommendedStepBudget) > MAX_RECOMMENDED_STEP_BUDGET)
  ) {
    throw new Error(
      `steering.recommended_step_budget must be an integer from 1 through ${String(MAX_RECOMMENDED_STEP_BUDGET)}`,
    )
  }
  const confidence = record['confidence']
  if (
    confidence !== undefined &&
    (typeof confidence !== 'number' || confidence < 0 || confidence > 1)
  ) {
    throw new Error('steering.confidence must be a number from 0 through 1')
  }

  return {
    schema_version: 1,
    parent_trial_id: record['parent_trial_id'],
    diagnosis: record['diagnosis'],
    prompt_patch: record['prompt_patch'],
    nudges: record['nudges'].map((nudge) => ({
      trigger: Reflect.get(nudge, 'trigger') as string,
      message: Reflect.get(nudge, 'message') as string,
    })),
    ...(recommendedStepBudget !== undefined
      ? { recommended_step_budget: Number(recommendedStepBudget) }
      : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  }
}

export function loadTerminalBenchSteering(path: string): {
  steering: TerminalBenchSteering
  contents: string
  interventionId: string
} {
  const contents = readFileSync(path, 'utf8')
  if (Buffer.byteLength(contents) > MAX_STEERING_BYTES) {
    throw new Error(`steering file exceeds ${String(MAX_STEERING_BYTES)} bytes`)
  }
  const steering = parseTerminalBenchSteering(JSON.parse(contents))
  const interventionId = createHash('sha256').update(contents).digest('hex').slice(0, 24)
  return { steering, contents, interventionId }
}

export function terminalBenchSteeringPrompt(steering: TerminalBenchSteering): string {
  return `A stronger reviewer inspected a previous attempt at this exact task and supplied the strategy below.
Treat it as fallible guidance: the task statement, current filesystem, and verifier tests remain authoritative.
Do not mention the review or merely discuss it; use it to improve the implementation.

${steering.prompt_patch}`
}
