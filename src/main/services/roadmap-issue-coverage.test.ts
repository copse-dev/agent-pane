import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addKnowledgeNote, setKnowledgeRootForTest } from './storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import { matchOpenIssuesToRoadmapItems } from './roadmap-issue-coverage.ts'

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
      async () => 'Mock response to: coverage',
    )
    assert.deepEqual(matches, [])
  })
})
