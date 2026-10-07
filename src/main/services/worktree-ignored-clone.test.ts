import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cloneIgnoredEntries,
  isSecretLikePath,
  selectIgnoredCloneEntries,
} from './worktree-ignored-clone.ts'

async function canReflink(dir: string): Promise<boolean> {
  await writeFile(join(dir, 'probe-src'), 'x')
  try {
    await copyFile(join(dir, 'probe-src'), join(dir, 'probe-dst'), constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  }
}

describe('selectIgnoredCloneEntries', () => {
  it('keeps collapsed directories and drops secrets, git internals, and escapes', () => {
    const listing = [
      'node_modules/',
      'dist/',
      '.env',
      '.env.local',
      'config/.env.production',
      'keys/server.pem',
      '.ssh/',
      '.worktrees/',
      '../outside',
      '/abs',
      'notes.local.md',
    ].join('\0')
    assert.deepEqual(selectIgnoredCloneEntries(listing), ['node_modules', 'dist', 'notes.local.md'])
  })

  it('flags secret-like names in any segment', () => {
    assert.equal(isSecretLikePath('a/.aws/config'), true)
    assert.equal(isSecretLikePath('id_ed25519'), true)
    assert.equal(isSecretLikePath('src/environment.ts'), false)
  })
})

describe('cloneIgnoredEntries', () => {
  it('clones when the filesystem can reflink, and leaves nothing behind when it cannot', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'copse-ignored-clone-'))
    try {
      const project = join(temp, 'project')
      const worktree = join(temp, 'worktree')
      await mkdir(join(project, 'node_modules', 'pkg'), { recursive: true })
      await mkdir(worktree, { recursive: true })
      await writeFile(join(project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
      await symlink('pkg/index.js', join(project, 'node_modules', 'link.js'))
      await symlink('/etc/hosts', join(project, 'node_modules', 'absolute.js'))
      await symlink('../../outside', join(project, 'node_modules', 'escape.js'))
      const supported = await canReflink(temp)

      const result = await cloneIgnoredEntries({
        projectRoot: project,
        worktreeRoot: worktree,
        listing: 'node_modules/\0',
      })

      if (supported) {
        assert.deepEqual(result, { cloned: ['node_modules'], unsupported: false })
        assert.equal(
          await readFile(join(worktree, 'node_modules', 'pkg', 'index.js'), 'utf8'),
          'module.exports = 1\n',
        )
        assert.ok((await lstat(join(worktree, 'node_modules', 'link.js'))).isSymbolicLink())
        await assert.rejects(lstat(join(worktree, 'node_modules', 'absolute.js')))
        await assert.rejects(lstat(join(worktree, 'node_modules', 'escape.js')))
      } else {
        assert.equal(result.unsupported, true)
        assert.deepEqual(result.cloned, [])
        await assert.rejects(lstat(join(worktree, 'node_modules')))
      }
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('never overwrites an entry the worktree already has', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'copse-ignored-clone-'))
    try {
      const project = join(temp, 'project')
      const worktree = join(temp, 'worktree')
      await mkdir(project, { recursive: true })
      await mkdir(worktree, { recursive: true })
      await writeFile(join(project, 'cache.bin'), 'project')
      await writeFile(join(worktree, 'cache.bin'), 'worktree')
      const result = await cloneIgnoredEntries({
        projectRoot: project,
        worktreeRoot: worktree,
        listing: 'cache.bin\0',
      })
      assert.deepEqual(result.cloned, [])
      assert.equal(await readFile(join(worktree, 'cache.bin'), 'utf8'), 'worktree')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})
