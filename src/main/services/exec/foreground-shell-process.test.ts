import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  SandboxManager,
  SandboxViolationStore,
  type WrapWithSandboxOptions,
} from '@anthropic-ai/sandbox-runtime'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { detectSandboxFailure } from '../security/sandbox-failure.ts'
import { runShellOnce } from './foreground-shell-process.ts'
import { setShellOutputSink } from './shell-output-context.ts'
import {
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  listBackgroundProcessPids,
  stopAllBackgroundProcesses,
} from './background-process.ts'
import {
  installBackgroundProcessSupervisor,
  runWithBackgroundProcessSupervisor,
  stopSupervisedBackgroundProcess,
} from './supervised-background-process.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'

const OWNER = { projectId: 'project-send-now', threadId: 'thread-send-now' }
const COMMAND = `echo ready $$; sleep 1; node -e "console.log('finished')"`

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Process did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('foreground shell interruption', () => {
  let root: string
  let supervisor: TaskSupervisor
  let dispose: () => void

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-send-now-'))
    supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root }),
    })
    dispose = installBackgroundProcessSupervisor(supervisor)
    await supervisor.start()
  })
  afterEach(async () => {
    setShellOutputSink(null)
    stopAllBackgroundProcesses()
    await supervisor.shutdown()
    dispose()
    rmSync(root, { recursive: true, force: true })
  })

  function start(
    command = COMMAND,
    timeout = 5_000,
  ): {
    controller: AbortController
    result: ReturnType<typeof runShellOnce>
    ready: Promise<string>
  } {
    const controller = new AbortController()
    let readyOutput = ''
    let announce: (output: string) => void = () => {}
    const ready = new Promise<string>((resolve) => {
      announce = resolve
    })
    setShellOutputSink((chunk) => {
      readyOutput += chunk
      if (readyOutput.includes('ready')) announce(readyOutput)
    })
    const result = runWithThreadExecutionContext(
      { ...OWNER, projectRoot: root, root, checkoutMode: 'shared', branch: null },
      () => runShellOnce(command, root, timeout, controller.signal, true, process.env),
    )
    return { controller, result, ready }
  }

  it('Send now keeps the same child alive, retains output, and tracks completion', async () => {
    const run = start()
    const ready = await run.ready
    run.controller.abort('send_now')
    const result = await run.result
    assert.ok(result.backgroundId)
    const pid = Number(/ready (\d+)/.exec(ready)?.[1])
    // The transferred shell keeps the PID it announced before Send now.
    assert.ok(pid > 0)
    process.kill(pid, 0)
    assert.equal(listBackgroundProcessPids()[0]?.pid, pid)
    assert.match(getBackgroundProcessLogs(result.backgroundId, OWNER) ?? '', /ready/)
    assert.deepEqual(listBackgroundProcesses({ ...OWNER, threadId: 'other' }), [])
    const task = supervisor
      .list(OWNER.projectId)
      .find((item) => item.processHandleId === result.backgroundId)
    assert.ok(task)
    await waitUntil(() => supervisor.get(OWNER.projectId, task.taskId)?.state === 'completed')
    assert.match(getBackgroundProcessLogs(result.backgroundId, OWNER) ?? '', /finished/)
    assert.equal(listBackgroundProcesses(OWNER)[0]?.exitCode, 0)
  })

  it('keeps error evidence when transferred work emits more than the background output cap', async () => {
    const script = [
      "console.log('ready')",
      'setTimeout(() => {',
      "console.log('building target\\n'.repeat(5000))",
      "console.log('src/core/parse.ts:88:13 - error TS2345: bad argument')",
      "console.log('building target\\n'.repeat(5000))",
      '}, 1_000)',
    ].join(';')
    const run = start(`node -e ${JSON.stringify(script)}`)
    await run.ready
    run.controller.abort('send_now')
    const result = await run.result
    assert.ok(result.backgroundId)
    await waitUntil(() => listBackgroundProcesses(OWNER)[0]?.running === false)
    const output = getBackgroundProcessLogs(result.backgroundId, OWNER) ?? ''
    assert.match(output, /src\/core\/parse.ts:88:13 - error TS2345: bad argument/)
    assert.match(output, /dropped \d+ bytes/)
  })

  it('Stop cancels the foreground command instead of adopting it', async () => {
    const run = start()
    await run.ready
    run.controller.abort()
    await run.result
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
    assert.deepEqual(supervisor.list(OWNER.projectId), [])
  })

  it('preserves the originating supervisor context when Send now arrives from another caller', async () => {
    dispose()
    const run = runWithBackgroundProcessSupervisor(supervisor, () => start())
    await run.ready
    run.controller.abort('send_now')
    const result = await run.result
    assert.ok(result.backgroundId)
    assert.equal(supervisor.list(OWNER.projectId)[0]?.processHandleId, result.backgroundId)
  })

  it('keeps the original deadline after Send now', async () => {
    const run = start(`node -e "console.log('ready');setTimeout(()=>{},30000)"`, 1_500)
    await run.ready
    run.controller.abort('send_now')
    const result = await run.result
    assert.ok(result.backgroundId)
    await waitUntil(() => listBackgroundProcesses(OWNER)[0]?.running === false)
    assert.equal(listBackgroundProcesses(OWNER)[0]?.timedOut, true)
  })

  it('allows stopping transferred work through the existing background control', async () => {
    const run = start(`node -e "console.log('ready');setTimeout(()=>{},30000)"`)
    await run.ready
    run.controller.abort('send_now')
    const result = await run.result
    assert.ok(result.backgroundId)
    assert.equal(await stopSupervisedBackgroundProcess(result.backgroundId, OWNER), true)
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
    assert.equal(supervisor.list(OWNER.projectId)[0]?.state, 'cancelled')
  })

  it('refuses unsandboxed commands in a read-only checkout before starting a child', async () => {
    await assert.rejects(
      runShellOnce(
        'echo unexpected',
        root,
        5_000,
        new AbortController().signal,
        true,
        process.env,
        [],
        undefined,
        true,
      ),
      /A read-only checkout cannot run commands outside the project sandbox/,
    )
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
    assert.deepEqual(supervisor.list(OWNER.projectId), [])
  })

  it('rejects a pre-aborted call without starting a child', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runShellOnce('echo unexpected', root, 5_000, controller.signal, true, process.env),
    )
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
  })
})

// ASRT keeps its violation store for the whole session and, for a wrap without a
// command id, keys each violation on the first 100 characters of the command
// text. These runs stub only the wrapper; the store is ASRT's real one, and the
// stub attributes violations exactly as ASRT does (`commandId ?? command`).
describe('foreground shell sandbox violation attribution', () => {
  let root: string
  let store: SandboxViolationStore
  /** Attribution keys the wrapper saw, one per sandboxed run, in order. */
  let runKeys: string[]
  /** Violations each wrap records, keyed by the run index they belong to. */
  let violationsDuringWrap: (runIndex: number) => number[]

  function recordViolation(key: string): void {
    store.addViolation({
      line: 'deny(1) file-read-data /Users/someone/.ssh/id_ed25519',
      encodedCommand: Buffer.from(key.slice(0, 100)).toString('base64'),
      timestamp: new Date(),
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-violation-attribution-'))
    store = new SandboxViolationStore()
    runKeys = []
    violationsDuringWrap = () => []
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {})
    mock.method(SandboxManager, 'getSandboxViolationStore', () => store)
    mock.method(
      SandboxManager,
      'wrapWithSandboxArgv',
      (
        command: string,
        _binShell?: unknown,
        _customConfig?: unknown,
        _abortSignal?: AbortSignal,
        _cwd?: string,
        options?: WrapWithSandboxOptions,
      ) => {
        const runIndex = runKeys.length
        runKeys.push(options?.commandId ?? command)
        for (const owner of violationsDuringWrap(runIndex)) {
          const key = runKeys[owner]
          if (key !== undefined) recordViolation(key)
        }
        return Promise.resolve({ argv: ['/bin/sh', '-c', command], env: { ...process.env } })
      },
    )
    setProjectSandboxEnabled(true)
  })
  afterEach(() => {
    setProjectSandboxEnabled(false)
    mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  })

  function run(command: string, exitCode: number): ReturnType<typeof runShellOnce> {
    return runShellOnce(command, root, 5_000, new AbortController().signal, false, {
      COPSE_TEST_EXIT: String(exitCode),
    })
  }

  it('does not count an earlier run of the same command against a later failure', async () => {
    const command = 'pnpm test >/dev/null 2>&1; exit "$COPSE_TEST_EXIT"'
    // The first run touches a denied path but succeeds; the second fails on its own.
    violationsDuringWrap = (runIndex) => (runIndex === 0 ? [0] : [])
    const first = await run(command, 0)
    const second = await run(command, 1)

    assert.equal(first.sandboxViolationCount, 1)
    assert.equal(second.exitCode, 1)
    assert.equal(second.sandboxViolationCount, 0)
    assert.notEqual(runKeys[0], runKeys[1], 'each run is wrapped with its own violation id')
    const detection = detectSandboxFailure({
      exitCode: second.exitCode,
      violationCount: second.sandboxViolationCount ?? 0,
      spawnFailed: second.spawnFailed ?? false,
    })
    assert.equal(detection.likely, false, 'an ordinary failure is not offered an unsandboxed retry')
  })

  it('does not share violations between commands with the same first 100 characters', async () => {
    const prefix = `: ${'x'.repeat(100)};`
    violationsDuringWrap = (runIndex) => (runIndex === 0 ? [0] : [])
    const blocked = await run(`${prefix} exit "$COPSE_TEST_EXIT"`, 1)
    const other = await run(`${prefix} true; exit "$COPSE_TEST_EXIT"`, 1)

    assert.equal(blocked.sandboxViolationCount, 1)
    assert.equal(other.sandboxViolationCount, 0)
  })

  it('attributes a late log line to the run that caused it, not the run that is executing', async () => {
    const command = 'exit "$COPSE_TEST_EXIT"'
    // The first run's violation only reaches the store while the second runs.
    violationsDuringWrap = (runIndex) => (runIndex === 1 ? [0] : [])
    await run(command, 0)
    const second = await run(command, 1)

    assert.equal(second.sandboxViolationCount, 0)
  })

  it('still counts a violation the current run recorded', async () => {
    violationsDuringWrap = (runIndex) => [runIndex]
    const result = await run('exit "$COPSE_TEST_EXIT"', 1)

    assert.equal(result.sandboxViolationCount, 1)
    assert.equal(
      detectSandboxFailure({ exitCode: result.exitCode, violationCount: 1, spawnFailed: false })
        .likely,
      true,
    )
  })
})
