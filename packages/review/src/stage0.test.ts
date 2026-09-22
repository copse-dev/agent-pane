import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFindings } from './finding.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import type { IsolationBackend } from './isolation.ts'
import { REVIEW_CONFIG_FILENAME } from './project-commands.ts'
import { renderStage0Report } from './report-text.ts'
import { openReviewGround, runStage0, runStage0Checks, type Stage0Report } from './stage0.ts'
import { createTestRepo, worktreeCount, type TestRepo } from './test-repo.ts'

/**
 * A project whose checks are plain `node` scripts, declared through
 * review.config.json so the test needs neither pnpm nor a network. Each check
 * reads a marker file the scenario writes on head or base.
 */
const CHECK_SCRIPT = `
const { readFileSync } = require('node:fs')
const kind = process.argv[2]
let spec = {}
try { spec = JSON.parse(readFileSync('checks.json', 'utf8')) } catch {}
const entry = spec[kind] ?? { exit: 0 }
if (entry.stdout) process.stdout.write(entry.stdout)
if (entry.env) process.stdout.write(JSON.stringify(process.env))
if (entry.sleepMs) setTimeout(() => process.exit(entry.exit ?? 0), entry.sleepMs)
else process.exit(entry.exit ?? 0)
`

function config(kinds: readonly string[], timeoutsMs: Record<string, number> = {}): string {
  const commands: Record<string, string[] | null> = { prepare: null }
  for (const kind of kinds) commands[kind] = [process.execPath, 'check.cjs', kind]
  return JSON.stringify({ commands, timeoutsMs })
}

const repos: TestRepo[] = []
after(async () => {
  await Promise.all(repos.map((repo) => repo.remove()))
})

async function scenario(
  baseChecks: Record<string, unknown>,
  headChecks: Record<string, unknown>,
  options: { kinds?: readonly string[]; timeoutsMs?: Record<string, number> } = {},
): Promise<TestRepo> {
  const kinds = options.kinds ?? ['build', 'typecheck', 'lint', 'test']
  const repo = await createTestRepo({
    'package.json': JSON.stringify(
      { name: 'fixture', scripts: { test: 'node check.cjs test' } },
      null,
      2,
    ),
    'check.cjs': CHECK_SCRIPT,
    [REVIEW_CONFIG_FILENAME]: config(kinds, options.timeoutsMs),
    'checks.json': JSON.stringify(baseChecks),
    'src/a.ts': 'export const a = 1\n',
  })
  repos.push(repo)
  repo.git('checkout', '-q', '-b', 'feature')
  await repo.write({
    'checks.json': JSON.stringify(headChecks),
    'src/a.ts': 'export const a: number = "one"\n',
  })
  repo.commit('head change')
  return repo
}

function run(
  repo: TestRepo,
  backend: IsolationBackend = createHostProcessBackend(),
): Promise<Stage0Report> {
  return runStage0({
    repoRoot: repo.root,
    baseRef: 'main',
    backend,
    diffOrigin: 'own',
    unisolatedConsent: true,
    hostEnv: { PATH: process.env['PATH'], SECRET_CANARY: 'canary-value-0123456789' },
  })
}

describe('runStage0', () => {
  it('is one clean line when every check passes on head, and never runs base', async () => {
    const repo = await scenario({}, {})
    const report = await run(repo)
    assert.deepEqual(report.findings, [])
    assert.deepEqual(report.coverage.checked, ['build', 'typecheck', 'lint', 'test'])
    assert.deepEqual(report.coverage.notChecked, [])
    assert.ok(report.checks.every((check) => check.verdict === 'clean' && check.base === null))
    assert.equal(report.dirtyWorkingTree, false)
    assert.match(renderStage0Report(report), /\nClean\.$/)
  })

  it('mints a confirmed finding for a test that passes on base and fails on head', async () => {
    const repo = await scenario({}, { test: { exit: 1, stdout: 'not ok 1 - adds\n' } })
    const report = await run(repo)
    assert.equal(report.findings.length, 1)
    const [finding] = report.findings
    assert.ok(finding)
    assert.equal(finding.class, 'test')
    assert.equal(finding.verdict.status, 'confirmed')
    assert.equal(finding.anchor.path, 'package.json')
    assert.ok(finding.anchor.startLine !== undefined, 'anchored at the script line')
    assert.deepEqual(
      finding.evidence.map((evidence) =>
        evidence.kind === 'command' ? [evidence.target, evidence.exitCode] : null,
      ),
      [
        ['head', 1],
        ['base', 0],
      ],
    )
    const testCheck = report.checks.find((check) => check.kind === 'test')
    assert.equal(testCheck?.verdict, 'regressed')
    assert.ok(
      report.checks.filter((check) => check.kind !== 'test').every((check) => check.base === null),
    )
    // The findings list is its own contract.
    assert.deepEqual(decodeFindings(JSON.parse(JSON.stringify(report.findings))), report.findings)
    assert.match(renderStage0Report(report), /1 finding\(s\):\n1\. \[test\] package\.json:\d+ —/)
  })

  it('anchors a new type diagnostic at its line and ignores one that only moved', async () => {
    const repo = await scenario(
      { typecheck: { exit: 2, stdout: "src/a.ts(9,1): error TS2304: Cannot find name 'x'.\n" } },
      {
        typecheck: {
          exit: 2,
          stdout: `src/a.ts(40,1): error TS2304: Cannot find name 'x'.\nsrc/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n`,
        },
      },
    )
    // Base fails typecheck too, so the check is failing-on-base and nothing is claimed.
    const report = await run(repo)
    assert.deepEqual(report.findings, [])
    assert.equal(
      report.checks.find((check) => check.kind === 'typecheck')?.verdict,
      'failing-on-base',
    )
  })

  it('mints one finding per new type diagnostic, anchored at its line', async () => {
    const repo = await scenario(
      {},
      {
        typecheck: {
          exit: 2,
          stdout: `src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n`,
        },
      },
    )
    const report = await run(repo)
    assert.equal(report.findings.length, 1)
    const [finding] = report.findings
    assert.ok(finding)
    assert.equal(finding.class, 'type')
    assert.deepEqual(finding.anchor, { path: 'src/a.ts', startLine: 1, endLine: 1 })
    assert.match(finding.claim, /^TS2322: /)
    assert.equal(finding.evidence[0]?.kind, 'citation')
    // Identity comes from the anchored source line, so the same line reported
    // at a different line number has the same id.
    const again = await run(repo)
    assert.equal(again.findings[0]?.id, finding.id)
  })

  it('reports a lint regression as a failed check, never as a finding (B4)', async () => {
    const repo = await scenario({}, { lint: { exit: 1 } })
    const report = await run(repo)
    assert.deepEqual(report.findings, [])
    assert.equal(report.checks.find((check) => check.kind === 'lint')?.verdict, 'regressed')
    assert.match(renderStage0Report(report), /lint ✗ regressed/)
  })

  it('claims nothing for a check that timed out on head, and says so', async () => {
    const repo = await scenario(
      {},
      { test: { exit: 0, sleepMs: 60_000 } },
      { timeoutsMs: { test: 300 } },
    )
    const report = await run(repo)
    assert.deepEqual(report.findings, [])
    const test = report.checks.find((check) => check.kind === 'test')
    assert.ok(test)
    assert.equal(test.verdict, 'undetermined')
    assert.equal(test.head?.status, 'timed-out')
    assert.deepEqual(report.coverage.checked, ['build', 'typecheck', 'lint'])
    assert.match(
      report.coverage.notChecked.map((note) => note.reason).join('\n'),
      /timed out on head/,
    )
    assert.match(renderStage0Report(report), /not checked: test — timed out/)
  })

  it('does not execute a foreign diff on the host backend, and touches nothing', async () => {
    const repo = await scenario({}, { test: { exit: 1 } })
    const report = await runStage0({
      repoRoot: repo.root,
      baseRef: 'main',
      backend: createHostProcessBackend(),
      diffOrigin: 'foreign',
      unisolatedConsent: true,
    })
    assert.equal(report.execution.decision.execute, false)
    assert.deepEqual(report.checks, [])
    assert.deepEqual(report.findings, [])
    assert.equal(report.coverage.notChecked[0]?.kind, 'all')
    assert.equal(worktreeCount(repo), 1)
    assert.match(renderStage0Report(report), /^Not executed: .*B1/m)
  })

  it('needs consent to run an own diff without isolation', async () => {
    const repo = await scenario({}, {})
    const report = await runStage0({
      repoRoot: repo.root,
      baseRef: 'main',
      backend: createHostProcessBackend(),
      diffOrigin: 'own',
    })
    assert.equal(report.execution.decision.execute, false)
    assert.match(report.execution.decision.reason, /consent/)
  })

  it('can materialise read-only checkouts for a refused execution, with no cell', async () => {
    // The app without an OS sandbox: the reviewer must not execute, but the
    // model stages still need base and head to read. The ground opens with the
    // worktrees and nothing else; Stage 0 reports the refusal as before, and
    // closing removes everything it made.
    const repo = await scenario({}, { test: { exit: 1 } })
    const ground = await openReviewGround({
      repoRoot: repo.root,
      baseRef: 'main',
      backend: createHostProcessBackend(),
      diffOrigin: 'own',
      readOnlyCheckouts: true,
    })
    try {
      assert.equal(ground.decision.execute, false)
      assert.ok(ground.checkouts, 'checkouts should be materialised')
      assert.equal(ground.cell, null)
      assert.equal(ground.project.head?.ecosystem, 'configured')
      assert.equal(worktreeCount(repo), 3)
      const report = await runStage0Checks(ground)
      assert.deepEqual(report.checks, [])
      assert.deepEqual(report.findings, [])
      assert.equal(report.coverage.notChecked[0]?.kind, 'all')
      assert.equal(report.headCommit, ground.checkouts.headCommit)
    } finally {
      await ground.close()
    }
    assert.equal(worktreeCount(repo), 1)
  })

  it('scrubs a host secret out of check output before it reaches the report', async () => {
    const repo = await scenario({}, { test: { exit: 1, env: true } })
    const report = await run(repo)
    const serialised = JSON.stringify(report)
    assert.doesNotMatch(serialised, /canary-value-0123456789/)
    assert.equal(report.findings.length, 1)
  })

  it('says why when the project cannot be detected', async () => {
    const repo = await createTestRepo({ 'README.md': 'nothing here\n' })
    repos.push(repo)
    const report = await run(repo)
    assert.deepEqual(report.checks, [])
    assert.deepEqual(
      report.coverage.notChecked.map((note) => note.kind),
      ['all'],
    )
    assert.match(report.coverage.notChecked.map((note) => note.reason).join('\n'), /package\.json/)
  })

  it('removes every scratch directory it made', async () => {
    const repo = await scenario({}, { test: { exit: 1 } })
    const report = await run(repo)
    assert.equal(report.findings.length, 1)
    assert.equal(worktreeCount(repo), 1)
  })
})
