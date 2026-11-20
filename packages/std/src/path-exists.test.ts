import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathExists } from './path-exists.ts'

describe('pathExists', () => {
  it('reports files and directories, follows symlinks, and treats a dangling link as absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'std-path-exists-'))
    try {
      const file = join(dir, 'file.txt')
      await writeFile(file, 'x')
      await symlink(file, join(dir, 'live-link'))
      await symlink(join(dir, 'gone'), join(dir, 'dangling-link'))

      assert.equal(await pathExists(dir), true)
      assert.equal(await pathExists(file), true)
      assert.equal(await pathExists(join(dir, 'live-link')), true)
      assert.equal(await pathExists(join(dir, 'dangling-link')), false)
      assert.equal(await pathExists(join(dir, 'missing')), false)
      assert.equal(await pathExists(join(file, 'not-a-dir-child')), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
