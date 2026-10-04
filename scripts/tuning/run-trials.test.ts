import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeConfig } from './configs.mts'
import { MemoryLedger } from './ledger.mts'
import { buildHarborLaunch, observeJob, observeTrial, type HarborLaunch } from './harbor-run.mts'
import {
  buildTrialRecord,
  parseTaskArgument,
  planBatches,
  runTrials,
  type RunnerDeps,
  type RunTrialsOptions,
} from './run-trials.mts'

const config = makeConfig('default', { reasoningRecoveryMaxTokens: 4096 })
const other = makeConfig('other', { reasoningRecoveryMaxTokens: 8192 })

interface FakeTrial {
  task: string
  reward?: number | null
  exceptionType?: string
  stderr?: string
  /** Record this tuning as applied (default: the config's own). */
  applied?: unknown
  omitApplied?: boolean
}

/** Write a Harbor-shaped trial directory under a job directory. */
function writeTrial(jobDir: string, tuning: unknown, trial: FakeTrial): void {
  const dir = join(jobDir, `${trial.task}__abc123`)
  mkdirSync(join(dir, 'agent', 'out'), { recursive: true })
  const reward = trial.reward === undefined ? 1 : trial.reward
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({
      task_name: `terminal-bench/${trial.task}`,
      started_at: '2026-10-04T10:00:00Z',
      finished_at: '2026-10-04T10:10:00Z',
      verifier_result: reward === null ? null : { rewards: { reward } },
      exception_info:
        trial.exceptionType === undefined
          ? null
          : { exception_type: trial.exceptionType, exception_message: 'boom' },
      agent_result: { n_input_tokens: 10, n_output_tokens: 5 },
    }),
  )
  writeFileSync(
    join(dir, 'agent', 'out', 'result.json'),
    JSON.stringify({
      stopReason: 'completed',
      promptsAttempted: 0,
      deferrals: [{}, {}],
      denials: [{}],
      usage: { inputTokens: 1234, outputTokens: 567 },
    }),
  )
  writeFileSync(
    join(dir, 'agent', 'driver-summary.json'),
    JSON.stringify({ wallMs: 90_000, modelCalls: 33 }),
  )
  if (trial.omitApplied !== true) {
    writeFileSync(
      join(dir, 'agent', 'out', 'tuning.applied.json'),
      JSON.stringify({ schemaVersion: 1, requested: trial.applied ?? tuning }),
    )
  }
  if (trial.stderr !== undefined)
    writeFileSync(join(dir, 'agent', 'driver.stderr.log'), trial.stderr)
}

function fakeDeps(
  script: (launch: HarborLaunch, jobDir: string) => void,
  calls: HarborLaunch[] = [],
): RunnerDeps {
  let clock = Date.parse('2026-10-04T10:00:00Z')
  return {
    execute: (launch): Promise<number> => {
      calls.push(launch)
      const jobDir = launch.args[launch.args.indexOf('--jobs-dir') + 1] ?? ''
      const name = launch.args[launch.args.indexOf('--job-name') + 1] ?? ''
      script(launch, join(jobDir, name))
      return Promise.resolve(0)
    },
    observeJob,
    loadedModels: () => Promise.resolve(['qwen3.6-35b-a3b']),
    codeRevision: () => 'deadbeef',
    now: (): Date => new Date((clock += 1000)),
    log: (): void => {},
  }
}

function baseOptions(
  jobsDir: string,
  store: MemoryLedger,
  overrides: Partial<RunTrialsOptions> = {},
): RunTrialsOptions {
  return {
    configs: [config],
    tasks: ['regex-log'],
    reps: 1,
    batchSize: 2,
    maxAttempts: 1,
    model: 'qwen3.6-35b-a3b',
    jobsDir,
    repoRoot: '/repo',
    env: { PATH: '/bin', COPSE_HARBOR_MAX_STEPS: '50' },
    dryRun: false,
    store,
    registry: null,
    ...overrides,
  }
}

function withJobsDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tuning-run-'))
  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

describe('planning jobs', () => {
  it('interleaves configs within each rep and batches tasks', () => {
    const pending = [config, other].flatMap((c) =>
      [1, 2].flatMap((rep) => ['a', 'b', 'c'].map((task) => ({ config: c, task, rep }))),
    )
    const batches = planBatches(pending, [config, other], 2)
    assert.deepEqual(
      batches.map((b) => `${b.config.id}:r${String(b.rep)}:${b.tasks.join('+')}`),
      [
        'default:r1:a+b',
        'default:r1:c',
        'other:r1:a+b',
        'other:r1:c',
        'default:r2:a+b',
        'default:r2:c',
        'other:r2:a+b',
        'other:r2:c',
      ],
    )
  })

  it('parses task lists from a comma list or an @file, rejecting unknown names', () => {
    assert.deepEqual(
      parseTaskArgument('regex-log,largest-eigenval', () => ''),
      ['regex-log', 'largest-eigenval'],
    )
    assert.deepEqual(
      parseTaskArgument('@list', () => '# screen\nregex-log\n\nlargest-eigenval # flips\n'),
      ['regex-log', 'largest-eigenval'],
    )
    assert.throws(
      () => parseTaskArgument('not-a-task', () => ''),
      /unknown Terminal-Bench task names/,
    )
  })
})

describe('the Harbor launch', () => {
  it('passes the tuning only as COPSE_HARBOR_TUNING and drops the legacy step-limit variable', () => {
    const launch = buildHarborLaunch({
      model: 'm',
      tasks: ['regex-log'],
      jobName: 'job-1',
      jobsDir: '/jobs',
      tuning: config.tuning,
      repoRoot: '/repo',
      env: { PATH: '/bin', PYTHONPATH: '/lib', COPSE_HARBOR_MAX_STEPS: '50' },
    })
    assert.equal(launch.command, 'uvx')
    assert.deepEqual(launch.args.slice(0, 5), [
      '--from',
      'harbor==0.16.1',
      'harbor',
      'run',
      '--dataset',
    ])
    assert.ok(
      launch.args.includes('benchmarks.terminal_bench.copse_container_agent:CopseContainerAgent'),
    )
    assert.ok(launch.args.includes('terminal-bench/regex-log'))
    assert.equal(launch.env['COPSE_HARBOR_TUNING'], '{"reasoningRecoveryMaxTokens":4096}')
    assert.equal(launch.env['COPSE_HARBOR_MAX_STEPS'], undefined)
    assert.equal(launch.env['PYTHONPATH'], '/repo:/lib')
    assert.equal(launch.env['LM_STUDIO_MODEL'], 'm')
  })
})

describe('reading a finished trial', () => {
  it('reads reward, timing, calls, tokens, stop reason and counts from the trial directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuning-observe-'))
    try {
      writeTrial(dir, config.tuning, { task: 'regex-log' })
      const observation = observeTrial(join(dir, 'regex-log__abc123'))
      assert.ok(observation)
      assert.equal(observation.task, 'regex-log')
      assert.equal(observation.reward, 1)
      assert.equal(observation.agentSeconds, 90)
      assert.equal(observation.modelCalls, 33)
      assert.equal(observation.inputTokens, 1234)
      assert.equal(observation.outputTokens, 567)
      assert.equal(observation.stopReason, 'completed')
      assert.equal(observation.deferrals, 2)
      assert.equal(observation.denials, 1)
      assert.equal(observation.promptsAttempted, 0)
      assert.equal(observeJob(dir).get('regex-log')?.reward, 1)
      assert.equal(observeTrial(join(dir, 'missing')), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('running trials', () => {
  it('records one line per trial with provenance, marks invalid ones, and keeps them', async () => {
    await withJobsDir(async (jobsDir) => {
      const store = new MemoryLedger()
      const deps = fakeDeps((_launch, jobDir) => {
        const tuning = config.tuning
        writeTrial(jobDir, tuning, { task: 'regex-log', reward: 1 })
        writeTrial(jobDir, tuning, {
          task: 'largest-eigenval',
          reward: 0,
          exceptionType: 'RuntimeError',
        })
      })
      const result = await runTrials(
        baseOptions(jobsDir, store, { tasks: ['regex-log', 'largest-eigenval', 'fix-git'] }),
        deps,
      )
      assert.equal(result.recorded, 3)
      const [pass, bad, missing] = store.read()
      assert.ok(pass && bad && missing)
      assert.equal(pass.valid, true)
      assert.equal(pass.reward, 1)
      assert.equal(pass.config.hash, config.hash)
      assert.deepEqual(pass.tuning, config.tuning)
      assert.equal(pass.agentSeconds, 90)
      assert.equal(pass.modelCalls, 33)
      assert.deepEqual(pass.lmStudioModels, ['qwen3.6-35b-a3b'])
      assert.equal(pass.codeRevision, 'deadbeef')
      assert.equal(bad.valid, false)
      assert.deepEqual(bad.invalidReasons, ['exception:RuntimeError'])
      assert.equal(bad.exception?.type, 'RuntimeError')
      assert.equal(missing.valid, false)
      assert.deepEqual(missing.invalidReasons, ['no-trial-result'])
    })
  })

  it('treats AgentTimeoutError as a valid failed attempt but a connection error as invalid', async () => {
    await withJobsDir(async (jobsDir) => {
      const store = new MemoryLedger()
      const deps = fakeDeps((_launch, jobDir) => {
        writeTrial(jobDir, config.tuning, {
          task: 'regex-log',
          reward: 0,
          exceptionType: 'AgentTimeoutError',
        })
        writeTrial(jobDir, config.tuning, {
          task: 'largest-eigenval',
          reward: 0,
          stderr: 'Error: fetch failed: connect ECONNREFUSED 127.0.0.1:1234\n',
        })
      })
      await runTrials(
        baseOptions(jobsDir, store, { tasks: ['regex-log', 'largest-eigenval'] }),
        deps,
      )
      const [timeout, refused] = store.read()
      assert.ok(timeout && refused)
      assert.equal(timeout.valid, true)
      assert.equal(timeout.exception?.type, 'AgentTimeoutError')
      assert.equal(refused.valid, false)
      assert.deepEqual(refused.invalidReasons, ['log:connection-error'])
    })
  })

  it('invalidates a trial that did not apply the requested tuning', async () => {
    await withJobsDir(async (jobsDir) => {
      const store = new MemoryLedger()
      const deps = fakeDeps((_launch, jobDir) => {
        writeTrial(jobDir, config.tuning, {
          task: 'regex-log',
          applied: { reasoningRecoveryMaxTokens: 1 },
        })
        writeTrial(jobDir, config.tuning, { task: 'largest-eigenval', omitApplied: true })
      })
      await runTrials(
        baseOptions(jobsDir, store, { tasks: ['regex-log', 'largest-eigenval'] }),
        deps,
      )
      assert.deepEqual(
        store.read().map((record) => record.invalidReasons),
        [['tuning-not-applied'], ['tuning-not-applied']],
      )
    })
  })

  it('is resumable: a second call over the same cells launches nothing', async () => {
    await withJobsDir(async (jobsDir) => {
      const store = new MemoryLedger()
      const calls: HarborLaunch[] = []
      const deps = fakeDeps((_launch, jobDir) => {
        for (const task of ['regex-log', 'largest-eigenval'])
          writeTrial(jobDir, config.tuning, { task })
      }, calls)
      const options = baseOptions(jobsDir, store, {
        tasks: ['regex-log', 'largest-eigenval'],
        reps: 2,
      })
      const first = await runTrials(options, deps)
      assert.equal(first.recorded, 4)
      assert.equal(calls.length, 2)
      const second = await runTrials(options, deps)
      assert.equal(second.recorded, 0)
      assert.equal(second.skipped, 4)
      assert.equal(calls.length, 2)
      const wider = await runTrials({ ...options, reps: 3 }, deps)
      assert.equal(wider.recorded, 2)
      assert.equal(calls.length, 3)
    })
  })

  it('interleaves candidate and incumbent jobs rep by rep', async () => {
    await withJobsDir(async (jobsDir) => {
      const store = new MemoryLedger()
      const order: string[] = []
      const deps = fakeDeps((launch, jobDir) => {
        order.push(launch.env['COPSE_HARBOR_TUNING'] ?? '')
        const tuning = launch.env['COPSE_HARBOR_TUNING']?.includes('8192')
          ? other.tuning
          : config.tuning
        writeTrial(jobDir, tuning, { task: 'regex-log' })
      })
      await runTrials(baseOptions(jobsDir, store, { configs: [config, other], reps: 2 }), deps)
      assert.deepEqual(order, [
        '{"reasoningRecoveryMaxTokens":4096}',
        '{"reasoningRecoveryMaxTokens":8192}',
        '{"reasoningRecoveryMaxTokens":4096}',
        '{"reasoningRecoveryMaxTokens":8192}',
      ])
    })
  })

  it('dry-run prints the exact command lines and env and neither runs nor records anything', async () => {
    await withJobsDir(async (jobsDir) => {
      const store = new MemoryLedger()
      const calls: HarborLaunch[] = []
      const lines: string[] = []
      const deps: RunnerDeps = { ...fakeDeps(() => {}, calls), log: (line) => lines.push(line) }
      const result = await runTrials(
        baseOptions(jobsDir, store, { dryRun: true, tasks: ['regex-log', 'largest-eigenval'] }),
        deps,
      )
      assert.equal(calls.length, 0)
      assert.equal(store.read().length, 0)
      assert.equal(result.jobs.length, 1)
      const text = lines.join('\n')
      assert.match(text, /'uvx' '--from' 'harbor==0\.16\.1' 'harbor' 'run'/)
      assert.match(
        text,
        /'--include-task-name' 'terminal-bench\/regex-log' '--include-task-name' 'terminal-bench\/largest-eigenval'/,
      )
      assert.match(text, /COPSE_HARBOR_TUNING='\{"reasoningRecoveryMaxTokens":4096\}'/)
      assert.doesNotMatch(text, /COPSE_HARBOR_MAX_STEPS/)
    })
  })
})

describe('buildTrialRecord', () => {
  it('fills a no-result record when the trial left nothing', () => {
    const record = buildTrialRecord({
      config,
      task: 'regex-log',
      rep: 1,
      observation: null,
      jobDir: '/jobs/x',
      lmStudioModels: null,
      codeRevision: null,
      startedAt: '2026-10-04T10:00:00.000Z',
      finishedAt: '2026-10-04T10:01:00.000Z',
    })
    assert.equal(record.valid, false)
    assert.equal(record.reward, null)
    assert.equal(record.lmStudioModels, null)
    assert.equal(record.trialDir, null)
  })
})
