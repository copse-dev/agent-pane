import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import {
  buildHashCommand,
  buildUploadCommand,
  parseRemoteHash,
  setNativeWatcherDepsForTest,
  stopAllNativeWatchers,
  tryWatchNative,
  unwatchNative,
  type RemoteWatcherProc,
} from './remote-native-watcher.ts'

const TARGET = { hostId: 'dev', remoteRoot: '/srv/app', absPath: '/srv/app/a.ts' }

/** Scripted stand-in for the remote ssh child process. */
class FakeProc implements RemoteWatcherProc {
  stdout = new PassThrough()
  stdin = new PassThrough()
  killed = false
  stdinEnded = false
  private written = ''
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor() {
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString()
    })
    this.stdin.on('finish', () => {
      this.stdinEnded = true
    })
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emitClose(): void {
    for (const listener of this.listeners.get('close') ?? []) listener()
  }

  emitReady(): void {
    this.emit({ event: 'ready', protocol: 1, version: '0.0.0' })
  }

  emit(event: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(event) + '\n')
  }

  /** Commands the session wrote to stdin, parsed. */
  commands(): Array<Record<string, unknown>> {
    return this.written
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line)
        if (!isJsonRecord(parsed)) throw new Error(`non-object command line: ${line}`)
        return parsed
      })
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface SetupOpts {
  /** Successive stdouts for the remote hash command; empty string = no file. */
  remoteHashes?: string[]
  approve?: boolean
  /** Pass null to simulate "no bundled binary for this platform". */
  binary?: Buffer | null
  autoReady?: boolean
  readyTimeoutMs?: number
  idleTeardownMs?: number
}

function setup(opts: SetupOpts = {}): {
  bytes: Buffer | null
  localHash: string
  procs: FakeProc[]
  execCalls: Array<{ command: string; stdin?: string }>
  approvals: () => number
} {
  const bytes = opts.binary === undefined ? Buffer.from('fake-watcher-binary') : opts.binary
  const localHash = bytes ? createHash('sha256').update(bytes).digest('hex') : ''
  const procs: FakeProc[] = []
  const execCalls: Array<{ command: string; stdin?: string }> = []
  const hashQueue = [...(opts.remoteHashes ?? [])]
  let approvals = 0
  setNativeWatcherDepsForTest({
    exec: (_hostId, _root, command, stdin) => {
      execCalls.push(stdin === undefined ? { command } : { command, stdin })
      if (command === buildHashCommand()) {
        const hash = hashQueue.shift() ?? ''
        return Promise.resolve({
          stdout: hash ? `${hash}  copse-remote-watcher` : '',
          stderr: '',
          code: hash ? 0 : 1,
        })
      }
      return Promise.resolve({ stdout: '', stderr: '', code: 0 })
    },
    spawn: () => {
      const proc = new FakeProc()
      procs.push(proc)
      if (opts.autoReady !== false) {
        setImmediate(() => {
          proc.emitReady()
        })
      }
      return Promise.resolve(proc)
    },
    getPlatform: () => ({ os: 'Linux', arch: 'x86_64' }),
    resolveBinaryPath: () => (bytes ? '/bundled/copse-remote-watcher' : null),
    readBinary: () => {
      if (!bytes) return Promise.reject(new Error('no binary'))
      return Promise.resolve(bytes)
    },
    approve: () => {
      approvals += 1
      return Promise.resolve(opts.approve !== false)
    },
    readyTimeoutMs: opts.readyTimeoutMs ?? 1_000,
    idleTeardownMs: opts.idleTeardownMs ?? 1_000,
  })
  return { bytes, localHash, procs, execCalls, approvals: () => approvals }
}

/** Let readline lines and queued promises drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(() => {
  stopAllNativeWatchers()
  setNativeWatcherDepsForTest(null)
})

describe('parseRemoteHash', () => {
  it('reads sha256sum and shasum output shapes', () => {
    const hash = 'a'.repeat(64)
    assert.equal(parseRemoteHash(`${hash}  /home/u/.copse/bin/copse-remote-watcher`), hash)
    assert.equal(parseRemoteHash(`${hash.toUpperCase()} *bin`), hash)
    assert.equal(parseRemoteHash('sha256sum: missing operand'), null)
    assert.equal(parseRemoteHash(''), null)
  })
})

describe('remote native watcher session', () => {
  it('uploads, verifies, watches, and streams change events', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { bytes, procs, execCalls } = setup({
      remoteHashes: ['b'.repeat(64), localHash],
    })
    const changes: Array<{ key: string; size: number }> = []
    const accepted = await tryWatchNative(
      'k1',
      TARGET,
      (key, size) => changes.push({ key, size }),
      () => assert.fail('should not fall back'),
    )
    assert.equal(accepted, true)

    // Hash check, upload (binary as one base64 stdin payload), verify.
    assert.equal(execCalls[0]?.command, buildHashCommand())
    const upload = execCalls[1]
    assert.ok(upload)
    assert.equal(upload.command, buildUploadCommand())
    assert.equal(upload.stdin, (bytes ?? Buffer.alloc(0)).toString('base64') + '\n')
    assert.equal(execCalls[2]?.command, buildHashCommand())

    await settle()
    const proc = procs[0]
    assert.ok(proc)
    assert.deepEqual(proc.commands(), [{ op: 'watch', path: TARGET.absPath }])

    proc.emit({ event: 'change', path: TARGET.absPath, kind: 'modify', size: 42 })
    await settle()
    assert.deepEqual(changes, [{ key: 'k1', size: 42 }])
  })

  it('skips the upload when the remote hash already matches', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { execCalls } = setup({ remoteHashes: [localHash] })
    const accepted = await tryWatchNative(
      'k1',
      TARGET,
      () => undefined,
      () => undefined,
    )
    assert.equal(accepted, true)
    assert.deepEqual(
      execCalls.map((call) => call.command),
      [buildHashCommand()],
    )
  })

  it('falls back without a bundled binary for the platform', async () => {
    const { execCalls, approvals } = setup({ binary: null })
    const accepted = await tryWatchNative(
      'k1',
      TARGET,
      () => undefined,
      () => undefined,
    )
    assert.equal(accepted, false)
    assert.equal(execCalls.length, 0)
    assert.equal(approvals(), 0)
  })

  it('remembers a declined install for the app run without re-prompting', async () => {
    const { approvals, execCalls } = setup({ approve: false })
    assert.equal(
      await tryWatchNative(
        'k1',
        TARGET,
        () => undefined,
        () => undefined,
      ),
      false,
    )
    assert.equal(
      await tryWatchNative(
        'k2',
        TARGET,
        () => undefined,
        () => undefined,
      ),
      false,
    )
    assert.equal(approvals(), 1)
    // Denied before anything touched the host.
    assert.equal(execCalls.length, 0)
  })

  it('refuses to run a binary that fails post-upload verification', async () => {
    const { procs, execCalls } = setup({
      remoteHashes: ['b'.repeat(64), 'c'.repeat(64)],
    })
    const accepted = await tryWatchNative(
      'k1',
      TARGET,
      () => undefined,
      () => undefined,
    )
    assert.equal(accepted, false)
    assert.equal(procs.length, 0)
    const last = execCalls[execCalls.length - 1]
    assert.match(last?.command ?? '', /^rm -f /)
  })

  it('hands exactly the watch-failed path back to the fallback', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { procs } = setup({ remoteHashes: [localHash] })
    const fellBack: string[] = []
    const changes: string[] = []
    const other = { ...TARGET, absPath: '/srv/app/b.ts' }
    await tryWatchNative(
      'k1',
      TARGET,
      (key) => changes.push(key),
      (key) => fellBack.push(key),
    )
    await tryWatchNative(
      'k2',
      other,
      (key) => changes.push(key),
      (key) => fellBack.push(key),
    )
    await settle()
    const proc = procs[0]
    assert.ok(proc)

    proc.emit({ event: 'watch-failed', path: TARGET.absPath })
    await settle()
    assert.deepEqual(fellBack, ['k1'])

    // The surviving subscription still streams.
    proc.emit({ event: 'change', path: other.absPath, kind: 'modify', size: 7 })
    await settle()
    assert.deepEqual(changes, ['k2'])
  })

  it('does not report deletions', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { procs } = setup({ remoteHashes: [localHash] })
    const changes: string[] = []
    await tryWatchNative(
      'k1',
      TARGET,
      (key) => changes.push(key),
      () => undefined,
    )
    await settle()
    procs[0]?.emit({ event: 'change', path: TARGET.absPath, kind: 'remove', size: null })
    procs[0]?.emit({ event: 'change', path: TARGET.absPath, kind: 'modify', size: null })
    await settle()
    assert.deepEqual(changes, [])
  })

  it('falls back every key on session death but leaves the host native-eligible', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { procs, approvals } = setup({ remoteHashes: [localHash, localHash] })
    const fellBack: string[] = []
    await tryWatchNative(
      'k1',
      TARGET,
      () => undefined,
      (key) => fellBack.push(key),
    )
    await tryWatchNative(
      'k2',
      { ...TARGET, absPath: '/srv/app/b.ts' },
      () => undefined,
      (key) => fellBack.push(key),
    )
    await settle()

    procs[0]?.emitClose()
    await settle()
    assert.deepEqual(fellBack.sort(), ['k1', 'k2'])

    // A dropped session is not a setup failure: the next subscription starts a
    // fresh session, without prompting again.
    const accepted = await tryWatchNative(
      'k3',
      TARGET,
      () => undefined,
      () => undefined,
    )
    assert.equal(accepted, true)
    assert.equal(procs.length, 2)
    assert.equal(approvals(), 1)
  })

  it('refcounts shared paths and tears down an idle session after the grace period', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { procs } = setup({ remoteHashes: [localHash], idleTeardownMs: 20 })
    await tryWatchNative(
      'k1',
      TARGET,
      () => undefined,
      () => undefined,
    )
    await tryWatchNative(
      'k2',
      TARGET,
      () => undefined,
      () => undefined,
    )
    await settle()
    const proc = procs[0]
    assert.ok(proc)

    unwatchNative('k1')
    await settle()
    // Another key still holds the path — no unwatch on the wire.
    assert.deepEqual(proc.commands(), [{ op: 'watch', path: TARGET.absPath }])

    unwatchNative('k2')
    await settle()
    assert.deepEqual(proc.commands(), [
      { op: 'watch', path: TARGET.absPath },
      { op: 'unwatch', path: TARGET.absPath },
    ])

    // Empty session survives the grace window, then dies by stdin EOF.
    assert.equal(proc.stdinEnded, false)
    await wait(40)
    assert.equal(proc.stdinEnded, true)
  })

  it('marks the host unavailable when the watcher never says ready', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { procs, approvals } = setup({
      remoteHashes: [localHash],
      autoReady: false,
      readyTimeoutMs: 20,
    })
    const accepted = await tryWatchNative(
      'k1',
      TARGET,
      () => undefined,
      () => undefined,
    )
    assert.equal(accepted, false)
    await settle()
    assert.equal(procs[0]?.stdinEnded, true)

    assert.equal(
      await tryWatchNative(
        'k2',
        TARGET,
        () => undefined,
        () => undefined,
      ),
      false,
    )
    assert.equal(procs.length, 1)
    assert.equal(approvals(), 1)
  })

  it('closes stdin on shutdown — the EOF exit contract', async () => {
    const localHash = createHash('sha256').update(Buffer.from('fake-watcher-binary')).digest('hex')
    const { procs } = setup({ remoteHashes: [localHash] })
    await tryWatchNative(
      'k1',
      TARGET,
      () => undefined,
      () => undefined,
    )
    await settle()
    stopAllNativeWatchers()
    await settle()
    const proc = procs[0]
    assert.ok(proc)
    assert.equal(proc.stdinEnded, true)
    assert.equal(proc.killed, true)
  })
})
