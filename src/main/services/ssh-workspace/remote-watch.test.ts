import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { deleteSetting, setSetting } from '../storage/settings.ts'
import {
  setRemoteWatchNativeForTest,
  stopAllRemoteWatchers,
  unwatchRemoteFile,
  watchRemoteFile,
} from './remote-watch.ts'
import { pollRemoteFilesOnce, setRemotePollExecForTest } from './remote-file-poller.ts'
import { setNativeWatcherDepsForTest } from './remote-native-watcher.ts'

const TARGET = { hostId: 'dev', remoteRoot: '/srv/app', absPath: '/srv/app/a.ts' }

/** Count poller stat execs; entries in the poller show up as commands here. */
function fakePollExec(): { commands: string[] } {
  const commands: string[] = []
  setRemotePollExecForTest((_hostId, _root, command) => {
    commands.push(command)
    return Promise.resolve({ stdout: '' })
  })
  return { commands }
}

/** Native deps that always fail resolution, counting the attempts. */
function nativeNeverAvailable(): { attempts: () => number } {
  let attempts = 0
  setNativeWatcherDepsForTest({
    getPlatform: () => {
      attempts += 1
      return { os: 'Linux', arch: 'x86_64' }
    },
    resolveBinaryPath: () => null,
  })
  return { attempts: () => attempts }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

afterEach(async () => {
  stopAllRemoteWatchers()
  setRemotePollExecForTest(null)
  setRemoteWatchNativeForTest(null)
  setNativeWatcherDepsForTest(null)
  await deleteSetting('sshWatcherMode')
})

describe('remote watch coordinator', () => {
  it('mode off subscribes nothing', async () => {
    await setSetting('sshWatcherMode', 'off')
    const poll = fakePollExec()
    const native = nativeNeverAvailable()
    watchRemoteFile('k1', TARGET, () => undefined)
    await settle()
    await pollRemoteFilesOnce()
    assert.equal(poll.commands.length, 0)
    assert.equal(native.attempts(), 0)
  })

  it('mode poll goes straight to the poller without touching the native path', async () => {
    await setSetting('sshWatcherMode', 'poll')
    const poll = fakePollExec()
    const native = nativeNeverAvailable()
    watchRemoteFile('k1', TARGET, () => undefined)
    await settle()
    await pollRemoteFilesOnce()
    assert.equal(poll.commands.length, 1)
    assert.equal(native.attempts(), 0)
  })

  it('mode auto falls back to the poller when the native path is unavailable', async () => {
    const poll = fakePollExec()
    const native = nativeNeverAvailable()
    watchRemoteFile('k1', TARGET, () => undefined)
    await settle()
    await pollRemoteFilesOnce()
    assert.equal(native.attempts(), 1)
    assert.equal(poll.commands.length, 1)
  })

  it('unwatch clears the key from whichever backend holds it', async () => {
    const poll = fakePollExec()
    nativeNeverAvailable()
    watchRemoteFile('k1', TARGET, () => undefined)
    await settle()
    unwatchRemoteFile('k1')
    await pollRemoteFilesOnce()
    assert.equal(poll.commands.length, 0)
  })

  it('polls during native setup and does not resurrect an unwatched key', async () => {
    const poll = fakePollExec()
    let finishNative: ((accepted: boolean) => void) | undefined
    let stillRequested: (() => boolean) | undefined
    setRemoteWatchNativeForTest((_key, _target, _onChange, _onFallback, isActive) => {
      stillRequested = isActive
      return new Promise<boolean>((resolve) => {
        finishNative = resolve
      })
    })

    watchRemoteFile('k1', TARGET, () => undefined)
    await pollRemoteFilesOnce()
    assert.equal(poll.commands.length, 1, 'polling covers the native setup window')

    unwatchRemoteFile('k1')
    assert.equal(stillRequested?.(), false)
    assert.ok(finishNative)
    finishNative(true)
    await settle()
    await pollRemoteFilesOnce()
    assert.equal(poll.commands.length, 1, 'the stale completion must not re-subscribe')
  })

  it('drops the setup poll once the native watcher is ready', async () => {
    const poll = fakePollExec()
    setRemoteWatchNativeForTest((_key, _target, _onChange, _onFallback, _isActive, onWatching) => {
      onWatching?.('k1')
      return Promise.resolve(true)
    })
    watchRemoteFile('k1', TARGET, () => undefined)
    await settle()
    await pollRemoteFilesOnce()
    assert.equal(poll.commands.length, 0)
  })
})
