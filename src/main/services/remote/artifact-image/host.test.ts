import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { startEgressProxy, type EgressProxyOptions } from './egress-proxy.ts'
import {
  approvedHosts,
  downloaderEnv,
  runArtifactImageHostJob,
  type HostDependencies,
} from './host.ts'
import { pngBytes } from './image-fixtures.test-support.ts'
import { ImageFrameAssembler, imageFrames, type HostJob, type ImageFrame } from './protocol.ts'

const ORIGIN = 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com'
const SIGNED = `${ORIGIN}/shot.png?X-Amz-Signature=topsecretsignature`
const REQUEST = '0123456789abcdef0123456789abcdef'
const JOB: HostJob = {
  v: 1,
  type: 'job',
  requestId: REQUEST,
  url: SIGNED,
  approvedOrigins: [ORIGIN],
}

const scripts = mkdtempSync(join(tmpdir(), 'artifact-image-host-'))
after(() => {
  rmSync(scripts, { recursive: true, force: true })
})

/**
 * A stand-in downloader: reads the job from stdin like the real one, records
 * what it received, then behaves as `mode` says.
 */
const FAKE_DOWNLOADER = join(scripts, 'fake-downloader.cjs')
writeFileSync(
  FAKE_DOWNLOADER,
  `
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const [mode, record, imageHex] = process.argv.slice(2)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { input += c; if (input.includes('\\n')) run() })
let ran = false
function frame(f) { process.stdout.write(JSON.stringify({ v: 1, ...f }) + '\\n') }
function run() {
  if (ran) return
  ran = true
  const job = JSON.parse(input.slice(0, input.indexOf('\\n')))
  fs.writeFileSync(record, JSON.stringify({ job, argv: process.argv, env: process.env }))
  const bytes = Buffer.from(imageHex, 'hex')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const chunk = { type: 'chunk', requestId: job.requestId, seq: 0, data: bytes.toString('base64') }
  const done = { type: 'done', requestId: job.requestId, mime: 'image/png', bytes: bytes.length, sha256 }
  switch (mode) {
    case 'ok': frame(chunk); frame(done); break
    case 'garbage': process.stdout.write('{"not":"a frame"}\\n'); break
    case 'partial': frame(chunk); break
    case 'forged-digest': frame(chunk); frame({ ...done, sha256: 'f'.repeat(64) }); break
    case 'wrong-request': frame({ ...chunk, requestId: 'f'.repeat(32) }); break
    case 'huge-line': process.stdout.write('x'.repeat(200000)); break
    case 'redirect-denied': frame({ type: 'error', requestId: job.requestId, code: 'redirect-denied', origin: 'https://evil.example' }); break
    case 'hang': setInterval(() => {}, 1000); return
    case 'silent-exit': process.exit(1)
    case 'ignore-term': process.on('SIGTERM', () => {}); frame(chunk); frame(done); setInterval(() => {}, 1000); return
  }
  process.exit(0)
}
`,
)

const zRecorded = z.object({
  job: z.record(z.string(), z.unknown()),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
})
type Recorded = z.infer<typeof zRecorded>

interface Run {
  frames: ImageFrame[]
  sandboxConfig: SandboxRuntimeConfig | null
  proxyOptions: EgressProxyOptions | null
  proxyClosed: boolean
  resetCalls: number
  /** Whether the downloader had exited when ASRT was reset. */
  childGoneAtReset: boolean | null
  wrapped: string | null
  child: ChildProcess | null
  recorded: () => Recorded
}

async function run(
  mode: string,
  options: {
    initializeFails?: boolean
    job?: HostJob
    signal?: AbortSignal
    deadlineMs?: number
  } = {},
): Promise<Run> {
  const record = join(scripts, `record-${mode}-${String(Date.now())}.json`)
  const state: Run = {
    frames: [],
    sandboxConfig: null,
    proxyOptions: null,
    proxyClosed: false,
    resetCalls: 0,
    childGoneAtReset: null,
    wrapped: null,
    child: null,
    recorded: () => {
      const parsed = safeJsonParse(readFileSync(record, 'utf8'), decodeWithSchema(zRecorded))
      assert.ok(parsed, 'the fake downloader recorded its inputs')
      return parsed
    },
  }
  const dependencies: HostDependencies = {
    sandbox: {
      initialize(config) {
        state.sandboxConfig = config
        return options.initializeFails
          ? Promise.reject(new Error('bwrap missing'))
          : Promise.resolve()
      },
      wrap(command) {
        state.wrapped = command
        // The fake "sandbox" runs the stand-in downloader with the host's arguments.
        return Promise.resolve({
          argv: [process.execPath, FAKE_DOWNLOADER, mode, record, pngBytes().toString('hex')],
          env: {
            PATH: '/usr/bin:/bin',
            CURSOR_API_KEY: 'should-not-pass',
            NODE_OPTIONS: '--require /evil.js',
            HTTPS_PROXY: 'http://corp:3128',
          },
        })
      },
      reset() {
        state.resetCalls++
        state.childGoneAtReset =
          state.child !== null && (state.child.exitCode !== null || state.child.signalCode !== null)
        return Promise.resolve()
      },
    },
    async startProxy(proxyOptions) {
      state.proxyOptions = proxyOptions
      const proxy = await startEgressProxy(proxyOptions)
      return {
        port: proxy.port,
        close: async (): Promise<void> => {
          state.proxyClosed = true
          await proxy.close()
        },
      }
    },
    spawn(file, args, env) {
      const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
      state.child = child
      return child
    },
    nodePath: '/opt/copse/Copse Helper',
    downloaderPath: '/opt/copse/dist/main/artifact-image-downloader.js',
    runtimeReadPaths: ['/opt/copse'],
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
  }
  await runArtifactImageHostJob(
    options.job ?? JOB,
    dependencies,
    (frame) => state.frames.push(frame),
    options.signal ?? new AbortController().signal,
  )
  return state
}

function onlyError(frames: readonly ImageFrame[]): string {
  assert.equal(frames.length, 1, JSON.stringify(frames))
  const [frame] = frames
  assert.ok(frame?.type === 'error')
  return frame.code
}

describe('artifact image host', () => {
  it('relays a verified image and tears everything down', async () => {
    const result = await run('ok')
    const assembler = new ImageFrameAssembler(REQUEST)
    let image = null
    for (const frame of result.frames) image = assembler.accept(frame) ?? image
    assert.deepEqual(image?.bytes, pngBytes())
    assert.equal(result.proxyClosed, true)
    assert.equal(result.resetCalls, 1)
    // Exited by itself or by teardown's SIGTERM: either way, gone before reset.
    assert.notEqual(result.child?.exitCode ?? result.child?.signalCode ?? null, null)
  })

  it('confines the downloader to its own proxy, with no writes or home reads', async () => {
    const result = await run('ok')
    const config = result.sandboxConfig
    assert.ok(config)
    const port = result.proxyOptions ? config.network.httpProxyPort : undefined
    assert.ok(typeof port === 'number')
    // Both ASRT proxy routes are this job's proxy, so ASRT starts none of its own.
    assert.equal(config.network.socksProxyPort, port)
    assert.deepEqual(config.network.allowedDomains, [
      'cloud-agent-artifacts.s3.us-east-1.amazonaws.com',
    ])
    assert.equal(config.network.allowLocalBinding, false)
    assert.equal(config.network.allowAllUnixSockets, false)
    assert.deepEqual(config.filesystem.allowWrite, [])
    assert.ok(config.filesystem.denyRead.includes(homedir()))
    assert.ok(config.filesystem.denyRead.includes(tmpdir()))
    // A denylist must cover the usual project and data roots, not only home.
    for (const root of ['/workspace', '/srv', '/opt', '/mnt', '/home']) {
      assert.ok(config.filesystem.denyRead.includes(root), root)
    }
    assert.equal(config.filesystem.allowGitConfig, false)
    assert.deepEqual(result.proxyOptions?.allowedHosts, [
      'cloud-agent-artifacts.s3.us-east-1.amazonaws.com',
    ])
  })

  it('passes the signed URL and proxy token over stdin only, never argv or env', async () => {
    const result = await run('ok')
    const recorded = result.recorded()
    assert.equal(recorded.job['url'], SIGNED)
    assert.match(String(recorded.job['proxyToken']), /^[a-f0-9]{64}$/u)
    assert.equal(recorded.job['proxyToken'], result.proxyOptions?.token)
    const outside = JSON.stringify({
      argv: recorded.argv,
      env: recorded.env,
      wrapped: result.wrapped,
    })
    assert.doesNotMatch(outside, /topsecretsignature/u)
    assert.ok(!outside.includes(String(recorded.job['proxyToken'])))
    assert.equal(
      result.wrapped,
      `'/opt/copse/Copse Helper' '/opt/copse/dist/main/artifact-image-downloader.js'`,
    )
  })

  it('builds the downloader environment from scratch', async () => {
    const env = (await run('ok')).recorded().env
    assert.equal(env['CURSOR_API_KEY'], undefined)
    assert.equal(env['NODE_OPTIONS'], undefined)
    assert.equal(env['HTTPS_PROXY'], undefined)
    assert.equal(env['ELECTRON_RUN_AS_NODE'], '1')
    assert.deepEqual(
      downloaderEnv({ PATH: '/x', SSH_AUTH_SOCK: '/tmp/agent', GITHUB_TOKEN: 't' }),
      {
        PATH: '/x',
        ELECTRON_RUN_AS_NODE: '1',
      },
    )
  })

  it('fails closed when the sandbox cannot start, never spawning anything', async () => {
    const result = await run('ok', { initializeFails: true })
    assert.equal(onlyError(result.frames), 'sandbox-unavailable')
    assert.equal(result.child, null)
    assert.equal(result.proxyClosed, true)
    assert.equal(result.resetCalls, 0)
  })

  it('fails closed when its proxy cannot start, never initializing ASRT or spawning', async () => {
    const frames: ImageFrame[] = []
    let initialized = false
    let spawned = false
    await runArtifactImageHostJob(
      JOB,
      {
        sandbox: {
          initialize: () => {
            initialized = true
            return Promise.resolve()
          },
          wrap: () => Promise.resolve({ argv: ['true'], env: {} }),
          reset: () => Promise.resolve(),
        },
        startProxy: () => Promise.reject(new Error('EADDRNOTAVAIL')),
        spawn: () => {
          spawned = true
          return spawn('true')
        },
        nodePath: '/x',
        downloaderPath: '/x/d.js',
        runtimeReadPaths: [],
      },
      (frame) => frames.push(frame),
      new AbortController().signal,
    )
    assert.equal(onlyError(frames), 'sandbox-unavailable')
    assert.equal(initialized, false)
    assert.equal(spawned, false)
  })

  it('refuses a job whose URL is outside its own approved origins before starting a proxy', async () => {
    const result = await run('ok', { job: { ...JOB, url: 'https://evil.example/x.png' } })
    assert.equal(onlyError(result.frames), 'origin-denied')
    assert.equal(result.proxyOptions, null)
  })

  it('refuses a job carrying a non-canonical approved origin', async () => {
    const result = await run('ok', {
      job: { ...JOB, approvedOrigins: ['https://*.amazonaws.com'] },
    })
    assert.equal(onlyError(result.frames), 'protocol')
  })

  for (const [mode, expected] of [
    ['garbage', 'protocol'],
    ['partial', 'protocol'],
    ['forged-digest', 'protocol'],
    ['wrong-request', 'protocol'],
    ['huge-line', 'protocol'],
    ['redirect-denied', 'redirect-denied'],
  ] as const) {
    it(`turns a downloader that sends ${mode} into one ${expected} error, with no partial bytes`, async () => {
      const result = await run(mode)
      assert.equal(onlyError(result.frames), expected)
      assert.equal(result.resetCalls, 1)
      assert.equal(result.proxyClosed, true)
    })
  }

  it('reports a downloader that exits silently as sandbox-unavailable, not a retryable error', async () => {
    const result = await run('silent-exit')
    assert.equal(onlyError(result.frames), 'sandbox-unavailable')
  })

  it('kills a downloader that ignores SIGTERM before resetting ASRT', async () => {
    const result = await run('ignore-term')
    // The image itself was verified and relayed...
    assert.equal(result.frames.at(-1)?.type, 'done')
    // ...and teardown waited for SIGKILL to land before the sandbox went away.
    assert.equal(result.child?.signalCode, 'SIGKILL')
    assert.equal(result.childGoneAtReset, true)
  })

  it('kills a hung downloader at the deadline', async () => {
    const result = await run('hang', { deadlineMs: 300 })
    assert.equal(onlyError(result.frames), 'timeout')
    assert.notEqual(result.child?.exitCode ?? result.child?.signalCode ?? null, null)
    assert.equal(result.resetCalls, 1)
  })

  it('cancels and kills the downloader when the parent goes away', async () => {
    const abort = new AbortController()
    setTimeout(() => {
      abort.abort()
    }, 200)
    const result = await run('hang', { signal: abort.signal })
    assert.equal(onlyError(result.frames), 'cancelled')
    assert.notEqual(result.child?.exitCode ?? result.child?.signalCode ?? null, null)
    assert.equal(result.proxyClosed, true)
  })
})

describe('approvedHosts', () => {
  it('accepts only canonical origins', () => {
    assert.deepEqual(approvedHosts([ORIGIN]), ['cloud-agent-artifacts.s3.us-east-1.amazonaws.com'])
    assert.equal(approvedHosts([`${ORIGIN}/`]), null)
    assert.equal(approvedHosts(['http://a.example']), null)
  })
})

// Keep the fixture image honest: the host relays exactly what it verified.
describe('fixture', () => {
  it('frames the fixture image', () => {
    assert.equal(imageFrames(REQUEST, 'image/png', pngBytes()).length, 2)
  })
})
