import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const LOOPBACK_HOST = '127.0.0.1'

/**
 * blockviz's vendored build (vendor/blockviz/README.md) is first-party content
 * we compile and ship ourselves, not agent-writable workspace content — so
 * this deliberately does NOT share static-preview-server.ts's CSP, which must
 * stay strict for a page an agent can plant. `'wasm-unsafe-eval'` is required
 * for `WebAssembly.instantiate()` under any `script-src` that isn't wide open;
 * `'unsafe-inline'` covers blockviz's own small inline theme-boot snippet in
 * its `index.html`.
 */
const CODE_MAP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
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
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}

interface CodeMapServerEntry {
  root: string
  server: Server
  url: string
}

let entry: CodeMapServerEntry | null = null

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

async function createCodeMapServer(root: string): Promise<CodeMapServerEntry> {
  const canonicalRoot = await realpath(root)
  const rootStat = await stat(canonicalRoot)
  if (!rootStat.isDirectory()) throw new Error('The code map asset root is not a directory.')

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
          'Content-Security-Policy': CODE_MAP_CSP,
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
        reject(new Error('The code map asset server did not receive a loopback port.'))
        return
      }
      resolvePort(address.port)
    })
  })
  server.unref()
  return { root: canonicalRoot, server, url: `http://localhost:${String(port)}/` }
}

/**
 * Loopback server for the vendored blockviz build (one for the app's
 * lifetime — unlike static-preview-server.ts, this root is a versioned build
 * output, not something an agent edits live, so no reload watcher).
 */
export async function getCodeMapAssetServer(root: string): Promise<{ url: string }> {
  const canonicalRoot = await realpath(root)
  if (entry && entry.root === canonicalRoot) return { url: entry.url }
  entry = await createCodeMapServer(canonicalRoot)
  return { url: entry.url }
}

/** Test hook — drop the singleton so the next call starts a fresh server. */
export function resetCodeMapAssetServerForTest(): void {
  entry?.server.close()
  entry = null
}
