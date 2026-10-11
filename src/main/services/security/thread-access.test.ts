import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { threadExecutionContextStorage } from '../thread-execution-context-store.ts'
import { runWithApprovalHandler } from '../approval.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import {
  ensureChatStoreRead,
  ensureThreadAccess,
  hasThreadAccess,
  needsOtherThreadRead,
  revokeThreadAccess,
  threadChatReadRoot,
} from './thread-access.ts'

describe('conversation access', () => {
  afterEach(() => {
    setSetting('threadReadAccess', [])
    setSetting('threadSendAccess', [])
  })

  it('asks exactly twice, reuses each grant and isolates other threads', async () => {
    const requests: string[] = []
    await runWithApprovalHandler(
      async (request) => {
        requests.push(request.title)
        return { approved: true, remember: false }
      },
      () =>
        runWithActiveRunIdentity('source', async () => {
          assert.deepEqual(
            await Promise.all([ensureThreadAccess('read'), ensureThreadAccess('read')]),
            [true, true],
          )
          assert.equal(hasThreadAccess('source', 'send'), false)
          assert.equal(await ensureThreadAccess('send'), true)
          assert.equal(await ensureThreadAccess('read'), true)
          assert.equal(await ensureThreadAccess('send'), true)
          assert.equal(hasThreadAccess('destination', 'read'), false)
          assert.equal(hasThreadAccess('destination', 'send'), false)
        }),
    )
    assert.deepEqual(requests, ['Read your other threads?', 'Send prompts to your other threads?'])
  })

  it('a denial or aborted request never records a grant', async () => {
    await runWithApprovalHandler(
      async () => ({ approved: false, remember: false }),
      () =>
        runWithActiveRunIdentity('denied', async () => {
          assert.equal(await ensureThreadAccess('read'), false)
          assert.equal(await ensureThreadAccess('send', AbortSignal.abort()), false)
        }),
    )
    assert.equal(hasThreadAccess('denied', 'read'), false)
    assert.equal(hasThreadAccess(null, 'send'), false)
  })

  it('guards file reads, and one declined read produces one request', async () => {
    let prompts = 0
    await runWithApprovalHandler(
      async () => {
        prompts++
        return { approved: false, remember: false }
      },
      () =>
        runWithActiveRunIdentity('file-reader', async () => {
          await assert.rejects(
            ensureChatStoreRead('/store/project/other/messages/a.md', '/store'),
            /declined/,
          )
        }),
    )
    assert.equal(prompts, 1)
    assert.equal(hasThreadAccess('file-reader', 'read'), false)
  })

  it('revokes one permission without changing the other or another thread', async () => {
    setSetting('threadReadAccess', ['source', 'other'])
    setSetting('threadSendAccess', ['source'])
    await revokeThreadAccess('source', 'read')
    assert.equal(hasThreadAccess('source', 'read'), false)
    assert.equal(hasThreadAccess('source', 'send'), true)
    assert.equal(hasThreadAccess('other', 'read'), true)
  })

  it('revocation invalidates an approval that is still pending', async () => {
    const answer = Promise.withResolvers<{ approved: boolean; remember: boolean }>()
    const shown = Promise.withResolvers<boolean>()
    await runWithApprovalHandler(
      () => {
        shown.resolve(true)
        return answer.promise
      },
      () =>
        runWithActiveRunIdentity('revoked-pending', async () => {
          const request = ensureThreadAccess('read')
          await shown.promise
          await revokeThreadAccess('revoked-pending', 'read')
          answer.resolve({ approved: true, remember: false })
          assert.equal(await request, false)
          assert.equal(hasThreadAccess('revoked-pending', 'read'), false)
        }),
    )
  })

  it('confines an unapproved run to its own transcript and grants the whole store after consent', () => {
    threadExecutionContextStorage.run(
      {
        projectId: 'project',
        threadId: 'source',
        projectRoot: '/repo',
        root: '/repo',
        checkoutMode: 'shared',
        branch: null,
      },
      () => {
        runWithActiveRunIdentity('source', () => {
          assert.equal(threadChatReadRoot('/store'), '/store/project/source')
          assert.equal(needsOtherThreadRead('/store/project/source/messages/a.md', '/store'), false)
          assert.equal(needsOtherThreadRead('/store/project/other/messages/a.md', '/store'), true)
          assert.equal(needsOtherThreadRead('/store/project/catalog.jsonl', '/store'), true)
          assert.equal(needsOtherThreadRead('/elsewhere/a.md', '/store'), false)
          setSetting('threadReadAccess', ['source'])
          assert.equal(threadChatReadRoot('/store'), '/store')
        })
      },
    )
  })
})
