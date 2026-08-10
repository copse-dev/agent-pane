import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { projectStoreNamespaceDir } from './project-namespace.ts'
import { storageSet } from './storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const cleanups: Array<() => void> = []

function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copse-namespace-'))
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** The pre-#1709 directory name: slug of the folder plus a hash of its path. */
function legacyName(root: string): string {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return `${slug || 'workspace'}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`
}

/** Put a project on the store the way the app does: an id plus its current path. */
function openProject(id: string | null, path: string): void {
  storageSet('projects', id ? [{ id, path, name: basename(path) }] : [])
  storageSet('activeProjectId', id)
  cleanups.push(setWorkspaceRootForTest(path))
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  storageSet('projects', [])
  storageSet('activeProjectId', null)
})

describe('projectStoreNamespaceDir', () => {
  it('names the directory after the project id, not its path', () => {
    const base = tempBase()
    openProject('project-1', '/repos/widget')

    assert.equal(projectStoreNamespaceDir(base), join(base, 'project-1'))
  })

  // The bug: threads followed a relocated project (keyed by id) while these
  // stores did not (keyed by a hash of the path), so they silently read empty.
  it('keeps a store attached to a project that moved', () => {
    const base = tempBase()
    const before = '/repos/widget'
    const after = '/somewhere/else/widget'

    openProject('project-1', before)
    const original = projectStoreNamespaceDir(base)
    mkdirSync(original, { recursive: true })
    writeFileSync(join(original, 'notes.txt'), 'kept')

    openProject('project-1', after)
    const relocated = projectStoreNamespaceDir(base)

    assert.equal(relocated, original)
    assert.equal(readFileSync(join(relocated, 'notes.txt'), 'utf8'), 'kept')
  })

  it('migrates an existing path-hashed directory on first use', () => {
    const base = tempBase()
    const root = '/repos/widget'
    const legacy = join(base, legacyName(root))
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'notes.txt'), 'from the old scheme')

    openProject('project-1', root)
    const dir = projectStoreNamespaceDir(base)

    assert.equal(dir, join(base, 'project-1'))
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'from the old scheme')
    assert.equal(existsSync(legacy), false, 'legacy directory should have been moved, not copied')
  })

  it('leaves an already-migrated directory alone', () => {
    const base = tempBase()
    const root = '/repos/widget'
    openProject('project-1', root)

    const target = join(base, 'project-1')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'notes.txt'), 'current')
    // A stale legacy directory must not overwrite the live one.
    const legacy = join(base, legacyName(root))
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'notes.txt'), 'stale')

    assert.equal(projectStoreNamespaceDir(base), target)
    assert.equal(readFileSync(join(target, 'notes.txt'), 'utf8'), 'current')
  })

  it('falls back to a shared namespace with no project open', () => {
    const base = tempBase()
    openProject(null, '/repos/widget')
    cleanups.push(setWorkspaceRootForTest(null))

    assert.equal(projectStoreNamespaceDir(base, null), join(base, 'shared'))
  })

  // Headless runs scope by workspace root and never set an active project id;
  // they must keep resolving to the directory they already use.
  it('keeps the legacy name when there is a root but no project id', () => {
    const base = tempBase()
    const root = '/repos/widget'
    storageSet('activeProjectId', null)
    cleanups.push(setWorkspaceRootForTest(root))

    assert.equal(projectStoreNamespaceDir(base, root), join(base, legacyName(root)))
  })

  it('honours an explicitly passed root', () => {
    const base = tempBase()
    openProject('project-1', '/repos/widget')

    assert.equal(projectStoreNamespaceDir(base, null), join(base, 'shared'))
  })
})
