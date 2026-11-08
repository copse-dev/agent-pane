import { createReadStream, watch, type FSWatcher } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { embeddedIpv4, normalizeHostname } from '@copse/llm/credential-url.ts'
import { sensitiveTargetReason } from '@copse/shell-guard/read-outside-project.ts'
import { PREVIEW_CAPABILITY_PARAM } from '@shared/browser-url.ts'

const LOOPBACK_HOST = '127.0.0.1'
export const PREVIEW_CAPABILITY_HEADER = 'X-Copse-Preview-Capability'

/**
 * Workspace HTML/JS is untrusted (the agent can write it). Allow local preview
 * scripts and styles, but block remote fetch/form posts so a planted page cannot
 * exfiltrate other workspace files the same-origin server would otherwise serve.
 */
const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

interface PreviewServerEntry {
  root: string
  server: Server
  url: string
  /** Never returned to a page; a capability URL only bootstraps one browser guest. */
  capability: string
  /** Recursive watch on `root`, so an edit to a served file reaches the pane. */
  watcher: FSWatcher | null
  /** Armed reload for this origin, coalescing a burst of writes into one. */
  staleTimer: ReturnType<typeof setTimeout> | null
  /**
   * Every spelling of this root a caller has used, canonical form included.
   * `/tmp` and `/var` are symlinks on macOS, so the path the workspace watcher
   * reports a change under is routinely not the realpath the server keyed
   * itself by; matching on either spelling avoids a silently missed reload
   * without an fs round-trip on every change burst.
   */
  roots: Set<string>
  /**
   * Root-relative paths this server has actually served, so a workspace edit
   * can be matched against what a preview is showing. Populated by real
   * requests, which is the only source that knows a page's sub-resources: the
   * entry document alone would miss the stylesheet and script edits that make up
   * most of an iteration. Stored relative because that is the shape the
   * recursive workspace watcher reports a change in. Bounded by the files a page
   * requests.
   */
  served: Set<string>
}

export interface StaticPreviewServer {
  root: string
  url: string
}

const servers = new Map<string, PreviewServerEntry>()

/** Exact loopback origin eligible for an authenticated preview request. */
function previewEntryForRequest(url: string): PreviewServerEntry | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== 'localhost' && parsed.hostname !== LOOPBACK_HOST)
  )
    return null
  parsed.hostname = 'localhost'
  return [...servers.values()].find((entry) => new URL(entry.url).origin === parsed.origin) ?? null
}

/** Add a bootstrap capability; the listener redirects it away before page JS runs. */
export function previewCapabilityUrl(url: string): string {
  const entry = previewEntryForRequest(url)
  if (!entry) return url
  const parsed = new URL(url)
  parsed.searchParams.set(PREVIEW_CAPABILITY_PARAM, entry.capability)
  return parsed.href
}

/** Only a navigation carrying this active listener's capability may bind a browser guest. */
export function previewRequestCapability(url: string): string | null {
  const entry = previewEntryForRequest(url)
  if (!entry) return null
  const supplied = new URL(url).searchParams.get(PREVIEW_CAPABILITY_PARAM)
  return supplied === entry.capability ? entry.capability : null
}

/** Whether this URL belongs to a Copse-owned static prototype server. */
export function isStaticPreviewUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  const host = normalizeHostname(parsed.hostname)
  // The listener binds 127.0.0.1 but advertises localhost. Opening its IP alias
  // must not turn an untrusted prototype into an unrestricted ordinary page.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === LOOPBACK_HOST ||
    embeddedIpv4(host) === LOOPBACK_HOST
  ) {
    parsed.hostname = 'localhost'
  }
  const origin = parsed.origin
  return [...servers.values()].some((entry) => new URL(entry.url).origin === origin)
}

function isInsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function isPrivatePreviewPath(root: string, path: string): boolean {
  const inside = relative(root, path)
  return (
    inside.split(sep).some((segment) => segment.startsWith('.')) ||
    (inside !== '' && sensitiveTargetReason(inside, inside) !== null)
  )
}

async function resolveRequestFile(root: string, requestUrl: string): Promise<string | null> {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null

  const candidate = resolve(root, `.${pathname}`)
  if (!isInsideRoot(root, candidate) || isPrivatePreviewPath(root, candidate)) return null

  try {
    const candidateStat = await stat(candidate)
    const file = candidateStat.isDirectory() ? join(candidate, 'index.html') : candidate
    const canonical = await realpath(file)
    if (!isInsideRoot(root, canonical) || isPrivatePreviewPath(root, canonical)) return null
    return (await stat(canonical)).isFile() ? canonical : null
  } catch {
    return null
  }
}

async function createPreviewServer(root: string): Promise<PreviewServerEntry> {
  const canonicalRoot = await realpath(root)
  const rootStat = await stat(canonicalRoot)
  if (!rootStat.isDirectory()) throw new Error('The preview root is not a directory.')

  const served = new Set<string>()
  const capability = randomBytes(32).toString('base64url')
  const capabilityBytes = Buffer.from(capability)
  let listeningPort = 0
  const server = createServer((request, response) => {
    // Browsers can load scripts and other no-cors resources without an Origin
    // header. Keep those responses inside this origin, including error pages.
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    // A DNS-rebound page keeps its attacker-controlled Host while connecting to
    // 127.0.0.1. Accept only the two loopback names Copse advertises and uses.
    const host = request.headers.host?.toLowerCase()
    const suppliedCapability = request.headers[PREVIEW_CAPABILITY_HEADER.toLowerCase()]
    const suppliedBytes =
      typeof suppliedCapability === 'string' ? Buffer.from(suppliedCapability) : null
    const authorized =
      suppliedBytes !== null &&
      suppliedBytes.length === capabilityBytes.length &&
      timingSafeEqual(suppliedBytes, capabilityBytes)
    if (
      !host ||
      ![`localhost:${String(listeningPort)}`, `127.0.0.1:${String(listeningPort)}`].includes(
        host,
      ) ||
      !authorized ||
      (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) ||
      (request.headers['sec-fetch-site'] !== undefined &&
        request.headers['sec-fetch-site'] !== 'same-origin' &&
        request.headers['sec-fetch-site'] !== 'none')
    ) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden')
      return
    }
    let requested: URL
    try {
      requested = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    if (requested.searchParams.has(PREVIEW_CAPABILITY_PARAM)) {
      if (requested.searchParams.get(PREVIEW_CAPABILITY_PARAM) !== capability) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden')
        return
      }
      requested.searchParams.delete(PREVIEW_CAPABILITY_PARAM)
      response
        .writeHead(302, {
          'Cache-Control': 'no-store',
          Location: `${requested.pathname}${requested.search}`,
        })
        .end()
      return
    }
    void resolveRequestFile(canonicalRoot, request.url ?? '/').then(
      (file) => {
        if (!file) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
          return
        }
        served.add(servedKey(canonicalRoot, file))
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': PREVIEW_CONTENT_SECURITY_POLICY,
          'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
        })
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        const stream = createReadStream(file)
        stream.on('error', () => {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        })
        stream.pipe(response)
      },
      () => {
        response.writeHead(500).end()
      },
    )
  })

  const port = await new Promise<number>((resolvePort, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('The preview server did not receive a loopback port.'))
        return
      }
      resolvePort(address.port)
    })
  })
  listeningPort = port
  server.unref()
  const entry: PreviewServerEntry = {
    root: canonicalRoot,
    server,
    url: `http://localhost:${String(port)}/`,
    capability,
    served,
    roots: new Set([resolve(canonicalRoot)]),
    watcher: null,
    staleTimer: null,
  }
  // The preview owns its own watch rather than borrowing the workspace index
  // watcher: that one is a single-root singleton started by the workspace-open
  // paths, so it never sees a thread worktree (#1400) — exactly where an agent
  // iterating on a prototype does its work. Its rebuild coalescing is also
  // load-bearing (#517), so grafting a second consumer onto it would be the
  // wrong seam even where the roots did line up.
  try {
    const watcher = watch(canonicalRoot, { recursive: true, persistent: false }, (_e, filename) => {
      if (filename !== null) handlePreviewWatchEvent(canonicalRoot, filename)
    })
    // An `error` with no listener is an uncaught exception that kills the main
    // process. A deleted or unmounted preview root must drop the watch instead.
    watcher.on('error', (err: unknown) => {
      console.warn('[copse-panel] preview watcher failed for', canonicalRoot, err)
      entry.watcher?.close()
      entry.watcher = null
    })
    entry.watcher = watcher
  } catch {
    // A root that cannot be watched still previews; it just will not self-refresh.
    entry.watcher = null
  }
  return entry
}

/**
 * Coalescing window for reload notifications. An agent rewriting a page's HTML,
 * CSS and script in one turn should repaint the preview once, not three times.
 */
export const PREVIEW_STALE_DEBOUNCE_MS = 200

type PreviewStaleSink = (origin: string) => void

let staleSink: PreviewStaleSink | null = null

/** Install the Electron-facing delivery boundary for "this preview is stale". */
export function setPreviewStaleSink(next: PreviewStaleSink | null): void {
  staleSink = next
}

/**
 * Route one recursive watch event. Exported for tests so the matching and
 * coalescing can be exercised without depending on `fs.watch` timing.
 */
export function handlePreviewWatchEvent(root: string, filename: string): void {
  for (const entry of servers.values()) {
    if (!entry.roots.has(resolve(root))) continue
    if (!entry.served.has(filename.split(sep).join('/'))) continue
    if (entry.staleTimer) clearTimeout(entry.staleTimer)
    entry.staleTimer = setTimeout(() => {
      entry.staleTimer = null
      staleSink?.(entry.url)
    }, PREVIEW_STALE_DEBOUNCE_MS)
  }
}

/** Test hook — deliver every armed reload immediately. */
export function flushPreviewStaleForTest(): void {
  for (const entry of servers.values()) {
    if (!entry.staleTimer) continue
    clearTimeout(entry.staleTimer)
    entry.staleTimer = null
    staleSink?.(entry.url)
  }
}

/** One comparable key for a served file: root-relative, forward slashes. */
function servedKey(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}

/**
 * Start (or reuse) Copse's bounded static-site server for one workspace. The
 * main process owns the listener: no agent command runs and no project-sandbox
 * authority is widened. Requests are loopback-only and symlinks cannot escape
 * the canonical workspace root.
 */
export async function getStaticPreviewServer(root: string): Promise<StaticPreviewServer> {
  const canonicalRoot = await realpath(root)
  const existing = servers.get(canonicalRoot)
  if (existing) {
    existing.roots.add(resolve(root))
    return { root: existing.root, url: existing.url }
  }
  const created = await createPreviewServer(canonicalRoot)
  created.roots.add(resolve(root))
  servers.set(canonicalRoot, created)
  return { root: created.root, url: created.url }
}

/** Loopback http(s) URL for a file already resolved inside `root`. Never `file://`. */
export async function workspacePreviewFileUrl(root: string, absolutePath: string): Promise<string> {
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(absolutePath)])
  if (!isInsideRoot(canonicalRoot, canonicalPath)) {
    throw new Error('Preview path must stay inside the workspace preview root.')
  }
  const preview = await getStaticPreviewServer(canonicalRoot)
  const previewPath = relative(canonicalRoot, canonicalPath)
    .split(sep)
    .map(encodeURIComponent)
    .join('/')
  return previewCapabilityUrl(staticPreviewUrl(preview.url, previewPath))
}

/**
 * Preview URL for an entry page, checked against what the server would serve.
 * A missing page (say, a build output not written yet) fails here instead of
 * opening a tab that only shows the server's 404.
 */
export async function staticPreviewEntryUrl(root: string, entryPath = '/'): Promise<string> {
  const preview = await getStaticPreviewServer(root)
  const url = staticPreviewUrl(preview.url, entryPath)
  if (!(await resolveRequestFile(preview.root, new URL(url).pathname))) {
    throw new Error(
      `Nothing to preview at "${entryPath}": no such file in the workspace. If it is a build output, finish the build before previewing.`,
    )
  }
  return previewCapabilityUrl(url)
}

export function staticPreviewUrl(baseUrl: string, entryPath = '/'): string {
  const trimmed = entryPath.trim()
  if (!trimmed || trimmed === '/') return baseUrl
  if (
    trimmed.includes('\0') ||
    trimmed.includes('\\') ||
    isAbsolute(trimmed) ||
    trimmed.split('/').includes('..')
  ) {
    throw new Error('Preview path must be a workspace-relative URL path.')
  }
  const url = new URL(trimmed.replace(/^\.\//, ''), baseUrl)
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error('Preview path must stay inside the workspace preview origin.')
  }
  return url.toString()
}

export async function shutdownStaticPreviewServers(): Promise<void> {
  const active = [...servers.values()]
  servers.clear()
  for (const entry of active) {
    entry.watcher?.close()
    if (entry.staleTimer) clearTimeout(entry.staleTimer)
  }
  await Promise.all(
    active.map(
      ({ server }) =>
        new Promise<void>((resolveClose) => {
          server.close(() => {
            resolveClose()
          })
          server.closeAllConnections()
        }),
    ),
  )
}
