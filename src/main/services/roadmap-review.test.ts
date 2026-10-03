import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import type { ClassifierRequest, ClassifierResult } from '@copse/llm/classifiers/types.ts'
import { parseReviewVerdict, reviewDetailMarkdown } from '@shared/roadmap/review.ts'
import {
  classifyRoadmapReview,
  clearBulkRunIssueCacheForTest,
  completeRoadmapReview,
  completeReviewPrompt,
  gatherIssueEvidenceWithBulkCache,
  orderRoadmapNotesForReview,
  prepareRoadmapReview,
  reviewRoadmapItem,
  reviewSectionChars,
  type ReviewSectionChars,
} from './roadmap-review.ts'
import type { LLMProvider } from '@shared/types'
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
import { deleteSetting, setSetting } from './storage/settings.ts'
import { saveClassifierProfile, setBackgroundClassifier } from './classifiers/classifier-service.ts'

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

  it('stamps the classifier verdict without reasoning when no model answers', async (t) => {
    const kev = CLASSIFIER_PRESETS.find((preset) => preset.id === 'kev')
    assert.ok(kev)
    await setSetting('classifierProviders', { version: 1, profiles: [] })
    await setSetting('extraProviders', [])
    await saveClassifierProfile(kev)
    await setBackgroundClassifier('kev')
    // Mock-LLM mode offers no small-tasks route, so only the classifier can answer.
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    t.after(async () => {
      delete process.env['COPSE_PANEL_MOCK_LLM']
      mock.restoreAll()
      await deleteSetting('backgroundClassifier')
    })
    const sent: string[] = []
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(typeof init?.body === 'string' ? init.body : '')
      return Response.json({
        model: 'kev-fixture',
        answers: {
          review: {
            type: 'choice',
            choice: 'open',
            probabilities: { open: 0.1, partial: 0.2, likely: 0.6, resolved: 0.1 },
          },
        },
      })
    })
    const note = addKnowledgeNote({
      type: 'Roadmap',
      title: 'Toggle',
      body: 'Add a shortcut to toggle the terminal',
      status: 'ready',
    })
    const result = await reviewRoadmapItem(note.id, 'abc123 Add terminal shortcut', 'bulk', 'run-c')
    assert.equal(result.verdict, 'likely')
    assert.equal(result.detail, '')
    assert.match(sent[0] ?? '', /Add a shortcut to toggle the terminal/)
    assert.match(sent[0] ?? '', /abc123 Add terminal shortcut/)
    const after = getKnowledgeNote(note.id)
    assert.equal(after?.fields['reviewVerdict'], 'likely')
    assert.equal(after.fields['reviewDetail'], '')
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

/** Characters the evidence sections may use for a window, per the 70% budget. */
function evidenceBudget(contextWindow: number): number {
  return Math.floor(contextWindow * 0.7 * 4)
}

function sectionTotal(sections: ReviewSectionChars): number {
  return sections.prompt + sections.notes + sections.issue + sections.commits
}

describe('reviewSectionChars', () => {
  it('sends the whole prompt when the model has room for it', () => {
    const sections = reviewSectionChars(128_000, 'deep')
    assert.deepEqual(sections, { prompt: 4000, notes: 1000, issue: 2000, commits: 12_000 })
  })

  it('shrinks the commit log first on a 4K local model', () => {
    const sections = reviewSectionChars(4096, 'deep')
    // The item's own prompt is what the verdict is about — it keeps its ceiling.
    assert.equal(sections.prompt, 4000)
    assert.equal(sections.issue, 2000)
    assert.ok(sections.commits < 12_000, 'commit log shrank')
    assert.ok(sections.commits >= 800, `commit log stayed useful: ${String(sections.commits)}`)
    assert.ok(sectionTotal(sections) <= evidenceBudget(4096))
  })

  it('keeps a share of every section when even the item does not fit', () => {
    const sections = reviewSectionChars(1024, 'deep')
    assert.ok(sections.prompt > 0 && sections.issue > 0 && sections.commits > 0)
    assert.ok(sections.prompt < 4000)
    assert.ok(sectionTotal(sections) <= evidenceBudget(1024))
  })
})

/** Provider that fails the first `failures` calls with `error`, then answers. */
function fakeProvider(opts: { failures: number; error: string }): {
  provider: LLMProvider
  asks: string[]
} {
  const asks: string[] = []
  const provider: LLMProvider = {
    async *stream(messages) {
      const first = messages[0]
      asks.push(
        first && 'content' in first && typeof first.content === 'string' ? first.content : '',
      )
      if (asks.length <= opts.failures) throw new Error(opts.error)
      yield { type: 'text', text: 'resolved\n- the commits close this out' }
    },
  }
  return { provider, asks }
}

const LM_STUDIO_CONTEXT_ERROR =
  'engine protocol predict stream returned an error: ' +
  '{"code":500,"message":"context size has been exceeded.","type":"server_error"}'

const REVIEW_INPUT = {
  note: { body: 'x'.repeat(5000), status: 'ready', fields: {} },
  pinned: null,
  linked: [],
  commits: 'c'.repeat(20_000),
  depth: 'deep' as const,
}

describe('completeReviewPrompt', () => {
  it('sizes the prompt to the reported context window', async () => {
    const { provider, asks } = fakeProvider({ failures: 0, error: '' })
    const { text } = await completeReviewPrompt(
      provider,
      REVIEW_INPUT,
      'lmstudio:qwen3-4b',
      4096,
      1000,
    )
    assert.match(text, /^resolved/)
    assert.equal(asks.length, 1)
    assert.ok((asks[0]?.length ?? 0) <= evidenceBudget(4096) + 1000, 'prompt fits the window')
  })

  it('retries smaller when the engine rejects the prompt for context', async () => {
    const { provider, asks } = fakeProvider({ failures: 1, error: LM_STUDIO_CONTEXT_ERROR })
    const { text } = await completeReviewPrompt(
      provider,
      REVIEW_INPUT,
      'lmstudio:qwen3-4b',
      32_768,
      1000,
    )
    assert.match(text, /^resolved/)
    assert.equal(asks.length, 2)
    assert.ok((asks[1]?.length ?? 0) < (asks[0]?.length ?? 0), 'second attempt was smaller')
  })

  it('sends image attachments with the prompt and names every attachment', async () => {
    const parts: unknown[] = []
    const provider: LLMProvider = {
      async *stream(messages) {
        const first = messages[0]
        if (first && 'content' in first) parts.push(first.content)
        yield { type: 'text', text: 'open\n- nothing yet' }
      },
    }
    const png = 'data:image/png;base64,AAAA'
    await completeReviewPrompt(
      provider,
      {
        ...REVIEW_INPUT,
        attachments: [
          { id: 'a', name: 'shot.png', mimeType: 'image/png', size: 3 },
          { id: 'b', name: 'spec.pdf', mimeType: 'application/pdf', size: 9 },
        ],
        images: [png],
      },
      'm',
      32_768,
      1000,
    )
    const content = parts[0]
    assert.ok(Array.isArray(content))
    assert.deepEqual(content[1], { type: 'image', dataUrl: png })
    assert.match(JSON.stringify(content[0]), /shot\.png[\s\S]*spec\.pdf/)
  })

  it('retries without images when the model rejects them', async () => {
    let calls = 0
    const provider: LLMProvider = {
      async *stream(messages) {
        calls++
        const first = messages[0]
        if (first && 'content' in first && Array.isArray(first.content)) {
          throw new Error('model does not support image input')
        }
        yield { type: 'text', text: 'open\n- no evidence' }
      },
    }
    const { text } = await completeReviewPrompt(
      provider,
      { ...REVIEW_INPUT, images: ['data:image/png;base64,AAAA'] },
      'm',
      32_768,
      1000,
    )
    assert.match(text, /^open/)
    assert.equal(calls, 2)
  })

  for (const contextWindow of [4096, 32_768]) {
    it(`retries image context overflow without images at ${String(contextWindow)} tokens`, async () => {
      const calls: unknown[] = []
      const provider: LLMProvider = {
        async *stream(messages) {
          const first = messages[0]
          assert.ok(first && 'content' in first)
          calls.push(first.content)
          if (Array.isArray(first.content)) throw new Error(LM_STUDIO_CONTEXT_ERROR)
          yield { type: 'text', text: 'open\n- text fits' }
        },
      }
      const { text } = await completeReviewPrompt(
        provider,
        { ...REVIEW_INPUT, images: ['data:image/png;base64,AAAA'] },
        'm',
        contextWindow,
        1000,
      )
      assert.match(text, /^open/)
      assert.equal(calls.length, 2)
      assert.ok(Array.isArray(calls[0]))
      assert.equal(typeof calls[1], 'string')
    })
  }

  it('reports advice, not the engine blob, when the retry also fails', async () => {
    const { provider, asks } = fakeProvider({ failures: 2, error: LM_STUDIO_CONTEXT_ERROR })
    await assert.rejects(
      completeReviewPrompt(provider, REVIEW_INPUT, 'lmstudio:qwen3-4b', 32_768, 1000),
      (err: Error) => {
        assert.match(
          err.message,
          /The resolution check did not fit “lmstudio:qwen3-4b”’s 4K context/,
        )
        assert.match(err.message, /raise the model’s “Context Length”/)
        assert.match(err.message, /Settings → General → Models → Small tasks/)
        assert.doesNotMatch(err.message, /engine protocol/)
        return true
      },
    )
    assert.equal(asks.length, 2)
  })

  it('does not retry failures that are not about context', async () => {
    const { provider, asks } = fakeProvider({ failures: 1, error: 'fetch failed: ECONNREFUSED' })
    await assert.rejects(
      completeReviewPrompt(provider, REVIEW_INPUT, 'lmstudio:qwen3-4b', 32_768, 1000),
      /ECONNREFUSED/,
    )
    assert.equal(asks.length, 1)
  })
})

describe('classifyRoadmapReview', () => {
  function answering(probabilities: Record<string, number>): ClassifierResult {
    return {
      profileId: 'kev',
      adapter: 'systemone',
      requestedModel: 'kev',
      model: 'kev-fixture',
      elapsedMs: 1,
      answers: { review: { type: 'choice', choice: 'resolved', probabilities } },
    }
  }

  it('asks one review question about the evidence, within the review budget', async () => {
    const captured: { requests: readonly ClassifierRequest[]; timeoutMs?: number | undefined } = {
      requests: [],
    }
    await classifyRoadmapReview('ROADMAP STATUS: ready', 45_000, async (requests, options) => {
      captured.requests = requests
      captured.timeoutMs = options?.timeoutMs
      return null
    })
    const question = captured.requests[0]?.questions['review']
    assert.ok(question?.type === 'choice')
    assert.deepEqual(Object.keys(question.options), ['open', 'partial', 'likely', 'resolved'])
    assert.match(question.instructions, /closed issue is evidence, not proof/)
    assert.equal(captured.timeoutMs, 45_000)
  })

  it('lets a tie fall to the less resolved verdict', async () => {
    assert.equal(
      await classifyRoadmapReview('x', 1, async () => [
        answering({ open: 0.1, partial: 0.1, likely: 0.4, resolved: 0.4 }),
      ]),
      'likely',
    )
  })
})
