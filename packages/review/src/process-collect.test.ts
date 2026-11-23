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

describe('collectProcess retained lines', () => {
  const prefix = 'COPSE_TEST_FAILURES_V1 '
  async function collect(script: string, maxOutputBytes: number): Promise<string> {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    const result = await collectProcess(child, {
      target: 'head',
      argv: [process.execPath, '-e', script],
      timeoutMs: 30_000,
      maxOutputBytes,
      retainLinePrefixes: [prefix],
    })
    return result.output
  }

  it('puts back a verdict line the tail cap dropped, once, ahead of the tail', async () => {
    const output = await collect(
      // The report, then far more failure detail than the cap keeps, split
      // across many writes so the report line reaches the collector in pieces.
      `process.stdout.write(${JSON.stringify(prefix)}); process.stdout.write('{"failed":2}\\n');` +
        "for (let i = 0; i < 2000; i++) process.stderr.write('detail line ' + i + '\\n')",
      4 * 1024,
    )
    const lines = output.split('\n')
    assert.equal(lines.filter((line) => line.startsWith(prefix)).length, 1)
    assert.equal(lines[0], `${prefix}{"failed":2}`)
    assert.match(output, /detail line 1999/)
    assert.doesNotMatch(output, /detail line 0\n/)
  })

  it('keeps a character whose bytes arrive in two chunks whole', async () => {
    // `é` is two bytes in UTF-8; the first write ends after its first byte.
    const output = await collect(
      `const b = Buffer.from(${JSON.stringify(`${prefix}{"name":"café ✓"}\n`)}, 'utf8');` +
        `const cut = b.indexOf(0xc3) + 1;` +
        'process.stdout.write(b.subarray(0, cut));' +
        'setTimeout(() => process.stdout.write(b.subarray(cut)), 50)',
      4 * 1024,
    )
    assert.equal(output, `${prefix}{"name":"café ✓"}\n`)
  })

  it('leaves the output alone when the line is still in the tail', async () => {
    const output = await collect(
      `console.log('before'); console.log(${JSON.stringify(prefix)} + '{"failed":0}'); console.log('after')`,
      4 * 1024,
    )
    assert.equal(output, `before\n${prefix}{"failed":0}\nafter\n`)
  })
})
