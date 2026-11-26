import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearEscalationGrants,
  escalationGrantFooter,
  grantableEscalationKinds,
  grantEscalationKinds,
  hasEscalationGrant,
} from './escalation-grant.ts'
import { promptUnsandboxedShell } from './permission-gate.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setPermissionGateForTests } from '../tool-registry.ts'
import { runWithWorkspaceRoot, setWorkspaceRootForTest } from '../workspace.ts'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import { setSetting } from '../storage/settings.ts'
import { drainWriteQueue } from '../storage/write-queue.ts'

const TMP = 'global temp path (/tmp/)'
const INLINE = 'inline script (interpreter -c/-e/--eval)'
const DOWNLOAD = 'network download (curl/wget)'

describe('grantableEscalationKinds', () => {
  it('names the kinds only when every reason is grantable', () => {
    assert.deepEqual(grantableEscalationKinds([TMP, INLINE, TMP]), [TMP, INLINE].sort())
    assert.equal(grantableEscalationKinds([TMP, DOWNLOAD]), null)
    assert.equal(grantableEscalationKinds(['home directory path (~/)']), null)
    assert.equal(grantableEscalationKinds(['absolute path outside workspace: /etc/x']), null)
    assert.equal(grantableEscalationKinds([]), null)
  })

  it('is covered by a grant of the same or wider kinds, in that thread only', () => {
    clearEscalationGrants()
    grantEscalationKinds('t1', [TMP, INLINE])
    assert.equal(hasEscalationGrant('t1', [TMP]), true)
    assert.equal(hasEscalationGrant('t1', [INLINE, TMP]), true)
    assert.equal(hasEscalationGrant('t1', [TMP, 'loopback request (curl/wget)']), false)
    assert.equal(hasEscalationGrant('t2', [TMP]), false)
    assert.equal(hasEscalationGrant('t1', []), false)
    clearEscalationGrants()
    assert.equal(hasEscalationGrant('t1', [TMP]), false)
  })

  it('says in the footer what the grant covers and what still asks', () => {
    assert.match(
      escalationGrantFooter([TMP, INLINE]),
      /only involve \/tmp files and inline scripts/,
    )
    assert.match(escalationGrantFooter([TMP]), /Downloads, installs, pushes and your home folder/)
  })
})

describe('Allow for this chat on an outside-sandbox prompt', () => {
  async function withGate<T>(fn: () => Promise<T>): Promise<T> {
    setPermissionGateForTests(null)
    clearEscalationGrants()
    const root = mkdtempSync(join(tmpdir(), 'copse-escalation-grant-'))
    mkdirSync(join(root, 'src'))
    const store = mkdtempSync(join(tmpdir(), 'copse-escalation-grant-store-'))
    const previousStore = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = store
    const restore = setWorkspaceRootForTest(root)
    await setSetting('safetyClassifierEnabled', false)
    try {
      return await runWithWorkspaceRoot(root, fn)
    } finally {
      await drainWriteQueue()
      setApprovalHandler(null)
      clearEscalationGrants()
      restore()
      if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousStore
      rmSync(store, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('offers the chat grant and then answers matching prompts in that chat without asking', async () => {
    await withGate(async () => {
      const requests: ApprovalRequest[] = []
      setApprovalHandler(async (request) => {
        requests.push(request)
        // The two-tier prompt's grant button resolves with remember.
        return { approved: true, remember: true }
      })
      const first = await runWithActiveRunIdentity('thread-grant', () =>
        promptUnsandboxedShell('node -e "1" > /tmp/out.txt', [TMP, INLINE]),
      )
      assert.equal(first, true)
      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.approveLabel, 'Allow for this chat')
      assert.equal(requests[0]?.approveOnceLabel, 'Run once')
      assert.match(requests[0]?.bodyFooter ?? '', /only involve \/tmp files and inline scripts/)

      // Same kinds, a different command: answered by the grant.
      const covered = await runWithActiveRunIdentity('thread-grant', () =>
        promptUnsandboxedShell('node -e "2" > /tmp/out2.txt', [TMP, INLINE]),
      )
      assert.equal(covered, true)
      assert.equal(requests.length, 1)

      // A download is never covered, and another chat has no grant.
      setApprovalHandler(async (request) => {
        requests.push(request)
        return { approved: false, remember: false }
      })
      assert.equal(
        await runWithActiveRunIdentity('thread-grant', () =>
          promptUnsandboxedShell('curl https://example.com -o /tmp/x', [TMP, DOWNLOAD]),
        ),
        false,
      )
      assert.equal(
        await runWithActiveRunIdentity('thread-other', () =>
          promptUnsandboxedShell('node -e "2" > /tmp/out2.txt', [TMP, INLINE]),
        ),
        false,
      )
      assert.equal(requests.length, 3)
      // The download prompt offers no chat grant at all.
      assert.equal(requests[1]?.approveOnceLabel, undefined)
    })
  })

  it('keeps asking when the harm gate would not allow the command', async () => {
    await withGate(async () => {
      grantEscalationKinds('thread-harm', [TMP])
      let asked = 0
      setApprovalHandler(async () => {
        asked++
        return { approved: false, remember: false }
      })
      const approved = await runWithActiveRunIdentity('thread-harm', () =>
        promptUnsandboxedShell('cp ~/.ssh/id_rsa /tmp/k', [TMP]),
      )
      assert.equal(approved, false)
      assert.equal(asked, 1)
    })
  })

  it('records "Run once" without granting anything', async () => {
    await withGate(async () => {
      let asked = 0
      setApprovalHandler(async () => {
        asked++
        return { approved: true, remember: false }
      })
      for (let i = 0; i < 2; i++) {
        await runWithActiveRunIdentity('thread-once', () =>
          promptUnsandboxedShell('node -e "2" > /tmp/out2.txt', [TMP, INLINE]),
        )
      }
      assert.equal(asked, 2)
    })
  })
})
