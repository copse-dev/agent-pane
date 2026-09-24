import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHostProcessBackend } from './host-process-backend.ts'
import { REVIEW_CONFIG_FILENAME } from './project-commands.ts'
import { decodeStage0Report } from './stage0-report.ts'
import { runStage0, type Stage0Report } from './stage0.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'

describe('Stage 0 report decoder', () => {
  let repo: TestRepo
  let report: Stage0Report

  before(async () => {
    repo = await createTestRepo({
      'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node t.cjs' } }),
      't.cjs': 'process.exit(process.argv[2] === "fail" ? 1 : 0)',
      [REVIEW_CONFIG_FILENAME]: JSON.stringify({
        commands: { prepare: null, test: [process.execPath, 't.cjs'] },
      }),
    })
    repo.git('checkout', '-q', '-b', 'feature')
    await repo.write({
      [REVIEW_CONFIG_FILENAME]: JSON.stringify({
        commands: { prepare: null, test: [process.execPath, 't.cjs', 'fail'] },
      }),
    })
    repo.commit('break the test')
    report = await runStage0({
      repoRoot: repo.root,
      baseRef: 'main',
      backend: createHostProcessBackend(),
      diffOrigin: 'own',
      unisolatedConsent: true,
      hostEnv: { PATH: process.env['PATH'] },
    })
  })

  after(async () => {
    await repo.remove()
  })

  it('round-trips a real report through JSON, bare or wrapped', () => {
    assert.equal(report.findings.length, 1)
    const bare: unknown = JSON.parse(JSON.stringify(report))
    assert.deepEqual(decodeStage0Report(bare), report)
    const wrapped: unknown = JSON.parse(JSON.stringify({ version: 2, stage0: report }))
    assert.deepEqual(decodeStage0Report(wrapped), report)
  })

  it('does not promote a legacy double-red report into proof that failures are pre-existing', () => {
    const check = report.checks[0]
    assert.ok(check?.head && check.base)
    const legacy = {
      ...report,
      findings: [],
      checks: [
        {
          ...check,
          verdict: 'failing-on-base',
          base: { ...check.base, status: 'failed', exitCode: 1 },
        },
      ],
    }
    for (const value of [legacy, { stage0: legacy }]) {
      const decoded = decodeStage0Report(value)
      assert.equal(decoded?.checks[0]?.verdict, 'undetermined')
      assert.match(decoded.coverage.notChecked.at(-1)?.reason ?? '', /legacy double-failure/)
    }
  })

  it('rejects a report that is not one', () => {
    assert.equal(decodeStage0Report(null), null)
    assert.equal(decodeStage0Report({ stage0: {} }), null)
    assert.equal(decodeStage0Report({ ...report, version: 99 }), null)
    assert.equal(
      decodeStage0Report({ ...report, findings: [{ id: 'nope' }] }),
      null,
      'a malformed finding fails the whole report',
    )
    assert.equal(
      decodeStage0Report({
        ...report,
        execution: { ...report.execution, strength: 'unbreakable' },
      }),
      null,
    )
  })
})
