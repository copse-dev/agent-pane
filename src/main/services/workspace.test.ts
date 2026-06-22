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
import {
  assertAllowedWorkspaceRoot,
  clearAllowedWorkspaceRootsForTest,
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
