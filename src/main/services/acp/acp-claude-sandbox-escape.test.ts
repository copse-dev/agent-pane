import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  CLAUDE_SANDBOX_ESCAPE_PARAM,
  claudeSandboxEscapeHookCommand,
  claudeSandboxEscapeRefusal,
  claudeSandboxEscapeSessionMeta,
} from './acp-claude-sandbox-escape.ts'

/**
 * Run the hook the way Claude Code does: its command through `sh -c`, with the
 * `PreToolUse` input JSON on stdin.
 */
function runHook(
  toolInput: Record<string, unknown>,
  bridgeMounted = true,
): { status: number | null; stderr: string; stdout: string } {
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: toolInput,
  })
  const result = spawnSync('/bin/sh', ['-c', claudeSandboxEscapeHookCommand(bridgeMounted)], {
    input: stdin,
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

describe("Claude Code's sandbox escape inside Copse's sandbox (#4146)", () => {
  const posix = process.platform !== 'win32'

  it('refuses an escaped Bash call with an explanation the model reads', { skip: !posix }, () => {
    const run = runHook({ command: 'gh pr view 1', [CLAUDE_SANDBOX_ESCAPE_PARAM]: true })
    // Exit 2 is Claude Code's "block the call and show stderr to the model".
    assert.equal(run.status, 2)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, `${claudeSandboxEscapeRefusal(true)}\n`)
    assert.match(run.stderr, /Copse's sandbox/)
    assert.match(run.stderr, /mcp__copse__run_shell/)
    assert.match(run.stderr, /expects_sandbox_block: true/)
  })

  it('leaves every other Bash call alone', { skip: !posix }, () => {
    for (const input of [
      { command: 'ls' },
      { command: 'ls', [CLAUDE_SANDBOX_ESCAPE_PARAM]: false },
      // A command line that only mentions the parameter is JSON-escaped inside
      // its string, so it is not the parameter itself.
      { command: `echo '{"${CLAUDE_SANDBOX_ESCAPE_PARAM}": true}'` },
    ]) {
      const run = runHook(input)
      assert.equal(run.status, 0, JSON.stringify(input))
      assert.equal(run.stderr, '')
    }
  })

  it('matches whitespace around the colon', { skip: !posix }, () => {
    const stdin = `{"tool_input": {"command": "ls", "${CLAUDE_SANDBOX_ESCAPE_PARAM}" :  true}}`
    const result = spawnSync('/bin/sh', ['-c', claudeSandboxEscapeHookCommand(true)], {
      input: stdin,
      encoding: 'utf8',
    })
    assert.equal(result.status, 2)
  })

  it('says so when the session has no Copse bridge to point at', { skip: !posix }, () => {
    const run = runHook({ command: 'gh auth status', [CLAUDE_SANDBOX_ESCAPE_PARAM]: true }, false)
    assert.equal(run.status, 2)
    assert.match(run.stderr, /tool bridge .* is not available in this session/)
    assert.match(run.stderr, /Tell the user/)
    assert.doesNotMatch(run.stderr, /mcp__copse__run_shell\)/)
  })

  it('hands Claude Code the hook as a Bash PreToolUse flag setting', () => {
    const meta = claudeSandboxEscapeSessionMeta(true)
    assert.deepEqual(meta, {
      claudeCode: {
        options: {
          settings: {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [
                    { type: 'command', command: claudeSandboxEscapeHookCommand(true), timeout: 10 },
                  ],
                },
              ],
            },
          },
        },
      },
    })
  })
})
