import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { z } from 'zod'

it('archives incomplete collection with verified immutable bytes and rejects corrupt read-back', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-report-archive-test-'))
  try {
    const data = join(root, 'data'),
      bin = join(root, 'bin')
    mkdirSync(data)
    mkdirSync(bin)
    writeFileSync(
      join(data, 'manifest.json'),
      JSON.stringify([
        {
          runId: '1',
          attempt: '1',
          head: 'a'.repeat(40),
          createdAt: '2026-10-17T12:00:00Z',
          missingReason: 'Not reconstructed',
        },
      ]),
    )
    writeFileSync(
      join(bin, 'aws'),
      `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.ARCHIVE_TEST_CALLS, JSON.stringify(args)+'\\n');
if(args.includes('put-object')) fs.copyFileSync(args[args.indexOf('--body')+1],process.env.ARCHIVE_TEST_OBJECT);
else fs.writeFileSync(args.at(-1), process.env.ARCHIVE_TEST_CORRUPT ? 'corrupt' : fs.readFileSync(process.env.ARCHIVE_TEST_OBJECT));
`,
      { mode: 0o755 },
    )
    const env = {
      ...process.env,
      PATH: bin + ':' + (process.env['PATH'] ?? ''),
      GITHUB_RUN_ID: '2',
      GITHUB_RUN_ATTEMPT: '1',
      COLLECTION_OUTCOME: 'failure',
      SCREENSHOT_R2_ACCOUNT_ID: 'a'.repeat(32),
      SCREENSHOT_R2_BUCKET: 'fake',
      SCREENSHOT_R2_PUBLIC_URL: 'https://example.com',
      SCREENSHOT_R2_ACCESS_KEY_ID: 'fake',
      SCREENSHOT_R2_SECRET_ACCESS_KEY: 'fake',
      ARCHIVE_TEST_CALLS: join(root, 'calls'),
      ARCHIVE_TEST_OBJECT: join(root, 'object'),
      GITHUB_STEP_SUMMARY: join(root, 'summary'),
    }
    const script = resolve('scripts/archive-gate-report.mts')
    execFileSync(process.execPath, [script, data], { env, stdio: 'pipe' })
    const bundle = z
      .object({
        collectionOutcome: z.string(),
        report: z.object({
          gateChangeReady: z.boolean(),
          totals: z.object({ missing: z.number(), completeFullReplays: z.number() }),
        }),
      })
      .parse(JSON.parse(readFileSync(join(data, 'bundle.json'), 'utf8')))
    assert.equal(bundle.collectionOutcome, 'failure')
    assert.equal(bundle.report.gateChangeReady, false)
    assert.equal(bundle.report.totals.missing, 1)
    assert.equal(bundle.report.totals.completeFullReplays, 0)
    assert.match(readFileSync(join(root, 'calls'), 'utf8'), /--if-none-match/)
    assert.match(
      readFileSync(join(data, 'archive.json'), 'utf8'),
      /ci-reports\/v1\/2\/1\/[a-f0-9]{64}\.json/,
    )
    const corrupt = spawnSync(process.execPath, [script, data], {
      env: { ...env, ARCHIVE_TEST_CORRUPT: '1' },
      encoding: 'utf8',
    })
    assert.notEqual(corrupt.status, 0)
    assert.match(corrupt.stderr, /digest mismatch/)
    writeFileSync(
      join(data, 'manifest.json'),
      JSON.stringify([
        {
          runId: '1',
          attempt: '1',
          head: 'a'.repeat(40),
          createdAt: '2026-10-17T12:00:00Z',
          record: '../../secret',
        },
      ]),
    )
    const invalid = spawnSync(process.execPath, [script, data], { env, encoding: 'utf8' })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /Unexpected record path/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('report automation is main-only, read-only on GitHub, and retains partial evidence', () => {
  const workflow = readFileSync('.github/workflows/gate-shadow-report.yml', 'utf8')
  assert(!workflow.includes('pull_request:'))
  assert(!workflow.includes('workflow_run:'))
  assert(workflow.includes("if: github.ref == 'refs/heads/main'"))
  assert(!workflow.includes(': write'))
  assert(workflow.includes('persist-credentials: false'))
  assert(workflow.includes('COLLECTION_OUTCOME: ${{ steps.collect.outcome }}'))
  assert(workflow.includes("if: always() && steps.report.outcome == 'success'"))
  assert(workflow.includes('retention-days: 90'))
})
