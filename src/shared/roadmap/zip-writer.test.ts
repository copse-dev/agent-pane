import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '../array-utils.ts'
import { ZipBuilder } from './zip-writer.ts'

/** Minimal STORE-only zip reader, just enough to assert what ZipBuilder wrote. */
function readZip(bytes: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const entries: { path: string; data: Uint8Array }[] = []
  let offset = 0
  while (offset < bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressionMethod = view.getUint16(offset + 8, true)
    assert.equal(compressionMethod, 0, 'expected store (uncompressed) method')
    const size = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    const data = bytes.slice(dataStart, dataStart + size)
    entries.push({ path, data })
    offset = dataStart + size
  }
  const signature = view.getUint32(offset, true)
  assert.ok(
    signature === 0x02014b50 || signature === 0x06054b50,
    'expected a central directory header or end-of-central-directory record to follow',
  )
  return entries
}

describe('ZipBuilder', () => {
  it('round-trips file contents and paths', () => {
    const zip = new ZipBuilder()
    zip.addFile('roadmap.md', new TextEncoder().encode('# hello'))
    zip.addFile('attachments/item-1/a-note.txt', new TextEncoder().encode('attached'))
    const entries = readZip(zip.build())
    assert.equal(entries.length, 2)
    assert.equal(at(entries, 0).path, 'roadmap.md')
    assert.equal(new TextDecoder().decode(at(entries, 0).data), '# hello')
    assert.equal(at(entries, 1).path, 'attachments/item-1/a-note.txt')
    assert.equal(new TextDecoder().decode(at(entries, 1).data), 'attached')
  })

  it('produces byte-identical output for identical input', () => {
    function build(): Uint8Array {
      const zip = new ZipBuilder()
      zip.addFile('roadmap.md', new TextEncoder().encode('same content'))
      zip.addFile('attachments/item-1/file.bin', new Uint8Array([1, 2, 3, 4]))
      return zip.build()
    }
    assert.deepEqual(Array.from(build()), Array.from(build()))
  })

  it('handles an empty archive', () => {
    const entries = readZip(new ZipBuilder().build())
    assert.equal(entries.length, 0)
  })

  it('rejects unsafe or duplicate paths', () => {
    const zip = new ZipBuilder()
    zip.addFile('ok.txt', new Uint8Array())
    assert.throws(() => {
      zip.addFile('/absolute.txt', new Uint8Array())
    })
    assert.throws(() => {
      zip.addFile('../escape.txt', new Uint8Array())
    })
    assert.throws(() => {
      zip.addFile('back\\slash.txt', new Uint8Array())
    })
    assert.throws(() => {
      zip.addFile('ok.txt', new Uint8Array())
    })
  })
})
