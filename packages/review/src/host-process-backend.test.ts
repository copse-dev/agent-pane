import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createHostProcessBackend } from './host-process-backend.ts'
import { cellEnvironment, type CellSpec, type ExecutionCell } from './isolation.ts'

const probeSchema = z.object({ cwd: z.string(), home: z.string(), tmp: z.string() })

describe('host-process backend', () => {
  let scratch = ''
  let spec: CellSpec
  let cell: ExecutionCell

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'review-host-backend-'))
    const base = join(scratch, 'base')
    const head = join(scratch, 'head')
    await mkdir(base)
    await mkdir(head)
    spec = {
      checkouts: { base, head },
      scratchDir: scratch,
      readOnlyPaths: [],
      env: cellEnvironment(process.env),
    }
    cell = await createHostProcessBackend().createCell(spec)
  })

  after(async () => {
    await cell.destroy()
    await rm(scratch, { recursive: true, force: true })
  })

  it('declares what it does and does not guarantee', () => {
    const backend = createHostProcessBackend()
    assert.equal(backend.strength, 'none')
    assert.deepEqual(backend.capabilities, {
      filesystemConfined: false,
      secretFreeEnvironment: true,
      networkDenied: false,
      ephemeral: true,
    })
  })

  it('runs in the requested checkout with HOME and TMPDIR inside the cell', async () => {
    const result = await cell.run({
      target: 'head',
      argv: [
        process.execPath,
        '-e',
        'console.log(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, tmp: process.env.TMPDIR }))',
      ],
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    const { cwd, home, tmp } = probeSchema.parse(JSON.parse(result.output.trim()))
    assert.equal((await stat(cwd)).ino, (await stat(spec.checkouts.head)).ino)
    assert.ok(home.startsWith(scratch), `HOME ${home} is outside the cell`)
    assert.ok(tmp.startsWith(scratch), `TMPDIR ${tmp} is outside the cell`)
  })

  it('kills a command that overruns its timeout and says so', async () => {
    const result = await cell.run({
      target: 'base',
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
      timeoutMs: 300,
      maxOutputBytes: 1024,
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, null)
    assert.ok(result.durationMs < 30_000)
  })

  it('retains the tail of the output under the cap', async () => {
    const result = await cell.run({
      target: 'head',
      argv: [process.execPath, '-e', 'for (let i = 0; i < 2000; i++) console.log("line " + i)'],
      timeoutMs: 30_000,
      maxOutputBytes: 512,
    })
    assert.equal(result.outputTruncated, true)
    assert.ok(Buffer.byteLength(result.output) <= 512)
    assert.match(result.output, /line 1999\n$/)
    assert.doesNotMatch(result.output, /line 0\n/)
  })

  it('reports a non-zero exit without throwing', async () => {
    const result = await cell.run({
      target: 'head',
      argv: [process.execPath, '-e', 'console.error("boom"); process.exit(3)'],
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
    })
    assert.equal(result.exitCode, 3)
    assert.match(result.output, /boom/)
  })
})
