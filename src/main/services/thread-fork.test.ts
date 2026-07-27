import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMMessage, Message, Thread } from '@shared/types'
import { loadAgentHistory, saveAgentHistory, saveProjectThread } from './thread-store.ts'
import { forkThreadHistory, rebuildAgentHistory } from './thread-fork.ts'

function userMsg(id: string, content: string, images?: string[]): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 1, ...(images ? { images } : {}) }
}

function assistantMsg(id: string, content: string, toolCalls: Message['toolCalls'] = []): Message {
  return { id, role: 'assistant', content, toolCalls, createdAt: 2 }
}

function thread(id: string, messages: Message[]): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('rebuildAgentHistory', () => {
  it('maps a plain question-and-answer turn onto provider messages', () => {
    const history = rebuildAgentHistory([userMsg('u1', 'Why?'), assistantMsg('a1', 'Because.')])

    assert.deepEqual(history, [
      { role: 'user', content: 'Why?' },
      { role: 'assistant', content: 'Because.' },
    ])
  })

  it('splits an assistant turn into text, tool calls, and one tool-result message', () => {
    const history = rebuildAgentHistory([
      userMsg('u1', 'Read it'),
      assistantMsg('a1', 'Looking now', [
        { id: 'tc-1', name: 'read_file', args: { path: 'a.ts' }, status: 'done', result: 'AAA' },
        { id: 'tc-2', name: 'read_file', args: { path: 'b.ts' }, status: 'error', result: 'boom' },
      ]),
    ])

    assert.deepEqual(history, [
      { role: 'user', content: 'Read it' },
      { role: 'assistant', content: 'Looking now' },
      {
        role: 'assistant',
        content: [
          { id: 'tc-1', name: 'read_file', args: { path: 'a.ts' } },
          { id: 'tc-2', name: 'read_file', args: { path: 'b.ts' } },
        ],
      },
      {
        role: 'tool',
        toolResults: [
          { toolCallId: 'tc-1', result: 'AAA' },
          { toolCallId: 'tc-2', result: 'boom' },
        ],
      },
    ])
  })

  it('carries images ahead of the prompt text, as the composer sends them', () => {
    const history = rebuildAgentHistory([
      userMsg('u1', 'What is this?', ['data:image/png;base64,x']),
    ])

    assert.deepEqual(history, [
      {
        role: 'user',
        content: [
          { type: 'image', dataUrl: 'data:image/png;base64,x' },
          { type: 'text', text: 'What is this?' },
        ],
      },
    ])
  })

  it('drops the paste placeholders whose expanded blocks were never stored', () => {
    const history = rebuildAgentHistory([userMsg('u1', 'Explain ￼ please')])
    assert.deepEqual(history, [{ role: 'user', content: 'Explain please' }])
  })

  it('skips error notes and empty assistant turns — neither was ever sent upstream', () => {
    const history = rebuildAgentHistory([
      userMsg('u1', 'Go'),
      { id: 'e1', role: 'error', content: 'Agent failed', toolCalls: [], createdAt: 3 },
      assistantMsg('a1', '   '),
    ])
    assert.deepEqual(history, [{ role: 'user', content: 'Go' }])
  })
})

describe('forkThreadHistory', () => {
  let root: string
  let previousRoot: string | undefined

  const sourceMessages = [
    userMsg('u1', 'First question'),
    assistantMsg('a1', 'First answer'),
    userMsg('u2', 'Second question'),
    assistantMsg('a2', 'Second answer'),
  ]

  // Real provider history holds turns the transcript never shows — here a
  // truncation nudge — which is exactly why a whole-thread fork copies it.
  const sourceHistory: LLMMessage[] = [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Second question' },
    { role: 'user', content: 'Continue where you left off.' },
    { role: 'assistant', content: 'Second answer' },
  ]

  beforeEach(async () => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-thread-fork-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    await saveProjectThread('proj', thread('src', sourceMessages))
    await saveAgentHistory('proj', 'src', sourceHistory)
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('copies the sidecar verbatim when the whole thread is forked', async () => {
    const result = await forkThreadHistory('proj', 'src', 'fork')

    assert.deepEqual(result, { source: 'copied', messageCount: sourceHistory.length })
    assert.deepEqual(await loadAgentHistory('proj', 'fork'), sourceHistory)
  })

  it('treats a fork through the last message as a whole-thread fork', async () => {
    const result = await forkThreadHistory('proj', 'src', 'fork', 'a2')

    assert.equal(result.source, 'copied')
    assert.deepEqual(await loadAgentHistory('proj', 'fork'), sourceHistory)
  })

  it('rebuilds history from the transcript when forking from an earlier message', async () => {
    const result = await forkThreadHistory('proj', 'src', 'fork', 'a1')

    assert.deepEqual(result, { source: 'rebuilt', messageCount: 2 })
    assert.deepEqual(await loadAgentHistory('proj', 'fork'), [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
    ])
  })

  it('leaves the source thread and its history untouched', async () => {
    await forkThreadHistory('proj', 'src', 'fork', 'a1')
    assert.deepEqual(await loadAgentHistory('proj', 'src'), sourceHistory)
  })

  it('rebuilds a visible first prompt when its run has not committed history yet', async () => {
    await saveProjectThread('proj', thread('fresh', [userMsg('u1', 'Hi')]))

    const result = await forkThreadHistory('proj', 'fresh', 'fork')

    assert.deepEqual(result, { source: 'rebuilt', messageCount: 1 })
    assert.deepEqual(await loadAgentHistory('proj', 'fork'), [{ role: 'user', content: 'Hi' }])
  })

  it('writes no sidecar when neither provider history nor a transcript exists', async () => {
    await saveProjectThread('proj', thread('fresh', []))

    const result = await forkThreadHistory('proj', 'fresh', 'fork')

    assert.deepEqual(result, { source: 'empty', messageCount: 0 })
    assert.deepEqual(await loadAgentHistory('proj', 'fork'), [])
  })

  it('rejects a thread that does not belong to the project', async () => {
    await assert.rejects(
      () => forkThreadHistory('other-proj', 'src', 'fork'),
      /does not belong to project/,
    )
  })

  it('rejects an unknown fork point rather than silently copying everything', async () => {
    await assert.rejects(() => forkThreadHistory('proj', 'src', 'fork', 'nope'), /is not in thread/)
  })

  it('refuses to fork a thread onto itself', async () => {
    await assert.rejects(() => forkThreadHistory('proj', 'src', 'src'), /onto itself/)
  })
})
