import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  branchStatusLookupKey,
  parseDiffNumstat,
  porcelainHasMergeConflicts,
  ghPrHasCiFailures,
  ghPrHasMergeConflicts,
  parseGhOpenPr,
  parseGhOpenPrList,
} from './github/pr-context-service.ts'
import {
  buildPluginFollowUps,
  buildDeterministicFollowUps,
  fillFollowUpSuggestions,
  pluginFollowUpConditionMet,
  parseModelFollowUpIds,
} from './follow-up-service.ts'
import { buildContinuePlanSuggestion } from '@shared/follow-ups/presets.ts'
import { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { definePlugin, type RegisteredPlugin } from '@copse/agent/plugins/plugin-manifest.ts'
import { runWithDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'

describe('branchStatusLookupKey', () => {
  it('does not coalesce identical paths and branches across projects', () => {
    // Local and SSH projects can legitimately use the same path string. The
    // coalescer is process-global, so root + branch alone could make a newly
    // active project join the previous project's in-flight GitHub result.
    assert.notEqual(
      branchStatusLookupKey('local-project', '/workspace/repo', 'main'),
      branchStatusLookupKey('ssh-project', '/workspace/repo', 'main'),
    )
  })
})

describe('parseDiffNumstat', () => {
  it('sums additions and deletions', () => {
    const raw = '3\t1\tfile.ts\0\n10\t5\tother.ts\n'
    assert.deepEqual(parseDiffNumstat(raw), { additions: 13, deletions: 6 })
  })

  it('ignores binary placeholder dashes', () => {
    const raw = '-\t-\tbinary.png\n2\t0\ttext.ts\n'
    assert.deepEqual(parseDiffNumstat(raw), { additions: 2, deletions: 0 })
  })
})

describe('porcelainHasMergeConflicts', () => {
  it('detects unmerged paths', () => {
    const raw = 'UU src/conflict.ts\0'
    assert.equal(porcelainHasMergeConflicts(raw), true)
  })

  it('returns false for a clean tree', () => {
    const raw = ' M src/foo.ts\0'
    assert.equal(porcelainHasMergeConflicts(raw), false)
  })
})

describe('gh PR helpers', () => {
  it('detects CI failures', () => {
    assert.equal(
      ghPrHasCiFailures({
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      }),
      true,
    )
  })

  it('detects merge conflicts from mergeable', () => {
    assert.equal(ghPrHasMergeConflicts({ mergeable: 'CONFLICTING' }), true)
    assert.equal(ghPrHasMergeConflicts({ mergeable: 'MERGEABLE' }), false)
  })
})

describe('parseGhOpenPr', () => {
  it('returns PR details for an open PR', () => {
    assert.deepEqual(
      parseGhOpenPr(
        JSON.stringify({
          state: 'OPEN',
          number: 42,
          title: 'Add feature',
          url: 'https://github.com/org/repo/pull/42',
        }),
      ),
      {
        number: 42,
        title: 'Add feature',
        url: 'https://github.com/org/repo/pull/42',
      },
    )
  })

  it('returns null for closed PRs', () => {
    assert.equal(
      parseGhOpenPr(JSON.stringify({ state: 'MERGED', number: 1, url: 'https://x' })),
      null,
    )
  })

  it('returns null for invalid JSON', () => {
    assert.equal(parseGhOpenPr('not json'), null)
  })
})

describe('parseGhOpenPrList', () => {
  it('returns the first PR from a list response', () => {
    assert.deepEqual(
      parseGhOpenPrList(
        JSON.stringify([
          {
            number: 7,
            title: 'Feature branch PR',
            url: 'https://github.com/org/repo/pull/7',
          },
        ]),
      ),
      {
        number: 7,
        title: 'Feature branch PR',
        url: 'https://github.com/org/repo/pull/7',
      },
    )
  })

  it('returns null for an empty list', () => {
    assert.equal(parseGhOpenPrList('[]'), null)
  })
})

describe('parseModelFollowUpIds', () => {
  it('parses a JSON array from model output', () => {
    assert.deepEqual(parseModelFollowUpIds('Here: ["run-tests", "explain"]'), [
      'run-tests',
      'explain',
    ])
  })

  it('returns empty array on invalid JSON', () => {
    assert.deepEqual(parseModelFollowUpIds('no json here'), [])
  })
})

describe('plugin-contributed follow-up bubbles', () => {
  const dirty = { changeStats: { additions: 3, deletions: 1 } }
  const clean = { changeStats: null }

  function withPlugin(plugin: RegisteredPlugin, run: () => void): void {
    const registry = new PluginRegistry()
    registry.register(plugin)
    runWithDefaultPluginRegistry(registry, run)
  }

  it('offers an enabled plugin’s bubble, mapping its action through', () => {
    withPlugin(
      definePlugin(
        { name: 'copse.test-offers', trust: 'first-party', stability: 'experimental' },
        {
          followUps: [
            { id: 'compare', label: 'Compare models', action: 'model-compare' },
            { id: 'tidy', label: 'Tidy up', prompt: 'Tidy the diff.' },
          ],
        },
      ),
      () => {
        assert.deepEqual(buildPluginFollowUps(dirty), [
          { id: 'compare', label: 'Compare models', action: 'model-compare' },
          { id: 'tidy', label: 'Tidy up', action: 'prompt', prompt: 'Tidy the diff.' },
        ])
      },
    )
  })

  it('honours the `when` condition against the workspace', () => {
    withPlugin(
      definePlugin(
        { name: 'copse.test-gated', trust: 'first-party', stability: 'experimental' },
        {
          followUps: [
            {
              id: 'gated',
              label: 'Needs a diff',
              action: 'model-compare',
              when: 'workspace-changes',
            },
            { id: 'ungated', label: 'Any time', prompt: 'Go on.', when: 'always' },
          ],
        },
      ),
      () => {
        assert.deepEqual(
          buildPluginFollowUps(dirty).map((s) => s.id),
          ['gated', 'ungated'],
        )
        // A clean tree has no working diff for the reviewers to read, so the
        // gated bubble must not offer a comparison of nothing.
        assert.deepEqual(
          buildPluginFollowUps(clean).map((s) => s.id),
          ['ungated'],
        )
      },
    )
  })

  it('offers nothing once the owning plugin is disabled', () => {
    const registry = new PluginRegistry()
    registry.register(
      definePlugin(
        { name: 'copse.test-off', trust: 'first-party', stability: 'experimental' },
        { followUps: [{ id: 'gone', label: 'Compare models', action: 'model-compare' }] },
      ),
    )
    registry.disable('copse.test-off')
    runWithDefaultPluginRegistry(registry, () => {
      assert.deepEqual(buildPluginFollowUps(dirty), [])
    })
  })
})

describe('pluginFollowUpConditionMet', () => {
  it('treats a null changeStats as a clean tree', () => {
    assert.equal(pluginFollowUpConditionMet('workspace-changes', { changeStats: null }), false)
    assert.equal(
      pluginFollowUpConditionMet('workspace-changes', {
        changeStats: { additions: 0, deletions: 2 },
      }),
      true,
    )
    assert.equal(pluginFollowUpConditionMet('always', { changeStats: null }), true)
  })
})

describe('continue-plan deterministic bubble', () => {
  const workspaceCtx = {
    branch: 'main',
    hasOpenPr: false,
    hasMergeConflicts: false,
    hasCiFailures: false,
    changeStats: null,
    canOpenPr: false,
  }

  it('leads with the plan when open todos survive the turn', () => {
    const suggestions = buildDeterministicFollowUps(workspaceCtx, {
      userMessage: 'ship it',
      assistantMessage: 'Done, mostly.',
      toolNames: [],
      openTodos: ['Write unit tests', 'Update changelog'],
    })
    assert.deepEqual(
      suggestions.map((s) => s.id),
      ['continue-plan'],
    )
    const plan = suggestions[0]
    assert.ok(plan)
    assert.match(plan.label, /^Continue: Write unit tests$/)
    // The prompt carries every open item so a click resumes the whole
    // remaining plan, not just its first line.
    assert.match(plan.prompt ?? '', /- Write unit tests/)
    assert.match(plan.prompt ?? '', /- Update changelog/)
  })

  it('offers nothing when the plan was fully reconciled', () => {
    const suggestions = buildDeterministicFollowUps(workspaceCtx, {
      userMessage: 'ship it',
      assistantMessage: 'Done.',
      toolNames: [],
    })
    assert.deepEqual(suggestions, [])
  })
})

describe('create-pr deterministic bubble', () => {
  const base = {
    branch: 'feature/x',
    hasOpenPr: false,
    hasMergeConflicts: false,
    hasCiFailures: false,
    changeStats: { additions: 118, deletions: 36 },
    canOpenPr: true,
  }
  const turn = { userMessage: 'make a pr', assistantMessage: 'Done.', toolNames: [] }

  it('offers the PR bubble right after the changeset chip', () => {
    assert.deepEqual(
      buildDeterministicFollowUps(base, turn).map((s) => s.id),
      ['changes', 'create-pr'],
    )
  })

  it('opens the dialog rather than sending a prompt', () => {
    const pr = buildDeterministicFollowUps(base, turn).find((s) => s.id === 'create-pr')
    assert.ok(pr, 'the create-pr bubble should be offered')
    assert.equal(pr.action, 'create-pr')
    // The create runs with no model in the loop, so there is no prompt for a
    // caller to fall back to sending.
    assert.equal(pr.prompt, undefined)
  })

  it('stays offered once the agent has committed and git status is clean', () => {
    // canOpenPr covers committed-but-unpublished work, which is exactly the
    // state a turn that ends in a commit leaves behind.
    const suggestions = buildDeterministicFollowUps({ ...base, changeStats: null }, turn)
    assert.deepEqual(
      suggestions.map((s) => s.id),
      ['create-pr'],
    )
  })

  it('is withheld when the branch already has an open PR', () => {
    const suggestions = buildDeterministicFollowUps(
      { ...base, hasOpenPr: true, canOpenPr: false },
      turn,
    )
    assert.equal(
      suggestions.some((s) => s.id === 'create-pr'),
      false,
    )
  })
})

describe('fillFollowUpSuggestions', () => {
  const workspace = {
    branch: 'feature/x',
    hasOpenPr: false,
    hasMergeConflicts: false,
    hasCiFailures: false,
    changeStats: { additions: 3, deletions: 1 },
    canOpenPr: true,
  }
  const turn = {
    userMessage: 'Implement the change',
    assistantMessage: 'Implementation is ready; validation remains.',
    toolNames: ['write_file'],
  }

  it('skips inference when plan, changes, and PR suggestions fill the visible slots', async () => {
    const prioritized = buildDeterministicFollowUps(workspace, {
      ...turn,
      openTodos: ['Validate the change'],
    })
    const pickModel = mock.fn(() => Promise.resolve([{ id: 'run-tests', label: 'Run tests' }]))
    const result = await fillFollowUpSuggestions(prioritized, pickModel)
    assert.deepEqual(
      result.map((suggestion) => suggestion.id),
      ['continue-plan', 'changes', 'create-pr'],
    )
    assert.deepEqual(result, prioritized)
    assert.equal(pickModel.mock.callCount(), 0)
  })

  it('skips inference when a plugin fills the remaining slot', async () => {
    const deterministic = buildDeterministicFollowUps(workspace, turn)
    const registry = new PluginRegistry()
    registry.register(
      definePlugin(
        { name: 'copse.test-follow-up-budget', trust: 'first-party', stability: 'experimental' },
        { followUps: [{ id: 'compare', label: 'Compare models', action: 'model-compare' }] },
      ),
    )
    const plugins = runWithDefaultPluginRegistry(registry, () => buildPluginFollowUps(workspace))
    const pickModel = mock.fn(() => Promise.resolve([{ id: 'explain', label: 'Explain' }]))
    const result = await fillFollowUpSuggestions([...deterministic, ...plugins], pickModel)
    assert.deepEqual(result, [...deterministic, ...plugins])
    assert.equal(result.length, 3)
    assert.equal(pickModel.mock.callCount(), 0)
  })

  it('calls the model once when a slot opens after the plan completes', async () => {
    const pickModel = mock.fn(() =>
      Promise.resolve([
        { id: 'run-tests', label: 'Run tests' },
        { id: 'continue', label: 'Keep going' },
      ]),
    )
    const before = buildDeterministicFollowUps(workspace, {
      ...turn,
      openTodos: ['Validate the change'],
    })
    await fillFollowUpSuggestions(before, pickModel)
    assert.equal(pickModel.mock.callCount(), 0)
    const after = buildDeterministicFollowUps(workspace, turn)
    const result = await fillFollowUpSuggestions(after, pickModel)
    assert.deepEqual(result, [...after, { id: 'run-tests', label: 'Run tests' }])
    assert.equal(pickModel.mock.callCount(), 1)
  })

  it('deduplicates prioritized ids before deciding whether the model is needed', async () => {
    const prioritized = buildDeterministicFollowUps(workspace, turn)
    const pickModel = mock.fn(() =>
      Promise.resolve([
        { id: 'changes', label: 'Duplicate changes' },
        { id: 'run-tests', label: 'Run tests' },
      ]),
    )
    const result = await fillFollowUpSuggestions([...prioritized, ...prioritized], pickModel)
    assert.deepEqual(result, [...prioritized, { id: 'run-tests', label: 'Run tests' }])
    assert.equal(pickModel.mock.callCount(), 1)
  })

  it('preserves priority and the cap when branch facts alone exceed three slots', async () => {
    const prioritized = buildDeterministicFollowUps(
      {
        ...workspace,
        hasOpenPr: true,
        canOpenPr: false,
        hasCiFailures: true,
        hasMergeConflicts: true,
      },
      { ...turn, openTodos: ['Finish validation'] },
    )
    const pickModel = mock.fn(() => Promise.resolve([]))
    const result = await fillFollowUpSuggestions(prioritized, pickModel)
    assert.equal(prioritized.length, 4)
    assert.deepEqual(result, prioritized.slice(0, 3))
    assert.equal(pickModel.mock.callCount(), 0)
  })

  it('still returns model suggestions when there are no higher-priority suggestions', async () => {
    const suggestions = [
      { id: 'explain', label: 'Explain' },
      { id: 'run-tests', label: 'Run tests' },
    ]
    const pickModel = mock.fn(() => Promise.resolve(suggestions))
    assert.deepEqual(await fillFollowUpSuggestions([], pickModel), suggestions)
    assert.equal(pickModel.mock.callCount(), 1)
  })
})

describe('buildContinuePlanSuggestion', () => {
  it('labels the bubble with the first open item', () => {
    const built = buildContinuePlanSuggestion(['Add tests', 'Run typecheck'])
    assert.equal(built.id, 'continue-plan')
    assert.equal(built.label, 'Continue: Add tests')
  })

  it('handles a single-item plan', () => {
    const built = buildContinuePlanSuggestion(['Only step left'])
    assert.equal(built.label, 'Continue: Only step left')
    assert.match(built.prompt, /- Only step left/)
  })

  it('keeps a long or multiline first item readable as a bubble label', () => {
    const suggestion = buildContinuePlanSuggestion([
      `Review the first failure\nand then ${'investigate '.repeat(20)}`,
    ])
    assert.ok(suggestion.label.length <= 82)
    assert.ok(suggestion.label.endsWith('…'))
    assert.equal(suggestion.label.includes('\n'), false)
    assert.match(suggestion.prompt, /Review the first failure\nand then/)
  })
})
