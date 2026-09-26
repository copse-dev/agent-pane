import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settleAcpChildShutdowns, shutdownAcpChild } from './acp-client.ts'

/** Spawn a group-leading `node -e` agent stand-in and wait for it to say `ready`. */
async function spawnAgent(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  })
  await once(child.stdout, 'data')
  return child
}

function groupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A leader that exits on stdin EOF after starting a grandchild in its own
 * group. The grandchild records whether it finished on its own or was SIGTERMed.
 */
function leaderWithGrandchild(marker: string, grandchildLingerMs: number | null): string {
  const finish =
    grandchildLingerMs === null
      ? 'setInterval(() => {}, 1000)'
      : `setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'clean'); process.exit(0) }, ${String(grandchildLingerMs)})`
  const grandchild = [
    "const fs = require('node:fs')",
    `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'TERM'); process.exit(1) })`,
    finish,
    "process.stdout.write('ready')",
  ].join('; ')
  return [
    "const { spawn } = require('node:child_process')",
    `const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    "g.stdout.once('data', () => process.stdout.write('ready'))",
    'process.stdin.resume()',
    "process.stdin.on('end', () => process.exit(0))",
  ].join('; ')
}

describe('shutdownAcpChild', () => {
  it('lets an agent that honours stdin EOF exit without any signal', async () => {
    const child = await spawnAgent(
      [
        "process.on('SIGTERM', () => process.exit(3))",
        'process.stdin.resume()',
        "process.stdin.on('end', () => process.exit(0))",
        "process.stdout.write('ready')",
      ].join('; '),
    )
    const started = Date.now()
    await shutdownAcpChild(child, 5_000)

    assert.equal(child.exitCode, 0)
    assert.equal(child.signalCode, null)
    assert.ok(Date.now() - started < 5_000, 'resolved before the deadline')
  })

  it('SIGTERMs an agent that ignores stdin EOF once the grace period ends', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX signal semantics')
      return
    }
    const child = await spawnAgent(
      "process.stdin.resume(); setInterval(() => {}, 1000); process.stdout.write('ready')",
    )
    const exited = once(child, 'exit')
    await shutdownAcpChild(child, 200)
    const exit = await exited
    const code: unknown = exit[0]
    const signal: unknown = exit[1]

    assert.equal(code, null)
    assert.equal(signal, 'SIGTERM')
  })

  it('waits for the rest of the group to drain instead of signalling it', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX process groups')
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'acp-shutdown-'))
    t.after(() => {
      rmSync(dir, { recursive: true, force: true })
    })
    const marker = join(dir, 'grandchild')
    const child = await spawnAgent(leaderWithGrandchild(marker, 300))

    await shutdownAcpChild(child, 5_000)

    assert.equal(child.exitCode, 0)
    assert.equal(readFileSync(marker, 'utf8'), 'clean')
    assert.equal(groupAlive(child), false)
  })

  it('SIGTERMs a group member still alive at the deadline after the leader exited', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX process groups')
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'acp-shutdown-'))
    t.after(() => {
      rmSync(dir, { recursive: true, force: true })
    })
    const marker = join(dir, 'grandchild')
    const child = await spawnAgent(leaderWithGrandchild(marker, null))

    await shutdownAcpChild(child, 500)
    assert.equal(child.exitCode, 0, 'the leader exited on EOF')
    const deadline = Date.now() + 5_000
    while (groupAlive(child) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.equal(readFileSync(marker, 'utf8'), 'TERM')
    assert.equal(groupAlive(child), false)
  })

  it('returns one shutdown per child and settles it for quit', async () => {
    const child = await spawnAgent(
      "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('ready')",
    )
    const first = shutdownAcpChild(child, 5_000)

    assert.equal(shutdownAcpChild(child, 5_000), first)
    await settleAcpChildShutdowns()
    assert.equal(child.exitCode, 0)
  })
})
