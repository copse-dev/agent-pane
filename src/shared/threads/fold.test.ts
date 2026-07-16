import { createHash } from 'node:crypto'
import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import { test } from 'node:test'
import type { Message, Thread } from '@shared/types'
import { explodeThread, foldThread, type FileToWrite, type RefResolver } from './fold.ts'
import type { ThreadMeta } from './spine-schema.ts'

const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

/** Resolver over an in-memory {ref -> contents} map, as the store's fs would provide. */
function resolverFor(files: FileToWrite[]): RefResolver {
  const map = new Map(files.map((f) => [f.ref, f.contents]))
  return (ref) => {
    const contents = map.get(ref)
    if (contents === undefined) throw new Error(`missing ref: ${ref}`)
    return contents
  }
}

function meta(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    id: 't1',
    title: 'A thread',
    status: 'idle',
    usage: { inputTokens: 10, outputTokens: 20 },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function roundTrip(messages: Message[], threadMeta: ThreadMeta = meta()): Thread {
  const { spine, files } = explodeThread(messages, hash)
  return foldThread(threadMeta, spine, resolverFor(files), { hash })
}

test('round-trips a simple user + assistant exchange', () => {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'hi', toolCalls: [], createdAt: 100 },
    { id: 'a1', role: 'assistant', content: 'hello', toolCalls: [], createdAt: 200 },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('round-trips a message whose body contains a --- fence', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '---\nfoo: bar\n---\nbody',
      toolCalls: [],
      createdAt: 1,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('round-trips reasoning, images, and commandSummary', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      reasoning: 'let me think\n---\nabout it',
      images: ['data:image/png;base64,iVBORw0KGgo=', 'data:image/gif;base64,R0lGOD=='],
      commandSummary: 'ran two commands',
      toolCalls: [],
      createdAt: 5,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('round-trips a user message with transcript attachments', () => {
  const messages: Message[] = [
    {
      id: 'u1',
      role: 'user',
      // The ￼ placeholder marks where the pasted block sits inline.
      content: 'apply this ￼ to the intro',
      attachments: [
        { kind: 'paste', label: 'Editor feedback' },
        { kind: 'file', label: 'notes.txt' },
        { kind: 'thread', label: 'Auth refactor' },
      ],
      toolCalls: [],
      createdAt: 7,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('round-trips a message-anchored post-turn review', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      toolCalls: [],
      review: { status: 'done', summary: '1 likely bug: off-by-one in the loop.' },
      createdAt: 7,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('round-trips tool calls with inline args and a spilled result', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'tc1',
          name: 'read_file',
          args: { path: 'x.ts', start_line: 1 },
          status: 'done',
          result: 'file contents\nwith lines',
          editStats: { additions: 3, deletions: 1 },
        },
      ],
      createdAt: 5,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('distinguishes a null result from an empty-string result', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc1', name: 'a', args: {}, status: 'done', result: null },
        { id: 'tc2', name: 'b', args: {}, status: 'done', result: '' },
      ],
      createdAt: 5,
    },
  ]
  const [msg] = roundTrip(messages).messages
  if (!msg) throw new Error('expected one message')
  strictEqual(msg.toolCalls[0]?.result, null)
  strictEqual(msg.toolCalls[1]?.result, '')
})

test('round-trips a nested subagent session', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: 'exploring',
      toolCalls: [
        {
          id: 'tc1',
          name: 'explore',
          args: { prompt: 'find the bug' },
          status: 'done',
          result: 'summary text',
          subagent: {
            id: 'sub1',
            kind: 'explore',
            status: 'done',
            prompt: 'find the bug',
            summary: 'found it',
            model: 'claude-sonnet-4-6',
            usage: { inputTokens: 5, outputTokens: 6 },
            messages: [
              { id: 'sm1', role: 'user', content: 'go', toolCalls: [], createdAt: 1 },
              {
                id: 'sm2',
                role: 'assistant',
                content: 'searching',
                toolCalls: [
                  {
                    id: 'stc1',
                    name: 'search_code',
                    args: { pattern: 'x' },
                    status: 'done',
                    result: 'match',
                  },
                ],
              },
            ],
          },
        },
      ],
      createdAt: 5,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('round-trips a per-message primary-chat model', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: 'from sonnet',
      model: 'claude-sonnet-4-6',
      toolCalls: [],
      createdAt: 1,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('preserves thread metadata around the messages', () => {
  const m = meta({
    title: 'Kept',
    todos: [{ id: 'x', content: 'do', status: 'pending' }],
    model: 'gpt-5',
  })
  const folded = roundTrip(
    [{ id: 'u1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1 }],
    m,
  )
  strictEqual(folded.title, 'Kept')
  strictEqual(folded.model, 'gpt-5')
  deepStrictEqual(folded.todos, [{ id: 'x', content: 'do', status: 'pending' }])
})

test('throws on a tampered message body (hash mismatch)', () => {
  const messages: Message[] = [
    { id: 'a1', role: 'assistant', content: 'original', toolCalls: [], createdAt: 1 },
  ]
  const { spine, files } = explodeThread(messages, hash)
  const tampered = files.map((f) =>
    f.ref === 'messages/a1.md' ? { ...f, contents: f.contents.replace('original', 'tampered') } : f,
  )
  throws(() => foldThread(meta(), spine, resolverFor(tampered), { hash }), /hash mismatch/)
})

test('skips hash verification when no hash fn is provided', () => {
  const messages: Message[] = [
    { id: 'a1', role: 'assistant', content: 'x', toolCalls: [], createdAt: 1 },
  ]
  const { spine, files } = explodeThread(messages, hash)
  const folded = foldThread(meta(), spine, resolverFor(files))
  deepStrictEqual(folded.messages, messages)
})

test('error-role messages round-trip', () => {
  const messages: Message[] = [
    { id: 'e1', role: 'error', content: 'boom', toolCalls: [], createdAt: 1 },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})
