import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@shared/types'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { parseSpineEntries } from '@copse/thread-store/spine-schema.ts'
import {
  appendMessage,
  closeThreadStoreIndexes,
  getProjectThread,
  saveProjectThread,
} from './thread-store.ts'

let root = ''
const original: Message = {
  id: 'saved',
  role: 'assistant',
  content: 'Original prose',
  reasoning: 'Original reasoning',
  toolCalls: [],
  createdAt: 1,
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copse-prose-atomicity-'))
  configureThreadStore({ workspaceRoot: () => root })
})
afterEach(() => {
  closeThreadStoreIndexes()
  configureThreadStore()
  rmSync(root, { recursive: true, force: true })
})
async function seed(role: 'user' | 'assistant'): Promise<Message> {
  const message = { ...original, role }
  await saveProjectThread('p', {
    id: 't',
    title: 'Atomic prose',
    status: 'idle',
    messages: [message],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  })
  return message
}

for (const role of ['user', 'assistant'] as const) {
  test(`a failed spine replacement preserves the old ${role} prose and reasoning on reload`, async () => {
    const message = await seed(role)
    const dir = join(root, 'p', 't')
    const events = join(dir, 'events.jsonl')
    const before = readFileSync(events, 'utf8')
    const body = readFileSync(join(dir, 'messages/saved.md'), 'utf8')
    const reasoning = readFileSync(join(dir, 'messages/saved.reasoning.md'), 'utf8')
    const realRename = fsPromises.rename
    let failures = 0
    const rename = mock.method(
      fsPromises,
      'rename',
      async (...args: Parameters<typeof realRename>): ReturnType<typeof realRename> => {
        if (String(args[1]) === events) {
          failures++
          throw new Error('simulated prose spine failure')
        }
        return realRename(...args)
      },
    )
    try {
      await assert.rejects(
        appendMessage('p', 't', {
          ...message,
          content: 'Reviewed replacement',
          reasoning: 'New reasoning',
        }),
        /simulated prose spine failure/,
      )
    } finally {
      rename.mock.restore()
    }
    assert.equal(failures, 1)
    assert.equal(readFileSync(events, 'utf8'), before)
    assert.equal(readFileSync(join(dir, 'messages/saved.md'), 'utf8'), body)
    assert.equal(readFileSync(join(dir, 'messages/saved.reasoning.md'), 'utf8'), reasoning)
    closeThreadStoreIndexes()
    const reloaded = await getProjectThread('p', 't')
    assert.equal(reloaded?.messages[0]?.content, message.content)
    assert.equal(reloaded.messages[0].reasoning, message.reasoning)
  })
}

test('successful replacement commits fresh prose references and leaves the previous revision intact', async () => {
  const message = await seed('assistant')
  const dir = join(root, 'p', 't')
  const body = readFileSync(join(dir, 'messages/saved.md'), 'utf8')
  const reasoning = readFileSync(join(dir, 'messages/saved.reasoning.md'), 'utf8')
  await appendMessage('p', 't', {
    ...message,
    content: 'Committed prose',
    reasoning: 'Committed reasoning',
  })
  closeThreadStoreIndexes()
  const reloaded = await getProjectThread('p', 't')
  assert.equal(reloaded?.messages[0]?.content, 'Committed prose')
  assert.equal(reloaded.messages[0].reasoning, 'Committed reasoning')
  assert.equal(readFileSync(join(dir, 'messages/saved.md'), 'utf8'), body)
  assert.equal(readFileSync(join(dir, 'messages/saved.reasoning.md'), 'utf8'), reasoning)
  const line = parseSpineEntries(readFileSync(join(dir, 'events.jsonl'), 'utf8')).find(
    (entry) => entry.line?.type === 'message',
  )?.line
  assert.ok(line?.type === 'message')
  assert.notEqual(line.content.ref, 'messages/saved.md')
  assert.notEqual(line.reasoning?.ref, 'messages/saved.reasoning.md')
})

test('repeated metadata finalization reuses the same complete prose revision', async () => {
  const message = await seed('assistant')
  const events = join(root, 'p', 't', 'events.jsonl')
  await appendMessage('p', 't', { ...message, toolSummary: 'First metadata update' })
  const first = parseSpineEntries(readFileSync(events, 'utf8')).find(
    (entry) => entry.line?.type === 'message',
  )?.line
  assert.ok(first?.type === 'message')
  await appendMessage('p', 't', { ...message, toolSummary: 'Final metadata update' })
  const second = parseSpineEntries(readFileSync(events, 'utf8')).find(
    (entry) => entry.line?.type === 'message',
  )?.line
  assert.ok(second?.type === 'message')
  assert.deepEqual(second.content, first.content)
  assert.deepEqual(second.reasoning, first.reasoning)
  assert.equal(
    (await getProjectThread('p', 't'))?.messages[0]?.toolSummary,
    'Final metadata update',
  )
})

test('a failed spine replacement preserves rich blocks, images and attachment snapshots on reload', async () => {
  // Each of these files is hash-checked on load, and a mismatch skips the
  // whole thread. An ACP upsert re-finalises them together with the prose.
  const rich: Message = {
    ...original,
    contentBlocks: [
      { type: 'resource_link', uri: 'https://example.test/old', name: 'old', title: 'Old' },
    ],
    reasoningBlocks: [{ type: 'text', text: 'Old reasoning block' }],
    images: ['data:image/png;base64,T0xE'],
    attachments: [{ kind: 'paste', label: 'notes', content: 'Old snapshot' }],
  }
  await saveProjectThread('p', {
    id: 't',
    title: 'Atomic rich message',
    status: 'idle',
    messages: [rich],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  })
  const events = join(root, 'p', 't', 'events.jsonl')
  const before = readFileSync(events, 'utf8')
  const realRename = fsPromises.rename
  const rename = mock.method(
    fsPromises,
    'rename',
    async (...args: Parameters<typeof realRename>): ReturnType<typeof realRename> => {
      if (String(args[1]) === events) throw new Error('simulated rich spine failure')
      return realRename(...args)
    },
  )
  const replacement: Message = {
    ...rich,
    content: 'New prose',
    contentBlocks: [
      { type: 'resource_link', uri: 'https://example.test/new', name: 'new', title: 'New' },
    ],
    reasoningBlocks: [{ type: 'text', text: 'New reasoning block' }],
    images: ['data:image/png;base64,TkVX'],
    attachments: [{ kind: 'paste', label: 'notes', content: 'New snapshot' }],
  }
  try {
    await assert.rejects(appendMessage('p', 't', replacement), /simulated rich spine failure/)
  } finally {
    rename.mock.restore()
  }
  assert.equal(readFileSync(events, 'utf8'), before)
  closeThreadStoreIndexes()
  const reloaded = (await getProjectThread('p', 't'))?.messages[0]
  assert.equal(reloaded?.content, rich.content)
  assert.deepEqual(reloaded.contentBlocks, rich.contentBlocks)
  assert.deepEqual(reloaded.reasoningBlocks, rich.reasoningBlocks)
  assert.deepEqual(reloaded.images, rich.images)
  assert.deepEqual(reloaded.attachments, rich.attachments)

  // Retry succeeds and loads the new files.
  await appendMessage('p', 't', replacement)
  closeThreadStoreIndexes()
  const retried = (await getProjectThread('p', 't'))?.messages[0]
  assert.equal(retried?.content, replacement.content)
  assert.deepEqual(retried.contentBlocks, replacement.contentBlocks)
  assert.deepEqual(retried.reasoningBlocks, replacement.reasoningBlocks)
  assert.deepEqual(retried.images, replacement.images)
  assert.deepEqual(retried.attachments, replacement.attachments)
})

test('a message whose id looks like a revision name cannot overwrite one', async () => {
  const message = await seed('assistant')
  await appendMessage('p', 't', { ...message, content: 'Replaced prose' })
  const events = join(root, 'p', 't', 'events.jsonl')
  const line = parseSpineEntries(readFileSync(events, 'utf8')).find(
    (entry) => entry.line?.type === 'message',
  )?.line
  assert.ok(line?.type === 'message')
  const revisionName = /^messages\/(.+)\.md$/.exec(line.content.ref)?.[1]
  assert.ok(revisionName)
  // The plain id spelled like the revision file, with or without its prefix.
  for (const id of [revisionName, revisionName.replace(/^~/, '')]) {
    await appendMessage('p', 't', { ...original, id, content: `Message ${id}`, createdAt: 2 })
  }
  closeThreadStoreIndexes()
  const reloaded = await getProjectThread('p', 't')
  assert.equal(reloaded?.messages[0]?.content, 'Replaced prose')
  assert.equal(reloaded.messages.length, 3)
})
