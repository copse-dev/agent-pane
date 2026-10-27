import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readPromptEvidence } from './environment-evidence.ts'

const NOW = Date.now()
let root: string
let previous: string | undefined

function message(
  id: string,
  calls: Array<{ id: string; name: string; args: unknown }>,
): Record<string, unknown> {
  return {
    v: 1,
    type: 'message',
    id,
    role: 'assistant',
    createdAt: NOW,
    content: { ref: `messages/${id}.md`, sha256: 'x' },
    toolCalls: calls.map((call) => ({ ...call, status: 'done', result: null })),
  }
}

function decision(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    type: 'decision',
    id: `d-${String(Math.random())}`,
    at: NOW,
    kind: 'shell',
    actor: 'user',
    verdict: 'approved',
    subject: 'shell command (arguments omitted)',
    cause: 'shell-sandbox-escalation',
    ...fields,
  }
}

function writeThread(threadId: string, lines: unknown[]): string {
  const dir = join(root, 'proj', threadId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return path
}

describe('readPromptEvidence', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-env-evidence-'))
    previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
  })
  after(() => {
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  })

  it('joins human shell answers to their command and drops everything else', async () => {
    writeThread('t1', [
      // The decision is written before the message that holds its settled tool call.
      decision({ toolCallId: 'c1' }),
      message('m1', [
        { id: 'c1', name: 'run_shell', args: { command: 'xcodebuild build' } },
        { id: 'c2', name: 'read_file', args: { path: 'a.ts' } },
      ]),
      decision({ actor: 'classifier', verdict: 'allowed', toolCallId: 'c1' }),
      decision({ verdict: 'timeout', toolCallId: 'c1' }),
      decision({ at: NOW - 40 * 86_400_000, toolCallId: 'c1' }),
      decision({ kind: 'web', cause: 'web-origin', subject: 'https://docs.example.com' }),
    ])
    const evidence = await readPromptEvidence('proj', NOW - 30 * 86_400_000)
    assert.deepEqual(
      evidence.map((item) => [item.kind, item.verdict, item.command ?? item.subject]),
      [
        ['shell', 'approved', 'xcodebuild build'],
        ['web', 'approved', 'https://docs.example.com'],
      ],
    )
  })

  it('skips threads untouched since the window began', async () => {
    const path = writeThread('old', [
      decision({ toolCallId: 'c9' }),
      message('m9', [{ id: 'c9', name: 'run_shell', args: { command: 'make' } }]),
    ])
    const old = (NOW - 60 * 86_400_000) / 1000
    utimesSync(path, old, old)
    const evidence = await readPromptEvidence('proj', NOW - 30 * 86_400_000)
    assert.ok(evidence.every((item) => item.threadId !== 'old'))
  })
})
