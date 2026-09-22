import * as fsModule from 'node:fs'
import type { Mode, PathLike, RmOptions } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { it } from 'node:test'
import { removeTree } from './remove-tree.ts'

const fs = fsModule.promises

/**
 * Shape the real Go fixture that broke review-ground cleanup in #2945: Go marks
 * everything it extracts into the module cache read-only, so the leaf file
 * cannot be unlinked until its parent directory is writable again.
 */
async function writeReadOnlyModuleCache(owned: string): Promise<string> {
  const moduleDir = join(owned, 'author-cache', 'example.test', 'dep@v1.0.0')
  await fs.mkdir(moduleDir, { recursive: true })
  await fs.writeFile(join(moduleDir, 'dep.go'), 'package dep')
  await fs.chmod(join(moduleDir, 'dep.go'), 0o400)
  // Bottom-up: a parent must stay writable long enough to chmod its children.
  await fs.chmod(moduleDir, 0o500)
  await fs.chmod(join(owned, 'author-cache', 'example.test'), 0o500)
  await fs.chmod(join(owned, 'author-cache'), 0o500)
  return moduleDir
}

/**
 * Force the read-only recovery path independently of who runs the suite. Root
 * bypasses the permission bits entirely, so the first `rm` succeeds there and
 * `makeDirectoriesWritable` never runs — a test that relied on a real EACCES
 * would quietly assert nothing in a privileged container while still passing.
 */
function failFirstRemovalOf(context: TestContext, target: string): () => boolean {
  const realRm = fs.rm
  let failed = false
  context.mock.method(fs, 'rm', async (path: PathLike, options?: RmOptions) => {
    if (!failed && String(path) === target) {
      failed = true
      throw Object.assign(new Error('permission denied, unlink'), { code: 'EACCES' })
    }
    return realRm(path, options)
  })
  return () => failed
}

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
  // Without this the case is silently skipped wherever the suite runs as root:
  // the permission bits above stop nothing, the first `rm` succeeds, and the
  // chmod interception this test exists to drive is never reached.
  const attemptedReadOnlyRecovery = failFirstRemovalOf(context, root)

  try {
    await removeTree(root)
    assert.equal(attemptedReadOnlyRecovery(), true, 'the first removal must have failed EACCES')
    assert.equal(intercepted, true, 'the regression must exercise lstat-to-chmod disappearance')
    await assert.rejects(fsModule.promises.access(root), /ENOENT/)
  } finally {
    context.mock.restoreAll()
    await fsModule.promises.chmod(cache, 0o700).catch(() => {})
    await fsModule.promises.rm(root, { recursive: true, force: true })
  }
})

it('removes a read-only Go module cache left inside the owned tree', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-remove-tree-go-'))
  const owned = join(root, 'copse-review-cell')
  await fs.mkdir(owned, { recursive: true })
  const moduleDir = await writeReadOnlyModuleCache(owned)
  const attemptedReadOnlyRecovery = failFirstRemovalOf(context, owned)

  try {
    await removeTree(owned)
    assert.equal(attemptedReadOnlyRecovery(), true, 'the first removal must have failed EACCES')
    await assert.rejects(fs.access(moduleDir), /ENOENT/, 'the read-only cache must be gone')
    await assert.rejects(fs.access(owned), /ENOENT/, 'the owned cell must be gone')
  } finally {
    context.mock.restoreAll()
    await removeTree(root).catch(() => {})
  }
})

it('confines permission repair to the owned tree', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-remove-tree-scope-'))
  const owned = join(root, 'copse-review-cell')
  const outside = join(root, 'outside')
  await fs.mkdir(owned, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(join(outside, 'sentinel.txt'), 'must survive')
  await writeReadOnlyModuleCache(owned)
  await fs.chmod(outside, 0o500)
  const outsideMode = (await fs.lstat(outside)).mode

  const realChmod = fs.chmod
  const repaired: string[] = []
  context.mock.method(fs, 'chmod', async (path: PathLike, mode: Mode) => {
    repaired.push(String(path))
    return realChmod(path, mode)
  })
  const attemptedReadOnlyRecovery = failFirstRemovalOf(context, owned)

  try {
    await removeTree(owned)
    assert.equal(attemptedReadOnlyRecovery(), true, 'the first removal must have failed EACCES')
    assert.ok(repaired.length > 0, 'recovery must have repaired at least one directory')
    assert.deepEqual(
      // Prefix alone would also accept a sibling like `<owned>-other`.
      repaired.filter((path) => path !== owned && !path.startsWith(owned + sep)),
      [],
      'cleanup must never widen permissions outside the cell it owns',
    )
    assert.equal((await fs.lstat(outside)).mode, outsideMode, 'outside mode must be untouched')
  } finally {
    context.mock.restoreAll()
    await fs.chmod(outside, 0o700).catch(() => {})
    await removeTree(root).catch(() => {})
  }
})

it('never follows a symlink out of the owned tree while repairing permissions', async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-remove-tree-symlink-'))
  const owned = join(root, 'copse-review-cell')
  const outside = join(root, 'outside')
  const nested = join(outside, 'nested')
  await fs.mkdir(owned, { recursive: true })
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(join(outside, 'sentinel.txt'), 'must survive')
  await writeReadOnlyModuleCache(owned)
  // A command running inside the review cell can plant this before cleanup.
  await fs.symlink(outside, join(owned, 'escape'), 'dir')
  await fs.chmod(nested, 0o500)
  const nestedMode = (await fs.lstat(nested)).mode
  const attemptedReadOnlyRecovery = failFirstRemovalOf(context, owned)

  try {
    await removeTree(owned)
    assert.equal(attemptedReadOnlyRecovery(), true, 'the first removal must have failed EACCES')
    await assert.rejects(fs.access(owned), /ENOENT/, 'the owned cell must be gone')
    assert.equal(
      await fs.readFile(join(outside, 'sentinel.txt'), 'utf8'),
      'must survive',
      'cleanup must not delete through the symlink',
    )
    assert.equal(
      (await fs.lstat(nested)).mode,
      nestedMode,
      'cleanup must not chmod through the symlink',
    )
  } finally {
    context.mock.restoreAll()
    await fs.chmod(nested, 0o700).catch(() => {})
    await removeTree(root).catch(() => {})
  }
})
