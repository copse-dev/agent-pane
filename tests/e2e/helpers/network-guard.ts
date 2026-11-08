import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http'
import { connect as netConnect, isIP, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

/**
 * Outbound network guard for e2e (docs/testing-strategy.md#outbound-network-guard).
 *
 * Two boundaries share one JSONL ledger:
 * - Node in Electron's main process: tests/e2e/electron-shell/network-guard.cjs.
 * - Chromium (renderer, webviews, Electron `net`): a loopback proxy started here
 *   and passed as `--proxy-server`. Chromium bypasses a proxy for loopback, so only
 *   non-loopback requests ever reach it.
 * A root Mocha `afterEach` reads the attempts each test produced and fails it.
 */

export type NetworkGuardMode = 'off' | 'log' | 'enforce'

/** `COPSE_E2E_NETWORK_GUARD`: `enforce` (default), `log` (record and forward), or `off`. */
export function networkGuardMode(value: string | undefined): NetworkGuardMode {
  const mode = value?.trim().toLowerCase() ?? ''
  if (mode === '' || mode === 'enforce') return 'enforce'
  if (mode === 'log' || mode === 'off') return mode
  throw new Error(`COPSE_E2E_NETWORK_GUARD must be enforce, log or off (got "${mode}")`)
}

const NetworkAttempt = z.object({
  at: z.string(),
  source: z.enum(['node', 'chromium']),
  process: z.string(),
  kind: z.string(),
  host: z.string(),
  port: z.number().nullable(),
  blocked: z.boolean(),
  detail: z.string().optional(),
  stack: z.array(z.string()).optional(),
})
export type NetworkAttempt = z.infer<typeof NetworkAttempt>

const decodeAttempt = decodeWithSchema(NetworkAttempt)

/**
 * True for names and addresses that never leave this machine. Mirrors
 * `isLoopbackHost` in electron-shell/network-guard.cjs; network-guard.test.ts
 * pins the two to the same table.
 */
export function isLoopbackHost(rawHost: string | undefined): boolean {
  if (rawHost === undefined || rawHost === '') return true
  let host = rawHost.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  host = host.replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true
  const family = isIP(host)
  if (family === 4) return host.startsWith('127.') || host === '0.0.0.0'
  if (family === 6) {
    if (host === '::1' || host === '::') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
    return mapped?.[1] !== undefined && isLoopbackHost(mapped[1])
  }
  return false
}

function describeTarget(attempt: NetworkAttempt): string {
  return attempt.port === null ? attempt.host : `${attempt.host}:${String(attempt.port)}`
}

/** One line per attempt: what, where, which process, and who asked. */
export function formatNetworkAttempt(attempt: NetworkAttempt): string {
  const action = attempt.blocked ? 'blocked' : 'observed'
  const initiator =
    attempt.stack && attempt.stack.length > 0
      ? `\n      ${attempt.stack.slice(0, 6).join('\n      ')}`
      : attempt.detail
        ? ` (${attempt.detail})`
        : ''
  return `${action} ${attempt.kind} ${describeTarget(attempt)} from ${attempt.process}${initiator}`
}

export class UnexpectedNetworkEgressError extends Error {
  constructor(attempts: readonly NetworkAttempt[], context: string) {
    const hosts = [...new Set(attempts.map(describeTarget))].join(', ')
    super(
      `${context}: e2e tests may only reach loopback, but this test tried to reach ${hosts}.\n` +
        attempts.map((attempt) => `  - ${formatNetworkAttempt(attempt)}`).join('\n') +
        '\nMock the service at its boundary (docs/testing-strategy.md#outbound-network-guard).',
    )
    this.name = 'UnexpectedNetworkEgressError'
  }
}

/** Reads ledger lines appended since the previous call. */
export function createLedgerReader(ledgerPath: string): () => NetworkAttempt[] {
  let offset = 0
  let partial = ''
  return () => {
    let fd: number
    try {
      fd = openSync(ledgerPath, 'r')
    } catch {
      return []
    }
    try {
      const size = fstatSync(fd).size
      if (size <= offset) return []
      const buffer = Buffer.alloc(size - offset)
      readSync(fd, buffer, 0, buffer.length, offset)
      offset = size
      const lines = (partial + buffer.toString('utf8')).split('\n')
      partial = lines.pop() ?? ''
      return lines.flatMap((line) => {
        if (line.trim() === '') return []
        const attempt = safeJsonParse(line, decodeAttempt)
        return attempt ? [attempt] : []
      })
    } finally {
      closeSync(fd)
    }
  }
}

function appendAttempt(ledgerPath: string, attempt: NetworkAttempt): void {
  appendFileSync(ledgerPath, `${JSON.stringify(attempt)}\n`)
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority)
  if (bracketed) {
    return { host: bracketed[1] ?? '', port: Number(bracketed[2] ?? defaultPort) }
  }
  const index = authority.lastIndexOf(':')
  if (index === -1) return { host: authority, port: defaultPort }
  return { host: authority.slice(0, index), port: Number(authority.slice(index + 1)) }
}

/**
 * Loopback HTTP proxy for Chromium. In `enforce` mode every request is refused
 * with 403; in `log` mode it is recorded and forwarded unchanged.
 */
export async function startNetworkGuardProxy(options: {
  mode: Exclude<NetworkGuardMode, 'off'>
  ledgerPath: string
}): Promise<{ port: number; close: () => Promise<void> }> {
  const enforce = options.mode === 'enforce'
  const record = (kind: string, host: string, port: number, detail: string): void => {
    appendAttempt(options.ledgerPath, {
      at: new Date().toISOString(),
      source: 'chromium',
      process: 'chromium network service (renderer, webview or Electron net)',
      kind,
      host,
      port,
      blocked: enforce,
      detail,
    })
  }
  const refusalBody = (target: string): string =>
    `[e2e-network-guard] ${target} refused: e2e tests may only reach loopback\n`

  const server: Server = createServer((req, res) => {
    const rawUrl = req.url ?? ''
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      res.writeHead(400).end()
      return
    }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const loopback = isLoopbackHost(url.hostname)
    if (!loopback) {
      record('http', url.hostname, port, `${req.method ?? 'GET'} ${url.origin}${url.pathname}`)
    }
    if (enforce && !loopback) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end(refusalBody(url.host))
      return
    }
    const upstream = httpRequest(
      {
        host: url.hostname,
        port,
        method: req.method,
        path: url.pathname + url.search,
        headers: forwardedHeaders(req.headers),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })

  server.on('connect', (req, clientSocket, head) => {
    const { host, port } = splitHostPort(req.url ?? '', 443)
    const loopback = isLoopbackHost(host)
    if (!loopback) {
      const agent = req.headers['user-agent']
      record('CONNECT', host, port, agent ? `user-agent ${agent}` : 'CONNECT tunnel')
    }
    if (enforce && !loopback) {
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${refusalBody(
          `${host}:${String(port)}`,
        )}`,
      )
      return
    }
    const upstream = netConnect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address: AddressInfo | string | null = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('network guard proxy has no TCP address')
  }
  // Keep-alive tunnels from a dead Electron must not hold the worker open.
  server.unref()
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}

function forwardedHeaders(headers: OutgoingHttpHeaders): OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.toLowerCase().startsWith('proxy-')),
  )
}

/** Chromium switches that send every non-loopback request through the guard proxy. */
export function networkGuardChromiumArgs(proxyPort: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${String(proxyPort)}`,
    // Chromium already bypasses the proxy for loopback; state it so a future
    // default change cannot route the app's own loopback servers through it.
    '--proxy-bypass-list=<local>;localhost;*.localhost;127.0.0.1;[::1]',
  ]
}

export function networkGuardLedgerPath(dir: string): string {
  return join(dir, 'network-guard.jsonl')
}

const expectedHosts = new Set<string>()

/**
 * Declare, inside one test, that it deliberately reaches `host` (for example a
 * spec proving that a public URL is refused). The attempt is still blocked; the
 * guard only stops counting it as a failure and instead requires it to happen.
 * Every use is an explicit exception: list it in docs/testing-strategy.md.
 */
export function expectNetworkEgress(host: string): void {
  expectedHosts.add(host.toLowerCase())
}

interface NetworkGuardHookContext {
  currentTest?: { title: string; fullTitle?: () => string; state?: string; file?: string }
  test?: { title: string; file?: string; parent?: { fullTitle?: () => string } }
}

/**
 * Root Mocha hooks that attribute ledger entries to the test that produced them.
 * `log` prints every attempt with a grep-able `[e2e-network-guard]` prefix;
 * `enforce` fails a passing test and reports alongside an already failing one.
 */
export function createNetworkGuard(options: {
  mode: NetworkGuardMode
  readAttempts: () => NetworkAttempt[]
  log?: (line: string) => void
  warn?: (line: string) => void
}): {
  afterEach: (this: NetworkGuardHookContext) => void
  afterAll: (this: NetworkGuardHookContext) => void
} {
  const log =
    options.log ??
    ((line: string): void => {
      console.log(line)
    })
  const warn =
    options.warn ??
    ((line: string): void => {
      console.error(line)
    })
  const report = (title: string, file: string | undefined, failedAlready: boolean): void => {
    const expected = new Set(expectedHosts)
    expectedHosts.clear()
    if (options.mode === 'off') return
    const all = options.readAttempts()
    const attempts = all.filter((attempt) => !expected.has(attempt.host.toLowerCase()))
    const missing = [...expected].filter(
      (host) => !all.some((attempt) => attempt.host.toLowerCase() === host),
    )
    if (missing.length > 0 && !failedAlready) {
      throw new Error(
        `${title}: expected the network guard to see ${missing.join(', ')}, but it saw ` +
          (all.length === 0 ? 'nothing' : all.map(formatNetworkAttempt).join('; ')),
      )
    }
    if (attempts.length === 0) return
    for (const attempt of attempts) {
      log(
        `[e2e-network-guard] ${JSON.stringify({ spec: file ?? null, test: title, ...attempt, stack: attempt.stack?.slice(0, 6) })}`,
      )
    }
    if (options.mode !== 'enforce') return
    const error = new UnexpectedNetworkEgressError(attempts, title)
    // Keep the body's own failure; still name the egress, which may be its cause.
    if (failedAlready) {
      warn(error.message)
      return
    }
    throw error
  }
  return {
    afterEach(): void {
      const test = this.currentTest
      const title = test?.fullTitle?.() ?? test?.title ?? 'e2e test'
      report(title, test?.file, test?.state === 'failed')
    },
    afterAll(): void {
      // Teardown after the last test (app shutdown, after() hooks) still counts.
      const file = this.test?.file
      report('after all tests', file, false)
    },
  }
}
