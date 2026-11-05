import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runWithActiveRunIdentity } from '../active-run-identity.ts'
import { threadExecutionContextStorage } from '../thread-execution-context-store.ts'
import { runWithApprovalHandler } from '../approval.ts'
import { setSetting } from '../storage/settings.ts'
import {
  ensureChatStoreRead,
  ensureThreadAccess,
  hasThreadAccess,
  needsOtherThreadRead,
  revokeThreadAccess,
  threadChatReadRoots,
} from './thread-access.ts'

describe('conversation access', () => {
  afterEach(async () => {
    await setSetting('threadReadAccess', [])
    await setSetting('threadSendAccess', [])
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

  for (const access of ['read', 'send'] as const) {
    for (const cancelled of [0, 1] as const) {
      it(`${access}: cancelling waiter ${String(cancelled)} preserves its live sibling`, async () => {
        const shown = Promise.withResolvers<boolean>()
        const answer = Promise.withResolvers<{ approved: boolean; remember: boolean }>()
        const controllers = [new AbortController(), new AbortController()] as const
        let prompts = 0
        await runWithApprovalHandler(
          () => {
            prompts++
            shown.resolve(true)
            return answer.promise
          },
          () =>
            runWithActiveRunIdentity('concurrent', async () => {
              const first = ensureThreadAccess(access, controllers[0].signal)
              await shown.promise
              const second = ensureThreadAccess(access, controllers[1].signal)
              // Let the approval service register the second independent waiter.
              await new Promise<void>((resolve) => setImmediate(resolve))
              controllers[cancelled].abort()
              answer.resolve({ approved: true, remember: false })
              assert.deepEqual(
                await Promise.all([first, second]),
                cancelled === 0 ? [false, true] : [true, false],
              )
              assert.equal(hasThreadAccess('concurrent', access), true)
            }),
        )
        assert.equal(prompts, 1)
      })
    }

    it(`${access}: cancelling every waiter never records a grant`, async () => {
      const shown = Promise.withResolvers<boolean>()
      const answer = Promise.withResolvers<{ approved: boolean; remember: boolean }>()
      const controllers = [new AbortController(), new AbortController()] as const
      await runWithApprovalHandler(
        () => {
          shown.resolve(true)
          return answer.promise
        },
        () =>
          runWithActiveRunIdentity('all-cancelled', async () => {
            const first = ensureThreadAccess(access, controllers[0].signal)
            await shown.promise
            const second = ensureThreadAccess(access, controllers[1].signal)
            await new Promise<void>((resolve) => setImmediate(resolve))
            controllers.forEach((controller) => {
              controller.abort()
            })
            answer.resolve({ approved: true, remember: false })
            assert.deepEqual(await Promise.all([first, second]), [false, false])
            assert.equal(hasThreadAccess('all-cancelled', access), false)
          }),
      )
    })
  }

  it('simultaneous requests from different chats require separate answers', async () => {
    const answers = [
      Promise.withResolvers<{ approved: boolean; remember: boolean }>(),
      Promise.withResolvers<{ approved: boolean; remember: boolean }>(),
    ] as const
    let prompts = 0
    await runWithApprovalHandler(
      () => {
        const answer = answers[prompts++]
        assert.ok(answer)
        return answer.promise
      },
      async () => {
        const first = runWithActiveRunIdentity('first-chat', () => ensureThreadAccess('read'))
        const second = runWithActiveRunIdentity('second-chat', () => ensureThreadAccess('read'))
        await new Promise<void>((resolve) => setImmediate(resolve))
        answers[0].resolve({ approved: true, remember: false })
        answers[1].resolve({ approved: false, remember: false })
        assert.deepEqual(await Promise.all([first, second]), [true, false])
        assert.equal(hasThreadAccess('first-chat', 'read'), true)
        assert.equal(hasThreadAccess('second-chat', 'read'), false)
      },
    )
    assert.equal(prompts, 2)
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
    await setSetting('threadReadAccess', ['source', 'other'])
    await setSetting('threadSendAccess', ['source'])
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

  it('confines an unapproved run to its own transcript and grants the whole store after consent', async () => {
    await threadExecutionContextStorage.run(
      {
        projectId: 'project',
        threadId: 'source',
        projectRoot: '/repo',
        root: '/repo',
        checkoutMode: 'shared',
        branch: null,
      },
      () =>
        runWithActiveRunIdentity('source', async () => {
          assert.deepEqual(threadChatReadRoots('/store'), ['/store/project/source'])
          assert.equal(needsOtherThreadRead('/store/project/source/messages/a.md', '/store'), false)
          assert.equal(needsOtherThreadRead('/store/project/other/messages/a.md', '/store'), true)
          assert.equal(needsOtherThreadRead('/store/project/catalog.jsonl', '/store'), true)
          assert.equal(needsOtherThreadRead('/elsewhere/a.md', '/store'), false)
          await setSetting('threadReadAccess', ['source'])
          assert.deepEqual(threadChatReadRoots('/store'), ['/store'])
        }),
    )
  })

  it('lets a follow-up read only its declared parent without consent', () => {
    threadExecutionContextStorage.run(
      {
        projectId: 'project',
        threadId: 'child',
        projectRoot: '/repo',
        root: '/repo',
        checkoutMode: 'shared',
        branch: null,
        followUpParentThreadId: 'parent',
      },
      () => {
        runWithActiveRunIdentity('child', () => {
          assert.deepEqual(threadChatReadRoots('/store'), [
            '/store/project/child',
            '/store/project/parent',
          ])
          assert.equal(needsOtherThreadRead('/store/project/parent/messages/a.md', '/store'), false)
          assert.equal(needsOtherThreadRead('/store/project/child/messages/a.md', '/store'), false)
          assert.equal(needsOtherThreadRead('/store/project/grandparent/meta.json', '/store'), true)
          assert.equal(
            needsOtherThreadRead('/store/other-project/parent/meta.json', '/store'),
            true,
          )
          assert.equal(needsOtherThreadRead('/store/project/catalog.jsonl', '/store'), true)
        })
      },
    )
  })
})
