// B4 (docs/plans/hooks-and-feature-packs.md, "Complete permission-hook I/O"):
// every Cursor agent-session hook wire payload carries the **real**
// conversation_id / generation_id and the running **model** identity
// (`model` / `model_id` / `model_params`, the `{ id, value }[]` array shape);
// `beforeReadFile` additionally receives the file **content** so a redaction /
// secret-detection hook can inspect the bytes and deny. Pinned here in the house
// style of `permission-platform.test.ts` by capturing each hook's stdin.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSessionInfo } from '@copse/agent/hooks/canonical-events.ts'
import { asTurnTreeId } from '@copse/agent/hooks/turn-tree.ts'
import { userHooksConfigPath, resetCursorHookSessionErrorsForTest } from './cursor-adapter.ts'
import { runToolGateHooks } from './tool-gate.ts'
import { runBeforeSubmitPromptHooks } from './before-submit-prompt.ts'
import { runAfterFileEditHooks } from './after-file-edit.ts'
import { runStopHooks } from './stop.ts'

const SESSION: AgentSessionInfo = {
  conversationId: 'conv-abc',
  generationId: 'gen-xyz',
  model: {
    model: 'claude-sonnet-4-6',
    modelId: 'claude-sonnet-4-6',
    modelParams: [
      { id: 'context_window', value: '200000' },
      { id: 'max_output_tokens', value: '64000' },
    ],
  },
}

describe('permission-hook I/O — agent-session envelope on the wire (B4)', () => {
  let tempHome = ''
  let originalHome: string | undefined
  let capturePath = ''

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-hook-io-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    capturePath = join(tempHome, 'captured-stdin.json')
    resetCursorHookSessionErrorsForTest()
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    await rm(tempHome, { recursive: true, force: true })
  })

  /** A hook that writes its stdin to `capturePath`, then allows. */
  async function writeCapturingHook(event: string): Promise<string> {
    const path = join(tempHome, `${event}.sh`)
    await writeFile(
      path,
      `#!/bin/sh\ncat > '${capturePath}'\nprintf '%s' '{"permission":"allow"}'\n`,
    )
    await chmod(path, 0o755)
    await mkdir(join(tempHome, '.cursor'), { recursive: true })
    await writeFile(
      userHooksConfigPath(),
      JSON.stringify({ hooks: { [event]: [{ command: path }] } }),
    )
    return path
  }

  async function capturedStdin(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(capturePath, 'utf-8')) as Record<string, unknown>
  }

  /** Assert the shared agent-session envelope (ids + model identity). */
  function assertEnvelope(stdin: Record<string, unknown>, event: string): void {
    assert.equal(stdin['conversation_id'], SESSION.conversationId)
    assert.equal(stdin['generation_id'], SESSION.generationId)
    assert.equal(stdin['hook_event_name'], event)
    assert.equal(stdin['model'], 'claude-sonnet-4-6')
    assert.equal(stdin['model_id'], 'claude-sonnet-4-6')
    // model_params is Cursor's `{ id, value }[]` ARRAY, not an object.
    assert.deepEqual(stdin['model_params'], SESSION.model?.modelParams)
    assert.ok(Array.isArray(stdin['model_params']))
  }

  it('beforeShellExecution carries real ids + model', async () => {
    await writeCapturingHook('beforeShellExecution')
    await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'ls' } },
      { workspaceRoot: null, projectTrusted: false, agentSession: SESSION },
    )
    const stdin = await capturedStdin()
    assertEnvelope(stdin, 'beforeShellExecution')
    assert.equal(stdin['command'], 'ls')
  })

  it('beforeMCPExecution carries real ids + model', async () => {
    await writeCapturingHook('beforeMCPExecution')
    await runToolGateHooks(
      { toolName: 'mcp__srv__tool', args: { a: 1 } },
      { workspaceRoot: null, projectTrusted: false, agentSession: SESSION },
    )
    const stdin = await capturedStdin()
    assertEnvelope(stdin, 'beforeMCPExecution')
    assert.equal(stdin['tool_name'], 'mcp__srv__tool')
  })

  it('beforeReadFile carries real ids + model AND the file content', async () => {
    await writeCapturingHook('beforeReadFile')
    const target = join(tempHome, 'secret.txt')
    await writeFile(target, 'ghp_supersecret_token\n')
    await runToolGateHooks(
      { toolName: 'read_file', args: { path: target } },
      { workspaceRoot: null, projectTrusted: false, agentSession: SESSION },
    )
    const stdin = await capturedStdin()
    assertEnvelope(stdin, 'beforeReadFile')
    assert.equal(stdin['file_path'], target)
    // Content is passed so a redaction hook can inspect and deny (B4).
    assert.equal(stdin['content'], 'ghp_supersecret_token\n')
  })

  it('beforeReadFile content is empty when the file cannot be read (never throws)', async () => {
    await writeCapturingHook('beforeReadFile')
    await runToolGateHooks(
      { toolName: 'read_file', args: { path: join(tempHome, 'does-not-exist.txt') } },
      { workspaceRoot: null, projectTrusted: false, agentSession: SESSION },
    )
    const stdin = await capturedStdin()
    assert.equal(stdin['content'], '')
  })

  it('beforeSubmitPrompt carries real ids + model', async () => {
    await writeCapturingHook('beforeSubmitPrompt')
    await runBeforeSubmitPromptHooks('hello world', {
      workspaceRoot: null,
      projectTrusted: false,
      agentSession: SESSION,
    })
    const stdin = await capturedStdin()
    assertEnvelope(stdin, 'beforeSubmitPrompt')
    assert.equal(stdin['prompt'], 'hello world')
  })

  it('afterFileEdit carries real ids + model', async () => {
    await writeCapturingHook('afterFileEdit')
    await runAfterFileEditHooks('/abs/path/file.ts', {
      workspaceRoot: null,
      projectTrusted: false,
      agentSession: SESSION,
    })
    const stdin = await capturedStdin()
    assertEnvelope(stdin, 'afterFileEdit')
    assert.equal(stdin['file_path'], '/abs/path/file.ts')
  })

  it('stop carries real ids + model (captured by value for detached dispatch)', async () => {
    await writeCapturingHook('stop')
    const result = await runStopHooks('completed', {
      threadId: 'hook-io-stop',
      turnTreeId: asTurnTreeId('hook-io-stop:turn'),
      workspaceRoot: null,
      projectTrusted: false,
      agentSession: SESSION,
    })
    // Detached (C1): the hook runs off the critical path — await its completion
    // before reading what it captured.
    await result.settled
    const stdin = await capturedStdin()
    assertEnvelope(stdin, 'stop')
    assert.equal(stdin['status'], 'completed')
  })

  it('omits model identity but keeps empty ids when no session is provided', async () => {
    await writeCapturingHook('beforeShellExecution')
    await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'ls' } },
      { workspaceRoot: null, projectTrusted: false },
    )
    const stdin = await capturedStdin()
    assert.equal(stdin['conversation_id'], '')
    assert.equal(stdin['generation_id'], '')
    assert.equal('model' in stdin, false)
    assert.equal('model_id' in stdin, false)
    assert.equal('model_params' in stdin, false)
  })
})
