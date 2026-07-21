import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
