/**
 * GitHub reads for commands in the desktop's project sandbox: the host side.
 *
 * A contained `run_shell` command has no network and cannot read `~/.ssh` or
 * gh's keyring-backed login, so `git fetch` and `gh pr view` fail inside it
 * and ask to escape. With the experimental setting on, this service serves
 * those reads on the host instead, through the same policy and handler as a
 * container run's GitHub capability (thread-in-container A24): exact GitHub
 * hosts, reads only, the user's token added here and never handed to the
 * command. See `sandbox-github-reads-config.ts` for the route and
 * docs/shell-permissions.md for the contract.
 *
 * Unlike a container's private link, these sockets are on the host, where any
 * process of the same user could connect. So each thread gets a session with
 * its own 32-byte secret, compared in constant time and never logged, and a
 * request without it is answered 401 and goes nowhere. The sockets live in a
 * 0700 directory and are 0600 themselves. That directory is under the system
 * temporary directory, which the project sandbox does not hide from other
 * sandboxed commands, so nothing in it is secret: a spawn gets its session's
 * secret only in its own environment.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duplexPair, type Duplex } from 'node:stream'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type { EgressLogEntry } from '@shared/types/container-run.ts'
import { GitHubCapability, type GitHubUpstream } from '../container-runtime/github-capability.ts'
import {
  encodeHead,
  GITHUB_GIT_ALIAS_HOST,
  githubResponseHeadSchema,
  HeadReader,
} from '../container-runtime/github-capability-wire.ts'
import {
  browserRequestRefusal,
  presentedSecret,
  sameSecret,
  sandboxGhConfigFiles,
  sandboxGhRouted,
  sandboxGitGlobalConfig,
  sandboxGitHubEnv,
  SANDBOX_GITHUB_SESSION_HEADER,
  sessionAliasHost,
  sessionIdFromAliasHost,
  userGlobalGitConfigIncludes,
} from './sandbox-github-reads-config.ts'

/** Appended to every policy refusal; the shell tool's denial signature keys on it. */
export const SANDBOX_GITHUB_READ_ONLY_NOTE =
  'Sandboxed GitHub access is read-only; run the command outside the sandbox to use your own GitHub sign-in.'

export interface SandboxGitHubReadsOptions {
  /** The desktop's GitHub token, or null to read GitHub unauthenticated. */
  token: () => Promise<string | null>
  /** Directory the private 0700 base directory is created in. */
  parentDir?: string
  /** Whether gh is routed: only where Seatbelt can allow one socket path. */
  platform?: NodeJS.Platform
  /** How the handler reaches GitHub; `https.request` by default. */
  upstream?: GitHubUpstream
  /** Every decision, without credentials. */
  onLog?: (entry: EgressLogEntry & { session: string }) => void
}

/** What one sandboxed spawn for a session is given. */
export interface SandboxGitHubSpawn {
  /** Variables added on top of the spawn's own environment. */
  env: (base: NodeJS.ProcessEnv) => Record<string, string | undefined>
  /** Unix socket paths the spawn may connect to (macOS Seatbelt). */
  allowUnixSockets: string[]
  /** Paths the spawn may read: the session's git and (macOS) gh configuration. */
  allowRead: string[]
}

interface Session {
  id: string
  secret: string
  dir: string
  aliasHost: string
  gh: { socketPath: string; configDir: string; server: Server } | null
}

type Route = 'git' | 'gh'

function headerPairs(request: IncomingMessage): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    pairs.push([request.rawHeaders[i] ?? '', request.rawHeaders[i + 1] ?? ''])
  }
  return pairs
}

/** gh reads a JSON `message`; git shows a `text/plain` body as `remote:` lines. */
function respondText(response: ServerResponse, route: Route, status: number, text: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const body = route === 'gh' ? `${JSON.stringify({ message: text })}\n` : `${text}\n`
  response.writeHead(status, {
    'Content-Type':
      route === 'gh' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    Connection: 'close',
  })
  response.end(body)
}

/** The longest unix socket path every supported platform accepts (macOS: 104 with the NUL). */
const SOCKET_PATH_LIMIT = 103

function listen(server: Server, path: string): Promise<void> {
  if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
    return Promise.reject(new Error(`socket path is too long for this platform: ${path}`))
  }
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      // Same user only; the 0700 directory already keeps others from reaching it.
      chmodSync(path, 0o600)
      resolveListen()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => {
      resolveClose()
    })
    server.closeAllConnections()
  })
}

/**
 * The session's global git configuration for one spawn's environment, written
 * when missing. Its name is its contents' hash, so spawns whose environments
 * name the same user files share one file. Null leaves the user's global
 * configuration in place and the route to the `GIT_CONFIG_*` rewrites alone,
 * as before this file existed.
 */
function gitGlobalConfigFor(session: Session, base: NodeJS.ProcessEnv): string | null {
  const includes = userGlobalGitConfigIncludes(base)
  if (includes === null) return null
  const contents = sandboxGitGlobalConfig(session.aliasHost, includes)
  if (contents === null) return null
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 12)
  const path = join(session.dir, `git-${digest}.config`)
  if (!existsSync(path)) {
    try {
      writeFileSync(path, contents, { mode: 0o600 })
    } catch {
      return null
    }
  }
  return path
}

export class SandboxGitHubReads {
  /** The socket ASRT's proxy routes every session's git alias to. */
  readonly gitSocketPath: string
  private readonly base: string
  private readonly options: SandboxGitHubReadsOptions
  private readonly routesGh: boolean
  private readonly gitServer: Server
  private readonly byKey = new Map<string, Promise<Session>>()
  private readonly byId = new Map<string, Session>()
  private readonly live = new Set<Duplex>()
  private closed = false
  private sessions = 0

  private constructor(options: SandboxGitHubReadsOptions, base: string) {
    this.options = options
    this.base = base
    this.gitSocketPath = join(base, 'git.sock')
    this.routesGh = sandboxGhRouted(options.platform ?? process.platform)
    this.gitServer = this.makeServer('git', null)
  }

  static async start(options: SandboxGitHubReadsOptions): Promise<SandboxGitHubReads> {
    // mkdtemp creates the directory 0700. Canonical, so the Seatbelt socket
    // rule names the path the kernel sees (/private/var/... on macOS).
    const base = realpathSync(mkdtempSync(join(options.parentDir ?? tmpdir(), 'cghr-')))
    chmodSync(base, 0o700)
    const reads = new SandboxGitHubReads(options, base)
    try {
      await listen(reads.gitServer, reads.gitSocketPath)
    } catch (error) {
      rmSync(base, { recursive: true, force: true })
      throw error
    }
    return reads
  }

  /** The session for `key` (a thread id), created on first use. */
  async spawnFor(key: string): Promise<SandboxGitHubSpawn> {
    if (this.closed) throw new Error('sandbox GitHub reads are stopped')
    let pending = this.byKey.get(key)
    if (pending === undefined) {
      pending = this.createSession()
      this.byKey.set(key, pending)
      pending.catch(() => {
        this.byKey.delete(key)
      })
    }
    const session = await pending
    return {
      env: (base) =>
        sandboxGitHubEnv(base, {
          aliasHost: session.aliasHost,
          secret: session.secret,
          ghConfigDir: session.gh?.configDir ?? null,
          gitGlobalConfig: gitGlobalConfigFor(session, base),
        }),
      allowUnixSockets: session.gh ? [session.gh.socketPath] : [],
      allowRead: [session.dir],
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const stream of this.live) stream.destroy()
    const sessions = await Promise.allSettled([...this.byKey.values()])
    await Promise.all([
      closeServer(this.gitServer),
      ...sessions.flatMap((result) =>
        result.status === 'fulfilled' && result.value.gh
          ? [closeServer(result.value.gh.server)]
          : [],
      ),
    ])
    rmSync(this.base, { recursive: true, force: true })
  }

  private async createSession(): Promise<Session> {
    const id = `s${randomBytes(8).toString('hex')}`
    // 32 random bytes; the prefix only makes a leaked value recognisable.
    const secret = `copse_sgh_${randomBytes(32).toString('hex')}`
    // A short directory name: macOS caps a socket path at 104 bytes.
    this.sessions += 1
    const dir = join(this.base, String(this.sessions))
    mkdirSync(dir, { mode: 0o700 })
    const session: Session = { id, secret, dir, aliasHost: sessionAliasHost(id), gh: null }
    if (this.routesGh) {
      const socketPath = join(dir, 'gh.sock')
      const configDir = join(dir, 'gh')
      mkdirSync(configDir, { mode: 0o700 })
      for (const [name, contents] of Object.entries(sandboxGhConfigFiles({ socketPath }))) {
        writeFileSync(join(configDir, name), contents, { mode: 0o600 })
      }
      const server = this.makeServer('gh', session)
      await listen(server, socketPath)
      session.gh = { socketPath, configDir, server }
    }
    this.byId.set(id, session)
    return session
  }

  private makeServer(route: Route, bound: Session | null): Server {
    const server = createServer((request, response) => {
      this.handle(route, bound, request, response)
    })
    server.on('connect', (_request: IncomingMessage, socket: Socket) => {
      socket.end(
        'HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      )
    })
    server.on('upgrade', (_request: IncomingMessage, socket: Socket) => {
      socket.destroy()
    })
    server.on('clientError', (_error, socket) => {
      socket.destroy()
    })
    return server
  }

  private log(session: string, entry: Omit<EgressLogEntry, 'at'>): void {
    this.options.onLog?.({ at: Date.now(), session, ...entry })
  }

  private handle(
    route: Route,
    bound: Session | null,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const headers = headerPairs(request)
    const refuse = (status: number, reason: string, session = '-'): void => {
      this.log(session, { origin: `sandbox-github ${route}`, event: 'refused', detail: reason })
      respondText(response, route, status, `Copse refused this request: ${reason}.`)
      request.resume()
    }
    const browser = browserRequestRefusal(headers)
    if (browser !== null) {
      refuse(403, browser)
      return
    }

    let session: Session | undefined
    let target = request.url ?? '/'
    let forwarded = headers
    if (route === 'gh') {
      session = bound ?? undefined
    } else {
      // ASRT's proxy forwards in absolute form, with the Host it checked.
      const match = /^http:\/\/([^/?#]*)(.*)$/is.exec(target)
      if (!match) {
        refuse(400, 'only proxied git requests are accepted here')
        return
      }
      const host = (match[1] ?? '').toLowerCase().replace(/:80$/, '')
      const hostHeaders = headers.filter(([name]) => name.toLowerCase() === 'host')
      const hostHeader = (hostHeaders[0]?.[1] ?? '').toLowerCase().replace(/:80$/, '')
      if (hostHeaders.length !== 1 || hostHeader !== host) {
        refuse(400, 'the request URL and its Host header name different hosts')
        return
      }
      const id = sessionIdFromAliasHost(host)
      session = id === null ? undefined : this.byId.get(id)
      // The policy knows one alias; the session label has done its job.
      target = `http://${GITHUB_GIT_ALIAS_HOST}${match[2] ?? ''}`
      forwarded = headers.map(([name, value]): [string, string] =>
        name.toLowerCase() === 'host' ? [name, GITHUB_GIT_ALIAS_HOST] : [name, value],
      )
    }
    const presented = presentedSecret(route, headers)
    if (session === undefined || presented === null || !sameSecret(presented, session.secret)) {
      refuse(401, "the request did not carry this thread's sandbox GitHub credential", session?.id)
      return
    }
    const sessionHeader = SANDBOX_GITHUB_SESSION_HEADER.toLowerCase()
    forwarded = forwarded.filter(([name]) => {
      const lower = name.toLowerCase()
      return lower !== 'authorization' && lower !== sessionHeader && lower !== 'proxy-authorization'
    })
    this.relay(
      route,
      session,
      { method: request.method ?? 'GET', target, headers: forwarded },
      request,
      response,
    )
  }

  /** Hand one admitted request to the shared handler over an in-memory stream. */
  private relay(
    route: Route,
    session: Session,
    head: { method: string; target: string; headers: Array<[string, string]> },
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const [client, server] = duplexPair()
    this.live.add(client)
    // Set by the handler's log before it writes a refusal's head.
    const outcome: { refusal: string | null } = { refusal: null }
    const capability = new GitHubCapability({
      token: this.options.token,
      // The session secret is the placeholder: anywhere but the (removed)
      // credential header it is a canary, and it is never forwarded.
      placeholder: session.secret,
      route: 'sandbox',
      ...(this.options.upstream ? { upstream: this.options.upstream } : {}),
      onLog: (entry): void => {
        if (entry.event === 'refused') outcome.refusal = entry.detail ?? 'the request is not a read'
        this.log(session.id, entry)
      },
    })
    void capability.serve(server).catch(() => {
      server.destroy()
    })
    client.write(encodeHead(head))
    request.pipe(client)

    const reader = new HeadReader()
    let started = false
    client.on('data', (chunk: Buffer) => {
      if (started) {
        if (!response.write(chunk)) {
          client.pause()
          response.once('drain', () => {
            client.resume()
          })
        }
        return
      }
      let found: { line: string; rest: Buffer } | null
      try {
        found = reader.feed(chunk)
      } catch {
        respondText(response, route, 502, 'Copse: the GitHub handler sent a malformed answer.')
        client.destroy()
        return
      }
      if (found === null) return
      const answer = safeJsonParse(found.line, decodeWithSchema(githubResponseHeadSchema))
      if (answer === null) {
        respondText(response, route, 502, 'Copse: the GitHub handler sent a malformed answer.')
        client.destroy()
        return
      }
      started = true
      if (outcome.refusal !== null) {
        // Re-worded for the client that asked: git only shows text/plain.
        respondText(
          response,
          route,
          answer.status,
          `Copse refused this request: ${outcome.refusal}. ${SANDBOX_GITHUB_READ_ONLY_NOTE}`,
        )
        client.destroy()
        return
      }
      response.writeHead(answer.status, answer.headers.flat())
      if (found.rest.length > 0) response.write(found.rest)
    })
    client.on('end', () => {
      if (!started)
        respondText(response, route, 502, 'Copse: the GitHub handler closed the request.')
      else if (!response.writableEnded) response.end()
    })
    client.on('error', () => {
      respondText(response, route, 502, 'Copse: the GitHub request failed.')
    })
    client.on('close', () => {
      this.live.delete(client)
    })
    response.on('close', () => {
      if (!client.destroyed) client.destroy()
    })
  }
}
