// Named `stepBoundary` hooks — E1 of the hooks platform.
//
// These lift the four in-loop nudge *policies* out of `runAgentLoop`: the loop
// nudge, the stuck-finalize (context-pressure force-text) nudge, the
// truncation-continue nudge, and the reasoning-runaway force-answer nudge. Each
// hook reads the step-boundary payload and returns the nudge text
// (`injectContext`) its policy selects, or abstains. The harness still owns
// *applying* that text — pushing the user message, running the forced text-only
// turn, and tracking the once-per-run flags / reasoning-runaway streak + give-up
// terminal — so extracting only the selection keeps behavior byte-identical
// (pinned by the existing run-agent-loop / escalation / guards tests) while the
// policy leaves the loop.
//
// In-loop nudges are mid-turn message pushes inside one `runAgentLoop`
// invocation, already bounded by `maxSteps` / the run deadline; they do **not**
// count against the C3 continuation budget (decision 5) — nothing here touches a
// `ContinuationGrant`, and the harness fires this event without consuming one.
//
// `packages/agent` stays Electron-free (execution-guidance rule 4): these are
// first-party function hooks that read pure loop signals off the payload.
import type { BlockingHook } from './canonical-events.ts'
import { LOOP_NUDGE_USER_MESSAGE, STUCK_FINALIZE_NUDGE } from '../agent-loop-guards.ts'
import { shouldForceTextAnswer, shouldInjectLoopNudge } from '../agent-loop-escalation.ts'
import {
  isTruncationStopReason,
  REASONING_RUNAWAY_FORCE_ANSWER_NUDGE,
  TRUNCATION_CONTINUE_NUDGE,
} from '@copse/llm/provider-stop-reason.ts'

// Stable hook ids. The harness reads a specific nudge's outcome by id (the four
// nudges have distinct application mechanisms, so they cannot be merged into one
// injected block the way turn-start / finalize context is).
export const STUCK_FINALIZE_NUDGE_HOOK_ID = 'stuck-finalize-nudge'
export const LOOP_NUDGE_HOOK_ID = 'loop-nudge'
export const TRUNCATION_CONTINUE_HOOK_ID = 'truncation-continue'
export const REASONING_RUNAWAY_HOOK_ID = 'reasoning-runaway'

/**
 * Force a text-only answer when the conversation is under enough context
 * pressure that continuing to call tools is unproductive (`shouldForceTextAnswer`).
 * Once-per-run (`forceTextAttempted`). The harness runs the returned nudge as a
 * tool-free forced turn — this hook only decides *whether* and *with what text*.
 */
export const stuckFinalizeNudgeHook: BlockingHook<'stepBoundary'> = {
  id: STUCK_FINALIZE_NUDGE_HOOK_ID,
  event: 'stepBoundary',
  run(payload) {
    if (payload.phase !== 'preStream' || !payload.escalation) return undefined
    if (payload.forceTextAttempted) return undefined
    if (!shouldForceTextAnswer(payload.escalation.input, payload.escalation.pressure)) {
      return undefined
    }
    return { injectContext: STUCK_FINALIZE_NUDGE }
  },
}

/**
 * Nudge the model off a redundant exploration loop when pressure + tool-only
 * steps indicate it is spinning (`shouldInjectLoopNudge`). Once-per-run
 * (`loopNudgeSent`). The harness pushes the returned text as a user message.
 */
export const loopNudgeHook: BlockingHook<'stepBoundary'> = {
  id: LOOP_NUDGE_HOOK_ID,
  event: 'stepBoundary',
  run(payload) {
    if (payload.phase !== 'preStream' || !payload.escalation) return undefined
    if (payload.loopNudgeSent) return undefined
    if (!shouldInjectLoopNudge(payload.escalation.input, payload.escalation.pressure)) {
      return undefined
    }
    return { injectContext: LOOP_NUDGE_USER_MESSAGE }
  },
}

/**
 * Ask the model to continue after a length-truncated stream
 * (`isTruncationStopReason`). Fires at each post-stream truncation site; the
 * harness pushes the returned text as a user message.
 */
export const truncationContinueHook: BlockingHook<'stepBoundary'> = {
  id: TRUNCATION_CONTINUE_HOOK_ID,
  event: 'stepBoundary',
  run(payload) {
    if (payload.phase !== 'postStream') return undefined
    if (!isTruncationStopReason(payload.stopReason)) return undefined
    return { injectContext: TRUNCATION_CONTINUE_NUDGE }
  },
}

/**
 * Force a direct answer after a pure-reasoning stream tripped the loop's own
 * per-stream output cap (`streamCappedAsRunaway`) — the normal
 * truncation-continue nudge has nothing to continue and would just re-prime the
 * loop. The harness owns the reasoning-runaway *streak* and the give-up terminal
 * (a bounded loop mechanism); this hook selects the force-answer text.
 */
export const reasoningRunawayHook: BlockingHook<'stepBoundary'> = {
  id: REASONING_RUNAWAY_HOOK_ID,
  event: 'stepBoundary',
  run(payload) {
    if (payload.phase !== 'postStream') return undefined
    if (!payload.streamCappedAsRunaway) return undefined
    return { injectContext: REASONING_RUNAWAY_FORCE_ANSWER_NUDGE }
  },
}

/**
 * Step-boundary hooks in the order the previous inline blocks ran. Order among
 * the pre-stream pair mirrors the inline order (stuck-finalize evaluated before
 * loop-nudge); the harness reads each by id, so cross-nudge order is not itself
 * load-bearing, but keeping it stable keeps the spine records readable.
 */
export const STEP_BOUNDARY_HOOKS: readonly BlockingHook<'stepBoundary'>[] = [
  stuckFinalizeNudgeHook,
  loopNudgeHook,
  truncationContinueHook,
  reasoningRunawayHook,
]
