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
