import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { artifactImageHostEnv, runArtifactImageHost } from './host-process.ts'
import { pngBytes } from './image-fixtures.test-support.ts'
import { encodeFrame, imageFrames, type HostJob, type ImageFrame } from './protocol.ts'

const REQUEST = 'c'.repeat(32)
const SIGNED = 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com/a.png?X-Amz-Signature=sig'
const JOB: HostJob = {
  v: 1,
  type: 'job',
  requestId: REQUEST,
  url: SIGNED,
  approvedOrigins: ['https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com'],
}

const dir = mkdtempSync(join(tmpdir(), 'artifact-image-host-process-'))
after(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A stand-in host bundle: records its inputs, then prints `output` and behaves as `tail` says. */
function fakeHost(
  name: string,
  output: string,
  tail: 'exit' | 'hang',
): { path: string; record: string } {
  const path = join(dir, `${name}.cjs`)
  const record = join(dir, `${name}.json`)
  writeFileSync(
    path,
    `
const fs = require('node:fs')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  if (!input.includes('\\n')) return
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, job: input.slice(0, input.indexOf('\\n')) }))
  process.stdout.write(${JSON.stringify(output)})
  ${tail === 'exit' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}
})
`,
  )
  return { path, record }
}

const zRecord = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  job: z.string(),
})

async function launch(
  host: { path: string },
  signal: AbortSignal = new AbortController().signal,
): Promise<ImageFrame[]> {
  const frames: ImageFrame[] = []
  await runArtifactImageHost(JOB, (frame) => frames.push(frame), signal, {
    execPath: process.execPath,
    hostPath: host.path,
  })
  return frames
}

describe('artifactImageHostEnv', () => {
  it('passes only what the host needs to find the sandbox tools', () => {
    assert.deepEqual(
      artifactImageHostEnv({
        PATH: '/usr/bin',
        HOME: '/home/u',
        TMPDIR: '/tmp/u',
        CURSOR_API_KEY: 'secret',
        NODE_OPTIONS: '--require /evil.js',
        HTTPS_PROXY: 'http://corp:3128',
        NODE_EXTRA_CA_CERTS: '/ca.pem',
      }),
      { PATH: '/usr/bin', HOME: '/home/u', TMPDIR: '/tmp/u', ELECTRON_RUN_AS_NODE: '1' },
    )
  })
})

describe('runArtifactImageHost', () => {
  it('sends the job over stdin only and delivers every decoded frame', async () => {
    const frames = imageFrames(REQUEST, 'image/png', pngBytes())
    const host = fakeHost('ok', frames.map(encodeFrame).join(''), 'exit')
    const delivered = await launch(host)
    assert.deepEqual(delivered, frames)
    const record = safeJsonParse(readFileSync(host.record, 'utf8'), decodeWithSchema(zRecord))
    assert.ok(record)
    assert.equal(record.job, JSON.stringify(JOB))
    // The signed URL is a bearer secret: never in argv or the environment.
    assert.doesNotMatch(JSON.stringify({ argv: record.argv, env: record.env }), /X-Amz-Signature/u)
    assert.equal(record.env['ELECTRON_RUN_AS_NODE'], '1')
  })

  it('turns an undecodable line into one protocol error and stops the host', async () => {
    const host = fakeHost('garbage', '{"type":"chunk","data":"not a frame"}\n', 'hang')
    const delivered = await launch(host)
    assert.deepEqual(
      delivered.map((frame) => (frame.type === 'error' ? frame.code : frame.type)),
      ['protocol'],
    )
  })

  it('refuses an unbounded line without buffering it', async () => {
    const host = fakeHost('huge', 'x'.repeat(200_000), 'hang')
    const delivered = await launch(host)
    assert.deepEqual(
      delivered.map((frame) => (frame.type === 'error' ? frame.code : frame.type)),
      ['protocol'],
    )
  })

  it('kills the host when the request is cancelled', async () => {
    const host = fakeHost('hang', '', 'hang')
    const abort = new AbortController()
    setTimeout(() => {
      abort.abort()
    }, 200)
    const started = Date.now()
    await launch(host, abort.signal)
    assert.ok(Date.now() - started < 5_000)
  })

  it('reports a host that cannot start as sandbox-unavailable', async () => {
    const frames: ImageFrame[] = []
    await runArtifactImageHost(JOB, (frame) => frames.push(frame), new AbortController().signal, {
      execPath: join(dir, 'no-such-runtime'),
      hostPath: join(dir, 'no-such-host.js'),
    })
    assert.deepEqual(
      frames.map((frame) => (frame.type === 'error' ? frame.code : frame.type)),
      ['sandbox-unavailable'],
    )
  })
})
