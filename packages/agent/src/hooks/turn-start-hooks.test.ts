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
  it('lists the four named hooks in the previous inline order', () => {
    assert.deepEqual(
      TURN_START_HOOKS.map((h) => h.id),
      ['todo-steering', 'github-link-steering', 'commit-steering', 'todo-pin'],
    )
    assert.deepEqual(
      FIRST_PARTY_HOOKS.map((h) => h.id),
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

describe('turnStart emit — byte-identical assembly vs previous inline order', () => {
  it('concatenates steering + pin the way runAgent used to', async () => {
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
      ['todo-steering', 'github-link-steering', 'commit-steering', 'todo-pin'],
    )
    // Previous inline: content + `\n\n` + blocks.join(`\n\n`) + formatTodosForPrompt(...)
    // where formatTodosForPrompt already starts with `\n\n`. Harness now does
    // content + `\n\n` + merged.injectContext — so injectContext must equal the
    // old suffix after that leading `\n\n`.
    const expectedSuffix = [
      TODO_STEERING_PROMPT,
      buildGithubLinkSteeringPrompt('org/repo'),
      buildCommitSteeringPrompt(),
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
