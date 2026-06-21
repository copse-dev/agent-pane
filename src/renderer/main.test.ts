import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('main layout boot', () => {
  it('syncs files pane visibility when the layout mounts', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/main.ts'), 'utf8')
    assert.match(src, /store\.on\('files_pane_changed', updateFilesPane\)/)
    assert.match(src, /mountFullLayout\(\)[\s\S]*updateFilesPane\(\)/)
    assert.match(
      src,
      /store\.on\('files_pane_changed', updateFilesPane\)[\s\S]*updateFilesPane\(\)/,
    )
  })
})
