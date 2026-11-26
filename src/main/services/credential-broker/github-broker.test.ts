/**
 * R2 exit gate (`docs/plans/execution-runtime-security.md`): the secret canary
 * never reaches the workload, approved GitHub work succeeds through the
 * broker, and the same process cannot reach an unapproved origin or reuse
 * another execution's grant.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanPrincipal, type RuntimeProfile } from '@shared/threads/execution-runtime.ts'
import type { RecordDecisionInput } from '../security/decision-log-store.ts'
import {
  createGitHubCredentialBroker,
  GITHUB_CREDENTIAL_REF,
  GITHUB_GRANT_AUDIT_LINES_PER_KIND,
  GITHUB_GRANT_MAX_CONCURRENT_REQUESTS,
  GITHUB_GRANT_TTL_MS,
  type IssuedGitHubGrant,
  type UpstreamRequest,
} from './github-broker.ts'

const CANARY = 'ghp_CANARYcanaryCANARYcanary0123456789'

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function call(
  grant: IssuedGitHubGrant,
  options: {
    method?: string
    path?: string
    host?: string
    authorization?: string
    body?: string
    headers?: Record<string, string>
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: grant.socketPath,
        method: options.method ?? 'GET',
        path: options.path ?? '/user',
        headers: {
          host: options.host ?? 'api.github.com',
          authorization: options.authorization ?? `token ${grant.env['GH_TOKEN'] ?? ''}`,
          ...options.headers,
        },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
        })
      },
    )
    req.once('error', reject)
    req.end(options.body)
  })
}

interface StalledRequest {
  readonly socket: Socket
  /** Resolves with everything received once it matches `pattern`; rejects after `ms`. */
  readonly waitFor: (pattern: RegExp, ms: number) => Promise<string>
  readonly closed: Promise<void>
}

/**
 * Open a raw connection and send a request whose headers promise a body that
 * never comes. `expect: 100-continue` makes Node answer "100 Continue" just
 * before it hands the request to the broker, so a test can tell when the
 * broker holds it.
 */
function stalledRequest(grant: IssuedGitHubGrant, method: string, path: string): StalledRequest {
  const socket = connect(grant.socketPath)
  let text = ''
  const listeners = new Set<() => void>()
  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString()
    for (const listener of listeners) listener()
  })
  socket.on('error', () => {})
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => {
      resolve()
    })
  })
  socket.write(
    `${method} ${path} HTTP/1.1\r\nhost: api.github.com\r\n` +
      `authorization: token ${grant.env['GH_TOKEN'] ?? ''}\r\n` +
      'expect: 100-continue\r\ncontent-type: application/json\r\n' +
      'content-length: 1048000\r\n\r\n',
  )
  const waitFor = (pattern: RegExp, ms: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        if (!pattern.test(text)) return
        listeners.delete(check)
        clearTimeout(timer)
        resolve(text)
      }
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(
          new Error(`no ${String(pattern)} within ${String(ms)} ms; got ${JSON.stringify(text)}`),
        )
      }, ms)
      listeners.add(check)
      check()
    })
  return { socket, waitFor, closed }
}

describe('GitHub credential broker', () => {
  let stateDir: string
  let now: number
  let upstreamCalls: UpstreamRequest[]
  let records: RecordDecisionInput[]
  let upstreamStatus: number
  let upstreamHeaders: [string, string][]
  let grants: IssuedGitHubGrant[]
  let requestTimeoutMs: number

  const broker = (): ReturnType<typeof createGitHubCredentialBroker> =>
    createGitHubCredentialBroker({
      resolveToken: () => Promise.resolve(CANARY),
      upstream: (request) => {
        upstreamCalls.push(request)
        return Promise.resolve({
          status: upstreamStatus,
          headers: upstreamHeaders,
          body: Buffer.from('{"login":"octocat"}'),
        })
      },
      record: (input) => {
        records.push(input)
      },
      now: () => now,
      stateDir: () => stateDir,
      requestTimeoutMs,
    })

  async function issue(threadId = 'thread-a'): Promise<IssuedGitHubGrant> {
    const grant = await broker().issue({
      principal: humanPrincipal('proj'),
      projectId: 'proj',
      threadId,
      profile: { kind: 'local', containment: 'contained' },
    })
    grants.push(grant)
    return grant
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'copse-gh-broker-'))
    now = 1_000
    upstreamCalls = []
    records = []
    upstreamStatus = 200
    upstreamHeaders = [['content-type', 'application/json']]
    grants = []
    requestTimeoutMs = 30_000
  })

  afterEach(async () => {
    await Promise.all(grants.map((grant) => grant.release()))
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('attaches the real token upstream and hands the child only a capability', async () => {
    const grant = await issue()
    assert.notEqual(grant.env['GH_TOKEN'], CANARY)
    assert.equal(JSON.stringify(grant.env).includes(CANARY), false)
    assert.deepEqual(grant.grant.network?.origins, ['https://api.github.com'])
    assert.equal(grant.grant.credentialRef, GITHUB_CREDENTIAL_REF)
    assert.equal(grant.grant.expiresAt, 1_000 + GITHUB_GRANT_TTL_MS)

    const reply = await call(grant)
    assert.equal(reply.status, 200)
    assert.equal(reply.body, '{"login":"octocat"}')
    assert.equal(upstreamCalls.length, 1)
    const [sent] = upstreamCalls
    assert.ok(sent)
    assert.equal(sent.url, 'https://api.github.com/user')
    assert.equal(sent.headers['authorization'], `token ${CANARY}`)
  })

  it('refuses another host, another grant and an expired or released grant', async () => {
    const mine = await issue('thread-a')
    const theirs = await issue('thread-b')

    assert.equal((await call(mine, { host: 'evil.example' })).status, 403)
    assert.equal((await call(mine, { host: 'github.com' })).status, 403)
    assert.equal((await call(mine, { authorization: `token ${CANARY}` })).status, 401)
    assert.equal(
      (await call(mine, { authorization: `token ${theirs.env['GH_TOKEN'] ?? ''}` })).status,
      401,
    )
    assert.equal((await call(mine, { authorization: '' })).status, 401)
    assert.equal(upstreamCalls.length, 0)

    now += GITHUB_GRANT_TTL_MS
    assert.equal((await call(mine)).status, 401)

    await theirs.release()
    await theirs.release()
    await assert.rejects(call(theirs))
    assert.equal(existsSync(theirs.socketPath), false)
    assert.equal(upstreamCalls.length, 0)
  })

  it('refuses to issue a grant for a command outside the sandbox', async () => {
    const outside: RuntimeProfile[] = [
      { kind: 'local', containment: 'host' },
      { kind: 'ssh', hostId: 'build-box' },
    ]
    for (const profile of outside) {
      const attempt = broker().issue({
        principal: humanPrincipal('proj'),
        projectId: 'proj',
        threadId: 'thread-a',
        profile,
      })
      // Release a grant that should not exist, so a failure cannot hang the run.
      await assert.rejects(
        attempt.then((grant) => {
          grants.push(grant)
        }),
        /only for contained local executions/,
      )
    }
    assert.deepEqual(readdirSync(stateDir), [])
    assert.deepEqual(records, [])
  })

  it('limits every grant to reads and GraphQL queries', async () => {
    const grant = await issue()
    assert.deepEqual(grant.grant.network?.methods, ['GET', 'HEAD'])
    assert.equal((await call(grant, { method: 'GET' })).status, 200)
    assert.equal(
      (await call(grant, { method: 'POST', path: '/repos/o/r/issues', body: '{}' })).status,
      403,
    )
    assert.equal((await call(grant, { method: 'DELETE', path: '/repos/o/r' })).status, 403)
    const mutation = JSON.stringify({
      query: 'mutation { addStar(input: {}) { clientMutationId } }',
    })
    assert.equal(
      (await call(grant, { method: 'POST', path: '/graphql', body: mutation })).status,
      403,
    )
    const query = JSON.stringify({ query: 'query { viewer { login } }' })
    assert.equal((await call(grant, { method: 'POST', path: '/graphql', body: query })).status, 200)
    assert.deepEqual(
      upstreamCalls.map((c) => `${c.method} ${c.url}`),
      ['GET https://api.github.com/user', 'POST https://api.github.com/graphql'],
    )
  })

  it('never follows a redirect, so the credential stays with GitHub', async () => {
    upstreamStatus = 302
    upstreamHeaders = [['location', 'https://codeload.github.com/o/r/tar.gz/main']]
    const grant = await issue()
    const reply = await call(grant, { path: '/repos/o/r/tarball/main' })
    assert.equal(reply.status, 302)
    assert.equal(reply.headers['location'], 'https://codeload.github.com/o/r/tar.gz/main')
    assert.equal(upstreamCalls.length, 1)
  })

  it('records the grant, each use and each refusal without the token', async () => {
    const grant = await issue()
    await call(grant)
    await call(grant, { host: 'evil.example' })
    assert.deepEqual(
      records.map((r) => `${r.kind}:${r.verdict}`),
      ['execution-grant:allowed', 'credential-use:allowed', 'network-access:blocked'],
    )
    for (const record of records) {
      assert.equal(record.principalId, 'human:local')
      assert.equal(record.runtime, 'local/contained')
      assert.equal(record.source, GITHUB_CREDENTIAL_REF)
    }
    assert.equal(records[0]?.scope, 'github-api-read')
    assert.deepEqual(records[1]?.reasons, ['status 200', 'bytes out 0', 'bytes in 19'])
    assert.equal(JSON.stringify(records).includes(CANARY), false)
    assert.equal(JSON.stringify(records).includes(grant.env['GH_TOKEN'] ?? '?'), false)
  })

  it('refuses a method the grant does not name before reading any body', async () => {
    const grant = await issue()
    const pending = stalledRequest(grant, 'POST', '/repos/o/r/issues')
    // The promised body never comes, so the refusal must not wait for it.
    const answer = await pending.waitFor(/is not a read/, 2_000)
    assert.match(answer, /HTTP\/1\.1 403/)
    pending.socket.destroy()
    assert.equal(upstreamCalls.length, 0)
  })

  it('answers 429 past the in-flight cap and 408 to a body that never arrives', async () => {
    requestTimeoutMs = 300
    const grant = await issue()
    const stalled = Array.from({ length: GITHUB_GRANT_MAX_CONCURRENT_REQUESTS }, () =>
      stalledRequest(grant, 'POST', '/graphql'),
    )
    await Promise.all(stalled.map((pending) => pending.waitFor(/100 Continue/, 2_000)))
    const refused = await call(grant)
    assert.equal(refused.status, 429)
    for (const pending of stalled) {
      assert.match(await pending.waitFor(/HTTP\/1\.1 408/, 5_000), /408/)
      await pending.closed
    }
    // Timed-out requests no longer count against the cap.
    assert.equal((await call(grant)).status, 200)
    assert.deepEqual(
      upstreamCalls.map((c) => `${c.method} ${c.url}`),
      ['GET https://api.github.com/user'],
    )
  })

  it('reads GraphQL only as a checked POST body', async () => {
    const grant = await issue()
    const query = JSON.stringify({ query: 'query { viewer { login } }' })
    assert.equal(
      (await call(grant, { method: 'GET', path: '/graphql?query=%7Bviewer%7Blogin%7D%7D' })).status,
      403,
    )
    assert.equal(
      (await call(grant, { method: 'POST', path: '/graphql?query=x', body: query })).status,
      403,
    )
    assert.equal(upstreamCalls.length, 0)
  })

  it('forwards neither a method override nor a body encoding', async () => {
    const grant = await issue()
    const reply = await call(grant, {
      headers: {
        'x-http-method-override': 'DELETE',
        'content-encoding': 'gzip',
        accept: 'application/vnd.github+json',
      },
    })
    assert.equal(reply.status, 200)
    const [sent] = upstreamCalls
    assert.ok(sent)
    assert.equal(sent.method, 'GET')
    assert.equal(sent.headers['x-http-method-override'], undefined)
    assert.equal(sent.headers['content-encoding'], undefined)
    assert.equal(sent.headers['accept'], 'application/vnd.github+json')
  })

  it('writes a bounded number of audit lines per grant and counts the rest', async () => {
    const grant = await issue()
    const extra = 3
    for (let index = 0; index < GITHUB_GRANT_AUDIT_LINES_PER_KIND + extra; index += 1) {
      await call(grant)
      await call(grant, { host: 'evil.example' })
    }
    const count = (kind: string): number => records.filter((r) => r.kind === kind).length
    assert.equal(count('credential-use'), GITHUB_GRANT_AUDIT_LINES_PER_KIND)
    assert.equal(count('network-access'), GITHUB_GRANT_AUDIT_LINES_PER_KIND)
    await grant.release()
    assert.deepEqual(
      records.slice(-2).map((r) => `${r.kind}:${r.verdict}:${r.subject}`),
      [
        `network-access:blocked:${String(extra)} more refused requests`,
        `credential-use:allowed:${String(extra)} more relayed requests`,
      ],
    )
    assert.equal(records.at(-1)?.principalId, 'human:local')
  })

  it('serves a real gh client whose environment never sees the token', async (t) => {
    const gh = ['/usr/local/bin/gh', '/opt/homebrew/bin/gh', '/usr/bin/gh'].find(existsSync)
    if (!gh) {
      t.skip('gh is not installed')
      return
    }
    const grant = await issue()
    const home = mkdtempSync(join(tmpdir(), 'copse-gh-home-'))
    try {
      const env = { PATH: process.env['PATH'] ?? '', HOME: home, ...grant.env }
      const output = await new Promise<string>((resolve, reject) => {
        execFile(gh, ['api', '/user', '--jq', '.login'], { env }, (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}\n${stderr}`))
          else resolve(stdout)
        })
      })
      assert.equal(output.trim(), 'octocat')
      assert.equal(upstreamCalls[0]?.headers['authorization'], `token ${CANARY}`)
      assert.equal(JSON.stringify(env).includes(CANARY), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
