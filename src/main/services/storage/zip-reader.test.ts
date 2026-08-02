import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { createZipArchive } from './zip-archive.ts'
import { isUnsafeEntryPath, readZipDirectory, readZipEntry } from './zip-reader.ts'

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))
const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8')

const MODIFIED = new Date(2026, 2, 4, 5, 6, 8)

function archive(files: Record<string, string>): Promise<Uint8Array> {
  return createZipArchive(
    Object.entries(files).map(([path, body]) => ({
      path,
      data: utf8(body),
      modifiedAt: MODIFIED,
    })),
  )
}

/** Flip one byte of an entry's body, leaving its stored CRC claiming otherwise. */
function corruptBody(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes)
  // The first local header is 30 bytes plus the name; the body starts after it.
  const body = 30 + Buffer.from(copy.buffer, copy.byteOffset).readUInt16LE(26)
  copy[body] = (copy[body] ?? 0) ^ 0xff
  return copy
}

describe('readZipDirectory', () => {
  it('round-trips what the writer produced', async () => {
    const bytes = await archive({
      'meta.json': '{"id":"t1"}',
      'messages/u1.md': 'hello '.repeat(200),
    })

    const entries = readZipDirectory(bytes)
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ['meta.json', 'messages/u1.md'],
    )
    assert.equal(decode(await readZipEntry(bytes, at(entries, 0))), '{"id":"t1"}')
    assert.equal(decode(await readZipEntry(bytes, at(entries, 1))), 'hello '.repeat(200))
    assert.equal(at(entries, 0).isDirectory, false)
    assert.equal(at(entries, 0).isSymlink, false)
    assert.deepEqual(at(entries, 0).modifiedAt, MODIFIED)
  })

  it('reads an entry the writer stored rather than deflated', async () => {
    // 8 pseudo-random bytes grow under deflate, so the writer stores them.
    const raw = new Uint8Array(Array.from({ length: 8 }, (_value, i) => (i * 97) % 251))
    const bytes = await createZipArchive([{ path: 'blob.bin', data: raw, modifiedAt: MODIFIED }])
    const entry = at(readZipDirectory(bytes), 0)
    assert.equal(entry.method, 0)
    assert.deepEqual(new Uint8Array(await readZipEntry(bytes, entry)), raw)
  })

  it('recognises directory entries by their trailing slash', async () => {
    const bytes = await createZipArchive([
      { path: 'nested/', data: new Uint8Array(), modifiedAt: MODIFIED },
      { path: 'nested/file.txt', data: utf8('x'), modifiedAt: MODIFIED },
    ])
    const entries = readZipDirectory(bytes)
    assert.equal(at(entries, 0).isDirectory, true)
    assert.equal(at(entries, 1).isDirectory, false)
  })

  it('rejects anything that is not a zip', () => {
    assert.throws(
      () => readZipDirectory(utf8('not a zip at all, just some text')),
      /Not a zip file/,
    )
    assert.throws(() => readZipDirectory(new Uint8Array(4)), /Not a zip file/)
  })

  it('reports a checksum mismatch rather than returning corrupt bytes', async () => {
    // A stored entry inflates trivially, so a flipped byte reaches the CRC
    // check rather than failing inside zlib first.
    const raw = new Uint8Array(Array.from({ length: 8 }, (_value, i) => (i * 97) % 251))
    const bytes = corruptBody(
      await createZipArchive([{ path: 'blob.bin', data: raw, modifiedAt: MODIFIED }]),
    )
    const entry = at(readZipDirectory(bytes), 0)
    await assert.rejects(readZipEntry(bytes, entry), /failed its checksum/)
  })

  it('names the entry when a deflated body will not inflate', async () => {
    const bytes = corruptBody(await archive({ 'a.txt': 'a'.repeat(4096) }))
    const entry = at(readZipDirectory(bytes), 0)
    await assert.rejects(readZipEntry(bytes, entry), /a\.txt could not be decompressed/)
  })
})

describe('isUnsafeEntryPath', () => {
  it('accepts ordinary relative entry names', () => {
    for (const path of ['a.txt', 'nested/a.txt', 'a..b/c.txt', 'dots.../x', '.hidden']) {
      assert.equal(isUnsafeEntryPath(path), false, path)
    }
  })

  it('rejects traversal, absolute, drive-relative and backslash names', () => {
    for (const path of [
      '../escape.txt',
      'nested/../../escape.txt',
      '/etc/passwd',
      '\\\\server\\share',
      'C:/Windows/system32',
      'c:secret',
      'nested\\..\\..\\escape.txt',
      '',
      'a\0b',
    ]) {
      assert.equal(isUnsafeEntryPath(path), true, JSON.stringify(path))
    }
  })
})
