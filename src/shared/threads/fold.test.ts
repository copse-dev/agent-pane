import { createHash } from 'node:crypto'
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict'
import { test } from 'node:test'
import type { Message, Thread } from '@shared/types'
import {
  attachHookCards,
  explodeThread,
  foldThread,
  refsOfLine,
  type FileToWrite,
  type RefResolver,
} from './fold.ts'
import {
  SPINE_SCHEMA_VERSION,
  parseSpine,
  serializeSpineLine,
  parseSpineEntries,
  type SpineHookRunLine,
  type SpineMessageLine,
  type ThreadMeta,
} from './spine-schema.ts'

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

test('round-trips reasoning, images, commandSummary, and toolSummary', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      reasoning: 'let me think\n---\nabout it',
      images: ['data:image/png;base64,iVBORw0KGgo=', 'data:image/gif;base64,R0lGOD=='],
      commandSummary: 'ran two commands',
      toolSummary: 'Read the settings UI',
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
        { kind: 'paste', label: 'Editor feedback', content: 'Use the shorter heading.' },
        { kind: 'file', label: 'notes.txt', content: 'release checklist\n- test\n' },
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

test('round-trips structured terminal diagnostics', () => {
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: 'An error occurred.',
      toolCalls: [],
      turnOutcome: {
        status: 'failed',
        stopReason: 'error',
        rawStopReason: 'INTERNAL_ERROR',
        source: 'provider',
        executor: 'acp',
        provider: 'claude-agent-acp',
        model: 'acp:claude-agent-acp#opus[1m]',
        lastEvent: 'tool',
        error: {
          name: 'RequestError',
          code: -32603,
          message: 'Internal error',
          details: 'Internal error during token generation',
        },
        endedAt: 9,
      },
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

test('round-trips ACP tool-call display metadata (kind + resultFormat)', () => {
  // External ACP agents tag calls with a kind ('read', 'execute', …) and
  // Markdown-formatted results; both must survive persistence or reloaded
  // threads lose their grouping, shell labels, and Markdown rendering.
  const messages: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'tc1',
          name: 'Read src/x.ts (1 - 40)',
          args: { file_path: 'src/x.ts' },
          status: 'done',
          result: '1\tcontents',
          kind: 'read',
          resultFormat: 'markdown',
        },
        {
          id: 'tc2',
          name: 'git status',
          args: { command: 'git status' },
          status: 'done',
          result: '```console\nclean\n```',
          kind: 'execute',
          resultFormat: 'markdown',
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

// decision 10: a hook-originated turn's provenance is persisted on the spine so
// the origin marker survives a reload (history stays honest about authorship).
test('round-trips a hook-originated turn origin + editedByUser', () => {
  const messages: Message[] = [
    {
      id: 'u1',
      role: 'user',
      content: 'finish the open todos before stopping',
      toolCalls: [],
      origin: { kind: 'hook', hookId: 'todo-closeout', event: 'stop' },
      editedByUser: true,
      createdAt: 1,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

// The prompt's starting repository state (HEAD commit + dirty flag) is
// captured at send time and must survive the spine round-trip untouched.
test('round-trips a prompt startingCommit + dirty flag', () => {
  const messages: Message[] = [
    {
      id: 'u1',
      role: 'user',
      content: 'fix the flaky test',
      toolCalls: [],
      startingCommit: 'a1b2c3d4e5f6',
      dirty: true,
      createdAt: 1,
    },
  ]
  deepStrictEqual(roundTrip(messages).messages, messages)
})

test('a message with no captured git state round-trips without the fields', () => {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'no git repo here', toolCalls: [], createdAt: 1 },
  ]
  const { spine } = explodeThread(messages, hash)
  const [line] = spine
  ok(line)
  strictEqual('startingCommit' in line, false)
  strictEqual('dirty' in line, false)
  deepStrictEqual(roundTrip(messages).messages, messages)
})

// `hookCards` is display-only (decision 17): derived from the spine `hook_run`
// lines at read time, never persisted via explode. A pure fold round-trip that
// starts without hookCards must not invent any.
test('the message explode path never persists derived hookCards', () => {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'hi', toolCalls: [], createdAt: 1 },
  ]
  const { spine } = explodeThread(messages, hash)
  // Nothing about the message line carries hook cards.
  const [line] = spine
  ok(line)
  deepStrictEqual(line.toolCalls, [])
  strictEqual('hookCards' in line, false)
})

function hookRun(id: string, overrides: Partial<SpineHookRunLine> = {}): SpineHookRunLine {
  return {
    v: SPINE_SCHEMA_VERSION,
    type: 'hook_run',
    id,
    event: 'stop',
    hookId: 'todo-closeout',
    executor: 'command',
    startedAt: 0,
    durationMs: 5,
    exitCode: 0,
    parseOk: true,
    decision: { permission: 'deny' },
    ...overrides,
  }
}

// decision 6 + 10 + 17: hook_run spine lines are attached to the message they
// fired within (the one that precedes them in the file) as display-only cards.
test('attachHookCards anchors hook runs to the preceding message', () => {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'go', toolCalls: [], createdAt: 1 },
    { id: 'a1', role: 'assistant', content: 'done', toolCalls: [], createdAt: 2 },
  ]
  const raw = [
    serializeSpineLine({
      v: SPINE_SCHEMA_VERSION,
      type: 'message',
      id: 'u1',
      role: 'user',
      content: { ref: 'messages/u1.md', sha256: 'x' },
      toolCalls: [],
    }),
    serializeSpineLine(hookRun('h1')),
    serializeSpineLine({
      v: SPINE_SCHEMA_VERSION,
      type: 'message',
      id: 'a1',
      role: 'assistant',
      content: { ref: 'messages/a1.md', sha256: 'y' },
      toolCalls: [],
    }),
  ].join('\n')

  const withCards = attachHookCards(messages, parseSpineEntries(raw))
  const first = withCards[0]
  ok(first)
  const cards = first.hookCards
  ok(cards)
  strictEqual(cards.length, 1)
  const card0 = cards[0]
  ok(card0)
  strictEqual(card0.status, 'deny')
  const second = withCards[1]
  ok(second)
  strictEqual(second.hookCards, undefined)
})

test('attachHookCards keeps orphan runs (no/absent anchor) on the first message', () => {
  const messages: Message[] = [
    { id: 'a1', role: 'assistant', content: 'x', toolCalls: [], createdAt: 1 },
  ]
  // A hook_run before any message line (anchor = null) and one anchored to a
  // deleted message id both fall onto the first message rather than vanish.
  const raw = [
    serializeSpineLine(hookRun('h-null')),
    serializeSpineLine({
      v: SPINE_SCHEMA_VERSION,
      type: 'message',
      id: 'a1',
      role: 'assistant',
      content: { ref: 'messages/a1.md', sha256: 'y' },
      toolCalls: [],
    }),
  ].join('\n')
  const withCards = attachHookCards(messages, parseSpineEntries(raw))
  const first = withCards[0]
  ok(first)
  const cards = first.hookCards
  ok(cards)
  strictEqual(cards.length, 1)
  const card0 = cards[0]
  ok(card0)
  strictEqual(card0.id, 'h-null')
})

test('attachHookCards is a no-op when there are no hook runs', () => {
  const messages: Message[] = [
    { id: 'a1', role: 'assistant', content: 'x', toolCalls: [], createdAt: 1 },
  ]
  const { spine } = explodeThread(messages, hash)
  const raw = spine.map((l) => serializeSpineLine(l)).join('\n')
  const same = attachHookCards(messages, parseSpineEntries(raw))
  strictEqual(same[0], messages[0])
})

/**
 * Records every ref the fold asks for, so a test can compare the fold's real
 * appetite against what {@link refsOfLine} advertises.
 */
function recordingResolverFor(files: FileToWrite[]): {
  resolve: RefResolver
  requested: Set<string>
} {
  const base = resolverFor(files)
  const requested = new Set<string>()
  return {
    resolve: (ref): string => {
      requested.add(ref)
      return base(ref)
    },
    requested,
  }
}

/** Collect refs the way the thread store's prefetch does — via `refsOfLine` only. */
function prefetchRefs(spine: SpineMessageLine[], files: FileToWrite[]): Set<string> {
  const map = new Map(files.map((f) => [f.ref, f.contents]))
  const out = new Set<string>()
  let frontier = [{ prefix: '', lines: spine }]
  while (frontier.length > 0) {
    const next: typeof frontier = []
    for (const { prefix, lines } of frontier) {
      for (const line of lines) {
        const { files: fileRefs, subagentDirs } = refsOfLine(line)
        for (const ref of fileRefs) out.add(prefix + ref)
        for (const dir of subagentDirs) {
          const eventsRef = `${prefix}${dir}events.jsonl`
          out.add(eventsRef)
          const raw = map.get(eventsRef)
          if (raw !== undefined) next.push({ prefix: prefix + dir, lines: parseSpine(raw) })
        }
      }
    }
    frontier = next
  }
  return out
}

// The thread store prefetches a thread's files asynchronously and then folds from
// memory. That only works while `refsOfLine` and the fold agree on which refs
// exist: a ref the fold wants but `refsOfLine` omits is never prefetched, and the
// fold throws `Missing thread file` — silently skipping the whole thread.
test('refsOfLine enumerates exactly the refs the fold resolves', () => {
  const messages: Message[] = [
    {
      id: 'u1',
      role: 'user',
      content: 'look at this',
      images: ['data:image/png;base64,aaaa'],
      attachments: [{ kind: 'file', label: 'notes.txt', content: 'attached snapshot' }],
      toolCalls: [],
      createdAt: 1,
    },
    {
      id: 'a1',
      role: 'assistant',
      content: 'exploring',
      reasoning: 'thinking about it',
      toolCalls: [
        { id: 'tc0', name: 'read_file', args: { path: 'a' }, status: 'done', result: 'contents' },
        { id: 'tc1', name: 'noop', args: {}, status: 'done', result: null },
        {
          id: 'tc2',
          name: 'explore',
          args: { prompt: 'find it' },
          status: 'done',
          result: 'summary',
          subagent: {
            id: 'sub1',
            kind: 'explore',
            status: 'done',
            prompt: 'find it',
            summary: 'found',
            messages: [
              {
                id: 'sm1',
                role: 'assistant',
                content: 'nested',
                toolCalls: [
                  {
                    id: 'stc1',
                    name: 'grep',
                    args: {},
                    status: 'done',
                    result: 'hit',
                    // A subagent of a subagent: the prefetch has to keep recursing.
                    subagent: {
                      id: 'sub2',
                      kind: 'explore',
                      status: 'done',
                      prompt: 'deeper',
                      summary: 'deeper still',
                      messages: [{ id: 'dm1', role: 'assistant', content: 'deep', toolCalls: [] }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
      createdAt: 2,
    },
  ]

  const { spine, files } = explodeThread(messages, hash)
  const { resolve, requested } = recordingResolverFor(files)
  foldThread(meta(), spine, resolve, { hash })

  deepStrictEqual([...prefetchRefs(spine, files)].sort(), [...requested].sort())
})
