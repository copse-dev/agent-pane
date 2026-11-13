import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { getSetting, setSetting, updateSetting } from '../storage/settings.ts'
import { SETTINGS_WRITE_QUEUE, runSerialized } from '../storage/write-queue.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'
import { currentAgentRoots } from '../execution-root.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { clearReadOutsideProjectGrants, grantReadOutsideProject } from './read-outside-grant.ts'
import { activateGuardedYoloForRun, armGuardedYolo, disableGuardedYolo } from './guarded-yolo.ts'
import { setWorkspaceTrusted } from './workspace-trust.ts'
import { copseToolPermissionId } from './tool-permissions.ts'
import {
  addTrustedShellCommand,
  offerableTrustedCommand,
  routeShellCommand,
  shellReadGrantTargets,
  shellRunsOutsideSandbox,
} from './command-routing-config.ts'

const SETTING = 'trustedShellCommands'

describe('trusted command settings', () => {
  it('keeps both commands when two grants overlap', async () => {
    await setSetting(SETTING, [])

    await Promise.all([addTrustedShellCommand('curl'), addTrustedShellCommand('xcodebuild')])

    assert.deepEqual(getSetting<string[]>(SETTING, []), ['curl', 'xcodebuild'])
  })

  it('reads after preceding writers in the shared settings transaction queue', async () => {
    // An earlier ordinary batch or mutation must land before a grant reads its value.
    await setSetting(SETTING, [])

    const { promise: blocked, resolve: release } = Promise.withResolvers<undefined>()
    const blocker = runSerialized(SETTINGS_WRITE_QUEUE, () => blocked)
    const earlierWrite = updateSetting<string[]>(SETTING, [], () => ['git'])

    let settled = false
    const remember = addTrustedShellCommand('curl').then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      assert.equal(settled, false, 'the grant must wait behind the queued settings write')
    } finally {
      release(undefined)
      await Promise.all([blocker, earlierWrite, remember])
    }
    assert.deepEqual(getSetting<string[]>(SETTING, []), ['git', 'curl'])
  })

  it('is a no-op for a duplicate or malformed entry', async () => {
    await setSetting(SETTING, ['curl'])

    await addTrustedShellCommand('curl')
    await addTrustedShellCommand('not a command')

    assert.deepEqual(getSetting<string[]>(SETTING, []), ['curl'])
  })
})

describe('sandbox routing in a worktree thread', () => {
  const projectRoot = '/Users/dev/project'
  const worktreeRoot = '/Users/dev/.copse/worktrees/project-1/thread-1'
  const worktree: ThreadExecutionContext = {
    projectId: 'project-1',
    threadId: 'thread-1',
    projectRoot,
    root: worktreeRoot,
    checkoutMode: 'worktree',
    branch: 'copse/thread-1',
  }

  it('judges paths against the thread checkout the gate also uses', () => {
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    const restore = setWorkspaceRootForTest(projectRoot)
    try {
      // The gate analyses this against the worktree and lets it run contained
      // without a prompt; the shell tool must not then route it outside.
      runWithThreadExecutionContext(worktree, () => {
        assert.equal(
          shellRunsOutsideSandbox(`cd ${worktreeRoot} && pnpm test`, currentAgentRoots()),
          false,
        )
        assert.equal(
          shellRunsOutsideSandbox('cat /Users/dev/elsewhere/x', currentAgentRoots()),
          true,
        )
      })
    } finally {
      restore()
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    }
  })

  it('reads trust from the thread project, not the window workspace', async () => {
    const restore = setWorkspaceRootForTest('/tmp/copse-routing-other-window')
    await setSetting(SETTING, ['xcodebuild'])
    await setSetting('autoRunSandboxCommands', true)
    setWorkspaceTrusted(projectRoot, true)
    try {
      runWithThreadExecutionContext(worktree, () => {
        assert.equal(routeShellCommand('xcodebuild -list', currentAgentRoots()).outcome, 'allow')
      })
      setWorkspaceTrusted(projectRoot, false)
      setWorkspaceTrusted('/tmp/copse-routing-other-window', true)
      runWithThreadExecutionContext(worktree, () => {
        assert.equal(routeShellCommand('xcodebuild -list', currentAgentRoots()).outcome, 'defer')
      })
    } finally {
      setWorkspaceTrusted(projectRoot, false)
      setWorkspaceTrusted('/tmp/copse-routing-other-window', false)
      restore()
    }
  })
})

describe('identity-pinned read routing', () => {
  it('passes the approved symlink destination to the sandbox and refuses a retargeted link', async () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-read-route-')))
    const root = join(base, 'project')
    const first = join(base, 'first.txt')
    const second = join(base, 'second.txt')
    const link = join(base, 'link.txt')
    mkdirSync(root)
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    symlinkSync(first, link)
    const context: ThreadExecutionContext = {
      projectId: 'read-route',
      threadId: 'read-route',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: null,
    }
    const restore = setWorkspaceRootForTest(root)
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    await setSetting(SETTING, [])
    try {
      grantReadOutsideProject(context.threadId, [link])
      const targets = (): string[] | null =>
        runWithActiveRunIdentity(context.threadId, () =>
          runWithThreadExecutionContext(context, () =>
            shellReadGrantTargets(`cat ${link}`, currentAgentRoots(), root),
          ),
        )
      assert.deepEqual(targets(), [first])
      rmSync(link)
      symlinkSync(second, link)
      // A stale standing grant is no longer reusable. The ordinary overlay
      // sees the literal link and refuses it rather than granting second.txt.
      assert.deepEqual(targets(), [link])
    } finally {
      clearReadOutsideProjectGrants()
      setProjectSandboxEnabled(false)
      mock.restoreAll()
      restore()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('passes a safe symlink destination to the sandbox in Guarded YOLO', async () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-yolo-read-route-')))
    const root = join(base, 'project')
    const destination = join(base, 'notes.txt')
    const link = join(base, 'notes-link.txt')
    mkdirSync(root)
    writeFileSync(destination, 'notes')
    symlinkSync(destination, link)
    const context: ThreadExecutionContext = {
      projectId: 'yolo-read-route',
      threadId: 'yolo-read-route',
      projectRoot: root,
      root,
      checkoutMode: 'shared',
      branch: null,
    }
    const restore = setWorkspaceRootForTest(root)
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    await setSetting(SETTING, [])
    try {
      armGuardedYolo(context.threadId)
      assert.equal(activateGuardedYoloForRun(context.threadId), true)
      const targets = runWithActiveRunIdentity(context.threadId, () =>
        runWithThreadExecutionContext(context, () =>
          shellReadGrantTargets('cat ' + link, currentAgentRoots(), root),
        ),
      )
      assert.deepEqual(targets, [destination])
    } finally {
      disableGuardedYolo(context.threadId)
      setProjectSandboxEnabled(false)
      mock.restoreAll()
      restore()
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('trusted-command routing with two roots at once (#3958)', () => {
  // Two runs in two projects resolve policy concurrently; each answer must
  // follow the roots it was handed, never the window workspace (a third root).
  const trusted = {
    projectRoot: '/tmp/copse-routing-trusted',
    executionRoot: '/tmp/copse-routing-trusted',
  }
  const untrusted = {
    projectRoot: '/tmp/copse-routing-untrusted',
    executionRoot: '/tmp/copse-routing-untrusted',
  }
  const ambient = '/tmp/copse-routing-ambient'

  for (const toolName of ['run_shell', 'run_background'] as const) {
    it(`lets ${toolName}'s Always ask setting suppress only its trusted route`, async () => {
      mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
      setProjectSandboxEnabled(true)
      await setSetting(SETTING, ['printf'])
      await setSetting('autoRunSandboxCommands', true)
      await setSetting('toolPermissionOverrides', {
        [copseToolPermissionId(toolName)]: 'ask',
      })
      setWorkspaceTrusted(trusted.projectRoot, true)
      try {
        assert.equal(shellRunsOutsideSandbox('printf local', trusted, toolName), false)
        const otherTool = toolName === 'run_shell' ? 'run_background' : 'run_shell'
        assert.equal(shellRunsOutsideSandbox('printf local', trusted, otherTool), true)
      } finally {
        await setSetting('toolPermissionOverrides', {})
        setWorkspaceTrusted(trusted.projectRoot, false)
        setProjectSandboxEnabled(false)
        mock.restoreAll()
      }
    })
  }

  it('routes, offers and grants per caller root', async () => {
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    const restore = setWorkspaceRootForTest(ambient)
    await setSetting(SETTING, ['xcodebuild'])
    await setSetting('autoRunSandboxCommands', true)
    setWorkspaceTrusted(trusted.projectRoot, true)
    setWorkspaceTrusted(ambient, true)
    try {
      const resolve = async (
        roots: typeof trusted,
      ): Promise<{
        routing: string
        outside: boolean
        readGrant: string[] | null
        offer: string | null
      }> => {
        await new Promise<void>((done) => setImmediate(done))
        return {
          routing: routeShellCommand('xcodebuild -list', roots).outcome,
          outside: shellRunsOutsideSandbox('xcodebuild -list', roots),
          readGrant: shellReadGrantTargets('xcodebuild -list', roots, roots.executionRoot),
          offer: offerableTrustedCommand('swift build', roots.projectRoot),
        }
      }
      const [a, b] = await Promise.all([resolve(trusted), resolve(untrusted)])
      assert.equal(a.routing, 'allow')
      assert.equal(a.outside, true)
      assert.equal(a.offer, 'swift')
      assert.equal(b.routing, 'defer')
      assert.equal(b.offer, null)
      // A trusted, allow-listed command keeps its unsandboxed routing: no read grant.
      assert.equal(a.readGrant, null)
    } finally {
      setWorkspaceTrusted(trusted.projectRoot, false)
      setWorkspaceTrusted(ambient, false)
      restore()
      setProjectSandboxEnabled(false)
      mock.restoreAll()
    }
  })
})
