import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { listForegroundShellProcesses, runShellOnce } from './foreground-shell-process.ts'
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

  it('lists a running command under its thread until it exits or moves to the background', async () => {
    const finished = start(`echo ready $$; sleep 0.3`)
    const pid = Number(/ready (\d+)/.exec(await finished.ready)?.[1])
    assert.deepEqual(listForegroundShellProcesses(), [
      { pid, command: 'echo ready $$; sleep 0.3', ...OWNER },
    ])
    await finished.result
    assert.deepEqual(listForegroundShellProcesses(), [])

    const detached = start()
    await detached.ready
    assert.equal(listForegroundShellProcesses().length, 1)
    detached.controller.abort('send_now')
    assert.ok((await detached.result).backgroundId)
    assert.deepEqual(listForegroundShellProcesses(), [])
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

describe('foreground shell completion', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-foreground-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const run = (command: string, timeout: number): ReturnType<typeof runShellOnce> =>
    runShellOnce(command, root, timeout, new AbortController().signal, true, process.env)

  it('gives a command that reads stdin EOF instead of hanging until the timeout', async () => {
    const startedAt = Date.now()
    const result = await run('read x; echo got:$x', 5_000)
    assert.match(result.output, /got:/)
    assert.ok(Date.now() - startedAt < 4_000)
  })

  it('keeps the output captured before a timeout and points at run_background', async () => {
    await assert.rejects(run('echo started; sleep 5', 1_000), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /timed out after 1000ms/)
      assert.match(error.message, /started/)
      assert.match(error.message, /run_background with wake_on_completion/)
      return true
    })
  })

  it('reports a signal-killed command as a failure', async () => {
    const result = await run('kill -9 $$', 5_000)
    assert.equal(result.exitCode, 137)
  })
})
