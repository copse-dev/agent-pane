import { it } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyOptionalBinaries } from './copy-optional-binaries.mts'

it('copies an optional binary tree dereferenced, over an older build that left a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copy-optional-binaries-'))
  try {
    // A worktree's vendor dir links into the shared cache; an older build
    // copied that link into dist as a link.
    const cached = join(root, 'cache', 'gortex')
    await mkdir(join(root, 'cache'))
    await writeFile(cached, 'binary\n')
    await mkdir(join(root, 'vendor'))
    await symlink(cached, join(root, 'vendor', 'gortex'))
    const dest = join(root, 'dist', 'gortex')
    await mkdir(dest, { recursive: true })
    await symlink(cached, join(dest, 'gortex'))

    await copyOptionalBinaries(join(root, 'vendor'), join(root, 'vendor', 'gortex'), dest)
    assert.equal((await lstat(join(dest, 'gortex'))).isSymbolicLink(), false)
    assert.equal(await readFile(join(dest, 'gortex'), 'utf8'), 'binary\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('skips a missing optional binary, but fails a copy that cannot complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copy-optional-binaries-'))
  try {
    const dest = join(root, 'dist', 'remote-watcher')
    await copyOptionalBinaries(join(root, 'absent'), join(root, 'absent'), dest)
    await assert.rejects(lstat(dest), /ENOENT/)
    // The source is there, but is a dangling link: the copy fails the build
    // instead of leaving whatever was in dist.
    await mkdir(join(root, 'vendor'))
    await symlink(join(root, 'nowhere'), join(root, 'vendor', 'remote-watcher'))
    await assert.rejects(
      copyOptionalBinaries(join(root, 'vendor'), join(root, 'vendor'), dest),
      /ENOENT/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
