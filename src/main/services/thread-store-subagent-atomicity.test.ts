import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  promises as fsPromises,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, SubagentSession } from '@shared/types'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { parseSpineEntries, type SpineMessageLine } from '@copse/thread-store/spine-schema.ts'
import {
  appendMessage,
  closeThreadStoreIndexes,
  getProjectThread,
  saveProjectThread,
} from './thread-store.ts'

// #4438: re-finalising a message must not rewrite its nested subagent
// transcript in place, because the fold verifies those files strictly.

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copse-subagent-atomicity-'))
  configureThreadStore({ workspaceRoot: () => root })
})
afterEach(() => {
  closeThreadStoreIndexes()
  configureThreadStore()
  rmSync(root, { recursive: true, force: true })
})

function session(text: string, status: SubagentSession['status']): SubagentSession {
  return {
    id: 'sub1',
    kind: 'explore',
    status,
    prompt: 'find the bug',
    summary: status === 'done' ? 'found it' : null,
    messages: [
      { id: 'sm1', role: 'user', content: 'go', toolCalls: [], createdAt: 1 },
      {
        id: 'sm2',
        role: 'assistant',
        content: text,
        toolCalls: [
          {
            id: 'call_0',
            name: 'grep',
            args: {},
            status: 'done',
            result: text,
          },
        ],
        createdAt: 2,
      },
    ],
  }
}

function withSubagent(text: string, status: SubagentSession['status']): Message {
  return {
    id: 'saved',
    role: 'assistant',
    content: 'Delegating',
    toolCalls: [
      {
        id: 'task_0',
        name: 'task',
        args: {},
        status: 'done',
        result: 'ok',
        subagent: session(text, status),
      },
    ],
    createdAt: 1,
  }
}

async function seed(): Promise<Message> {
  const message = withSubagent('first partial transcript', 'running')
  await saveProjectThread('p', {
    id: 't',
    title: 'Atomic subagent',
    status: 'idle',
    messages: [message],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  })
  return message
}

function messageLine(dir: string): SpineMessageLine {
  const line = parseSpineEntries(readFileSync(join(dir, 'events.jsonl'), 'utf8')).find(
    (entry) => entry.line?.type === 'message',
  )?.line
  assert.ok(line?.type === 'message')
  return line
}

function subagentRef(dir: string): string {
  const ref = messageLine(dir).toolCalls[0]?.subagent?.ref
  assert.ok(ref)
  return ref
}

test('a re-finalisation that fails after rewriting nested files still loads the old transcript', async () => {
  const message = await seed()
  const dir = join(root, 'p', 't')
  const events = join(dir, 'events.jsonl')
  const before = readFileSync(events, 'utf8')
  const oldRef = subagentRef(dir)
  const realRename = fsPromises.rename
  // Fail the nested spine replacement: the nested prose and blobs have already
  // been written by then, which is the half-finished save from the issue.
  const rename = mock.method(
    fsPromises,
    'rename',
    async (...args: Parameters<typeof realRename>): ReturnType<typeof realRename> => {
      const target = String(args[1])
      if (target.includes(join(dir, 'subagents')) && target.endsWith('events.jsonl')) {
        throw new Error('simulated nested spine failure')
      }
      return realRename(...args)
    },
  )
  const replacement = withSubagent('second partial transcript', 'running')
  try {
    await assert.rejects(appendMessage('p', 't', replacement), /simulated nested spine failure/)
  } finally {
    rename.mock.restore()
  }
  assert.equal(readFileSync(events, 'utf8'), before)
  assert.equal(subagentRef(dir), oldRef)
  closeThreadStoreIndexes()
  const reloaded = await getProjectThread('p', 't')
  assert.deepEqual(reloaded?.messages[0]?.toolCalls[0]?.subagent, message.toolCalls[0]?.subagent)

  // The retry commits the new transcript.
  await appendMessage('p', 't', replacement)
  closeThreadStoreIndexes()
  const retried = await getProjectThread('p', 't')
  assert.deepEqual(retried?.messages[0]?.toolCalls[0]?.subagent, replacement.toolCalls[0]?.subagent)
})

test('a re-finalisation whose parent spine write fails leaves the old nested directory untouched', async () => {
  const message = await seed()
  const dir = join(root, 'p', 't')
  const events = join(dir, 'events.jsonl')
  const oldRef = subagentRef(dir)
  const oldNested = readFileSync(join(dir, oldRef, 'events.jsonl'), 'utf8')
  const oldProse = readFileSync(join(dir, oldRef, 'messages/sm2.md'), 'utf8')
  const realRename = fsPromises.rename
  const rename = mock.method(
    fsPromises,
    'rename',
    async (...args: Parameters<typeof realRename>): ReturnType<typeof realRename> => {
      if (String(args[1]) === events) throw new Error('simulated parent spine failure')
      return realRename(...args)
    },
  )
  try {
    await assert.rejects(
      appendMessage('p', 't', withSubagent('second partial transcript', 'running')),
      /simulated parent spine failure/,
    )
  } finally {
    rename.mock.restore()
  }
  assert.equal(readFileSync(join(dir, oldRef, 'events.jsonl'), 'utf8'), oldNested)
  assert.equal(readFileSync(join(dir, oldRef, 'messages/sm2.md'), 'utf8'), oldProse)
  closeThreadStoreIndexes()
  const reloaded = await getProjectThread('p', 't')
  assert.deepEqual(reloaded?.messages[0]?.toolCalls[0]?.subagent, message.toolCalls[0]?.subagent)
})

test('a committed re-finalisation switches to a fresh directory and removes the superseded one', async () => {
  await seed()
  const dir = join(root, 'p', 't')
  assert.equal(subagentRef(dir), 'subagents/sub1/')
  let previous = subagentRef(dir)
  for (let round = 1; round <= 5; round++) {
    await appendMessage('p', 't', withSubagent(`partial ${String(round)}`, 'running'))
    const ref = subagentRef(dir)
    assert.match(ref, /^subagents\/~rev-[0-9a-f]{64}\/$/)
    assert.notEqual(ref, previous)
    assert.equal(existsSync(join(dir, previous)), false)
    previous = ref
  }
  const finished = withSubagent('final transcript', 'done')
  await appendMessage('p', 't', finished)
  assert.equal(messageLine(dir).toolCalls[0]?.subagent?.id, 'sub1')
  assert.deepEqual(readdirSync(join(dir, 'subagents')), [
    subagentRef(dir).slice('subagents/'.length, -1),
  ])
  closeThreadStoreIndexes()
  const reloaded = await getProjectThread('p', 't')
  assert.deepEqual(reloaded?.messages[0]?.toolCalls[0]?.subagent, finished.toolCalls[0]?.subagent)
})

test('an unchanged transcript re-finalised again reuses its directory', async () => {
  await seed()
  const dir = join(root, 'p', 't')
  const message = withSubagent('settled', 'done')
  await appendMessage('p', 't', message)
  const first = subagentRef(dir)
  await appendMessage('p', 't', { ...message, toolSummary: 'metadata only' })
  assert.equal(subagentRef(dir), first)
  assert.ok(existsSync(join(dir, first, 'events.jsonl')))
  closeThreadStoreIndexes()
  const reloaded = await getProjectThread('p', 't')
  assert.equal(reloaded?.messages[0]?.toolSummary, 'metadata only')
  assert.deepEqual(reloaded.messages[0].toolCalls[0]?.subagent, message.toolCalls[0]?.subagent)
})
