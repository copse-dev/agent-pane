import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupEvalGortex,
  inspectEvalGortexProcess,
  parsePsIdentity,
} from './eval-gortex-cleanup.mts'

const profiles: string[] = []
afterEach(() => {
  for (const profile of profiles.splice(0)) rmSync(profile, { recursive: true, force: true })
})

type Identity = {
  pid: number
  started: string
  executable: string
  home: string
  daemon: boolean
  privateFiles: boolean
}
type Boundary = NonNullable<Parameters<typeof cleanupEvalGortex>[1]>
type Inspection = NonNullable<Parameters<typeof inspectEvalGortexProcess>[2]>

function fixture(): {
  profile: string
  home: string
  processes: Map<number, Identity>
  signals: number[]
  boundary: Boundary
  inspection: Inspection
} {
  const profile = realpathSync(mkdtempSync(join(tmpdir(), '.wdio-eval-userdata-01234567-')))
  profiles.push(profile)
  const home = join(profile, 'gortex')
  const processes = new Map([
    [
      11,
      {
        pid: 11,
        started: 'first',
        executable: '/cache/gortex',
        home,
        daemon: true,
        privateFiles: true,
      },
    ],
    [
      12,
      {
        pid: 12,
        started: 'second',
        executable: '/cache/gortex',
        home,
        daemon: false,
        privateFiles: true,
      },
    ],
    [
      13,
      {
        pid: 13,
        started: 'daily',
        executable: '/cache/gortex',
        home: '/daily/gortex',
        daemon: true,
        privateFiles: true,
      },
    ],
  ])
  const signals: number[] = []
  const inspection: Inspection = {
    alive: (pid) => {
      if (!processes.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    },
    status: (pid) => {
      const identity = processes.get(pid)
      assert.ok(identity)
      return { started: identity.started, state: 'S' }
    },
    home: (pid) => processes.get(pid)?.home,
    details: (pid) => {
      const identity = processes.get(pid)
      assert.ok(identity)
      return {
        executable: identity.executable,
        files: identity.privateFiles ? [join(identity.home, 'service.log')] : [],
      }
    },
    canonical: (path) => path,
    pidfile: (home) =>
      [...processes.values()].find((identity) => identity.home === home && identity.daemon)?.pid ??
      null,
    uid: () => 501,
    ownUid: 501,
  }
  const boundary: Boundary = {
    candidates: () => [...processes.keys()],
    inspect: (pid, home) => inspectEvalGortexProcess(pid, home, inspection),
    terminate: (pid: number) => {
      signals.push(pid)
      processes.delete(pid)
    },
    pause: async () => {},
  }
  return { profile, home, processes, signals, boundary, inspection }
}

describe('eval Gortex service cleanup', () => {
  it('keeps PID identity stable through running/sleeping and scheduler-flag transitions', async () => {
    const f = fixture()
    const start = 'Fri Nov 13 21:21:29 2026'
    const states = new Map<number, string[]>()
    const inspect = f.boundary.inspect
    f.boundary.inspect = (pid, home): Identity | null => {
      const identity = inspect(pid, home)
      if (!identity) return null
      const observed = states.get(pid) ?? []
      const state = observed.length === 0 ? 'R+' : 'Ss'
      observed.push(state)
      states.set(pid, observed)
      const sample = parsePsIdentity(`${start} ${state}`)
      return { ...identity, started: sample.started }
    }
    assert.deepEqual(parsePsIdentity(`${start} R`), { started: start, state: 'R' })
    assert.deepEqual(parsePsIdentity(`${start} S+`), { started: start, state: 'S+' })
    assert.equal(parsePsIdentity(`${start} Z`).state, 'Z')
    assert.throws(() => parsePsIdentity(''), /Incomplete/)
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.deepEqual(f.signals, [12, 11])
    assert.deepEqual([...f.processes.keys()], [13])
    assert.deepEqual(states.get(12), ['R+', 'Ss'])
    assert.deepEqual(states.get(11), ['R+', 'Ss'])
  })

  it('signals profile clients before the detached daemon and leaves the shared-executable daily process alive', async () => {
    const f = fixture()
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.deepEqual(f.signals, [12, 11])
    assert.deepEqual([...f.processes.keys()], [13])
  })

  it('finds a daemon before its pidfile exists using private open files', async () => {
    const f = fixture()
    const daemon = f.processes.get(11)
    assert.ok(daemon)
    daemon.daemon = false
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.ok(f.signals.includes(11))
  })

  it('rejects a daily profile before touching the process boundary', async () => {
    const f = fixture()
    await assert.rejects(cleanupEvalGortex('/daily', f.boundary), /generated eval/)
    assert.deepEqual(f.signals, [])
  })

  it('rejects a generated-looking symlink to another profile', async () => {
    const f = fixture()
    const alias = `${f.profile}-alias`
    profiles.push(alias)
    symlinkSync(f.profile, alias)
    await assert.rejects(cleanupEvalGortex(alias, f.boundary), /aliased/)
    assert.deepEqual(f.signals, [])
  })

  it('does not signal a PID reused between enumeration and shutdown', async () => {
    const f = fixture()
    let reads = 0
    const inspect = f.boundary.inspect
    f.boundary.inspect = (pid, home): Identity | null => {
      const value = inspect(pid, home)
      if (pid === 12 && ++reads > 1 && value) return { ...value, started: 'reused' }
      return value
    }
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /changed identity/)
    assert.deepEqual(f.signals, [])
  })

  it('does not signal a same-profile process with an unverified executable', async () => {
    const f = fixture()
    const client = f.processes.get(12)
    assert.ok(client)
    client.executable = '/cache/unrelated'
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /establish ownership/)
    assert.deepEqual(f.signals, [])
  })

  it('fails closed when no pidfile or private open file corroborates ownership', async () => {
    const f = fixture()
    const client = f.processes.get(12)
    assert.ok(client)
    client.privateFiles = false
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /establish ownership/)
    assert.deepEqual(f.signals, [])
  })

  it('handles a process exiting just before SIGTERM', async () => {
    const f = fixture()
    f.boundary.terminate = (pid): void => {
      f.processes.delete(pid)
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    }
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.deepEqual([...f.processes.keys()], [13])
  })

  it('fails instead of deleting evidence when an owned service ignores SIGTERM', async () => {
    const f = fixture()
    f.boundary.terminate = (pid): void => {
      f.signals.push(pid)
    }
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /did not stop/)
    assert.deepEqual(f.signals, [12, 11])
  })

  it('reaps a verified owned service that appears during teardown', async () => {
    const f = fixture()
    f.boundary.terminate = (pid): void => {
      f.signals.push(pid)
      f.processes.delete(pid)
      if (pid === 11)
        f.processes.set(21, {
          pid: 21,
          started: 'late',
          executable: '/cache/gortex',
          home: f.home,
          daemon: true,
          privateFiles: true,
        })
    }
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.deepEqual(f.signals, [12, 11, 21])
    assert.deepEqual([...f.processes.keys()], [13])
  })

  it('bounds cleanup when owned services keep reappearing', async () => {
    const f = fixture()
    let nextPid = 100
    f.boundary.terminate = (pid): void => {
      const identity = f.processes.get(pid)
      assert.ok(identity)
      f.processes.delete(pid)
      f.signals.push(pid)
      if (identity.daemon) {
        const replacement = { ...identity, pid: nextPid++, started: String(nextPid) }
        f.processes.set(replacement.pid, replacement)
      }
    }
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /did not stop/)
    assert.ok([...f.processes.values()].some((identity) => identity.home === f.home))
  })

  it('skips a removed foreign HOME before inspecting its executable or files', async () => {
    const f = fixture()
    const foreign = f.processes.get(13)
    assert.ok(foreign)
    foreign.home = '/removed/foreign/gortex'
    f.inspection.canonical = (path): string => {
      if (path === foreign.home) throw new Error('foreign HOME was deleted')
      return path
    }
    const details = f.inspection.details
    f.inspection.details = (pid): ReturnType<Inspection['details']> => {
      assert.notEqual(pid, 13, 'Foreign HOME must be classified before full inspection')
      return details(pid)
    }
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.deepEqual(f.signals, [12, 11])
    assert.ok(f.processes.has(13))
  })

  it('skips a foreign process whose executable can no longer be resolved', async () => {
    const f = fixture()
    const details = f.inspection.details
    f.inspection.details = (pid): ReturnType<Inspection['details']> => {
      if (pid === 13) throw new Error('foreign executable was replaced')
      return details(pid)
    }
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.deepEqual(f.signals, [12, 11])
    assert.ok(f.processes.has(13))
  })

  it('skips an inaccessible process when its UID establishes that it is foreign', async () => {
    const f = fixture()
    const home = f.inspection.home
    const alive = f.inspection.alive
    f.inspection.home = (pid): string | undefined => {
      if (pid === 13) throw Object.assign(new Error('unreadable environment'), { code: 'EACCES' })
      return home(pid)
    }
    f.inspection.alive = (pid): void => {
      if (pid === 13) throw Object.assign(new Error('foreign user'), { code: 'EPERM' })
      alive(pid)
    }
    f.inspection.uid = (pid): number => (pid === 13 ? 502 : 501)
    await cleanupEvalGortex(f.profile, f.boundary)
    assert.deepEqual(f.signals, [12, 11])
    assert.ok(f.processes.has(13))
  })

  it('preserves a denied matching-profile process with the same UID', async () => {
    const f = fixture()
    const alive = f.inspection.alive
    f.inspection.alive = (pid): void => {
      if (pid === 12) throw Object.assign(new Error('denied'), { code: 'EPERM' })
      alive(pid)
    }
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /Cannot verify/)
    assert.deepEqual(f.signals, [])
  })

  it('preserves a live candidate whose HOME is missing', async () => {
    const f = fixture()
    const home = f.inspection.home
    f.inspection.home = (pid): string | undefined => (pid === 12 ? undefined : home(pid))
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /Cannot verify/)
    assert.deepEqual(f.signals, [])
    assert.ok(f.processes.has(12))
  })

  it('preserves an unreadable executable after HOME establishes ownership', async () => {
    const f = fixture()
    const details = f.inspection.details
    f.inspection.details = (pid): ReturnType<Inspection['details']> => {
      if (pid === 12) throw new Error('owned executable unavailable')
      return details(pid)
    }
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /Cannot verify/)
    assert.deepEqual(f.signals, [])
  })

  it('preserves a missing matching HOME instead of treating it as foreign', async () => {
    const f = fixture()
    f.inspection.canonical = (path): string => {
      if (path === f.home) throw new Error('owned HOME unavailable')
      return path
    }
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /Cannot verify/)
    assert.deepEqual(f.signals, [])
  })

  it('preserves an inspection failure rather than treating it as process absence', async () => {
    const f = fixture()
    f.boundary.inspect = (): never => {
      throw new Error('inspection denied')
    }
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /inspection denied/)
    assert.deepEqual(f.signals, [])
  })
})
