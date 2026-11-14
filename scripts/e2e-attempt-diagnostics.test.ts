import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '../packages/std/src/safe-json.ts'
import {
  E2E_ATTEMPT_DIRECTORY_ENV,
  managedAttemptDirectory,
  observePid,
  recordLaunchResult,
  recordSessionLifecycle,
  recordWorkerEnd,
  sealAttemptArtifacts,
  sessionLifecycleFact,
  startAttemptArtifacts,
} from './lib/e2e-attempt-diagnostics.mts'

const manifestSchema = z.object({
  driverEof: z.literal('unknown'),
  driverExitCode: z.null(),
  driverSignal: z.null(),
  launchResultAvailable: z.boolean(),
  files: z.array(z.object({ name: z.string(), bytes: z.number(), sha256: z.string() })),
})

function manifest(directory: string): z.infer<typeof manifestSchema> {
  const parsed = safeJsonParse(
    readFileSync(join(directory, 'snapshot', 'manifest.json'), 'utf8'),
    decodeWithSchema(manifestSchema),
  )
  assert(parsed)
  return parsed
}

describe('outer e2e attempt diagnostics', () => {
  it('retains identical raw basenames in unique immutable byte snapshots, including repeated attempt numbers', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-attempt-bytes-')))
    try {
      const first = startAttemptArtifacts('1', root)
      const second = startAttemptArtifacts('1', root)
      assert(first && second)
      assert.notEqual(first, second)
      const bytes = [Buffer.from([0, 255, 13, 10, 7]), Buffer.from('second driver\r\n')]
      for (const [index, directory] of [first, second].entries()) {
        const raw = bytes[index]
        assert(raw)
        writeFileSync(join(directory, 'wdio-0-0-chromedriver.log'), raw)
        await sealAttemptArtifacts(directory, index === 0 ? 1 : 0, root)
        const entry = manifest(directory).files.find(
          (file) => file.name === 'wdio-0-0-chromedriver.log',
        )
        assert(entry)
        assert.equal(entry.bytes, raw.length)
        assert.equal(entry.sha256, createHash('sha256').update(raw).digest('hex'))
        assert.deepEqual(readFileSync(join(directory, 'snapshot', entry.name)), raw)
      }
      const before = readFileSync(join(first, 'snapshot', 'manifest.json'))
      writeFileSync(join(first, 'wdio-0-0-chromedriver.log'), 'late driver output')
      await sealAttemptArtifacts(first, 1, root)
      assert.deepEqual(readFileSync(join(first, 'snapshot', 'wdio-0-0-chromedriver.log')), bytes[0])
      assert.deepEqual(readFileSync(join(first, 'snapshot', 'manifest.json')), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retains partial logs and explicit unknowns when no launch result was observed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-attempt-partial-')))
    try {
      const directory = startAttemptArtifacts('2', root)
      assert(directory)
      writeFileSync(join(directory, 'wdio-0-0-chromedriver.log'), 'partial protocol')
      await sealAttemptArtifacts(directory, 124, root)
      const sealed = manifest(directory)
      assert.equal(sealed.launchResultAvailable, false)
      const outer = safeJsonParse(
        readFileSync(join(directory, 'outer-attempt-result.json'), 'utf8'),
        decodeWithSchema(
          z.object({ role: z.literal('outer-attempt'), exitStatus: z.literal(124) }),
        ),
      )
      assert(outer)
      assert.equal(sealed.driverSignal, null)
      assert.equal(sealed.driverExitCode, null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('separates launch command signals, worker signals and pre-cleanup PID observations', () => {
    const directory = startAttemptArtifacts('1')
    assert(directory)
    const previous = process.env[E2E_ATTEMPT_DIRECTORY_ENV]
    try {
      const child = spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'])
      assert.equal(child.signal, 'SIGTERM')
      recordLaunchResult(directory, 'wdio', child)
      const result = safeJsonParse(
        readFileSync(join(directory, 'launch-command-result.json'), 'utf8'),
        decodeWithSchema(
          z.object({
            role: z.literal('launch-command'),
            exitCode: z.null(),
            signal: z.literal('SIGTERM'),
          }),
        ),
      )
      assert(result)
      const facts = sessionLifecycleFact(
        'before-forced-cleanup',
        { 'wdio:driverPID': 123, 'goog:processID': 456, password: 'do-not-retain' },
        (pid) => (pid === 123 ? 'absent' : 'exists'),
      )
      const text = JSON.stringify(facts)
      assert(!text.includes('do-not-retain'))
      assert(text.includes('before-forced-cleanup'))
      assert(text.includes('"observation":"absent"'))
      assert(text.includes('"observation":"exists"'))
      assert(text.includes('"driverExitCode":null'))
      process.env[E2E_ATTEMPT_DIRECTORY_ENV] = directory
      recordWorkerEnd('0-0', 137, 'SIGKILL')
      const worker = safeJsonParse(
        readFileSync(join(directory, 'worker-0-0.json'), 'utf8'),
        decodeWithSchema(
          z.object({
            role: z.literal('wdio-worker'),
            exitCode: z.literal(137),
            signal: z.literal('SIGKILL'),
          }),
        ),
      )
      assert(worker)
      recordSessionLifecycle('before-forced-cleanup', () => ({ 'wdio:driverPID': process.pid }))
      const before = readFileSync(join(directory, `session-${String(process.pid)}.jsonl`), 'utf8')
      recordSessionLifecycle('before-forced-cleanup', () => {
        throw new Error('private capability error')
      })
      assert.equal(
        readFileSync(join(directory, `session-${String(process.pid)}.jsonl`), 'utf8'),
        before,
      )
      assert(!before.includes('private capability error'))
    } finally {
      if (previous === undefined) delete process.env['COPSE_E2E_DIAGNOSTICS_DIR']
      else process.env[E2E_ATTEMPT_DIRECTORY_ENV] = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('uses only signal zero and distinguishes absent, denied and unknown PID probes', () => {
    for (const [code, expected] of [
      ['ESRCH', 'absent'],
      ['EPERM', 'permission-denied'],
      ['EOTHER', 'unknown'],
    ]) {
      const stub = mock.method(process, 'kill', (_pid: number, signal?: string | number) => {
        assert.equal(signal, 0)
        throw Object.assign(new Error('not retained'), { code })
      })
      try {
        assert.equal(observePid(123), expected)
      } finally {
        stub.mock.restore()
      }
    }
    const stub = mock.method(process, 'kill', (_pid: number, signal?: string | number) => {
      assert.equal(signal, 0)
      return true
    })
    try {
      assert.equal(observePid(123), 'exists')
    } finally {
      stub.mock.restore()
    }
  })

  it('rejects unrelated paths and symlinked attempt directories', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-attempt-path-')))
    try {
      const directory = startAttemptArtifacts('1', root)
      assert(directory)
      const link = join(directory, '..', 'attempt-2-symlink')
      symlinkSync(directory, link)
      assert.equal(managedAttemptDirectory(link, root), undefined)
      assert.equal(managedAttemptDirectory(root, root), undefined)
      assert.equal(managedAttemptDirectory(directory, root), directory)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
