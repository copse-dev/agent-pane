import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHookRegistry, mergeBlockingOutcomes, FIRST_PARTY_HOOKS } from './hook-registry.ts'
import {
  TURN_START_HOOKS,
  todoSteeringHook,
  githubLinkSteeringHook,
  todoPinHook,
  forcedPlanningHook,
  siteBuildingSteeringHook,
} from './turn-start-hooks.ts'
import {
  FORCED_PLANNING_PLUGIN_ID,
  FORCED_TODO_PLAN_PROMPT,
  FORCED_WRITTEN_PLAN_PROMPT,
  CANONICAL_THRESHOLD_SETTING,
  PLAN_TOOL_NAME,
} from '../forced-planning.ts'
import { TODO_STEERING_PROMPT, formatTodosForPrompt } from '../todo-steering.ts'
import { buildGithubLinkSteeringPrompt } from '../github-link-steering.ts'
import type { TodoItem } from '../wire-types.ts'
import { SITE_BUILDING_STEERING_PROMPT } from '../site-building-steering.ts'

const multiStepPrompt =
  'Refactor the renderer across several files and then run tests to confirm nothing broke'
const githubPrompt = 'Can you review pull request #201 and summarize open PRs?'
const plainPrompt = 'What does this function do?'

const priorTodos: TodoItem[] = [
  { id: 't1', content: 'Step one', status: 'pending' },
  { id: 't2', content: 'Step two', status: 'in_progress', assignedModel: 'local' },
]

describe('TURN_START_HOOKS registration', () => {
  it('lists the non-plugin turn-start hooks after P4 (todos moved to copse.todos)', () => {
    // The todos turn-start hooks (`todo-steering`, `todo-pin`) moved into the
    // `copse.todos` first-party plugin (P4). Only the non-todos steering hooks
    // remain in the static list; the plugin folds its two hooks in through
    // `createHookRegistry`, restoring the same registration count when
    // enabled.
    assert.deepEqual(
      TURN_START_HOOKS.map((h) => h.id),
      ['github-link-steering'],
    )
    assert.deepEqual(
      FIRST_PARTY_HOOKS.filter((h) => h.event === 'turnStart').map((h) => h.id),
      TURN_START_HOOKS.map((h) => h.id),
    )
  })
})

describe('todo-steering', () => {
  it('injects the steering prompt for multi-step work and abstains otherwise', async () => {
    assert.deepEqual(
      await todoSteeringHook.run({ userText: multiStepPrompt, priorTodos: [] }, {}),
      {
        injectContext: TODO_STEERING_PROMPT,
      },
    )
    assert.equal(
      await todoSteeringHook.run({ userText: plainPrompt, priorTodos: [] }, {}),
      undefined,
    )
  })

  it('abstains on ACP because update_todos is not a bridged tool', async () => {
    assert.equal(
      await todoSteeringHook.run(
        { userText: multiStepPrompt, priorTodos: [], executor: 'acp', toolNames: [] },
        {},
      ),
      undefined,
    )
  })
})

describe('site-building-steering', () => {
  it('injects the same quality brief for local and ACP executors', async () => {
    const userText =
      'Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio.'
    for (const executor of ['local', 'acp'] as const) {
      assert.deepEqual(
        await siteBuildingSteeringHook.run({ userText, priorTodos: [], executor }, {}),
        { injectContext: SITE_BUILDING_STEERING_PROMPT },
      )
    }
  })

  it('abstains from a site review', async () => {
    assert.equal(
      await siteBuildingSteeringHook.run(
        { userText: 'Review our coming-soon website', priorTodos: [] },
        {},
      ),
      undefined,
    )
  })
})

describe('github-link-steering', () => {
  it('resolves the slug via context and injects the markdown-link prompt', async () => {
    let called = false
    const outcome = await githubLinkSteeringHook.run(
      { userText: githubPrompt, priorTodos: [] },
      {
        resolveGithubRepoSlug: async () => {
          called = true
          return 'copse-dev/agent-pane'
        },
      },
    )
    assert.equal(called, true)
    assert.deepEqual(outcome, {
      injectContext: buildGithubLinkSteeringPrompt('copse-dev/agent-pane'),
    })
  })

  it('does not resolve the slug when the prompt does not warrant steering', async () => {
    let called = false
    const outcome = await githubLinkSteeringHook.run(
      { userText: plainPrompt, priorTodos: [] },
      {
        resolveGithubRepoSlug: async () => {
          called = true
          return 'copse-dev/agent-pane'
        },
      },
    )
    assert.equal(called, false)
    assert.equal(outcome, undefined)
  })

  it('treats a missing resolver as a null slug', async () => {
    const outcome = await githubLinkSteeringHook.run({ userText: githubPrompt, priorTodos: [] }, {})
    assert.deepEqual(outcome, { injectContext: buildGithubLinkSteeringPrompt(null) })
  })
})

describe('todo-pin', () => {
  it('pins prior todos without a leading blank-line prefix (harness adds one)', async () => {
    const outcome = await todoPinHook.run({ userText: plainPrompt, priorTodos }, {})
    const expected = formatTodosForPrompt(priorTodos).replace(/^\n+/, '')
    assert.deepEqual(outcome, { injectContext: expected })
    assert.match(expected, /^## Current plan\n/)
  })

  it('abstains when there are no prior todos', async () => {
    assert.equal(await todoPinHook.run({ userText: plainPrompt, priorTodos: [] }, {}), undefined)
  })
})

describe('forced-planning', () => {
  const weakModelTurn = {
    userText: multiStepPrompt,
    priorTodos: [],
    model: 'claude-haiku-4-5',
    toolNames: [PLAN_TOOL_NAME, 'read_file'],
  }

  it('forces the todo plan for a below-threshold model', async () => {
    assert.deepEqual(await forcedPlanningHook.run(weakModelTurn, {}), {
      injectContext: FORCED_TODO_PLAN_PROMPT,
    })
  })

  it('abstains for a frontier model and for a turn with no model id', async () => {
    assert.equal(
      await forcedPlanningHook.run({ ...weakModelTurn, model: 'claude-fable-5' }, {}),
      undefined,
    )
    assert.equal(
      await forcedPlanningHook.run({ userText: multiStepPrompt, priorTodos: [] }, {}),
      undefined,
    )
  })

  it('steers to a written plan when update_todos is not in the turn’s tool list', async () => {
    assert.deepEqual(await forcedPlanningHook.run({ ...weakModelTurn, toolNames: [] }, {}), {
      injectContext: FORCED_WRITTEN_PLAN_PROMPT,
    })
    // No tool list at all is treated the same way — never name a tool the turn
    // may not be offering.
    const { toolNames: _dropped, ...noToolList } = weakModelTurn
    assert.deepEqual(await forcedPlanningHook.run(noToolList, {}), {
      injectContext: FORCED_WRITTEN_PLAN_PROMPT,
    })
  })

  it('reads its threshold from the plugin-scoped setting via context', async () => {
    const reads: string[] = []
    const outcome = await forcedPlanningHook.run(
      { ...weakModelTurn, model: 'claude-sonnet-5' },
      {
        resolvePluginSetting: (pluginId, key) => {
          assert.equal(pluginId, FORCED_PLANNING_PLUGIN_ID)
          reads.push(key)
          // Sonnet 5 measures ~53; a 60 threshold pulls it under.
          return key === CANONICAL_THRESHOLD_SETTING ? 60 : undefined
        },
      },
    )
    assert.deepEqual(outcome, { injectContext: FORCED_TODO_PLAN_PROMPT })
    assert.ok(reads.includes(CANONICAL_THRESHOLD_SETTING))
  })
})

describe('turnStart emit — enabled todos plugin yields the expected assembly order', () => {
  it('runs the static steering hook, then the todos plugin hooks (steering + pin)', async () => {
    // Post-P4 order: static `TURN_START_HOOKS` (`github`) fire first, then the
    // `copse.todos` plugin's turn-start hooks (`todo-steering`, `todo-pin`) —
    // the plugin fold appends after the static list in `createHookRegistry`.
    const registry = createHookRegistry()
    const result = await registry.emit(
      'turnStart',
      {
        userText: `${multiStepPrompt} Also review pull request #42.`,
        priorTodos,
      },
      { resolveGithubRepoSlug: async () => 'org/repo' },
    )
    const merged = mergeBlockingOutcomes(result.outcomes)
    assert.deepEqual(
      result.outcomes.map((o) => o.hookId),
      ['github-link-steering', 'todo-steering', 'todo-pin'],
    )
    const expectedSuffix = [
      buildGithubLinkSteeringPrompt('org/repo'),
      TODO_STEERING_PROMPT,
      formatTodosForPrompt(priorTodos).replace(/^\n+/, ''),
    ].join('\n\n')
    assert.equal(merged.injectContext, expectedSuffix)
  })

  it('emits nothing for a plain prompt with no prior todos', async () => {
    const registry = createHookRegistry()
    const result = await registry.emit(
      'turnStart',
      { userText: plainPrompt, priorTodos: [] },
      { resolveGithubRepoSlug: async () => 'org/repo' },
    )
    assert.deepEqual(result.outcomes, [])
    assert.equal(mergeBlockingOutcomes(result.outcomes).injectContext, undefined)
  })
})
