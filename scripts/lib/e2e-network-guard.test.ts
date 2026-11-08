import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  createLedgerReader,
  createNetworkGuard,
  expectNetworkEgress,
  isLoopbackHost,
  networkGuardChromiumArgs,
  networkGuardMode,
  startNetworkGuardProxy,
  UnexpectedNetworkEgressError,
  type NetworkAttempt,
} from '../../tests/e2e/helpers/network-guard.ts'
import {
  parseNetworkGuardLines,
  renderNetworkReport,
  summariseNetworkGuard,
} from './e2e-network-report.mts'

const NODE_GUARD = join(process.cwd(), 'tests/e2e/electron-shell/network-guard.cjs')

const HOSTS = [
  'localhost',
  'LOCALHOST.',
  'app.localhost',
  '127.0.0.1',
  '127.9.8.7',
  '0.0.0.0',
  '::1',
  '[::1]',
  '::',
  '::ffff:127.0.0.1',
  '',
  'example.com',
  'localhost.example.com',
  '10.0.0.1',
  '192.168.1.42',
  '169.254.169.254',
  '8.8.8.8',
  '::ffff:8.8.8.8',
  '2001:db8::1',
  'redirector.gvt1.com',
]

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'copse-network-guard-'))
}

function attempt(overrides: Partial<NetworkAttempt> = {}): NetworkAttempt {
  return {
    at: '2026-11-08T00:00:00.000Z',
    source: 'node',
    process: 'electron main (Node)',
    kind: 'connect',
    host: 'example.com',
    port: 443,
    blocked: true,
    stack: ['at fetchThing (/app/dist/main/index.js:1:2)'],
    ...overrides,
  }
}

/** Run `script` in a fresh Node process with the Node guard installed. */
function runGuarded(mode: 'log' | 'enforce', script: string): { stdout: string; ledger: string } {
  const dir = scratch()
  try {
    const ledgerPath = join(dir, 'ledger.jsonl')
    const prelude = `require(${JSON.stringify(NODE_GUARD)}).install({ mode: ${JSON.stringify(mode)}, ledgerPath: ${JSON.stringify(ledgerPath)}, processLabel: 'unit child' });\n`
    const result = spawnSync(process.execPath, ['-e', prelude + script], {
      encoding: 'utf8',
      timeout: 30_000,
      // A host proxy would otherwise carry undici fetch through an allowed loopback hop.
      // An inherited unit preload would install first and own the guard.
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '',
        HTTPS_PROXY: '',
        HTTP_PROXY: '',
        NODE_OPTIONS: '',
        COPSE_UNIT_NETWORK_GUARD: '',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    let ledger = ''
    try {
      ledger = readFileSync(ledgerPath, 'utf8')
    } catch {
      // No attempts recorded.
    }
    return { stdout: result.stdout, ledger }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('e2e network guard: loopback rule', () => {
  it('agrees between the Node guard and the WDIO helper', () => {
    const { stdout } = runGuarded(
      'log',
      `const { isLoopbackHost } = require(${JSON.stringify(NODE_GUARD)});\n` +
        `process.stdout.write(JSON.stringify(${JSON.stringify(HOSTS)}.map((h) => isLoopbackHost(h))))`,
    )
    assert.deepEqual(
      JSON.parse(stdout),
      HOSTS.map((host) => isLoopbackHost(host)),
    )
    assert.deepEqual(
      HOSTS.filter((host) => isLoopbackHost(host)),
      [
        'localhost',
        'LOCALHOST.',
        'app.localhost',
        '127.0.0.1',
        '127.9.8.7',
        '0.0.0.0',
        '::1',
        '[::1]',
        '::',
        '::ffff:127.0.0.1',
        '',
      ],
    )
  })
})

describe('e2e network guard: Node boundary', () => {
  it('refuses fetch, http, raw TCP, DNS and UDP past loopback and records each one', () => {
    const { stdout, ledger } = runGuarded(
      'enforce',
      `
const http = require('node:http')
const net = require('node:net')
const dns = require('node:dns')
const dgram = require('node:dgram')
const outcomes = {}
const note = (name) => (error) => { outcomes[name] = error ? String(error.message) : 'ok' }
;(async () => {
  const server = http.createServer((_req, res) => res.end('loopback'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const local = await fetch('http://127.0.0.1:' + server.address().port + '/')
  outcomes.loopback = await local.text()
  server.close()
  await fetch('https://example.com/').then(() => note('fetch')(), (e) => note('fetch')(e.cause ?? e))
  await new Promise((resolve) => http.get('http://example.org/', () => resolve()).on('error', (e) => { note('http')(e); resolve() }))
  await new Promise((resolve) => net.connect(443, '203.0.113.7').on('error', (e) => { note('net')(e); resolve() }))
  await new Promise((resolve) => dns.lookup('example.net', (e) => { note('lookup')(e); resolve() }))
  await dns.promises.resolve4('example.edu').then(() => note('resolve4')(), note('resolve4'))
  const udp = dgram.createSocket('udp4')
  await new Promise((resolve) => udp.send('x', 53, '8.8.8.8', (e) => { note('udp')(e); resolve() }))
  udp.close()
  process.stdout.write(JSON.stringify(outcomes))
})()
`,
    )
    const outcomes: unknown = JSON.parse(stdout)
    assert.ok(outcomes && typeof outcomes === 'object')
    const values = Object.entries(outcomes)
    assert.deepEqual(
      values.find(([name]) => name === 'loopback'),
      ['loopback', 'loopback'],
    )
    for (const [name, message] of values) {
      if (name === 'loopback') continue
      assert.match(String(message), /\[e2e-network-guard\] .* refused/, name)
    }
    assert.deepEqual(values.map(([name]) => name).sort(), [
      'fetch',
      'http',
      'lookup',
      'loopback',
      'net',
      'resolve4',
      'udp',
    ])
    const recorded = ledger
      .trim()
      .split('\n')
      .map((line) => {
        const parsed: unknown = JSON.parse(line)
        assert.ok(parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'host'))
        return parsed
      })
    const reader = parseNetworkGuardLines(
      recorded
        .map(
          (entry) => `[e2e-network-guard] ${JSON.stringify({ spec: null, test: 't', ...entry })}`,
        )
        .join('\n'),
    )
    assert.deepEqual(reader.map((entry) => `${entry.kind} ${entry.host}`).sort(), [
      'connect 203.0.113.7',
      'connect example.com',
      'connect example.org',
      'dns.lookup example.net',
      'dns.resolve4 example.edu',
      'udp 8.8.8.8',
    ])
    assert.ok(reader.every((entry) => entry.blocked && entry.process === 'unit child'))
    // The initiator is the caller's frame, not the guard's own.
    assert.ok(
      reader.every((entry) => !(entry.stack ?? []).some((f) => f.includes('network-guard.cjs'))),
    )
  })

  it('records without refusing in log mode', () => {
    const { stdout, ledger } = runGuarded(
      'log',
      `require('node:dns').lookup('copse-guard-check.invalid', (e) => process.stdout.write(String(e && e.message)))`,
    )
    assert.doesNotMatch(stdout, /e2e-network-guard/)
    const entry: unknown = JSON.parse(ledger.trim())
    assert.ok(entry && typeof entry === 'object')
    assert.deepEqual(
      [Reflect.get(entry, 'kind'), Reflect.get(entry, 'host'), Reflect.get(entry, 'blocked')],
      ['dns.lookup', 'copse-guard-check.invalid', false],
    )
  })
})

describe('e2e network guard: Chromium proxy', () => {
  it('refuses CONNECT and absolute-URL requests and records the target', async () => {
    const dir = scratch()
    const ledgerPath = join(dir, 'ledger.jsonl')
    const proxy = await startNetworkGuardProxy({ mode: 'enforce', ledgerPath })
    try {
      const connectReply = await new Promise<string>((resolve, reject) => {
        const socket = netConnect(proxy.port, '127.0.0.1', () => {
          socket.write(
            'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nUser-Agent: unit\r\n\r\n',
          )
        })
        let data = ''
        socket.on('data', (chunk) => (data += chunk.toString()))
        socket.on('end', () => {
          resolve(data)
        })
        socket.on('error', reject)
      })
      assert.match(connectReply, /^HTTP\/1\.1 403 /)
      assert.match(connectReply, /\[e2e-network-guard\] example\.com:443 refused/)

      const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: proxy.port, path: 'http://example.org/page?q=1' },
          (res) => {
            let text = ''
            res.on('data', (chunk: Buffer) => (text += chunk.toString()))
            res.on('end', () => {
              resolve({ status: res.statusCode ?? 0, text })
            })
          },
        )
        req.on('error', reject)
        req.end()
      })
      assert.equal(body.status, 403)
      assert.match(body.text, /example\.org refused/)

      const attempts = createLedgerReader(ledgerPath)()
      assert.deepEqual(
        attempts.map((a) => [a.source, a.kind, a.host, a.port, a.blocked, a.detail]),
        [
          ['chromium', 'CONNECT', 'example.com', 443, true, 'user-agent unit'],
          ['chromium', 'http', 'example.org', 80, true, 'GET http://example.org/page'],
        ],
      )
    } finally {
      await proxy.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('routes Chromium through the proxy without proxying loopback', () => {
    assert.deepEqual(networkGuardChromiumArgs(4321), [
      '--proxy-server=http://127.0.0.1:4321',
      '--proxy-bypass-list=<local>;localhost;*.localhost;127.0.0.1;[::1]',
    ])
  })
})

describe('e2e network guard: Mocha hooks', () => {
  const hooks = (
    mode: 'log' | 'enforce',
    attempts: NetworkAttempt[],
  ): { guard: ReturnType<typeof createNetworkGuard>; logged: string[]; warned: string[] } => {
    const logged: string[] = []
    const warned: string[] = []
    let pending = attempts
    const guard = createNetworkGuard({
      mode,
      readAttempts: () => {
        const next = pending
        pending = []
        return next
      },
      log: (line) => logged.push(line),
      warn: (line) => warned.push(line),
    })
    return { guard, logged, warned }
  }
  const context = (
    state: string,
  ): { currentTest: { title: string; state: string; file: string } } => ({
    currentTest: { title: 'opens settings', state, file: '/repo/tests/e2e/settings.e2e.ts' },
  })

  it('fails a passing test that reached a public host, naming it', () => {
    const { guard, logged } = hooks('enforce', [attempt()])
    assert.throws(
      () => {
        guard.afterEach.call(context('passed'))
      },
      (error: unknown) =>
        error instanceof UnexpectedNetworkEgressError &&
        /opens settings: .*tried to reach example\.com:443/.test(error.message) &&
        error.message.includes('at fetchThing'),
    )
    assert.equal(logged.length, 1)
  })

  it('keeps an already failing test failure and only reports', () => {
    const { guard, logged, warned } = hooks('enforce', [attempt()])
    guard.afterEach.call(context('failed'))
    assert.equal(logged.length, 1)
    assert.match(warned.join('\n'), /tried to reach example\.com:443/)
  })

  it('only logs in log mode and passes nothing when nothing was attempted', () => {
    const logMode = hooks('log', [attempt({ blocked: false })])
    logMode.guard.afterEach.call(context('passed'))
    assert.equal(logMode.logged.length, 1)
    const quiet = hooks('enforce', [])
    quiet.guard.afterEach.call(context('passed'))
    assert.deepEqual(quiet.logged, [])
  })

  it('accepts a declared attempt and requires it to have happened', () => {
    const seen = hooks('enforce', [attempt({ host: 'example.org' })])
    expectNetworkEgress('example.org')
    seen.guard.afterEach.call(context('passed'))

    const missing = hooks('enforce', [])
    expectNetworkEgress('example.org')
    assert.throws(() => {
      missing.guard.afterEach.call(context('passed'))
    }, /expected the network guard to see example\.org, but it saw nothing/)
    // A declaration lasts for one test only.
    const next = hooks('enforce', [attempt({ host: 'example.org' })])
    assert.throws(() => {
      next.guard.afterEach.call(context('passed'))
    }, UnexpectedNetworkEgressError)
  })

  it('attributes teardown attempts after the last test', () => {
    const { guard } = hooks('enforce', [attempt()])
    assert.throws(() => {
      guard.afterAll.call({ test: { title: '"after all" hook', file: 'x.e2e.ts' } })
    }, /after all tests/)
  })
})

describe('e2e network guard: mode and report', () => {
  it('defaults to enforce and rejects unknown modes', () => {
    assert.equal(networkGuardMode(undefined), 'enforce')
    assert.equal(networkGuardMode(' LOG '), 'log')
    assert.equal(networkGuardMode('off'), 'off')
    assert.throws(() => networkGuardMode('warn'), /enforce, log or off/)
  })

  it('summarises guard lines per host with the specs that reached it', () => {
    const line = (spec: string, host: string): string =>
      `[0-0] [e2e-network-guard] ${JSON.stringify({ spec, test: 't', ...attempt({ host }) })}`
    const rows = summariseNetworkGuard(
      parseNetworkGuardLines(
        [
          line('/w/tests/e2e/a.e2e.ts', 'redirector.gvt1.com'),
          'unrelated output',
          line('/w/tests/e2e/b.e2e.ts', 'redirector.gvt1.com'),
          line('/w/tests/e2e/b.e2e.ts', 'example.com'),
          '[e2e-network-guard] {not json',
        ].join('\n'),
      ),
    )
    assert.deepEqual(
      rows.map((row) => [row.host, row.count, row.specs]),
      [
        ['redirector.gvt1.com', 2, ['tests/e2e/a.e2e.ts', 'tests/e2e/b.e2e.ts']],
        ['example.com', 1, ['tests/e2e/b.e2e.ts']],
      ],
    )
    assert.match(renderNetworkReport(rows), /\| redirector\.gvt1\.com:443 \| connect \|/)
    assert.equal(renderNetworkReport([]), 'No non-loopback network attempts were recorded.\n')
  })
})
