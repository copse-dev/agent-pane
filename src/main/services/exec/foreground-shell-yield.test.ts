import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { runShellOnce } from './foreground-shell-process.ts'
import {
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  listBackgroundProcessPids,
  stopAllBackgroundProcesses,
} from './background-process.ts'
import {
  hasBackgroundCompletionWake,
  installBackgroundProcessSupervisor,
  stopSupervisedBackgroundProcess,
} from './supervised-background-process.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { TaskSupervisor } from '../supervisor/task-supervisor.ts'
import { FileSupervisedTaskStore } from '../supervisor/task-store.ts'
import { isPidAlive } from './subprocess-kill.ts'

const OWNER = { projectId: 'project-shell-yield', threadId: 'thread-shell-yield' }

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('The yielded command did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('explicit foreground shell yield', () => {
  let root: string
  let supervisor: TaskSupervisor
  let dispose: () => void

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-shell-yield-'))
    supervisor = new TaskSupervisor({
      store: new FileSupervisedTaskStore({ COPSE_WORKSPACE_DIR: root }),
    })
    dispose = installBackgroundProcessSupervisor(supervisor)
    await supervisor.start()
    writeFileSync(
      join(root, 'bounded.cjs'),
      [
        "const fs = require('node:fs')",
        "fs.appendFileSync('starts.txt', 'started once\\n')",
        "fs.writeFileSync('pid.txt', String(process.pid))",
        "console.log('checkpoint complete')",
        'const timer = setInterval(() => {',
        "  if (!fs.existsSync('release.txt')) return",
        '  clearInterval(timer)',
        "  fs.writeFileSync('finished.txt', 'done\\n')",
        "  console.log('bounded work finished')",
        '}, 20)',
      ].join('\n'),
    )
  })

  afterEach(async () => {
    stopAllBackgroundProcesses()
    await supervisor.shutdown()
    dispose()
    mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  })

  function run(
    command: string,
    timeoutMs: number,
    options: Parameters<typeof runShellOnce>[9],
    signal = new AbortController().signal,
  ): ReturnType<typeof runShellOnce> {
    return runWithThreadExecutionContext(
      { ...OWNER, projectRoot: root, root, checkoutMode: 'shared', branch: null },
      () =>
        runShellOnce(
          command,
          root,
          timeoutMs,
          signal,
          true,
          process.env,
          [],
          undefined,
          false,
          options,
        ),
    )
  }

  it('yields the same bounded process before its hard deadline and completes without replay', async () => {
    const result = await run('node bounded.cjs', 1_500, { yieldAfterMs: 100 })
    assert.ok(result.backgroundId, 'long work must return a tracked still-running handle')
    await waitUntil(() => existsSync(join(root, 'pid.txt')))
    const pid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'))
    assert.ok(pid > 0)
    process.kill(pid, 0)
    assert.equal(listBackgroundProcessPids().length, 1)
    assert.equal(listBackgroundProcesses(OWNER)[0]?.running, true)
    assert.deepEqual(listBackgroundProcesses({ ...OWNER, threadId: 'other' }), [])
    writeFileSync(join(root, 'release.txt'), 'finish')
    await waitUntil(() => listBackgroundProcesses(OWNER)[0]?.running === false)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'started once\n')
    assert.equal(readFileSync(join(root, 'finished.txt'), 'utf8'), 'done\n')
    assert.match(
      getBackgroundProcessLogs(result.backgroundId, OWNER) ?? '',
      /bounded work finished/,
    )
    assert.equal(listBackgroundProcesses(OWNER)[0]?.exitCode, 0)
  })

  it('keeps an early exit in the foreground and never creates a completion wake', async () => {
    let completions = 0
    const result = await run('echo finished', 1_500, {
      yieldAfterMs: 500,
      onCompletion: () => {
        completions++
      },
    })
    assert.equal(result.backgroundId, undefined)
    assert.equal(result.exitCode, 0)
    assert.match(result.output, /finished/)
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
    assert.equal(completions, 0)
  })

  it('retains the original deadline and reports its timeout exactly once', async () => {
    const completions: boolean[] = []
    const result = await run('node bounded.cjs', 400, {
      yieldAfterMs: 100,
      onCompletion: ({ info }) => {
        completions.push(info.timedOut)
      },
    })
    assert.ok(result.backgroundId)
    await waitUntil(() => completions.length > 0)
    assert.deepEqual(completions, [true])
    assert.equal(listBackgroundProcesses(OWNER)[0]?.timedOut, true)
    assert.equal(existsSync(join(root, 'finished.txt')), false)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'started once\n')
  })

  it('stops yielded work through its existing task handle without a completion wake', async () => {
    let completions = 0
    const result = await run('node bounded.cjs', 2_000, {
      yieldAfterMs: 100,
      onCompletion: () => {
        completions++
      },
    })
    assert.ok(result.backgroundId)
    assert.equal(hasBackgroundCompletionWake(OWNER), true)
    assert.equal(await stopSupervisedBackgroundProcess(result.backgroundId, OWNER), true)
    await waitUntil(() => listBackgroundProcessPids().length === 0)
    assert.equal(completions, 0)
    assert.equal(hasBackgroundCompletionWake(OWNER), false)
    assert.equal(existsSync(join(root, 'finished.txt')), false)
    assert.equal(supervisor.list(OWNER.projectId)[0]?.state, 'cancelled')
  })

  it('honors Stop during asynchronous adoption and never wakes the cancelled work', async () => {
    let releaseAdoption = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseAdoption = resolve
    })
    let announceAdoption = (): void => {}
    const entered = new Promise<void>((resolve) => {
      announceAdoption = resolve
    })
    const original = supervisor.adoptRunning.bind(supervisor)
    mock.method(supervisor, 'adoptRunning', async (...args: Parameters<typeof original>) => {
      announceAdoption()
      await gate
      return original(...args)
    })
    const controller = new AbortController()
    let completions = 0
    const pending = run(
      'node bounded.cjs',
      2_000,
      {
        yieldAfterMs: 100,
        onCompletion: () => {
          completions++
        },
      },
      controller.signal,
    )
    const cancelled = assert.rejects(pending, /cancelled while moving to the background/)
    await entered
    const pid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'))
    controller.abort()
    // The child can close while the supervisor's record write is still held.
    // Cancelling must win over the delayed completion, without a wake.
    await waitUntil(() => !isPidAlive(pid))
    releaseAdoption()
    await cancelled
    await waitUntil(() => !isPidAlive(pid))
    assert.equal(supervisor.list(OWNER.projectId)[0]?.state, 'cancelled')
    assert.equal(completions, 0)
    assert.equal(existsSync(join(root, 'finished.txt')), false)
  })

  it('preserves Send now during adoption instead of turning it into Stop', async () => {
    let releaseAdoption = (): void => {}
    const gate = new Promise<void>((resolve) => {
      releaseAdoption = resolve
    })
    let announceAdoption = (): void => {}
    const entered = new Promise<void>((resolve) => {
      announceAdoption = resolve
    })
    const original = supervisor.adoptRunning.bind(supervisor)
    mock.method(supervisor, 'adoptRunning', async (...args: Parameters<typeof original>) => {
      announceAdoption()
      await gate
      return original(...args)
    })
    const controller = new AbortController()
    const pending = run('node bounded.cjs', 2_000, { yieldAfterMs: 100 }, controller.signal)
    await entered
    controller.abort('send_now')
    releaseAdoption()
    const receipt = await pending
    assert.ok(receipt.backgroundId)
    assert.equal(listBackgroundProcesses(OWNER)[0]?.running, true)
    writeFileSync(join(root, 'release.txt'), 'finish')
    await waitUntil(() => listBackgroundProcesses(OWNER)[0]?.running === false)
    assert.equal(readFileSync(join(root, 'starts.txt'), 'utf8'), 'started once\n')
    assert.equal(readFileSync(join(root, 'finished.txt'), 'utf8'), 'done\n')
  })

  it('fails adoption by stopping the original command rather than losing it', async () => {
    dispose()
    await assert.rejects(
      run('node bounded.cjs', 1_500, { yieldAfterMs: 100 }),
      /supervisor is unavailable/,
    )
    const pid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'))
    await waitUntil(() => !isPidAlive(pid))
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
    assert.equal(existsSync(join(root, 'finished.txt')), false)
  })

  it('rejects an invalid wait or pre-aborted call before starting work', async () => {
    await assert.rejects(run('node bounded.cjs', 500, { yieldAfterMs: 500 }), /earlier than/)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(run('node bounded.cjs', 1_500, { yieldAfterMs: 100 }, controller.signal))
    assert.equal(existsSync(join(root, 'starts.txt')), false)
    assert.deepEqual(listBackgroundProcesses(OWNER), [])
  })
})
