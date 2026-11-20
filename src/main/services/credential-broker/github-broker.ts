/**
 * Per-execution GitHub credential broker (`docs/plans/execution-runtime-security.md`,
 * R2 and binding decision 5).
 *
 * The workload never receives the user's GitHub token. Each execution gets its
 * own grant: a private directory holding a unix socket and a gh config that
 * points `http_unix_socket` at it, plus a random capability the child presents
 * as `GH_TOKEN`. gh then speaks plain HTTP over that socket; the broker checks
 * the capability, the target host, the method and (for a read-only grant) that
 * a GraphQL body is a query, then replays the request to `https://api.github.com`
 * with the real token attached in this process. The capability is worthless
 * anywhere else: a leaked copy cannot authenticate to GitHub, and another
 * execution's capability does not open this socket's grant.
 *
 * The broker never follows a redirect, so the credential is never sent to a
 * redirect target; the client receives the 3xx and follows it without it.
 * Every grant, request and refusal is recorded on the thread spine by opaque
 * credential reference — never the token, never request or response bodies.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  runtimeProfileId,
  type ExecutionGrant,
  type ExecutionPrincipal,
  type RuntimeProfile,
} from '@shared/threads/execution-runtime.ts'
import type { RecordDecisionInput } from '../security/decision-log-store.ts'
import { parseGraphqlQuery } from '../github/gh-api-read.ts'
import { isRecord } from '@shared/unknown-value.ts'

/** The only origin this broker attaches a GitHub credential for. */
export const GITHUB_API_HOST = 'api.github.com'
const GITHUB_API_ORIGIN = `https://${GITHUB_API_HOST}`

/** Opaque identity of the credential the broker attaches; recorded instead of the value. */
export const GITHUB_CREDENTIAL_REF = 'github:user-login'

/** Env keys through which a raw GitHub token could reach a child. */
export const GITHUB_TOKEN_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const

const READ_ONLY_METHODS = ['GET', 'HEAD'] as const
const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'] as const

/** A grant outlives its process only if the process outlives this. */
export const GITHUB_GRANT_TTL_MS = 60 * 60_000

/** Largest request body the broker buffers (GraphQL documents, REST JSON). */
const MAX_REQUEST_BYTES = 1024 * 1024

/**
 * Requests one grant serves at once. Each may buffer a body of up to
 * {@link MAX_REQUEST_BYTES} in the main process, so a contained command cannot
 * hold more than this many megabytes; a request beyond the cap gets a 429.
 */
export const GITHUB_GRANT_MAX_CONCURRENT_REQUESTS = 16

/** How long a client has to send a request's headers and body before a 408. */
export const GITHUB_BROKER_REQUEST_TIMEOUT_MS = 30_000

/**
 * Audit lines of each kind (`credential-use`, `network-access`) one grant
 * writes to the thread's spine. Past this the broker only counts, and
 * releasing the grant writes one summary line per kind with the count.
 */
export const GITHUB_GRANT_AUDIT_LINES_PER_KIND = 20

/** Request headers never forwarded upstream. */
const DROPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'proxy-authorization',
  'proxy-connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  // The body goes upstream exactly as the broker checked it, and a
  // method-override header cannot turn a read into a write.
  'content-encoding',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
])

/** Response headers that describe the upstream framing, not the body we relay. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'keep-alive',
])

export interface UpstreamRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: Buffer
}

export interface UpstreamResponse {
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: Buffer
}

export interface GitHubBrokerDependencies {
  /** Host-side lookup of the user's GitHub token; null when there is none. */
  resolveToken: () => Promise<string | null>
  /** Send one request upstream. Must not follow redirects. */
  upstream: (request: UpstreamRequest) => Promise<UpstreamResponse>
  record: (input: RecordDecisionInput) => void
  now: () => number
  /**
   * Private parent directory for per-grant sockets and gh config. No sandbox
   * profile may grant writes to it or its children: a contained command that
   * could rename a grant directory could swap in another execution's config.
   */
  stateDir: () => string
  /** Deadline for a request's headers and body ({@link GITHUB_BROKER_REQUEST_TIMEOUT_MS}). */
  requestTimeoutMs: number
}

export interface GitHubGrantRequest {
  readonly principal: ExecutionPrincipal
  readonly projectId: string
  readonly threadId: string
  readonly profile: RuntimeProfile
  /** Contained executions get a read-only grant, matching `gh_api_read`. */
  readonly readOnly: boolean
}

export interface IssuedGitHubGrant {
  readonly grant: ExecutionGrant
  /** Env overlay for the child: a private gh config and the capability. */
  readonly env: Readonly<Record<string, string>>
  /** The unix socket the child must be allowed to connect to. */
  readonly socketPath: string
  /** The grant's private directory (socket and gh config), which the child must be able to read. */
  readonly configDir: string
  /** Close the socket, revoke the capability and remove the grant's files. Idempotent. */
  readonly release: () => Promise<void>
}

export async function fetchUpstream(request: UpstreamRequest): Promise<UpstreamResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body && request.body.length > 0 ? { body: new Uint8Array(request.body) } : {}),
    redirect: 'manual',
  })
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: Buffer.from(await response.arrayBuffer()),
  }
}

function capabilityMatches(header: string | undefined, capability: Buffer): boolean {
  if (!header) return false
  const match = /^(?:token|bearer)\s+(\S+)$/i.exec(header.trim())
  const presented = Buffer.from(match?.[1] ?? '', 'utf8')
  return presented.length === capability.length && timingSafeEqual(presented, capability)
}

function requestHost(request: IncomingMessage): string {
  return (request.headers.host ?? '').toLowerCase().replace(/:443$/, '')
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Whether a read-only grant may send this `POST /graphql` body: only a query document. */
function isReadOnlyGraphqlQuery(body: Buffer): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false
  const query = parsed['query']
  return typeof query === 'string' && parseGraphqlQuery(query).ok
}

function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ message: `Copse credential broker: ${message}` }))
}

export function createGitHubCredentialBroker(dependencies: GitHubBrokerDependencies): {
  issue: (request: GitHubGrantRequest) => Promise<IssuedGitHubGrant>
} {
  return {
    issue: async (request): Promise<IssuedGitHubGrant> => {
      const dir = await mkdtemp(join(dependencies.stateDir(), 'gh-'))
      const socketPath = join(dir, 'broker.sock')
      const capabilityText = randomBytes(32).toString('base64url')
      const capability = Buffer.from(capabilityText, 'utf8')
      const methods = request.readOnly ? READ_ONLY_METHODS : ALL_METHODS
      const grant: ExecutionGrant = {
        principalId: request.principal.id,
        projectId: request.projectId,
        threadId: request.threadId,
        turnId: '',
        operation: request.readOnly ? 'github-api-read' : 'github-api',
        network: { origins: [GITHUB_API_ORIGIN], methods: [...methods] },
        credentialRef: GITHUB_CREDENTIAL_REF,
        expiresAt: dependencies.now() + GITHUB_GRANT_TTL_MS,
        remembered: false,
      }
      const runtime = runtimeProfileId(request.profile)
      const audit = {
        projectId: request.projectId,
        threadId: request.threadId,
        principalId: request.principal.id,
        principalKind: request.principal.kind,
        runtime,
        source: GITHUB_CREDENTIAL_REF,
      } satisfies Partial<RecordDecisionInput>
      let revoked = false
      let inFlight = 0

      // A contained loop can make requests for the grant's whole hour, so the
      // spine gets the first few lines of each kind and then one count.
      const audited = { 'credential-use': 0, 'network-access': 0 }
      const unrecorded = { 'credential-use': 0, 'network-access': 0 }
      const recordEffect = (input: RecordDecisionInput & { kind: keyof typeof audited }): void => {
        if (audited[input.kind] >= GITHUB_GRANT_AUDIT_LINES_PER_KIND) {
          unrecorded[input.kind] += 1
          return
        }
        audited[input.kind] += 1
        dependencies.record(input)
      }
      const recordUnrecordedCounts = (): void => {
        const refused = unrecorded['network-access']
        if (refused > 0) {
          dependencies.record({
            ...audit,
            kind: 'network-access',
            actor: 'system',
            verdict: 'blocked',
            subject: `${String(refused)} more refused requests`,
            reasons: [`only the first ${String(GITHUB_GRANT_AUDIT_LINES_PER_KIND)} are listed`],
          })
        }
        const relayed = unrecorded['credential-use']
        if (relayed > 0) {
          dependencies.record({
            ...audit,
            kind: 'credential-use',
            actor: 'system',
            verdict: 'allowed',
            subject: `${String(relayed)} more relayed requests`,
            scope: grant.operation,
            reasons: [`only the first ${String(GITHUB_GRANT_AUDIT_LINES_PER_KIND)} are listed`],
          })
        }
      }

      const block = (
        response: ServerResponse,
        status: number,
        subject: string,
        why: string,
      ): void => {
        recordEffect({
          ...audit,
          kind: 'network-access',
          actor: 'system',
          verdict: 'blocked',
          subject,
          reasons: [why],
        })
        refuse(response, status, why)
      }

      const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const method = (req.method ?? 'GET').toUpperCase()
        const host = requestHost(req)
        const path = req.url ?? '/'
        const subject = `${method} ${host || '(no host)'}`
        if (!capabilityMatches(req.headers.authorization, capability)) {
          block(res, 401, subject, 'this command did not present its own GitHub access key')
          return
        }
        if (revoked || dependencies.now() >= grant.expiresAt) {
          block(res, 401, subject, 'grant expired or revoked')
          return
        }
        if (host !== GITHUB_API_HOST || !path.startsWith('/')) {
          block(res, 403, subject, `destination not in grant: ${host || '(none)'}`)
          return
        }
        // Decide the method before buffering anything. A read-only grant sends
        // GraphQL only as a POST body it checks below: no GET, no query string.
        const graphqlBody = request.readOnly && method === 'POST' && path === '/graphql'
        const allowed: readonly string[] = methods
        if (request.readOnly && path.split('?')[0] === '/graphql' && !graphqlBody) {
          block(res, 403, subject, 'read-only grant: GraphQL is read only as a POST query')
          return
        }
        if (!allowed.includes(method) && !graphqlBody) {
          block(
            res,
            403,
            subject,
            request.readOnly
              ? `read-only grant: ${method} is not a read`
              : `method not in grant: ${method}`,
          )
          return
        }
        if (inFlight >= GITHUB_GRANT_MAX_CONCURRENT_REQUESTS) {
          block(res, 429, subject, 'too many requests at once for this grant')
          return
        }
        inFlight += 1
        try {
          await relay(req, res, method, path, subject, graphqlBody)
        } finally {
          inFlight -= 1
        }
      }

      const relay = async (
        req: IncomingMessage,
        res: ServerResponse,
        method: string,
        path: string,
        subject: string,
        graphqlBody: boolean,
      ): Promise<void> => {
        const body = await readBody(req)
        if (body === null) {
          block(res, 413, subject, 'request body too large')
          return
        }
        if (graphqlBody && !isReadOnlyGraphqlQuery(body)) {
          block(res, 403, subject, 'read-only grant: POST is not a read')
          return
        }
        const token = await dependencies.resolveToken()
        if (!token) {
          block(res, 503, subject, 'no GitHub login available to attach')
          return
        }
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue
          headers[name] = Array.isArray(value) ? value.join(', ') : value
        }
        headers['authorization'] = `token ${token}`
        let upstream: UpstreamResponse
        try {
          upstream = await dependencies.upstream({
            url: `${GITHUB_API_ORIGIN}${path}`,
            method,
            headers,
            ...(body.length > 0 ? { body } : {}),
          })
        } catch {
          block(res, 502, subject, 'upstream request failed')
          return
        }
        for (const [name, value] of upstream.headers) {
          if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) res.appendHeader(name, value)
        }
        res.setHeader('content-length', String(upstream.body.length))
        res.writeHead(upstream.status)
        res.end(method === 'HEAD' ? undefined : upstream.body)
        recordEffect({
          ...audit,
          kind: 'credential-use',
          actor: 'system',
          verdict: 'allowed',
          subject,
          scope: grant.operation,
          reasons: [
            `status ${String(upstream.status)}`,
            `bytes out ${String(body.length)}`,
            `bytes in ${String(upstream.body.length)}`,
          ],
        })
      }

      // Node answers 408 and closes the connection when the headers and body
      // have not both arrived by the deadline, so a stalled client cannot pin
      // a buffered body in this process.
      const server: Server = createServer(
        {
          headersTimeout: dependencies.requestTimeoutMs,
          requestTimeout: dependencies.requestTimeoutMs,
          connectionsCheckingInterval: Math.min(1_000, dependencies.requestTimeoutMs),
        },
        (req, res) => {
          handle(req, res).catch(() => {
            if (!res.headersSent) refuse(res, 500, 'internal error')
            else res.destroy()
          })
        },
      )
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(socketPath, () => {
            server.off('error', reject)
            resolve()
          })
        })
        await writeFile(join(dir, 'config.yml'), `http_unix_socket: ${socketPath}\n`, {
          mode: 0o600,
        })
      } catch (error) {
        // A socket path past the platform's limit fails here; leave nothing behind.
        server.close()
        await rm(dir, { recursive: true, force: true })
        throw error
      }

      dependencies.record({
        ...audit,
        kind: 'execution-grant',
        actor: 'system',
        verdict: 'allowed',
        subject: `${grant.operation} ${GITHUB_API_HOST}`,
        scope: grant.operation,
        reasons: [
          `methods ${methods.join(',')}${request.readOnly ? ' + GraphQL query' : ''}`,
          `expires ${new Date(grant.expiresAt).toISOString()}`,
        ],
      })

      let released: Promise<void> | null = null
      return {
        grant,
        socketPath,
        configDir: dir,
        env: { GH_CONFIG_DIR: dir, GH_TOKEN: capabilityText },
        release: (): Promise<void> => {
          released ??= (async (): Promise<void> => {
            revoked = true
            recordUnrecordedCounts()
            await new Promise<void>((resolve) => {
              server.close(() => {
                resolve()
              })
              server.closeAllConnections()
            })
            await rm(dir, { recursive: true, force: true })
          })()
          return released
        },
      }
    },
  }
}
