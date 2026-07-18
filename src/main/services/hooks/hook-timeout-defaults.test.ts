// Contract tests for per-hook timeout defaults (H4, decision 13).
//
// Pins the two acceptance points of "vendor timeout defaults per dialect + a
// per-hook override honoured":
//   - A hook config that omits `timeout` picks up its **dialect default** —
//     Cursor 30s, Claude 600s — not Copse's historical fixed 5s.
//   - A per-hook `timeout` (seconds on the wire) wins, converted to ms.
// Discovery is where the default is applied (`CommandHook.timeoutMs`), so the
// tests assert on the `CommandHook`s the adapters hand the registry.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cursorToolGateHooks,
  userHooksConfigPath,
  CURSOR_DEFAULT_HOOK_TIMEOUT_MS,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import {
  claudeToolGateHooks,
  userClaudeSettingsPath,
  CLAUDE_DEFAULT_HOOK_TIMEOUT_MS,
} from './claude-adapter.ts'

const SHELL_GATE = { toolName: 'run_shell', input: { command: 'ls' } }
const OPTS = { workspaceRoot: null, projectTrusted: false }

describe('per-hook timeout defaults (H4, decision 13)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-hook-timeout-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    // Ensure the Cursor module-level timeout sits at its vendor default (some
    // other spec may have shortened it); H4 tests the *default* is applied.
    setCursorHookTimeoutForTest()
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCursorHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeCursorHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  async function writeClaudeSettings(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.claude'), { recursive: true })
    await writeFile(userClaudeSettingsPath(), JSON.stringify(config), 'utf-8')
  }

  it('Cursor: a hook with no timeout uses the 30s vendor default', async () => {
    await writeCursorHooks({ hooks: { beforeShellExecution: [{ command: './gate.sh' }] } })
    const [hook] = await cursorToolGateHooks(SHELL_GATE, OPTS)
    assert.ok(hook)
    assert.equal(hook.timeoutMs, CURSOR_DEFAULT_HOOK_TIMEOUT_MS)
    assert.equal(hook.timeoutMs, 30_000)
  })

  it('Cursor: a per-hook `timeout` (seconds) overrides the default', async () => {
    await writeCursorHooks({
      hooks: { beforeShellExecution: [{ command: './gate.sh', timeout: 5 }] },
    })
    const [hook] = await cursorToolGateHooks(SHELL_GATE, OPTS)
    assert.ok(hook)
    assert.equal(hook.timeoutMs, 5_000)
  })

  it('Claude: a hook with no timeout uses the 600s vendor default', async () => {
    await writeClaudeSettings({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './g.sh' }] }] },
    })
    const [hook] = await claudeToolGateHooks(SHELL_GATE, OPTS)
    assert.ok(hook)
    assert.equal(hook.timeoutMs, CLAUDE_DEFAULT_HOOK_TIMEOUT_MS)
    assert.equal(hook.timeoutMs, 600_000)
  })

  it('Claude: a per-hook `timeout` (seconds) overrides the default', async () => {
    await writeClaudeSettings({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: './g.sh', timeout: 12 }] },
        ],
      },
    })
    const [hook] = await claudeToolGateHooks(SHELL_GATE, OPTS)
    assert.ok(hook)
    assert.equal(hook.timeoutMs, 12_000)
  })

  it('ignores a non-positive / non-numeric timeout and falls back to the default', async () => {
    await writeCursorHooks({
      hooks: {
        beforeShellExecution: [
          { command: './a.sh', timeout: 0 },
          { command: './b.sh', timeout: 'x' },
        ],
      },
    })
    const hooks = await cursorToolGateHooks(SHELL_GATE, OPTS)
    assert.equal(hooks.length, 2)
    for (const h of hooks) assert.equal(h.timeoutMs, CURSOR_DEFAULT_HOOK_TIMEOUT_MS)
  })
})
