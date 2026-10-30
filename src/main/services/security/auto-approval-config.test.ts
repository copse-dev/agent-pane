import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceTrusted } from './workspace-trust.ts'
import { clearGitRemotesCache } from './git-remotes.ts'
import { resolveAutoApproval } from './auto-approval-config.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'

describe('resolveAutoApproval — sandbox gate', () => {
  async function withTrustedRepo(run: (root: string) => void | Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'copse-auto-approval-config-'))
    mkdirSync(join(root, '.git'))
    writeFileSync(
      join(root, '.git', 'config'),
      '[remote "origin"]\n\turl = https://example.com/x.git\n',
    )
    clearGitRemotesCache()
    const restore = setWorkspaceRootForTest(root)
    setWorkspaceTrusted(root, true)
    await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'read')
    await setSetting('autoRunSandboxCommands', true)
    try {
      await run(root)
    } finally {
      await setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
      setWorkspaceTrusted(root, false)
      restore()
      clearGitRemotesCache()
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('auto-approves a recognised read-tier shape only when the sandbox is active', async () => {
    await withTrustedRepo((root) => {
      const allowed = resolveAutoApproval('git fetch origin main', root, true)
      assert.equal(allowed.action, 'auto-approve')
      assert.equal('tier' in allowed ? allowed.tier : undefined, 'read')

      const blocked = resolveAutoApproval('git fetch origin main', root, false)
      assert.equal(blocked.action, 'prompt')
      assert.ok(blocked.reasons.includes('project sandbox not active'))
    })
  })

  it('does not grant artifact downloads an unsandboxed retry even with an active session sandbox', async () => {
    await withTrustedRepo((root) => {
      for (const command of [
        'gh run download 123',
        'gh run download 123 --dir .tmp/artifacts',
        'gh run download 123 --dir /tmp/outside-artifacts',
      ]) {
        assert.equal(resolveAutoApproval(command, root, true).action, 'prompt', command)
      }
    })
  })

  it('fails closed when the caller omits sandboxEnabled', async () => {
    await withTrustedRepo((root) => {
      const blocked = resolveAutoApproval('git fetch origin main', root)
      assert.equal(blocked.action, 'prompt')
      assert.ok(blocked.reasons.includes('project sandbox not active'))
    })
  })

  it('still prompts when auto-run is off, even with a live sandbox', async () => {
    await withTrustedRepo(async (root) => {
      await setSetting('autoRunSandboxCommands', false)
      const blocked = resolveAutoApproval('git fetch origin main', root, true)
      assert.equal(blocked.action, 'prompt')
      assert.ok(blocked.reasons.includes('auto-run disabled'))
    })
  })

  it('reads trust from the run project, not the window workspace', async () => {
    await withTrustedRepo((root) => {
      const other = mkdtempSync(join(tmpdir(), 'copse-auto-approval-other-'))
      const inOtherProject = <T>(fn: () => T): T =>
        runWithThreadExecutionContext(
          {
            projectId: 'other',
            threadId: 'background-thread',
            projectRoot: other,
            root: other,
            checkoutMode: 'shared',
            branch: null,
          },
          fn,
        )
      try {
        // The window shows the trusted repo, but this run acts on an untrusted one.
        const blocked = inOtherProject(() => resolveAutoApproval('git status', undefined, true))
        assert.equal(blocked.action, 'prompt')
        assert.ok(blocked.reasons.includes('workspace not trusted'))

        setWorkspaceTrusted(other, true)
        setWorkspaceTrusted(root, false)
        const allowed = inOtherProject(() => resolveAutoApproval('git status', undefined, true))
        assert.equal(allowed.action, 'auto-approve')
      } finally {
        setWorkspaceTrusted(other, false)
        rmSync(other, { recursive: true, force: true })
      }
    })
  })
})
