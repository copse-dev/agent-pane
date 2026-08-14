import '../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import type { Thread } from '@shared/types'
import {
  downloadThreadArchive,
  threadExportBaseName,
  threadHasExportableContent,
  threadToJsonl,
} from './export-thread.ts'
import { createFakeApi } from './fake-api.test-support.ts'
import {
  expectRecord,
  expectStringArray,
  parseJsonUnknown,
  recordArrayOrEmpty,
} from '@shared/unknown-value.ts'

/** Install `value` at `target[key]`, returning an undo that restores the original. */
function swap(target: object, key: string, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, value })
  return (): void => {
    if (previous) Object.defineProperty(target, key, previous)
    else Reflect.deleteProperty(target, key)
  }
}

/**
 * Run a download and capture what it handed the browser: the clicked anchor and
 * the blob behind its object URL. `click` is intercepted rather than allowed
 * through — happy-dom would otherwise try to navigate to the blob URL.
 */
async function captureDownload(
  run: () => Promise<void>,
): Promise<{ fileName: string; type: string; blob: Blob }> {
  const clicked: HTMLElement[] = []
  const captured: Blob[] = []
  const undo = [
    swap(HTMLElement.prototype, 'click', function click(this: HTMLElement): void {
      clicked.push(this)
    }),
    swap(URL, 'createObjectURL', (blob: Blob): string => {
      captured.push(blob)
      return `blob:test/${String(captured.length)}`
    }),
  ]
  try {
    await run()
  } finally {
    for (const restore of undo) restore()
  }
  const blob = at(captured, 0)
  return { fileName: at(clicked, 0).getAttribute('download') ?? '', type: blob.type, blob }
}

function thread(messages: Thread['messages'] = []): Thread {
  return {
    id: 'thread-1',
    title: 'New Thread',
    status: 'idle',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('export thread', () => {
  it('does not treat a blank thread as exportable', () => {
    assert.equal(threadHasExportableContent(undefined), false)
    assert.equal(threadHasExportableContent(thread()), false)
  })

  it('treats threads with messages as exportable', () => {
    assert.equal(
      threadHasExportableContent(
        thread([
          {
            id: 'message-1',
            role: 'user',
            content: 'hello',
            toolCalls: [],
            createdAt: 2,
          },
        ]),
      ),
      true,
    )
  })

  it('exports one JSONL message line per message', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'user',
          content: 'hello',
          toolCalls: [],
          createdAt: 2,
        },
      ]),
    )

    assert.equal(jsonl.trimEnd().split('\n').length, 2)
  })

  it('includes the thread header fields beyond the legacy subset', () => {
    const t = thread()
    t.status = 'error'
    t.todos = [{ id: 'todo-1', content: 'do thing', status: 'pending' }]
    t.workingBrief = 'fix the bug'
    t.gitBranch = 'feature/x'
    t.contextSnapshot = {
      contextWindow: 200000,
      conversationBudget: 150000,
      conversationTokens: 1000,
      fillRatio: 0.5,
      updatedAt: 3,
    }
    t.queuePaused = true
    t.draftPrompt = 'unsent'

    const header = expectRecord(parseJsonUnknown(at(threadToJsonl(t).trimEnd().split('\n'), 0)))
    assert.equal(header['exportVersion'], 5)
    assert.equal(header['status'], 'error')
    assert.deepEqual(header['todos'], t.todos)
    assert.equal(header['workingBrief'], 'fix the bug')
    assert.equal(header['gitBranch'], 'feature/x')
    assert.deepEqual(header['contextSnapshot'], t.contextSnapshot)
    assert.equal(header['queuePaused'], true)
    assert.equal(header['draftPrompt'], 'unsent')
  })

  it('infers distinct provider slugs from usage.byModel keys', () => {
    const t = thread()
    t.usage = {
      inputTokens: 1,
      outputTokens: 1,
      byModel: {
        'claude-sonnet-4-6': { inputTokens: 1, outputTokens: 1 },
        'gpt-5': { inputTokens: 0, outputTokens: 0 },
        'lmstudio:qwen': { inputTokens: 0, outputTokens: 0 },
      },
    }

    const header = expectRecord(parseJsonUnknown(at(threadToJsonl(t).trimEnd().split('\n'), 0)))
    assert.deepEqual(expectStringArray(header['providers']).sort(), [
      'anthropic',
      'lmstudio',
      'openai',
    ])
  })

  it('exports message commandSummary and full toolCalls (editStats, subagent usage)', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'done',
          commandSummary: 'ran 3 shell commands',
          toolSummary: 'Inspected the repo layout',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'write_file',
              args: {},
              status: 'done',
              result: 'ok',
              editStats: { additions: 5, deletions: 2 },
              subagent: {
                id: 'sub-1',
                kind: 'explore',
                status: 'done',
                prompt: 'look',
                summary: 'found it',
                messages: [],
                usage: { inputTokens: 10, outputTokens: 4 },
              },
            },
          ],
          createdAt: 2,
        },
      ]),
    )

    const line = expectRecord(parseJsonUnknown(at(jsonl.trimEnd().split('\n'), 1)))
    assert.equal(line['commandSummary'], 'ran 3 shell commands')
    assert.equal(line['toolSummary'], 'Inspected the repo layout')
    const toolCall = at(recordArrayOrEmpty(line['toolCalls']), 0)
    assert.deepEqual(toolCall['editStats'], { additions: 5, deletions: 2 })
    assert.deepEqual(expectRecord(toolCall['subagent'])['usage'], {
      inputTokens: 10,
      outputTokens: 4,
    })
  })

  it('exports assistant reasoning when present', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'answer',
          reasoning: 'thinking step by step',
          toolCalls: [],
          createdAt: 2,
        },
      ]),
    )

    const line = expectRecord(parseJsonUnknown(at(jsonl.trimEnd().split('\n'), 1)))
    assert.equal(line['reasoning'], 'thinking step by step')
  })

  it('exports a message-anchored post-turn review on its message line', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'done with the change',
          toolCalls: [],
          review: { status: 'done', summary: '1 likely bug.' },
          createdAt: 2,
        },
      ]),
    )

    const line = expectRecord(parseJsonUnknown(at(jsonl.trimEnd().split('\n'), 1)))
    assert.deepEqual(line['review'], { status: 'done', summary: '1 likely bug.' })
  })

  it('exports per-message primary-chat model when present', () => {
    const jsonl = threadToJsonl(
      thread([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'done',
          model: 'claude-sonnet-4-6',
          toolCalls: [],
          createdAt: 2,
        },
      ]),
    )
    const msg = expectRecord(parseJsonUnknown(at(jsonl.trimEnd().split('\n'), 1)))
    assert.equal(msg['model'], 'claude-sonnet-4-6')
  })
})

describe('export thread download naming', () => {
  const stamp = new Date('2026-04-05T06:07:08Z')

  it('slugifies the title and stamps the day', () => {
    const named = thread()
    named.title = 'Fix the *flaky* login test'
    assert.equal(threadExportBaseName(named, stamp), 'Fix-the-flaky-login-test-2026-04-05')
  })

  it('falls back to "thread" for an untitled thread', () => {
    const named = thread()
    named.title = ''
    assert.equal(threadExportBaseName(named, stamp), 'thread-2026-04-05')
  })

  it('truncates a long title so the filename stays manageable', () => {
    const named = thread()
    named.title = 'x'.repeat(120)
    assert.equal(threadExportBaseName(named, stamp), `${'x'.repeat(40)}-2026-04-05`)
  })
})

describe('downloadThreadArchive', () => {
  it('asks the main process for the thread directory and saves it as a .zip', async () => {
    const named = thread()
    named.title = 'Archive me'
    const calls: Array<[string, string]> = []
    const api = createFakeApi()
    const downloaded = await captureDownload(async () => {
      await downloadThreadArchive(
        {
          ...api,
          threads: {
            ...api.threads,
            exportArchive: (
              projectId: string,
              threadId: string,
            ): ReturnType<typeof api.threads.exportArchive> => {
              calls.push([projectId, threadId])
              return Promise.resolve({
                bytes: new Uint8Array([80, 75, 5, 6]),
                build: {
                  version: '1.2.3',
                  buildCommit: null,
                  buildDirty: null,
                  packaged: false,
                  platform: 'test',
                  capturedAt: '2026-08-14T09:30:00.000Z',
                },
              })
            },
          },
        },
        'project-1',
        named,
      )
    })

    assert.deepEqual(calls, [['project-1', 'thread-1']])
    assert.match(downloaded.fileName, /^Archive-me-\d{4}-\d{2}-\d{2}\.zip$/)
    assert.equal(downloaded.type, 'application/zip')
    assert.deepEqual(
      new Uint8Array(await downloaded.blob.arrayBuffer()),
      new Uint8Array([80, 75, 5, 6]),
    )
  })
})
