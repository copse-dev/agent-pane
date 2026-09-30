import {
  blockedModelMaker,
  MODEL_MAKERS,
  parseBlockedModelMakers,
} from '@copse/llm/model-maker-block.ts'
import { getSetting } from '../storage/settings.ts'

export function isModelMakerAllowed(model: string): boolean {
  return (
    blockedModelMaker(
      model,
      parseBlockedModelMakers(getSetting<unknown>('blockedModelMakers', [])),
    ) === null
  )
}

/** Prevent a saved selection from bypassing the picker after a maker is blocked. */
export function assertModelMakerAllowed(model: string): void {
  const maker = blockedModelMaker(
    model,
    parseBlockedModelMakers(getSetting<unknown>('blockedModelMakers', [])),
  )
  if (!maker) return
  const label = MODEL_MAKERS.find((entry) => entry.id === maker)?.label ?? maker
  throw new Error(
    `${label} models are blocked in Settings → General → Models. Choose another model or remove that block.`,
  )
}
