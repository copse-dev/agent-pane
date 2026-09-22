// The bench:review self-test: the committed corpus through the whole pipeline
// with the mock profile, scored, and held to the committed baseline. What it
// pins is the harness and everything in the pipeline that is not a model —
// Stage 0's delta, clustering across lenses, verification's verdicts, the
// ranking — so a change to any of them that moves the measurement is seen on
// the PR that makes it, not a quarter later (P6).
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BASELINE_PATH,
  baselineKey,
  compareSummaries,
  corpusFingerprint,
  DEFAULT_CASES_DIR,
  gateFailures,
  loadCases,
  main,
  mockProfile,
  modelProfile,
  readBaselines,
  runBench,
  sanitiseEndpoint,
  targetGateFailures,
  type BenchSummary,
} from './bench-review-lib.mts'
import { wilsonLowerBound95 } from '@copse/review/eval.ts'

describe('bench:review over the committed corpus', () => {
  let outDir = ''
  let summary: BenchSummary

  it('routes reviewer model IDs containing colons without truncation', () => {
    const [reviewCase] = loadCases(DEFAULT_CASES_DIR)
    assert.ok(reviewCase)
    const model = 'qwen/qwen3-235b-a22b:free'
    const profile = modelProfile({
      provider: 'openrouter',
      models: [model],
      challenger: 'anthropic/claude-sonnet-5',
      env: { OPENROUTER_API_KEY: 'offline-test-key' },
    })
    const reviewer = profile.providerFor('review:correctness', reviewCase, model)
    assert.deepEqual(profile.reviewerIdentities, [
      { model, provider: 'openrouter', endpoint: null },
    ])
    assert.deepEqual(profile.challengerIdentity, {
      model: 'anthropic/claude-sonnet-5',
      provider: 'openrouter',
      endpoint: null,
    })
    assert.equal(profile.providerFor('review:security', reviewCase, model), reviewer)
    assert.notEqual(profile.providerFor('challenge', reviewCase), reviewer)
    assert.throws(
      () => profile.providerFor('review:correctness', reviewCase, 'missing'),
      /no provider/,
    )
  })

  before(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'bench-review-'))
    summary = await runBench(loadCases(DEFAULT_CASES_DIR), { profile: mockProfile(), outDir })
  })

  after(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  it('runs every case and scores the surfaced findings against the truth', () => {
    assert.deepEqual(
      summary.cases.map((result) => result.error),
      summary.cases.map(() => null),
    )
    const byId = new Map(summary.cases.map((result) => [result.id, result.score]))
    // Stage 0's test regression and the reviewer's anchored finding both hit the defect.
    assert.deepEqual(
      [byId.get('paginate-off-by-one')?.surfaced, byId.get('paginate-off-by-one')?.truePositives],
      [2, 2],
    )
    assert.equal(byId.get('paginate-off-by-one')?.confirmedByReproducer, 1)
    // A resource finding survives the challenge and hits by anchor with slack.
    assert.deepEqual(
      [byId.get('timer-leak')?.surfaced, byId.get('timer-leak')?.truePositives],
      [1, 1],
    )
    // The challenger refuted the only candidate: nothing reaches the human.
    assert.equal(byId.get('clean-rename')?.surfaced, 0)
    // Two lenses, one defect, one finding, confirmed by a reproducer.
    assert.deepEqual(
      [
        byId.get('null-check-dropped')?.surfaced,
        byId.get('null-check-dropped')?.truePositives,
        byId.get('null-check-dropped')?.confirmedByReproducer,
      ],
      [1, 1, 1],
    )
    // An undetermined challenge lets a wrong claim through: the false positive the metric counts.
    assert.deepEqual(
      [byId.get('false-alarm')?.surfaced, byId.get('false-alarm')?.falsePositives],
      [1, 1],
    )
    assert.equal(summary.metrics.cases, 5)
    assert.equal(summary.metrics.surfaced, 5)
    assert.equal(summary.metrics.truePositives, 4)
    assert.equal(summary.metrics.duplicates, 0)
    assert.equal(summary.metrics.precision, 0.8)
    assert.ok((summary.metrics.precisionLowerBound95 ?? 1) < 0.85)
    assert.equal(summary.metrics.recall, 1)
    assert.equal(summary.metrics.confirmed, 3)
    assert.equal(summary.metrics.confirmedByReproducer, 2)
    assert.equal(summary.metrics.reproducerRate, 0.4)
    assert.ok(summary.metrics.outputTokens > 0)
  })

  it('holds to the committed baseline, and says what moved when it does not', () => {
    const baselines = readBaselines(BASELINE_PATH)
    assert.ok(baselines[baselineKey(summary)], `no mock baseline in ${BASELINE_PATH}`)
    assert.deepEqual(gateFailures(summary, baselines), [])
    const worse: BenchSummary = {
      ...summary,
      metrics: {
        ...summary.metrics,
        precision: 0.6,
        truePositives: 3,
        outputTokensPerConfirmed: (summary.metrics.outputTokensPerConfirmed ?? 0) * 2,
      },
    }
    const failures = gateFailures(worse, baselines)
    assert.equal(failures.length, 3, failures.join('; '))
    assert.match(failures[0] ?? '', /precision 60% < baseline 80%/)
    assert.match(gateFailures(summary, {})[0] ?? '', /no baseline for configuration/)
  })

  it('keys baselines by the complete run configuration and corpus', () => {
    const original = baselineKey(summary)
    const variants: BenchSummary[] = [
      {
        ...summary,
        configuration: {
          ...summary.configuration,
          reviewers: [{ model: 'mock', provider: 'openai', endpoint: null }],
        },
      },
      {
        ...summary,
        configuration: {
          ...summary.configuration,
          challenger: { model: 'other', provider: 'mock', endpoint: null },
        },
      },
      {
        ...summary,
        configuration: { ...summary.configuration, lenses: ['correctness'] },
      },
      {
        ...summary,
        configuration: { ...summary.configuration, verify: false },
      },
      {
        ...summary,
        configuration: {
          ...summary.configuration,
          reviewers: [
            { model: 'mock', provider: 'openai-compatible', endpoint: 'http://localhost:9000/' },
          ],
        },
      },
      {
        ...summary,
        configuration: {
          ...summary.configuration,
          corpus: { ...summary.configuration.corpus, fingerprint: '0'.repeat(64) },
        },
      },
    ]
    const keys = [original, ...variants.map(baselineKey)]
    assert.equal(new Set(keys).size, keys.length)
    assert.match(corpusFingerprint(loadCases(DEFAULT_CASES_DIR)), /^[0-9a-f]{64}$/)
    assert.notEqual(
      corpusFingerprint(loadCases(DEFAULT_CASES_DIR)),
      corpusFingerprint(loadCases(DEFAULT_CASES_DIR, 'timer-leak')),
    )
  })

  it('strips endpoint credentials and request parameters from recorded identity', () => {
    assert.equal(
      sanitiseEndpoint('https://user:secret@example.com/v1?api_key=secret#fragment'),
      'https://example.com/v1',
    )
    const profile = modelProfile({
      provider: 'openai-compatible',
      models: ['local-model'],
      baseUrl: 'https://user:secret@example.com/v1?api_key=secret#fragment',
      env: {},
    })
    assert.deepEqual(profile.reviewerIdentities, [
      { model: 'local-model', provider: 'openai-compatible', endpoint: 'https://example.com/v1' },
    ])
  })

  it('separates the absolute 85% target from the regression ratchet', () => {
    const realConfiguration: BenchSummary['configuration'] = {
      ...summary.configuration,
      reviewers: [{ model: 'gpt-5', provider: 'openai', endpoint: null }],
      challenger: { model: 'gpt-5', provider: 'openai', endpoint: null },
    }
    const withMetrics = (
      truePositives: number,
      falsePositives: number,
      found: number,
      defects: number,
      duplicates = 0,
    ): BenchSummary => {
      const evaluated = truePositives + falsePositives
      return {
        ...summary,
        profile: 'gpt-5',
        configuration: realConfiguration,
        metrics: {
          ...summary.metrics,
          surfaced: evaluated + duplicates,
          truePositives,
          falsePositives,
          duplicates,
          precision: evaluated === 0 ? null : truePositives / evaluated,
          precisionLowerBound95: wilsonLowerBound95(truePositives, evaluated),
          found,
          defects,
          recall: defects === 0 ? null : found / defects,
        },
      }
    }
    assert.deepEqual(targetGateFailures(withMetrics(22, 0, 3, 3)), [])
    assert.match(
      targetGateFailures(withMetrics(5, 0, 3, 3)).join('; '),
      /95% lower bound/,
      'five perfect findings are too small a sample',
    )
    assert.match(targetGateFailures(withMetrics(84, 16, 3, 3)).join('; '), /precision 84%/)
    assert.match(targetGateFailures(withMetrics(22, 0, 1, 3)).join('; '), /recall 33\.3%/)
    assert.match(targetGateFailures(withMetrics(22, 0, 3, 3, 1)).join('; '), /duplicates 1/)
    assert.match(targetGateFailures(summary).join('; '), /real-model profile/)
  })

  it('compares two summaries for an ablation', async () => {
    const a = join(outDir, 'a.json')
    const b = join(outDir, 'b.json')
    await writeFile(a, JSON.stringify(summary))
    await writeFile(
      b,
      JSON.stringify({
        ...summary,
        verify: false,
        metrics: { ...summary.metrics, precision: 0.5 },
      }),
    )
    const table = compareSummaries(a, b)
    assert.match(table, /precision\s+80%\s+50%/)
    assert.match(table, /verify\s+true\s+false/)
  })

  it('rejects bad usage before running anything', async () => {
    let err = ''
    const code = await main(['--provider', 'carrier-pigeon'], {
      stdout: () => undefined,
      stderr: (text) => {
        err += text
      },
    })
    assert.equal(code, 2)
    assert.match(err, /unknown provider carrier-pigeon/)
    const none = await main(['--mock', '--case', 'no-such-case'], {
      stdout: () => undefined,
      stderr: (text) => {
        err += text
      },
    })
    assert.equal(none, 2)
    assert.match(err, /no cases in .* matching no-such-case/)
    const mockTarget = await main(['--mock', '--target-gate'], {
      stdout: () => undefined,
      stderr: (text) => {
        err += text
      },
    })
    assert.equal(mockTarget, 2)
    assert.match(err, /target-gate requires a real-model profile/)
  })
})
