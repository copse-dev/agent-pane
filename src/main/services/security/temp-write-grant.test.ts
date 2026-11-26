import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTempWriteGrants, grantTempWrites, hasTempWriteGrant } from './temp-write-grant.ts'
import { ensureShellCommandPermitted } from './permission-gate.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setPermissionGateForTests } from '../tool-registry.ts'
import { runWithWorkspaceRoot, setWorkspaceRootForTest } from '../workspace.ts'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import { setSetting } from '../storage/settings.ts'
import { drainWriteQueue } from '../storage/write-queue.ts'

describe('temp write grants', () => {
  it('are held per thread until cleared', () => {
    clearTempWriteGrants()
    grantTempWrites('t1')
    assert.equal(hasTempWriteGrant('t1'), true)
    assert.equal(hasTempWriteGrant('t2'), false)
    clearTempWriteGrants()
    assert.equal(hasTempWriteGrant('t1'), false)
  })
})

describe('Let this command write to /tmp?', () => {
  async function withGate(
    fn: (shell: (thread: string, command: string) => Promise<boolean>) => Promise<void>,
  ): Promise<void> {
    setPermissionGateForTests(null)
    clearTempWriteGrants()
    const root = mkdtempSync(join(tmpdir(), 'copse-temp-write-'))
    // The harm gate reads a script before letting it run; give it a plain one.
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'server.js'), "console.log('listening')\n")
    const store = mkdtempSync(join(tmpdir(), 'copse-temp-write-store-'))
    const previousStore = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = store
    const restore = setWorkspaceRootForTest(root)
    await setSetting('safetyClassifierEnabled', false)
    try {
      await fn((thread, command) =>
        runWithWorkspaceRoot(root, () =>
          runWithActiveRunIdentity(thread, () =>
            ensureShellCommandPermitted(command, {
              sandboxEnabled: true,
              autoRun: true,
              executionRoot: root,
            }),
          ),
        ),
      )
    } finally {
      await drainWriteQueue()
      setApprovalHandler(null)
      clearTempWriteGrants()
      restore()
      if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previousStore
      rmSync(store, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('asks the contained question, then answers later /tmp writes in that chat', async () => {
    await withGate(async (shell) => {
      const requests: ApprovalRequest[] = []
      setApprovalHandler(async (request) => {
        requests.push(request)
        return { approved: true, remember: true }
      })
      assert.equal(await shell('chat', 'node src/server.js > /tmp/server.log 2>&1'), true)
      assert.equal(requests.length, 1)
      const [first] = requests
      assert.ok(first)
      assert.equal(first.title, 'Let this command write to /tmp?')
      assert.equal(first.cause, 'shell-temp-write')
      assert.equal(first.scope, 'sandbox')
      assert.equal(first.approveOnceLabel, 'Allow once')
      assert.match(first.bodyAdvice ?? '', /\/tmp\/server\.log/)

      assert.equal(await shell('chat', 'echo hi > /tmp/other.txt'), true)
      assert.equal(requests.length, 1, 'the chat grant answers a different /tmp path')

      // A download to /tmp still needs the network, so it gets the ordinary
      // outside-sandbox prompt; another chat has no grant.
      setApprovalHandler(async (request) => {
        requests.push(request)
        return { approved: false, remember: false }
      })
      await shell('chat', 'curl https://example.com -o /tmp/x')
      await shell('other-chat', 'echo hi > /tmp/other.txt')
      assert.equal(requests[1]?.title, 'Run outside sandbox?')
      assert.equal(requests[2]?.title, 'Let this command write to /tmp?')
    })
  })

  it('grants nothing on Allow once', async () => {
    await withGate(async (shell) => {
      let asked = 0
      setApprovalHandler(async () => {
        asked++
        return { approved: true, remember: false }
      })
      await shell('once', 'echo a > /tmp/a.txt')
      await shell('once', 'echo b > /tmp/b.txt')
      assert.equal(asked, 2)
    })
  })
})
