import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import {
  assertAllowedWorkspaceRoot,
  assertWorkspaceWriteTarget,
  clearAllowedWorkspaceRootsForTest,
  isResolvedPathInsideWorkspace,
  registerAllowedWorkspaceRoot,
  resolveWorkspacePath,
  setWorkspaceRootForTest,
} from './workspace.ts'

describe('workspace path containment', () => {
  let cleanupRoot: (() => void) | undefined

  beforeEach(() => {
    clearAllowedWorkspaceRootsForTest()
  })

  afterEach(() => {
    cleanupRoot?.()
    cleanupRoot = undefined
    clearAllowedWorkspaceRootsForTest()
  })

  it('rejects absolute paths outside the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.throws(() => resolveWorkspacePath('/etc/passwd'), /outside workspace/)
  })

  it('accepts absolute paths under the workspace root', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    const abs = join(ws, 'src', 'a.ts')
    const resolved = resolveWorkspacePath(abs)
    assert.equal(resolved, realpathSync.native(abs))
  })

  it('rejects paths that lexically escape the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.throws(() => resolveWorkspacePath('../outside'), /outside workspace/)
  })

  it('rejects symlink hops that leave the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(outside, join(ws, 'link'), 'dir')
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.throws(() => resolveWorkspacePath('link/secret.txt'), /outside workspace/)
  })

  it('allows normal files under the workspace root', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    const resolved = resolveWorkspacePath('src/a.ts')
    assert.equal(resolved, realpathSync.native(join(ws, 'src', 'a.ts')))
  })

  it('allows creating new paths when parent directories exist', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    const resolved = resolveWorkspacePath('src/new-file.ts')
    assert.equal(resolved, join(realpathSync.native(ws), 'src', 'new-file.ts'))
    assert.ok(!existsSync(resolved))
  })
})

describe('assertWorkspaceWriteTarget (symlink write escape)', () => {
  let cleanupRoot: (() => void) | undefined

  beforeEach(() => {
    clearAllowedWorkspaceRootsForTest()
  })

  afterEach(() => {
    cleanupRoot?.()
    cleanupRoot = undefined
    clearAllowedWorkspaceRootsForTest()
  })

  it('rejects writing through a dangling symlink that points outside the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    // Target does NOT exist yet: a dangling symlink slips past resolveWorkspacePath
    // (existsSync follows the link, sees nothing, and treats it as a new file).
    symlinkSync(join(outside, 'authorized_keys'), join(ws, 'deploy.conf'))
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    // resolveWorkspacePath still returns an in-workspace-looking path...
    const resolved = resolveWorkspacePath('deploy.conf')
    // ...but the write guard must refuse to follow the escaping symlink.
    assert.throws(() => {
      assertWorkspaceWriteTarget(resolved)
    }, /symlink that escapes/)
  })

  it('rejects writing through a symlinked parent directory that points outside', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    symlinkSync(outside, join(ws, 'link'), 'dir')
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.throws(() => {
      assertWorkspaceWriteTarget(join(realpathSync.native(ws), 'link', 'x.txt'))
    }, /escapes the workspace|outside workspace/)
  })

  it('allows a symlink whose target stays inside the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'real'))
    symlinkSync(join(ws, 'real', 'file.ts'), join(ws, 'alias.ts'))
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.doesNotThrow(() => {
      assertWorkspaceWriteTarget(join(realpathSync.native(ws), 'alias.ts'))
    })
  })

  it('allows creating an ordinary new file (no symlink in the path)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.doesNotThrow(() => {
      assertWorkspaceWriteTarget(join(realpathSync.native(ws), 'src', 'new.ts'))
    })
  })
})

describe('isResolvedPathInsideWorkspace (TOCTOU re-validation)', () => {
  let cleanupRoot: (() => void) | undefined

  afterEach(() => {
    cleanupRoot?.()
    cleanupRoot = undefined
  })

  it('returns false when no workspace is open', () => {
    cleanupRoot = setWorkspaceRootForTest(null)
    assert.equal(isResolvedPathInsideWorkspace('/anything'), false)
  })

  it('accepts a normal file under the workspace root', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.equal(isResolvedPathInsideWorkspace(join(realpathSync.native(ws), 'src', 'a.ts')), true)
  })

  it('rejects a path swapped to a symlink pointing outside the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    cleanupRoot = setWorkspaceRootForTest(ws)

    // Path that was originally a regular in-workspace file...
    const watched = join(realpathSync.native(ws), 'watched.txt')
    writeFileSync(watched, 'ok')
    assert.equal(isResolvedPathInsideWorkspace(watched), true)

    // ...is later swapped to a symlink escaping the workspace (TOCTOU).
    rmSync(watched)
    symlinkSync(join(outside, 'secret.txt'), watched, 'file')
    assert.equal(isResolvedPathInsideWorkspace(watched), false)
  })
})

describe('allowed workspace roots', () => {
  afterEach(() => {
    clearAllowedWorkspaceRootsForTest()
  })

  it('permits only registered project folders via workspace:set guard', () => {
    const allowed = mkdtempSync(join(tmpdir(), 'copse-allowed-'))
    const other = mkdtempSync(join(tmpdir(), 'copse-other-'))
    registerAllowedWorkspaceRoot(allowed)
    assert.doesNotThrow(() => assertAllowedWorkspaceRoot(allowed))
    assert.throws(() => assertAllowedWorkspaceRoot(other), /not an allowed project/)
  })
})
