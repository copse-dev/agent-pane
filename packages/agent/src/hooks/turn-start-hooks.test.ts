import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHookRegistry, mergeBlockingOutcomes, FIRST_PARTY_HOOKS } from './hook-registry.ts'
import {
  TURN_START_HOOKS,
  todoSteeringHook,
  githubLinkSteeringHook,
  commitSteeringHook,
  todoPinHook,
} from './turn-start-hooks.ts'
import { TODO_STEERING_PROMPT, formatTodosForPrompt } from '../todo-steering.ts'
import { buildGithubLinkSteeringPrompt } from '../github-link-steering.ts'
import { buildCommitSteeringPrompt } from '../commit-steering.ts'
import type { TodoItem } from '../wire-types.ts'

const multiStepPrompt =
  'Refactor the renderer across several files and then run tests to confirm nothing broke'
const githubPrompt = 'Can you review pull request #201 and summarize open PRs?'
const commitPrompt = 'Please create a commit for these changes'
const plainPrompt = 'What does this function do?'

const priorTodos: TodoItem[] = [
  { id: 't1', content: 'Step one', status: 'pending' },
  { id: 't2', content: 'Step two', status: 'in_progress', assignedModel: 'local' },
]

describe('TURN_START_HOOKS registration', () => {
  it('lists the non-pack turn-start hooks after P4 (todos moved to copse.todos)', () => {
    // The todos turn-start hooks (`todo-steering`, `todo-pin`) moved into the
    // `copse.todos` first-party pack (P4). Only the non-todos steering hooks
    // remain in the static list; the pack folds its two hooks in through
    // `createHookRegistry`, restoring the same registration count when
    // enabled.
    assert.deepEqual(
      TURN_START_HOOKS.map((h) => h.id),
      ['github-link-steering', 'commit-steering'],
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

describe('commit-steering', () => {
  it('injects the git_commit preference for commit prompts and abstains otherwise', async () => {
    assert.deepEqual(await commitSteeringHook.run({ userText: commitPrompt, priorTodos: [] }, {}), {
      injectContext: buildCommitSteeringPrompt(),
    })
    assert.equal(
      await commitSteeringHook.run({ userText: plainPrompt, priorTodos: [] }, {}),
      undefined,
    )
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

describe('turnStart emit — enabled todos pack yields the expected assembly order', () => {
  it('runs the two static steering hooks, then the todos pack hooks (steering + pin)', async () => {
    // Post-P4 order: static `TURN_START_HOOKS` (`github`, `commit`) fire
    // first, then the `copse.todos` pack's turn-start hooks (`todo-steering`,
    // `todo-pin`) — the pack fold appends after the static list in
    // `createHookRegistry`. This is a deliberate reordering vs the M0.2
    // inline layout: the todos pack becomes an *additive* layer whose blocks
    // sit at the end of the injected suffix, which is what allows a
    // disable of the pack to strip its contribution cleanly.
    const registry = createHookRegistry()
    const result = await registry.emit(
      'turnStart',
      {
        userText: `${multiStepPrompt} Also review pull request #42 and commit the fix.`,
        priorTodos,
      },
      { resolveGithubRepoSlug: async () => 'org/repo' },
    )
    const merged = mergeBlockingOutcomes(result.outcomes)
    assert.deepEqual(
      result.outcomes.map((o) => o.hookId),
      ['github-link-steering', 'commit-steering', 'todo-steering', 'todo-pin'],
    )
    const expectedSuffix = [
      buildGithubLinkSteeringPrompt('org/repo'),
      buildCommitSteeringPrompt(),
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
