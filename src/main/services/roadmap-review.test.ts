import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseReviewVerdict, reviewDetailMarkdown } from '@shared/roadmap/review.ts'
import { completeRoadmapReview, prepareRoadmapReview, reviewRoadmapItem } from './roadmap-review.ts'
import {
  addKnowledgeNote,
  getKnowledgeNote,
  setKnowledgeRootForTest,
} from './storage/knowledge-store.ts'
import { getRoadmapLastReviewAt, setRoadmapReviewRootForTest } from './roadmap-review-state.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('parseReviewVerdict', () => {
  it('reads the first verdict word on the first line', () => {
    assert.equal(parseReviewVerdict('likely\n- commit mentions the fix'), 'likely')
    assert.equal(parseReviewVerdict('RESOLVED\nDone via #123'), 'resolved')
    assert.equal(parseReviewVerdict('no verdict here'), null)
  })
})

describe('reviewDetailMarkdown', () => {
  it('expands stored bullet separators into a markdown list', () => {
    assert.equal(
      reviewDetailMarkdown('Commit matches · Issue still open'),
      '- Commit matches\n- Issue still open',
    )
  })
})

describe('roadmap review service', () => {
  let knowledgeRoot: string
  let reviewRoot: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    knowledgeRoot = mkdtempSync(join(tmpdir(), 'roadmap-review-knowledge-'))
    reviewRoot = mkdtempSync(join(tmpdir(), 'roadmap-review-state-'))
    setKnowledgeRootForTest(knowledgeRoot)
    setRoadmapReviewRootForTest(reviewRoot)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    setRoadmapReviewRootForTest(null)
    restoreWorkspace()
    rmSync(knowledgeRoot, { recursive: true, force: true })
    rmSync(reviewRoot, { recursive: true, force: true })
  })

  it('prepare lists non-archived items and complete stamps lastReviewAt', async () => {
    addKnowledgeNote({
      type: 'Roadmap',
      title: 'Active item',
      body: 'Do the thing',
      status: 'ready',
    })
    addKnowledgeNote({
      type: 'Roadmap',
      title: 'Archived item',
      body: 'Old work',
      status: 'archived',
    })
    assert.equal(getRoadmapLastReviewAt(), null)
    const prepared = await prepareRoadmapReview()
    assert.equal(prepared.items.length, 1)
    assert.equal(prepared.items[0]?.title, 'Active item')
    assert.ok(prepared.runId)
    completeRoadmapReview(prepared.runId)
    assert.ok(getRoadmapLastReviewAt())
  })

  it('does not advance the checkpoint for a stale or fabricated run id', async () => {
    const prepared = await prepareRoadmapReview()
    assert.equal(completeRoadmapReview('00000000-0000-4000-8000-000000000000'), false)
    assert.equal(getRoadmapLastReviewAt(), null)
    assert.equal(completeRoadmapReview(prepared.runId), true)
    assert.ok(getRoadmapLastReviewAt())
  })

  it('marks done items resolved without calling a model', async () => {
    const note = addKnowledgeNote({
      type: 'Roadmap',
      title: 'Shipped',
      body: 'Already finished',
      status: 'done',
    })
    const result = await reviewRoadmapItem(
      note.id,
      '(no commits in this window)',
      'bulk',
      'run-test',
    )
    assert.equal(result.verdict, 'resolved')
    assert.equal(result.depth, 'bulk')
    const after = getKnowledgeNote(note.id)
    assert.equal(after?.fields['reviewVerdict'], 'resolved')
    assert.equal(after.fields['reviewBulkRun'], 'run-test')
  })
})
