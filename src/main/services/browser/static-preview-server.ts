import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const LOOPBACK_HOST = '127.0.0.1'

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
}

export interface StaticPreviewServer {
  root: string
  url: string
}

const servers = new Map<string, PreviewServerEntry>()

function isInsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
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
  if (!isInsideRoot(root, candidate)) return null

  try {
    const candidateStat = await stat(candidate)
    const file = candidateStat.isDirectory() ? join(candidate, 'index.html') : candidate
    const canonical = await realpath(file)
    if (!isInsideRoot(root, canonical)) return null
    return (await stat(canonical)).isFile() ? canonical : null
  } catch {
    return null
  }
}

async function createPreviewServer(root: string): Promise<PreviewServerEntry> {
  const canonicalRoot = await realpath(root)
  const rootStat = await stat(canonicalRoot)
  if (!rootStat.isDirectory()) throw new Error('The preview root is not a directory.')

  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    void resolveRequestFile(canonicalRoot, request.url ?? '/').then(
      (file) => {
        if (!file) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
          return
        }
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': PREVIEW_CONTENT_SECURITY_POLICY,
          'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
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
  server.unref()
  return { root: canonicalRoot, server, url: `http://localhost:${String(port)}/` }
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
  if (existing) return { root: existing.root, url: existing.url }
  const created = await createPreviewServer(canonicalRoot)
  servers.set(canonicalRoot, created)
  return { root: created.root, url: created.url }
}

/** Loopback http(s) URL for a file already resolved inside `root`. Never `file://`. */
export async function workspacePreviewFileUrl(root: string, absolutePath: string): Promise<string> {
  const preview = await getStaticPreviewServer(root)
  if (!isInsideRoot(preview.root, absolutePath)) {
    throw new Error('Preview path must stay inside the workspace preview root.')
  }
  const previewPath = relative(preview.root, absolutePath).split(sep).map(encodeURIComponent).join('/')
  return staticPreviewUrl(preview.url, previewPath)
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
