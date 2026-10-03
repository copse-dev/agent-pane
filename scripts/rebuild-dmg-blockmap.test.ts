import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { loadBuildBlockMap, rebuildDmgBlockmap } from './rebuild-dmg-blockmap.mts'

interface BlockMapFile {
  name: string
  offset: number
  checksums: string[]
  sizes: number[]
}

function readBlockMap(path: string): BlockMapFile {
  const parsed: unknown = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
  assert.ok(typeof parsed === 'object' && parsed !== null && 'files' in parsed)
  const files: unknown = parsed.files
  assert.ok(Array.isArray(files) && files.length === 1)
  const file: unknown = files[0]
  assert.ok(
    typeof file === 'object' &&
      file !== null &&
      'name' in file &&
      typeof file.name === 'string' &&
      'offset' in file &&
      typeof file.offset === 'number' &&
      'checksums' in file &&
      Array.isArray(file.checksums) &&
      file.checksums.every((checksum) => typeof checksum === 'string') &&
      'sizes' in file &&
      Array.isArray(file.sizes) &&
      file.sizes.every((size) => typeof size === 'number'),
  )
  return { name: file.name, offset: file.offset, checksums: file.checksums, sizes: file.sizes }
}

describe('rebuildDmgBlockmap', () => {
  it('writes a gzip blockmap that covers the DMG as it is now', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copse-dmg-blockmap-'))
    try {
      const dmg = join(dir, 'Copse-1.0.0-arm64.dmg')
      writeFileSync(dmg, randomBytes(256 * 1024))
      const blockmap = await rebuildDmgBlockmap(dmg)
      assert.equal(blockmap, `${dmg}.blockmap`)
      const before = readBlockMap(blockmap)
      assert.equal(
        before.sizes.reduce((sum, size) => sum + size, 0),
        statSync(dmg).size,
      )

      // Stapling appends a ticket to the image; the rebuilt map must follow.
      appendFileSync(dmg, randomBytes(4096))
      await rebuildDmgBlockmap(dmg)
      const after = readBlockMap(blockmap)
      assert.equal(
        after.sizes.reduce((sum, size) => sum + size, 0),
        statSync(dmg).size,
      )
      assert.notDeepEqual(after.checksums, before.checksums)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses anything but a DMG', async () => {
    await assert.rejects(rebuildDmgBlockmap('release/Copse-1.0.0-arm64.zip'), /Not a DMG/)
  })

  it('reaches electron-builder’s own block-map builder', () => {
    assert.equal(typeof loadBuildBlockMap(), 'function')
  })
})
