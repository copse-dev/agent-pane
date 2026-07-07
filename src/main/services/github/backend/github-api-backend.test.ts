import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { githubApiBackend } from './github-api-backend.ts'
import { resetGitHubApiTokenCacheForTest } from './github-token.ts'

interface RouteResult {
  status?: number
  body: unknown
}

type Router = (method: string, url: string, body: unknown) => RouteResult

const calls: Array<{ method: string; url: string; body: unknown }> = []
let router: Router = (): RouteResult => ({ body: {} })
const originalFetch = globalThis.fetch

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function installFetch(): void {
  const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null
    calls.push({ method, url, body })
    const { status = 200, body: responseBody } = router(method, url, body)
    return Promise.resolve(new Response(JSON.stringify(responseBody), { status }))
  }
  globalThis.fetch = fakeFetch
}

const REF = { owner: 'octo', repo: 'demo', number: 7 }

beforeEach((): void => {
  calls.length = 0
  process.env['GITHUB_TOKEN'] = 'test-token'
  resetGitHubApiTokenCacheForTest()
  installFetch()
})

afterEach((): void => {
  globalThis.fetch = originalFetch
  delete process.env['GITHUB_TOKEN']
  router = (): RouteResult => ({ body: {} })
})

function variablesOf(body: unknown): Record<string, unknown> {
  const vars = (body as { variables?: Record<string, unknown> }).variables
  return vars ?? {}
}

describe('githubApiBackend', () => {
  it('sends the request to the /user endpoint for status', async () => {
    router = (): RouteResult => ({ body: { login: 'octo' } })
    const status = await githubApiBackend.getStatus()
    assert.equal(status.username, 'octo')
    assert.equal(calls.length, 1)
    assert.match(calls[0]?.url ?? '', /\/user$/)
  })

  it('approvePr POSTs an APPROVE review', async () => {
    router = (): RouteResult => ({ status: 200, body: {} })
    const result = await githubApiBackend.approvePr(REF)
    assert.equal(result.ok, true)
    assert.equal(result.backend, 'api')
    const call = calls.at(-1)
    assert.ok(call)
    assert.equal(call.method, 'POST')
    assert.match(call.url, /\/repos\/octo\/demo\/pulls\/7\/reviews$/)
    assert.deepEqual(call.body, { event: 'APPROVE' })
  })

  it('markPrReady is a no-op when the PR is not a draft', async () => {
    router = (_m: string, url: string): RouteResult =>
      url.includes('/pulls/7') ? { body: { draft: false, node_id: 'n1' } } : { body: {} }
    const result = await githubApiBackend.markPrReady(REF)
    assert.equal(result.ok, true)
    assert.equal(result.noop, true)
    assert.ok(!calls.some((call) => call.url.endsWith('/graphql')))
  })

  it('markPrReady runs the GraphQL mutation for a draft PR', async () => {
    router = (_m: string, url: string): RouteResult => {
      if (url.endsWith('/graphql')) return { body: { data: { markPullRequestReadyForReview: {} } } }
      return { body: { draft: true, node_id: 'node-123' } }
    }
    const result = await githubApiBackend.markPrReady(REF)
    assert.equal(result.ok, true)
    assert.equal(result.noop, undefined)
    const gql = calls.find((call) => call.url.endsWith('/graphql'))
    assert.ok(gql)
    assert.equal(variablesOf(gql.body)['id'], 'node-123')
  })

  it('enableAutoMerge picks squash when allowed and reports the strategy', async () => {
    router = (_m: string, url: string): RouteResult => {
      if (url.endsWith('/graphql')) return { body: { data: { enablePullRequestAutoMerge: {} } } }
      if (/\/repos\/octo\/demo$/.test(url)) {
        return {
          body: { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false },
        }
      }
      return { body: { node_id: 'node-9' } }
    }
    const result = await githubApiBackend.enableAutoMerge(REF)
    assert.equal(result.ok, true)
    assert.equal(result.strategy, 'squash')
    const gql = calls.find((call) => call.url.endsWith('/graphql'))
    assert.equal(variablesOf(gql?.body)['method'], 'SQUASH')
  })

  it('enableAutoMerge treats an "already enabled" GraphQL error as a no-op success', async () => {
    router = (_m: string, url: string): RouteResult => {
      if (url.endsWith('/graphql')) {
        return { body: { errors: [{ message: 'Pull request Auto merge is already enabled' }] } }
      }
      if (/\/repos\/octo\/demo$/.test(url)) return { body: { allow_squash_merge: true } }
      return { body: { node_id: 'node-9' } }
    }
    const result = await githubApiBackend.enableAutoMerge(REF)
    assert.equal(result.ok, true)
    assert.equal(result.noop, true)
  })

  it('rerunFailedRuns re-runs each failed workflow run on the head branch', async () => {
    router = (method: string, url: string): RouteResult => {
      if (url.includes('/pulls/7')) return { body: { head: { ref: 'feature' } } }
      if (url.includes('/actions/runs') && method === 'GET') {
        return {
          body: {
            workflow_runs: [
              { id: 1, conclusion: 'failure' },
              { id: 2, conclusion: 'success' },
              { id: 3, conclusion: 'failure' },
            ],
          },
        }
      }
      return { status: 201, body: {} }
    }
    const result = await githubApiBackend.rerunFailedRuns(REF)
    assert.equal(result.ok, true)
    assert.equal(result.rerunCount, 2)
    const rerunCalls = calls.filter((call) => call.url.includes('/rerun-failed-jobs'))
    assert.equal(rerunCalls.length, 2)
    assert.ok(rerunCalls.every((call) => call.method === 'POST'))
  })

  it('surfaces a REST error message on failure', async () => {
    router = (): RouteResult => ({
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    })
    const result = await githubApiBackend.approvePr(REF)
    assert.equal(result.ok, false)
    assert.match(result.message, /not accessible/)
  })

  it('maps PR details from the REST pull payload', async () => {
    router = (_m: string, url: string): RouteResult => {
      if (url.endsWith('/files?per_page=100')) {
        return { body: [{ filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 }] }
      }
      return {
        body: {
          number: 7,
          title: 'Do a thing',
          html_url: 'https://github.com/octo/demo/pull/7',
          state: 'open',
          draft: true,
          auto_merge: { enabled_by: {} },
          head: { ref: 'feature' },
          base: { ref: 'main' },
        },
      }
    }
    const details = await githubApiBackend.getPrDetails(REF)
    assert.ok(details)
    assert.equal(details.title, 'Do a thing')
    assert.equal(details.state, 'OPEN')
    assert.equal(details.isDraft, true)
    assert.equal(details.autoMergeEnabled, true)
    assert.equal(details.files.length, 1)
  })
})
