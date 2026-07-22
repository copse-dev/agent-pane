import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseReviewVerdict, reviewDetailMarkdown } from '@shared/roadmap/review.ts'
import {
  clearBulkRunIssueCacheForTest,
  completeRoadmapReview,
  gatherIssueEvidenceWithBulkCache,
  orderRoadmapNotesForReview,
  prepareRoadmapReview,
  reviewRoadmapItem,
} from './roadmap-review.ts'
import type { PrRef } from './github/backend/backend.ts'
import { mockGitHubBackend } from './github/backend/mock-backend.ts'
import {
  addKnowledgeNote,
  getKnowledgeNote,
  setKnowledgeRootForTest,
} from './storage/knowledge-store.ts'
import { getRoadmapLastReviewAt, setRoadmapReviewRootForTest } from './roadmap-review-state.ts'
import type { GhIssueSummary } from '../../shared/types/git.ts'
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

  it('orders done items last by createdAt for bulk review', () => {
    const ordered = orderRoadmapNotesForReview([
      { id: 'done-new', status: 'done', createdAt: '2026-06-01T00:00:00.000Z' },
      { id: 'ready', status: 'ready', createdAt: '2026-03-01T00:00:00.000Z' },
      { id: 'blocked', status: 'blocked', createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'done-old', status: 'done', createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    assert.deepEqual(
      ordered.map((n) => n.id),
      ['ready', 'blocked', 'done-old', 'done-new'],
    )
  })

  it('prepare places done items after active ones', async () => {
    addKnowledgeNote({
      type: 'Roadmap',
      title: 'Done item',
      body: 'Finished',
      status: 'done',
    })
    addKnowledgeNote({
      type: 'Roadmap',
      title: 'Active item',
      body: 'Still open',
      status: 'ready',
    })
    const prepared = await prepareRoadmapReview()
    assert.deepEqual(
      prepared.items.map((i) => i.title),
      ['Active item', 'Done item'],
    )
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

  it('dedupes GitHub issue fetches for the same pinned issue within one bulk run', async () => {
    process.env['COPSE_PANEL_MOCK_GH'] = '1'
    process.env['COPSE_PANEL_MOCK_GH_STATUS'] = 'ready'
    let getIssueCalls = 0
    let searchCalls = 0
    const origGetIssue = mockGitHubBackend.getIssue.bind(mockGitHubBackend)
    const origSearch = mockGitHubBackend.searchWorkspaceIssues.bind(mockGitHubBackend)
    mockGitHubBackend.getIssue = async (ref: PrRef): Promise<GhIssueSummary | null> => {
      getIssueCalls++
      return origGetIssue(ref)
    }
    mockGitHubBackend.searchWorkspaceIssues = async (
      query: string,
      limit: number,
    ): Promise<GhIssueSummary[]> => {
      searchCalls++
      return origSearch(query, limit)
    }
    try {
      clearBulkRunIssueCacheForTest()
      const prepared = await prepareRoadmapReview()
      const slug = 'copse-mock/demo'
      await gatherIssueEvidenceWithBulkCache('#41', slug, prepared.runId)
      await gatherIssueEvidenceWithBulkCache('#41', slug, prepared.runId)
      assert.equal(getIssueCalls, 1)
      assert.equal(searchCalls, 1)

      getIssueCalls = 0
      searchCalls = 0
      const otherRun = await prepareRoadmapReview()
      await gatherIssueEvidenceWithBulkCache('#41', slug, otherRun.runId)
      assert.equal(getIssueCalls, 1)
      assert.equal(searchCalls, 1)

      // Re-prepare orphans the first runId from pending — its cache must be dropped
      // so a later gather under that id cannot reuse stranded evidence.
      getIssueCalls = 0
      searchCalls = 0
      await gatherIssueEvidenceWithBulkCache('#41', slug, prepared.runId)
      assert.equal(getIssueCalls, 1)
      assert.equal(searchCalls, 1)
      assert.equal(completeRoadmapReview(prepared.runId), false)
      assert.equal(completeRoadmapReview(otherRun.runId), true)
    } finally {
      mockGitHubBackend.getIssue = origGetIssue
      mockGitHubBackend.searchWorkspaceIssues = origSearch
      delete process.env['COPSE_PANEL_MOCK_GH']
      delete process.env['COPSE_PANEL_MOCK_GH_STATUS']
      clearBulkRunIssueCacheForTest()
    }
  })
})
