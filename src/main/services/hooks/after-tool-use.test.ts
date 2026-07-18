// Contract tests for the `afterToolUse` fire site (D2).
//
// Pins the D2 acceptance surface:
//   - fires after a shell tool result → the Cursor `afterShellExecution` flavor
//     with `command` / `output` / `duration` on stdin;
//   - fires after an MCP tool result → the `afterMCPExecution` flavor with
//     `tool_name` / `tool_input` (JSON string) / `result_json` on stdin;
//   - the output snapshot is **capped** before it reaches a hook's stdin;
//   - it is dispatched **detached** — a slow observation hook never blocks the
//     caller (decision 3, no drain barrier);
//   - discovery maps the vendor event names to the canonical `afterToolUse`
//     (a shell hook never fires for a non-shell tool, and vice versa).
//
// Same house style as `stop.test.ts` — a real spawned script driven through the
// canonical `afterToolUse` registry → runner → adapter seam.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  userHooksConfigPath,
  resetCursorHookSessionErrorsForTest,
  setCursorHookTimeoutForTest,
} from './cursor-adapter.ts'
import { runAfterToolUseHooks, capToolOutput, AFTER_TOOL_USE_OUTPUT_CAP } from './after-tool-use.ts'
import type { HookEventPayloads } from '@copse/agent/hooks/canonical-events.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'

let threadCounter = 0

/** Fire the canonical afterToolUse event (the production tool-result path). */
function fireAfterToolUse(
  payload: HookEventPayloads['afterToolUse'],
  opts: { workspaceRoot?: string | null; projectTrusted?: boolean } = {},
): ReturnType<typeof runAfterToolUseHooks> {
  const threadId = `after-tool-test-thread-${String(threadCounter++)}`
  return runAfterToolUseHooks(payload, {
    threadId,
    turnTreeId: asTurnTreeId(`${threadId}:turn`),
    workspaceRoot: opts.workspaceRoot ?? null,
    projectTrusted: opts.projectTrusted ?? false,
  })
}

describe('afterToolUse (tool-result fire site — D2)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-after-tool-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCursorHookSessionErrorsForTest()
    setCursorHookTimeoutForTest(2_000)
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setCursorHookTimeoutForTest()
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  /** Write an executable shell script that copies its stdin to `stdinFile`. */
  async function writeCaptureHook(name: string, stdinFile: string): Promise<string> {
    const path = join(tempHome, name)
    await writeFile(path, `#!/bin/sh\ncat > '${stdinFile}'\n`, 'utf-8')
    await chmod(path, 0o755)
    return path
  }

  it('does nothing when no afterToolUse hooks are registered', async () => {
    const result = await fireAfterToolUse({
      toolName: 'run_shell',
      toolCallId: 'tc-1',
      isError: false,
      input: { command: 'ls' },
      output: 'a\nb\n',
    })
    assert.equal(result.ran, 0)
    await result.settled
  })

  it('fires after a shell tool — afterShellExecution flavor with command/output/duration', async () => {
    const stdinFile = join(tempHome, 'shell.json')
    const script = await writeCaptureHook('after-shell.sh', stdinFile)
    await writeUserHooks({ hooks: { afterShellExecution: [{ command: script }] } })

    const result = await fireAfterToolUse({
      toolName: 'run_shell',
      toolCallId: 'tc-shell',
      isError: false,
      input: { command: 'echo hi' },
      output: 'hi\n',
      durationMs: 42,
    })
    assert.equal(result.ran, 1)
    await result.settled

    assert.equal(existsSync(stdinFile), true)
    const stdin = JSON.parse(readFileSync(stdinFile, 'utf-8')) as {
      command?: string
      output?: string
      duration?: number
      hook_event_name?: string
    }
    assert.equal(stdin.command, 'echo hi')
    assert.equal(stdin.output, 'hi\n')
    assert.equal(stdin.duration, 42)
    assert.equal(stdin.hook_event_name, 'afterShellExecution')
  })

  it('fires after an MCP tool — afterMCPExecution flavor with tool_name/tool_input/result_json', async () => {
    const stdinFile = join(tempHome, 'mcp.json')
    const script = await writeCaptureHook('after-mcp.sh', stdinFile)
    await writeUserHooks({ hooks: { afterMCPExecution: [{ command: script }] } })

    const result = await fireAfterToolUse({
      toolName: 'mcp__db__query',
      toolCallId: 'tc-mcp',
      isError: false,
      input: { sql: 'SELECT 1' },
      output: '{"rows":[1]}',
      durationMs: 7,
    })
    assert.equal(result.ran, 1)
    await result.settled

    const stdin = JSON.parse(readFileSync(stdinFile, 'utf-8')) as {
      tool_name?: string
      tool_input?: string
      result_json?: string
      duration?: number
      hook_event_name?: string
    }
    assert.equal(stdin.tool_name, 'mcp__db__query')
    // tool_input is a JSON *string* of the params (vendor contract).
    assert.equal(stdin.tool_input, JSON.stringify({ sql: 'SELECT 1' }))
    assert.equal(stdin.result_json, '{"rows":[1]}')
    assert.equal(stdin.duration, 7)
    assert.equal(stdin.hook_event_name, 'afterMCPExecution')
  })

  it('caps the output snapshot before it reaches the hook stdin', async () => {
    const stdinFile = join(tempHome, 'capped.json')
    const script = await writeCaptureHook('after-cap.sh', stdinFile)
    await writeUserHooks({ hooks: { afterShellExecution: [{ command: script }] } })

    const huge = 'x'.repeat(AFTER_TOOL_USE_OUTPUT_CAP + 5_000)
    const result = await fireAfterToolUse({
      toolName: 'run_shell',
      toolCallId: 'tc-cap',
      isError: false,
      input: { command: 'cat big' },
      output: huge,
    })
    assert.equal(result.ran, 1)
    await result.settled

    const stdin = JSON.parse(readFileSync(stdinFile, 'utf-8')) as { output?: string }
    assert.ok(stdin.output !== undefined)
    // Capped to the slice plus a short truncation marker — never the full output.
    assert.ok(stdin.output.length < huge.length, 'output must be truncated below the raw length')
    assert.ok(
      stdin.output.startsWith('x'.repeat(AFTER_TOOL_USE_OUTPUT_CAP)),
      'the capped output keeps the leading slice',
    )
    assert.match(stdin.output, /output truncated/)
  })

  it('is detached — a slow afterToolUse hook does not block the caller (decision 3)', async () => {
    const marker = join(tempHome, 'slow.marker')
    const script = join(tempHome, 'slow-after.sh')
    await writeFile(script, `#!/bin/sh\ncat > /dev/null\nsleep 0.6\n: > '${marker}'\n`, 'utf-8')
    await chmod(script, 0o755)
    await writeUserHooks({ hooks: { afterShellExecution: [{ command: script }] } })

    const t0 = Date.now()
    const result = await fireAfterToolUse({
      toolName: 'run_shell',
      toolCallId: 'tc-slow',
      isError: false,
      input: { command: 'sleep' },
      output: 'done',
    })
    const elapsedAfterDispatch = Date.now() - t0

    assert.equal(result.ran, 1)
    assert.ok(
      elapsedAfterDispatch < 300,
      `dispatch must not block on the hook; it took ${String(elapsedAfterDispatch)}ms`,
    )
    assert.equal(existsSync(marker), false)

    await result.settled
    assert.equal(existsSync(marker), true)
  })

  it('discovery maps vendor event names — a shell hook never fires for a non-shell / MCP tool', async () => {
    await writeUserHooks({ hooks: { afterShellExecution: [{ command: './after.sh' }] } })

    // A read_file result has no Cursor after-event, so nothing fires…
    const readResult = await fireAfterToolUse({
      toolName: 'read_file',
      toolCallId: 'tc-read',
      isError: false,
      input: { path: 'a.ts' },
      output: 'contents',
    })
    assert.equal(readResult.ran, 0)
    await readResult.settled

    // …and an MCP result does not match the afterShellExecution hook either.
    const mcpResult = await fireAfterToolUse({
      toolName: 'mcp__db__query',
      toolCallId: 'tc-mcp2',
      isError: false,
      input: {},
      output: '{}',
    })
    assert.equal(mcpResult.ran, 0)
    await mcpResult.settled
  })

  it('is notification-only — a crashing / failClosed hook never throws or blocks', async () => {
    const path = join(tempHome, 'crash.sh')
    await writeFile(path, '#!/bin/sh\ncat > /dev/null\nexit 2\n', 'utf-8')
    await chmod(path, 0o755)
    await writeUserHooks({ hooks: { afterShellExecution: [{ command: path, failClosed: true }] } })

    const result = await fireAfterToolUse({
      toolName: 'run_shell',
      toolCallId: 'tc-crash',
      isError: false,
      input: { command: 'boom' },
      output: '',
    })
    assert.equal(result.ran, 1)
    await result.settled
  })

  it('a project afterToolUse hook is ignored unless the workspace is trusted', async () => {
    const stdinFile = join(tempHome, 'proj.json')
    const script = await writeCaptureHook('proj-after.sh', stdinFile)
    const projectRoot = await mkdtemp(join(tmpdir(), 'copse-after-proj-'))
    try {
      await mkdir(join(projectRoot, '.cursor'), { recursive: true })
      await writeFile(
        join(projectRoot, '.cursor', 'hooks.json'),
        JSON.stringify({ hooks: { afterShellExecution: [{ command: script }] } }),
        'utf-8',
      )

      const payload: HookEventPayloads['afterToolUse'] = {
        toolName: 'run_shell',
        toolCallId: 'tc-proj',
        isError: false,
        input: { command: 'ls' },
        output: 'x',
      }

      const untrusted = await fireAfterToolUse(payload, {
        workspaceRoot: projectRoot,
        projectTrusted: false,
      })
      assert.equal(untrusted.ran, 0)
      await untrusted.settled

      const trusted = await fireAfterToolUse(payload, {
        workspaceRoot: projectRoot,
        projectTrusted: true,
      })
      assert.equal(trusted.ran, 1)
      await trusted.settled
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  describe('capToolOutput', () => {
    it('returns undefined for undefined output (no snapshot)', () => {
      assert.equal(capToolOutput(undefined), undefined)
    })

    it('passes through output at or under the cap unchanged', () => {
      const small = 'a'.repeat(AFTER_TOOL_USE_OUTPUT_CAP)
      assert.equal(capToolOutput(small), small)
    })

    it('truncates and marks output over the cap', () => {
      const big = 'b'.repeat(AFTER_TOOL_USE_OUTPUT_CAP + 1)
      const capped = capToolOutput(big)
      assert.ok(capped !== undefined)
      assert.ok(capped.startsWith('b'.repeat(AFTER_TOOL_USE_OUTPUT_CAP)))
      assert.match(capped, /output truncated/)
      assert.ok(capped.length < big.length + 100)
    })
  })
})
