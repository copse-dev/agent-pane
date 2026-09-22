import * as fsModule from 'node:fs'
import type { Mode, PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { it } from 'node:test'
import { removeTree } from './remove-tree.ts'

it('treats a read-only directory disappearing during cleanup as removed', async (context) => {
  const root = await fsModule.promises.mkdtemp(join(tmpdir(), 'review-remove-tree-'))
  const cache = join(root, 'cache')
  const moduleDir = join(cache, 'module')
  await fsModule.promises.mkdir(moduleDir, { recursive: true })
  await fsModule.promises.writeFile(join(moduleDir, 'dep.go'), 'package dep')
  await fsModule.promises.chmod(moduleDir, 0o500)
  await fsModule.promises.chmod(cache, 0o500)

  const realChmod = fsModule.promises.chmod
  let intercepted = false
  context.mock.method(fsModule.promises, 'chmod', async (path: PathLike, mode: Mode) => {
    if (String(path) === cache) {
      intercepted = true
      await realChmod(cache, 0o700)
      await realChmod(moduleDir, 0o700)
      await fsModule.promises.rm(cache, { recursive: true, force: true })
      throw Object.assign(new Error('directory disappeared'), { code: 'ENOENT' })
    }
    return realChmod(path, mode)
  })

  try {
    await removeTree(root)
    assert.equal(intercepted, true, 'the regression must exercise lstat-to-chmod disappearance')
    await assert.rejects(fsModule.promises.access(root), /ENOENT/)
  } finally {
    context.mock.restoreAll()
    await fsModule.promises.chmod(cache, 0o700).catch(() => {})
    await fsModule.promises.rm(root, { recursive: true, force: true })
  }
})
