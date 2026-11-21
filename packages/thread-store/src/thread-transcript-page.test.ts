import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThread, readThreadTranscriptPage } from './thread-store.ts'

let root: string
let previous: string | undefined
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copse-transcript-page-'))
  previous = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = root
  await createThread('project', {
    id: 'thread',
    title: 'Conversation',
    status: 'idle',
    createdAt: 1,
    updatedAt: 3,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      { id: 'old', role: 'user', content: 'Old question', toolCalls: [], createdAt: 1 },
      { id: 'question', role: 'user', content: 'Latest question', toolCalls: [], createdAt: 2 },
      {
        id: 'answer',
        role: 'assistant',
        content: 'Latest answer',
        createdAt: 3,
        toolCalls: [
          {
            id: 'tool',
            name: 'read_file',
            args: { path: 'file.txt' },
            status: 'done',
            result: 'x'.repeat(20000),
          },
        ],
      },
    ],
  })
})
afterEach(async () => {
  if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
  else process.env['COPSE_WORKSPACE_DIR'] = previous
  await rm(root, { recursive: true, force: true })
})

it('pages recent prose without hydrating older messages or tool blobs', async () => {
  await rm(join(root, 'project/thread/messages/old.md'))
  await rm(join(root, 'project/thread/blobs'), { recursive: true, force: true })
  const recent = await readThreadTranscriptPage('project', 'thread', { limit: 1, offset: 0 })
  assert.ok(recent)
  assert.ok(recent.messages[0])
  assert.equal(recent.messages[0].content, 'Latest answer')
  assert.deepEqual(recent.messages[0].toolCalls, [{ name: 'read_file', status: 'done' }])
  assert.equal(recent.totalMessages, 3)
  assert.equal(recent.nextOffset, 1)
  const older = await readThreadTranscriptPage('project', 'thread', {
    limit: 1,
    offset: recent.nextOffset,
  })
  assert.ok(older)
  assert.equal(older.messages[0]?.content, 'Latest question')
  assert.equal(older.nextOffset, 2)
  const empty = await readThreadTranscriptPage('project', 'thread', { limit: 1, offset: 3 })
  assert.ok(empty)
  assert.deepEqual(empty.messages, [])
  assert.equal(empty.nextOffset, null)
})

it('returns chronological pages and explicitly marks truncated message bodies', async () => {
  await createThread('project', {
    id: 'long',
    title: 'Long answer',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      {
        id: 'long-answer',
        role: 'assistant',
        content: 'a'.repeat(5000),
        toolCalls: [],
        createdAt: 1,
      },
    ],
  })
  const page = await readThreadTranscriptPage('project', 'thread', { limit: 2, offset: 0 })
  assert.deepEqual(
    page?.messages.map((message) => message.id),
    ['question', 'answer'],
  )
  const long = await readThreadTranscriptPage('project', 'long', { limit: 1, offset: 0 })
  assert.ok(long)
  assert.ok(long.messages[0])
  assert.equal(long.messages[0].content.length, 4000)
  assert.equal(long.messages[0].contentTruncated, true)
  assert.ok(long.messages[0].contentPath?.endsWith('/messages/long-answer.md'))
})

it('does not return tampered content or follow a message symlink', async () => {
  const message = join(root, 'project/thread/messages/answer.md')
  const original = await readFile(message, 'utf8')
  await writeFile(message, original.replace('Latest answer', 'Forged answer'))
  const changed = await readThreadTranscriptPage('project', 'thread', { limit: 1, offset: 0 })
  assert.ok(changed)
  assert.ok(changed.messages[0])
  assert.equal(changed.messages[0].unavailable, true)
  assert.doesNotMatch(changed.messages[0].content, /Forged answer/)
  await writeFile(join(root, 'private.txt'), original)
  await rm(message)
  await symlink(join(root, 'private.txt'), message)
  const linked = await readThreadTranscriptPage('project', 'thread', { limit: 1, offset: 0 })
  assert.ok(linked)
  assert.ok(linked.messages[0])
  assert.equal(linked.messages[0].unavailable, true)
  assert.doesNotMatch(linked.messages[0].content, /Latest answer/)
})

it('rejects escaping thread ids and invalid page bounds', async () => {
  await assert.rejects(
    readThreadTranscriptPage('project', '../other', { limit: 1, offset: 0 }),
    /outside/,
  )
  assert.throws(
    () => readThreadTranscriptPage('project', 'thread', { limit: 21, offset: 0 }),
    /limit/,
  )
  assert.throws(
    () => readThreadTranscriptPage('project', 'thread', { limit: 1, offset: -1 }),
    /offset/,
  )
})

it('retains a failed budget outcome independently of idle status and positive partial prose', async () => {
  await createThread('project', {
    id: 'budget-review',
    title: 'Review checkpoint',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    usage: { inputTokens: 0, outputTokens: 0 },
    messages: [
      {
        id: 'partial-review',
        role: 'assistant',
        createdAt: 1,
        content: 'The checks inspected so far were green.',
        toolCalls: [],
        turnOutcome: {
          status: 'failed',
          stopReason: 'max_steps',
          source: 'host',
          executor: 'local',
          provider: 'fixture',
          model: 'fixture',
          endedAt: 2,
        },
      },
    ],
  })
  const page = await readThreadTranscriptPage('project', 'budget-review', { limit: 1, offset: 0 })
  assert.ok(page)
  assert.ok(page.messages[0])
  assert.equal(page.status, 'idle')
  assert.match(page.messages[0].content, /green/)
  assert.deepEqual(page.messages[0].turnOutcome, { status: 'failed', stopReason: 'max_steps' })
  const legacy = await readThreadTranscriptPage('project', 'thread', { limit: 1, offset: 0 })
  assert.equal(legacy?.messages[0]?.turnOutcome, null)
})
