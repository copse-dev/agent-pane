import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTO_APPROVAL_LEVEL_SETTING } from '@shared/auto-approval.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { setWorkspaceTrusted } from './workspace-trust.ts'
import { clearGitRemotesCache } from './git-remotes.ts'
import { resolveAutoApproval } from './auto-approval-config.ts'

describe('resolveAutoApproval — sandbox gate', () => {
  function withTrustedRepo(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'copse-auto-approval-config-'))
    mkdirSync(join(root, '.git'))
    writeFileSync(
      join(root, '.git', 'config'),
      '[remote "origin"]\n\turl = https://example.com/x.git\n',
    )
    clearGitRemotesCache()
    const restore = setWorkspaceRootForTest(root)
    setWorkspaceTrusted(root, true)
    setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'read')
    setSetting('autoRunSandboxCommands', true)
    try {
      run(root)
    } finally {
      setSetting(AUTO_APPROVAL_LEVEL_SETTING, 'off')
      setWorkspaceTrusted(root, false)
      restore()
      clearGitRemotesCache()
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('auto-approves a recognised read-tier shape only when the sandbox is active', () => {
    withTrustedRepo((root) => {
      const allowed = resolveAutoApproval('git fetch origin main', root, true)
      assert.equal(allowed.action, 'auto-approve')
      assert.equal('tier' in allowed ? allowed.tier : undefined, 'read')

      const blocked = resolveAutoApproval('git fetch origin main', root, false)
      assert.equal(blocked.action, 'prompt')
      assert.ok(blocked.reasons.includes('project sandbox not active'))
    })
  })

  it('fails closed when the caller omits sandboxEnabled', () => {
    withTrustedRepo((root) => {
      const blocked = resolveAutoApproval('git fetch origin main', root)
      assert.equal(blocked.action, 'prompt')
      assert.ok(blocked.reasons.includes('project sandbox not active'))
    })
  })

  it('still prompts when auto-run is off, even with a live sandbox', () => {
    withTrustedRepo((root) => {
      setSetting('autoRunSandboxCommands', false)
      const blocked = resolveAutoApproval('git fetch origin main', root, true)
      assert.equal(blocked.action, 'prompt')
      assert.ok(blocked.reasons.includes('auto-run disabled'))
    })
  })
})
