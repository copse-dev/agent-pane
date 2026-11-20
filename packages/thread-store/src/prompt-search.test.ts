import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureThreadStore } from './environment.ts'
import {
  createThread,
  saveProjectThread,
  appendMessage,
  updateMeta,
  deleteProjectThread,
} from './thread-store.ts'
import type { Thread, Message } from './thread-types.ts'
import { PromptSearchIndex } from './prompt-search.ts'

function message(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 1, ...extra }
}
function thread(id: string, messages: Message[]): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages,
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

describe('persistent human prompt search', () => {
  let root: string
  let index: PromptSearchIndex
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-prompt-index-'))
    configureThreadStore({ workspaceRoot: () => root })
    index = new PromptSearchIndex(root)
  })
  afterEach(() => {
    configureThreadStore()
    rmSync(root, { recursive: true, force: true })
  })

  it('indexes only human requests with literal Unicode substring semantics', async () => {
    await createThread(
      'p',
      thread('human', [message('u', 'Fix the Cafe\u0301, a_b% "quote" menu')]),
    )
    await createThread('p', thread('assistant', [message('a', 'café', { role: 'assistant' })]))
    await createThread(
      'p',
      thread('automatic', [
        message('m', 'café', { origin: { kind: 'machine', operationId: 'job' } }),
      ]),
    )
    await createThread(
      'p',
      thread('edited', [
        message('h', 'café', {
          origin: { kind: 'hook', hookId: 'h', event: 'stop' },
          editedByUser: true,
        }),
      ]),
    )
    await createThread('other', thread('foreign', [message('u', 'café')]))
    for (const query of ['CAFÉ', 'fé']) {
      const result = await index.search('p', query)
      assert.equal(result.incomplete, false)
      assert.deepEqual(result.matches.sort(), ['edited', 'human'])
    }
    for (const query of ['a_b%', '"quote"']) {
      assert.deepEqual((await index.search('p', query)).matches, ['human'])
    }
    assert.deepEqual((await index.search('p', 'missing')).matches, [])
  })

  it('reuses prompt text after restart and after an assistant append without rereading it', async () => {
    await createThread('p', thread('t', [message('u', 'a needle')]))
    await index.search('p', '') // background warm-up before a query
    // If either path reads the prompt again it will fail. Restore before cleanup.
    const path = join(root, 'p/t/messages/u.md')
    const raw = readFileSync(path, 'utf8')
    rmSync(path)
    assert.deepEqual(await new PromptSearchIndex(root).search('p', 'needle'), {
      matches: ['t'],
      incomplete: false,
    })
    await appendMessage('p', 't', message('a', 'large tool history', { role: 'assistant' }))
    assert.deepEqual(await index.search('p', 'needle'), { matches: ['t'], incomplete: false })
    writeFileSync(path, raw)
  })

  it('refreshes new requests, edits/truncation, archive/restore and deletion', async () => {
    await createThread('p', thread('t', [message('u', 'old words')]))
    assert.deepEqual((await index.search('p', 'needle')).matches, [])
    await appendMessage('p', 't', message('next', 'a needle'))
    assert.deepEqual((await index.search('p', 'needle')).matches, ['t'])
    await saveProjectThread('p', thread('t', [message('u', 'rewritten')]))
    assert.deepEqual((await index.search('p', 'needle')).matches, [])
    assert.deepEqual((await index.search('p', 'rewritten')).matches, ['t'])
    await updateMeta('p', 't', { archivedAt: 3 })
    assert.deepEqual((await index.search('p', 'rewritten')).matches, [])
    await saveProjectThread('p', thread('t', [message('u', 'restored')]))
    assert.deepEqual((await index.search('p', 'restored')).matches, ['t'])
    await deleteProjectThread('p', 't')
    assert.deepEqual((await index.search('p', 'restored')).matches, [])
  })

  it('rebuilds a corrupt cache from files and excludes unreadable or changing threads', async () => {
    await createThread('p', thread('t', [message('u', 'needle')]))
    writeFileSync(join(root, 'p/.thread-prompt-index.sqlite'), 'broken cache')
    assert.deepEqual(await index.search('p', 'needle'), { matches: ['t'], incomplete: false })
    writeFileSync(join(root, 'p/t/history-edit-transaction.json'), '{}')
    assert.deepEqual(await index.search('p', 'needle'), { matches: [], incomplete: true })
    rmSync(join(root, 'p/t/history-edit-transaction.json'))
    rmSync(join(root, 'p/t/messages/u.md'))
    assert.deepEqual(await index.search('p', 'needle'), { matches: [], incomplete: true })
  })

  it('never follows prompt or cache symlinks outside the project store', async () => {
    await createThread('p', thread('t', [message('u', 'needle')]))
    const prompt = join(root, 'p/t/messages/u.md')
    const outside = join(root, 'outside.md')
    writeFileSync(outside, readFileSync(prompt))
    rmSync(prompt)
    symlinkSync(outside, prompt)
    assert.deepEqual(await index.search('p', 'needle'), { matches: [], incomplete: true })
    const db = join(root, 'p/.thread-prompt-index.sqlite')
    rmSync(db)
    symlinkSync(outside, db)
    await assert.rejects(index.search('p', 'needle'), /Unsafe prompt index path/)
    assert.ok(readFileSync(outside, 'utf8').includes('needle'))
    await assert.rejects(index.search('../escape', 'needle'), /outside/)
  })

  it('stops a superseded backfill between threads', async () => {
    await createThread('p', thread('t', [message('u', 'needle')]))
    assert.deepEqual(await index.search('p', 'needle', () => false), {
      matches: [],
      incomplete: false,
    })
    assert.deepEqual((await index.search('p', 'needle')).matches, ['t'])
  })
})
