import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'

// Inject only Electron's transport boundary. The registered handlers, real
// checkout lifecycle, queued store and filesystem below remain production code.
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
const originalElectron = require.cache[electronPath]
const runtime = import('../../sidecar/electron-shim/index.ts').then(async (shim) => {
  const module = new Module(electronPath)
  module.exports = shim
  require.cache[electronPath] = module
  const { BrowserWindow } = await import('electron')
  const { registerFsHandlers } = await import('./fs-handlers.ts')
  const { initFsWatcher } = await import('./fs-watcher.ts')
  const { registerIndexHandlers } = await import('./index-handlers.ts')
  const store = await import('../services/thread-store.ts')
  const storage = await import('../services/storage/storage.ts')
  const { configureThreadStore } = await import('@copse/thread-store/environment.ts')
  const { allocateThreadWorktree } = await import('../services/worktree-manager.ts')
  const { releaseCompletedAutomationWorktree } = await import('../services/worktree-parking.ts')
  const { setSandboxFsGatewayEnabledForTest } =
    await import('../project-sandbox/sandbox-fs-client.ts')
  const { stopWorkspaceIndexWatcher } =
    await import('../services/search/workspace-index-watcher.ts')
  const { setGitAvailableForTest } = await import('../services/tool-availability.ts')
  const { clearAllowedWorkspaceRootsForTest } = await import('../services/workspace.ts')
  const win = new BrowserWindow({ show: false })
  registerFsHandlers(win)
  initFsWatcher(win)
  registerIndexHandlers(win)
  return {
    ...store,
    ...storage,
    configureThreadStore,
    allocateThreadWorktree,
    releaseCompletedAutomationWorktree,
    setSandboxFsGatewayEnabledForTest,
    stopWorkspaceIndexWatcher,
    setGitAvailableForTest,
    clearAllowedWorkspaceRootsForTest,
    invoke: (channel: string, args: unknown[]): Promise<unknown> =>
      shim.sidecarInternals.dispatchInvoke(win.id, channel, args),
  }
})

after(() => {
  if (originalElectron) require.cache[electronPath] = originalElectron
  else Reflect.deleteProperty(require.cache, electronPath)
})

const PROJECT = 'passive-read-project'
const THREAD = 'finished-check'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

describe('registered passive filesystem and file-reference handlers', () => {
  let root = ''
  let repo = ''
  let previousWorktrees: string | undefined
  let previousWorkspace: string | undefined
  let previousProjects: unknown
  let previousActiveProject: unknown

  beforeEach(async () => {
    const r = await runtime
    root = mkdtempSync(join(tmpdir(), 'copse-passive-reads-'))
    previousWorktrees = process.env['COPSE_WORKTREES_DIR']
    previousWorkspace = process.env['COPSE_WORKSPACE_DIR']
    previousProjects = r.storageGet('projects')
    previousActiveProject = r.storageGet('activeProjectId')
    process.env['COPSE_WORKTREES_DIR'] = join(root, 'worktrees')
    process.env['COPSE_WORKSPACE_DIR'] = join(root, 'workspace')
    r.configureThreadStore({
      workspaceRoot: () => join(root, 'workspace'),
      listProjectIds: () => [PROJECT],
    })
    r.setSandboxFsGatewayEnabledForTest(false)
    r.setGitAvailableForTest(true)
    repo = join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Copse Test'])
    git(repo, ['config', 'user.email', 'copse@example.invalid'])
    writeFileSync(join(repo, 'README.md'), 'shared checkout\n')
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-qm', 'base'])
    r.storageSet('projects', [{ id: PROJECT, path: repo, name: 'Passive read project' }])
  })

  afterEach(async () => {
    const r = await runtime
    await r.invoke('fs:unwatch', [PROJECT, THREAD, 'README.md'])
    r.stopWorkspaceIndexWatcher()
    r.storageSet('projects', previousProjects)
    r.storageSet('activeProjectId', previousActiveProject)
    r.configureThreadStore()
    r.setSandboxFsGatewayEnabledForTest(null)
    r.setGitAvailableForTest(null)
    r.clearAllowedWorkspaceRootsForTest()
    if (previousWorktrees === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousWorktrees
    if (previousWorkspace === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousWorkspace
    rmSync(root, { recursive: true, force: true })
  })

  async function seed(): Promise<string> {
    const r = await runtime
    const worktree = await r.allocateThreadWorktree({
      projectId: PROJECT,
      threadId: THREAD,
      projectRoot: repo,
      prompt: 'Finished check',
      baseBranch: 'main',
      seedFromDirtyProject: false,
    })
    const thread: Thread = {
      id: THREAD,
      title: 'Finished check',
      status: 'idle',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      automation: { scheduleId: 'checks', scheduleName: 'Checks', triggeredAt: 1 },
      worktree,
      worktreeChoice: 'worktree',
      gitBranch: worktree.branch,
      createdAt: 1,
      updatedAt: 1,
    }
    await r.createThread(PROJECT, thread)
    return worktree.path
  }

  async function seedNested(): Promise<string> {
    const r = await runtime
    const nested = join(repo, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'README.md'), 'app checkout\n')
    writeFileSync(join(nested, 'app-only.ts'), 'export const app = true\n')
    writeFileSync(join(repo, 'root-only.ts'), 'export const root = true\n')
    git(repo, ['add', 'packages', 'root-only.ts'])
    git(repo, ['commit', '-qm', 'nested app'])
    repo = nested
    r.storageSet('projects', [{ id: PROJECT, path: nested, name: 'Nested app' }])
    return seed()
  }

  for (const channel of [
    'fs:list-dir',
    'fs:readdir',
    'fs:read-file',
    'fs:read-image',
    'fs:watch',
    'index:resolve-file-references',
  ]) {
    it(`${channel} cannot recreate a retired checkout or rewrite its record`, async () => {
      const r = await runtime
      const path = await seed()
      assert.deepEqual(await r.releaseCompletedAutomationWorktree(PROJECT, THREAD), {
        released: true,
      })
      const meta = join(root, 'workspace', PROJECT, THREAD, 'meta.json')
      const before = readFileSync(meta)
      const args =
        channel === 'index:resolve-file-references'
          ? [['README.md'], { projectId: PROJECT, threadId: THREAD }]
          : [
              PROJECT,
              THREAD,
              channel === 'fs:list-dir' || channel === 'fs:readdir' ? '' : 'README.md',
            ]
      if (channel === 'fs:read-image') {
        const result = await r.invoke(channel, args)
        assert.ok(typeof result === 'object' && result !== null && Object.hasOwn(result, 'error'))
      } else if (channel === 'fs:watch') await r.invoke(channel, args)
      else if (channel === 'index:resolve-file-references')
        assert.deepEqual(await r.invoke(channel, args), [])
      else await assert.rejects(r.invoke(channel, args), /checkout.*unavailable/i)
      assert.equal(existsSync(path), false)
      assert.ok(readFileSync(meta).equals(before))
    })
  }

  it('reads the dirty live PR checkout rather than the shared project', async () => {
    const r = await runtime
    const path = await seed()
    const meta = await r.getThreadMeta(PROJECT, THREAD)
    assert.ok(meta?.worktree)
    await r.updateMetaOrThrow(PROJECT, THREAD, {
      worktree: {
        ...meta.worktree,
        pullRequestUrl: 'https://github.com/copse-dev/agent-pane/pull/1',
      },
    })
    writeFileSync(join(path, 'README.md'), 'private PR changes\n')
    assert.equal(
      await r.invoke('fs:read-file', [PROJECT, THREAD, 'README.md']),
      'private PR changes\n',
    )
    assert.deepEqual(await r.invoke('fs:list-dir', [PROJECT, THREAD, '']), [
      { name: 'README.md', isDir: false },
    ])
  })

  it('keeps an isolated monorepo project scoped to its own subdirectory', async () => {
    const r = await runtime
    const path = await seedNested()
    assert.equal(await r.invoke('fs:read-file', [PROJECT, THREAD, 'README.md']), 'app checkout\n')
    assert.deepEqual(await r.invoke('fs:list-dir', [PROJECT, THREAD, '']), [
      { name: 'app-only.ts', isDir: false },
      { name: 'README.md', isDir: false },
    ])
    assert.deepEqual(
      await r.invoke('index:resolve-file-references', [
        ['app-only.ts', 'root-only.ts'],
        { projectId: PROJECT, threadId: THREAD },
      ]),
      [{ candidate: 'app-only.ts', path: 'app-only.ts', kind: 'file' }],
    )
    await r.invoke('fs:write-file', [PROJECT, THREAD, 'README.md', 'app edit\n'])
    assert.equal(readFileSync(join(path, 'packages', 'app', 'README.md'), 'utf8'), 'app edit\n')
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'shared checkout\n')
  })

  for (const invalid of ['missing', 'escaped', 'file']) {
    it(`does not fall back to a monorepo root when its project directory is ${invalid}`, async () => {
      const r = await runtime
      const path = await seedNested()
      const nested = join(path, 'packages', 'app')
      rmSync(nested, { recursive: true })
      if (invalid === 'escaped') {
        const outside = join(root, 'outside')
        mkdirSync(outside)
        writeFileSync(join(outside, 'README.md'), 'outside data\n')
        symlinkSync(outside, nested, process.platform === 'win32' ? 'junction' : 'dir')
      } else if (invalid === 'file') writeFileSync(nested, 'not a directory\n')
      const meta = join(root, 'workspace', PROJECT, THREAD, 'meta.json')
      const before = readFileSync(meta)
      await assert.rejects(
        r.invoke('fs:read-file', [PROJECT, THREAD, 'README.md']),
        /checkout.*unavailable/i,
      )
      await assert.rejects(r.invoke('fs:list-dir', [PROJECT, THREAD, '']), /checkout.*unavailable/i)
      await r.invoke('fs:watch', [PROJECT, THREAD, 'README.md'])
      assert.deepEqual(
        await r.invoke('index:resolve-file-references', [
          ['README.md'],
          { projectId: PROJECT, threadId: THREAD },
        ]),
        [],
      )
      assert.ok(readFileSync(meta).equals(before))
      assert.equal(existsSync(join(path, 'root-only.ts')), true)
    })
  }

  it('still restores the checkout before an explicit file write', async () => {
    const r = await runtime
    const path = await seed()
    assert.deepEqual(await r.releaseCompletedAutomationWorktree(PROJECT, THREAD), {
      released: true,
    })
    assert.equal(existsSync(path), false)
    await r.invoke('fs:write-file', [PROJECT, THREAD, 'README.md', 'Intentional edit.\n'])
    assert.equal(readFileSync(join(path, 'README.md'), 'utf8'), 'Intentional edit.\n')
    assert.equal((await r.getThreadMeta(PROJECT, THREAD))?.worktree?.retiredAt, undefined)
  })
})
