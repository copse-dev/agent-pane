import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDiffNumstat,
  porcelainHasMergeConflicts,
  ghPrHasCiFailures,
  ghPrHasMergeConflicts,
  parseGhOpenPr,
  parseGhOpenPrList,
} from './github/pr-context-service.ts'
import {
  buildPluginFollowUps,
  pluginFollowUpConditionMet,
  parseModelFollowUpIds,
} from './follow-up-service.ts'
import { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { definePlugin, type RegisteredPlugin } from '@copse/agent/plugins/plugin-manifest.ts'
import { runWithDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'

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

describe('pack-contributed follow-up bubbles', () => {
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
