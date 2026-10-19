import { it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
const publisher = resolve('scripts/publish-gate-evidence.mts')
const replay = resolve('scripts/replay-gate-evidence.mts')
it('reports absent failed/cancelled evidence as unavailable and rejects successful or malformed evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-publication-missing-'))
  try {
    const env = {
      ...process.env,
      SOURCE_RUN_ID: '123',
      SOURCE_RUN_ATTEMPT: '1',
      SOURCE_HEAD_SHA: 'a'.repeat(40),
    }
    for (const directoryExists of [false, true]) {
      if (directoryExists) mkdirSync(join(root, 'incoming'))
      for (const conclusion of ['cancelled', 'failure', 'success']) {
        rmSync(join(root, 'gate-publication.json'), { force: true })
        const result = spawnSync(process.execPath, [publisher, 'incoming'], {
          cwd: root,
          env: { ...env, SOURCE_CONCLUSION: conclusion },
          encoding: 'utf8',
        })
        if (conclusion === 'success') {
          assert.notEqual(result.status, 0)
          assert.match(result.stderr, /Missing selected CI plan/)
        } else {
          assert.equal(result.status, 0, result.stderr)
          const publication = z
            .object({ text: z.string(), count: z.number(), shadowAvailable: z.boolean() })
            .parse(JSON.parse(readFileSync(join(root, 'gate-publication.json'), 'utf8')))
          assert.equal(publication.shadowAvailable, false)
          assert.equal(publication.count, 0)
          assert.match(publication.text, /No successful replay is recorded/)
          assert.match(publication.text, new RegExp(conclusion))
        }
      }
    }
    writeFileSync(join(root, 'incoming/plan.json'), '{}')
    const malformed = spawnSync(process.execPath, [publisher, 'incoming'], {
      cwd: root,
      env: { ...env, SOURCE_CONCLUSION: 'cancelled' },
      encoding: 'utf8',
    })
    assert.notEqual(malformed.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('publishes failed-run evidence immutably, verifies bytes, rejects tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-publication-'))
  try {
    mkdirSync(join(root, 'incoming'))
    const spec = 'tests/e2e/smoke.e2e.ts',
      sha = 'a'.repeat(40)
    writeFileSync(
      join(root, 'incoming/plan.json'),
      JSON.stringify({
        version: 1,
        runId: '123',
        runAttempt: '1',
        commit: sha,
        head: sha,
        actual: { mode: 'full', specs: [spec], shards: 8 },
        proposed: { mode: 'subset', specs: [spec], count: 1, shards: 1 },
        estimate: { savedSpecMinutes: 2 },
      }),
    )
    const row = {
      version: 1,
      spec,
      attempt: 1,
      outcome: 'failed',
      exitCode: 1,
      durationSeconds: 1,
      failureClass: 'unclassified',
      runId: '123',
      runAttempt: '2',
      shard: '1',
      commit: sha,
    }
    writeFileSync(join(root, 'incoming/outcome.json'), JSON.stringify(row))
    const bin = join(root, 'aws')
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_CALLS, JSON.stringify(args)+'\\n');
if (args.includes('put-object')) fs.copyFileSync(args[args.indexOf('--body')+1],process.env.FAKE_AWS_OBJECT);
else fs.copyFileSync(process.env.FAKE_AWS_OBJECT,args.at(-1));
`,
    )
    chmodSync(bin, 0o755)
    const env = {
      ...process.env,
      PATH: root + ':' + (process.env['PATH'] ?? ''),
      SOURCE_RUN_ID: '123',
      SOURCE_RUN_ATTEMPT: '2',
      SOURCE_HEAD_SHA: sha,
      SOURCE_CONCLUSION: 'failure',
      SCREENSHOT_R2_ACCOUNT_ID: 'a'.repeat(32),
      SCREENSHOT_R2_ACCESS_KEY_ID: 'fake',
      SCREENSHOT_R2_SECRET_ACCESS_KEY: 'fake',
      SCREENSHOT_R2_BUCKET: 'fake',
      SCREENSHOT_R2_PUBLIC_URL: 'https://example.com',
      FAKE_AWS_OBJECT: join(root, 'object.json'),
      FAKE_AWS_CALLS: join(root, 'calls.jsonl'),
    }
    execFileSync(process.execPath, [publisher, 'incoming'], { cwd: root, env, stdio: 'pipe' })
    const publication = z
      .object({ url: z.string(), text: z.string() })
      .parse(JSON.parse(readFileSync(join(root, 'gate-publication.json'), 'utf8')))
    assert.match(publication.url, /ci-evidence\/v1\/123\/2\/[a-f0-9]{64}\.json$/)
    assert.match(publication.text, /Unclassified failures: 1/)
    const calls = z.array(z.array(z.string())).parse(
      readFileSync(join(root, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line)),
    )
    assert(calls[0]?.includes('--if-none-match'))
    assert(calls[1]?.includes('get-object'))
    writeFileSync(join(root, 'incoming/outcome.json'), JSON.stringify({ ...row, runId: '999' }))
    const invalid = spawnSync(process.execPath, [publisher, 'incoming'], {
      cwd: root,
      env,
      encoding: 'utf8',
    })
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /provenance mismatch/)
    assert.equal(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').length, 2)
    // Attempt 2 failed before creating worker results: attempt 1's pass is stale.
    writeFileSync(
      join(root, 'incoming/outcome.json'),
      JSON.stringify({
        ...row,
        runAttempt: '1',
        outcome: 'passed',
        exitCode: 0,
        failureClass: null,
      }),
    )
    execFileSync(process.execPath, [publisher, 'incoming'], { cwd: root, env, stdio: 'pipe' })
    const replayed = JSON.parse(
      execFileSync(process.execPath, [replay, env.FAKE_AWS_OBJECT], {
        cwd: root,
        env,
        encoding: 'utf8',
      }),
    ) as unknown
    const comparison = z
      .object({ incomplete: z.array(z.string()), classificationComplete: z.boolean() })
      .parse(replayed)
    assert.deepEqual(comparison.incomplete, [spec])
    assert.equal(comparison.classificationComplete, false)
    // Even a failed shadow calculation must preserve the effective CI plan.
    writeFileSync(join(root, 'incoming/outcome.json'), JSON.stringify(row))
    const selected = JSON.parse(readFileSync(join(root, 'incoming/plan.json'), 'utf8')) as unknown
    const selectedPlan = z.record(z.string(), z.unknown()).parse(selected)
    rmSync(join(root, 'incoming/plan.json'))
    writeFileSync(
      join(root, 'incoming/selected-plan.json'),
      JSON.stringify({ ...selectedPlan, shadowAvailable: false }),
    )
    execFileSync(process.execPath, [publisher, 'incoming'], { cwd: root, env, stdio: 'pipe' })
    const fallback = z
      .object({ text: z.string() })
      .parse(JSON.parse(readFileSync(join(root, 'gate-publication.json'), 'utf8')))
    assert.match(fallback.text, /Shadow unavailable; actual CI plan preserved/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
