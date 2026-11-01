import { existsSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

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

/** Only build-manifest assets, loaded before listening; request paths never touch disk. */
export function loadRemoteAssets(
  root: string,
): Map<string, { body: Buffer; headers: Record<string, string> }> {
  const file = join(root, 'assets.json')
  if (!existsSync(file)) return new Map()
  const paths = safeJsonParse(readFileSync(file, 'utf8'), decodeWithSchema(manifestSchema))
  if (!paths) throw new Error('Invalid remote interface asset manifest')
  const result = new Map<string, { body: Buffer; headers: Record<string, string> }>()
  for (const path of paths) {
    const headers = {
      'Content-Type': types[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        path === 'mermaid-frame.html' ? "frame-ancestors 'self'" : REMOTE_INTERFACE_CSP,
    }
    if (path === 'mermaid-frame.html') headers['X-Frame-Options'] = 'SAMEORIGIN'
    const asset = { body: readFileSync(join(root, path)), headers }
    result.set('/remote/' + path, asset)
    if (path === 'index.html') result.set('/remote/', asset)
  }
  return result
}
