import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  promises as fsPromises,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@shared/types'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { parseSpineEntries, type SpineMessageLine } from '@copse/thread-store/spine-schema.ts'
import {
  appendMessage,
  backfillThreadPrRefs,
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
function messageLine(dir: string): SpineMessageLine {
  const line = parseSpineEntries(readFileSync(join(dir, 'events.jsonl'), 'utf8')).find(
    (entry) => entry.line?.type === 'message',
  )?.line
  assert.ok(line?.type === 'message')
  return line
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

test('successful replacement commits fresh prose references and removes the superseded files', async () => {
  const message = await seed('assistant')
  const dir = join(root, 'p', 't')
  await appendMessage('p', 't', {
    ...message,
    content: 'Committed prose',
    reasoning: 'Committed reasoning',
  })
  closeThreadStoreIndexes()
  const reloaded = await getProjectThread('p', 't')
  assert.equal(reloaded?.messages[0]?.content, 'Committed prose')
  assert.equal(reloaded.messages[0].reasoning, 'Committed reasoning')
  const line = messageLine(dir)
  assert.notEqual(line.content.ref, 'messages/saved.md')
  assert.notEqual(line.reasoning?.ref, 'messages/saved.reasoning.md')
  // The original files go once the new line has committed.
  assert.equal(existsSync(join(dir, 'messages/saved.md')), false)
  assert.equal(existsSync(join(dir, 'messages/saved.reasoning.md')), false)
  assert.deepEqual(
    readdirSync(join(dir, 'messages'))
      .map((name) => `messages/${name}`)
      .sort(),
    [line.content.ref, line.reasoning?.ref].sort(),
  )
})

test('100 re-finalisations of a growing message leave only the files its line references', async () => {
  // The transcript writer re-finalises a message on every settled tool call.
  const message = await seed('assistant')
  const dir = join(root, 'p', 't')
  let content = ''
  for (let round = 1; round <= 100; round++) {
    content += `${'x'.repeat(1023)}\n`
    await appendMessage('p', 't', { ...message, content, reasoning: `Reasoning ${String(round)}` })
  }
  const line = messageLine(dir)
  const files = readdirSync(join(dir, 'messages'))
  assert.deepEqual(
    files.map((name) => `messages/${name}`).sort(),
    [line.content.ref, line.reasoning?.ref].sort(),
  )
  const bytes = files.reduce((sum, name) => sum + statSync(join(dir, 'messages', name)).size, 0)
  assert.ok(bytes < 2 * content.length, `messages/ holds ${String(bytes)} bytes`)
  closeThreadStoreIndexes()
  const reloaded = (await getProjectThread('p', 't'))?.messages[0]
  assert.equal(reloaded?.content, content)
  assert.equal(reloaded.reasoning, 'Reasoning 100')
})

test('a superseded file that cannot be removed is logged and the replacement still commits', async () => {
  const message = await seed('assistant')
  const dir = join(root, 'p', 't')
  const unlink = mock.method(fsPromises, 'unlink', async (): Promise<void> => {
    throw Object.assign(new Error('simulated unlink failure'), { code: 'EACCES' })
  })
  const warn = mock.method(console, 'warn', () => undefined)
  try {
    await appendMessage('p', 't', { ...message, content: 'Kept despite cleanup' })
  } finally {
    unlink.mock.restore()
    warn.mock.restore()
  }
  assert.ok(unlink.mock.callCount() > 0)
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('messages/saved.md')))
  assert.ok(existsSync(join(dir, 'messages/saved.md')))
  closeThreadStoreIndexes()
  assert.equal((await getProjectThread('p', 't'))?.messages[0]?.content, 'Kept despite cleanup')
})

test('a transcript read that took the spine before a replacement retries against the new line', async () => {
  // The PR-ref backfill reads transcripts outside the store queue, so a
  // replacement can commit and remove the old prose between its two reads.
  const message = await seed('assistant')
  const oldProse = join(root, 'p', 't', 'messages/saved.md')
  const realOpen = fsPromises.open
  let reachedOldProse = (): void => undefined
  const atOldProse = new Promise<void>((resolve) => {
    reachedOldProse = resolve
  })
  let releaseRead = (): void => undefined
  const released = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  let held = false
  const open = mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof realOpen>): ReturnType<typeof realOpen> => {
      if (!held && String(args[0]) === oldProse) {
        held = true
        reachedOldProse()
        await released
      }
      return realOpen(...args)
    },
  )
  const scanned: string[] = []
  try {
    const backfill = backfillThreadPrRefs('p', ['t'], (refs) => {
      scanned.push(...refs.map((entry) => entry.threadId))
    })
    await atOldProse
    await appendMessage('p', 't', { ...message, content: 'Replaced during the read' })
    assert.equal(existsSync(oldProse), false)
    releaseRead()
    await backfill
  } finally {
    releaseRead()
    open.mock.restore()
  }
  assert.deepEqual(scanned, ['t'])
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
