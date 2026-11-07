import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { formatArgvForShell, setProjectSandboxEnabled, spawnBackgroundProcess } from './spawn.ts'

const heldScript =
  "process.stdin.once('data', () => process.exit(0)); process.stdout.write('ready')"

describe('background process sandbox lease', () => {
  let cwd: string
  let wrappedArgv: string[]
  let wrapFailure: Error | undefined
  let wrapped: number
  let released: number
  const children = new Set<ChildProcess>()

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'copse-background-lease-'))
    wrappedArgv = [process.execPath, '-e', 'process.exit(0)']
    wrapFailure = undefined
    wrapped = 0
    released = 0
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'wrapWithSandboxArgv', async () => {
      if (wrapFailure) throw wrapFailure
      wrapped += 1
      return { argv: wrappedArgv, env: { ...process.env } }
    })
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {
      released += 1
      assert.ok(released <= wrapped, 'must not release an unrelated sandbox lease')
    })
    setProjectSandboxEnabled(true)
  })

  afterEach(async () => {
    for (const child of children) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) =>
          child.once('close', () => {
            resolve()
          }),
        )
        child.kill()
        await closed
      }
    }
    children.clear()
    setProjectSandboxEnabled(false)
    mock.restoreAll()
    await rm(cwd, { recursive: true, force: true })
  })

  async function start(
    command = 'node controlled.cjs',
    unsandboxed = false,
  ): Promise<{
    child: ChildProcess
    closed: Promise<number | null>
    errors: Error[]
  }> {
    const child = await spawnBackgroundProcess(command, { cwd, unsandboxed })
    children.add(child)
    const errors: Error[] = []
    child.on('error', (error) => errors.push(error))
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve))
    return { child, closed, errors }
  }

  async function startHeld(): Promise<Awaited<ReturnType<typeof start>>> {
    wrappedArgv = [process.execPath, '-e', heldScript]
    const watched = await start()
    assert.ok(watched.child.stdout)
    await new Promise<void>((resolve, reject) => {
      watched.child.stdout?.once('data', () => {
        resolve()
      })
      watched.child.once('error', reject)
    })
    return watched
  }

  async function finishHeld(watched: Awaited<ReturnType<typeof start>>): Promise<void> {
    assert.ok(watched.child.stdin)
    watched.child.stdin.end('finish')
    assert.equal(await watched.closed, 0)
  }

  it('releases a successful local wrapped child exactly once', async () => {
    const watched = await start()
    assert.equal(await watched.closed, 0)
    assert.equal(wrapped, 1)
    assert.equal(released, 1)
    assert.deepEqual(watched.errors, [])
  })

  it('releases once when the wrapped executable cannot spawn', async () => {
    wrappedArgv = [join(cwd, 'missing-executable')]
    const watched = await start()
    await watched.closed
    assert.equal(watched.child.pid, undefined)
    assert.equal(watched.errors.length, 1)
    assert.equal(wrapped, 1)
    assert.equal(released, 1)
  })

  it('releases a successful wrap rejected before spawn by empty argv', async () => {
    wrappedArgv = []
    await assert.rejects(start(), /sandbox wrap produced empty argv/)
    assert.equal(wrapped, 1)
    assert.equal(released, 1)
  })

  it('does not consume a lease when wrapping rejects', async () => {
    wrapFailure = new Error('controlled wrapper rejection')
    await assert.rejects(start(), /controlled wrapper rejection/)
    assert.equal(wrapped, 0)
    assert.equal(released, 0)
  })

  it('does not consume a lease for explicitly unsandboxed commands', async () => {
    const watched = await start(
      formatArgvForShell(process.execPath, ['-e', 'process.exit(0)']),
      true,
    )
    assert.equal(await watched.closed, 0)
    assert.equal(wrapped, 0)
    assert.equal(released, 0)
  })

  it('does not consume a lease when the sandbox is inactive', async () => {
    setProjectSandboxEnabled(false)
    const watched = await start(formatArgvForShell(process.execPath, ['-e', 'process.exit(0)']))
    assert.equal(await watched.closed, 0)
    assert.equal(wrapped, 0)
    assert.equal(released, 0)
  })

  it('keeps a live child protected after an error until its real close', async () => {
    const watched = await startHeld()
    const pid = watched.child.pid
    assert.ok(pid)
    watched.child.emit('error', new Error('controlled kill failure while still alive'))
    assert.equal(released, 0)
    assert.doesNotThrow(() => process.kill(pid, 0))
    await finishHeld(watched)
    assert.equal(released, 1)
    assert.equal(watched.errors.length, 1)
  })

  it('releases only the closed owner while another wrapped child stays live', async () => {
    const first = await startHeld()
    const second = await startHeld()
    assert.equal(wrapped, 2)
    assert.equal(released, 0)
    await finishHeld(first)
    assert.equal(released, 1)
    const pid = second.child.pid
    assert.ok(pid)
    assert.doesNotThrow(() => process.kill(pid, 0))
    await finishHeld(second)
    assert.equal(released, 2)
  })

  it('keeps an older live lease when a later wrapper rejects', async () => {
    const first = await startHeld()
    wrapFailure = new Error('controlled later wrapper rejection')
    await assert.rejects(start(), /controlled later wrapper rejection/)
    assert.equal(wrapped, 1)
    assert.equal(released, 0)
    const pid = first.child.pid
    assert.ok(pid)
    assert.doesNotThrow(() => process.kill(pid, 0))
    await finishHeld(first)
    assert.equal(released, 1)
  })
})
