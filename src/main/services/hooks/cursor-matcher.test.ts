// Contract tests for Cursor per-event `matcher` semantics (D3).
//
// D3 wires Cursor's native per-hook `matcher` (a regex string) into the Cursor
// adapter's dispatch-side discovery, honouring the vendor's per-event field
// selection ("which field the matcher applies to depends on the hook"):
//
//   - beforeShellExecution / afterShellExecution → the shell command text
//   - beforeMCPExecution / afterMCPExecution      → the (MCP) tool name
//   - beforeReadFile                              → the tool type (`Read`)
//   - afterFileEdit                               → the tool type (`Write`)
//   - beforeSubmitPrompt                          → the value `UserPromptSubmit`
//   - stop                                        → the value `Stop`
//   - subagentStart / subagentStop                → the subagent type (D1)
//
// These pin the matcher matrix at the discovery seam — the number of hooks a
// discovery function returns is exactly whether the matcher matched (1) or
// filtered the hook out (0). Behavior is fail-open for a missing matcher (fires
// for all) and skip-and-warn for an invalid regex (fires for nothing).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  userHooksConfigPath,
  cursorToolGateHooks,
  cursorAfterToolUseHooks,
  cursorBeforeSubmitPromptHooks,
  cursorStopHooks,
  cursorAfterFileEditHooks,
  cursorSubagentStartHooks,
  cursorSubagentStopHooks,
} from './cursor-adapter.ts'

const discover = { workspaceRoot: null, projectTrusted: false }

describe('Cursor per-event matcher semantics (D3)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-matcher-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
  })

  async function writeUserHooks(config: unknown): Promise<void> {
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(userHooksConfigPath(), JSON.stringify(config), 'utf-8')
  }

  // --- command-text matcher: beforeShellExecution (toolGate flavor) ---

  it('command-text matcher on beforeShell — fires only for a matching command', async () => {
    await writeUserHooks({
      hooks: { beforeShellExecution: [{ command: './net.sh', matcher: 'curl|wget|nc ' }] },
    })

    const matched = await cursorToolGateHooks(
      { toolName: 'run_shell', input: { command: 'curl https://example.com' } },
      discover,
    )
    assert.equal(matched.length, 1)

    const skipped = await cursorToolGateHooks(
      { toolName: 'run_shell', input: { command: 'ls -la' } },
      discover,
    )
    assert.equal(skipped.length, 0)
  })

  it('command-text matcher on afterShell — fires only for a matching command', async () => {
    await writeUserHooks({
      hooks: { afterShellExecution: [{ command: './audit.sh', matcher: 'rm -rf' }] },
    })

    const matched = await cursorAfterToolUseHooks(
      {
        toolName: 'run_shell',
        toolCallId: 'tc-1',
        isError: false,
        input: { command: 'rm -rf build' },
        output: '',
      },
      discover,
    )
    assert.equal(matched.length, 1)

    const skipped = await cursorAfterToolUseHooks(
      {
        toolName: 'run_shell',
        toolCallId: 'tc-2',
        isError: false,
        input: { command: 'echo safe' },
        output: '',
      },
      discover,
    )
    assert.equal(skipped.length, 0)
  })

  // --- tool-name matcher: MCP events ---

  it('tool-name matcher on beforeMCP — fires only for a matching MCP tool', async () => {
    await writeUserHooks({
      hooks: { beforeMCPExecution: [{ command: './mcp-guard.sh', matcher: 'db__query' }] },
    })

    const matched = await cursorToolGateHooks(
      { toolName: 'mcp__db__query', input: { sql: 'SELECT 1' } },
      discover,
    )
    assert.equal(matched.length, 1)

    const skipped = await cursorToolGateHooks({ toolName: 'mcp__fs__write', input: {} }, discover)
    assert.equal(skipped.length, 0)
  })

  it('tool-name matcher on afterMCP — fires only for a matching MCP tool', async () => {
    await writeUserHooks({
      hooks: { afterMCPExecution: [{ command: './mcp-audit.sh', matcher: 'db__' }] },
    })

    const matched = await cursorAfterToolUseHooks(
      { toolName: 'mcp__db__query', toolCallId: 'tc', isError: false, input: {}, output: '{}' },
      discover,
    )
    assert.equal(matched.length, 1)

    const skipped = await cursorAfterToolUseHooks(
      { toolName: 'mcp__http__get', toolCallId: 'tc', isError: false, input: {}, output: '{}' },
      discover,
    )
    assert.equal(skipped.length, 0)
  })

  it('tool-type matcher on generic postToolUse matches Cursor tool tokens', async () => {
    await writeUserHooks({
      hooks: { postToolUse: [{ command: './read-audit.sh', matcher: '^Read$' }] },
    })

    const read = await cursorAfterToolUseHooks(
      { toolName: 'read_file', toolCallId: 'tc-read', isError: false, input: {}, output: '' },
      discover,
    )
    assert.equal(read.length, 1)

    const shell = await cursorAfterToolUseHooks(
      { toolName: 'run_shell', toolCallId: 'tc-shell', isError: false, input: {}, output: '' },
      discover,
    )
    assert.equal(shell.length, 0)
  })

  // --- tool-type matcher: beforeReadFile (`Read`) ---

  it('tool-type matcher on beforeReadFile — matches `Read`, not `TabRead`', async () => {
    await writeUserHooks({
      hooks: { beforeReadFile: [{ command: './redact.sh', matcher: 'Read' }] },
    })
    const matched = await cursorToolGateHooks(
      { toolName: 'read_file', input: { path: 'a.ts' } },
      discover,
    )
    assert.equal(matched.length, 1)

    // Copse's read gate is the non-tab `Read` tool, so a Tab-only matcher never matches.
    await writeUserHooks({
      hooks: { beforeReadFile: [{ command: './redact.sh', matcher: '^TabRead$' }] },
    })
    const skipped = await cursorToolGateHooks(
      { toolName: 'read_file', input: { path: 'a.ts' } },
      discover,
    )
    assert.equal(skipped.length, 0)
  })

  // --- fixed-token matcher: beforeSubmitPrompt (`UserPromptSubmit`) ---

  it('matcher on beforeSubmitPrompt — matches the fixed `UserPromptSubmit` token', async () => {
    await writeUserHooks({
      hooks: { beforeSubmitPrompt: [{ command: './guard.sh', matcher: 'UserPromptSubmit' }] },
    })
    const matched = await cursorBeforeSubmitPromptHooks({ prompt: 'hi' }, discover)
    assert.equal(matched.length, 1)

    await writeUserHooks({
      hooks: { beforeSubmitPrompt: [{ command: './guard.sh', matcher: 'Nope' }] },
    })
    const skipped = await cursorBeforeSubmitPromptHooks({ prompt: 'hi' }, discover)
    assert.equal(skipped.length, 0)
  })

  // --- fixed-token matcher: stop (`Stop`) ---

  it('matcher on stop — matches the fixed `Stop` token', async () => {
    await writeUserHooks({ hooks: { stop: [{ command: './s.sh', matcher: 'Stop' }] } })
    const matched = await cursorStopHooks({ status: 'completed' }, discover)
    assert.equal(matched.length, 1)

    await writeUserHooks({ hooks: { stop: [{ command: './s.sh', matcher: 'Other' }] } })
    const skipped = await cursorStopHooks({ status: 'completed' }, discover)
    assert.equal(skipped.length, 0)
  })

  // --- subagent-type matcher (D1, now via the centralized D3 helper) ---

  it('subagent-type matcher on subagentStart/Stop — fires only for a matching type', async () => {
    await writeUserHooks({
      hooks: {
        subagentStart: [{ command: './val.sh', matcher: 'explore|shell' }],
        subagentStop: [{ command: './done.sh', matcher: 'explore|shell' }],
      },
    })

    assert.equal((await cursorSubagentStartHooks({ subagentType: 'explore' }, discover)).length, 1)
    assert.equal(
      (await cursorSubagentStartHooks({ subagentType: 'investigate_ci' }, discover)).length,
      0,
    )
    assert.equal(
      (await cursorSubagentStopHooks({ subagentType: 'shell', status: 'completed' }, discover))
        .length,
      1,
    )
    assert.equal(
      (
        await cursorSubagentStopHooks(
          { subagentType: 'investigate_ci', status: 'completed' },
          discover,
        )
      ).length,
      0,
    )
  })

  // --- afterFileEdit: glob (Copse convenience) AND matcher (Cursor `Write`) both apply ---

  it('afterFileEdit honours both the Copse `glob` and the Cursor `matcher` (tool type Write)', async () => {
    // matcher matches the Write tool-type; glob narrows by path — both must pass.
    await writeUserHooks({
      hooks: { afterFileEdit: [{ command: './fmt.sh', glob: '**/*.ts', matcher: 'Write' }] },
    })
    assert.equal(
      (await cursorAfterFileEditHooks({ filePath: '/repo/src/a.ts' }, discover)).length,
      1,
    )
    // glob excludes a non-.ts path even though the matcher matches.
    assert.equal(
      (await cursorAfterFileEditHooks({ filePath: '/repo/src/a.md' }, discover)).length,
      0,
    )

    // matcher excludes a Tab-only edit even though the glob matches — Copse edits
    // are the non-tab `Write` tool.
    await writeUserHooks({
      hooks: { afterFileEdit: [{ command: './fmt.sh', glob: '**/*.ts', matcher: '^TabWrite$' }] },
    })
    assert.equal(
      (await cursorAfterFileEditHooks({ filePath: '/repo/src/a.ts' }, discover)).length,
      0,
    )
  })

  // --- defaults + invalid-matcher behavior ---

  it('a hook with no matcher fires for every action (Cursor default)', async () => {
    await writeUserHooks({ hooks: { beforeShellExecution: [{ command: './all.sh' }] } })
    const hooks = await cursorToolGateHooks(
      { toolName: 'run_shell', input: { command: 'anything at all' } },
      discover,
    )
    assert.equal(hooks.length, 1)
  })

  it('an invalid matcher regex skips the hook (skip-and-warn, never fires)', async () => {
    // `(` is an unterminated group — an invalid RegExp. Copse skips the hook
    // rather than firing it for everything (documented divergence: Cursor's docs
    // do not specify invalid-matcher behavior).
    await writeUserHooks({
      hooks: { beforeShellExecution: [{ command: './broken.sh', matcher: '(' }] },
    })
    const hooks = await cursorToolGateHooks(
      { toolName: 'run_shell', input: { command: 'curl x' } },
      discover,
    )
    assert.equal(hooks.length, 0)
  })
})
