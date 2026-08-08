/**
 * Unit pins for the steer A/B harness.
 *
 * The point of the harness is that a check must be able to FAIL — a checker
 * that always passes would make every steer look effective. Each check kind is
 * therefore asserted in both directions.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  buildSteerEvalPrompt,
  loadSteerPack,
  parseSteerEvalArgs,
  steerPackPaths,
  renderSteerEvalMarkdown,
  runChecks,
  STEER_BLOCK_TEXTS,
  STEER_NUDGE_TEXTS,
  STEER_TURN_START_TEXTS,
  steerText,
  summarizeSteerPack,
  type SteerEvalAttempt,
  type SteerPack,
} from './steer-eval-lib.mts'

const CALLS = [
  { name: 'git_status', args: {} },
  { name: 'run_shell', args: { command: 'git commit -m "wip"' } },
  { name: 'git_commit', args: { message: 'add feature' } },
]

function checkPass(results: ReturnType<typeof runChecks>, id: string): boolean {
  const found = results.find((result) => result.id === id)
  assert.ok(found, `expected a result for check ${id}`)
  return found.pass
}

function withWorkspace(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'steer-eval-test-'))
  try {
    run(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

describe('steer eval checks', () => {
  it('tool-used and tool-not-used discriminate in both directions', () => {
    const results = runChecks(
      [
        { id: 'commit-tool', kind: 'tool-used', tool: 'git_commit' },
        { id: 'absent-tool', kind: 'tool-used', tool: 'update_todos' },
        { id: 'no-shell', kind: 'tool-not-used', tool: 'run_shell' },
        { id: 'no-todos', kind: 'tool-not-used', tool: 'update_todos' },
      ],
      { calls: CALLS, finalMessage: 'done', workspace: '/tmp' },
    )
    assert.equal(checkPass(results, 'commit-tool'), true)
    assert.equal(checkPass(results, 'absent-tool'), false)
    assert.equal(checkPass(results, 'no-shell'), false)
    assert.equal(checkPass(results, 'no-todos'), true)
  })

  it('first-tool-is pins the opening move', () => {
    const results = runChecks(
      [
        { id: 'opens-status', kind: 'first-tool-is', tool: 'git_status' },
        { id: 'opens-todos', kind: 'first-tool-is', tool: 'update_todos' },
      ],
      { calls: CALLS, finalMessage: '', workspace: '/tmp' },
    )
    assert.equal(checkPass(results, 'opens-status'), true)
    assert.equal(checkPass(results, 'opens-todos'), false)
  })

  it('tool-arg matching catches a shelled-out git commit', () => {
    const results = runChecks(
      [
        {
          id: 'shell-commits',
          kind: 'tool-arg-matches',
          tool: 'run_shell',
          arg: 'command',
          pattern: '\\bgit\\s+commit\\b',
        },
        {
          id: 'no-shell-commit',
          kind: 'tool-arg-not-matches',
          tool: 'run_shell',
          arg: 'command',
          pattern: '\\bgit\\s+commit\\b',
        },
        {
          id: 'no-shell-push',
          kind: 'tool-arg-not-matches',
          tool: 'run_shell',
          arg: 'command',
          pattern: '\\bgit\\s+push\\b',
        },
      ],
      { calls: CALLS, finalMessage: '', workspace: '/tmp' },
    )
    assert.equal(checkPass(results, 'shell-commits'), true)
    assert.equal(checkPass(results, 'no-shell-commit'), false)
    assert.equal(checkPass(results, 'no-shell-push'), true)
  })

  it('matches assistant text emitted before the first selected tool call', () => {
    const numberedPlan = 'Plan:\n1. Read src/parse.js\n2. Rename the function\n3. Add a test'
    const calls = [
      { name: 'list_dir', args: {}, textBeforeCall: 'I will inspect the project first.' },
      { name: 'read_file', args: {}, textBeforeCall: 'I will inspect the project first.' },
      { name: 'str_replace', args: {}, textBeforeCall: numberedPlan },
      { name: 'write_file', args: {}, textBeforeCall: `${numberedPlan}\nStep 2 is in progress.` },
    ]
    const results = runChecks(
      [
        {
          id: 'numbered-plan-before-mutation',
          kind: 'before-tool-matches',
          tools: ['str_replace', 'write_file'],
          pattern: '(^|\\n)\\s*1[.)][\\s\\S]*(^|\\n)\\s*2[.)][\\s\\S]*(^|\\n)\\s*3[.)]',
        },
        {
          id: 'missing-plan-before-read',
          kind: 'before-tool-matches',
          tools: ['read_file'],
          pattern: '4[.)]',
        },
      ],
      {
        calls,
        finalMessage: 'Done.',
        workspace: '/tmp',
      },
    )
    assert.equal(checkPass(results, 'numbered-plan-before-mutation'), true)
    assert.equal(checkPass(results, 'missing-plan-before-read'), false)
  })

  it('final-message checks cover match, absence, and length bounds', () => {
    const results = runChecks(
      [
        { id: 'mentions-branch', kind: 'final-matches', pattern: 'branch' },
        { id: 'mentions-rocket', kind: 'final-matches', pattern: 'rocket' },
        { id: 'no-rocket', kind: 'final-not-matches', pattern: 'rocket' },
        { id: 'short-enough', kind: 'final-max-chars', max: 100 },
        { id: 'too-short', kind: 'final-max-chars', max: 5 },
        { id: 'long-enough', kind: 'final-min-chars', min: 5 },
      ],
      {
        calls: [],
        finalMessage: 'Committed on a working branch rather than main.',
        workspace: '/tmp',
      },
    )
    assert.equal(checkPass(results, 'mentions-branch'), true)
    assert.equal(checkPass(results, 'mentions-rocket'), false)
    assert.equal(checkPass(results, 'no-rocket'), true)
    assert.equal(checkPass(results, 'short-enough'), true)
    assert.equal(checkPass(results, 'too-short'), false)
    assert.equal(checkPass(results, 'long-enough'), true)
  })

  it('max-tool-calls bounds loop length', () => {
    const results = runChecks(
      [
        { id: 'under', kind: 'max-tool-calls', max: 5 },
        { id: 'over', kind: 'max-tool-calls', max: 1 },
      ],
      { calls: CALLS, finalMessage: '', workspace: '/tmp' },
    )
    assert.equal(checkPass(results, 'under'), true)
    assert.equal(checkPass(results, 'over'), false)
  })

  it('shell checks run against the finished workspace', () => {
    withWorkspace((workspace) => {
      writeFileSync(join(workspace, 'built.txt'), 'ok', 'utf8')
      const results = runChecks(
        [
          { id: 'file-there', kind: 'shell', command: 'test -f built.txt' },
          { id: 'file-missing', kind: 'shell', command: 'test -f absent.txt' },
        ],
        { calls: [], finalMessage: '', workspace },
      )
      assert.equal(checkPass(results, 'file-there'), true)
      assert.equal(checkPass(results, 'file-missing'), false)
    })
  })
})

describe('steer eval prompt arms', () => {
  it('a section steer varies the base prompt by omission only', () => {
    const withArm = buildSteerEvalPrompt(
      '/tmp/ws',
      { kind: 'section', ref: 'gitBranchSafety' },
      'with',
    )
    const withoutArm = buildSteerEvalPrompt(
      '/tmp/ws',
      { kind: 'section', ref: 'gitBranchSafety' },
      'without',
    )
    assert.match(withArm, /Git branch safety/)
    assert.doesNotMatch(withoutArm, /Git branch safety/)
    assert.match(withoutArm, /Working style:/)
    assert.match(withoutArm, /Working directory: \/tmp\/ws/)
  })

  it('a block steer appends the shipping block text to the with arm only', () => {
    const withArm = buildSteerEvalPrompt('/tmp/ws', { kind: 'block', ref: 'browserTools' }, 'with')
    const withoutArm = buildSteerEvalPrompt(
      '/tmp/ws',
      { kind: 'block', ref: 'browserTools' },
      'without',
    )
    assert.ok(withArm.includes(STEER_BLOCK_TEXTS.browserTools))
    assert.ok(!withoutArm.includes(STEER_BLOCK_TEXTS.browserTools))
    assert.equal(withArm.replace(STEER_BLOCK_TEXTS.browserTools, ''), withoutArm)
  })

  it('a turn-start steer appends the shipping injection to the with arm only', () => {
    const withArm = buildSteerEvalPrompt(
      '/tmp/ws',
      { kind: 'turnStart', ref: 'forcedTodoPlan' },
      'with',
    )
    const withoutArm = buildSteerEvalPrompt(
      '/tmp/ws',
      { kind: 'turnStart', ref: 'forcedTodoPlan' },
      'without',
    )
    assert.ok(withArm.includes(STEER_TURN_START_TEXTS.forcedTodoPlan))
    assert.ok(!withoutArm.includes(STEER_TURN_START_TEXTS.forcedTodoPlan))
  })

  it('a nudge steer leaves both prompts identical — it varies mid-loop', () => {
    const spec = { kind: 'nudge', ref: 'stuckFinalize', afterSteps: 3 } as const
    assert.equal(
      buildSteerEvalPrompt('/tmp/ws', spec, 'with'),
      buildSteerEvalPrompt('/tmp/ws', spec, 'without'),
    )
    assert.equal(steerText(spec), STEER_NUDGE_TEXTS.stuckFinalize)
  })

  it('resolves steer text from the shipping constants, not a copy', () => {
    assert.equal(
      steerText({ kind: 'turnStart', ref: 'commitSteering' }),
      STEER_TURN_START_TEXTS.commitSteering,
    )
    assert.match(STEER_TURN_START_TEXTS.commitSteering, /git_commit tool/)
  })
})

function attempt(armId: 'with' | 'without', compliant: boolean): SteerEvalAttempt {
  return {
    packId: 'pack',
    taskId: 'task',
    armId,
    attempt: 1,
    compliant,
    checks: [
      {
        id: 'only-check',
        kind: 'tool-used',
        pass: compliant,
        detail: compliant ? 'ok' : 'missing',
      },
    ],
    toolNames: [],
    finalMessage: 'Final answer.',
    finalChars: 13,
    inputTokens: 100,
    outputTokens: 20,
    usageEstimated: false,
    durationMs: 5,
    trace: 'trace.jsonl',
  }
}

const PACK: SteerPack = {
  id: 'pack',
  description: 'fixture pack',
  steer: { kind: 'section', ref: 'gitBranchSafety' },
  gate: { minLift: 0.3, minWithPassRate: 0.6 },
  tasks: [{ id: 'task', prompt: 'do the thing', checks: [] as never[] }],
}

describe('steer eval reporting', () => {
  it('reports lift as the steered arm minus the control arm', () => {
    const summary = summarizeSteerPack(PACK, [
      attempt('with', true),
      attempt('with', true),
      attempt('without', false),
      attempt('without', false),
    ])
    assert.equal(summary.lift, 1)
    assert.equal(summary.gatePassed, true)
    assert.equal(summary.arms.find((arm) => arm.armId === 'with')?.passRate, 1)
    assert.equal(summary.arms.find((arm) => arm.armId === 'without')?.passRate, 0)
  })

  it('fails the gate when a steer changes nothing', () => {
    const summary = summarizeSteerPack(PACK, [attempt('with', true), attempt('without', true)])
    assert.equal(summary.lift, 0)
    assert.equal(summary.gatePassed, false)
    assert.match(summary.gateDetail, /minLift/)
  })

  it('fails the gate when the steered arm is unreliable even with positive lift', () => {
    const summary = summarizeSteerPack(PACK, [
      attempt('with', true),
      attempt('with', false),
      attempt('without', false),
      attempt('without', false),
    ])
    assert.equal(summary.lift, 0.5)
    assert.equal(summary.gatePassed, false)
    assert.match(summary.gateDetail, /minWithPassRate/)
  })

  it('scores length reduction from the arm means, not an absolute threshold', () => {
    const long = { ...attempt('without', true), finalChars: 1000 }
    const short = { ...attempt('with', true), finalChars: 400 }
    const pack: SteerPack = {
      ...PACK,
      gate: { meanFinalCharsReduction: 0.5 },
    }
    const summary = summarizeSteerPack(pack, [short, long])
    assert.equal(summary.meanFinalCharsReduction, 0.6)
    assert.equal(summary.gatePassed, true)

    const tooLenient = summarizeSteerPack({ ...PACK, gate: { meanFinalCharsReduction: 0.75 } }, [
      short,
      long,
    ])
    assert.equal(tooLenient.gatePassed, false)
    assert.match(tooLenient.gateDetail, /length reduction/)
  })

  it('an empty control arm cannot manufacture a length win', () => {
    const summary = summarizeSteerPack({ ...PACK, gate: { meanFinalCharsReduction: 0.1 } }, [
      { ...attempt('with', true), finalChars: 0 },
      { ...attempt('without', true), finalChars: 0 },
    ])
    assert.equal(summary.meanFinalCharsReduction, 0)
    assert.equal(summary.gatePassed, false)
  })

  it('renders a markdown matrix with the lift column', () => {
    const markdown = renderSteerEvalMarkdown({
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      provider: 'mock',
      model: 'mock',
      repeats: 1,
      packs: [summarizeSteerPack(PACK, [attempt('with', true), attempt('without', false)])],
      attempts: [],
    })
    assert.match(markdown, /\| pack \| steer \| with \| without \| lift \| len Δ \| gate \|/)
    assert.match(markdown, /\+100%/)
  })
})

describe('shipped steer packs', () => {
  it('every pack parses against the schema', () => {
    const paths = steerPackPaths()
    assert.ok(paths.length > 0, 'expected at least one pack in benchmarks/steer/packs')
    for (const path of paths) {
      assert.doesNotThrow(() => loadSteerPack(path), `pack failed to parse: ${path}`)
    }
  })

  it('pack ids are unique and match their filename', () => {
    const seen = new Set<string>()
    for (const path of steerPackPaths()) {
      const pack = loadSteerPack(path)
      assert.equal(
        `${pack.id}.json`,
        basename(path),
        `pack id ${pack.id} does not match its filename ${basename(path)}`,
      )
      assert.ok(!seen.has(pack.id), `duplicate pack id: ${pack.id}`)
      seen.add(pack.id)
    }
  })

  it('task ids are unique within a pack and every check id is unique within a task', () => {
    for (const path of steerPackPaths()) {
      const pack = loadSteerPack(path)
      const taskIds = pack.tasks.map((task) => task.id)
      assert.equal(new Set(taskIds).size, taskIds.length, `duplicate task id in ${pack.id}`)
      for (const task of pack.tasks) {
        const checkIds = task.checks.map((check) => check.id)
        assert.equal(
          new Set(checkIds).size,
          checkIds.length,
          `duplicate check id in ${pack.id}/${task.id}`,
        )
      }
    }
  })

  it('every regex in a check compiles', () => {
    for (const path of steerPackPaths()) {
      for (const task of loadSteerPack(path).tasks) {
        for (const check of task.checks) {
          if ('pattern' in check) {
            assert.doesNotThrow(
              () => new RegExp(check.pattern),
              `bad regex in ${task.id}/${check.id}: ${check.pattern}`,
            )
          }
        }
        for (const pattern of task.allowedCommandPatterns ?? []) {
          assert.doesNotThrow(() => new RegExp(pattern), `bad command pattern in ${task.id}`)
        }
      }
    }
  })

  it('a real-model pack declares a gate — an eval with no threshold cannot fail', () => {
    for (const path of steerPackPaths()) {
      const pack = loadSteerPack(path)
      const realModelTasks = pack.tasks.filter((task) => task.mockOnly !== true)
      if (realModelTasks.length === 0) continue
      assert.ok(
        pack.gate?.minLift !== undefined || pack.gate?.minWithPassRate !== undefined,
        `pack ${pack.id} has real-model tasks but declares no gate`,
      )
    }
  })

  it('fixtures and seeded nudge reads referenced by packs exist', () => {
    for (const path of steerPackPaths()) {
      const pack = loadSteerPack(path)
      for (const task of pack.tasks) {
        if (task.fixture === undefined) {
          assert.equal(
            task.seedReadFiles,
            undefined,
            `seeded reads require a fixture in ${task.id}`,
          )
          continue
        }
        assert.ok(existsSync(task.fixture), `missing fixture ${task.fixture} for task ${task.id}`)
        for (const seededPath of task.seedReadFiles ?? []) {
          assert.equal(pack.steer.kind, 'nudge', `seeded reads require a nudge pack in ${task.id}`)
          assert.ok(
            existsSync(join(task.fixture, seededPath)),
            `missing seeded read ${seededPath} for task ${task.id}`,
          )
        }
      }
    }
  })
})

describe('steer eval CLI parsing', () => {
  it('parses provider, repeats, and pack filters', () => {
    const options = parseSteerEvalArgs([
      '--provider',
      'lmstudio',
      '--model',
      'qwen/qwen3.6-35b-a3b',
      '--repeats',
      '5',
      '--pack',
      'git-branch-safety',
      '--require-gates',
    ])
    assert.equal(options.providerId, 'lmstudio')
    assert.equal(options.model, 'qwen/qwen3.6-35b-a3b')
    assert.equal(options.repeats, 5)
    assert.equal(options.packId, 'git-branch-safety')
    assert.equal(options.requireGates, true)
    assert.equal(options.packsDir, 'benchmarks/steer/packs')
  })

  it('rejects an unknown provider', () => {
    assert.throws(() => parseSteerEvalArgs(['--provider', 'ollama']), /--provider must be one of/)
  })

  it('rejects a non-positive repeat count', () => {
    assert.throws(() => parseSteerEvalArgs(['--repeats', '0']), /--repeats must be a positive/)
  })
})
