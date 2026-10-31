// Production-boundary contract lane (issue #1370). Exercises the real services
// Copse talks to — LLM providers, GitHub, the update feed, the npm packages ACP
// auto-setup installs — on a schedule and before each release candidate, so a
// vendor-side change is found by a scheduled run rather than by a user.
//
// The contracts run through product code wherever plain Node can load it: the
// LLM contracts stream through @copse/llm's own provider factories (the same
// retry wrapper, error classes and abort handling the agent loop uses), and the
// update-feed contract calls the app's `fetchUpdateChangelog`. GitHub and npm
// are checked at the response shape the product reads.
//
// Outcome classification, waivers, redaction and rendering are in
// scripts/lib/boundary-contracts.mts; docs/boundary-contracts.md is the guide.
//
// Run:  pnpm run contracts:boundary -- --list
//       pnpm run contracts:boundary -- --target update-feed --target acp-adapters
// Secrets are read from the environment only (CI secrets in Actions); a target
// whose secret is absent is reported as skipped, never as passing.

import { readFile, writeFile } from 'node:fs/promises'
import { isDirectExecution } from './lib/direct-execution.mts'
import { load as loadYaml } from 'js-yaml'
import { z } from 'zod'
import { createProvider, createOpenRouterProvider } from '@copse/llm/create-provider.ts'
import { isRetryableStreamError, isStreamAbortError } from '@copse/llm/stream-retry.ts'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { KNOWN_ACP_AGENTS } from '../src/shared/acp-known-agents.ts'
import {
  getGitHubReleaseType,
  getPublishedUpdateChannels,
  getReleaseChannel,
} from '../src/shared/release-channel.mts'
import { fetchUpdateChangelog } from '../src/main/services/update-changelog.ts'
import {
  applyWaivers,
  classifyExpectedFailure,
  classifyFailure,
  ContractTimeout,
  ContractViolation,
  createRedactor,
  effectiveStatus,
  errorStatus,
  exitCodeFor,
  formatConsoleLine,
  renderAnnotations,
  renderMarkdown,
  staleWaivers,
  validateWaivers,
  waiverFileSchema,
  type ContractMatrix,
  type ContractOutcome,
  type ContractReport,
  type ContractResult,
  type Waiver,
} from './lib/boundary-contracts.mts'

// ── Target model ────────────────────────────────────────────────────────────

export interface ContractContext {
  readonly fetch: typeof fetch
  /** Aborts when the contract's deadline passes. */
  readonly signal: AbortSignal
  /** Only the secrets the target declared. */
  readonly secrets: Readonly<Record<string, string>>
}

/** A contract resolves to a pass detail, or to an already-classified verdict. */
export type ContractVerdict =
  | string
  | { readonly outcome: ContractOutcome; readonly detail: string }

export interface ContractDefinition {
  readonly id: string
  readonly description: string
  readonly run: (ctx: ContractContext) => Promise<ContractVerdict>
}

export interface ContractTarget {
  readonly id: string
  readonly description: string
  /** Env vars the target needs; all must be set or every contract is skipped. */
  readonly secrets: readonly string[]
  /** Env vars used when present (e.g. a token that only raises a rate limit). */
  readonly optionalSecrets?: readonly string[]
  readonly contracts: readonly ContractDefinition[]
}

/** The provider constructors the LLM targets call. Injected so tests never reach a network. */
export interface ProviderFactories {
  readonly anthropic: (model: string, apiKey: string) => LLMProvider
  readonly openai: (model: string, apiKey: string) => LLMProvider
  readonly openrouter: (model: string, apiKey: string) => LLMProvider
}

export const PRODUCT_PROVIDERS: ProviderFactories = {
  anthropic: (model, apiKey) => createProvider(model, { anthropicApiKey: apiKey }),
  openai: (model, apiKey) => createProvider(model, { openAiApiKey: apiKey }),
  // ZDR-only and no training: the defaults a Copse user gets.
  openrouter: (model, apiKey) => createOpenRouterProvider(model, apiKey),
}

/** Per-contract deadline. Generous: the provider's own retry budget runs inside it. */
export const CONTRACT_TIMEOUT_MS = 90_000
/** How long a cancelled stream may take to settle before that counts as a hang. */
export const CANCEL_SETTLE_MS = 5_000

// ── HTTP helpers ────────────────────────────────────────────────────────────

/** A non-2xx response, shaped so `classifyFailure` can read its status. */
export class HttpStatusError extends Error {
  override readonly name = 'HttpStatusError'
  /** The status to classify by; see `effectiveStatus`. */
  readonly status: number
  constructor(status: number, what: string, headers: Headers = new Headers()) {
    const effective = effectiveStatus(status, headers)
    const note = effective === status ? '' : ' (rate limit exhausted)'
    super(`${what} answered HTTP ${String(status)}${note}`)
    this.status = effective
  }
}

interface HttpResult {
  readonly status: number
  readonly headers: Headers
  readonly text: string
}

async function request(
  ctx: ContractContext,
  url: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const response = await ctx.fetch(url, { ...init, signal: ctx.signal })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

/** GET/POST expecting 200 and a body that decodes with `schema`. */
async function requestJson<T>(
  ctx: ContractContext,
  what: string,
  url: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<{ value: T; headers: Headers }> {
  const res = await request(ctx, url, init)
  if (res.status !== 200) throw new HttpStatusError(res.status, what, res.headers)
  const value = safeJsonParse(res.text, decodeWithSchema(schema))
  if (value === null)
    throw new ContractViolation(`${what} returned a body the product cannot decode`)
  return { value, headers: res.headers }
}

// ── LLM provider targets ────────────────────────────────────────────────────

const SHORT_PROMPT = 'Reply with the single word OK.'
const LONG_PROMPT = 'Count from 1 to 300, one number per line, with no other text.'

interface StreamSummary {
  readonly text: string
  readonly outputTokens: number | null
  readonly inputTokens: number | null
  readonly stopReason: string | null
  readonly done: boolean
}

async function streamToEnd(
  provider: LLMProvider,
  prompt: string,
  signal: AbortSignal,
): Promise<StreamSummary> {
  let text = ''
  let usage: Extract<ProviderStreamChunk, { type: 'usage' }> | null = null
  let done: Extract<ProviderStreamChunk, { type: 'done' }> | null = null
  for await (const chunk of provider.stream([{ role: 'user', content: prompt }], [], signal)) {
    if (chunk.type === 'text') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk
    else if (chunk.type === 'done') done = chunk
  }
  return {
    text,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    stopReason: done?.stopReason ?? null,
    done: done !== null,
  }
}

function assertGeneration(summary: StreamSummary): string {
  if (summary.text.trim() === '') throw new ContractViolation('the stream produced no text')
  if (summary.outputTokens === null || summary.outputTokens <= 0) {
    throw new ContractViolation('the stream reported no output-token usage (cost tracking breaks)')
  }
  if (!summary.done) throw new ContractViolation('the stream ended without a done chunk')
  return `${String(summary.inputTokens)} in / ${String(summary.outputTokens)} out tokens, stop ${summary.stopReason ?? 'unset'}`
}

/**
 * Run a call the contract expects to FAIL with one of `expected`, and require
 * the product to treat that failure as final: retrying an invalid key or a
 * missing model only burns the user's time and the provider's rate limit.
 */
async function expectRejected(
  ctx: ContractContext,
  provider: LLMProvider,
  expected: readonly number[],
  what: string,
): Promise<ContractVerdict> {
  try {
    await streamToEnd(provider, SHORT_PROMPT, ctx.signal)
  } catch (err) {
    if (ctx.signal.aborted) throw err
    const verdict = classifyExpectedFailure(errorStatus(err), expected, what)
    if (verdict.outcome === 'pass' && isRetryableStreamError(err)) {
      return {
        outcome: 'regression',
        detail: `${verdict.detail}, but isRetryableStreamError treats it as retryable`,
      }
    }
    return verdict
  }
  return { outcome: 'regression', detail: `${what} produced a successful stream` }
}

interface LlmTargetSpec {
  readonly id: string
  readonly description: string
  readonly secret: string
  readonly model: string
  readonly unavailableModel: string
  /** Shaped like a real key so key-format checks pass and the provider is what rejects it. */
  readonly invalidKey: string
  readonly unavailableStatuses: readonly number[]
  readonly create: (model: string, apiKey: string) => LLMProvider
}

function llmTarget(spec: LlmTargetSpec): ContractTarget {
  const key = (ctx: ContractContext): string => ctx.secrets[spec.secret] ?? ''
  return {
    id: spec.id,
    description: spec.description,
    secrets: [spec.secret],
    contracts: [
      {
        id: 'generation',
        description: `${spec.model} streams text, usage and a done chunk through the product provider`,
        run: async (ctx): Promise<ContractVerdict> =>
          assertGeneration(
            await streamToEnd(spec.create(spec.model, key(ctx)), SHORT_PROMPT, ctx.signal),
          ),
      },
      {
        id: 'invalid-key',
        description: 'a rejected key fails with 401/403 and is not retried',
        run: (ctx): Promise<ContractVerdict> =>
          expectRejected(ctx, spec.create(spec.model, spec.invalidKey), [401, 403], 'invalid key'),
      },
      {
        id: 'unavailable-model',
        description: 'an unknown model fails with a client error and is not retried',
        run: (ctx): Promise<ContractVerdict> =>
          expectRejected(
            ctx,
            spec.create(spec.unavailableModel, key(ctx)),
            spec.unavailableStatuses,
            'unknown model',
          ),
      },
      {
        id: 'cancellation',
        description: `aborting mid-stream settles within ${String(CANCEL_SETTLE_MS)}ms as an abort the product recognises`,
        run: async (ctx): Promise<ContractVerdict> => {
          const controller = new AbortController()
          const forward = (): void => {
            controller.abort(ctx.signal.reason)
          }
          ctx.signal.addEventListener('abort', forward, { once: true })
          let abortedAt: number | null = null
          try {
            const provider = spec.create(spec.model, key(ctx))
            const messages = [{ role: 'user' as const, content: LONG_PROMPT }]
            for await (const chunk of provider.stream(messages, [], controller.signal)) {
              if (abortedAt === null && (chunk.type === 'text' || chunk.type === 'reasoning')) {
                abortedAt = Date.now()
                controller.abort()
              }
            }
          } catch (err) {
            if (abortedAt === null) throw err
            if (!isStreamAbortError(err)) {
              const name = err instanceof Error ? err.name : typeof err
              return {
                outcome: 'regression',
                detail: `the abort surfaced as ${name}, which isStreamAbortError does not recognise`,
              }
            }
          } finally {
            ctx.signal.removeEventListener('abort', forward)
          }
          if (abortedAt === null) {
            throw new ContractViolation('the stream finished before any content arrived to cancel')
          }
          const settledMs = Date.now() - abortedAt
          if (settledMs > CANCEL_SETTLE_MS) {
            throw new ContractViolation(
              `the stream took ${String(settledMs)}ms to settle after abort`,
            )
          }
          return `settled ${String(settledMs)}ms after abort`
        },
      },
      {
        id: 'recovery',
        description: 'the same provider instance serves a request after a cancelled one',
        run: async (ctx): Promise<ContractVerdict> => {
          const provider = spec.create(spec.model, key(ctx))
          try {
            await streamToEnd(provider, SHORT_PROMPT, AbortSignal.abort())
          } catch (err) {
            if (!isStreamAbortError(err)) throw err
          }
          return `after a pre-aborted call: ${assertGeneration(await streamToEnd(provider, SHORT_PROMPT, ctx.signal))}`
        },
      },
    ],
  }
}

// ── GitHub ──────────────────────────────────────────────────────────────────

const GITHUB_API = 'https://api.github.com'

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'copse-boundary-contracts',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function githubTarget(repository: string): ContractTarget {
  const [owner = '', name = ''] = repository.split('/')
  return {
    id: 'github',
    description: `GitHub REST + GraphQL, the APIs the product's GitHub backend calls (${repository})`,
    secrets: ['GITHUB_TOKEN'],
    contracts: [
      {
        id: 'rest-read',
        description: 'an authenticated repository read decodes and carries rate-limit headers',
        run: async (ctx): Promise<ContractVerdict> => {
          const { value, headers } = await requestJson(
            ctx,
            'GET /repos/{repo}',
            `${GITHUB_API}/repos/${repository}`,
            z.object({ full_name: z.string(), default_branch: z.string() }),
            { headers: githubHeaders(ctx.secrets['GITHUB_TOKEN']) },
          )
          if (value.full_name.toLowerCase() !== repository.toLowerCase()) {
            throw new ContractViolation(`expected ${repository}, got ${value.full_name}`)
          }
          const limit = Number(headers.get('x-ratelimit-limit'))
          const remaining = Number(headers.get('x-ratelimit-remaining'))
          if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) {
            throw new ContractViolation('the response carries no usable x-ratelimit headers')
          }
          return `rate limit ${String(remaining)}/${String(limit)} remaining`
        },
      },
      {
        id: 'graphql-read',
        description: 'the GraphQL endpoint answers a repository pull-request query',
        run: async (ctx): Promise<ContractVerdict> => {
          const { value } = await requestJson(
            ctx,
            'POST /graphql',
            `${GITHUB_API}/graphql`,
            z.object({
              data: z.object({
                repository: z.object({
                  nameWithOwner: z.string(),
                  pullRequests: z.object({ totalCount: z.number() }),
                }),
              }),
            }),
            {
              method: 'POST',
              headers: githubHeaders(ctx.secrets['GITHUB_TOKEN']),
              body: JSON.stringify({
                query:
                  'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner pullRequests(states:OPEN){totalCount}}}',
                variables: { owner, name },
              }),
            },
          )
          return `${value.data.repository.nameWithOwner}: ${String(value.data.repository.pullRequests.totalCount)} open PRs`
        },
      },
      {
        id: 'invalid-token',
        description: 'a rejected token answers 401, which the backend reports as signed out',
        run: async (ctx): Promise<ContractVerdict> => {
          const res = await request(ctx, `${GITHUB_API}/user`, {
            headers: githubHeaders('copse-contract-invalid-token'),
          })
          return classifyExpectedFailure(
            effectiveStatus(res.status, res.headers),
            [401],
            'invalid token',
          )
        },
      },
      {
        id: 'missing-resource',
        description: 'an unknown repository answers 404, not a server error',
        run: async (ctx): Promise<ContractVerdict> => {
          const res = await request(
            ctx,
            `${GITHUB_API}/repos/${owner}/copse-contract-missing-repo`,
            {
              headers: githubHeaders(ctx.secrets['GITHUB_TOKEN']),
            },
          )
          return classifyExpectedFailure(
            effectiveStatus(res.status, res.headers),
            [404],
            'unknown repository',
          )
        },
      },
    ],
  }
}

// ── Update feed ─────────────────────────────────────────────────────────────

const RELEASES_REPO = 'copse-dev/copse-releases'
const RELEASES_API = `${GITHUB_API}/repos/${RELEASES_REPO}/releases?per_page=100`

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string(), size: z.number() })),
  }),
)
type FeedRelease = z.infer<typeof releasesSchema>[number]

/** The electron-updater `<channel>-mac.yml` fields the updater acts on. */
const updateInfoSchema = z.object({
  version: z.string(),
  files: z
    .array(z.object({ url: z.string(), sha512: z.string(), size: z.number().int().positive() }))
    .min(1),
  path: z.string(),
  sha512: z.string(),
})

function releaseVersion(release: FeedRelease): string | null {
  const version = release.tag_name.replace(/^v/, '')
  try {
    getReleaseChannel(version)
    return version
  } catch {
    return null
  }
}

async function publishedReleases(ctx: ContractContext): Promise<FeedRelease[]> {
  const { value } = await requestJson(ctx, 'GET releases', RELEASES_API, releasesSchema, {
    headers: githubHeaders(ctx.secrets['GITHUB_TOKEN']),
  })
  return value.filter((r) => !r.draft && releaseVersion(r) !== null)
}

function isSha512(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, 'base64').length === 64
}

/** Fetch and check one channel file against the release's own assets. */
async function checkChannelFile(
  ctx: ContractContext,
  release: FeedRelease,
  channel: string,
): Promise<string> {
  const version = releaseVersion(release) ?? release.tag_name
  const file = `${channel}-mac.yml`
  const res = await request(
    ctx,
    `https://github.com/${RELEASES_REPO}/releases/download/${release.tag_name}/${file}`,
  )
  if (res.status === 404) {
    throw new ContractViolation(`${release.tag_name} has no ${file}; that channel cannot update`)
  }
  if (res.status !== 200) throw new HttpStatusError(res.status, `GET ${file}`, res.headers)
  let parsed: unknown
  try {
    parsed = loadYaml(res.text)
  } catch {
    throw new ContractViolation(`${release.tag_name}/${file} is not valid YAML`)
  }
  const info = updateInfoSchema.safeParse(parsed)
  if (!info.success) {
    throw new ContractViolation(`${release.tag_name}/${file} lacks fields electron-updater needs`)
  }
  if (info.data.version !== version) {
    throw new ContractViolation(
      `${release.tag_name}/${file} names version ${info.data.version}, not ${version}`,
    )
  }
  const assets = new Map(release.assets.map((a) => [a.name, a.size]))
  for (const entry of info.data.files) {
    const size = assets.get(entry.url)
    if (size === undefined) {
      throw new ContractViolation(
        `${file} points at ${entry.url}, which the release does not carry`,
      )
    }
    if (size !== entry.size) {
      throw new ContractViolation(
        `${file} says ${entry.url} is ${String(entry.size)} bytes; the asset is ${String(size)}`,
      )
    }
    if (!isSha512(entry.sha512))
      throw new ContractViolation(`${file} has a malformed sha512 for ${entry.url}`)
  }
  return `${file} → ${String(info.data.files.length)} files`
}

const updateFeedTarget: ContractTarget = {
  id: 'update-feed',
  description: `${RELEASES_REPO}: the feed electron-updater and the update changelog read`,
  secrets: [],
  optionalSecrets: ['GITHUB_TOKEN'],
  contracts: [
    {
      id: 'changelog',
      description: "the app's fetchUpdateChangelog returns notes for the newest release",
      run: async (ctx): Promise<ContractVerdict> => {
        const releases = await publishedReleases(ctx)
        const newest = releases[0]
        const latestVersion = newest ? releaseVersion(newest) : null
        if (!newest || latestVersion === null) {
          throw new ContractViolation('no published release with a version the app can classify')
        }
        for (const release of releases) {
          const version = releaseVersion(release)
          if (
            version !== null &&
            release.prerelease !== (getGitHubReleaseType(version) === 'prerelease')
          ) {
            throw new ContractViolation(
              `${release.tag_name}'s prerelease flag disagrees with its channel`,
            )
          }
        }
        // fetchUpdateChangelog swallows every failure to []; record what the
        // boundary said so an outage is not mistaken for a decode regression.
        const seen: { status: number | null; headers: Headers } = {
          status: null,
          headers: new Headers(),
        }
        const recording: typeof fetch = async (input, init) => {
          const response = await ctx.fetch(input, init)
          seen.status = response.status
          seen.headers = response.headers
          return response
        }
        const entries = await fetchUpdateChangelog(
          { currentVersion: '0.0.1', latestVersion, includePrereleases: true },
          recording,
        )
        if (entries.length === 0) {
          if (seen.status === null)
            throw new ContractTimeout('the changelog request never answered')
          if (seen.status !== 200)
            throw new HttpStatusError(seen.status, 'fetchUpdateChangelog', seen.headers)
          throw new ContractViolation('fetchUpdateChangelog decoded no entries from a 200 response')
        }
        if (entries[0]?.version !== latestVersion) {
          throw new ContractViolation(
            `the changelog starts at ${String(entries[0]?.version)}, not ${latestVersion}`,
          )
        }
        return `${String(entries.length)} entries, newest ${latestVersion}`
      },
    },
    {
      id: 'beta-channel',
      description: 'the newest release publishes channel metadata that matches its assets',
      run: async (ctx): Promise<ContractVerdict> => {
        const newest = (await publishedReleases(ctx))[0]
        const version = newest ? releaseVersion(newest) : null
        if (!newest || version === null) throw new ContractViolation('no published release')
        const checked: string[] = []
        for (const channel of getPublishedUpdateChannels(version)) {
          checked.push(await checkChannelFile(ctx, newest, channel))
        }
        return `${newest.tag_name}: ${checked.join(', ')}`
      },
    },
    {
      id: 'stable-channel',
      description: 'the newest stable release, once one exists, publishes latest-mac.yml',
      run: async (ctx): Promise<ContractVerdict> => {
        const stable = (await publishedReleases(ctx)).find((r) => !r.prerelease)
        if (!stable) return { outcome: 'skipped', detail: 'no stable release is published yet' }
        return `${stable.tag_name}: ${await checkChannelFile(ctx, stable, 'latest')}`
      },
    },
  ],
}

// ── ACP adapters ────────────────────────────────────────────────────────────

const npmManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  deprecated: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
})

function binNames(name: string, bin: string | Record<string, string> | undefined): string[] {
  if (bin === undefined) return []
  if (typeof bin === 'string') return [name.replace(/^@[^/]+\//, '')]
  return Object.keys(bin)
}

const acpAdaptersTarget: ContractTarget = {
  id: 'acp-adapters',
  description: 'npm packages ACP auto-setup installs (KNOWN_ACP_AGENTS installPackage)',
  secrets: [],
  contracts: KNOWN_ACP_AGENTS.flatMap((agent) => {
    const pkg = agent.installPackage
    if (!pkg) return []
    return [
      {
        id: `npm-${agent.id}`,
        description: `${pkg}@latest is published, not deprecated, and installs the \`${agent.command}\` binary`,
        run: async (ctx: ContractContext): Promise<ContractVerdict> => {
          const { value } = await requestJson(
            ctx,
            `npm ${pkg}`,
            `https://registry.npmjs.org/${pkg}/latest`,
            npmManifestSchema,
            { headers: { Accept: 'application/json' } },
          )
          if (value.deprecated)
            throw new ContractViolation(
              `${pkg}@${value.version} is deprecated: ${value.deprecated}`,
            )
          const bins = binNames(value.name, value.bin)
          if (!bins.includes(agent.command)) {
            throw new ContractViolation(
              `${pkg}@${value.version} installs [${bins.join(', ')}], not ${agent.command}`,
            )
          }
          return `${pkg}@${value.version}`
        },
      },
    ]
  }),
}

// ── Matrix ──────────────────────────────────────────────────────────────────

export interface TargetOptions {
  readonly providers?: ProviderFactories
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** An env value, treating an empty string (an unset Actions variable) as absent. */
function setting(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]
  return value === undefined || value === '' ? undefined : value
}

export function buildTargets(options: TargetOptions = {}): ContractTarget[] {
  const providers = options.providers ?? PRODUCT_PROVIDERS
  const env = options.env ?? process.env
  return [
    llmTarget({
      id: 'anthropic',
      description: 'Anthropic Messages API through the product AnthropicProvider',
      secret: 'CONTRACT_ANTHROPIC_API_KEY',
      model: setting(env, 'CONTRACT_ANTHROPIC_MODEL') ?? 'claude-haiku-4-5',
      unavailableModel: 'claude-copse-contract-unavailable',
      invalidKey: 'sk-ant-api03-copse-contract-invalid-key-0000000000',
      unavailableStatuses: [404],
      create: providers.anthropic,
    }),
    llmTarget({
      id: 'openai',
      description: 'OpenAI Responses API through the product provider factory',
      secret: 'CONTRACT_OPENAI_API_KEY',
      model: setting(env, 'CONTRACT_OPENAI_MODEL') ?? 'gpt-5-nano',
      unavailableModel: 'gpt-copse-contract-unavailable',
      invalidKey: 'sk-proj-copse-contract-invalid-key-0000000000',
      unavailableStatuses: [400, 404],
      create: providers.openai,
    }),
    llmTarget({
      id: 'openrouter',
      description: 'OpenRouter with the product ZDR/no-training routing defaults',
      secret: 'CONTRACT_OPENROUTER_API_KEY',
      model: setting(env, 'CONTRACT_OPENROUTER_MODEL') ?? 'openai/gpt-5-nano',
      unavailableModel: 'copse-contract/unavailable-model',
      invalidKey: 'sk-or-v1-copse-contract-invalid-key-0000000000',
      unavailableStatuses: [400, 404],
      create: providers.openrouter,
    }),
    githubTarget(setting(env, 'GITHUB_REPOSITORY') ?? 'copse-dev/agent-pane'),
    updateFeedTarget,
    acpAdaptersTarget,
  ]
}

export function contractMatrix(targets: readonly ContractTarget[]): ContractMatrix {
  return new Map(targets.map((t) => [t.id, t.contracts.map((c) => c.id)]))
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  readonly targets: readonly ContractTarget[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly onResult?: (result: ContractResult) => void
}

/** Run every contract in order. Results are raw: redact before they leave the process. */
export async function runContracts(options: RunOptions): Promise<ContractResult[]> {
  const fetchImpl = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? CONTRACT_TIMEOUT_MS
  const results: ContractResult[] = []
  const record = (result: ContractResult): void => {
    results.push(result)
    options.onResult?.(result)
  }
  for (const target of options.targets) {
    const missing = target.secrets.filter((name) => !options.env[name])
    const secrets: Record<string, string> = {}
    for (const name of [...target.secrets, ...(target.optionalSecrets ?? [])]) {
      const value = options.env[name]
      if (value) secrets[name] = value
    }
    for (const contract of target.contracts) {
      if (missing.length > 0) {
        record({
          target: target.id,
          contract: contract.id,
          outcome: 'skipped',
          detail: `not configured: ${missing.join(', ')} unset`,
          durationMs: 0,
        })
        continue
      }
      const started = Date.now()
      const signal = AbortSignal.timeout(timeoutMs)
      let verdict: { outcome: ContractOutcome; detail: string }
      try {
        const value = await contract.run({ fetch: fetchImpl, signal, secrets })
        verdict = typeof value === 'string' ? { outcome: 'pass', detail: value } : value
      } catch (err) {
        verdict = signal.aborted
          ? classifyFailure(new ContractTimeout(`no answer within ${String(timeoutMs / 1000)}s`))
          : classifyFailure(err)
      }
      record({
        target: target.id,
        contract: contract.id,
        ...verdict,
        durationMs: Date.now() - started,
      })
    }
  }
  return results
}

/** Every secret value any target could read, for literal redaction. */
export function secretValues(
  targets: readonly ContractTarget[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const names = new Set(targets.flatMap((t) => [...t.secrets, ...(t.optionalSecrets ?? [])]))
  return [...names].map((name) => env[name] ?? '').filter((v) => v.length > 0)
}

export function redactResult(
  result: ContractResult,
  redact: (s: string) => string,
): ContractResult {
  return { ...result, detail: redact(result.detail) }
}

export async function loadWaivers(path: string): Promise<Waiver[]> {
  const parsed = safeJsonParse(await readFile(path, 'utf8'), decodeWithSchema(waiverFileSchema))
  if (parsed === null) throw new Error(`${path} does not match the waiver schema`)
  return parsed.waivers
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  list: boolean
  targets: string[]
  json: string | null
  summary: string | null
  waivers: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    list: false,
    targets: [],
    json: null,
    summary: process.env['GITHUB_STEP_SUMMARY'] ?? null,
    waivers: 'scripts/data/boundary-contract-waivers.json',
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${String(arg)} needs a value`)
      return next
    }
    if (arg === '--') continue
    if (arg === '--list') args.list = true
    else if (arg === '--target') args.targets.push(...value().split(',').filter(Boolean))
    else if (arg === '--json') args.json = value()
    else if (arg === '--summary') args.summary = value()
    else if (arg === '--waivers') args.waivers = value()
    else throw new Error(`unknown argument ${String(arg)}`)
  }
  return args
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const all = buildTargets()
  if (args.list) {
    for (const target of all) {
      const needs = target.secrets.length > 0 ? ` (needs ${target.secrets.join(', ')})` : ''
      console.log(`${target.id}${needs} — ${target.description}`)
      for (const c of target.contracts) console.log(`  ${c.id}: ${c.description}`)
    }
    return 0
  }
  const unknown = args.targets.filter((id) => !all.some((t) => t.id === id))
  if (unknown.length > 0) throw new Error(`unknown target(s): ${unknown.join(', ')}`)
  const targets = args.targets.length > 0 ? all.filter((t) => args.targets.includes(t.id)) : all
  const redact = createRedactor(secretValues(all, process.env))

  const now = new Date()
  const waivers = await loadWaivers(args.waivers)
  const startedAt = now.toISOString()
  const raw = await runContracts({
    targets,
    env: process.env,
    onResult: (r) => {
      console.log(redact(formatConsoleLine(r)))
    },
  })
  const results = [
    ...validateWaivers(waivers, contractMatrix(all), now),
    ...applyWaivers(raw, waivers, now),
  ].map((r) => redactResult(r, redact))

  const server = process.env['GITHUB_SERVER_URL']
  const repo = process.env['GITHUB_REPOSITORY']
  const runId = process.env['GITHUB_RUN_ID']
  const report: ContractReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    sha: process.env['GITHUB_SHA'] ?? null,
    runUrl: server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
    results,
    staleWaivers: staleWaivers(raw, waivers, now),
  }
  if (process.env['GITHUB_ACTIONS'] === 'true') {
    for (const line of renderAnnotations(results)) console.log(line)
  }
  // Redact the rendered documents as a whole as well: belt and braces against
  // a secret reaching a field other than `detail`.
  if (args.summary) await writeFile(args.summary, redact(renderMarkdown(report)), { flag: 'a' })
  if (args.json) await writeFile(args.json, `${redact(JSON.stringify(report, null, 2))}\n`)
  return exitCodeFor(results)
}

// Bundled to CJS by run-boundary-contracts.mts, where `__filename` is the bundle;
// a test bundle importing this module is not the named entrypoint.
const bundleFilename = typeof __filename === 'undefined' ? undefined : __filename
if (isDirectExecution(import.meta.url, 'boundary-contracts', bundleFilename)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(2)
    },
  )
}
