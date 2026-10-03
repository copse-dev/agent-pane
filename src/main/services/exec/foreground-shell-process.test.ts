import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
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

  it('rejects a pre-aborted call without starting a child', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runShellOnce('echo unexpected', root, 5_000, controller.signal, true, process.env),
    )
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
  })
})
