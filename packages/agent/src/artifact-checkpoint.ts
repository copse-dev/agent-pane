import type { BlockingHook } from './hooks/canonical-events.ts'

/** Experimental plugin and hook identities. */
export const ARTIFACT_CHECKPOINT_PLUGIN_ID = 'copse.artifact-checkpoint'
export const ARTIFACT_CHECKPOINT_HOOK_ID = 'artifact-checkpoint'

/** Plugin-scoped delay before the once-per-run checkpoint is eligible. */
export const ARTIFACT_CHECKPOINT_DELAY_MINUTES_SETTING = 'delayMinutes'
export const DEFAULT_ARTIFACT_CHECKPOINT_DELAY_MINUTES = 8
export const MAX_ARTIFACT_CHECKPOINT_DELAY_MINUTES = 60

export const ARTIFACT_CHECKPOINT_NUDGE =
  'The run is taking longer than expected. Preserve the best runnable artifact now before further exploration. Then use the remaining time for focused validation and fixes.'

/**
 * Coerce the persisted delay into a bounded whole-minute threshold. Enabling or
 * disabling the behavior belongs to the plugin toggle; this setting only moves
 * its checkpoint within a run.
 */
export function resolveArtifactCheckpointDelayMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return DEFAULT_ARTIFACT_CHECKPOINT_DELAY_MINUTES
  }
  return Math.min(Math.max(Math.round(raw), 1), MAX_ARTIFACT_CHECKPOINT_DELAY_MINUTES)
}

/**
 * Once a run crosses its configured wall-clock threshold, ask the model to
 * preserve a runnable artifact before it spends more time exploring. The loop
 * owns the once-per-run flag and applies the selected text as a tool-enabled
 * message; this hook owns only the policy and text.
 */
export const artifactCheckpointHook: BlockingHook<'stepBoundary'> = {
  id: ARTIFACT_CHECKPOINT_HOOK_ID,
  event: 'stepBoundary',
  run(payload, context) {
    if (
      payload.phase !== 'preStream' ||
      !payload.artifactCheckpointEligible ||
      payload.artifactCheckpointSent
    ) {
      return undefined
    }
    if (context.signal?.aborted) return undefined
    const delayMinutes = resolveArtifactCheckpointDelayMinutes(
      context.resolvePluginSetting?.(
        ARTIFACT_CHECKPOINT_PLUGIN_ID,
        ARTIFACT_CHECKPOINT_DELAY_MINUTES_SETTING,
      ),
    )
    if (payload.elapsedWallTimeMs < delayMinutes * 60_000) return undefined
    if (payload.remainingWallTimeMs <= 0) return undefined
    return { injectContext: ARTIFACT_CHECKPOINT_NUDGE }
  },
}
