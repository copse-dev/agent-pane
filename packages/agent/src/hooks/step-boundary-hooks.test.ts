import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  loopNudgeHook,
  LOOP_NUDGE_HOOK_ID,
  reasoningRunawayHook,
  REASONING_RUNAWAY_HOOK_ID,
  STEP_BOUNDARY_HOOKS,
  stuckFinalizeNudgeHook,
  STUCK_FINALIZE_NUDGE_HOOK_ID,
  truncationContinueHook,
  TRUNCATION_CONTINUE_HOOK_ID,
} from './step-boundary-hooks.ts'
import { createHookRegistry, FIRST_PARTY_HOOKS, type HookEmitResult } from './hook-registry.ts'
import type { StepBoundaryEscalation, StepBoundaryPayload } from './canonical-events.ts'
import { measureConversationPressure, type EscalationInput } from '../agent-loop-escalation.ts'
import { LOOP_NUDGE_USER_MESSAGE, STUCK_FINALIZE_NUDGE } from '../agent-loop-guards.ts'
import {
  REASONING_RUNAWAY_FORCE_ANSWER_NUDGE,
  TRUNCATION_CONTINUE_NUDGE,
} from '@copse/llm/provider-stop-reason.ts'

const sys: LLMMessage = { role: 'system', content: 'system prompt' }

/** Build a preStream escalation snapshot from crafted messages + step counts. */
function escalation(
  messages: LLMMessage[],
  toolOnlySteps: number,
  trimEvents: number,
  maxContextTokens = 8192,
): StepBoundaryEscalation {
  const input: EscalationInput = {
    messages,
    maxContextTokens,
    toolSchemaReserveTokens: 2500,
    toolOnlySteps,
    trimEvents,
  }
  return { input, pressure: measureConversationPressure(input) }
}

/** High-fill snapshot: `shouldInjectLoopNudge` fires (mirrors escalation test). */
const loopNudgeFires = escalation(
  [
    sys,
    { role: 'user', content: 'x'.repeat(20_000) },
    { role: 'assistant', content: 'y'.repeat(20_000) },
  ],
  2,
  0,
)

/** Trim + fill + steps snapshot: `shouldForceTextAnswer` fires. */
const forceTextFires = escalation(
  [
    sys,
    { role: 'user', content: 'x'.repeat(24_000) },
    { role: 'assistant', content: 'y'.repeat(24_000) },
  ],
  3,
  2,
  15_050,
)

/** Small thread: neither escalation nudge fires. */
const calm = escalation([sys, { role: 'user', content: 'hi' }], 0, 0)

function preStream(over: Partial<StepBoundaryPayload> = {}): StepBoundaryPayload {
  return {
    phase: 'preStream',
    loopNudgeSent: false,
    forceTextAttempted: false,
    streamCappedAsRunaway: false,
    ...over,
  }
}

function postStream(over: Partial<StepBoundaryPayload> = {}): StepBoundaryPayload {
  return {
    phase: 'postStream',
    loopNudgeSent: false,
    forceTextAttempted: false,
    streamCappedAsRunaway: false,
    ...over,
  }
}

describe('STEP_BOUNDARY_HOOKS registration', () => {
  it('lists the four named nudge hooks in inline order and joins FIRST_PARTY_HOOKS', () => {
    assert.deepEqual(
      STEP_BOUNDARY_HOOKS.map((h) => h.id),
      ['stuck-finalize-nudge', 'loop-nudge', 'truncation-continue', 'reasoning-runaway'],
    )
    assert.deepEqual(
      FIRST_PARTY_HOOKS.filter((h) => h.event === 'stepBoundary').map((h) => h.id),
      STEP_BOUNDARY_HOOKS.map((h) => h.id),
    )
  })
})

describe('stuck-finalize-nudge', () => {
  it('injects STUCK_FINALIZE_NUDGE when force-text pressure fires and not yet attempted', async () => {
    assert.deepEqual(
      await stuckFinalizeNudgeHook.run(preStream({ escalation: forceTextFires }), {}),
      { injectContext: STUCK_FINALIZE_NUDGE },
    )
  })

  it('abstains once forceTextAttempted (once-per-run gate)', async () => {
    assert.equal(
      await stuckFinalizeNudgeHook.run(
        preStream({ escalation: forceTextFires, forceTextAttempted: true }),
        {},
      ),
      undefined,
    )
  })

  it('abstains when force-text pressure does not fire', async () => {
    assert.equal(await stuckFinalizeNudgeHook.run(preStream({ escalation: calm }), {}), undefined)
  })

  it('abstains outside preStream / without escalation signals', async () => {
    assert.equal(await stuckFinalizeNudgeHook.run(preStream(), {}), undefined)
    assert.equal(
      await stuckFinalizeNudgeHook.run(postStream({ stopReason: 'max_tokens' }), {}),
      undefined,
    )
  })
})

describe('loop-nudge', () => {
  it('injects LOOP_NUDGE_USER_MESSAGE when loop pressure fires and not yet sent', async () => {
    assert.deepEqual(await loopNudgeHook.run(preStream({ escalation: loopNudgeFires }), {}), {
      injectContext: LOOP_NUDGE_USER_MESSAGE,
    })
  })

  it('abstains once loopNudgeSent (once-per-run gate)', async () => {
    assert.equal(
      await loopNudgeHook.run(preStream({ escalation: loopNudgeFires, loopNudgeSent: true }), {}),
      undefined,
    )
  })

  it('abstains when loop pressure does not fire and outside preStream', async () => {
    assert.equal(await loopNudgeHook.run(preStream({ escalation: calm }), {}), undefined)
    assert.equal(await loopNudgeHook.run(postStream(), {}), undefined)
  })
})

describe('truncation-continue', () => {
  it('injects TRUNCATION_CONTINUE_NUDGE for a length-truncated stream', async () => {
    for (const stopReason of ['max_tokens', 'length']) {
      assert.deepEqual(await truncationContinueHook.run(postStream({ stopReason }), {}), {
        injectContext: TRUNCATION_CONTINUE_NUDGE,
      })
    }
  })

  it('abstains for a non-truncation stop reason and outside postStream', async () => {
    assert.equal(
      await truncationContinueHook.run(postStream({ stopReason: 'end_turn' }), {}),
      undefined,
    )
    assert.equal(await truncationContinueHook.run(postStream(), {}), undefined)
    assert.equal(
      await truncationContinueHook.run(preStream({ escalation: loopNudgeFires }), {}),
      undefined,
    )
  })
})

describe('reasoning-runaway', () => {
  it('injects REASONING_RUNAWAY_FORCE_ANSWER_NUDGE when the stream was capped as runaway', async () => {
    assert.deepEqual(
      await reasoningRunawayHook.run(
        postStream({ stopReason: 'max_tokens', streamCappedAsRunaway: true }),
        {},
      ),
      { injectContext: REASONING_RUNAWAY_FORCE_ANSWER_NUDGE },
    )
  })

  it('abstains when the stream was not capped as runaway and outside postStream', async () => {
    assert.equal(
      await reasoningRunawayHook.run(postStream({ stopReason: 'max_tokens' }), {}),
      undefined,
    )
    assert.equal(
      await reasoningRunawayHook.run(preStream({ escalation: loopNudgeFires }), {}),
      undefined,
    )
  })
})

describe('stepBoundary emit — per-hook nudge selection by id (as the loop reads it)', () => {
  const nudge = (result: HookEmitResult, id: string): string | undefined =>
    result.outcomes.find((o) => o.hookId === id)?.outcome.injectContext

  it('preStream selects stuck-finalize + loop nudges independently, no truncation/runaway', async () => {
    const registry = createHookRegistry()
    const result = await registry.emit(
      'stepBoundary',
      preStream({ escalation: forceTextFires }),
      {},
    )
    // forceTextFires also satisfies the loop-nudge thresholds, so both fire.
    assert.equal(nudge(result, STUCK_FINALIZE_NUDGE_HOOK_ID), STUCK_FINALIZE_NUDGE)
    assert.equal(nudge(result, LOOP_NUDGE_HOOK_ID), LOOP_NUDGE_USER_MESSAGE)
    assert.equal(nudge(result, TRUNCATION_CONTINUE_HOOK_ID), undefined)
    assert.equal(nudge(result, REASONING_RUNAWAY_HOOK_ID), undefined)
  })

  it('postStream selects truncation + reasoning-runaway nudges, no pre-stream nudges', async () => {
    const registry = createHookRegistry()
    const result = await registry.emit(
      'stepBoundary',
      postStream({ stopReason: 'max_tokens', streamCappedAsRunaway: true }),
      {},
    )
    assert.equal(nudge(result, TRUNCATION_CONTINUE_HOOK_ID), TRUNCATION_CONTINUE_NUDGE)
    assert.equal(nudge(result, REASONING_RUNAWAY_HOOK_ID), REASONING_RUNAWAY_FORCE_ANSWER_NUDGE)
    assert.equal(nudge(result, STUCK_FINALIZE_NUDGE_HOOK_ID), undefined)
    assert.equal(nudge(result, LOOP_NUDGE_HOOK_ID), undefined)
  })

  it('emits nothing when nothing applies (calm preStream / plain postStream)', async () => {
    const registry = createHookRegistry()
    assert.deepEqual(
      (await registry.emit('stepBoundary', preStream({ escalation: calm }), {})).outcomes,
      [],
    )
    assert.deepEqual(
      (await registry.emit('stepBoundary', postStream({ stopReason: 'end_turn' }), {})).outcomes,
      [],
    )
  })
})
