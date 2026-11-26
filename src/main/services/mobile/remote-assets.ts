import { readFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import { pageAsset, pinPageAssets, type PageAsset } from './http-response.ts'

const manifestSchema = z
  .array(z.string().regex(/^(?!.*(?:^|\/)\.\.?\/)[\w./-]+\.(?:html|js|css|svg|png|ttf|woff2?)$/))
  .max(5000)
const types: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
export const REMOTE_INTERFACE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"

/**
 * Only build-manifest assets, loaded before listening; request paths never touch disk.
 * The document pins its script and stylesheet by hash (see `pinPageAssets`).
 */
export async function loadRemoteAssets(root: string): Promise<Map<string, PageAsset>> {
  const file = join(root, 'assets.json')
  let manifest: string
  try {
    manifest = await readFile(file, 'utf8')
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return new Map()
    throw error
  }
  const paths = safeJsonParse(manifest, decodeWithSchema(manifestSchema))
  if (!paths) throw new Error('Invalid remote interface asset manifest')
  const headersFor = (path: string): Record<string, string> => ({
    'Content-Type': types[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': path === 'mermaid-frame.html' ? 'SAMEORIGIN' : 'DENY',
    'Content-Security-Policy':
      path === 'mermaid-frame.html' ? "frame-ancestors 'self'" : REMOTE_INTERFACE_CSP,
  })
  const result = new Map<string, PageAsset>()
  for (const path of paths) {
    if (path === 'index.html') continue
    result.set('/remote/' + path, pageAsset(await readFile(join(root, path)), headersFor(path)))
  }
  if (paths.includes('index.html')) {
    const html = pinPageAssets(await readFile(join(root, 'index.html'), 'utf8'), '/remote/', result)
    const page = pageAsset(Buffer.from(html, 'utf8'), headersFor('index.html'))
    result.set('/remote/index.html', page)
    result.set('/remote/', page)
  }
  return result
}
