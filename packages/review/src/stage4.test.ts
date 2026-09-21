import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materialiseCheckouts, type MaterialisedCheckouts } from './checkouts.ts'
import { buildReviewContext, type ReviewContext } from './context.ts'
import type { Finding } from './finding.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import { cellEnvironment, serializeCell, type ExecutionCell } from './isolation.ts'
import { ScriptedProvider, type ScriptedStep } from './scripted-provider.ts'
import { verifyFindings, type Stage4Options } from './stage4.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'
import { REPRODUCER_DIR } from './verifier-tools.ts'

function candidate(id: string, klass: Finding['class'], line: number): Finding {
  return {
    id,
    anchor: { path: 'lib.cjs', startLine: line, endLine: line },
    claim: `value() returns 2 where callers expect 1 (${id})`,
    class: klass,
    severity: 'high',
    confidence: 'medium',
    provenance: {
      raisedBy: [{ kind: 'model', id: 'reviewer', lens: 'correctness' }],
      corroboratedBy: [],
      challengedBy: [],
    },
    evidence: [{ kind: 'citation', path: 'lib.cjs', startLine: line, endLine: line }],
    verdict: { status: 'unverified', reason: 'the constant changed' },
  }
}

const REPRO = {
  path: `${REPRODUCER_DIR}/value.repro.cjs`,
  content:
    "const value = require('../lib.cjs'); if (value() !== 1) { console.error('got ' + value()); process.exit(1) }",
  argv: [process.execPath, `${REPRODUCER_DIR}/value.repro.cjs`],
}

describe('verifyFindings', () => {
  let repo: TestRepo
  let scratch = ''
  let checkouts: MaterialisedCheckouts
  let context: ReviewContext
  let cell: ExecutionCell

  before(async () => {
    repo = await createTestRepo({ 'lib.cjs': 'module.exports = () => 1\n' })
    repo.git('checkout', '-q', '-b', 'feature')
    await repo.write({ 'lib.cjs': 'module.exports = () => 2\n' })
    repo.commit('change value')
    scratch = await mkdtemp(join(tmpdir(), 'review-stage4-'))
    checkouts = await materialiseCheckouts({
      repoRoot: repo.root,
      baseRef: 'main',
      scratchDir: scratch,
      includeWorkingTree: false,
    })
    context = await buildReviewContext({ checkouts })
    cell = serializeCell(
      await createHostProcessBackend().createCell({
        checkouts: { base: checkouts.base, head: checkouts.head },
        scratchDir: scratch,
        readOnlyPaths: [],
        env: cellEnvironment(process.env),
      }),
    )
  })

  after(async () => {
    await cell.destroy()
    await checkouts.cleanup()
    await rm(scratch, { recursive: true, force: true })
    await repo.remove()
  })

  function options(
    findings: Finding[],
    scripts: { reproduce?: ScriptedStep[]; challenge?: ScriptedStep[] },
  ): Stage4Options {
    return {
      headCheckout: checkouts.head,
      baseCheckout: checkouts.base,
      context,
      cell,
      shellDecision: 'allow' as const,
      scrub: (text: string): string => text,
      findings,
      reproducer: scripts.reproduce
        ? { model: 'repro-model', provider: new ScriptedProvider(scripts.reproduce) }
        : null,
      challenger: scripts.challenge
        ? { model: 'challenger-model', provider: new ScriptedProvider(scripts.challenge) }
        : null,
      threadId: 'thread',
      turnPrefix: 'turn',
    }
  }

  it('confirms a finding whose reproducer fails on head and passes on base, keeping the artefact', async () => {
    const finding = candidate('1111111111111111', 'contract', 1)
    const result = await verifyFindings(
      options([finding], {
        reproduce: [
          { type: 'tool_call', name: 'write_reproducer', args: REPRO },
          { type: 'text', text: 'Reproduced.' },
        ],
        challenge: [
          {
            type: 'tool_call',
            name: 'verdict',
            args: { status: 'refuted', reason: 'should never run' },
          },
        ],
      }),
    )
    const [verified] = result.findings
    assert.ok(verified)
    assert.equal(verified.verdict.status, 'confirmed')
    assert.match(verified.verdict.reason, /reproducer .* fails on head/)
    assert.deepEqual(verified.evidence.at(-1), {
      kind: 'reproducer',
      testPath: REPRO.path,
      failsOnHead: true,
      passesOnBase: true,
    })
    assert.equal(result.reproducers[0]?.run.confirms, true)
    assert.deepEqual(result.counts, {
      attempted: 1,
      confirmed: 1,
      refuted: 0,
      survived: 0,
      undetermined: 0,
      skipped: 0,
    })
    // The challenger was not consulted once execution settled it.
    assert.deepEqual(
      result.records.map((record) => record.strategy),
      ['reproducer'],
    )
    assert.equal(await readFile(join(checkouts.head, REPRO.path), 'utf8'), REPRO.content)
    await assert.rejects(access(join(checkouts.base, REPRO.path)), 'base must stay pristine')
    assert.equal(result.events[0]?.type, 'turn_start')
    assert.equal(result.usage.estimated, false)
  })

  it('falls through to the challenger when the reproducer does not separate head from base', async () => {
    const finding = candidate('2222222222222222', 'test', 1)
    const weak = { ...REPRO, path: `${REPRODUCER_DIR}/weak.repro.cjs`, content: 'process.exit(0)' }
    const result = await verifyFindings(
      options([finding], {
        reproduce: [
          { type: 'tool_call', name: 'write_reproducer', args: weak },
          { type: 'text', text: 'Could not reproduce.' },
        ],
        challenge: [
          { type: 'tool_call', name: 'read_file', args: { path: 'lib.cjs' } },
          {
            type: 'tool_call',
            name: 'verdict',
            args: {
              status: 'stands',
              reason: 'lib.cjs line 1 returns 2; the only caller expects 1.',
            },
          },
          { type: 'text', text: 'Stands.' },
        ],
      }),
    )
    const [verified] = result.findings
    assert.ok(verified)
    assert.equal(verified.verdict.status, 'unverified')
    assert.match(verified.verdict.reason, /survived challenge by challenger-model/)
    assert.deepEqual(verified.provenance.challengedBy, [
      { kind: 'model', id: 'challenger-model', lens: 'challenge' },
    ])
    assert.deepEqual(
      result.records.map((record) => [record.strategy, record.result]),
      [
        ['reproducer', 'undetermined'],
        ['challenge', 'survived'],
      ],
    )
    assert.equal(result.counts.survived, 1)
  })

  it('refutes a finding when the challenger shows it wrong, and skips reproducers for non-reproducible classes', async () => {
    const finding = candidate('3333333333333333', 'security', 1)
    const result = await verifyFindings(
      options([finding], {
        reproduce: [{ type: 'text', text: 'should never run' }],
        challenge: [
          {
            type: 'tool_call',
            name: 'run_command',
            args: { argv: [process.execPath, '-e', 'console.log("checked")'] },
          },
          {
            type: 'tool_call',
            name: 'verdict',
            args: {
              status: 'refuted',
              reason: 'The value is never used as a credential; see lib.cjs.',
            },
          },
          { type: 'text', text: 'Refuted.' },
        ],
      }),
    )
    const [verified] = result.findings
    assert.ok(verified)
    assert.equal(verified.verdict.status, 'refuted')
    assert.match(verified.verdict.reason, /^challenged by challenger-model: /)
    assert.equal(
      verified.evidence.some((evidence) => evidence.kind === 'command'),
      true,
    )
    assert.deepEqual(
      result.records.map((record) => record.strategy),
      ['challenge'],
    )
    assert.equal(result.counts.refuted, 1)
  })

  it('verifies the most promising findings first and counts the rest as skipped', async () => {
    const low = {
      ...candidate('4444444444444444', 'security', 1),
      severity: 'low' as const,
      confidence: 'low' as const,
    }
    const high = {
      ...candidate('5555555555555555', 'security', 1),
      severity: 'critical' as const,
      confidence: 'high' as const,
    }
    const result = await verifyFindings({
      ...options([low, high], {
        challenge: [
          {
            type: 'tool_call',
            name: 'verdict',
            args: { status: 'undetermined', reason: 'could not tell either way' },
          },
          { type: 'text', text: 'done' },
        ],
      }),
      maxVerified: 1,
    })
    assert.deepEqual(
      result.records.map((record) => record.findingId),
      [high.id],
    )
    assert.equal(result.counts.skipped, 1)
    assert.equal(result.counts.undetermined, 1)
    assert.equal(result.findings.find((f) => f.id === low.id)?.verdict.status, 'unverified')
  })

  it('leaves a confirmed finding alone and does nothing without a cell for reproducers', async () => {
    const confirmed = {
      ...candidate('6666666666666666', 'contract', 1),
      verdict: { status: 'confirmed' as const, reason: 'stage 0' },
    }
    const result = await verifyFindings({
      ...options([confirmed], { reproduce: [{ type: 'text', text: 'never' }] }),
      cell: null,
    })
    assert.deepEqual(result.records, [])
    assert.equal(result.counts.attempted, 0)
    assert.equal(result.findings[0]?.verdict.status, 'confirmed')
  })
})
