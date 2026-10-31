import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import {
  buildTargets,
  contractMatrix,
  loadWaivers,
  redactResult,
  runContracts,
  secretValues,
  type ContractTarget,
  type ProviderFactories,
} from './boundary-contracts.mts'
import { createRedactor, validateWaivers } from './lib/boundary-contracts.mts'

const GOOD_KEY = 'sk-ant-api03-GOODKEYVALUE-0123456789abcdef'
const ENV = {
  CONTRACT_ANTHROPIC_API_KEY: GOOD_KEY,
  GITHUB_TOKEN: 'ghs_contracttokenvalue0123456789abcdef',
  GITHUB_REPOSITORY: 'copse-dev/agent-pane',
}

function httpError(status: number, message = `HTTP ${String(status)}`): Error {
  return Object.assign(new Error(message), { status })
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

const GENERATION: ProviderStreamChunk[] = [
  { type: 'text', text: 'OK' },
  { type: 'usage', model: 'm', inputTokens: 12, outputTokens: 2 },
  { type: 'done', stopReason: 'end_turn' },
]

interface ScriptedOptions {
  /** Thrown instead of streaming for a valid key and known model. */
  readonly generationError?: Error
  /** Thrown for an invalid key. */
  readonly invalidKeyError?: Error
  /** What the stream raises once the caller aborts mid-stream. */
  readonly abortSurface?: () => Error
}

/** A provider that behaves like the real ones for each contract's input. */
function scripted(options: ScriptedOptions = {}): (model: string, key: string) => LLMProvider {
  return (model, key) => ({
    async *stream(messages, _tools, signal): AsyncGenerator<ProviderStreamChunk> {
      if (signal?.aborted) throw abortError()
      if (key !== GOOD_KEY) throw options.invalidKeyError ?? httpError(401)
      if (model.includes('unavailable')) throw httpError(404)
      if (options.generationError !== undefined) throw options.generationError
      const first = messages[0]
      const prompt =
        first?.role === 'user' && typeof first.content === 'string' ? first.content : ''
      if (prompt.startsWith('Count')) {
        for (let n = 1; n <= 300; n++) {
          if (signal?.aborted) throw (options.abortSurface ?? abortError)()
          yield { type: 'text', text: `${String(n)}\n` }
          await new Promise((r) => setTimeout(r, 1))
        }
        return
      }
      yield* GENERATION
    },
  })
}

function providers(anthropic: (model: string, key: string) => LLMProvider): ProviderFactories {
  return { anthropic, openai: scripted(), openrouter: scripted() }
}

function only(id: string, factories: ProviderFactories = providers(scripted())): ContractTarget[] {
  return buildTargets({ providers: factories, env: ENV }).filter((t) => t.id === id)
}

function outcomes(
  results: readonly { contract: string; outcome: string }[],
): Record<string, string> {
  return Object.fromEntries(results.map((r) => [r.contract, r.outcome]))
}

describe('LLM provider contracts', () => {
  it('pass against a provider that behaves like production', async () => {
    const results = await runContracts({ targets: only('anthropic'), env: ENV })
    assert.deepEqual(outcomes(results), {
      generation: 'pass',
      'invalid-key': 'pass',
      'unavailable-model': 'pass',
      cancellation: 'pass',
      recovery: 'pass',
    })
  })

  it('skip every contract, rather than pass, when the key is not configured', async () => {
    const results = await runContracts({ targets: only('openai'), env: ENV })
    assert.equal(results.length, 5)
    assert.ok(results.every((r) => r.outcome === 'skipped'))
    assert.match(results[0]?.detail ?? '', /CONTRACT_OPENAI_API_KEY unset/)
  })

  it('reads an overloaded provider as an outage, not a regression', async () => {
    const targets = only('anthropic', providers(scripted({ generationError: httpError(529) })))
    const results = await runContracts({ targets, env: ENV })
    assert.equal(outcomes(results)['generation'], 'outage')
    assert.equal(outcomes(results)['invalid-key'], 'pass')
  })

  it('fails when a rejected key is something the product would retry', async () => {
    // A duck-typed overloaded body makes isRetryableStreamError say yes.
    const retryable = Object.assign(httpError(401), { error: { type: 'overloaded_error' } })
    const targets = only('anthropic', providers(scripted({ invalidKeyError: retryable })))
    const result = (await runContracts({ targets, env: ENV })).find(
      (r) => r.contract === 'invalid-key',
    )
    assert.equal(result?.outcome, 'regression')
    assert.match(result.detail, /retryable/)
  })

  it('fails when an invalid key answers with a status the product does not handle', async () => {
    const targets = only('anthropic', providers(scripted({ invalidKeyError: httpError(400) })))
    const result = (await runContracts({ targets, env: ENV })).find(
      (r) => r.contract === 'invalid-key',
    )
    assert.equal(result?.outcome, 'regression')
  })

  it('fails when a cancellation surfaces as an error the product does not read as an abort', async () => {
    const targets = only(
      'anthropic',
      providers(scripted({ abortSurface: () => new Error('stream closed unexpectedly') })),
    )
    const result = (await runContracts({ targets, env: ENV })).find(
      (r) => r.contract === 'cancellation',
    )
    assert.equal(result?.outcome, 'regression')
    assert.match(result.detail, /isStreamAbortError/)
  })

  it('never lets a secret echoed by the provider reach the report', async () => {
    const leaky = scripted({ generationError: httpError(400, `invalid x-api-key ${GOOD_KEY}`) })
    const targets = only('anthropic', providers(leaky))
    const redact = createRedactor(secretValues(targets, ENV))
    const results = (await runContracts({ targets, env: ENV })).map((r) => redactResult(r, redact))
    const generation = results.find((r) => r.contract === 'generation')
    assert.equal(generation?.outcome, 'regression')
    assert.doesNotMatch(JSON.stringify(results), /GOODKEYVALUE/)
    assert.match(generation.detail, /REDACTED/)
  })
})

describe('the contract deadline', () => {
  it('records a boundary that never answers as an outage', async () => {
    const hang: ContractTarget = {
      id: 'hang',
      description: 'never answers',
      secrets: [],
      contracts: [
        {
          id: 'wait',
          description: 'waits for the deadline',
          run: (ctx) =>
            new Promise((_resolve, reject) => {
              ctx.signal.addEventListener('abort', () => {
                reject(abortError())
              })
            }),
        },
      ],
    }
    const [result] = await runContracts({ targets: [hang], env: {}, timeoutMs: 20 })
    assert.equal(result?.outcome, 'outage')
    assert.match(result.detail, /no answer within/)
  })
})

// ── fetch-backed targets ─────────────────────────────────────────────────────

type Route = (url: string, init: RequestInit | undefined) => Response | undefined

function fakeFetch(...routes: Route[]): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    for (const route of routes) {
      const response = route(url, init)
      if (response) return Promise.resolve(response)
    }
    return Promise.resolve(new Response('not routed', { status: 599 }))
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

describe('GitHub contracts', () => {
  const github: Route = (url, init) => {
    const auth = new Headers(init?.headers).get('authorization')
    if (url.endsWith('/user')) return json({ message: 'Bad credentials' }, 401)
    if (url.endsWith('/copse-contract-missing-repo')) return json({ message: 'Not Found' }, 404)
    if (url.endsWith('/repos/copse-dev/agent-pane') && auth?.startsWith('Bearer ghs_')) {
      return json({ full_name: 'copse-dev/agent-pane', default_branch: 'main' }, 200, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
      })
    }
    if (url.endsWith('/graphql')) {
      return json({
        data: {
          repository: { nameWithOwner: 'copse-dev/agent-pane', pullRequests: { totalCount: 3 } },
        },
      })
    }
    return undefined
  }

  it('pass against the API shapes the backend reads', async () => {
    const results = await runContracts({
      targets: only('github'),
      env: ENV,
      fetch: fakeFetch(github),
    })
    assert.deepEqual(outcomes(results), {
      'rest-read': 'pass',
      'graphql-read': 'pass',
      'invalid-token': 'pass',
      'missing-resource': 'pass',
    })
  })

  it("treat GitHub's 403 rate-limit response as rate limiting", async () => {
    const limited: Route = () =>
      json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' })
    const results = await runContracts({
      targets: only('github'),
      env: ENV,
      fetch: fakeFetch(limited),
    })
    assert.ok(
      results.every((r) => r.outcome === 'rate-limited'),
      JSON.stringify(results),
    )
  })

  it('fail when the GraphQL response stops decoding', async () => {
    const changed: Route = (url) =>
      url.endsWith('/graphql') ? json({ data: { repository: null } }) : undefined
    const results = await runContracts({
      targets: only('github'),
      env: ENV,
      fetch: fakeFetch(changed, github),
    })
    assert.equal(outcomes(results)['graphql-read'], 'regression')
  })
})

describe('update-feed contracts', () => {
  const SHA = Buffer.alloc(64, 7).toString('base64')
  const release = {
    tag_name: 'v0.1.0-beta.8',
    body: '<!-- copse:changelog -->\n- Fixed things',
    draft: false,
    prerelease: true,
    assets: [
      { name: 'Copse-0.1.0-beta.8-arm64.zip', size: 100 },
      { name: 'beta-mac.yml', size: 10 },
    ],
  }
  const yml = (size: number): string =>
    [
      'version: 0.1.0-beta.8',
      'files:',
      '  - url: Copse-0.1.0-beta.8-arm64.zip',
      `    sha512: ${SHA}`,
      `    size: ${String(size)}`,
      'path: Copse-0.1.0-beta.8-arm64.zip',
      `sha512: ${SHA}`,
    ].join('\n')
  const releases =
    (list: unknown[] = [release], status = 200): Route =>
    (url) =>
      url.startsWith('https://api.github.com/repos/copse-dev/copse-releases/releases')
        ? json(list, status)
        : undefined
  const channelFile =
    (body: string | null): Route =>
    (url) => {
      if (!url.endsWith('/beta-mac.yml')) return undefined
      return body === null ? new Response('Not Found', { status: 404 }) : new Response(body)
    }

  it('pass for a beta-only feed, skipping the stable channel until one exists', async () => {
    const results = await runContracts({
      targets: only('update-feed'),
      env: ENV,
      fetch: fakeFetch(releases(), channelFile(yml(100))),
    })
    assert.deepEqual(outcomes(results), {
      changelog: 'pass',
      'beta-channel': 'pass',
      'stable-channel': 'skipped',
    })
  })

  it('fail when channel metadata disagrees with the release assets', async () => {
    const results = await runContracts({
      targets: only('update-feed'),
      env: ENV,
      fetch: fakeFetch(releases(), channelFile(yml(99))),
    })
    const beta = results.find((r) => r.contract === 'beta-channel')
    assert.equal(beta?.outcome, 'regression')
    assert.match(beta.detail, /99 bytes/)
  })

  it('fail when a release ships without its channel file', async () => {
    const results = await runContracts({
      targets: only('update-feed'),
      env: ENV,
      fetch: fakeFetch(releases(), channelFile(null)),
    })
    assert.equal(outcomes(results)['beta-channel'], 'regression')
  })

  it('fail when a prerelease flag contradicts the version channel', async () => {
    const results = await runContracts({
      targets: only('update-feed'),
      env: ENV,
      fetch: fakeFetch(releases([{ ...release, prerelease: false }]), channelFile(yml(100))),
    })
    assert.equal(outcomes(results)['changelog'], 'regression')
  })

  it('read a releases API outage as an outage', async () => {
    const results = await runContracts({
      targets: only('update-feed'),
      env: ENV,
      fetch: fakeFetch(releases([], 502)),
    })
    assert.ok(
      results.every((r) => r.outcome === 'outage'),
      JSON.stringify(results),
    )
  })
})

describe('ACP adapter contracts', () => {
  const npm =
    (manifest: (pkg: string) => Record<string, unknown>): Route =>
    (url) => {
      const match = /^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/.exec(url)
      return match?.[1] ? json(manifest(match[1])) : undefined
    }
  const target = only('acp-adapters')[0]

  it('cover every catalog agent auto-setup can install from npm', () => {
    assert.ok(target)
    assert.ok(target.contracts.length >= 2)
    for (const c of target.contracts) assert.match(c.id, /^npm-/)
  })

  it('pass when the package installs the command the catalog spawns', async () => {
    const bins: Record<string, Record<string, string>> = {
      '@qwen-code/qwen-code': { qwen: 'cli.js' },
      '@agentclientprotocol/claude-agent-acp': { 'claude-agent-acp': 'dist/index.js' },
      '@agentclientprotocol/codex-acp': { 'codex-acp': 'bin/codex-acp' },
    }
    const results = await runContracts({
      targets: only('acp-adapters'),
      env: ENV,
      fetch: fakeFetch(npm((pkg) => ({ name: pkg, version: '1.0.0', bin: bins[pkg] ?? {} }))),
    })
    assert.ok(
      results.every((r) => r.outcome === 'pass'),
      JSON.stringify(results),
    )
  })

  it('fail when a package is deprecated or stops shipping the binary', async () => {
    const results = await runContracts({
      targets: only('acp-adapters'),
      env: ENV,
      fetch: fakeFetch(
        npm((pkg) =>
          pkg.includes('codex')
            ? { name: pkg, version: '9.0.0', deprecated: 'moved to @new/codex' }
            : { name: pkg, version: '9.0.0', bin: { renamed: 'x.js' } },
        ),
      ),
    })
    assert.ok(results.every((r) => r.outcome === 'regression'))
    assert.match(results.find((r) => r.contract === 'npm-codex-acp')?.detail ?? '', /deprecated/)
  })
})

describe('matrix bookkeeping', () => {
  const targets = buildTargets({ providers: providers(scripted()), env: ENV })

  it('documents every target and contract in docs/boundary-contracts.md', () => {
    const doc = readFileSync(resolve('docs/boundary-contracts.md'), 'utf8')
    for (const target of targets) {
      for (const contract of target.contracts) {
        const id = contract.id.startsWith('npm-') ? 'npm-<agent>' : contract.id
        assert.ok(doc.includes(`\`${target.id}/${id}\``), `${target.id}/${id} is not documented`)
      }
    }
  })

  it('checks in a waiver file whose waivers all name real contracts', async () => {
    const waivers = await loadWaivers(resolve('scripts/data/boundary-contract-waivers.json'))
    // Expiry is the scheduled lane's job, not PR CI's: judge names only, from a
    // date every waiver is valid on.
    const problems = validateWaivers(waivers, contractMatrix(targets), new Date(0)).filter(
      (p) => !/expires|expired/.test(p.detail),
    )
    assert.deepEqual(problems, [])
  })
})
