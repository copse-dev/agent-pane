// bench:risk: the evidence finder, the sampler, the landed-commit map, and the
// run path end to end through the real `copse-review --summary-only` with the
// mock provider, on a throwaway repository.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderSummaryBlock } from '@copse/review/pr-summary.ts'
import { createTestRepo, type TestRepo } from '@copse/review/test-repo.ts'
import {
  decodeRiskRatingSet,
  type RiskCase,
  type RiskCorpus,
  type RiskEvidence,
} from '@copse/review/risk-eval.ts'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import {
  areaOf,
  changeShape,
  excerptAround,
  isBlamingEvidence,
  isFixTitle,
  isLowSignalPath,
  landedCommits,
  localEvidence,
  main,
  mentionPattern,
  mergeVerdicts,
  pickMature,
  ratingSource,
  runRatings,
  timelineEvidence,
  type BenchIo,
  type EvidenceInput,
  type GitHubClient,
  type SampleTier,
} from './bench-risk-lib.mts'

const MERGED = '2026-09-10T00:00:00Z'

function later(
  number: number,
  title: string,
  body: string,
  days: number,
  files: readonly string[] = [],
): EvidenceInput['mentioners'][number] {
  const at = new Date(Date.parse(MERGED) + days * 86_400_000).toISOString()
  return { kind: 'pr', number, title, body, createdAt: at, mergedAt: at, files }
}

function input(
  mentioners: EvidenceInput['mentioners'],
  hot: readonly string[] = [],
): EvidenceInput {
  return {
    repo: 'copse-dev/agent-pane',
    number: 100,
    title: 'Add the widget',
    mergedAt: MERGED,
    files: ['src/main/widget.ts', 'src/main/hot.ts', 'src/main/widget.test.ts'],
    windowDays: 7,
    mentioners,
    hotFiles: new Set(hot),
  }
}

function riskCase(overrides: Partial<RiskCase>): RiskCase {
  return {
    number: 1,
    title: 'Change',
    state: 'merged',
    mergedAt: MERGED,
    cohort: 'mature',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    size: { files: 1, additions: 1, deletions: 0, sourceLines: 1, sourceDeletions: 0 },
    areas: [],
    surfaces: [],
    posted: null,
    observedDays: 7,
    evidence: [],
    ...overrides,
  }
}

describe('evidence', () => {
  it("matches this repository's #n and URLs, not a longer number or another repository's", () => {
    const pattern = mentionPattern(100, 'copse-dev/agent-pane')
    assert.match('a regression from #100.', pattern)
    assert.match('see https://github.com/copse-dev/agent-pane/pull/100', pattern)
    assert.doesNotMatch('see #1000', pattern)
    assert.doesNotMatch('https://redirect.github.com/other/repo/issues/100', pattern)
    assert.doesNotMatch('&#100;', pattern)
    assert.equal(
      excerptAround('x '.repeat(200) + '#100 broke it', pattern, 10),
      '…x x x x x #100 broke it',
    )
  })

  it('finds references, reverts and fix-titled overlaps inside the window only', () => {
    const found = localEvidence(
      input(
        [
          later(101, 'Fix the widget crash', 'A regression from #100.', 1),
          later(102, 'Revert "Add the widget"', 'Reverts it.', 2),
          later(103, 'Fix widget sizing', 'No mention.', 3, ['src/main/widget.ts']),
          later(104, 'Fix hot path', 'No mention.', 3, ['src/main/hot.ts']),
          later(105, 'Add a gadget', 'No mention.', 3, ['src/main/widget.ts']),
          later(106, 'Fix the widget test', 'No mention.', 3, ['src/main/widget.test.ts']),
          later(107, 'Fix late', 'After #100.', 8),
          later(108, 'Fix before', 'Before #100.', -1),
        ],
        ['src/main/hot.ts'],
      ),
    )
    assert.deepEqual(
      found.map((item) => [item.source, item.ref]),
      [
        ['reference', '#101'],
        ['revert', '#102'],
        ['fix-overlap', '#103'],
      ],
    )
    assert.ok(found.every((item) => item.verdict === 'unverified'))
    assert.equal(found[2]?.excerpt, 'shares src/main/widget.ts')
  })

  it("does not read a later description's summary block as a mention", () => {
    const block = renderSummaryBlock(
      {
        risk: 'low',
        riskReason: 'Follows up #100 closely.',
        overview: ['Touches what #100 added.'],
      },
      { headCommit: null, toolVersion: '0.1.0', report: null },
    )
    assert.deepEqual(localEvidence(input([later(101, 'Other', `Body.\n\n${block}`, 1)])), [])
    assert.equal(
      localEvidence(input([later(101, 'Other', `After #100.\n\n${block}`, 1)])).length,
      1,
    )
  })

  it('keeps verdicts across a re-collect, including items no longer found', () => {
    const fresh: RiskEvidence[] = [
      {
        source: 'reference',
        ref: '#1',
        title: 't',
        daysAfterMerge: 1,
        excerpt: 'e',
        verdict: 'unverified',
      },
    ]
    const previous: RiskEvidence[] = [
      {
        source: 'reference',
        ref: '#1',
        title: 't',
        daysAfterMerge: 1,
        excerpt: 'old',
        verdict: 'regression',
        note: 'n',
      },
      {
        source: 'main-ci',
        ref: 'abc',
        title: 't',
        daysAfterMerge: 0,
        excerpt: 'e',
        verdict: 'unrelated',
      },
    ]
    const merged = mergeVerdicts(fresh, previous)
    assert.deepEqual(
      merged.map((item) => [item.ref, item.verdict, item.excerpt, item.note]),
      [
        ['#1', 'regression', 'e', 'n'],
        ['abc', 'unrelated', 'e', undefined],
      ],
    )
  })

  it('classifies titles, paths and blaming text', () => {
    assert.equal(isFixTitle('Stop the pane stealing focus'), true)
    assert.equal(isFixTitle('Add a pane'), false)
    assert.equal(isLowSignalPath('tests/e2e/a.e2e.ts'), true)
    assert.equal(isLowSignalPath('src/main/a.test.ts'), true)
    assert.equal(isLowSignalPath('pnpm-lock.yaml'), true)
    assert.equal(isLowSignalPath('src/main/a.ts'), false)
    assert.equal(areaOf('src/main/services/a.ts'), 'src/main')
    assert.equal(areaOf('packages/review/src/a.ts'), 'packages/review')
    assert.equal(areaOf('.github/workflows/ci.yml'), '.github')
    assert.equal(areaOf('Makefile'), '(root)')
    const item: RiskEvidence = {
      source: 'reference',
      ref: '#2',
      title: 'x',
      daysAfterMerge: 1,
      excerpt: 'Fixes a regression from #1.',
      verdict: 'unverified',
    }
    assert.equal(isBlamingEvidence(item), true)
    assert.equal(isBlamingEvidence({ ...item, excerpt: 'Rebased after #1 landed.' }), false)
  })
})

const BLAMED: SampleTier = 'blamed'
const EVIDENCE: SampleTier = 'evidence'
const NONE: SampleTier = 'none'

describe('timelineEvidence', () => {
  it('reads cross-references from every page of a long timeline', async () => {
    const crossRef = (number: number, day: string): unknown => ({
      event: 'cross-referenced',
      source: { issue: { number, title: `Fix ${String(number)}`, created_at: day } },
    })
    const filler = Array.from({ length: 99 }, () => ({ event: 'commented' }))
    const requested: string[] = []
    const client: GitHubClient = {
      get: (path) => {
        requested.push(path)
        const page = /[?&]page=(\d+)/.exec(path)?.[1]
        if (page === '1') return Promise.resolve([crossRef(201, '2026-09-11T00:00:00Z'), ...filler])
        if (page === '2') return Promise.resolve([crossRef(202, '2026-09-12T00:00:00Z')])
        return Promise.resolve([])
      },
    }
    const found = await timelineEvidence(client, 100, MERGED, 7, new Set(['#999']))
    assert.deepEqual(
      found.map((item) => item.ref),
      ['#201', '#202'],
    )
    assert.equal(requested.length, 2, 'a short page ends the walk')
  })
})

describe('ratingSource', () => {
  it('names the provider and model a run passed through', () => {
    assert.equal(ratingSource(['--provider', 'openrouter', '--model', 'm']), 'openrouter/m')
    assert.equal(ratingSource(['--model', 'claude-sonnet-5']), 'claude-sonnet-5')
    assert.equal(ratingSource([]), 'default provider')
  })
})

describe('pickMature', () => {
  it('takes blamed changes first for the evidence half and spreads the rest over sizes', () => {
    const candidates = [
      ...[1, 2].map((number) => ({ number, tier: BLAMED, sourceLines: 200 })),
      ...[3, 4, 5, 6].map((number) => ({
        number,
        tier: EVIDENCE,
        sourceLines: number * 150,
      })),
      ...[7, 8, 9, 10, 11, 12].map((number) => ({
        number,
        tier: NONE,
        sourceLines: (number - 7) * 250,
      })),
    ]
    const picked = pickMature(candidates, 6)
    assert.equal(picked.length, 6)
    assert.deepEqual(
      picked
        .filter((candidate) => candidate.tier === 'blamed')
        .map((candidate) => candidate.number),
      [1, 2],
    )
    assert.equal(picked.filter((candidate) => candidate.tier === 'evidence').length, 1)
    assert.equal(picked.filter((candidate) => candidate.tier === 'none').length, 3)
    assert.deepEqual(pickMature(candidates, 6), picked, 'the sample is stable')
    assert.deepEqual(
      picked.map((candidate) => candidate.number),
      [...picked.map((candidate) => candidate.number)].sort((a, b) => a - b),
    )
  })
})

describe('git and the run path', () => {
  let repo: TestRepo
  let outDir: string
  let base: string
  let landed: string

  before(async () => {
    repo = await createTestRepo({ 'src/math.ts': 'export const add = (a, b) => a + b\n' })
    base = repo.git('rev-parse', 'HEAD')
    await repo.write({
      'src/math.ts': 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b\n',
      'src/math.test.ts': 'test\n',
    })
    landed = repo.commit('Add subtraction (#7)')
    outDir = await mkdtemp(join(tmpdir(), 'bench-risk-'))
  })

  after(async () => {
    await repo.remove()
    await rm(outDir, { recursive: true, force: true })
  })

  it('maps pull requests to the commits they landed as, and measures the change', () => {
    assert.deepEqual([...landedCommits(repo.root, 'main')], [[7, landed]])
    const shape = changeShape(repo.root, base, landed)
    assert.deepEqual(shape.size, {
      files: 2,
      additions: 2,
      deletions: 0,
      sourceLines: 1,
      sourceDeletions: 0,
    })
    assert.deepEqual(shape.areas, ['src'])
  })

  it('rates a case through the real summary step and scores the ratings', async () => {
    const corpus: RiskCorpus = {
      version: 1,
      repo: 'o/r',
      collectedAt: MERGED,
      windowDays: 7,
      cases: [riskCase({ number: 7, base, head: landed })],
    }
    const script = join(outDir, 'mock.json')
    await writeFile(
      script,
      JSON.stringify([
        {
          type: 'tool_call',
          name: 'write_summary',
          args: {
            risk: 'high',
            riskReason: 'A scripted rating for the harness self-test.',
            overview: ['Adds a subtraction helper next to add.'],
          },
        },
        { type: 'text', text: 'Done.' },
      ]),
    )
    const lines: string[] = []
    const ratings = await runRatings({
      corpus,
      repoDir: repo.root,
      reviewerDir: resolve('.'),
      label: 'mock',
      reviewerArgs: ['--provider', 'mock', '--mock-script', script],
      source: 'mock',
      cases: [],
      env: process.env,
      now: new Date(MERGED),
      io: { stdout: (text) => lines.push(text), stderr: (text) => lines.push(text) },
    })
    assert.deepEqual(ratings.ratings, [
      { number: 7, risk: 'high', reason: 'A scripted rating for the harness self-test.' },
    ])
    assert.match(ratings.promptDigest ?? '', /^[0-9a-f]{16}$/)

    const corpusPath = join(outDir, 'corpus.json')
    const ratingsPath = join(outDir, 'mock-ratings.json')
    await writeFile(corpusPath, JSON.stringify(corpus))
    await writeFile(ratingsPath, JSON.stringify(ratings))
    const out: string[] = []
    const io: BenchIo = {
      stdout: (text) => {
        out.push(text)
      },
      stderr: (text) => {
        out.push(text)
      },
    }
    assert.equal(await main(['score', '--corpus', corpusPath, '--ratings', ratingsPath], io), 0)
    assert.match(out.join(''), /\| #7 \| high ↑ \| low \|/)
    out.length = 0
    assert.equal(await main(['compare', '--corpus', corpusPath, 'posted', ratingsPath], io), 0)
    assert.match(out.join(''), /before \(posted\): 0 scored/)
    assert.match(out.join(''), /after \(mock\): 1 scored, exact 0, over 1/)
    out.length = 0
    assert.equal(await main(['score', '--corpus', join(outDir, 'missing.json')], io), 1)
    assert.match(out.join(''), /does not exist; run collect first/)
    const written = safeJsonParse(await readFile(ratingsPath, 'utf8'), decodeRiskRatingSet)
    assert.equal(written?.label, 'mock')
  })
})
