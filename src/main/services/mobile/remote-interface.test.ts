import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteInterface } from './remote-interface.ts'
import type { RemoteRead, RemoteView } from '../../../shared/remote-interface.ts'

const request: RemoteRead = { version: 1, channel: 'agent:running-thread-ids', args: [] }

describe('remote desktop relay', () => {
  it('rejects unauthenticated reads before desktop dispatch', async () => {
    const host = new RemoteInterface()
    let delivered = 0
    host.attach(() => {
      delivered++
    })
    await assert.rejects(
      host.read(request, () => false),
      /revoked/,
    )
    assert.equal(delivered, 0)
  })

  it('correlates replies and rechecks revocation before returning data', async () => {
    const host = new RemoteInterface()
    let allowed = true
    let replyId = ''
    host.attach((id) => {
      replyId = id
    })
    const read = host.read(request, () => allowed)
    allowed = false
    host.reply({ id: replyId, ok: true, value: ['private-thread'] })
    await assert.rejects(read, /revoked/)
  })

  it('rejects in-flight reads when the owning desktop closes', async () => {
    const host = new RemoteInterface()
    const detach = host.attach(() => {})
    const pending = host.read(request, () => true)
    detach()
    await assert.rejects(pending, /closed/)
    await assert.rejects(
      host.read(request, () => true),
      /Open the Copse/,
    )
  })

  it('replies exactly once and ignores a late or unknown response', async () => {
    const host = new RemoteInterface()
    let replyId = ''
    host.attach((id) => {
      replyId = id
    })
    const pending = host.read(request, () => true)
    host.reply({ id: 'unknown', ok: true, value: 'wrong' })
    host.reply({ id: replyId, ok: true, value: ['t'] })
    host.reply({ id: replyId, ok: true, value: ['duplicate'] })
    assert.deepEqual(await pending, ['t'])
  })

  it('narrows a snapshot to the project and thread a client is showing', () => {
    const host = new RemoteInterface()
    host.attach(() => {})
    const thread = (id: string, messages: string[]): RemoteView['threads'][number] => ({
      id,
      title: id,
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: messages.map((content, index) => ({
        id: `${id}-${String(index)}`,
        role: 'user',
        content,
        toolCalls: [],
        createdAt: 1,
      })),
    })
    host.publish({
      projectId: 'p',
      threads: [thread('open', ['hello']), thread('sibling', ['long']), thread('blank', [])],
    })
    host.publish({ projectId: 'q', threads: [thread('other', ['elsewhere'])] })

    assert.deepEqual(
      host.snapshot().views.map((view) => view.projectId),
      ['p', 'q'],
    )
    const project = host.snapshot({ projectId: 'p' })
    assert.deepEqual(project.views, [host.snapshot().views[0]], 'the whole view of one project')

    const [view] = host.snapshot({ projectId: 'p', threadId: 'open' }).views
    assert.deepEqual(
      view?.threads.map((item) => [item.id, item.messages.length, item.messagesLoaded]),
      [
        ['open', 1, undefined],
        // A sibling keeps its row and drops its transcript, as an unopened thread does.
        ['sibling', 0, false],
        // Nothing to drop, so nothing claims to be unloaded.
        ['blank', 0, undefined],
      ],
    )
    assert.equal(view.threads[1]?.title, 'sibling')
    assert.deepEqual(host.snapshot({ projectId: 'unknown' }).views, [])
    assert.equal(host.snapshot({ projectId: 'p', threadId: 'gone' }).views[0]?.threads.length, 3)
  })

  it('returns the same snapshot until something is published', () => {
    const host = new RemoteInterface()
    host.attach(() => {})
    host.publish({ projectId: 'p', threads: [] })
    const scope = { projectId: 'p', threadId: 't' }
    const before = host.snapshot(scope)
    assert.equal(host.snapshot(scope), before)
    assert.equal(host.snapshot(), host.snapshot())
    assert.notEqual(host.snapshot({ projectId: 'p' }), before)
    host.publish({ projectId: 'p', threads: [] })
    const after = host.snapshot(scope)
    assert.notEqual(after, before)
    assert.ok(after.revision > before.revision)
    // A client naming ever more scopes cannot grow the memo without bound.
    for (let index = 0; index < 50; index++) host.snapshot({ projectId: `p${String(index)}` })
    assert.equal(host.snapshot(scope).revision, after.revision)
  })

  it('changes session identity and clears snapshots when the owner changes', () => {
    const host = new RemoteInterface()
    host.attach(() => {})
    host.publish({ projectId: 'p', threads: [] })
    const before = host.snapshot()
    host.attach(() => {})
    const after = host.snapshot()
    assert.notEqual(before.sessionId, after.sessionId)
    assert.deepEqual(after.views, [])
    assert.ok(after.revision > before.revision)
  })
})
