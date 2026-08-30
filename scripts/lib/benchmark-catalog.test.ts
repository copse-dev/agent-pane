import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { BenchTranscript } from './bench-transcript.mts'
import { buildBenchmarkData, buildBenchmarkSite, type LowWorkFloor } from './benchmark-catalog.mts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'copse-benchmarks-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

interface TrialFixture {
  attempt: number
  inputTokens: number
  outputTokens: number
  profile: string
  reward: number
  runId: string
  task?: string
  toolCalls: number
  verifierError?: string
}

function writeTrace(directory: string, fixture: TrialFixture): void {
  let sequence = 0
  const transcript = new BenchTranscript(
    directory,
    `Complete ${fixture.task ?? 'court-form-filling'} safely.`,
    'test-model',
    {
      now: 1_700_000_000_000,
      idFactory: (): string => `fixture-${String(++sequence)}`,
      projectId: 'benchmarks',
    },
  )
  transcript.record({ type: 'reasoning', text: `I should compare the ${fixture.profile} path.` })
  transcript.record({
    type: 'tool_call',
    toolCall: { id: 'shell-1', name: 'run_shell', args: { command: 'ls -la' } },
  })
  transcript.record({
    type: 'tool_result',
    toolCallId: 'shell-1',
    result: 'total 8\n-rw-r--r-- task.txt',
    isError: false,
  })
  transcript.record({ type: 'text', text: `Finished with ${fixture.profile}.` })
  transcript.record({
    type: 'usage',
    model: 'test-model',
    inputTokens: fixture.inputTokens,
    outputTokens: fixture.outputTokens,
  })
  transcript.record({ type: 'done', stopReason: 'end_turn' })
  transcript.write()
}

function writeSkillsTrial(root: string, fixture: TrialFixture): void {
  const task = fixture.task ?? 'court-form-filling'
  const id = `${task}__${fixture.profile.replace('@', '-')}__attempt-${String(fixture.attempt)}`
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeTrace(join(directory, 'thread'), { ...fixture, task })
  writeFileSync(
    join(directory, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      benchmark: { id: 'skillsbench', version: '1.1' },
      task: { name: task },
      profile: { id: fixture.profile },
      runId: fixture.runId,
      createdAt: '2026-08-26T12:00:00.000Z',
      sourceCommit: 'skills-commit',
      model: 'test-model',
      attempt: fixture.attempt,
      elapsedSeconds: 92.5,
      officialReward: fixture.reward,
      result: {
        n_tool_calls: fixture.toolCalls,
        n_skill_invocations: fixture.profile.includes('product') ? 1 : 0,
        n_input_tokens: fixture.inputTokens,
        n_output_tokens: fixture.outputTokens,
        error: null,
        verifier_error: fixture.verifierError ?? null,
        verifier_error_category: fixture.verifierError ? 'grader-crash' : null,
        partial_trajectory: false,
      },
    })}\n`,
  )
}

function writeTerminalTrial(root: string, fixture: TrialFixture, exception: unknown = null): void {
  const task = fixture.task ?? 'regex-log'
  const directory = join(root, `${task}-trial-${String(fixture.attempt)}`)
  mkdirSync(directory, { recursive: true })
  writeTrace(join(directory, 'agent', 'thread'), { ...fixture, task })
  writeFileSync(
    join(directory, 'run-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      trialId: `${task}-trial-${String(fixture.attempt)}`,
      suiteRunId: fixture.runId,
      createdAt: '2026-08-27T12:00:00.000Z',
      task: {
        name: task,
        attemptIndex: fixture.attempt,
        startedAt: '2026-08-27T11:45:00.000Z',
        finishedAt: '2026-08-27T12:00:00.000Z',
        reward: fixture.reward,
        exception,
      },
      model: 'test-model',
      dataset: { id: 'terminal-bench', version: '2.1' },
      profile: { id: 'main', versionedId: fixture.profile },
      source: { commit: 'terminal-commit' },
      metrics: {
        elapsedSeconds: 900,
        inputTokens: fixture.inputTokens,
        outputTokens: fixture.outputTokens,
        toolCalls: fixture.toolCalls,
      },
    })}\n`,
  )
}

const LOW_WORK_FLOOR: LowWorkFloor = { minInputTokens: 1_000, minToolCalls: 3 }

describe('benchmark catalog', () => {
  it('normalizes SkillsBench traces and flags low-work trials', async () => {
    const root = temporaryDirectory()
    writeSkillsTrial(root, {
      attempt: 1,
      inputTokens: 982,
      outputTokens: 273,
      profile: 'skills-product@1',
      reward: 0,
      runId: 'study-42-shard-0',
      toolCalls: 2,
    })
    writeSkillsTrial(root, {
      attempt: 1,
      inputTokens: 18_824,
      outputTokens: 1_603,
      profile: 'skills-none@1',
      reward: 1,
      runId: 'study-42-shard-0',
      toolCalls: 14,
    })

    const data = await buildBenchmarkData({
      artifactRoots: [root],
      generatedAt: new Date('2026-08-27T01:00:00.000Z'),
      lowWorkFloor: LOW_WORK_FLOOR,
    })

    assert.equal(data.catalog.runs.length, 1)
    const run = data.runs[0]
    assert.ok(run)
    assert.equal(run.trials.length, 2)
    assert.deepEqual(data.catalog.warnings, [])
    const lowWork = run.trials.find((trial) => trial.variant === 'skills-product@1')
    assert.ok(lowWork)
    assert.equal(lowWork.runId, 'study-42')
    assert.deepEqual(lowWork.flags, ['low-work'])
    assert.equal(lowWork.prompt, 'Complete court-form-filling safely.')
    assert.equal(lowWork.trace.length, 3)
    assert.equal(lowWork.trace[1]?.toolCalls[0]?.name, 'run_shell')
    assert.equal(data.catalog.runs[0]?.passed, 1)
  })

  it('normalizes Terminal-Bench run manifests and timeout outcomes', async () => {
    const root = temporaryDirectory()
    writeTerminalTrial(
      root,
      {
        attempt: 1,
        inputTokens: 8_000,
        outputTokens: 900,
        profile: 'main@3',
        reward: 0,
        runId: 'terminal-nightly-7',
        task: 'regex-log',
        toolCalls: 9,
      },
      { exception_type: 'AgentTimeoutError', message: 'Agent exceeded 900 seconds' },
    )

    const data = await buildBenchmarkData({ artifactRoots: [root] })
    const trial = data.runs[0]?.trials[0]
    assert.ok(trial)
    assert.equal(trial.benchmark, 'terminal-bench')
    assert.equal(trial.outcome, 'timeout')
    assert.equal(trial.agentErrorCategory, 'AgentTimeoutError')
    assert.equal(trial.trace.length, 3)
    assert.equal(data.catalog.runs[0]?.sourceCommits[0], 'terminal-commit')
  })

  it('keeps valid runs while warning about malformed source manifests', async () => {
    const root = temporaryDirectory()
    writeSkillsTrial(root, {
      attempt: 1,
      inputTokens: 5_000,
      outputTokens: 500,
      profile: 'skills-none@1',
      reward: 0,
      runId: 'study-mixed',
      toolCalls: 6,
    })
    const invalid = join(root, 'invalid-source')
    mkdirSync(invalid)
    writeFileSync(join(invalid, 'manifest.json'), '{"schemaVersion":"wrong"}\n')

    const data = await buildBenchmarkData({ artifactRoots: [root] })
    assert.equal(data.runs[0]?.trials.length, 1)
    assert.match(data.catalog.warnings[0] ?? '', /invalid SkillsBench manifest/)
  })

  it('writes a portable catalog with lazy run and trial payloads', async () => {
    const skills = temporaryDirectory()
    const terminal = temporaryDirectory()
    const output = join(temporaryDirectory(), 'site')
    writeSkillsTrial(skills, {
      attempt: 1,
      inputTokens: 4_000,
      outputTokens: 600,
      profile: 'skills-none@1',
      reward: 1,
      runId: 'skills-static',
      toolCalls: 5,
    })
    writeTerminalTrial(terminal, {
      attempt: 1,
      inputTokens: 6_000,
      outputTokens: 700,
      profile: 'main@3',
      reward: 1,
      runId: 'terminal-static',
      toolCalls: 7,
    })

    const first = await buildBenchmarkSite({
      artifactRoots: [skills],
      outputDir: output,
    })
    const firstRun = first.runs[0]
    assert.ok(firstRun)
    const firstRunIndex = join(output, 'runs', firstRun.summary.slug, 'index.json')
    assert.equal(existsSync(firstRunIndex), true)

    const data = await buildBenchmarkSite({
      append: true,
      artifactRoots: [terminal],
      outputDir: output,
    })
    assert.equal(data.catalog.runs.length, 2)
    assert.equal(existsSync(firstRunIndex), true)
    assert.match(readFileSync(join(output, 'index.html'), 'utf8'), /Content-Security-Policy/)
    assert.match(readFileSync(join(output, 'app.js'), 'utf8'), /textContent/)
    assert.equal(existsSync(join(output, 'assets', 'Pliant-Variable.ttf')), true)
    const catalog: unknown = JSON.parse(readFileSync(join(output, 'catalog.json'), 'utf8'))
    assert.deepEqual(catalog, data.catalog)
    assert.equal(existsSync(join(output, 'archive.json')), false)
    for (const run of [firstRun, ...data.runs]) {
      const indexPath = join(output, 'runs', run.summary.slug, 'index.json')
      assert.equal(existsSync(indexPath), true)
      const runIndex = readFileSync(indexPath, 'utf8')
      assert.doesNotMatch(runIndex, /"trace":/)
      assert.equal(
        existsSync(
          join(output, 'runs', run.summary.slug, 'trials', `${run.trials[0]?.slug ?? ''}.json`),
        ),
        true,
      )
    }
  })
})
