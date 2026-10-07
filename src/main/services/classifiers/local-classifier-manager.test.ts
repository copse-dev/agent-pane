import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { afterEach, describe, it } from 'node:test'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'
import type { LocalClassifierStatus } from '@shared/local-classifiers.ts'
import {
  LocalClassifierManager,
  describeInstallFailure,
  type LocalClassifierDeps,
} from './local-classifier-manager.ts'
import { localClassifierEntry } from './local-server.mts'

const WINNOW_PORT = 8091

interface Fixture {
  manager: LocalClassifierManager
  saved: ClassifierProfile[]
  prepared: string[]
  /** Ports the fake machine is listening on. */
  listening: Set<number>
  installed: Set<string>
  available: Set<string>
  env: NodeJS.ProcessEnv
  profiles: ClassifierProfile[]
  prepareFailure: { message: string } | null
  freeBytes: number | null
  uninstalled: string[]
}

const children: Array<ReturnType<typeof spawn>> = []

function fixture(): Fixture {
  const env: NodeJS.ProcessEnv = {}
  const deps: LocalClassifierDeps = {
    prepare: async (name, spec) => {
      state.prepared.push(name)
      if (state.prepareFailure) throw new Error(state.prepareFailure.message)
      state.installed.add(name)
      return { root: '/cache', checkout: `/cache/${name}/${spec.revision}`, models: '/cache/m' }
    },
    isInstalled: async (name) => state.installed.has(name),
    portListening: async (port) => state.listening.has(port),
    programAvailable: async (program) => state.available.has(program),
    freeBytes: async () => state.freeBytes,
    uninstall: async (name) => {
      state.uninstalled.push(name)
      state.installed.delete(name)
    },
    // A real, harmless child: the manager only needs something it can start and kill.
    spawnServer: (command) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
      children.push(child)
      // The "server" begins accepting connections once it has started.
      state.listening.add(WINNOW_PORT)
      child.once('close', () => state.listening.delete(WINNOW_PORT))
      assert.ok(command.length > 0)
      return child
    },
    listProfiles: () => state.profiles,
    saveProfile: async (profile) => {
      state.saved.push(profile)
      state.profiles = [...state.profiles, profile]
    },
    env,
    sleep: async () => new Promise((resolve) => setTimeout(resolve, 5)),
  }
  const state: Fixture = {
    manager: new LocalClassifierManager(deps),
    saved: [],
    prepared: [],
    listening: new Set(),
    installed: new Set(),
    available: new Set(['git', 'python3', 'uv']),
    env,
    profiles: [],
    prepareFailure: null,
    freeBytes: null,
    uninstalled: [],
  }
  return state
}

async function winnow(f: Fixture): Promise<LocalClassifierStatus> {
  const found = (await f.manager.overview()).servers.find((server) => server.id === 'winnow')
  assert.ok(found)
  return found
}

async function until(
  f: Fixture,
  predicate: (status: LocalClassifierStatus) => boolean,
): Promise<LocalClassifierStatus> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await winnow(f)
    if (predicate(status)) return status
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out; last status ${JSON.stringify(await winnow(f))}`)
}

describe('LocalClassifierManager', () => {
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
  })

  it('reports each server as not installed, installed, or already running', async () => {
    const f = fixture()
    assert.equal((await winnow(f)).phase, 'not-installed')
    f.installed.add('winnow')
    assert.equal((await winnow(f)).phase, 'installed')
    f.listening.add(WINNOW_PORT)
    const detected = await winnow(f)
    assert.equal(detected.phase, 'external')
    assert.equal(detected.saved, false)
    assert.equal(detected.baseUrl, 'http://127.0.0.1:8091/v1')
  })

  it('names missing prerequisites without downloading anything', async () => {
    const f = fixture()
    f.available.delete('python3')
    assert.deepEqual((await winnow(f)).missing, ['python3'])
    await f.manager.install('winnow')
    const failed = await until(f, (status) => status.error !== undefined)
    assert.match(failed.error ?? '', /python3/)
    assert.deepEqual(f.prepared, [])
  })

  it('installs, starts, saves the preset connection, and stops again', async () => {
    const f = fixture()
    await f.manager.install('winnow')
    const running = await until(f, (status) => status.phase === 'running' && status.saved)
    assert.deepEqual(f.prepared, ['winnow'])
    assert.equal(f.saved.length, 1)
    assert.equal(f.saved[0]?.id, 'winnow')
    assert.equal(running.error, undefined)

    await f.manager.stop('winnow')
    const stopped = await until(f, (status) => status.phase === 'installed')
    assert.equal(stopped.saved, true)
    assert.equal(stopped.error, undefined)
  })

  it('refuses to start over a port something else is using', async () => {
    const f = fixture()
    f.installed.add('winnow')
    f.listening.add(WINNOW_PORT)
    assert.equal((await winnow(f)).phase, 'external')
    await f.manager.start('winnow')
    assert.equal((await winnow(f)).phase, 'external')
    assert.equal(children.length, 0)
  })

  it('records a failed setup and lets the person retry', async () => {
    const f = fixture()
    f.prepareFailure = { message: 'pip exploded' }
    await f.manager.install('winnow')
    const failed = await until(f, (status) => status.error !== undefined)
    assert.equal(failed.phase, 'not-installed')
    assert.match(failed.error ?? '', /pip exploded/)
    f.prepareFailure = null
    await f.manager.install('winnow')
    await until(f, (status) => status.phase === 'running')
  })

  it('stops before downloading when something already listens on the port', async () => {
    const f = fixture()
    f.listening.add(WINNOW_PORT)
    // `external` offers no install button; a race still must not start a 12 GB download.
    await f.manager.install('winnow')
    const failed = await until(f, (status) => status.error !== undefined)
    assert.match(failed.error ?? '', /Port 8091 is already in use/)
    assert.match(failed.error ?? '', /nothing was downloaded/i)
    assert.deepEqual(f.prepared, [])
  })

  it('refuses a download the disk cannot hold, and allows one that fits or is unknown', async () => {
    const f = fixture()
    f.freeBytes = 1e9
    await f.manager.install('winnow')
    const failed = await until(f, (status) => status.error !== undefined)
    assert.match(failed.error ?? '', /Not enough free disk space for Winnow-12B/)
    assert.match(failed.error ?? '', /COPSE_CLASSIFIER_CACHE/)
    assert.deepEqual(f.prepared, [])
    f.freeBytes = 40e9
    await f.manager.install('winnow')
    await until(f, (status) => status.phase === 'running')
    assert.deepEqual(f.prepared, ['winnow'])
  })

  it('does not check the disk when the server is already set up', async () => {
    const f = fixture()
    f.installed.add('winnow')
    f.freeBytes = 1
    await f.manager.install('winnow')
    await until(f, (status) => status.phase === 'running')
  })

  it('reads a failed download as offline, out of space, or an unfetchable pinned version', async () => {
    const entry = localClassifierEntry('winnow')
    assert.ok(entry)
    assert.match(
      describeInstallFailure(
        new Error(
          "git clone exited with 128: fatal: unable to access '…': Could not resolve host: github.com",
        ),
        entry,
      ),
      /Could not reach the network .* Check your connection/,
    )
    assert.match(
      describeInstallFailure(
        new Error('python3 scripts/setup.py exited with 1: No space left on device'),
        entry,
      ),
      /ran out of disk space/,
    )
    assert.match(
      describeInstallFailure(
        new Error(
          "git fetch --quiet origin 77d1… exited with 128: fatal: couldn't find remote ref 77d1",
        ),
        entry,
      ),
      /Could not fetch the pinned version of Winnow-12B \(77d14580c673\)/,
    )
    assert.equal(describeInstallFailure(new Error('pip exploded'), entry), 'pip exploded')
  })

  it('shows each failure on the row and clears it when the next attempt begins', async () => {
    const f = fixture()
    f.prepareFailure = { message: 'git clone exited with 128: Could not resolve host: github.com' }
    await f.manager.install('winnow')
    const offline = await until(f, (status) => status.error !== undefined)
    assert.match(offline.error ?? '', /Could not reach the network/)
    assert.equal(offline.phase, 'not-installed')
    f.prepareFailure = null
    await f.manager.install('winnow')
    const running = await until(f, (status) => status.phase === 'running')
    assert.equal(running.error, undefined)
  })

  it('uninstalls a stopped server and refuses while it runs', async () => {
    const f = fixture()
    await f.manager.install('winnow')
    await until(f, (status) => status.phase === 'running')
    await assert.rejects(f.manager.uninstall('winnow'), /Stop Winnow-12B before uninstalling/)
    assert.deepEqual(f.uninstalled, [])
    await f.manager.stop('winnow')
    await until(f, (status) => status.phase === 'installed')
    const after = await f.manager.uninstall('winnow')
    assert.deepEqual(f.uninstalled, ['winnow'])
    assert.equal(after.servers.find((server) => server.id === 'winnow')?.phase, 'not-installed')
    // The saved connection is left for the person to remove.
    assert.equal(after.servers.find((server) => server.id === 'winnow')?.saved, true)
  })

  it('refuses to uninstall a server something else is running', async () => {
    const f = fixture()
    f.installed.add('winnow')
    f.listening.add(WINNOW_PORT)
    await assert.rejects(f.manager.uninstall('winnow'), /is running on port 8091/)
    assert.deepEqual(f.uninstalled, [])
    await assert.rejects(f.manager.uninstall('../evil'), /Unknown local classifier/)
  })

  it('connects a detected server without installing it', async () => {
    const f = fixture()
    await assert.rejects(f.manager.connect('winnow'), /not running/)
    f.listening.add(WINNOW_PORT)
    const overview = await f.manager.connect('winnow')
    assert.equal(overview.servers.find((server) => server.id === 'winnow')?.saved, true)
    assert.deepEqual(f.prepared, [])
    // A second call does not save a duplicate.
    await f.manager.connect('winnow')
    assert.equal(f.saved.length, 1)
  })

  it('rejects ids outside the catalog', async () => {
    const f = fixture()
    await assert.rejects(f.manager.install('constructor'), /Unknown local classifier/)
    await assert.rejects(f.manager.start('../evil'), /Unknown local classifier/)
  })

  it('hints at a hosted preset only when its key is in the environment and no connection exists', async () => {
    const f = fixture()
    assert.deepEqual((await f.manager.overview()).hosted, [])
    f.env['TYPESAFE_API_KEY'] = 'secret-value'
    const hosted = (await f.manager.overview()).hosted
    assert.deepEqual(hosted, [
      { presetId: 'typesafe', label: 'TypeSafe / Jev', envVar: 'TYPESAFE_API_KEY' },
    ])
    assert.equal(JSON.stringify(hosted).includes('secret-value'), false)
    const preset = CLASSIFIER_PRESETS.find((entry) => entry.id === 'typesafe')
    assert.ok(preset)
    f.profiles = [preset]
    assert.deepEqual((await f.manager.overview()).hosted, [])
  })
})
