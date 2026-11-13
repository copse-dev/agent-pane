import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupEvalGortex } from './eval-gortex-cleanup.mts'

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

function fixture(): {
  profile: string
  home: string
  processes: Map<number, Identity>
  signals: number[]
  boundary: Boundary
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
  const boundary: Boundary = {
    candidates: () => [...processes.keys()],
    inspect: (pid: number) => processes.get(pid) ?? null,
    terminate: (pid: number) => {
      signals.push(pid)
      processes.delete(pid)
    },
    pause: async () => {},
  }
  return { profile, home, processes, signals, boundary }
}

describe('eval Gortex service cleanup', () => {
  it('stops profile clients before the detached daemon and leaves the shared-executable daily process alive', async () => {
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
    f.boundary.inspect = (pid): Identity | null => {
      const value = inspect(pid)
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

  it('fails if a new owned service appears during teardown', async () => {
    const f = fixture()
    f.boundary.terminate = (pid): void => {
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
    await assert.rejects(cleanupEvalGortex(f.profile, f.boundary), /did not stop/)
    assert.ok(f.processes.has(21))
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
