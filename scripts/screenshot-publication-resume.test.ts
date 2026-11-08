import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { safeJsonParse, decodeWithSchema } from '../src/shared/safe-json.ts'
import { z } from 'zod'

const steps = z
  .object({
    jobs: z.object({
      publish: z.object({
        steps: z.array(
          z.object({
            name: z.string().optional(),
            run: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
            if: z.string().optional(),
            uses: z.string().optional(),
            'continue-on-error': z.boolean().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
          }),
        ),
      }),
    }),
  })
  .parse(load(readFileSync('.github/workflows/publish-screenshot-candidates.yml', 'utf8'))).jobs
  .publish.steps

describe('resuming screenshot publication', () => {
  it('recreates the exact compare object after interruption, independent of retry time', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-publish-resume-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    try {
      git('init', '--quiet')
      mkdirSync(join(root, 'tests/e2e/screenshots'), { recursive: true })
      writeFileSync(join(root, 'tests/e2e/screenshots/manifest.json'), '{}\n')
      writeFileSync(join(root, 'README.md'), 'Reference screenshots\n')
      git('add', '.')
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      )
      const head = git('rev-parse', 'HEAD')
      writeFileSync(join(root, 'tests/e2e/screenshots/manifest.json'), '{"new.png":"candidate"}\n')
      const step = steps.find(
        (entry) => entry.name === 'Push the view-only screenshot compare branch',
      )
      assert.ok(step?.run)
      // Execute the real workflow through commit-tree. Only the network push is omitted.
      const source = step.run.split('basic="$(')[0]
      assert.ok(source)
      const run = (date: string, runId = '99'): string =>
        execFileSync('bash', ['-c', `${source}\nprintf '%s' "$commit"`], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            COMPARE_BRANCH: `screenshot-compare/pr-123/${head.slice(0, 12)}`,
            HEAD_SHA: head,
            PARENT_NUMBER: '123',
            RUN_ID: runId,
            RUNNER_TEMP: root,
            SOURCE_RUN_CREATED_AT: '2026-11-08T18:00:00Z',
            GIT_AUTHOR_DATE: date,
            GIT_COMMITTER_DATE: date,
          },
        }).trim()
      const first = run('2026-11-08T19:00:00Z')
      const resumed = run('2026-11-08T19:21:00Z')
      assert.equal(resumed, first, 'a publisher retry must retain the immutable compare commit')
      assert.equal(git('rev-parse', `${first}^`), head)
      assert.equal(
        git('diff-tree', '--no-commit-id', '--name-only', '-r', first),
        'tests/e2e/screenshots/manifest.json',
      )
      assert.notEqual(
        run('2026-11-08T19:21:00Z', '100'),
        first,
        'different source runs retain distinct provenance',
      )
      writeFileSync(join(root, 'tests/e2e/screenshots/manifest.json'), '{"new.png":"other"}\n')
      assert.notEqual(
        run('2026-11-08T19:21:00Z'),
        first,
        'changed evidence is never confused with a retry',
      )
      assert.equal(git('rev-parse', 'HEAD'), head)
      assert.equal(git('diff', '--cached'), '', 'the real index is untouched')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

const receiptSchema = z.object({
  publicationComplete: z.boolean(),
  blockers: z.array(z.string()),
  source: z.object({
    runId: z.string().nullable(),
    head: z.string().nullable(),
    renderedCheckout: z.null(),
  }),
  evidence: z.object({
    archiveDigest: z.string().nullable(),
    verifiedManifestSha256: z.string().nullable(),
    compareCommit: z.string().nullable(),
  }),
  review: z.object({
    recordedDecision: z.string().nullable(),
    pending: z.boolean().nullable(),
    manualHolds: z.string(),
  }),
  quota: z.object({ remaining: z.string().nullable(), resetAt: z.string().nullable() }),
})
function receipt(env: Record<string, string> = {}, manifest = true): z.infer<typeof receiptSchema> {
  const root = mkdtempSync(join(tmpdir(), 'copse-publication-receipt-'))
  try {
    if (manifest) writeFileSync(join(root, 'screenshot-upload-manifest.json'), '{}\n')
    const step = steps.find((entry) => entry.name === 'Write publication receipt')
    assert.ok(step?.run)
    execFileSync('bash', ['-c', step.run], {
      cwd: root,
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        GITHUB_STEP_SUMMARY: join(root, 'summary'),
        SOURCE_RUN_ID: '99',
        SOURCE_HEAD_SHA: 'a'.repeat(40),
        ELIGIBLE: 'true',
        HAS_ARTIFACT: 'true',
        ARTIFACT_ID: '42',
        ARTIFACT_DIGEST: `sha256:${'b'.repeat(64)}`,
        COMPARE_COMMIT: 'c'.repeat(40),
        REVIEW_PENDING: 'true',
        DISCOVER_OUTCOME: 'success',
        CANDIDATES_OUTCOME: 'success',
        STORAGE_OUTCOME: 'success',
        COMPARE_OUTCOME: 'success',
        GATE_OUTCOME: 'success',
        LINK_OUTCOME: 'success',
        LINK_DISPOSITION: 'published',
        PUBLICATION_STATUS: 'success',
        ...env,
      },
    })
    const result = safeJsonParse(
      readFileSync(join(root, 'screenshot-publication-receipt.json'), 'utf8'),
      decodeWithSchema(receiptSchema),
    )
    assert.ok(result)
    assert.match(readFileSync(join(root, 'summary'), 'utf8'), /Publication receipt/)
    return result
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('publication completion receipts', () => {
  it('retains published hashes without inventing visual approval or a rendered checkout', () => {
    const actual = receipt()
    assert.equal(actual.publicationComplete, true)
    assert.deepEqual(actual.blockers, [])
    assert.equal(actual.source.runId, '99')
    assert.equal(actual.source.head, 'a'.repeat(40))
    assert.equal(actual.source.renderedCheckout, null)
    assert.equal(actual.evidence.archiveDigest, `sha256:${'b'.repeat(64)}`)
    assert.equal(
      actual.evidence.verifiedManifestSha256,
      'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356',
    )
    assert.equal(actual.review.recordedDecision, null)
    assert.equal(actual.review.pending, true)
    assert.match(actual.review.manualHolds, /remain/)
  })
  it('records a pushed compare followed by quota failure as incomplete', () => {
    const actual = receipt({
      GATE_OUTCOME: 'failure',
      REVIEW_PENDING: '',
      LINK_OUTCOME: 'skipped',
      QUOTA_REMAINING: '0',
      QUOTA_RESET: '1794165658',
    })
    assert.equal(actual.publicationComplete, false)
    assert.deepEqual(actual.blockers, ['gate', 'link'])
    assert.equal(actual.evidence.compareCommit, 'c'.repeat(40))
    assert.equal(actual.review.pending, null)
    assert.equal(actual.quota.resetAt, '2026-11-08T19:20:58.000Z')
  })
  for (const step of ['DISCOVER', 'CANDIDATES', 'STORAGE', 'GATE', 'LINK']) {
    it(`does not claim completion after ${step.toLowerCase()} fails`, () => {
      const actual = receipt({ [`${step}_OUTCOME`]: 'failure' })
      assert.equal(actual.publicationComplete, false)
      assert.ok(actual.blockers.includes(step.toLowerCase()))
    })
  }
  it('reports the final stack review state instead of the earlier zero-candidate gate', () => {
    const attest = steps.find((entry) => entry.name === 'Attest combined screenshot stack coverage')
    assert.match(
      z.string().parse(attest?.with?.['script']),
      /core\.setOutput\('review-pending', String\(coverage\.needsReview\)\)/,
    )
    const writer = steps.find((entry) => entry.name === 'Write publication receipt')
    assert.equal(
      writer?.env?.['STACK_REVIEW_PENDING'],
      '${{ steps.attest.outputs.review-pending }}',
    )
    const actual = receipt({
      STACK_ARTIFACT_ID: '8',
      ATTEST_OUTCOME: 'success',
      STACK_REVIEW_PENDING: 'true',
      REVIEW_PENDING: '',
      REVIEW_DECISION: 'Accepted by @reviewer',
    })
    assert.equal(actual.publicationComplete, true)
    assert.equal(actual.review.pending, true)
    assert.equal(actual.review.recordedDecision, null)
  })
  it('keeps absent, expired or superseded evidence incomplete', () => {
    assert.equal(receipt({ ELIGIBLE: 'false' }).publicationComplete, false)
    assert.equal(receipt({ SUPERSEDED: 'true' }).publicationComplete, false)
    assert.equal(receipt({ LINK_DISPOSITION: 'superseded' }).publicationComplete, false)
    assert.equal(receipt({ PUBLICATION_STATUS: 'failure' }).publicationComplete, false)
    assert.equal(receipt({ ARTIFACT_ID: '' }).publicationComplete, false)
    assert.equal(receipt({}, false).publicationComplete, false)
    assert.equal(
      receipt({ STACK_ARTIFACT_ID: '8', ATTEST_OUTCOME: 'failure' }).publicationComplete,
      false,
    )
  })
  it('permits verified zero candidates without pretending an absent artifact was downloaded', () => {
    const actual = receipt(
      {
        HAS_ARTIFACT: 'false',
        ARTIFACT_ID: '',
        ARTIFACT_DIGEST: '',
        COMPARE_COMMIT: '',
        CANDIDATES_OUTCOME: 'skipped',
        STORAGE_OUTCOME: 'skipped',
      },
      false,
    )
    assert.equal(actual.publicationComplete, true)
    assert.equal(actual.evidence.verifiedManifestSha256, null)
    assert.equal(actual.evidence.archiveDigest, null)
  })
  it('preserves explicit decisions and unknown quota observations', () => {
    const actual = receipt({
      REVIEW_DECISION: 'Accepted by @reviewer',
      REVIEW_PENDING: '',
      QUOTA_RESET: 'garbled',
    })
    assert.equal(actual.review.recordedDecision, 'Accepted by @reviewer')
    assert.equal(actual.review.pending, false)
    assert.equal(actual.quota.resetAt, null)
  })
  it('writes locally even on failure and preserves an attempt-specific artifact', () => {
    assert.equal(steps.find((entry) => entry.name === 'Write publication receipt')?.if, 'always()')
    const upload = steps.find((entry) => entry.name === 'Preserve publication receipt')
    assert.equal(upload?.if, "always() && steps.receipt.outcome == 'success'")
    assert.equal(upload.with?.['if-no-files-found'], 'error')
    assert.equal(
      upload.with['name'],
      'screenshot-publication-${{ github.run_id }}-${{ github.run_attempt }}',
    )
  })
  it('keeps receipt failures advisory while real publication failures still fail closed', () => {
    for (const name of ['Write publication receipt', 'Preserve publication receipt']) {
      assert.equal(steps.find((entry) => entry.name === name)?.['continue-on-error'], true, name)
    }
    for (const name of [
      'Resolve the live parent PR and exact artifact',
      'Validate and apply candidate PNGs',
      'Upload verified candidates to R2',
      'Gate the parent on screenshot review',
      'Link screenshot evidence from the parent',
      'Attest combined screenshot stack coverage',
    ]) {
      const step = steps.find((entry) => entry.name === name)
      assert.ok(step, name)
      assert.notEqual(step['continue-on-error'], true, name)
    }
    assert.match(steps.at(-1)?.if ?? '', /failure\(\)/)
  })
})
