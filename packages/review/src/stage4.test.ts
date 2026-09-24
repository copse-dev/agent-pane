import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materialiseCheckouts, type MaterialisedCheckouts } from './checkouts.ts'
import { buildReviewContext, type ReviewContext } from './context.ts'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { Finding } from './finding.ts'
import { createHostProcessBackend } from './host-process-backend.ts'
import { cellEnvironment, serializeCell, type ExecutionCell } from './isolation.ts'
import { ScriptedProvider, type ScriptedStep } from './scripted-provider.ts'
import { verifyFindings, type Stage4Options } from './stage4.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'
import { openReviewGround, prepareVerificationBase, runStage0Checks } from './stage0.ts'
import { createVerifierToolExecutor, REPRODUCER_DIR } from './verifier-tools.ts'

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
      prepareBase: () => Promise.resolve(),
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

  it(
    'overlaps at most two findings and keeps result order when they finish out of order',
    { timeout: 5000 },
    async () => {
      const ids = ['parallel-one', 'parallel-two', 'parallel-three']
      const gates = ids.map(() => Promise.withResolvers<undefined>())
      const started = ids.map(() => Promise.withResolvers<undefined>())
      let active = 0
      let maximum = 0
      const seen: number[] = []
      const provider: LLMProvider = {
        async *stream(messages): AsyncGenerator<ProviderStreamChunk> {
          if (messages.some((message) => message.role === 'tool')) {
            yield { type: 'done' }
            return
          }
          const index = ids.findIndex((id) => JSON.stringify(messages).includes(`(${id})`))
          assert.ok(index >= 0)
          seen.push(index)
          active++
          maximum = Math.max(maximum, active)
          started[index]?.resolve(undefined)
          await gates[index]?.promise
          active--
          yield {
            type: 'tool_call',
            toolCall: {
              id: `verdict-${String(index)}`,
              name: 'verdict',
              args: {
                status: 'undetermined',
                reason: 'No behavioral proof was available for this claim.',
              },
            },
          }
          yield {
            type: 'usage',
            model: 'parallel',
            inputTokens: index + 1,
            outputTokens: 1,
            hostingProvider: `Host ${String(index)}`,
          }
          yield { type: 'done', stopReason: 'tool_calls' }
        },
      }
      const running = verifyFindings({
        ...options(
          ids.map((id) => candidate(id, 'security', 1)),
          {},
        ),
        challenger: { model: 'parallel', provider },
        concurrency: 2,
      })
      try {
        await Promise.all([started[0]?.promise, started[1]?.promise])
        assert.deepEqual(seen, [0, 1])
        gates[1]?.resolve(undefined)
        await started[2]?.promise
        assert.equal(active, 2)
        gates[2]?.resolve(undefined)
        gates[0]?.resolve(undefined)
        const result = await running
        assert.equal(maximum, 2)
        assert.deepEqual(
          result.records.map((record) => record.findingId),
          ids,
        )
        assert.deepEqual(
          result.records.map((record) => record.hostingProviders),
          [['Host 0'], ['Host 1'], ['Host 2']],
        )
        assert.deepEqual(
          result.records.map((record) => record.usage.inputTokens),
          [1, 2, 3],
        )
        assert.equal(result.counts.attempted, 3)
      } finally {
        for (const gate of gates) gate.resolve(undefined)
        await running
      }
    },
  )

  it('does not start the next finding after cancellation', { timeout: 5000 }, async () => {
    const controller = new AbortController()
    const bothStarted = Promise.withResolvers<undefined>()
    let calls = 0
    const provider: LLMProvider = {
      async *stream(_messages, _tools, signal): AsyncGenerator<ProviderStreamChunk> {
        assert.ok(signal)
        if (++calls === 2) bothStarted.resolve(undefined)
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Cancelled', 'AbortError'))
            },
            { once: true },
          )
          signal.throwIfAborted()
        })
        yield { type: 'done' }
      },
    }
    const running = verifyFindings({
      ...options(
        ['cancel-one', 'cancel-two', 'cancel-three'].map((id) => candidate(id, 'security', 1)),
        {},
      ),
      challenger: { model: 'cancel', provider },
      concurrency: 2,
      signal: controller.signal,
    })
    await bothStarted.promise
    controller.abort()
    const result = await running
    assert.equal(calls, 2)
    assert.equal(result.counts.attempted, 2)
    assert.ok(result.records.every((record) => record.outcome === 'cancelled'))
  })

  it(
    'keeps concurrent reproducer files distinct and each write/run/cleanup atomic',
    { timeout: 10000 },
    async () => {
      const ids = ['atomic-one', 'atomic-two']
      const reproviders = ids.map(
        (_id, index) =>
          new ScriptedProvider([
            {
              type: 'tool_call',
              name: 'write_reproducer',
              args: {
                ...REPRO,
                path: `.copse-review/finding-${String(index + 1)}-atomic.cjs`,
                argv: [process.execPath, `.copse-review/finding-${String(index + 1)}-atomic.cjs`],
              },
            },
            { type: 'text', text: 'Executed both revisions.' },
          ]),
      )
      const challengers = ids.map(
        () =>
          new ScriptedProvider([
            {
              type: 'tool_call',
              name: 'verdict',
              args: {
                status: 'stands',
                reproducerAssessment: 'valid',
                reason:
                  'Both revisions call value(); the changed return value fails the same assertion that passes on base.',
              },
            },
            { type: 'text', text: 'Checked the proof.' },
          ]),
      )
      const select = (providers: ScriptedProvider[]): LLMProvider => ({
        stream(messages, ...args): AsyncIterable<ProviderStreamChunk> {
          const index = ids.findIndex((id) => JSON.stringify(messages).includes(`(${id})`))
          const provider = providers[index]
          assert.ok(provider)
          return provider.stream(messages, ...args)
        },
      })
      const runs: string[] = []
      const guardedCell: ExecutionCell = {
        spec: cell.spec,
        destroy: () => Promise.resolve(),
        async run(command) {
          const files = (await readdir(join(checkouts.base, '.copse-review'))).filter((file) =>
            /finding-\d+-atomic/.test(file),
          )
          assert.equal(
            files.length,
            1,
            'another finding wrote its base file during this reproducer',
          )
          runs.push(`${files[0] ?? ''}:${command.target}`)
          return cell.run(command)
        },
      }
      const result = await verifyFindings({
        ...options(
          ids.map((id) => candidate(id, 'contract', 1)),
          {},
        ),
        reproducer: { model: 'reproduce', provider: select(reproviders) },
        challenger: { model: 'challenge', provider: select(challengers) },
        cell: guardedCell,
        concurrency: 2,
      })
      assert.equal(result.counts.confirmed, 2)
      for (const [reproduce, challenge] of [
        ['turn:reproduce:1', 'turn:challenge:2'],
        ['turn:reproduce:3', 'turn:challenge:4'],
      ]) {
        const tested = result.events.findIndex(
          (event) => event.type === 'turn_end' && event.turnId === reproduce,
        )
        const checked = result.events.findIndex(
          (event) => event.type === 'turn_start' && event.turnId === challenge,
        )
        assert.ok(tested >= 0 && checked > tested, 'a challenger must wait for its own reproducer')
      }
      assert.deepEqual(runs, [
        'finding-1-atomic.cjs:head',
        'finding-1-atomic.cjs:base',
        'finding-2-atomic.cjs:head',
        'finding-2-atomic.cjs:base',
      ])
      assert.deepEqual(
        result.records.map((record) => record.turnId),
        ['turn:reproduce:1', 'turn:challenge:2', 'turn:reproduce:3', 'turn:challenge:4'],
      )
      for (const prefix of ['finding-1-', 'finding-2-']) {
        assert.ok(
          await readFile(join(checkouts.head, '.copse-review', `${prefix}atomic.cjs`), 'utf8'),
        )
        await assert.rejects(access(join(checkouts.base, '.copse-review', `${prefix}atomic.cjs`)))
      }
    },
  )

  it("rejects another finding's test filename before writing or executing", async () => {
    const executor = createVerifierToolExecutor({
      ...options([], {}),
      reproducerPrefix: '.copse-review/finding-1-',
    })
    const signal = new AbortController().signal
    for (const path of [
      '.copse-review/finding-2-foreign.cjs',
      '.copse-review/finding-1-nested/file.cjs',
    ]) {
      const result = await executor.execute(
        'write_reproducer',
        { ...REPRO, path },
        signal,
        'collision',
      )
      assert.match(result, /test filename must start/)
      await assert.rejects(access(join(checkouts.head, path)))
    }
  })

  it('confirms an audited behavioral differential and keeps the artefact', async () => {
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
            args: {
              status: 'stands',
              reproducerAssessment: 'valid',
              reason:
                'The same test invokes value() on both revisions: base returns 1; head returns 2 and fails the behavioral assertion.',
            },
          },
          { type: 'text', text: 'Behavioral proof audited.' },
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
    assert.equal(result.reproducers[0]?.run.separates, true)
    assert.deepEqual(result.counts, {
      attempted: 1,
      confirmed: 1,
      refuted: 0,
      survived: 0,
      undetermined: 0,
      skipped: 0,
    })
    // A different exit code must survive the proof audit.
    assert.deepEqual(
      result.records.map((record) => record.strategy),
      ['reproducer', 'challenge'],
    )
    assert.equal(await readFile(join(checkouts.head, REPRO.path), 'utf8'), REPRO.content)
    await assert.rejects(access(join(checkouts.base, REPRO.path)), 'base must stay pristine')
    assert.equal(result.events[0]?.type, 'turn_start')
    assert.equal(result.usage.estimated, false)
  })

  it('does not confirm source-shape evidence that skips the base scenario', async () => {
    // Same failure mode as the live PR #3003 proof: a textual guard makes
    // base pass without executing the claimed behavior.
    const weak = {
      ...REPRO,
      content:
        "const s=require('fs').readFileSync('lib.cjs','utf8'); if (!s.includes('=> 2')) process.exit(0); require('assert').match(s,/=> 1/)",
    }
    const result = await verifyFindings(
      options([candidate('7777777777777777', 'contract', 1)], {
        reproduce: [
          { type: 'tool_call', name: 'write_reproducer', args: weak },
          { type: 'text', text: 'The exit codes differ.' },
        ],
        challenge: [
          {
            type: 'tool_call',
            name: 'verdict',
            args: {
              status: 'stands',
              reason:
                'The runtime value still appears wrong, but this test reads source and skips base.',
              reproducerAssessment: 'invalid',
            },
          },
          { type: 'text', text: 'Unverified.' },
        ],
      }),
    )
    assert.equal(result.findings[0]?.verdict.status, 'unverified')
    assert.equal(result.counts.confirmed, 0)
    assert.equal(result.counts.survived, 1)
    assert.equal(result.reproducers.length, 0)
  })

  it('requires a proof assessment even when the challenger agrees with a differential', async () => {
    const result = await verifyFindings(
      options([candidate('9999999999999999', 'contract', 1)], {
        reproduce: [
          { type: 'tool_call', name: 'write_reproducer', args: REPRO },
          { type: 'text', text: 'Reproduced.' },
        ],
        challenge: [
          {
            type: 'tool_call',
            name: 'verdict',
            args: {
              status: 'stands',
              reason: 'I agree with the reviewer without checking the test.',
            },
          },
          { type: 'text', text: 'Stands.' },
        ],
      }),
    )
    assert.equal(result.findings[0]?.verdict.status, 'unverified')
    assert.equal(result.counts.confirmed, 0)
    assert.equal(result.counts.undetermined, 1)
    assert.ok(
      result.events.some(
        (event) => event.type === 'tool_result' && event.result.includes('reproducerAssessment'),
      ),
    )
  })

  it('leaves an unaudited differential unverified when no challenger is configured', async () => {
    const result = await verifyFindings(
      options([candidate('8888888888888888', 'contract', 1)], {
        reproduce: [
          { type: 'tool_call', name: 'write_reproducer', args: REPRO },
          { type: 'text', text: 'Reproduced.' },
        ],
      }),
    )
    assert.equal(result.findings[0]?.verdict.status, 'unverified')
    assert.equal(result.counts.undetermined, 1)
    assert.equal(result.counts.confirmed, 0)
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

  it('repairs a prose-only challenge with an exact verdict tool choice', async () => {
    const finding = candidate('7777777777777777', 'security', 1)
    const provider = new ScriptedProvider([
      {
        type: 'text',
        text: 'The changed return value is used by the only caller, so the defect stands.',
      },
      {
        type: 'tool_call',
        name: 'verdict',
        args: {
          status: 'stands',
          reason: 'lib.cjs line 1 returns 2 and the only caller still requires 1.',
        },
      },
      { type: 'text', text: 'Done.' },
    ])
    const result = await verifyFindings({
      ...options([finding], {}),
      challenger: { model: 'challenger-model', provider },
    })

    const record = result.records.at(0)
    assert.ok(record)
    assert.equal(record.result, 'survived')
    assert.equal(record.outcome, 'completed')
    assert.equal(result.counts.survived, 1)
    assert.deepEqual(provider.streamOptions, [
      undefined,
      { toolChoice: { name: 'verdict' } },
      undefined,
    ])
    const repair = provider.calls.at(1)?.at(-1)
    assert.ok(repair)
    assert.equal(repair.role, 'user')
    const { content } = repair
    if (typeof content !== 'string') assert.fail('repair prompt must be text')
    assert.match(content, /Call verdict exactly once now/)
  })

  it('fails closed when the challenger ignores the required verdict repair', async () => {
    const finding = candidate('8888888888888888', 'security', 1)
    const result = await verifyFindings(
      options([finding], {
        challenge: [
          { type: 'text', text: 'I think this is probably fine.' },
          { type: 'text', text: 'Still not calling the tool.' },
        ],
      }),
    )

    const record = result.records.at(0)
    assert.ok(record)
    assert.equal(record.result, 'undetermined')
    assert.equal(record.outcome, 'failed')
    assert.match(record.reason, /stopped without calling the required verdict tool/)
    assert.deepEqual(result.findings.at(0)?.provenance.challengedBy, [])
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
  it('prepares dependencies and build artifacts on a clean base before reproducing', async () => {
    const project = await createTestRepo({
      'package.json': '{"name":"fixture"}',
      'review.config.json': JSON.stringify({
        commands: {
          prepare: [process.execPath, 'prepare.cjs'],
          build: [process.execPath, 'build.cjs'],
          test: [process.execPath, '-e', 'process.exit(0)'],
        },
      }),
      'prepare.cjs':
        "const fs=require('fs');fs.mkdirSync('node_modules/dep',{recursive:true});fs.writeFileSync('node_modules/dep/index.js','module.exports=1')",
      'build.cjs':
        "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('lib.cjs','dist/lib.cjs')",
      'lib.cjs': "module.exports=()=>require('dep')\n",
    })
    project.git('checkout', '-q', '-b', 'feature')
    await project.write({ 'lib.cjs': "module.exports=()=>require('dep')+1\n" })
    project.commit('change value')
    const ground = await openReviewGround({
      repoRoot: project.root,
      baseRef: 'main',
      backend: createHostProcessBackend(),
      diffOrigin: 'own',
      unisolatedConsent: true,
    })
    try {
      const stage0 = await runStage0Checks(ground)
      assert.equal(stage0.preparation.base, null)
      assert.ok(ground.checkouts)
      const executor = createVerifierToolExecutor({
        headCheckout: ground.checkouts.head,
        baseCheckout: ground.checkouts.base,
        context: await buildReviewContext({ checkouts: ground.checkouts }),
        cell: ground.cell,
        shellDecision: 'allow',
        scrub: (text) => text,
        prepareBase: (signal) => prepareVerificationBase(ground, stage0, signal),
      })
      await executor.execute(
        'write_reproducer',
        {
          path: '.copse-review/repro.cjs',
          content: "require('assert').equal(require('../dist/lib.cjs')(),1)",
          argv: [process.execPath, '.copse-review/repro.cjs'],
        },
        new AbortController().signal,
        'repro',
      )
      assert.equal(executor.reproducer()?.separates, true)
    } finally {
      await ground.close()
      await project.remove()
    }
  })
})
