import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addKnowledgeNote, setKnowledgeRootForTest } from './storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import type { ClassifierRequest, ClassifierResult } from '@copse/llm/classifiers/types.ts'
import { classifyCoverage, matchOpenIssuesToRoadmapItems } from './roadmap-issue-coverage.ts'

/** A classifier result answering each question with its own distribution. */
function coverageResult(answers: Record<string, Record<string, number>>): ClassifierResult {
  return {
    profileId: 'kev',
    adapter: 'systemone',
    requestedModel: 'kev',
    model: 'kev-fixture',
    elapsedMs: 1,
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, probabilities]) => [
        id,
        { type: 'choice', choice: 'none', probabilities },
      ]),
    ),
  }
}

const NONE = { none: 0.9, partial: 0.05, likely: 0.05 }

function candidate(
  id: string,
  title = id,
): { id: string; title: string; body: string; issue: string } {
  return { id, title, body: `${title} prompt`, issue: '' }
}

describe('matchOpenIssuesToRoadmapItems', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-coverage-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('returns empty when there are no candidate roadmap items', async () => {
    const matches = await matchOpenIssuesToRoadmapItems(
      [{ number: 52, title: 'Shortcut', body: '' }],
      async () => {
        throw new Error('should not call the model')
      },
    )
    assert.deepEqual(matches, [])
  })

  it('skips pinned issues and asks the model only about the rest', async () => {
    const pinned = addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Pinned flash fix',
      body: 'Fix the startup theme flash',
      status: 'ready',
      fields: { issue: '#41' },
    })
    const unpinned = addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Terminal toggle',
      body: 'Add a keyboard shortcut to toggle the terminal pane',
      status: 'ready',
      fields: {},
    })
    let ask = ''
    const matches = await matchOpenIssuesToRoadmapItems(
      [
        { number: 41, title: 'Dark mode flashes', body: 'flash' },
        { number: 52, title: 'Add keyboard shortcut to toggle the terminal pane', body: '' },
      ],
      async (prompt) => {
        ask = prompt
        return `#52 ${unpinned.id} likely\n#41 ${pinned.id} likely`
      },
    )
    assert.match(ask, /ISSUES:\n- #52/)
    assert.doesNotMatch(ask, /ISSUES:[\s\S]*#41/)
    assert.match(ask, /pin=#41/, 'pinned item stays in ITEMS for context')
    assert.deepEqual(matches, [
      {
        issueNumber: 52,
        itemId: unpinned.id,
        itemTitle: 'Terminal toggle',
        verdict: 'likely',
      },
    ])
  })

  it('ignores archived items and unparseable model output', async () => {
    addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Archived',
      body: 'old',
      status: 'archived',
      fields: {},
    })
    addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Live',
      body: 'live prompt',
      status: 'ready',
      fields: {},
    })
    const matches = await matchOpenIssuesToRoadmapItems(
      [{ number: 1, title: 'Anything', body: '' }],
      async () => 'I could not determine which issues are covered.',
    )
    assert.deepEqual(matches, [])
  })

  it('uses the classifier answer and does not ask the model', async () => {
    const item = addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Terminal toggle',
      body: 'Add a keyboard shortcut to toggle the terminal pane',
      status: 'ready',
      fields: {},
    })
    const matches = await matchOpenIssuesToRoadmapItems(
      [{ number: 52, title: 'Toggle the terminal', body: '' }],
      async () => {
        throw new Error('should not call the model')
      },
      async () => [{ issueNumber: 52, itemId: item.id, verdict: 'partial' }],
    )
    assert.deepEqual(matches, [
      { issueNumber: 52, itemId: item.id, itemTitle: 'Terminal toggle', verdict: 'partial' },
    ])
  })

  it('falls back to the model when no classifier answers', async () => {
    const item = addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Terminal toggle',
      body: 'Add a keyboard shortcut to toggle the terminal pane',
      status: 'ready',
      fields: {},
    })
    let asked = false
    const matches = await matchOpenIssuesToRoadmapItems(
      [{ number: 52, title: 'Toggle the terminal', body: '' }],
      async () => {
        asked = true
        return `#52 ${item.id} likely`
      },
      async () => null,
    )
    assert.equal(asked, true)
    assert.equal(matches[0]?.verdict, 'likely')
  })
})

describe('classifyCoverage', () => {
  it('asks one request per issue, with the issue as the state and one question per item', async () => {
    const captured: { requests: readonly ClassifierRequest[] } = { requests: [] }
    await classifyCoverage(
      [
        { number: 52, title: 'Toggle the terminal', body: 'Needs a shortcut' },
        { number: 53, title: 'Theme flash', body: '' },
      ],
      [candidate('a', 'Terminal toggle'), candidate('b', 'Theme fix')],
      async (requests) => {
        captured.requests = requests
        return null
      },
    )
    assert.equal(captured.requests.length, 2)
    const request = captured.requests[0]
    assert.ok(request)
    assert.equal(request.state, 'Issue #52: Toggle the terminal\n\nNeeds a shortcut')
    assert.deepEqual(Object.keys(request.questions), ['item-0', 'item-1'])
    const question = request.questions['item-0']
    assert.ok(question?.type === 'choice')
    assert.match(question.instructions, /"Terminal toggle": Terminal toggle prompt/)
    assert.deepEqual(Object.keys(question.options), ['none', 'partial', 'likely'])
  })

  it('splits an issue across requests when the items exceed one request', async () => {
    const captured: { requests: readonly ClassifierRequest[] } = { requests: [] }
    const items = Array.from({ length: 300 }, (_, i) => candidate(`item${String(i)}`))
    await classifyCoverage([{ number: 1, title: 'x', body: '' }], items, async (requests) => {
      captured.requests = requests
      return null
    })
    assert.deepEqual(
      captured.requests.map((request) => Object.keys(request.questions).length),
      [256, 44],
    )
  })

  it('keeps the strongest match per issue and lets a tie fall to none', async () => {
    const matches = await classifyCoverage(
      [
        { number: 52, title: 'a', body: '' },
        { number: 53, title: 'b', body: '' },
      ],
      [candidate('a'), candidate('b'), candidate('c')],
      async () => [
        coverageResult({
          'item-0': { none: 0.2, partial: 0.7, likely: 0.1 },
          'item-1': { none: 0.1, partial: 0.3, likely: 0.6 },
          'item-2': { none: 0.1, partial: 0.1, likely: 0.8 },
        }),
        // A three-way tie is not a match: a tie goes to none.
        coverageResult({
          'item-0': { none: 0.4, partial: 0.2, likely: 0.4 },
          'item-1': NONE,
          'item-2': NONE,
        }),
      ],
    )
    assert.deepEqual(matches, [{ issueNumber: 52, itemId: 'c', verdict: 'likely' }])
  })

  it('returns null when an answer is missing, so the model can answer instead', async () => {
    const matches = await classifyCoverage(
      [{ number: 52, title: 'a', body: '' }],
      [candidate('a'), candidate('b')],
      async () => [coverageResult({ 'item-0': NONE })],
    )
    assert.equal(matches, null)
  })
})
