import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadKnowledgeNotes, setKnowledgeRootForTest } from '../storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import {
  dismissReviewFinding,
  loadDismissedFindingIds,
  REVIEW_DISMISSAL_NOTE_TYPE,
  restoreReviewFinding,
} from './review-dismissals.ts'

describe('review dismissals', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'review-dismissals-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  const finding = {
    findingId: '0123456789abcdef',
    path: 'src/math.ts',
    claim: 'add subtracts its second argument instead of adding it.',
    class: 'contract',
  }

  it('records a dismissal as one knowledge note keyed by the finding id, once', () => {
    assert.deepEqual([...loadDismissedFindingIds()], [])
    dismissReviewFinding(finding)
    dismissReviewFinding(finding)
    const notes = loadKnowledgeNotes(REVIEW_DISMISSAL_NOTE_TYPE)
    assert.equal(notes.length, 1)
    const [note] = notes
    assert.ok(note)
    assert.equal(note.fields['findingId'], finding.findingId)
    assert.equal(note.fields['path'], finding.path)
    assert.deepEqual(note.tags, ['contract'])
    assert.match(note.title, /src\/math\.ts: add subtracts/)
    assert.deepEqual([...loadDismissedFindingIds()], [finding.findingId])
  })

  it('restores by deleting the note, and says whether there was one', () => {
    dismissReviewFinding(finding)
    dismissReviewFinding({ ...finding, findingId: 'fedcba9876543210', claim: 'other' })
    assert.equal(restoreReviewFinding(finding.findingId), true)
    assert.deepEqual([...loadDismissedFindingIds()], ['fedcba9876543210'])
    assert.equal(restoreReviewFinding(finding.findingId), false)
  })
})
