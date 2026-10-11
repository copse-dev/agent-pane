import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { classify } from '@copse/llm/classifiers/index.ts'
import { CLASSIFIER_PRESETS, CLASSIFIER_TEST_REQUEST } from '@copse/llm/classifiers/presets.ts'
import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'
import type { LocalClassifierStatus } from '@shared/local-classifiers.ts'
import {
  FAKE_WINNOW_PIN,
  writeFakeClassifierTools,
} from '../../../../tests/helpers/fake-classifier-tools.ts'
import {
  LocalClassifierManager,
  defaultSleep,
  spawnLocalServer,
} from './local-classifier-manager.ts'
import {
  freeDiskBytes,
  isClassifierInstalled,
  portListening,
  prepareClassifierCache,
  programAvailable,
  removeClassifierInstall,
} from './local-server.mts'

/**
 * "Download and run" with the real manager, the real cache preparation and real
 * child processes. The only fakes sit at the process boundary: `git`, `python3`
 * and `uv` are small Node scripts on a PATH that holds nothing else, and the
 * "server" they start is a real HTTP listener on Winnow's port. Nothing is
 * downloaded, and nothing in the product knows it is under test.
 */

const WINNOW_PORT = 8091
const PIN = FAKE_WINNOW_PIN

interface Machine {
  root: string
  cache: string
  log: () => string
  profiles: ClassifierProfile[]
  manager: LocalClassifierManager
  freeBytes: number | null
}

const ENV_KEYS = [
  'PATH',
  'COPSE_CLASSIFIER_CACHE',
  'FAKE_LOG',
  'FAKE_GIT_MODE',
  'FAKE_PY_MODE',
] as const

function machine(programs: readonly ('git' | 'python3')[] = ['git', 'python3']): Machine {
  const root = mkdtempSync(join(tmpdir(), 'copse-classifier-install-'))
  const binDir = join(root, 'bin')
  writeFakeClassifierTools(binDir, programs)
  const cache = join(root, 'cache')
  const logFile = join(root, 'calls.log')
  writeFileSync(logFile, '')
  // PATH holds only the fakes, so a tool that is not here is genuinely missing.
  process.env['PATH'] = binDir
  process.env['COPSE_CLASSIFIER_CACHE'] = cache
  process.env['FAKE_LOG'] = logFile
  const state = {
    root,
    cache,
    log: (): string => readFileSync(logFile, 'utf8'),
    profiles: [] as ClassifierProfile[],
    freeBytes: null as number | null,
  }
  const manager = new LocalClassifierManager({
    prepare: prepareClassifierCache,
    isInstalled: isClassifierInstalled,
    portListening,
    programAvailable,
    freeBytes: async (path): Promise<number | null> => state.freeBytes ?? freeDiskBytes(path),
    uninstall: removeClassifierInstall,
    spawnServer: spawnLocalServer,
    listProfiles: (): ClassifierProfile[] => state.profiles,
    saveProfile: async (profile): Promise<void> => {
      state.profiles = [...state.profiles, profile]
    },
    env: {},
    sleep: defaultSleep,
  })
  return Object.assign(state, { manager })
}

async function winnow(m: Machine): Promise<LocalClassifierStatus> {
  const found = (await m.manager.overview()).servers.find((server) => server.id === 'winnow')
  assert.ok(found)
  return found
}

async function until(
  m: Machine,
  predicate: (status: LocalClassifierStatus) => boolean,
): Promise<LocalClassifierStatus> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const status = await winnow(m)
    if (predicate(status)) return status
    if (Date.now() > deadline) throw new Error(`timed out; last ${JSON.stringify(status)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function winnowProfile(): ClassifierProfile {
  const profile = CLASSIFIER_PRESETS.find((entry) => entry.id === 'winnow')
  assert.ok(profile)
  return profile
}

describe('Download and run, with fake git/python3 on PATH', () => {
  /** Winnow's port is fixed by the catalog; a machine that is using it skips these. */
  function scenario(name: string, run: () => Promise<void>): void {
    it(name, async (t) => {
      if (!portFree) {
        t.skip(`port ${String(WINNOW_PORT)} is in use on this machine`)
        return
      }
      await run()
    })
  }

  const saved = new Map<string, string | undefined>()
  let current: Machine | undefined
  let squatter: Server | undefined
  let portFree = true

  before(async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key])
    portFree = !(await portListening(WINNOW_PORT))
  })

  beforeEach(() => {
    delete process.env['FAKE_GIT_MODE']
    delete process.env['FAKE_PY_MODE']
  })

  afterEach(async () => {
    await current?.manager.stop('winnow').catch(() => undefined)
    current?.manager.stopAll()
    await new Promise<void>((resolve) => {
      if (!squatter) {
        resolve()
        return
      }
      squatter.close(() => {
        resolve()
      })
      squatter = undefined
    })
    if (current) rmSync(current.root, { recursive: true, force: true })
    current = undefined
  })

  after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  scenario('detects, installs, starts, answers a test call, stops and uninstalls', async () => {
    const m = (current = machine())
    assert.equal((await winnow(m)).phase, 'not-installed')

    await m.manager.install('winnow')
    const running = await until(m, (status) => status.phase === 'running' && status.saved)
    assert.equal(running.error, undefined)

    // Set up at the pinned revision: a marker only a finished setup writes.
    const checkout = join(m.cache, 'winnow', PIN)
    assert.equal(readFileSync(join(checkout, '.git', 'head'), 'utf8'), PIN)
    assert.ok(existsSync(join(checkout, '.copse-setup-complete')))
    assert.ok(existsSync(join(m.cache, 'winnow', 'models', 'model.safetensors')))
    assert.deepEqual(
      m.profiles.map((profile) => profile.id),
      ['winnow'],
    )
    assert.match(
      m.log(),
      /git clone --quiet https:\/\/github\.com\/EldanRing\/winnow-inference\.git /,
    )
    assert.match(m.log(), /python3 scripts\/setup\.py --text-only --model-dir /)

    // The test call goes to the server Copse started, through the real protocol path.
    const result = await classify(winnowProfile(), CLASSIFIER_TEST_REQUEST)
    assert.equal(result.model, 'winnow-fake')
    assert.equal(result.answers['color']?.type, 'choice')

    await m.manager.stop('winnow')
    const stopped = await until(m, (status) => status.phase === 'installed')
    assert.equal(stopped.error, undefined)
    assert.equal(await portListening(WINNOW_PORT), false)

    // A second run reuses the cache: no clone, no setup.
    const before = m.log()
    await m.manager.start('winnow')
    await until(m, (status) => status.phase === 'running')
    assert.equal(m.log().replace(before, '').includes('clone'), false)
    assert.equal(m.log().replace(before, '').includes('setup.py'), false)
    await m.manager.stop('winnow')
    await until(m, (status) => status.phase === 'installed')

    const after = await m.manager.uninstall('winnow')
    assert.equal(after.servers.find((server) => server.id === 'winnow')?.phase, 'not-installed')
    assert.equal(existsSync(join(m.cache, 'winnow')), false)
    assert.equal(m.profiles.length, 1, 'the saved connection is left for the person to remove')
  })

  scenario('names a missing python3 and downloads nothing', async () => {
    const m = (current = machine(['git']))
    const status = await winnow(m)
    assert.deepEqual(status.missing, ['python3'])
    await m.manager.install('winnow')
    const failed = await until(m, (s) => s.error !== undefined)
    assert.match(failed.error ?? '', /Install python3 first/)
    assert.equal(m.log().includes('clone'), false)
    assert.equal(existsSync(m.cache), false)
  })

  scenario('stops before cloning when the disk cannot hold the download', async () => {
    const m = (current = machine())
    m.freeBytes = 2e9
    await m.manager.install('winnow')
    const failed = await until(m, (s) => s.error !== undefined)
    assert.match(failed.error ?? '', /Not enough free disk space for Winnow-12B/)
    assert.equal(m.log().includes('clone'), false)
  })

  scenario(
    'reports running out of space partway through setup, and recovers on retry',
    async () => {
      const m = (current = machine())
      process.env['FAKE_PY_MODE'] = 'enospc'
      await m.manager.install('winnow')
      const failed = await until(m, (s) => s.error !== undefined)
      assert.match(failed.error ?? '', /ran out of disk space/)
      assert.equal(failed.phase, 'not-installed', 'no completion marker after a failed setup')
      assert.equal(m.profiles.length, 0)
      assert.equal(await portListening(WINNOW_PORT), false)

      delete process.env['FAKE_PY_MODE']
      await m.manager.install('winnow')
      await until(m, (s) => s.phase === 'running' && s.saved)
    },
  )

  scenario('reports being offline when the clone cannot reach the network', async () => {
    const m = (current = machine())
    process.env['FAKE_GIT_MODE'] = 'offline'
    await m.manager.install('winnow')
    const failed = await until(m, (s) => s.error !== undefined)
    assert.match(failed.error ?? '', /Could not reach the network to download Winnow-12B/)
    assert.match(failed.error ?? '', /Could not resolve host: github\.com/)
    assert.equal(failed.phase, 'not-installed')
    assert.equal(m.profiles.length, 0)
  })

  scenario('reports a pinned revision that cannot be fetched and installs nothing', async () => {
    const m = (current = machine())
    process.env['FAKE_GIT_MODE'] = 'bad-rev'
    await m.manager.install('winnow')
    const failed = await until(m, (s) => s.error !== undefined)
    assert.match(
      failed.error ?? '',
      /Could not fetch the pinned version of Winnow-12B \(77d14580c673\)/,
    )
    assert.equal(failed.phase, 'not-installed')
    assert.equal(
      m.log().includes('setup.py'),
      false,
      'setup code never ran at an unverified revision',
    )
  })

  scenario('refuses a port clash before downloading anything', async () => {
    const m = (current = machine())
    squatter = createServer((socket) => {
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      squatter?.once('error', reject)
      squatter?.listen(WINNOW_PORT, '127.0.0.1', resolve)
    })
    assert.equal((await winnow(m)).phase, 'external')
    await m.manager.install('winnow')
    const failed = await until(m, (s) => s.error !== undefined)
    assert.match(failed.error ?? '', /Port 8091 is already in use/)
    assert.equal(m.log().includes('clone'), false)
    // Uninstall is refused too: the process on the port is not Copse's to disturb.
    await assert.rejects(m.manager.uninstall('winnow'), /running on port 8091/)
  })

  scenario('cancelling an install leaves no error and nothing running', async () => {
    const m = (current = machine())
    process.env['FAKE_GIT_MODE'] = ''
    await m.manager.install('winnow')
    await m.manager.stop('winnow')
    // Whether the cancel landed before or after setup finished, there is no failure to show.
    const settled = await until(m, (s) => s.phase !== 'installing' && s.phase !== 'starting')
    assert.equal(settled.error, undefined)
  })
})
