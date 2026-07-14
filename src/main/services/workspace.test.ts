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
  getChatStoreRoot,
  isResolvedPathInsideWorkspace,
  registerAllowedWorkspaceRoot,
  resolveReadablePath,
  resolveWorkspacePath,
  scheduleAllowedWorkspaceRootsBootstrap,
  seedAllowedWorkspaceRoots,
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

  it('rejects absolute paths outside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.rejects(() => resolveWorkspacePath('/etc/passwd'), /outside workspace/)
  })

  it('accepts absolute paths under the workspace root', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    const abs = join(ws, 'src', 'a.ts')
    const resolved = await resolveWorkspacePath(abs)
    assert.equal(resolved, realpathSync.native(abs))
  })

  it('rejects paths that lexically escape the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.rejects(() => resolveWorkspacePath('../outside'), /outside workspace/)
  })

  it('rejects symlink hops that leave the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(outside, join(ws, 'link'), 'dir')
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.rejects(() => resolveWorkspacePath('link/secret.txt'), /outside workspace/)
  })

  it('allows normal files under the workspace root', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    const resolved = await resolveWorkspacePath('src/a.ts')
    assert.equal(resolved, realpathSync.native(join(ws, 'src', 'a.ts')))
  })

  it('allows creating new paths when parent directories exist', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    const resolved = await resolveWorkspacePath('src/new-file.ts')
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

  it('rejects writing through a dangling symlink that points outside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    // Target does NOT exist yet: a dangling symlink slips past resolveWorkspacePath
    // (existsSync follows the link, sees nothing, and treats it as a new file).
    symlinkSync(join(outside, 'authorized_keys'), join(ws, 'deploy.conf'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    // resolveWorkspacePath still returns an in-workspace-looking path...
    const resolved = await resolveWorkspacePath('deploy.conf')
    // ...but the write guard must refuse to follow the escaping symlink.
    await assert.rejects(() => assertWorkspaceWriteTarget(resolved), /symlink that escapes/)
  })

  it('rejects writing through a symlinked parent directory that points outside', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    symlinkSync(outside, join(ws, 'link'), 'dir')
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.rejects(
      () => assertWorkspaceWriteTarget(join(realpathSync.native(ws), 'link', 'x.txt')),
      /escapes the workspace|outside workspace/,
    )
  })

  it('allows a symlink whose target stays inside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'real'))
    symlinkSync(join(ws, 'real', 'file.ts'), join(ws, 'alias.ts'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.doesNotReject(() =>
      assertWorkspaceWriteTarget(join(realpathSync.native(ws), 'alias.ts')),
    )
  })

  it('allows creating an ordinary new file (no symlink in the path)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.doesNotReject(() =>
      assertWorkspaceWriteTarget(join(realpathSync.native(ws), 'src', 'new.ts')),
    )
  })
})

describe('isResolvedPathInsideWorkspace (TOCTOU re-validation)', () => {
  let cleanupRoot: (() => void) | undefined

  afterEach(() => {
    cleanupRoot?.()
    cleanupRoot = undefined
  })

  it('returns false when no workspace is open', async () => {
    cleanupRoot = setWorkspaceRootForTest(null)
    assert.equal(await isResolvedPathInsideWorkspace('/anything'), false)
  })

  it('accepts a normal file under the workspace root', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.equal(
      await isResolvedPathInsideWorkspace(join(realpathSync.native(ws), 'src', 'a.ts')),
      true,
    )
  })

  it('rejects a path swapped to a symlink pointing outside the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    cleanupRoot = setWorkspaceRootForTest(ws)

    // Path that was originally a regular in-workspace file...
    const watched = join(realpathSync.native(ws), 'watched.txt')
    writeFileSync(watched, 'ok')
    assert.equal(await isResolvedPathInsideWorkspace(watched), true)

    // ...is later swapped to a symlink escaping the workspace (TOCTOU).
    rmSync(watched)
    symlinkSync(join(outside, 'secret.txt'), watched, 'file')
    assert.equal(await isResolvedPathInsideWorkspace(watched), false)
  })
})

describe('resolveReadablePath (read-only chat-store mount, #644)', () => {
  let cleanupRoot: (() => void) | undefined
  let prevChatDir: string | undefined
  let chatRoot: string
  let chatFile: string

  beforeEach(() => {
    clearAllowedWorkspaceRootsForTest()
    prevChatDir = process.env['COPSE_WORKSPACE_DIR']
    // A realistic seeded chat store: <root>/proj/thread/messages/m.md
    chatRoot = mkdtempSync(join(tmpdir(), 'copse-chat-'))
    process.env['COPSE_WORKSPACE_DIR'] = chatRoot
    const msgDir = join(chatRoot, 'proj', 'thread', 'messages')
    mkdirSync(msgDir, { recursive: true })
    chatFile = join(msgDir, 'm.md')
    writeFileSync(chatFile, 'thread body')
  })

  afterEach(() => {
    cleanupRoot?.()
    cleanupRoot = undefined
    if (prevChatDir === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = prevChatDir
    rmSync(chatRoot, { recursive: true, force: true })
    clearAllowedWorkspaceRootsForTest()
  })

  it('resolves an absolute path inside the chat store (read-only)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.equal(await resolveReadablePath(chatFile), realpathSync.native(chatFile))
    rmSync(ws, { recursive: true, force: true })
  })

  it('still resolves workspace-relative paths (workspace takes precedence)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'ok')
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    assert.equal(
      await resolveReadablePath('src/a.ts'),
      realpathSync.native(join(ws, 'src', 'a.ts')),
    )
    rmSync(ws, { recursive: true, force: true })
  })

  it('rejects an absolute path outside both the workspace and the chat store', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.rejects(
      () => resolveReadablePath('/etc/passwd'),
      /outside workspace or chat store/,
    )
    rmSync(ws, { recursive: true, force: true })
  })

  it('rejects a symlink inside the chat store whose target escapes it', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'copse-out-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(outside, join(chatRoot, 'proj', 'link'), 'dir')
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    await assert.rejects(
      () => resolveReadablePath(join(chatRoot, 'proj', 'link', 'secret.txt')),
      /outside workspace or chat store/,
    )
    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('write guards reject a chat-store path by construction', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'copse-ws-'))
    await registerAllowedWorkspaceRoot(ws)
    cleanupRoot = setWorkspaceRootForTest(ws)
    // The write path never uses resolveReadablePath — both workspace-only guards reject it.
    await assert.rejects(() => resolveWorkspacePath(chatFile), /outside workspace/)
    await assert.rejects(
      () => assertWorkspaceWriteTarget(realpathSync.native(chatFile)),
      /outside workspace/,
    )
    rmSync(ws, { recursive: true, force: true })
  })

  it('getChatStoreRoot returns null when the store does not exist yet', async () => {
    const missing = join(tmpdir(), 'copse-chat-missing-does-not-exist')
    process.env['COPSE_WORKSPACE_DIR'] = missing
    assert.equal(await getChatStoreRoot(), null)
  })
})

describe('allowed workspace roots', () => {
  afterEach(() => {
    clearAllowedWorkspaceRootsForTest()
  })

  it('permits only registered project folders via workspace:set guard', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'copse-allowed-'))
    const other = mkdtempSync(join(tmpdir(), 'copse-other-'))
    await registerAllowedWorkspaceRoot(allowed)
    await assert.doesNotReject(() => assertAllowedWorkspaceRoot(allowed))
    await assert.rejects(() => assertAllowedWorkspaceRoot(other), /not an allowed project/)
  })

  it('assertAllowedWorkspaceRoot waits for startup bootstrap seeding', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'copse-bootstrap-'))
    scheduleAllowedWorkspaceRootsBootstrap(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await seedAllowedWorkspaceRoots([{ path: allowed }])
    })
    await assert.doesNotReject(() => assertAllowedWorkspaceRoot(allowed))
  })

  it('tracks SSH project roots by host id and path', async () => {
    await registerAllowedWorkspaceRoot('/var/www/app', 'dev')
    await assert.doesNotReject(() => assertAllowedWorkspaceRoot('/var/www/app', 'dev'))
    await assert.rejects(
      () => assertAllowedWorkspaceRoot('/var/www/app', 'staging'),
      /not an allowed project/,
    )
    await assert.rejects(
      () => assertAllowedWorkspaceRoot('/var/www/other', 'dev'),
      /not an allowed/,
    )
  })
})
