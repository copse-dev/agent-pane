import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  importIssuesAsRoadmapItems,
  templateRoadmapPrompt,
  type RoadmapImportIssue,
} from './roadmap-issue-import.ts'
import { loadKnowledgeNotes, setKnowledgeRootForTest } from './storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

const ISSUE: RoadmapImportIssue = {
  number: 41,
  title: 'Dark mode flashes light theme on startup',
  body: 'On launch the window paints light before the persisted theme applies.',
}

describe('templateRoadmapPrompt', () => {
  it('folds the issue number, title, and body into a runnable prompt', () => {
    const prompt = templateRoadmapPrompt(ISSUE)
    assert.match(prompt, /^Resolve GitHub issue #41: Dark mode flashes/)
    assert.match(prompt, /Issue description:\nOn launch/)
  })

  it('omits the description block for a bodyless issue', () => {
    const prompt = templateRoadmapPrompt({ ...ISSUE, body: '  ' })
    assert.equal(prompt, 'Resolve GitHub issue #41: Dark mode flashes light theme on startup')
  })
})

describe('importIssuesAsRoadmapItems', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-import-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  const stubClassify = (): Promise<'medium'> => Promise.resolve('medium')

  it('creates one ready item per issue, pinned, drafted, and stamped', async () => {
    const drafted: number[] = []
    const created = await importIssuesAsRoadmapItems(
      [ISSUE, { number: 52, title: 'Add terminal shortcut', body: '' }],
      (issue) => {
        drafted.push(issue.number)
        return Promise.resolve(`Do the work for issue ${String(issue.number)}`)
      },
      stubClassify,
    )
    assert.deepEqual(drafted, [41, 52])
    assert.equal(created.length, 2)
    const notes = loadKnowledgeNotes('Roadmap')
    assert.equal(notes.length, 2)
    const first = notes.find((n) => n.fields['issue'] === '#41')
    assert.ok(first, 'item pinned to #41 exists')
    assert.equal(first.body, 'Do the work for issue 41')
    assert.equal(first.status, 'ready')
    assert.equal(first.fields['complexity'], 'medium')
    assert.match(first.fields['notes'] ?? '', /Imported from issue #41/)
  })

  it('falls back to the template when the draft fn fails', async () => {
    const created = await importIssuesAsRoadmapItems(
      [ISSUE],
      () => Promise.resolve(templateRoadmapPrompt(ISSUE)),
      stubClassify,
    )
    assert.match(created[0]?.body ?? '', /^Resolve GitHub issue #41/)
  })
})
