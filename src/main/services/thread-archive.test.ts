import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { Message, Thread } from '@shared/types'
import { buildThreadArchive } from './thread-archive.ts'
import { saveProjectThread } from './thread-store.ts'

/** Decode an archive into `path → contents`, following the central directory. */
function readZipEntries(archive: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.length)
  const eocd = buffer.length - 22
  assert.equal(buffer.readUInt32LE(eocd), 0x0605_4b50, 'end-of-central-directory signature')
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = new Map<string, string>()
  for (let index = 0; index < count; index += 1) {
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength
    const bodyStart =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28)
    const body = buffer.subarray(bodyStart, bodyStart + compressedSize)
    entries.set(path, (method === 0 ? body : inflateRawSync(body)).toString('utf8'))
  }
  return entries
}

function userMsg(id: string, content: string): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 10 }
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

describe('buildThreadArchive', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-thread-archive-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('zips the whole thread directory under a folder named for the thread', async () => {
    await saveProjectThread('p1', thread('t1', [userMsg('u1', 'hello world')]))
    // A nested subagent session: the archive must recurse, not just take the top level.
    mkdirSync(join(root, 'p1', 't1', 'subagents', 's1'), { recursive: true })
    writeFileSync(join(root, 'p1', 't1', 'subagents', 's1', 'meta.json'), '{"id":"s1"}')

    const entries = readZipEntries(await buildThreadArchive('p1', 't1'))

    assert.deepEqual(
      [...entries.keys()].sort(),
      ['t1/events.jsonl', 't1/messages/u1.md', 't1/meta.json', 't1/subagents/s1/meta.json'].sort(),
    )
    assert.match(entries.get('t1/messages/u1.md') ?? '', /hello world/)
    assert.equal(entries.get('t1/subagents/s1/meta.json'), '{"id":"s1"}')
    assert.match(entries.get('t1/meta.json') ?? '', /"title":"t1"/)
  })

  it('leaves other threads in the project out of the archive', async () => {
    await saveProjectThread('p1', thread('t1', [userMsg('u1', 'mine')]))
    await saveProjectThread('p1', thread('t2', [userMsg('u2', 'not mine')]))

    const entries = readZipEntries(await buildThreadArchive('p1', 't1'))

    assert.ok(entries.has('t1/meta.json'))
    assert.equal(
      [...entries.keys()].filter((path) => !path.startsWith('t1/')).length,
      0,
      'every entry belongs to the exported thread',
    )
  })

  it('skips symlinks rather than following them out of the store', async () => {
    await saveProjectThread('p1', thread('t1', [userMsg('u1', 'hello')]))
    const secret = join(root, 'outside.txt')
    writeFileSync(secret, 'not part of the thread')
    symlinkSync(secret, join(root, 'p1', 't1', 'escape.txt'))

    const entries = readZipEntries(await buildThreadArchive('p1', 't1'))

    assert.equal(entries.has('t1/escape.txt'), false)
  })

  it('rejects a thread that has no directory in the store', async () => {
    await assert.rejects(buildThreadArchive('p1', 'missing'), /No stored thread directory/)
  })
})
