/**
 * Native containment for the artifact-image downloader: the production sandbox
 * profile and ASRT adapter, run for real. Skips on Windows, and on a host where
 * ASRT cannot start a sandbox at all (for example a container that forbids the
 * nested user namespace bubblewrap's seccomp helper needs), saying why.
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronRuntimeAllowReadPaths } from '../../../project-sandbox/config.ts'
import { resolveSandboxShellExecutable } from '../../../project-sandbox/sandbox-argv.ts'
import { asrtHostSandbox } from './asrt-host-sandbox.ts'
import { startEgressProxy, type EgressDecision, type EgressProxy } from './egress-proxy.ts'
import { downloaderEnv, downloaderSandboxConfig } from './host.ts'

/** Stands in for the downloader: reports what its sandbox lets it reach. */
const PROBE = `
const net = require('node:net')
const fs = require('node:fs')
const [loopbackPort, sentinel] = process.argv.slice(2)
const report = {}
function done() { process.stdout.write(JSON.stringify(report) + '\\n'); process.exit(0) }
function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) })
    const timer = setTimeout(() => { socket.destroy(); resolve('blocked') }, 3000)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('LEAK') })
    socket.once('error', () => { clearTimeout(timer); resolve('blocked') })
  })
}
function proxyStatus(port, attempts) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('error', () => {
      if (attempts > 0) setTimeout(() => resolve(proxyStatus(port, attempts - 1)), 50)
      else resolve('unreachable')
    })
    socket.once('connect', () => {
      socket.write('CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n')
    })
    socket.once('data', (chunk) => {
      socket.destroy()
      resolve((/^HTTP\\/1\\.[01] (\\d{3})/.exec(String(chunk)) || [])[1] || 'garbled')
    })
  })
}
;(async () => {
  const proxy = new URL(process.env.HTTPS_PROXY || 'http://invalid:0')
  report.proxy = await proxyStatus(Number(proxy.port), 60)
  report.loopback = await tryConnect('127.0.0.1', loopbackPort)
  report.internet = await tryConnect('1.1.1.1', 443)
  try { fs.readFileSync(sentinel); report.sentinel = 'LEAK' } catch { report.sentinel = 'blocked' }
  done()
})()
`

function run(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(resolveSandboxShellExecutable(file), args, { cwd: '/', env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('close', (code) => {
      resolve({ code, stdout, stderr })
    })
    child.once('error', (error) => {
      resolve({ code: -1, stdout, stderr: error.message })
    })
  })
}

describe(
  'artifact-image downloader native containment',
  { skip: process.platform === 'win32' },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-image-native-')))
    const probeDir = join(root, 'probe')
    const probe = join(probeDir, 'probe.cjs')
    const sentinel = join(root, 'secret.txt')
    const decisions: EgressDecision[] = []
    let proxy: EgressProxy | null = null
    let loopback: Server | null = null
    let started = false

    before(async () => {
      mkdirSync(probeDir)
      writeFileSync(probe, PROBE)
      writeFileSync(sentinel, 'host secret')
      loopback = createServer((socket) => socket.end('host loopback'))
      await new Promise<void>((resolve) => loopback?.listen(0, '127.0.0.1', resolve))
      proxy = await startEgressProxy({
        token: 'a'.repeat(64),
        allowedHosts: ['cloud-agent-artifacts.s3.us-east-1.amazonaws.com'],
        onDecision: (decision) => decisions.push(decision),
      })
    })

    after(async () => {
      if (started) await asrtHostSandbox.reset().catch(() => {})
      await proxy?.close()
      const server = loopback
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve()
          })
        })
      }
      rmSync(root, { recursive: true, force: true })
    })

    it(
      'reaches only its job proxy and cannot read outside its own directory',
      { timeout: 60_000 },
      async (t) => {
        assert.ok(proxy && loopback)
        const loopbackAddress = loopback.address()
        assert.ok(loopbackAddress && typeof loopbackAddress !== 'string')
        try {
          await asrtHostSandbox.initialize(
            downloaderSandboxConfig({
              proxyPort: proxy.port,
              allowedHosts: ['cloud-agent-artifacts.s3.us-east-1.amazonaws.com'],
              downloaderPath: probe,
              runtimeReadPaths: electronRuntimeAllowReadPaths(process.execPath),
            }),
          )
          started = true
        } catch (error) {
          t.skip(`ASRT unavailable: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        // Prove the host can run anything sandboxed before judging containment.
        const smoke = await asrtHostSandbox.wrap('true')
        const [smokeFile = '', ...smokeArgs] = smoke.argv
        const smokeRun = await run(smokeFile, smokeArgs, downloaderEnv(smoke.env))
        if (smokeRun.code !== 0) {
          t.skip(
            `ASRT cannot start a sandbox on this host: ${smokeRun.stderr.trim().slice(0, 200)}`,
          )
          return
        }

        const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
        const wrapped = await asrtHostSandbox.wrap(
          [process.execPath, probe, String(loopbackAddress.port), sentinel].map(quote).join(' '),
        )
        const [file = '', ...args] = wrapped.argv
        const result = await run(file, args, downloaderEnv(wrapped.env))
        assert.equal(result.code, 0, result.stderr)
        const report: unknown = JSON.parse(result.stdout.trim())
        assert.deepEqual(report, {
          // The job proxy answered: an unauthenticated CONNECT is refused with 407.
          proxy: '407',
          loopback: 'blocked',
          internet: 'blocked',
          sentinel: 'blocked',
        })
        assert.ok(decisions.some((decision) => decision.outcome === 'unauthenticated'))
      },
    )
  },
)
