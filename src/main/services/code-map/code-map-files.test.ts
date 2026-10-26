import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectProjectFiles } from './code-map-files.ts'
import { invalidateIndex } from '../search/file-index.ts'
import { setRgAvailableForTest } from '../tool-availability.ts'

describe('collectProjectFiles', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-panel-code-map-'))
    // Forces the deterministic no-rg walk fallback (file-index.ts), which also
    // skips node_modules and dotfiles the same way the real walk does.
    setRgAvailableForTest(false)
  })

  afterEach(async () => {
    invalidateIndex(root)
    setRgAvailableForTest(null)
    await rm(root, { recursive: true, force: true })
  })

  it('reads project text files and skips node_modules', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules/dep'), { recursive: true })
    await writeFile(join(root, 'src/main.ts'), 'export const x = 1\n')
    await writeFile(join(root, 'node_modules/dep/index.js'), 'module.exports = {}\n')

    const files = await collectProjectFiles(root)

    assert.deepEqual(
      files.map((f) => f.path),
      ['src/main.ts'],
    )
    assert.equal(files[0]?.content, 'export const x = 1\n')
  })

  it('skips files that look binary', async () => {
    await writeFile(join(root, 'readme.md'), '# hi\n')
    await writeFile(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

    const files = await collectProjectFiles(root)

    assert.deepEqual(
      files.map((f) => f.path),
      ['readme.md'],
    )
  })

  it("orders code before tests and docs, same as blockviz's own ranking", async () => {
    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(join(root, 'tests'), { recursive: true })
    await writeFile(join(root, 'docs/guide.md'), 'guide\n')
    await writeFile(join(root, 'tests/a.test.ts'), 'test\n')
    await writeFile(join(root, 'main.ts'), 'code\n')

    const files = await collectProjectFiles(root)

    assert.deepEqual(
      files.map((f) => f.path),
      ['main.ts', 'tests/a.test.ts', 'docs/guide.md'],
    )
  })
})
