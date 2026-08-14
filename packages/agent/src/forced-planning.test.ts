// Contract test: the forced-planning policy.
//
// The behavioural matrix this pins, in the house style of the steering tests:
//
// | model                | request        | prior plan | outcome                    |
// | -------------------- | -------------- | ---------- | -------------------------- |
// | below threshold      | substantive    | none       | plan forced                |
// | at/above threshold   | substantive    | none       | abstain                    |
// | below threshold      | trivial/short  | none       | abstain                    |
// | below threshold      | substantive    | live       | abstain (plan already open)|
// | unmeasured           | substantive    | none       | config-dependent           |
//
// Plus the two scales never being compared against one threshold, and the
// steering naming `update_todos` only when the tool is actually offered.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ResolvedIntellect } from '@copse/llm/intellect-lookup.ts'
import type { TodoItem } from './wire-types.ts'
import {
  decideForcedPlanning,
  resolveForcedPlanningConfig,
  CANONICAL_THRESHOLD_SETTING,
  COMPOSITE_THRESHOLD_SETTING,
  DEFAULT_CANONICAL_INTELLECT_THRESHOLD,
  DEFAULT_COMPOSITE_INTELLECT_THRESHOLD,
  DEFAULT_FORCED_PLANNING_CONFIG,
  FORCED_TODO_PLAN_PROMPT,
  FORCED_WRITTEN_PLAN_PROMPT,
  MIN_FORCED_PLAN_TEXT_LENGTH,
  PLAN_TOOL_NAME,
  UNMEASURED_MODELS_SETTING,
  type ForcedPlanningInput,
} from './forced-planning.ts'

const SUBSTANTIVE = 'Refactor the settings dialog into panels and update the tests'

function input(overrides: Partial<ForcedPlanningInput> = {}): ForcedPlanningInput {
  return {
    model: 'test-model',
    userText: SUBSTANTIVE,
    priorTodos: [],
    todosToolAvailable: true,
    ...overrides,
  }
}

function scored(
  value: number,
  scale: ResolvedIntellect['scale'] = 'canonical',
): () => ResolvedIntellect {
  const resolved: ResolvedIntellect = { value, scale, estimated: false, basis: 'test fixture' }
  return () => resolved
}

const unmeasured = (): ResolvedIntellect | null => null

function todo(status: TodoItem['status']): TodoItem {
  return { id: 't1', content: 'carried over', status }
}

describe('decideForcedPlanning', () => {
  it('forces a plan when the running model measures below the threshold', () => {
    const decision = decideForcedPlanning(input(), DEFAULT_FORCED_PLANNING_CONFIG, scored(24))
    assert.ok(decision, 'a below-threshold model must be made to plan')
    assert.equal(decision.prompt, FORCED_TODO_PLAN_PROMPT)
    assert.match(decision.prompt, new RegExp(PLAN_TOOL_NAME))
    assert.equal(decision.intellect?.value, 24)
    assert.match(decision.reason, /below the 40 threshold/)
  })

  it('abstains at or above the threshold', () => {
    const config = DEFAULT_FORCED_PLANNING_CONFIG
    assert.equal(decideForcedPlanning(input(), config, scored(59.9)), null)
    // Boundary: the threshold itself is "capable enough", not forced.
    assert.equal(
      decideForcedPlanning(input(), config, scored(DEFAULT_CANONICAL_INTELLECT_THRESHOLD)),
      null,
    )
    assert.ok(
      decideForcedPlanning(input(), config, scored(DEFAULT_CANONICAL_INTELLECT_THRESHOLD - 0.1)),
    )
  })

  it('never compares a composite score against the canonical threshold', () => {
    // 45 is above the canonical threshold (40) but below the composite one (60).
    // Reading it on the wrong ruler would flip both of these assertions.
    const config = DEFAULT_FORCED_PLANNING_CONFIG
    assert.equal(decideForcedPlanning(input(), config, scored(45, 'canonical')), null)
    assert.ok(decideForcedPlanning(input(), config, scored(45, 'composite')))
    assert.equal(
      decideForcedPlanning(
        input(),
        config,
        scored(DEFAULT_COMPOSITE_INTELLECT_THRESHOLD, 'composite'),
      ),
      null,
    )
  })

  it('abstains on requests too small to be worth planning', () => {
    const short = 'x'.repeat(MIN_FORCED_PLAN_TEXT_LENGTH - 1)
    assert.equal(
      decideForcedPlanning(input({ userText: short }), DEFAULT_FORCED_PLANNING_CONFIG, scored(24)),
      null,
    )
    // Whitespace does not buy length.
    assert.equal(
      decideForcedPlanning(
        input({ userText: `  ${short}  ` }),
        DEFAULT_FORCED_PLANNING_CONFIG,
        scored(24),
      ),
      null,
    )
  })

  it('abstains while a plan from a prior turn is still open', () => {
    const config = DEFAULT_FORCED_PLANNING_CONFIG
    for (const status of ['pending', 'in_progress'] as const) {
      assert.equal(
        decideForcedPlanning(input({ priorTodos: [todo(status)] }), config, scored(24)),
        null,
        `a ${status} todo means the model already has a plan to follow`,
      )
    }
    // A finished plan is not a live one — the next request plans again.
    for (const status of ['completed', 'cancelled'] as const) {
      assert.ok(decideForcedPlanning(input({ priorTodos: [todo(status)] }), config, scored(24)))
    }
  })

  it('abstains with no model id (nothing to threshold on)', () => {
    const config = DEFAULT_FORCED_PLANNING_CONFIG
    assert.equal(decideForcedPlanning(input({ model: undefined }), config, scored(24)), null)
    assert.equal(decideForcedPlanning(input({ model: '  ' }), config, scored(24)), null)
  })

  it('follows the unmeasured-model policy when nothing is sourced', () => {
    assert.equal(
      decideForcedPlanning(input(), DEFAULT_FORCED_PLANNING_CONFIG, unmeasured),
      null,
      'the shipped default must not change prompts on a guess',
    )
    const forced = decideForcedPlanning(
      input(),
      { ...DEFAULT_FORCED_PLANNING_CONFIG, unmeasured: 'plan' },
      unmeasured,
    )
    assert.ok(forced)
    assert.equal(forced.intellect, null)
    assert.match(forced.reason, /no sourced intellect measurement/)
  })

  it('falls back to a written plan when update_todos is not offered this turn', () => {
    const decision = decideForcedPlanning(
      input({ todosToolAvailable: false }),
      DEFAULT_FORCED_PLANNING_CONFIG,
      scored(24),
    )
    assert.ok(decision, 'the plan is still mandatory without the tool')
    assert.equal(decision.prompt, FORCED_WRITTEN_PLAN_PROMPT)
    assert.doesNotMatch(
      decision.prompt,
      new RegExp(PLAN_TOOL_NAME),
      'never name a tool the turn filtered out',
    )
  })

  it('resolves a real model through the shipped catalog by default', () => {
    // One end-to-end case without the injection seam: Claude Haiku 4.5 is
    // measured at 24 on the canonical scale, well under the default threshold.
    const decision = decideForcedPlanning(input({ model: 'claude-haiku-4-5' }))
    assert.ok(decision)
    assert.equal(decision.intellect?.scale, 'canonical')
    assert.equal(decideForcedPlanning(input({ model: 'claude-fable-5' })), null)
  })
})

describe('resolveForcedPlanningConfig', () => {
  it('uses the manifest defaults with no reader and for absent values', () => {
    assert.deepEqual(resolveForcedPlanningConfig(), DEFAULT_FORCED_PLANNING_CONFIG)
    assert.deepEqual(
      resolveForcedPlanningConfig(() => undefined),
      DEFAULT_FORCED_PLANNING_CONFIG,
    )
  })

  it('reads persisted values, coercing numeric strings', () => {
    const stored: Record<string, unknown> = {
      [CANONICAL_THRESHOLD_SETTING]: 55,
      [COMPOSITE_THRESHOLD_SETTING]: '70',
      [UNMEASURED_MODELS_SETTING]: 'plan',
    }
    assert.deepEqual(
      resolveForcedPlanningConfig((key) => stored[key]),
      {
        canonicalThreshold: 55,
        compositeThreshold: 70,
        unmeasured: 'plan',
      },
    )
  })

  it('falls back to defaults for values that would silently break the policy', () => {
    // An emptied number input arrives as NaN and a corrupted bag can hold
    // anything; either must not disable the plugin by accident.
    const junk: Record<string, unknown> = {
      [CANONICAL_THRESHOLD_SETTING]: Number.NaN,
      [COMPOSITE_THRESHOLD_SETTING]: -5,
      [UNMEASURED_MODELS_SETTING]: 'nonsense',
    }
    assert.deepEqual(
      resolveForcedPlanningConfig((key) => junk[key]),
      DEFAULT_FORCED_PLANNING_CONFIG,
    )
  })
})
