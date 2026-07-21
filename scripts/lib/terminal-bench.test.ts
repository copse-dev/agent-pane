import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { describe, it } from 'node:test'
import { TERMINAL_BENCH_TASK_NAMES, terminalBenchTaskImage } from './terminal-bench-tasks.mts'
import {
  buildTerminalBenchLaunch,
  DEFAULT_TERMINAL_BENCH_MIN_FREE_DISK_GIB,
  DEFAULT_TERMINAL_BENCH_PREFETCH_MIN_FREE_DISK_GIB,
  HARBOR_VERSION,
  TERMINAL_BENCH_AGENT,
  TERMINAL_BENCH_DATASET,
  terminalBenchCompletedTaskNames,
  terminalBenchDiskSpaceError,
  terminalBenchFatalInfrastructureOutput,
  terminalBenchMinimumFreeDiskBytes,
  terminalBenchModel,
  terminalBenchPrefetchMinimumFreeDiskBytes,
} from './terminal-bench.mts'

const env = { LM_STUDIO_MODEL: 'local/test-model', LM_STUDIO_API_KEY: 'test-key' }

describe('terminal benchmark launcher', () => {
  it('pins the complete 2.0 task registry without duplicates', () => {
    assert.equal(TERMINAL_BENCH_TASK_NAMES.length, 89)
    assert.equal(new Set(TERMINAL_BENCH_TASK_NAMES).size, 89)
    assert.equal(
      terminalBenchTaskImage('adaptive-rejection-sampler'),
      'alexgshaw/adaptive-rejection-sampler:20251031',
    )
  })

  it('builds a cheap local smoke run by default', () => {
    const launch = buildTerminalBenchLaunch([], env)
    assert.equal(launch.command, 'uvx')
    assert.deepEqual(launch.args.slice(0, 4), [
      '--from',
      `harbor==${HARBOR_VERSION}`,
      'harbor',
      'run',
    ])
    assert.ok(launch.args.includes(TERMINAL_BENCH_DATASET))
    assert.ok(launch.args.includes(TERMINAL_BENCH_AGENT))
    assert.deepEqual(launch.args.slice(launch.args.indexOf('--n-concurrent'), -2), [
      '--n-concurrent',
      '1',
      '--n-attempts',
      '1',
    ])
    assert.deepEqual(launch.args.slice(-2), ['--n-tasks', '1'])
    assert.match(launch.env['COPSE_TERMINAL_AGENT_BUNDLE'] ?? '', /terminal-bench-agent\.cjs$/)
    assert.equal(launch.env['PYTHONPATH'], process.cwd())
  })

  it('keeps an existing Python import path after the repository root', () => {
    const launch = buildTerminalBenchLaunch([], { ...env, PYTHONPATH: '/existing/python/path' })
    assert.equal(launch.env['PYTHONPATH'], `${process.cwd()}${delimiter}/existing/python/path`)
  })

  it('removes the local task cap for a full-suite run and preserves overrides', () => {
    const launch = buildTerminalBenchLaunch(
      ['--all', '-k', '5', '-n', '2', '--include-task-name', 'example-*'],
      env,
    )
    assert.equal(launch.args.includes('--all'), false)
    assert.equal(launch.args.includes('--n-tasks'), false)
    assert.deepEqual(launch.args.slice(-6), [
      '-k',
      '5',
      '-n',
      '2',
      '--include-task-name',
      'example-*',
    ])
  })

  it('does not add a task cap when a single registry task is selected', () => {
    const launch = buildTerminalBenchLaunch(['--task', 'terminal-bench/example'], env)
    assert.equal(launch.args.includes('--n-tasks'), false)
  })

  it('requires an explicit local model', () => {
    assert.throws(() => terminalBenchModel({}), /LM_STUDIO_MODEL/)
  })

  it('resumes completed outcomes but retries infrastructure-invalid trials', () => {
    assert.deepEqual(
      terminalBenchCompletedTaskNames([
        { task_name: 'pass', exception_info: null },
        { task_name: 'timeout', exception_info: { exception_type: 'AgentTimeoutError' } },
        { task_name: 'docker-failed', exception_info: { exception_type: 'RuntimeError' } },
        { task_name: 'stream-failed', exception_info: { exception_type: 'TypeError' } },
        { task_name: 'pass', exception_info: null },
      ]),
      ['pass', 'timeout'],
    )
  })

  it('guards enough host disk for large task images', () => {
    const required = terminalBenchMinimumFreeDiskBytes(env)
    assert.equal(required, DEFAULT_TERMINAL_BENCH_MIN_FREE_DISK_GIB * 1024 ** 3)
    assert.match(terminalBenchDiskSpaceError(required - 1, env) ?? '', /at least 15\.0 GiB/)
    assert.equal(terminalBenchDiskSpaceError(required, env), undefined)
    assert.equal(
      terminalBenchMinimumFreeDiskBytes({ ...env, COPSE_TERMINAL_MIN_FREE_DISK_GIB: '2.5' }),
      2.5 * 1024 ** 3,
    )
    assert.equal(
      terminalBenchPrefetchMinimumFreeDiskBytes(env),
      DEFAULT_TERMINAL_BENCH_PREFETCH_MIN_FREE_DISK_GIB * 1024 ** 3,
    )
    assert.equal(
      terminalBenchPrefetchMinimumFreeDiskBytes({
        ...env,
        COPSE_TERMINAL_PREFETCH_MIN_FREE_DISK_GIB: '40',
      }),
      40 * 1024 ** 3,
    )
  })

  it('recognizes fatal Docker host failures without matching ordinary task output', () => {
    assert.equal(
      terminalBenchFatalInfrastructureOutput(
        'failed to register layer: write /torch/lib.so: input/output error',
      ),
      'Docker image extraction failed',
    )
    assert.equal(
      terminalBenchFatalInfrastructureOutput('Docker daemon is not running. Please start Docker.'),
      'Docker daemon stopped',
    )
    assert.equal(
      terminalBenchFatalInfrastructureOutput('command exited 1: no space left'),
      undefined,
    )
  })
})
