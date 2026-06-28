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
  clearAllowedWorkspaceRootsForTest,
  isResolvedPathInsideWorkspace,
  registerAllowedWorkspaceRoot,
  resolveWorkspacePath,
  resolveReadablePath,
  setAttachmentsRoot,
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

describe('resolveReadablePath (read-only attachments root)', () => {
  let cleanupRoot: (() => void) | undefined

  afterEach(() => {
    cleanupRoot?.()
    cleanupRoot = undefined
    setAttachmentsRoot(null)
  })

  it('still resolves workspace files like resolveWorkspacePath', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.equal(resolveReadablePath('src/a.ts'), realpathSync.native(join(ws, 'src', 'a.ts')))
  })

  it('accepts absolute paths inside the registered attachments root', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const att = mkdtempSync(join(tmpdir(), 'copse-att-'))
    writeFileSync(join(att, 'big.jsonl'), 'data')
    cleanupRoot = setWorkspaceRootForTest(ws)
    setAttachmentsRoot(att)
    const abs = join(att, 'big.jsonl')
    assert.equal(resolveReadablePath(abs), realpathSync.native(abs))
  })

  it('rejects paths outside both the workspace and attachments roots', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const att = mkdtempSync(join(tmpdir(), 'copse-att-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    cleanupRoot = setWorkspaceRootForTest(ws)
    setAttachmentsRoot(att)
    assert.throws(() => resolveReadablePath(join(outside, 'secret.txt')), /outside workspace/)
  })

  it('rejects a symlink inside the attachments root that escapes it', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const att = mkdtempSync(join(tmpdir(), 'copse-att-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(outside, join(att, 'link'), 'dir')
    cleanupRoot = setWorkspaceRootForTest(ws)
    setAttachmentsRoot(att)
    assert.throws(() => resolveReadablePath(join(att, 'link', 'secret.txt')), /outside workspace/)
  })

  it('does not consult the attachments root for relative paths', () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const att = mkdtempSync(join(tmpdir(), 'copse-att-'))
    writeFileSync(join(att, 'big.jsonl'), 'data')
    cleanupRoot = setWorkspaceRootForTest(ws)
    setAttachmentsRoot(att)
    // A bare relative name only ever resolves against the workspace, never the
    // attachments root — so it maps under ws, not the same-named file in att.
    const resolved = resolveReadablePath('big.jsonl')
    assert.equal(resolved, join(realpathSync.native(ws), 'big.jsonl'))
    assert.notEqual(resolved, join(att, 'big.jsonl'))
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
