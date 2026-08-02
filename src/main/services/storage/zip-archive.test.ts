import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, inflateRawSync } from 'node:zlib'
import { at } from '@shared/array-utils.ts'
import { createZipArchive } from './zip-archive.ts'

interface ReadEntry {
  path: string
  method: number
  crc: number
  uncompressedSize: number
  data: Buffer
  dosTime: number
  dosDate: number
}

/**
 * Minimal reader used only by these tests: walk the central directory, follow
 * each local header offset, and decode the body. Reading through the central
 * directory (rather than scanning for local signatures) is what real extractors
 * do, so a broken directory fails here the same way it would in `unzip`.
 */
function readZip(archive: Uint8Array): ReadEntry[] {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.length)
  const eocd = buffer.length - 22
  assert.equal(buffer.readUInt32LE(eocd), 0x0605_4b50, 'end-of-central-directory signature')
  const count = buffer.readUInt16LE(eocd + 10)
  assert.equal(buffer.readUInt16LE(eocd + 8), count, 'entries on this disk match the total')
  const centralSize = buffer.readUInt32LE(eocd + 12)
  let cursor = buffer.readUInt32LE(eocd + 16)
  assert.equal(cursor + centralSize, eocd, 'central directory ends where the EOCD begins')
  const entries: ReadEntry[] = []
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x0201_4b50, 'central header signature')
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const path = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength

    assert.equal(buffer.readUInt32LE(localOffset), 0x0403_4b50, 'local header signature')
    assert.equal(buffer.readUInt16LE(localOffset + 6) & 0x0800, 0x0800, 'UTF-8 name flag')
    assert.equal(buffer.readUInt16LE(localOffset + 8), method, 'local method matches central')
    assert.equal(buffer.readUInt32LE(localOffset + 14), crc, 'local CRC matches central')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const extraLength = buffer.readUInt16LE(localOffset + 28)
    assert.equal(
      buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength),
      path,
      'local name matches central',
    )
    const bodyStart = localOffset + 30 + localNameLength + extraLength
    const body = buffer.subarray(bodyStart, bodyStart + compressedSize)
    entries.push({
      path,
      method,
      crc,
      uncompressedSize,
      data: method === 0 ? Buffer.from(body) : inflateRawSync(body),
      dosTime: buffer.readUInt16LE(localOffset + 10),
      dosDate: buffer.readUInt16LE(localOffset + 12),
    })
  }
  return entries
}

const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

describe('createZipArchive', () => {
  it('round-trips entries through the central directory', async () => {
    const modifiedAt = new Date('2026-03-04T05:06:08Z')
    const archive = await createZipArchive([
      { path: 'thread-1/meta.json', data: utf8('{"id":"thread-1"}'), modifiedAt },
      { path: 'thread-1/messages/a.md', data: utf8('hello'.repeat(200)), modifiedAt },
    ])

    const entries = readZip(archive)
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ['thread-1/meta.json', 'thread-1/messages/a.md'],
    )
    assert.equal(at(entries, 0).data.toString('utf8'), '{"id":"thread-1"}')
    assert.equal(at(entries, 1).data.toString('utf8'), 'hello'.repeat(200))
    for (const entry of entries) {
      assert.equal(entry.crc, crc32(entry.data), `CRC for ${entry.path}`)
      assert.equal(entry.uncompressedSize, entry.data.length, `size for ${entry.path}`)
    }
  })

  it('deflates compressible data and stores what deflate would grow', async () => {
    const modifiedAt = new Date('2026-03-04T05:06:08Z')
    // Deflate's block overhead makes a few random-ish bytes bigger than they
    // started; the writer must fall back to storing those verbatim.
    const incompressible = new Uint8Array(Array.from({ length: 8 }, (_value, i) => (i * 97) % 251))
    const archive = await createZipArchive([
      { path: 'repetitive.txt', data: utf8('a'.repeat(4096)), modifiedAt },
      { path: 'tiny.bin', data: incompressible, modifiedAt },
    ])

    const entries = readZip(archive)
    assert.equal(at(entries, 0).method, 8, 'repetitive text is deflated')
    assert.equal(at(entries, 1).method, 0, 'incompressible bytes are stored')
    assert.deepEqual(new Uint8Array(at(entries, 1).data), incompressible)
    assert.ok(archive.length < 4096, 'the deflated archive is far smaller than its input')
  })

  it('writes the modification time as a DOS timestamp, clamped to the format', async () => {
    const archive = await createZipArchive([
      {
        path: 'stamped.txt',
        data: utf8('x'),
        // Local time — DOS timestamps carry no zone, so read it back the same way.
        modifiedAt: new Date(2026, 2, 4, 5, 6, 8),
      },
      { path: 'ancient.txt', data: utf8('x'), modifiedAt: new Date(1970, 0, 1) },
      { path: 'invalid.txt', data: utf8('x'), modifiedAt: new Date(Number.NaN) },
    ])

    const entries = readZip(archive)
    const stamped = at(entries, 0)
    assert.equal(stamped.dosDate, ((2026 - 1980) << 9) | (3 << 5) | 4)
    assert.equal(stamped.dosTime, (5 << 11) | (6 << 5) | 4)
    // Anything the format cannot represent lands on its 1980-01-01 floor.
    for (const index of [1, 2]) {
      assert.equal(
        at(entries, index).dosDate,
        (1 << 5) | 1,
        `clamped date for entry ${String(index)}`,
      )
      assert.equal(at(entries, index).dosTime, 0, `clamped time for entry ${String(index)}`)
    }
  })

  it('writes a valid empty archive', async () => {
    const archive = await createZipArchive([])
    assert.equal(archive.length, 22)
    assert.deepEqual(readZip(archive), [])
  })
})
