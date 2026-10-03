import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ThreadDeepLinks,
  type DeepLinkWindow,
  type ThreadDeepLinkTarget,
} from './thread-deep-links.ts'

const ID = '12345678-1234-1234-1234-123456789abc'
const NEXT = '22345678-1234-1234-1234-123456789abc'
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fixture(owners: (id: string) => Promise<string[]> = async () => ['project']): {
  links: ThreadDeepLinks
  sent: ThreadDeepLinkTarget[]
  actions: string[]
  open: () => void
} {
  const sent: ThreadDeepLinkTarget[] = []
  const actions: string[] = []
  const win: DeepLinkWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => {
      actions.push('restore')
    },
    show: () => {
      actions.push('show')
    },
    focus: () => {
      actions.push('focus')
    },
    webContents: {
      id: 1,
      send: (_channel, target) => {
        sent.push(target)
      },
    },
  }
  let current: DeepLinkWindow | null = null
  const links = new ThreadDeepLinks(() => current, owners)
  return {
    links,
    sent,
    actions,
    open: (): void => {
      current = win
    },
  }
}

describe('thread deep-link delivery', () => {
  it('queues a cold launch until the renderer has restored projects', async () => {
    const f = fixture()
    assert.equal(f.links.accept(`copse://thread/${ID}`), true)
    f.open()
    await tick()
    assert.deepEqual(f.sent, [])
    f.links.ready(1)
    await tick()
    assert.deepEqual(f.sent, [{ threadId: ID, projectId: 'project' }])
    assert.deepEqual(f.actions, ['restore', 'show', 'focus'])
  })

  it('delivers warm links but waits through renderer reloads', async () => {
    const f = fixture()
    f.open()
    f.links.ready(1)
    f.links.accept(`copse://thread/${ID}`)
    await tick()
    f.links.unready(1)
    f.links.accept(`copse://thread/${NEXT}`)
    await tick()
    assert.equal(f.sent.length, 1)
    f.links.ready(1)
    await tick()
    assert.equal(f.sent[1]?.threadId, NEXT)
  })

  it('reports missing or ambiguous owners without choosing another project', async () => {
    for (const owners of [[], ['a', 'b']]) {
      const f = fixture(async () => owners)
      f.open()
      f.links.ready(1)
      f.links.accept(`copse://thread/${ID}`)
      await tick()
      assert.deepEqual(f.sent, [{ threadId: ID, projectId: null }])
    }
  })

  it('ignores malformed URLs and superseded owner lookups', async () => {
    let finish: ((owners: string[]) => void) | undefined
    const f = fixture((id) =>
      id === ID
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(['project']),
    )
    f.open()
    f.links.ready(1)
    assert.equal(f.links.accept('copse://run/anything'), false)
    f.links.accept(`copse://thread/${ID}`)
    f.links.accept(`copse://thread/${NEXT}`)
    await tick()
    finish?.(['project'])
    await tick()
    assert.deepEqual(f.sent, [{ threadId: NEXT, projectId: 'project' }])
  })
})
