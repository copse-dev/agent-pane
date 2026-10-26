import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { getSetting, setSetting, updateSetting } from '../storage/settings.ts'
import { SETTINGS_WRITE_QUEUE, runSerialized } from '../storage/write-queue.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setWorkspaceTrusted } from './workspace-trust.ts'
import {
  addTrustedShellCommand,
  routeShellCommand,
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
        assert.equal(shellRunsOutsideSandbox(`cd ${worktreeRoot} && pnpm test`), false)
        assert.equal(shellRunsOutsideSandbox('cat /Users/dev/elsewhere/x'), true)
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
    setSetting('autoRunSandboxCommands', true)
    setWorkspaceTrusted(projectRoot, true)
    try {
      runWithThreadExecutionContext(worktree, () => {
        assert.equal(routeShellCommand('xcodebuild -list').outcome, 'allow')
      })
      setWorkspaceTrusted(projectRoot, false)
      setWorkspaceTrusted('/tmp/copse-routing-other-window', true)
      runWithThreadExecutionContext(worktree, () => {
        assert.equal(routeShellCommand('xcodebuild -list').outcome, 'defer')
      })
    } finally {
      setWorkspaceTrusted(projectRoot, false)
      setWorkspaceTrusted('/tmp/copse-routing-other-window', false)
      restore()
    }
  })
})
