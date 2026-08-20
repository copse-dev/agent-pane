import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  GITHUB_LIST_WATCH_INTERVAL_MS,
  gitHubListWatchSnapshotForTest,
  notifyGitHubListWatchers,
  resetGitHubListWatchForTest,
  setGitHubListWatch,
  setGitHubListWatchBroadcast,
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
    isDestroyed: (): boolean => false,
  }
}

function countBroadcasts(): { ticks: number } {
  const state = { ticks: 0 }
  setGitHubListWatchBroadcast((): void => {
    state.ticks++
  })
  return state
}

afterEach((): void => {
  resetGitHubListWatchForTest()
  resetAppWindowsForTest()
  mock.timers.reset()
})

describe('github list watch', () => {
  it('arms one timer for two watchers and broadcasts once per tick', (): void => {
    mock.timers.enable({ apis: ['setInterval'] })
    const ticks = countBroadcasts()
    setGitHubListWatch(1, true, false)
    setGitHubListWatch(2, true, true)
    assert.deepEqual(gitHubListWatchSnapshotForTest(), {
      watcherCount: 2,
      includeMyPrs: true,
      timerArmed: true,
    })
    mock.timers.tick(GITHUB_LIST_WATCH_INTERVAL_MS)
    mock.timers.tick(GITHUB_LIST_WATCH_INTERVAL_MS)
    assert.equal(ticks.ticks, 2)
  })

  it('stops the timer when the last watcher unwatches', (): void => {
    mock.timers.enable({ apis: ['setInterval'] })
    const ticks = countBroadcasts()
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
    mock.timers.tick(GITHUB_LIST_WATCH_INTERVAL_MS * 2)
    assert.equal(ticks.ticks, 0)
  })

  it('does not reset the cadence when a second window starts watching', (): void => {
    mock.timers.enable({ apis: ['setInterval'] })
    const ticks = countBroadcasts()
    setGitHubListWatch(1, true, false)
    mock.timers.tick(GITHUB_LIST_WATCH_INTERVAL_MS)
    setGitHubListWatch(2, true, false)
    assert.equal(gitHubListWatchSnapshotForTest().timerArmed, true)
    assert.equal(ticks.ticks, 1, 'joining a watcher must not fire an extra tick')
  })

  it('unions includeMyPrs across watchers and drops it when that pane unwatches', (): void => {
    mock.timers.enable({ apis: ['setInterval'] })
    setGitHubListWatch(1, true, false)
    setGitHubListWatch(2, true, true)
    assert.equal(gitHubListWatchSnapshotForTest().includeMyPrs, true)
    setGitHubListWatch(2, true, false)
    assert.equal(gitHubListWatchSnapshotForTest().includeMyPrs, false)
  })

  it('skips broadcast when nobody is watching', (): void => {
    const ticks = countBroadcasts()
    notifyGitHubListWatchers()
    assert.equal(ticks.ticks, 0)
  })

  it('fans a tick to every app window on the default broadcast path', (): void => {
    mock.timers.enable({ apis: ['setInterval'] })
    setGitHubListWatchBroadcast((): void => {
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

  it('uses the shared 30s interval', (): void => {
    assert.equal(GITHUB_LIST_WATCH_INTERVAL_MS, 30_000)
  })
})
