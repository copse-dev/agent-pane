import { Kind, OperationTypeNode, parse, type OperationDefinitionNode } from 'graphql'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { errorMessage } from '@shared/errors.ts'

/**
 * `gh_api_read`: read-only GitHub API access through the host's `gh` login.
 *
 * The agent never supplies `gh` arguments. It supplies an endpoint path or a
 * GraphQL document; Copse validates them and builds the argv itself, so the
 * request is always a GET or a single GraphQL `query` against the host `gh` is
 * configured for. That construction — not a token scope — is the read-only
 * guarantee: the user's ordinary `gh` credential is used, exactly as for
 * `gh_pr_view`. See docs/shell-permissions.md "Host-side read tools".
 */

/** Cap on the text returned to the agent, after `jq`. */
export const GH_API_READ_MAX_OUTPUT_BYTES = 256 * 1024
/** Pages fetched with `paginate` before stopping. */
export const GH_API_READ_MAX_PAGES = 10
/** Wall-clock budget for the whole call, across pages. */
export const GH_API_READ_TIMEOUT_MS = 60_000

const MAX_ENDPOINT_LENGTH = 2048
const MAX_JQ_LENGTH = 4096
const MAX_GRAPHQL_LENGTH = 64 * 1024
// Headers (`--include`) and the GraphQL pagination envelope ride on top of the
// body; read enough to know the body crossed the cap without buffering more.
const STDOUT_READ_BYTES = 2 * GH_API_READ_MAX_OUTPUT_BYTES + 64 * 1024

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** C0 control characters and DEL, optionally allowing tab and newline. */
function hasControlChar(text: string, allowWhitespace = false): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (allowWhitespace && (char === '\t' || char === '\n')) continue
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Validate a REST endpoint and return the path `gh api` receives.
 *
 * Only a relative API path is accepted: `gh api` treats a full URL as the
 * request target, so a scheme or host would leave the configured GitHub host.
 */
export function parseRestEndpoint(raw: string): Result<string> {
  if (raw.length === 0) return { ok: false, error: 'endpoint is empty.' }
  if (raw.length > MAX_ENDPOINT_LENGTH)
    return {
      ok: false,
      error: `endpoint is longer than ${String(MAX_ENDPOINT_LENGTH)} characters.`,
    }
  if (hasControlChar(raw) || /\s/.test(raw))
    return { ok: false, error: 'endpoint must not contain whitespace or control characters.' }
  if (raw.startsWith('-')) return { ok: false, error: 'endpoint must not start with "-".' }
  if (raw.includes('\\') || raw.includes('#'))
    return { ok: false, error: 'endpoint must not contain "\\" or "#".' }
  if (raw.includes('://') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw))
    return {
      ok: false,
      error: 'endpoint must be a path relative to the GitHub API, not a URL or host.',
    }
  const endpoint = raw.startsWith('/') ? raw.slice(1) : raw
  const queryAt = endpoint.indexOf('?')
  const path = queryAt === -1 ? endpoint : endpoint.slice(0, queryAt)
  if (path.length === 0) return { ok: false, error: 'endpoint has no path.' }
  for (const segment of path.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return { ok: false, error: 'endpoint has invalid percent-encoding.' }
    }
    if (segment.length === 0) return { ok: false, error: 'endpoint has an empty path segment.' }
    if (decoded === '.' || decoded === '..' || /[/\\]/.test(decoded) || hasControlChar(decoded))
      return { ok: false, error: 'endpoint must not contain "." or ".." path segments.' }
  }
  if (path === 'graphql' || path.startsWith('graphql/'))
    return { ok: false, error: 'Use the graphql input for GraphQL queries, not endpoint.' }
  return { ok: true, value: endpoint }
}

/**
 * Validate an agent `jq` filter. `gh` evaluates it with gojq, whose `env` and
 * `$ENV` expose the `gh` process environment — including any forwarded GitHub
 * token — so both are refused, as are module directives.
 */
export function validateJq(jq: string): Result<string> {
  if (jq.trim().length === 0) return { ok: false, error: 'jq is empty.' }
  if (jq.length > MAX_JQ_LENGTH)
    return { ok: false, error: `jq is longer than ${String(MAX_JQ_LENGTH)} characters.` }
  // Tabs and newlines are ordinary jq whitespace; other control characters are not.
  if (hasControlChar(jq, true))
    return { ok: false, error: 'jq must not contain control characters.' }
  if (/\$ENV\b/.test(jq) || /(^|[^.\w$])env\b/.test(jq))
    return { ok: false, error: 'jq must not read the environment (env / $ENV).' }
  if (/(^|[^.\w$])(import|include)\b/.test(jq))
    return { ok: false, error: 'jq must not import modules.' }
  return { ok: true, value: jq }
}

export interface GraphqlQuery {
  query: string
  /** Whether the operation declares `$endCursor`, which pagination fills in. */
  declaresEndCursor: boolean
}

/**
 * Accept exactly one GraphQL operation, which must be a `query`. Fragments
 * may accompany it; any other definition (a second operation, a mutation or
 * subscription, schema language) is refused before anything is sent.
 */
export function parseGraphqlQuery(query: string): Result<GraphqlQuery> {
  if (query.trim().length === 0) return { ok: false, error: 'graphql is empty.' }
  if (query.length > MAX_GRAPHQL_LENGTH)
    return { ok: false, error: `graphql is longer than ${String(MAX_GRAPHQL_LENGTH)} characters.` }
  const operations: OperationDefinitionNode[] = []
  try {
    const document = parse(query, { noLocation: true })
    for (const definition of document.definitions) {
      if (definition.kind === Kind.OPERATION_DEFINITION) operations.push(definition)
      else if (definition.kind !== Kind.FRAGMENT_DEFINITION)
        return { ok: false, error: 'graphql may contain one query and fragments only.' }
    }
  } catch (error) {
    return { ok: false, error: `graphql does not parse: ${errorMessage(error)}` }
  }
  if (operations.length !== 1)
    return { ok: false, error: 'graphql must contain exactly one operation.' }
  const [operation] = operations
  if (!operation || operation.operation !== OperationTypeNode.QUERY)
    return {
      ok: false,
      error: `gh_api_read only runs queries; this is a ${operation?.operation ?? 'unknown'} operation.`,
    }
  return {
    ok: true,
    value: {
      query,
      declaresEndCursor: (operation.variableDefinitions ?? []).some(
        (definition) => definition.variable.name.value === 'endCursor',
      ),
    },
  }
}

/** Cut `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  // Back off continuation bytes (10xxxxxx) so the cut lands on a lead byte.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

export type GhApiReadInput =
  | { kind: 'rest'; endpoint: string; jq?: string | undefined; paginate: boolean }
  | {
      kind: 'graphql'
      query: string
      variables: Record<string, unknown>
      jq?: string | undefined
      paginate: boolean
    }

/** What `gh_api_read` needs from `runGh`; tests substitute a recorded `gh`. */
export type GhApiRunner = (
  args: string[],
  opts: { stdin?: Buffer; timeout_ms: number; stdoutMaxBytes: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>

/** Validate raw tool arguments into a request, or explain the refusal. */
export function parseGhApiReadArgs(args: {
  endpoint?: string | undefined
  graphql?: string | undefined
  variables?: Record<string, unknown> | undefined
  jq?: string | undefined
  paginate?: boolean | undefined
}): Result<GhApiReadInput> {
  const paginate = args.paginate ?? false
  let jq: string | undefined
  if (args.jq !== undefined) {
    const checked = validateJq(args.jq)
    if (!checked.ok) return checked
    jq = checked.value
  }
  if ((args.endpoint === undefined) === (args.graphql === undefined))
    return { ok: false, error: 'Pass exactly one of endpoint (REST) or graphql (a query).' }
  if (args.endpoint !== undefined) {
    if (args.variables !== undefined)
      return { ok: false, error: 'variables apply to graphql only.' }
    const endpoint = parseRestEndpoint(args.endpoint)
    if (!endpoint.ok) return endpoint
    return { ok: true, value: { kind: 'rest', endpoint: endpoint.value, jq, paginate } }
  }
  const parsed = parseGraphqlQuery(args.graphql ?? '')
  if (!parsed.ok) return parsed
  if (paginate && !parsed.value.declaresEndCursor)
    return {
      ok: false,
      error:
        'graphql pagination needs the query to declare `$endCursor: String` and select `pageInfo { hasNextPage endCursor }`.',
    }
  return {
    ok: true,
    value: {
      kind: 'graphql',
      query: parsed.value.query,
      variables: args.variables ?? {},
      jq,
      paginate,
    },
  }
}

interface Page {
  /** Output for the agent: the (jq-filtered) body. */
  body: string
  /** Next REST endpoint or GraphQL cursor, when more pages exist. */
  next: string | null
}

/** Split `gh api --include` output into status, headers and body. */
function splitIncluded(stdout: string): { status: number; headers: string[]; body: string } {
  const match = /\r?\n\r?\n/.exec(stdout)
  const head = match ? stdout.slice(0, match.index) : stdout
  const body = match ? stdout.slice(match.index + match[0].length) : ''
  const [statusLine = '', ...headers] = head.split(/\r?\n/)
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1] ?? 0)
  return { status, headers, body }
}

/**
 * The next page's endpoint from a `Link` header, as a path `gh api` resolves
 * against its own host. The URL's host is discarded rather than trusted.
 */
export function nextRestEndpoint(headers: readonly string[]): string | null {
  for (const header of headers) {
    const colon = header.indexOf(':')
    if (colon === -1 || header.slice(0, colon).trim().toLowerCase() !== 'link') continue
    for (const part of header.slice(colon + 1).split(',')) {
      const link = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)
      if (!link?.[1]) continue
      let url: URL
      try {
        url = new URL(link[1])
      } catch {
        return null
      }
      // GitHub Enterprise Server serves the REST API under /api/v3/, which gh
      // adds itself for a relative endpoint.
      const path = url.pathname.replace(/^\/api\/v3\//, '/')
      const endpoint = parseRestEndpoint(`${path}${url.search}`)
      return endpoint.ok ? endpoint.value : null
    }
  }
  return null
}

const pageInfoSchema = z
  .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
  .nullable()
const graphqlEnvelopeSchema = z.object({
  copsePageInfo: pageInfoSchema.optional(),
  copseOutput: z.array(z.json()),
})

/**
 * Wrap the agent's filter so one `gh` call yields both the filtered output and
 * the first `pageInfo` in the response, the object `gh --paginate` follows. The
 * agent filter sits on its own lines so a trailing `#` comment cannot swallow
 * the wrapper; it is otherwise unconstrained jq the agent could have run anyway.
 */
function graphqlPagingFilter(jq: string | undefined): string {
  return [
    '{copsePageInfo: ([.. | objects | select(has("pageInfo")) | .pageInfo] | first),',
    'copseOutput: [(',
    jq ?? '.',
    ')]}',
  ].join('\n')
}

/** Print jq results as `gh --jq` does: strings raw, everything else as JSON. */
function formatJqOutputs(values: readonly unknown[]): string {
  return values
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n')
}

class GhApiError extends Error {}

async function fetchPage(
  input: GhApiReadInput,
  next: string | null,
  run: GhApiRunner,
  timeout_ms: number,
  signal: AbortSignal | undefined,
): Promise<Page> {
  const common = { timeout_ms, stdoutMaxBytes: STDOUT_READ_BYTES, ...(signal ? { signal } : {}) }
  if (input.kind === 'rest') {
    const endpoint = next ?? input.endpoint
    const args = ['api', '--method', 'GET', '--include']
    if (input.jq !== undefined) args.push(`--jq=${input.jq}`)
    args.push('--', endpoint)
    const result = await run(args, common)
    const { headers, body } = splitIncluded(result.stdout)
    if (result.code !== 0) throw new GhApiError(describeFailure(result.stderr, body, result.code))
    return { body, next: input.paginate ? nextRestEndpoint(headers) : null }
  }

  const variables = next === null ? input.variables : { ...input.variables, endCursor: next }
  const args = ['api', 'graphql', '--input', '-']
  if (input.paginate) args.push(`--jq=${graphqlPagingFilter(input.jq)}`)
  else if (input.jq !== undefined) args.push(`--jq=${input.jq}`)
  const stdin = Buffer.from(JSON.stringify({ query: input.query, variables }), 'utf8')
  const result = await run(args, { ...common, stdin })
  if (result.code !== 0)
    throw new GhApiError(describeFailure(result.stderr, result.stdout, result.code))
  if (!input.paginate) return { body: result.stdout, next: null }
  const envelope = safeJsonParse(result.stdout.trim(), decodeWithSchema(graphqlEnvelopeSchema))
  // An envelope too large to parse is still useful text: return it raw and let
  // the cap below truncate it, rather than discarding the page.
  if (!envelope) return { body: result.stdout, next: null }
  const pageInfo = envelope.copsePageInfo
  return {
    body: formatJqOutputs(envelope.copseOutput),
    next: pageInfo?.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : null,
  }
}

function describeFailure(stderr: string, body: string, code: number): string {
  const detail = [stderr.trim(), truncateUtf8(body.trim(), 4096)].filter(Boolean).join('\n')
  return detail || `gh exited with code ${String(code)}`
}

function truncationNotice(): string {
  return (
    `\n\n[gh_api_read: output truncated at ${String(GH_API_READ_MAX_OUTPUT_BYTES / 1024)} KiB. ` +
    'Narrow the result with jq, select fewer fields, or request smaller pages ' +
    '(per_page/page for REST, first/after for GraphQL).]'
  )
}

function pageLimitNotice(input: GhApiReadInput, next: string): string {
  const resume =
    input.kind === 'rest'
      ? `continue from endpoint "${next}"`
      : `continue with variables.endCursor = ${JSON.stringify(next)}`
  return `\n\n[gh_api_read: stopped after ${String(GH_API_READ_MAX_PAGES)} pages; more exist. Narrow the query, or ${resume}.]`
}

/**
 * Run a validated read and return text for the agent: the output capped at
 * {@link GH_API_READ_MAX_OUTPUT_BYTES}, with a notice when it was truncated or
 * pagination stopped early, or an error message.
 */
export async function runGhApiRead(
  input: GhApiReadInput,
  run: GhApiRunner,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<string> {
  const deadline = now() + GH_API_READ_TIMEOUT_MS
  const pieces: string[] = []
  let bytes = 0
  let next: string | null = null
  for (let page = 1; ; page++) {
    const remaining = deadline - now()
    if (remaining <= 0) {
      pieces.push(
        `\n\n[gh_api_read: stopped after ${String(GH_API_READ_TIMEOUT_MS / 1000)} s; ${String(page - 1)} page(s) read.]`,
      )
      break
    }
    let result: Page
    try {
      result = await fetchPage(input, next, run, remaining, signal)
    } catch (error) {
      const message = errorMessage(error)
      if (pieces.length === 0) return `gh_api_read failed: ${message}`
      pieces.push(`\n\n[gh_api_read: page ${String(page)} failed: ${message}]`)
      break
    }
    const piece = pieces.length === 0 ? result.body : `\n${result.body}`
    const pieceBytes = Buffer.byteLength(piece, 'utf8')
    if (bytes + pieceBytes > GH_API_READ_MAX_OUTPUT_BYTES) {
      pieces.push(truncateUtf8(piece, GH_API_READ_MAX_OUTPUT_BYTES - bytes), truncationNotice())
      break
    }
    pieces.push(piece)
    bytes += pieceBytes
    next = result.next
    if (next === null) break
    if (page >= GH_API_READ_MAX_PAGES) {
      pieces.push(pageLimitNotice(input, next))
      break
    }
  }
  const text = pieces.join('')
  return text.trim().length === 0 ? '(empty response)' : text
}
