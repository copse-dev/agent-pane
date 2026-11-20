/**
 * Which GitHub requests from a container run the host forwards, to where, and
 * with which credential (`docs/plans/thread-in-container.md`, decision A24).
 * Pure: the handler (`github-capability.ts`) does the I/O.
 *
 * Hosts:
 * - Token-bearing, exactly `api.github.com` and `github.com` (and the guest's
 *   git alias, `github.copse.internal`, which means `github.com` for git's
 *   fetch paths only). Exact match after lowercasing; a trailing dot, a port
 *   other than the default, userinfo, an IP literal, or any prefix or suffix
 *   is a different name and is refused.
 * - Pass-through, forwarded without any credential, exactly: `codeload.github.com`
 *   (archives), `results-receiver.actions.githubusercontent.com` (`gh run view
 *   --log` is redirected there), `objects.githubusercontent.com` and
 *   `release-assets.githubusercontent.com` (release downloads) and
 *   `raw.githubusercontent.com`. Not every `*.githubusercontent.com` host:
 *   `camo.githubusercontent.com` fetches any URL it is given, so the suffix
 *   would be a route out to hosts the guest chooses.
 * - Everything else is refused.
 *
 * Reads only, in this version: GET and HEAD (never anything naming
 * `git-receive-pack`), git's `git-upload-pack` POST on github.com, and a
 * GraphQL POST whose body is a single query (`graphql-read-only.ts`). Every
 * other method is a write and is refused before anything is forwarded.
 *
 * Credentials: the guest's own `Authorization` is always removed. The real
 * token is added only on a token-bearing host, as `token …` for the API and as
 * Basic `x-access-token:…` for git smart HTTP on github.com (GitHub answers
 * `token` there with 401). On github.com only git's two fetch paths are
 * forwarded at all: `gh` reads through the API, and a release or log download
 * arrives as an API redirect to a pass-through host. Any other web page or
 * download would only widen what a run's choice of reads can signal to the
 * owners of what it reads (download and traffic counts).
 */
import { isIP } from 'node:net'
import { GITHUB_GIT_ALIAS_HOST } from './github-capability-wire.ts'

export const GITHUB_API_HOST = 'api.github.com'
export const GITHUB_WEB_HOST = 'github.com'

/** Hosts that never get a token, forwarded for reads only. Exact names, never a suffix. */
const PASS_THROUGH_HOSTS = new Set([
  'codeload.github.com',
  'results-receiver.actions.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
])

export type GitHubAuth = 'token' | 'basic' | 'none'

export type GitHubDecision =
  | { action: 'refuse'; status: number; reason: string }
  | {
      action: 'forward'
      /** The real host to dial over HTTPS on 443. */
      host: string
      /** Origin-form path and query to send. */
      path: string
      auth: GitHubAuth
      /** `graphql`: buffer the body and check it is one query before forwarding. */
      body: 'none' | 'stream' | 'graphql'
    }

export interface GitHubRequestFacts {
  method: string
  /** The request-target as received. */
  target: string
  /** The `Host` header, or null when there was none (or more than one). */
  host: string | null
}

function refuse(reason: string, status = 403): GitHubDecision {
  return { action: 'refuse', status, reason }
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * `host` or `host:port`, lowercased and checked: no trailing dot, no empty
 * label, no IP literal, no userinfo, no brackets. The port, when present, is
 * returned for the caller to compare with the scheme's default.
 */
export function parseAuthority(value: string): { host: string; port: number | null } | null {
  const match = /^([^:@[\]\s/\\]+)(?::(\d{1,5}))?$/.exec(value)
  if (!match) return null
  const host = (match[1] ?? '').toLowerCase()
  if (isIP(host) !== 0) return null
  const labels = host.split('.')
  if (!labels.every((label) => LABEL.test(label))) return null
  const port = match[2] === undefined ? null : Number(match[2])
  if (port !== null && (port < 1 || port > 65535)) return null
  return { host, port }
}

function isPassThroughHost(host: string): boolean {
  return PASS_THROUGH_HOSTS.has(host)
}

/** Percent-decoded, or null when the encoding is malformed. */
function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

const REPO_SEGMENT = '[A-Za-z0-9_.-]+'
const UPLOAD_PACK_PATH = new RegExp(`^/${REPO_SEGMENT}/${REPO_SEGMENT}/git-upload-pack$`)
const INFO_REFS_PATH = new RegExp(`^/${REPO_SEGMENT}/${REPO_SEGMENT}/info/refs$`)

type GitPath = 'info-refs' | 'upload-pack' | null

/** Git's smart-HTTP fetch paths: the ref advertisement and the pack request. */
function gitFetchPath(method: string, path: string, query: string): GitPath {
  if ((method === 'GET' || method === 'HEAD') && INFO_REFS_PATH.test(path)) {
    return query === 'service=git-upload-pack' ? 'info-refs' : null
  }
  if (method === 'POST' && UPLOAD_PACK_PATH.test(path) && query === '') return 'upload-pack'
  return null
}

/**
 * Whether a decoded API path could reach GraphQL in any spelling: a first
 * segment (or the one after `api`) starting with `graphql`, once repeated
 * slashes are collapsed and `;params` and an extension are dropped. No REST
 * resource on the API has such a top-level segment, so
 * `/repos/graphql/graphql-js` and the like still pass.
 */
function namesGraphqlEndpoint(plainPath: string): boolean {
  const segments = plainPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase().split(';')[0]?.split('.')[0] ?? '')
  const [first = '', second = ''] = segments
  return first.startsWith('graphql') || (first === 'api' && second.startsWith('graphql'))
}

/** Decide one request. */
export function decideGitHubRequest(facts: GitHubRequestFacts): GitHubDecision {
  const method = facts.method.toUpperCase()
  if (!/^[A-Z]+$/.test(method)) return refuse('the request method is malformed', 400)

  // Where the client meant to go: the Host header for origin-form (gh over
  // its socket), the URL for absolute-form (git through the loopback proxy),
  // and the two must agree when both are present.
  let authority: string
  let pathAndQuery: string
  if (facts.target.startsWith('/')) {
    if (facts.host === null) return refuse('the request has no single Host header', 400)
    authority = facts.host
    pathAndQuery = facts.target
  } else if (/^http:\/\//i.test(facts.target)) {
    let url: URL
    try {
      url = new URL(facts.target)
    } catch {
      return refuse('the request URL is malformed', 400)
    }
    if (url.username !== '' || url.password !== '' || /^http:\/\/[^/]*@/i.test(facts.target)) {
      return refuse('credentials in the request URL are not allowed')
    }
    const raw = /^http:\/\/([^/?#]*)/i.exec(facts.target)?.[1] ?? ''
    authority = raw
    if (facts.host !== null && facts.host.toLowerCase() !== raw.toLowerCase()) {
      return refuse('the request URL and its Host header name different hosts')
    }
    const rest = facts.target.slice(`http://${raw}`.length)
    pathAndQuery = rest.length === 0 ? '/' : rest
    if (!pathAndQuery.startsWith('/') && !pathAndQuery.startsWith('?')) {
      return refuse('the request URL is malformed', 400)
    }
    if (pathAndQuery.startsWith('?')) pathAndQuery = `/${pathAndQuery}`
  } else {
    return refuse('only origin-form and plain-http absolute-form requests are accepted', 400)
  }

  const parsed = parseAuthority(authority)
  if (parsed === null) return refuse(`"${authority.slice(0, 80)}" is not a GitHub host`)
  const absolute = !facts.target.startsWith('/')
  const isAlias = parsed.host === GITHUB_GIT_ALIAS_HOST
  // The alias is plain http to the guest's own proxy (port 80); every real
  // name is https (port 443). Only the alias may arrive in absolute form.
  const defaultPort = isAlias ? 80 : 443
  if (parsed.port !== null && parsed.port !== defaultPort) {
    return refuse(`port ${String(parsed.port)} is not GitHub's`)
  }
  if (absolute && !isAlias) {
    return refuse('only the git alias may be requested through the proxy form')
  }

  if (/[\s#\\]/.test(pathAndQuery) || /[\u0000-\u001f\u007f]/.test(pathAndQuery)) {
    return refuse('the request path is malformed', 400)
  }
  const queryAt = pathAndQuery.indexOf('?')
  const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt)
  const query = queryAt === -1 ? '' : pathAndQuery.slice(queryAt + 1)
  const plainPath = decoded(path)
  const plainQuery = decoded(query.replace(/\+/g, ' '))
  if (plainPath === null || plainQuery === null) {
    return refuse('the request path has malformed percent-encoding', 400)
  }
  if (plainPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    return refuse('dot segments are not allowed in the request path', 400)
  }
  if (/receive-pack/i.test(`${pathAndQuery} ${plainPath} ${plainQuery}`)) {
    return refuse('pushing is not allowed from a container run')
  }

  const isRead = method === 'GET' || method === 'HEAD'

  if (isAlias || parsed.host === GITHUB_WEB_HOST) {
    // Matched on the raw bytes: the repository segments admit no `%`, so an
    // encoded slash or dot cannot reshape the path GitHub will see.
    const git = gitFetchPath(method, path, query)
    if (git !== null) {
      return {
        action: 'forward',
        host: GITHUB_WEB_HOST,
        path: pathAndQuery,
        auth: 'basic',
        body: git === 'upload-pack' ? 'stream' : 'none',
      }
    }
    if (isAlias) return refuse('only git fetches go through the git alias')
    if (isRead) {
      return refuse(
        'only git fetches go to github.com from a container run; gh reads through the API',
      )
    }
    return refuse(`${method} to github.com is a write; container runs can only read GitHub`)
  }

  if (parsed.host === GITHUB_API_HOST) {
    // GraphQL goes by POST, where the body is checked; a GET carrying a
    // document in its query string is never what gh sends.
    if (isRead && namesGraphqlEndpoint(plainPath)) {
      return refuse('GraphQL must be sent as a POST, where Copse can check it is a query')
    }
    if (isRead) {
      return {
        action: 'forward',
        host: GITHUB_API_HOST,
        path: pathAndQuery,
        auth: 'token',
        body: 'none',
      }
    }
    if (method === 'POST' && path === '/graphql' && query === '') {
      return {
        action: 'forward',
        host: GITHUB_API_HOST,
        path: pathAndQuery,
        auth: 'token',
        body: 'graphql',
      }
    }
    return refuse(
      `${method} ${plainPath.slice(0, 120)} is a write; container runs can only read GitHub`,
    )
  }

  if (isPassThroughHost(parsed.host)) {
    if (isRead) {
      return {
        action: 'forward',
        host: parsed.host,
        path: pathAndQuery,
        auth: 'none',
        body: 'none',
      }
    }
    return refuse(`${method} to ${parsed.host} is a write; container runs can only read GitHub`)
  }

  return refuse(`${parsed.host} is not a GitHub host`)
}
