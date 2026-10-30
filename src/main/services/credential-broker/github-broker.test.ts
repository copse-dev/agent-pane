/**
 * R2 exit gate (`docs/plans/execution-runtime-security.md`): the secret canary
 * never reaches the workload, approved GitHub work succeeds through the
 * broker, and the same process cannot reach an unapproved origin or reuse
 * another execution's grant.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanPrincipal } from '@shared/threads/execution-runtime.ts'
import type { RecordDecisionInput } from '../security/decision-log-store.ts'
import {
  createGitHubCredentialBroker,
  GITHUB_CREDENTIAL_REF,
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

describe('GitHub credential broker', () => {
  let stateDir: string
  let now: number
  let upstreamCalls: UpstreamRequest[]
  let records: RecordDecisionInput[]
  let upstreamStatus: number
  let upstreamHeaders: [string, string][]
  let grants: IssuedGitHubGrant[]

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
    })

  async function issue(readOnly: boolean, threadId = 'thread-a'): Promise<IssuedGitHubGrant> {
    const grant = await broker().issue({
      principal: humanPrincipal('proj'),
      projectId: 'proj',
      threadId,
      profile: { kind: 'local', containment: readOnly ? 'contained' : 'host' },
      readOnly,
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
  })

  afterEach(async () => {
    await Promise.all(grants.map((grant) => grant.release()))
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('attaches the real token upstream and hands the child only a capability', async () => {
    const grant = await issue(false)
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
    const mine = await issue(false, 'thread-a')
    const theirs = await issue(false, 'thread-b')

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

  it('limits a read-only grant to reads and GraphQL queries', async () => {
    const grant = await issue(true)
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
    const grant = await issue(false)
    const reply = await call(grant, { path: '/repos/o/r/tarball/main' })
    assert.equal(reply.status, 302)
    assert.equal(reply.headers['location'], 'https://codeload.github.com/o/r/tar.gz/main')
    assert.equal(upstreamCalls.length, 1)
  })

  it('records the grant, each use and each refusal without the token', async () => {
    const grant = await issue(false)
    await call(grant)
    await call(grant, { host: 'evil.example' })
    assert.deepEqual(
      records.map((r) => `${r.kind}:${r.verdict}`),
      ['execution-grant:allowed', 'credential-use:allowed', 'network-access:blocked'],
    )
    for (const record of records) {
      assert.equal(record.principalId, 'human:local')
      assert.equal(record.runtime, 'local/host')
      assert.equal(record.source, GITHUB_CREDENTIAL_REF)
    }
    assert.deepEqual(records[1]?.reasons, ['status 200', 'bytes out 0', 'bytes in 19'])
    assert.equal(JSON.stringify(records).includes(CANARY), false)
    assert.equal(JSON.stringify(records).includes(grant.env['GH_TOKEN'] ?? '?'), false)
  })

  it('serves a real gh client whose environment never sees the token', async (t) => {
    const gh = ['/usr/local/bin/gh', '/opt/homebrew/bin/gh', '/usr/bin/gh'].find(existsSync)
    if (!gh) {
      t.skip('gh is not installed')
      return
    }
    const grant = await issue(false)
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
