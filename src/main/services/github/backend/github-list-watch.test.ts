import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  GITHUB_LIST_WATCH_INTERVAL_MS,
  gitHubListWatchSnapshotForTest,
  notifyGitHubListWatchers,
  resetGitHubListWatchForTest,
  setGitHubListWatch,
  setGitHubListWatchBroadcast,
  setGitHubListWatchDepsForTest,
} from './github-list-watch.ts'
import {
  broadcastToAppWindows,
  registerAppWindow,
  resetAppWindowsForTest,
  type AppWindowWebContents,
} from '../../../windows/app-window-broadcast.ts'

interface FakeWindow extends AppWindowWebContents {
  sent: { channel: string; args: unknown[] }[]
}

function fakeWindow(): FakeWindow {
  return {
    sent: [],
    send(channel: string, ...args: unknown[]): void {
      this.sent.push({ channel, args })
    },
    isDestroyed: () => false,
  }
}

function installFakeTimer(): { ticks: number; fire: () => void } {
  let handler: (() => void) | null = null
  const state = {
    ticks: 0,
    fire(): void {
      if (!handler) throw new Error('timer is not armed')
      handler()
    },
  }
  setGitHubListWatchDepsForTest({
    setInterval: (next: () => void): number => {
      handler = next
      return 1
    },
    clearInterval: (): void => {
      handler = null
    },
    broadcast: (): void => {
      state.ticks++
    },
  })
  return state
}

afterEach((): void => {
  resetGitHubListWatchForTest()
  resetAppWindowsForTest()
})

describe('github list watch', () => {
  it('arms one timer for two watchers and broadcasts once per tick', () => {
    const timer = installFakeTimer()
    setGitHubListWatch(1, true, false)
    setGitHubListWatch(2, true, true)
    assert.deepEqual(gitHubListWatchSnapshotForTest(), {
      watcherCount: 2,
      includeMyPrs: true,
      timerArmed: true,
    })
    timer.fire()
    timer.fire()
    assert.equal(timer.ticks, 2)
  })

  it('stops the timer when the last watcher unwatches', () => {
    const timer = installFakeTimer()
    setGitHubListWatch(1, true, false)
    setGitHubListWatch(2, true, false)
    setGitHubListWatch(1, false, false)
    assert.equal(gitHubListWatchSnapshotForTest().timerArmed, true)
    setGitHubListWatch(2, false, false)
    assert.deepEqual(gitHubListWatchSnapshotForTest(), {
      watcherCount: 0,
      includeMyPrs: false,
      timerArmed: false,
    })
    assert.throws(() => {
      timer.fire()
    }, /timer is not armed/)
  })

  it('does not reset the cadence when a second window starts watching', () => {
    const timer = installFakeTimer()
    setGitHubListWatch(1, true, false)
    timer.fire()
    setGitHubListWatch(2, true, false)
    assert.equal(gitHubListWatchSnapshotForTest().timerArmed, true)
    assert.equal(timer.ticks, 1, 'joining a watcher must not fire an extra tick')
  })

  it('unions includeMyPrs across watchers and drops it when that pane unwatches', () => {
    installFakeTimer()
    setGitHubListWatch(1, true, false)
    setGitHubListWatch(2, true, true)
    assert.equal(gitHubListWatchSnapshotForTest().includeMyPrs, true)
    setGitHubListWatch(2, true, false)
    assert.equal(gitHubListWatchSnapshotForTest().includeMyPrs, false)
  })

  it('skips broadcast when nobody is watching', () => {
    const timer = installFakeTimer()
    notifyGitHubListWatchers()
    assert.equal(timer.ticks, 0)
  })

  it('fans a tick to every app window on the default broadcast path', () => {
    setGitHubListWatchDepsForTest({
      setInterval: (): number => 1,
      clearInterval: (): void => undefined,
      broadcast: (): void => undefined,
    })
    setGitHubListWatchBroadcast(() => {
      broadcastToAppWindows('gh:lists_tick')
    })
    const main = fakeWindow()
    const popout = fakeWindow()
    registerAppWindow(main)
    registerAppWindow(popout)
    setGitHubListWatch(1, true, false)
    notifyGitHubListWatchers()
    for (const win of [main, popout]) {
      assert.deepEqual(win.sent, [{ channel: 'gh:lists_tick', args: [] }])
    }
  })

  it('uses the shared 30s interval', () => {
    assert.equal(GITHUB_LIST_WATCH_INTERVAL_MS, 30_000)
  })
})
