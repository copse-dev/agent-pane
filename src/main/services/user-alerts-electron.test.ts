import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPEN_THREAD_FROM_ALERT_CHANNEL,
  openUserAlertTarget,
  shouldSendSystemNotification,
  startWindowAttention,
  type AlertClickWindow,
  type DockAttention,
  type WindowAttention,
} from './user-alerts-electron.ts'

function fakeWindow(): {
  win: WindowAttention
  flashes: boolean[]
  focus(): void
} {
  const flashes: boolean[] = []
  let focusListener: (() => void) | null = null
  return {
    flashes,
    win: {
      flashFrame: (flag) => flashes.push(flag),
      once: (_event, listener): void => {
        focusListener = listener
      },
      removeListener: (_event, listener): void => {
        if (focusListener === listener) focusListener = null
      },
      isDestroyed: () => false,
    },
    focus: () => focusListener?.(),
  }
}

describe('shouldSendSystemNotification', () => {
  it('only sends while the Copse window is hidden', () => {
    assert.equal(
      shouldSendSystemNotification({ isDestroyed: () => false, isVisible: () => true }),
      false,
    )
    assert.equal(
      shouldSendSystemNotification({ isDestroyed: () => false, isVisible: () => false }),
      true,
    )
    assert.equal(
      shouldSendSystemNotification({ isDestroyed: () => true, isVisible: () => false }),
      false,
    )
  })
})

describe('startWindowAttention', () => {
  it('uses a critical Dock bounce for interaction and stops it once', () => {
    const target = fakeWindow()
    const calls: string[] = []
    const dock: DockAttention = {
      bounce: (type) => {
        calls.push(`bounce:${String(type)}`)
        return 42
      },
      cancelBounce: (id) => calls.push(`cancel:${String(id)}`),
    }

    const stop = startWindowAttention(target.win, dock, 'interaction')
    stop()
    stop()

    assert.deepEqual(calls, ['bounce:critical', 'cancel:42'])
    assert.deepEqual(target.flashes, [])
  })

  it('uses an informational bounce for completion and stops on focus', () => {
    const target = fakeWindow()
    const calls: string[] = []
    const dock: DockAttention = {
      bounce: (type) => {
        calls.push(`bounce:${String(type)}`)
        return 7
      },
      cancelBounce: (id) => calls.push(`cancel:${String(id)}`),
    }

    startWindowAttention(target.win, dock, 'thread-finished')
    target.focus()

    assert.deepEqual(calls, ['bounce:informational', 'cancel:7'])
  })

  it('flashes the taskbar when no Dock is available and clears on focus', () => {
    const target = fakeWindow()

    startWindowAttention(target.win, undefined, 'interaction')
    target.focus()

    assert.deepEqual(target.flashes, [true, false])
  })
})

interface FakeClickWindow extends AlertClickWindow {
  name: string
  calls: string[]
  sent: unknown[][]
}

function clickWindow(
  name: string,
  state: { destroyed?: boolean; visible?: boolean; minimized?: boolean } = {},
): FakeClickWindow {
  const calls: string[] = []
  const sent: unknown[][] = []
  return {
    name,
    calls,
    sent,
    isDestroyed: () => state.destroyed ?? false,
    isVisible: () => state.visible ?? true,
    isMinimized: () => state.minimized ?? false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: { send: (channel, ...args) => sent.push([channel, ...args]) },
  }
}

describe('openUserAlertTarget', () => {
  it('focuses the owning window and asks it to open the thread in its stored project', async () => {
    const owner = clickWindow('owner')
    const other = clickWindow('other')
    const looked: string[] = []

    const used = await openUserAlertTarget(
      owner,
      () => other,
      'thread-1',
      async (threadId) => {
        looked.push(threadId)
        return 'project-1'
      },
    )

    assert.equal(used, owner)
    assert.deepEqual(owner.calls, ['focus'])
    assert.deepEqual(owner.sent, [
      [OPEN_THREAD_FROM_ALERT_CHANNEL, { threadId: 'thread-1', projectId: 'project-1' }],
    ])
    assert.deepEqual(looked, ['thread-1'])
    assert.deepEqual(other.sent, [], 'another window never receives the thread')
  })

  it('restores and shows a minimized, hidden owner before focusing it', async () => {
    const owner = clickWindow('owner', { visible: false, minimized: true })

    await openUserAlertTarget(
      owner,
      () => null,
      'thread-1',
      async () => null,
    )

    assert.deepEqual(owner.calls, ['restore', 'show', 'focus'])
    assert.deepEqual(owner.sent, [
      [OPEN_THREAD_FROM_ALERT_CHANNEL, { threadId: 'thread-1', projectId: null }],
    ])
  })

  it('opens the thread in the fallback window once the owner has closed', async () => {
    const owner = clickWindow('owner', { destroyed: true })
    const fallback = clickWindow('fallback')

    const used = await openUserAlertTarget(
      owner,
      () => fallback,
      'thread-2',
      async () => 'p',
    )

    assert.equal(used, fallback)
    assert.deepEqual(owner.calls, [])
    assert.deepEqual(fallback.sent, [
      [OPEN_THREAD_FROM_ALERT_CHANNEL, { threadId: 'thread-2', projectId: 'p' }],
    ])
  })

  it('only focuses the window for an alert that is not about a thread', async () => {
    const owner = clickWindow('owner')
    let looked = false

    await openUserAlertTarget(
      owner,
      () => null,
      undefined,
      async () => {
        looked = true
        return 'p'
      },
    )

    assert.deepEqual(owner.calls, ['focus'])
    assert.deepEqual(owner.sent, [])
    assert.equal(looked, false)
  })

  it('still opens the thread when the project lookup fails', async () => {
    const owner = clickWindow('owner')

    await openUserAlertTarget(
      owner,
      () => null,
      'thread-3',
      () => Promise.reject(new Error('disk')),
    )

    assert.deepEqual(owner.sent, [
      [OPEN_THREAD_FROM_ALERT_CHANNEL, { threadId: 'thread-3', projectId: null }],
    ])
  })

  it('does nothing when no window is left', async () => {
    const owner = clickWindow('owner', { destroyed: true })
    assert.equal(
      await openUserAlertTarget(
        owner,
        () => null,
        'thread-4',
        async () => 'p',
      ),
      null,
    )
  })
})
