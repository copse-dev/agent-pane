import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTextOrNull } from './read-text-or-null.ts'

describe('readTextOrNull', () => {
  it('returns the file text, including an empty file, and null when it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'std-read-text-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'héllo\n')
      writeFileSync(join(dir, 'empty.txt'), '')
      assert.equal(readTextOrNull(join(dir, 'a.txt')), 'héllo\n')
      assert.equal(readTextOrNull(join(dir, 'empty.txt')), '')
      assert.equal(readTextOrNull(join(dir, 'missing.txt')), null)
      assert.equal(readTextOrNull(dir), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
