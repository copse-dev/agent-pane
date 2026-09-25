import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { collectProcess } from './process-collect.ts'
import type { CellCommand } from './isolation.ts'

// A leader that starts a grandchild in its own session (outside the process
// group a timeout kills) which inherits, and so holds open, the output pipes.
function leaderWithEscapedGrandchild(leaderBody: string): string {
  return [
    "const { spawn } = require('node:child_process')",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: 'inherit' })",
    "console.log('grandchild ' + g.pid)",
    'g.unref()',
    leaderBody,
  ].join('\n')
}

function command(argv: readonly string[], timeoutMs: number): CellCommand {
  return {
    target: 'head',
    argv: [argv[0] ?? process.execPath, ...argv.slice(1)],
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  }
}

async function run(
  script: string,
  timeoutMs: number,
): Promise<{ result: Awaited<ReturnType<typeof collectProcess>>; elapsed: number }> {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const started = Date.now()
  const result = await collectProcess(child, command([process.execPath, '-e', script], timeoutMs))
  const elapsed = Date.now() - started
  const pid = /grandchild (\d+)/.exec(result.output)?.[1]
  if (pid !== undefined) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  return { result, elapsed }
}

describe('collectProcess', { skip: process.platform === 'win32' }, () => {
  it('returns when the leader exits even if an escaped grandchild holds the pipes', async () => {
    const { result, elapsed } = await run(
      leaderWithEscapedGrandchild("console.log('leader done')"),
      15_000,
    )
    assert.ok(elapsed < 5_000, `waited ${String(elapsed)}ms for the grandchild`)
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false, 'a clean exit is not a timeout')
    assert.match(result.output, /leader done/)
  })

  it('still ends a timed-out command whose grandchild escaped the group', async () => {
    const { result, elapsed } = await run(
      leaderWithEscapedGrandchild('setTimeout(() => {}, 20000)'),
      300,
    )
    assert.ok(elapsed < 5_000, `waited ${String(elapsed)}ms past the deadline`)
    assert.equal(result.timedOut, true)
  })
})
