import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatPushTarget,
  clearChatPushGrants,
  grantChatPush,
  hasChatPushGrant,
} from './push-grant.ts'
import { ensureToolPermitted } from './permission-gate.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setPermissionGateForTests } from '../tool-registry.ts'
import { runWithWorkspaceRoot, setWorkspaceRootForTest } from '../workspace.ts'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import { setSetting } from '../storage/settings.ts'
import { drainWriteQueue } from '../storage/write-queue.ts'

/** A repository on `feature`, whose origin's default branch is `main`. */
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'copse-push-grant-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git(
    '-c',
    'user.email=t@example.test',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  )
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(root, 'a.txt'), 'a')
  return root
}

describe('chatPushTarget', () => {
  it('names only a fast-forward push of the checked-out, non-default branch', async () => {
    const root = repository()
    try {
      assert.deepEqual(await chatPushTarget({ branch: 'feature' }, root), {
        root,
        branch: 'feature',
      })
      assert.equal(await chatPushTarget({ branch: 'other' }, root), null)
      assert.equal(
        await chatPushTarget({ branch: 'feature', expected_remote_sha: 'a'.repeat(40) }, root),
        null,
      )
      assert.equal(await chatPushTarget({ branch: 'feature' }, null), null)
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root })
      assert.equal(await chatPushTarget({ branch: 'main' }, root), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps grants per thread, checkout and branch', () => {
    clearChatPushGrants()
    grantChatPush('t1', { root: '/r', branch: 'feature' })
    assert.equal(hasChatPushGrant('t1', { root: '/r', branch: 'feature' }), true)
    assert.equal(hasChatPushGrant('t1', { root: '/r', branch: 'other' }), false)
    assert.equal(hasChatPushGrant('t1', { root: '/elsewhere', branch: 'feature' }), false)
    assert.equal(hasChatPushGrant('t2', { root: '/r', branch: 'feature' }), false)
    clearChatPushGrants()
  })
})

describe('Allow for this chat on a push prompt', () => {
  it('asks once, then pushes the same branch again in that chat without asking', async () => {
    setPermissionGateForTests(null)
    clearChatPushGrants()
    const root = repository()
    const store = mkdtempSync(join(tmpdir(), 'copse-push-grant-store-'))
    const previousStore = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = store
    const restore = setWorkspaceRootForTest(root)
    await setSetting('safetyClassifierEnabled', false)
    const requests: ApprovalRequest[] = []
    setApprovalHandler(async (request) => {
      requests.push(request)
      return { approved: true, remember: true }
    })
    try {
      const push = (thread: string, args: unknown): Promise<boolean> =>
        runWithWorkspaceRoot(root, () =>
          runWithActiveRunIdentity(thread, () =>
            ensureToolPermitted({ toolName: 'git_push', args }),
          ),
        )
      assert.equal(await push('chat', { branch: 'feature' }), true)
      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.approveLabel, 'Allow for this chat')
      assert.equal(requests[0]?.approveOnceLabel, 'Push once')
      assert.match(requests[0]?.bodyFooter ?? '', /pushes feature to origin again/)

      assert.equal(await push('chat', { branch: 'feature' }), true)
      assert.equal(requests.length, 1, 'the chat grant answers the second push')

      // A history rewrite and another chat still ask.
      await push('chat', { branch: 'feature', expected_remote_sha: 'b'.repeat(40) })
      await push('other-chat', { branch: 'feature' })
      assert.equal(requests.length, 3)
      assert.equal(requests[1]?.approveOnceLabel, undefined)
    } finally {
      await drainWriteQueue()
      setApprovalHandler(null)
      clearChatPushGrants()
      restore()
      if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousStore
      rmSync(store, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
