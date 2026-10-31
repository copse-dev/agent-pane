import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkspaceNavigation } from './workspace-navigation.ts'

function fixture(): {
  invoke: ReturnType<typeof createWorkspaceNavigation>
  calls: string[]
  release: (path: string) => void
  fail: (path: string) => void
} {
  const calls: string[] = []
  const pending = new Map<string, { resolve: () => void; reject: () => void }>()
  const invoke = createWorkspaceNavigation((channel, ...args) => {
    const path = typeof args[0] === 'string' ? args[0] : ''
    calls.push(`${channel}:${path}`)
    if (channel !== 'workspace:set') return Promise.resolve(null)
    return new Promise<void>((resolve, reject) => {
      pending.set(path, {
        resolve,
        reject: () => {
          reject(new Error('missing folder'))
        },
      })
    })
  })
  return {
    invoke,
    calls,
    release: (path) => pending.get(path)?.resolve(),
    fail: (path) => pending.get(path)?.reject(),
  }
}

test('workspace actions wait but project-owned transcript reads do not', async () => {
  const f = fixture()
  const selecting = f.invoke('workspace:set', '/b')
  const file = f.invoke('fs:readFile', 'file.ts')
  await f.invoke('threads:load-messages', 'b', 'thread')
  assert.deepEqual(f.calls, ['workspace:set:/b', 'threads:load-messages:b'])
  f.release('/b')
  await Promise.all([selecting, file])
  assert.equal(f.calls.at(-1), 'fs:readFile:file.ts')
})

test('rapid selections run in order and discard actions for superseded workspaces', async () => {
  const f = fixture()
  const b = f.invoke('workspace:set', '/b')
  const staleAction = assert.rejects(f.invoke('git:stage', 'file.ts'), /selection changed/)
  const a = f.invoke('workspace:set', '/a')
  const latestAction = f.invoke('fs:readFile', 'latest.ts')
  assert.deepEqual(f.calls, ['workspace:set:/b'])
  f.release('/b')
  await b
  await staleAction
  assert.deepEqual(f.calls, ['workspace:set:/b', 'workspace:set:/a'])
  f.release('/a')
  await Promise.all([a, latestAction])
  assert.equal(f.calls.at(-1), 'fs:readFile:latest.ts')
  assert.ok(!f.calls.some((call) => call.startsWith('git:stage')))
})

test('failed activation cannot send actions to the old root and recovery releases the barrier', async () => {
  const f = fixture()
  const selecting = assert.rejects(f.invoke('workspace:set', '/missing'), /missing folder/)
  const unsafeAction = assert.rejects(f.invoke('fs:writeFile', 'file.ts'), /missing folder/)
  f.fail('/missing')
  await Promise.all([selecting, unsafeAction])
  await assert.rejects(f.invoke('fs:readFile', 'file.ts'), /missing folder/)
  const recovery = f.invoke('workspace:set', '/a')
  await Promise.resolve()
  await Promise.resolve()
  f.release('/a')
  await recovery
  await f.invoke('fs:readFile', 'file.ts')
  assert.equal(f.calls.at(-1), 'fs:readFile:file.ts')
  assert.ok(!f.calls.includes('fs:writeFile:file.ts'))
})

test('project-store reads also wait for navigation persistence after the root is ready', async () => {
  let finishNavigation = (): void => undefined
  const calls: string[] = []
  const invoke = createWorkspaceNavigation((channel) => {
    calls.push(channel)
    return channel === 'main-window:set-navigation'
      ? new Promise<void>((resolve) => {
          finishNavigation = resolve
        })
      : Promise.resolve(null)
  })
  const writing = invoke('main-window:set-navigation', { activeProjectId: 'b' })
  await invoke('workspace:set', '/b')
  const roadmap = invoke('roadmap:list')
  await Promise.resolve()
  assert.deepEqual(calls, ['main-window:set-navigation', 'workspace:set'])
  finishNavigation()
  await Promise.all([writing, roadmap])
  assert.equal(calls.at(-1), 'roadmap:list')
})

test('queued workspace activations coalesce so intermediate projects do no setup work', async () => {
  const f = fixture()
  const first = f.invoke('workspace:set', '/first')
  const skipped = assert.rejects(f.invoke('workspace:set', '/intermediate'), /superseded/)
  const last = f.invoke('workspace:set', '/last')
  f.release('/first')
  await first
  await skipped
  await Promise.resolve()
  assert.deepEqual(f.calls, ['workspace:set:/first', 'workspace:set:/last'])
  f.release('/last')
  await last
})

test('SSH authentication replies bypass the activation that is waiting for them', async () => {
  const f = fixture()
  const connecting = f.invoke('workspace:set', '/remote', 'host')
  await f.invoke('ssh-prompt:respond', 'request-id', 'yes')
  assert.deepEqual(f.calls, ['workspace:set:/remote', 'ssh-prompt:respond:request-id'])
  f.release('/remote')
  await connecting
})

test('a slow remote activation cannot delay actions in a newer local selection', async () => {
  const f = fixture()
  const remote = f.invoke('workspace:set', '/remote', 'host')
  const local = f.invoke('workspace:set', '/local')
  const file = f.invoke('fs:readFile', 'local.ts')
  await Promise.resolve()
  f.release('/local')
  await Promise.all([local, file])
  assert.equal(f.calls.at(-1), 'fs:readFile:local.ts')
  f.release('/remote')
  await remote
})
