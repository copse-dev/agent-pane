import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAcpPrompt } from '../acp/acp-agent-service.ts'
import {
  listCodexSessionFiles,
  readCodexSession,
  readCodexSessionHeader,
} from './codex-sessions.ts'
import type { ExternalSessionFile } from './external-session-types.ts'
import { isCopsePrompt } from './session-files.ts'

let home: string
const ROOT = '/Users/dev/code/my-app'

function writeRollout(name: string, lines: unknown[]): ExternalSessionFile {
  const dir = join(home, 'sessions', '2026', '11', '01')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return { source: 'codex', path, updatedAt: 1, bytes: 1 }
}

const at = (payload: unknown, type = 'response_item'): unknown => ({
  timestamp: '2026-11-01T09:00:00.000Z',
  type,
  payload,
})
const meta = at(
  {
    id: '0199-codex-session',
    timestamp: '2026-11-01T09:00:00.000Z',
    cwd: ROOT,
    originator: 'codex_cli_rs',
    git: { branch: 'feature/login' },
  },
  'session_meta',
)
const userMessage = (text: string): unknown =>
  at({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-sessions-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('Codex CLI sessions', () => {
  it('lists rollout files newest first', async () => {
    writeRollout('rollout-2026-11-01T09-00-00-a.jsonl', [meta])
    writeRollout('rollout-2026-11-01T10-00-00-b.jsonl', [meta])
    writeRollout('notes.txt', [])

    const files = await listCodexSessionFiles(home)

    assert.deepEqual(
      files?.map((file) => file.path.split('/').at(-1)),
      ['rollout-2026-11-01T10-00-00-b.jsonl', 'rollout-2026-11-01T09-00-00-a.jsonl'],
    )
    assert.equal(await listCodexSessionFiles(join(home, 'missing')), null)
  })

  it('titles a session by what the user typed, not the context Codex injected', async () => {
    const file = writeRollout('rollout-a.jsonl', [
      meta,
      userMessage('<environment_context>\n  <cwd>/x</cwd>\n</environment_context>'),
      userMessage('# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>be nice</INSTRUCTIONS>'),
      userMessage('Add a dark mode toggle'),
    ])

    const header = await readCodexSessionHeader(file)

    assert.ok(header)
    assert.equal(header.title, 'Add a dark mode toggle')
    assert.equal(header.sessionId, '0199-codex-session')
    assert.equal(header.cwd, ROOT)
    assert.equal(header.gitBranch, 'feature/login')
  })

  it('turns response items into a transcript with shell calls and their exit status', async () => {
    const file = writeRollout('rollout-a.jsonl', [
      meta,
      userMessage('Run the tests'),
      at({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Find the runner.' }] }),
      at({
        type: 'function_call',
        name: 'shell',
        call_id: 'call_1',
        arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }),
      }),
      at({
        type: 'function_call_output',
        call_id: 'call_1',
        output: JSON.stringify({ output: '1 failing', metadata: { exit_code: 1 } }),
      }),
      at({
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call_2',
        input: '*** Begin Patch',
      }),
      at({ type: 'custom_tool_call_output', call_id: 'call_2', output: 'Done!' }),
      at({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Fixed it.' }],
      }),
      at({ type: 'user_message', message: 'Run the tests' }, 'event_msg'),
    ])

    const session = await readCodexSession(file)

    assert.ok(session)
    assert.deepEqual(
      session.messages.map((message) => [message.role, message.content]),
      [
        ['user', 'Run the tests'],
        ['assistant', ''],
        ['assistant', 'Fixed it.'],
      ],
    )
    const step = session.messages[1]
    assert.ok(step)
    assert.equal(step.reasoning, 'Find the runner.')
    assert.deepEqual(
      step.toolCalls.map((call) => [call.title, call.kind, call.status, call.result]),
      [
        ['npm test', 'execute', 'error', '1 failing'],
        ['Apply patch', 'edit', 'done', 'Done!'],
      ],
    )
  })

  it("leaves out Codex's own reviewer sessions and sessions Copse itself ran", async () => {
    const reviewer = writeRollout('rollout-r.jsonl', [
      at(
        {
          id: 'r',
          timestamp: '2026-11-01T09:00:00.000Z',
          cwd: ROOT,
          source: { subagent: { other: 'guardian' } },
          thread_source: 'guardian_review',
          parent_thread_id: '0199-codex-session',
        },
        'session_meta',
      ),
      userMessage(
        'The following is the Codex agent history whose request action you are assessing',
      ),
    ])
    const fromCopse = writeRollout('rollout-c.jsonl', [
      meta,
      userMessage('Session notes: this session persists across turns, and background…\n\nFix it'),
    ])

    assert.equal(await readCodexSessionHeader(reviewer), null)
    assert.equal(await readCodexSessionHeader(fromCopse), null)
  })

  it('reads the output parts and commands of newer exec and wait calls', async () => {
    const file = writeRollout('rollout-a.jsonl', [
      meta,
      userMessage('List the tools'),
      at({
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_1',
        input: 'const xs = ALL_TOOLS.filter(Boolean)\nreturn xs',
      }),
      at({
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'Script completed\nOutput:\n' },
          { type: 'input_text', text: '[1, 2]' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      }),
      at({
        type: 'function_call',
        name: 'wait',
        call_id: 'call_2',
        arguments: JSON.stringify({ cell_id: '16', yield_time_ms: 20000 }),
      }),
      at({
        type: 'function_call_output',
        call_id: 'call_2',
        output: [{ type: 'input_text', text: 'Script completed\n' }],
      }),
    ])

    const session = await readCodexSession(file)

    assert.deepEqual(
      session?.messages[1]?.toolCalls.map((call) => [call.title, call.kind, call.result]),
      [
        [
          'const xs = ALL_TOOLS.filter(Boolean)',
          'execute',
          'Script completed\nOutput:\n[1, 2][image]\n',
        ],
        ['Wait for cell 16', 'execute', 'Script completed\n'],
      ],
    )
  })

  it("recognises every way Copse's agent prompts open", () => {
    const mounted = { copseServer: 'copse_h0u45itf', bridgeToolNames: ['read_file'] }
    const prior = [{ role: 'user' as const, content: 'Earlier' }]
    for (const prompt of [
      buildAcpPrompt('Fix it', []),
      buildAcpPrompt('Fix it', [], mounted),
      buildAcpPrompt('Fix it', [], { ...mounted, includeNotes: false }),
      buildAcpPrompt('Fix it', prior, { includeNotes: false }),
    ])
      assert.ok(isCopsePrompt(prompt), prompt.slice(0, 80))
    assert.equal(isCopsePrompt('Fix it'), false)
  })

  it('reads rollouts written before records were wrapped', async () => {
    const file = writeRollout('rollout-old.jsonl', [
      { id: 'old-session', timestamp: '2025-06-01T09:00:00.000Z', instructions: null },
      { record_type: 'state' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi!' }] },
    ])

    const session = await readCodexSession(file)

    // An old rollout has no cwd, so it cannot be tied to a project.
    assert.equal(session, null)
  })
})
