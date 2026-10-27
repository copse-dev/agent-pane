import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
  type Server,
} from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { EgressBroker } from './egress-broker.ts'
import { EgressLink } from './egress-link.ts'
import { parseEgressRule } from './egress-rules.ts'
import {
  authorizationFor,
  GitHubCapability,
  GITHUB_UPSTREAM_IDLE_TIMEOUT_MS,
  requestFraming,
} from './github-capability.ts'
import {
  encodeHead,
  githubResponseHeadSchema,
  HOST_GITHUB_TARGET,
  type GitHubRequestHead,
} from './github-capability-wire.ts'
import { startGuestGitHubBridge, type GuestGitHubBridge } from './guest-github-bridge.ts'

/**
 * The capability end to end, in one process: a client the way `gh` (unix
 * socket, origin-form) or `git` (loopback proxy, absolute-form) talks to the
 * guest bridge → the stdio link → the broker → the host handler → a fake
 * GitHub on loopback standing in for the real hosts. The upstream seam is
 * the handler's injected request function, so every request the fake sees
 * is exactly what would have gone to GitHub.
 */

const REAL_TOKEN = 'ghp_RealTokenValue0123456789abcdefABCD'
const PLACEHOLDER = 'ghp_copse_tabc123_rtest_00ff00ff'

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

function startFakeGitHub(): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    if (req.url === '/hang') {
      // Never answers; only an upstream timeout ends this request.
      seen.push({ method: req.method ?? '', url: req.url, headers: req.headers, body: '' })
      return
    }
    const parts: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      parts.push(chunk)
    })
    req.on('end', () => {
      const body = Buffer.concat(parts).toString('utf8')
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const url = req.url ?? ''
      if (url === '/redirect') {
        res.writeHead(302, {
          Location: 'https://results-receiver.actions.githubusercontent.com/log?sig=abc',
        })
        res.end()
        return
      }
      if (url === '/reflect') {
        // A misbehaving endpoint that echoes the credential, split across
        // two writes so the scrubber has to catch it across a chunk boundary.
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Echo': `token ${REAL_TOKEN}` })
        res.write(`before ${REAL_TOKEN.slice(0, 12)}`)
        setTimeout(() => {
          res.end(`${REAL_TOKEN.slice(12)} after`)
        }, 20)
        return
      }
      if (url === '/gzip') {
        res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' })
        res.end(gzipSync(`zipped ${REAL_TOKEN} zipped`))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: url }))
    })
  })
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolveStart({ server, port, seen })
    })
  })
}

/** The `message` gh prints from an error body. */
function messageOf(body: string): string {
  const parsed = safeJsonParse(body, decodeWithSchema(z.object({ message: z.string() })))
  return parsed?.message ?? ''
}

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function send(options: RequestOptions, body?: string): Promise<Answer> {
  return new Promise((resolveSend, reject) => {
    const req = httpRequest(options, (res) => {
      const parts: Buffer[] = []
      res.on('data', (chunk: Buffer) => {
        parts.push(chunk)
      })
      res.on('end', () => {
        resolveSend({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(parts).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Resolve once `check` holds, polling briefly; fails the test after two seconds. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for the condition')
    await new Promise((resolveTick) => setTimeout(resolveTick, 5))
  }
}

/**
 * Serve one request straight into the host handler, bypassing the guest
 * bridge: a head and body bytes that need not agree, as a worker that does
 * not frame honestly could send them.
 */
async function serveDirect(
  capability: GitHubCapability,
  head: GitHubRequestHead,
  body: Buffer,
): Promise<{ status: number | null; text: string }> {
  const written: Buffer[] = []
  const stream = new Duplex({
    read(): void {},
    write(chunk: Buffer, _encoding, callback): void {
      written.push(chunk)
      callback()
    },
  })
  stream.push(Buffer.from(encodeHead(head)))
  stream.push(body)
  stream.push(null)
  await capability.serve(stream)
  if (!stream.destroyed && !stream.writableFinished) {
    await new Promise<void>((resolveDone) => {
      stream.once('finish', resolveDone)
      stream.once('close', resolveDone)
    })
  }
  const all = Buffer.concat(written).toString('utf8')
  const newline = all.indexOf('\n')
  if (newline === -1) return { status: null, text: '' }
  const parsed = safeJsonParse(all.slice(0, newline), decodeWithSchema(githubResponseHeadSchema))
  return { status: parsed?.status ?? null, text: all.slice(newline + 1) }
}

describe('GitHub read capability, guest bridge to fake GitHub', () => {
  let fake: { server: Server; port: number; seen: Seen[] }
  let broker: EgressBroker
  let bridge: GuestGitHubBridge
  let socketDir: string
  let token: string | null = REAL_TOKEN
  const upstreamOptions: RequestOptions[] = []

  /** The `index`th request the fake GitHub received. */
  const seenAt = (index: number): Seen => {
    const seen = fake.seen.at(index)
    if (seen === undefined) assert.fail(`the fake GitHub saw no request ${String(index)}`)
    return seen
  }

  /** What gh sends: origin-form to the socket, the real host in Host, the placeholder. */
  const gh = (
    method: string,
    path: string,
    host = 'api.github.com',
    body?: string,
    extra: Record<string, string> = {},
  ): Promise<Answer> =>
    send(
      {
        socketPath: bridge.socketPath,
        method,
        path,
        headers: {
          Host: host,
          Authorization: `token ${PLACEHOLDER}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...extra,
        },
      },
      body,
    )

  /** What git sends: absolute-form to the loopback proxy, no credential. */
  const git = (method: string, path: string, body?: string): Promise<Answer> =>
    send(
      {
        host: '127.0.0.1',
        port: bridge.gitProxyPort,
        method,
        path: `http://github.copse.internal${path}`,
        headers: { Host: 'github.copse.internal' },
      },
      body,
    )

  before(async () => {
    fake = await startFakeGitHub()
    const capability = new GitHubCapability({
      token: (): Promise<string | null> => Promise.resolve(token),
      placeholder: PLACEHOLDER,
      upstream: (options): ClientRequest => {
        upstreamOptions.push(options)
        return httpRequest({ ...options, host: '127.0.0.1', port: fake.port })
      },
      onLog: (entry): void => {
        broker.record(entry)
      },
    })
    broker = new EgressBroker({
      rules: [parseEgressRule(HOST_GITHUB_TARGET)],
      github: (stream): Promise<void> => capability.serve(stream),
    })
    const guestToHost = new PassThrough()
    const hostToGuest = new PassThrough()
    broker.attach(guestToHost, hostToGuest)
    const link = new EgressLink(hostToGuest, guestToHost)
    // A unix socket path must stay short; the profile's tmpdir can be long.
    const base = tmpdir().length < 60 ? tmpdir() : '/tmp'
    socketDir = mkdtempSync(join(base, 'ghb-'))
    bridge = await startGuestGitHubBridge(link, {
      socketPath: join(socketDir, 'gh.sock'),
      gitProxy: { host: '127.0.0.1', port: 0 },
    })
  })

  after(async () => {
    // Each step on its own: a setup that failed part way must not leave the
    // fake server holding the process open.
    const steps: Array<() => unknown> = [
      (): Promise<void> => bridge.close(),
      (): void => {
        broker.stop()
      },
      (): void => {
        fake.server.closeAllConnections()
        fake.server.close()
      },
      (): void => {
        rmSync(socketDir, { recursive: true, force: true })
      },
    ]
    for (const step of steps) {
      try {
        await step()
      } catch {
        // Never set up; nothing to undo.
      }
    }
  })

  beforeEach(() => {
    fake.seen.length = 0
    upstreamOptions.length = 0
    token = REAL_TOKEN
  })

  it('gives the API the real token in place of the placeholder', async () => {
    const answer = await gh('GET', '/user')
    assert.equal(answer.status, 200)
    assert.deepEqual(JSON.parse(answer.body), { ok: true, path: '/user' })
    assert.equal(fake.seen.length, 1)
    const seen = seenAt(0)
    assert.equal(seen.headers.host, 'api.github.com')
    assert.equal(seen.headers.authorization, `token ${REAL_TOKEN}`)
    assert.equal(seen.headers['accept-encoding'], 'identity')
    assert.equal(JSON.stringify(seen.headers).includes(PLACEHOLDER), false)
  })

  it('gives git Basic x-access-token credentials for a fetch through the alias', async () => {
    const refs = await git('GET', '/o/private.git/info/refs?service=git-upload-pack')
    assert.equal(refs.status, 200)
    const pack = await git('POST', '/o/private.git/git-upload-pack', '0032want abc\n0000')
    assert.equal(pack.status, 200)
    assert.equal(fake.seen.length, 2)
    const basic = `Basic ${Buffer.from(`x-access-token:${REAL_TOKEN}`).toString('base64')}`
    for (const seen of fake.seen) {
      assert.equal(seen.headers.host, 'github.com')
      assert.equal(seen.headers.authorization, basic)
    }
    assert.equal(seenAt(0).url, '/o/private.git/info/refs?service=git-upload-pack')
    assert.equal(seenAt(1).body, '0032want abc\n0000')
    assert.equal(authorizationFor('basic', REAL_TOKEN), basic)
    assert.equal(authorizationFor('token', REAL_TOKEN), `token ${REAL_TOKEN}`)
    assert.equal(authorizationFor('none', REAL_TOKEN), null)
  })

  it('refuses a push at the info/refs probe before anything is forwarded', async () => {
    const answer = await git('GET', '/o/r.git/info/refs?service=git-receive-pack')
    assert.equal(answer.status, 403)
    assert.match(messageOf(answer.body), /^Copse refused this request: pushing is not allowed/)
    const post = await git('POST', '/o/r.git/git-receive-pack', 'PACK')
    assert.equal(post.status, 403)
    assert.equal(fake.seen.length, 0)
  })

  it('forwards a GraphQL query and refuses a mutation smuggled beside it', async () => {
    const query = JSON.stringify({ query: 'query { viewer { login } }' })
    const ok = await gh('POST', '/graphql', 'api.github.com', query)
    assert.equal(ok.status, 200)
    assert.equal(seenAt(0).body, query)
    assert.equal(seenAt(0).headers.authorization, `token ${REAL_TOKEN}`)
    fake.seen.length = 0
    for (const body of [
      JSON.stringify({ query: 'query { a } mutation { deleteRepository(input: {}) { x } }' }),
      JSON.stringify([{ query: 'query { a }' }, { query: 'mutation { b }' }]),
      JSON.stringify({ query: 'subscription { a }' }),
      JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'x' } } }),
    ]) {
      const refused = await gh('POST', '/graphql', 'api.github.com', body)
      assert.equal(refused.status, 403, body)
      assert.match(messageOf(refused.body), /^Copse refused this request: /)
    }
    assert.equal(fake.seen.length, 0)
  })

  it('refuses REST writes and non-GitHub hosts before forwarding', async () => {
    const comment = await gh('POST', '/repos/o/r/issues/1/comments', 'api.github.com', '{}')
    assert.equal(comment.status, 403)
    assert.match(messageOf(comment.body), /write; container runs can only read GitHub/)
    const elsewhere = await gh('GET', '/', 'example.com')
    assert.equal(elsewhere.status, 403)
    const lookalike = await gh('GET', '/user', 'api.github.com.evil.example')
    assert.equal(lookalike.status, 403)
    assert.equal(fake.seen.length, 0)
  })

  it('returns redirects without following them, and gives the redirect target no token', async () => {
    const answer = await gh('GET', '/redirect')
    assert.equal(answer.status, 302)
    assert.equal(
      answer.headers.location,
      'https://results-receiver.actions.githubusercontent.com/log?sig=abc',
    )
    assert.equal(fake.seen.length, 1)
    // gh follows it itself, to a pass-through host, still with the placeholder.
    const followed = await gh(
      'GET',
      '/log?sig=abc',
      'results-receiver.actions.githubusercontent.com',
    )
    assert.equal(followed.status, 200)
    assert.equal(seenAt(1).headers.host, 'results-receiver.actions.githubusercontent.com')
    assert.equal(seenAt(1).headers.authorization, undefined)
  })

  it('redacts a reflected token from headers and a body split across chunks', async () => {
    const before = broker.log().length
    const answer = await gh('GET', '/reflect')
    assert.equal(answer.status, 200)
    assert.equal(answer.body, `before ${'*'.repeat(REAL_TOKEN.length)} after`)
    assert.equal(answer.headers['x-echo'], `token ${'*'.repeat(REAL_TOKEN.length)}`)
    assert.equal(JSON.stringify(answer).includes(REAL_TOKEN), false)
    const redactions = broker
      .log()
      .slice(before)
      .filter((entry) => entry.event === 'error' && /redacted/.test(entry.detail ?? ''))
    assert.ok(redactions.length >= 1)
    assert.equal(JSON.stringify(broker.log()).includes(REAL_TOKEN), false)
  })

  it('decodes a compressed answer so the token cannot hide in it', async () => {
    const answer = await gh('GET', '/gzip')
    assert.equal(answer.status, 200)
    assert.equal(answer.body, `zipped ${'*'.repeat(REAL_TOKEN.length)} zipped`)
    assert.equal(answer.headers['content-encoding'], undefined)
  })

  it('refuses a read that asks to be run as another method', async () => {
    const answer = await gh('GET', '/repos/o/r', 'api.github.com', undefined, {
      'X-HTTP-Method-Override': 'DELETE',
    })
    assert.equal(answer.status, 403)
    assert.match(messageOf(answer.body), /X-HTTP-Method-Override header is not allowed/)
    assert.equal(fake.seen.length, 0)
  })

  it('refuses the placeholder anywhere but Authorization', async () => {
    const inHeader = await gh('GET', '/user', 'api.github.com', undefined, {
      'X-Forward': PLACEHOLDER,
    })
    assert.equal(inHeader.status, 403)
    const inPath = await gh('GET', `/search/code?q=${PLACEHOLDER}`)
    assert.equal(inPath.status, 403)
    const inBody = await gh(
      'POST',
      '/graphql',
      'api.github.com',
      JSON.stringify({ query: `query { search(query: "${PLACEHOLDER}") { count } }` }),
    )
    assert.equal(inBody.status, 403)
    assert.equal(fake.seen.length, 0)
  })

  it('goes out unauthenticated when the desktop has no GitHub sign-in', async () => {
    token = null
    const answer = await gh('GET', '/user')
    assert.equal(answer.status, 200)
    assert.equal(seenAt(0).headers.authorization, undefined)
  })

  it(
    'refuses a read that declares a body, so no framing reaches the token-bearing request',
    { timeout: 10_000 },
    async () => {
      // Before the fix the guest's Content-Length went upstream on a GET that
      // then sent no body, leaving GitHub waiting on bytes that never came.
      // Node's client frames a GET body only when told its length.
      const body = 'x'.repeat(60)
      const length = { 'Content-Length': String(body.length) }
      const get = await gh('GET', '/user', 'api.github.com', body, length)
      assert.equal(get.status, 400)
      assert.match(messageOf(get.body), /a GET request cannot carry a body/)
      const refs = await send(
        {
          host: '127.0.0.1',
          port: bridge.gitProxyPort,
          method: 'GET',
          path: 'http://github.copse.internal/o/r.git/info/refs?service=git-upload-pack',
          headers: { Host: 'github.copse.internal', ...length },
        },
        body,
      )
      assert.equal(refs.status, 400)
      assert.equal(fake.seen.length, 0)
    },
  )

  it('sends a bodyless read with no framing headers, on a connection of its own', async () => {
    const answer = await gh('GET', '/user', 'api.github.com', undefined, {
      'Content-Length': '0',
    })
    assert.equal(answer.status, 200)
    const seen = seenAt(0)
    assert.equal(seen.headers['content-length'], undefined)
    assert.equal(seen.headers['transfer-encoding'], undefined)
    assert.equal(seen.headers.connection, 'close')
    assert.equal(upstreamOptions.at(0)?.agent, false)
  })

  it('forwards a streamed fetch body with exactly its declared length', async () => {
    const body = '0032want abc\n0000'
    const pack = await git('POST', '/o/private.git/git-upload-pack', body)
    assert.equal(pack.status, 200)
    assert.equal(seenAt(0).headers['content-length'], String(Buffer.byteLength(body)))
    assert.equal(seenAt(0).body, body)
  })

  it(
    'abandons a streamed body longer than its Content-Length before sending it',
    { timeout: 10_000 },
    async () => {
      const capability = new GitHubCapability({
        token: (): Promise<string | null> => Promise.resolve(REAL_TOKEN),
        placeholder: PLACEHOLDER,
        upstream: (options): ClientRequest =>
          httpRequest({ ...options, host: '127.0.0.1', port: fake.port }),
      })
      const answer = await serveDirect(
        capability,
        {
          method: 'POST',
          target: 'http://github.copse.internal/o/r.git/git-upload-pack',
          headers: [
            ['Host', 'github.copse.internal'],
            ['Content-Length', '4'],
          ],
        },
        Buffer.from(`0000${'x'.repeat(60)}`),
      )
      assert.equal(answer.status, null)
      // Give a stray request time to arrive if one had been sent.
      await new Promise((resolveTick) => setTimeout(resolveTick, 50))
      assert.equal(
        fake.seen.some((seen) => seen.body.includes('x')),
        false,
      )
    },
  )

  it(
    'abandons a streamed body shorter than its Content-Length instead of hanging',
    { timeout: 10_000 },
    async () => {
      const capability = new GitHubCapability({
        token: (): Promise<string | null> => Promise.resolve(REAL_TOKEN),
        placeholder: PLACEHOLDER,
        upstream: (options): ClientRequest =>
          httpRequest({ ...options, host: '127.0.0.1', port: fake.port }),
      })
      const answer = await serveDirect(
        capability,
        {
          method: 'POST',
          target: 'http://github.copse.internal/o/r.git/git-upload-pack',
          headers: [
            ['Host', 'github.copse.internal'],
            ['Content-Length', '60'],
          ],
        },
        Buffer.from('0000'),
      )
      assert.equal(answer.status, 502)
      assert.match(messageOf(answer.text), /shorter than its Content-Length/)
    },
  )

  it('answers 502 when the upstream goes idle', { timeout: 10_000 }, async () => {
    const requests: ClientRequest[] = []
    const capability = new GitHubCapability({
      token: (): Promise<string | null> => Promise.resolve(REAL_TOKEN),
      placeholder: PLACEHOLDER,
      upstream: (options): ClientRequest => {
        const request = httpRequest({
          ...options,
          host: '127.0.0.1',
          port: fake.port,
        })
        requests.push(request)
        return request
      },
    })
    const served = serveDirect(
      capability,
      { method: 'GET', target: '/hang', headers: [['Host', 'api.github.com']] },
      Buffer.alloc(0),
    )
    await until(() => fake.seen.some((seen) => seen.url === '/hang'))
    const request = requests.at(0)
    if (request === undefined) assert.fail('no upstream request was made')
    assert.equal(request.socket?.timeout, GITHUB_UPSTREAM_IDLE_TIMEOUT_MS)
    // What the socket does once it has been idle that long.
    request.emit('timeout')
    const answer = await served
    assert.equal(answer.status, 502)
    assert.match(messageOf(answer.text), /did not answer in time/)
  })

  it('refuses CONNECT on the bridge', async () => {
    const reply = await new Promise<string>((resolveReply, reject) => {
      const socket = connect(bridge.gitProxyPort, '127.0.0.1', () => {
        socket.write('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n')
      })
      let text = ''
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
      })
      socket.on('end', () => {
        resolveReply(text)
      })
      socket.on('error', reject)
    })
    assert.match(reply, /^HTTP\/1\.1 405 /)
    assert.equal(fake.seen.length, 0)
  })
})

describe('requestFraming', () => {
  it('reads a single plain length or chunked, and treats a zero length as no body', () => {
    assert.deepEqual(requestFraming([]), { kind: 'empty' })
    assert.deepEqual(requestFraming([['Content-Length', '0']]), {
      kind: 'empty',
    })
    assert.deepEqual(requestFraming([['content-length', '12']]), {
      kind: 'length',
      length: 12,
    })
    assert.deepEqual(requestFraming([['Transfer-Encoding', 'Chunked']]), {
      kind: 'chunked',
    })
  })

  it('refuses framing that could be read two ways', () => {
    for (const headers of [
      [
        ['Content-Length', '4'],
        ['Transfer-Encoding', 'chunked'],
      ],
      [
        ['Content-Length', '4'],
        ['Content-Length', '4'],
      ],
      [['Content-Length', '4, 4']],
      [['Content-Length', '-1']],
      [['Content-Length', '0x10']],
      [['Transfer-Encoding', 'gzip, chunked']],
      [
        ['Transfer-Encoding', 'chunked'],
        ['Transfer-Encoding', 'chunked'],
      ],
    ] satisfies Array<Array<[string, string]>>) {
      assert.equal(requestFraming(headers).kind, 'invalid', JSON.stringify(headers))
    }
  })
})

describe('GitHub read capability without the allowlist entry', () => {
  it('is refused by the broker', async () => {
    const capability = new GitHubCapability({
      token: (): Promise<string | null> => Promise.resolve(REAL_TOKEN),
      placeholder: PLACEHOLDER,
    })
    const broker = new EgressBroker({
      rules: [],
      github: (stream): Promise<void> => capability.serve(stream),
    })
    const guestToHost = new PassThrough()
    const hostToGuest = new PassThrough()
    broker.attach(guestToHost, hostToGuest)
    const link = new EgressLink(hostToGuest, guestToHost)
    await assert.rejects(link.open(HOST_GITHUB_TARGET), /no GitHub access for this run/)
    broker.stop()
  })
})
