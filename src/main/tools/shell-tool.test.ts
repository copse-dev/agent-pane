import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_OUTPUT_TRUNCATED_MARKER,
} from '../services/exec/subprocess-output-cap.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import {
  RUN_SHELL_DEFAULT_TIMEOUT_MS,
  RUN_SHELL_MAX_TIMEOUT_MS,
  RUN_SHELL_MIN_TIMEOUT_MS,
  runShellTool,
} from './shell-tool.ts'

/** Parse just the `timeout_ms` field through the tool's real schema. */
function parseTimeout(timeout_ms: unknown): ReturnType<typeof runShellTool.parameters.safeParse> {
  return runShellTool.parameters.safeParse({ command: 'true', timeout_ms })
}

describe('run_shell timeout_ms schema (issue #785)', () => {
  it('defaults to the short foreground timeout when omitted', () => {
    const parsed = runShellTool.parameters.safeParse({ command: 'true' })
    assert.ok(parsed.success)
    assert.equal(parsed.data.timeout_ms, RUN_SHELL_DEFAULT_TIMEOUT_MS)
  })

  it('accepts the minimum timeout and rejects one millisecond below it', () => {
    assert.ok(parseTimeout(RUN_SHELL_MIN_TIMEOUT_MS).success)
    const tooSmall = parseTimeout(RUN_SHELL_MIN_TIMEOUT_MS - 1)
    assert.equal(tooSmall.success, false)
  })

  it('accepts the previous 5-minute cap and durations just beyond it', () => {
    // The old hard cap was 300_000ms; 300_001 used to fail. It must now pass so a
    // build that needs more than five minutes no longer burns turns (issue #785).
    assert.ok(parseTimeout(300_000).success)
    assert.ok(parseTimeout(300_001).success)
    assert.ok(parseTimeout(10 * 60 * 1000).success)
  })

  it('accepts exactly the new maximum', () => {
    assert.equal(RUN_SHELL_MAX_TIMEOUT_MS, 30 * 60 * 1000)
    assert.ok(parseTimeout(RUN_SHELL_MAX_TIMEOUT_MS).success)
  })

  it('rejects one millisecond over the maximum with an actionable message', () => {
    const overCap = parseTimeout(RUN_SHELL_MAX_TIMEOUT_MS + 1)
    assert.ok(!overCap.success)
    const message = overCap.error.issues.map((i) => i.message).join(' ')
    assert.match(message, new RegExp(String(RUN_SHELL_MAX_TIMEOUT_MS)))
    // Steers the caller to the background path instead of a longer foreground timeout.
    assert.match(message, /run_background/)
  })

  it('rejects a non-integer timeout', () => {
    assert.equal(parseTimeout(1500.5).success, false)
  })
})

describe('run_shell tool description (issue #785)', () => {
  it('advertises the background path for unbounded work', () => {
    assert.match(runShellTool.description, /run_background/)
  })
})

describe('run_shell tool description (issue #1714)', () => {
  it('says where commands run and steers away from an inferred absolute cd', () => {
    // Thread a47f13b5 lost several turns because nothing told the model that the
    // shell's cwd was the worktree, not the checkout it had inferred: it `cd`d
    // out of the sandbox, and every command after the `cd` failed with EPERM.
    assert.match(runShellTool.description, /working directory named in your system prompt/)
    assert.match(runShellTool.description, /do not `cd` to an absolute path you inferred/)
  })

  it('explains that worktree mode reaches the same files by another path', () => {
    // The model's own reasoning in that thread was "these may be different
    // checkouts". They were not.
    assert.match(runShellTool.description, /same files by a different path/)
  })
})

describe('run_shell tool description (issue #1436)', () => {
  it('limits reactive elevation to a sandbox-contained failure', () => {
    assert.match(runShellTool.description, /A sandbox-contained failure.*may be retried once/)
  })
})

describe('run_shell over-cap output', () => {
  const cleanups: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it('keeps the exit code, a mid-stream failure, and a dropped-bytes summary', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'copse-shell-cap-')))
    cleanups.push(async () => rm(root, { recursive: true, force: true }))
    cleanups.push(setWorkspaceRootForTest(root))
    await writeFile(
      join(root, 'noisy.mjs'),
      [
        'const line = (i) => `building target ${i} of the workspace, nothing to report\\n`',
        'for (let i = 0; i < 3000; i++) process.stdout.write(line(i))',
        "process.stdout.write('src/core/parse.ts:88:13 - error TS2345: bad argument\\n')",
        'for (let i = 3000; i < 6000; i++) process.stdout.write(line(i))',
        'process.exitCode = 3',
      ].join('\n'),
    )

    const command = `${JSON.stringify(process.execPath)} noisy.mjs`
    const signal = new AbortController().signal
    const context: ThreadExecutionContext = {
      projectId: 'shell-cap',
      threadId: 'shell-cap',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: null,
    }
    const run = runWithThreadExecutionContext(context, async () =>
      runShellTool.execute({ command, timeout_ms: 30_000 }, signal),
    )
    await assert.rejects(run, (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.ok(err.message.startsWith('Exited with code 3:\n'), 'exit code heads the result')
      assert.ok(err.message.includes(COMMAND_OUTPUT_TRUNCATED_MARKER.trim()))
      assert.ok(err.message.includes('\nsrc/core/parse.ts:88:13 - error TS2345: bad argument\n'))
      assert.match(
        err.message,
        /\[dropped \d+ bytes \(~\d+ lines\) from the middle; 1 error\/warning\/location line from that span kept below\. Re-run with a narrower command/,
      )
      assert.ok(err.message.includes('building target 5999 of the workspace'))
      assert.ok(Buffer.byteLength(err.message, 'utf8') <= COMMAND_OUTPUT_MAX_BYTES + 64)
      return true
    })
  })
})
