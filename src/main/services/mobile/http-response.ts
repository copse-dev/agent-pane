import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'

const brotli = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/** What the LAN server writes for one request, decided before any byte is sent. */
export interface ResponseSpec {
  status: number
  headers: Record<string, string>
  body: Buffer | null
}

/** The conditional and negotiation headers of one request. */
export interface RequestPreferences {
  acceptEncoding?: string | undefined
  ifNoneMatch?: string | undefined
}

export type ContentCoding = 'br' | 'gzip'

/**
 * A year, never revalidated. Only for a URL that names its own content by hash,
 * referenced with Subresource Integrity from a document that is itself never
 * cached (see {@link pinPageAssets}).
 */
export const IMMUTABLE_CACHE_CONTROL = 'private, max-age=31536000, immutable'

/** Bodies under this are sent as they are: the coding's framing outweighs the saving. */
const MIN_COMPRESSED_BYTES = 1024

/** The best coding this server offers that the request accepts (RFC 9110 §12.5.3). */
export function acceptedCoding(header: string | undefined): ContentCoding | null {
  if (!header) return null
  const weights = new Map<string, number>()
  for (const part of header.split(',')) {
    const [name = '', ...parameters] = part.split(';')
    const coding = name.trim().toLowerCase()
    if (!coding) continue
    let weight = 1
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/i.exec(parameter)
      if (match) weight = Number(match[1])
    }
    weights.set(coding, weight)
  }
  const weight = (coding: string): number => weights.get(coding) ?? weights.get('*') ?? 0
  if (weight('br') > 0) return 'br'
  if (weight('gzip') > 0) return 'gzip'
  return null
}

/**
 * Brotli 5 costs about what gzip 6 does and is about a tenth smaller on these
 * bundles; 4 keeps a polled JSON body cheap. Both run on the thread pool, off
 * the main process's event loop.
 */
function encode(body: Buffer, coding: ContentCoding, quality: 4 | 5): Promise<Buffer> {
  return coding === 'br'
    ? brotli(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: quality,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gzipAsync(body, { level: 6 })
}

function sha256(content: string | Buffer): Buffer {
  return createHash('sha256').update(content).digest()
}

/**
 * A weak validator: the codings of one body are byte-different and
 * semantically the same, which is exactly what `W/` says.
 */
export function entityTag(content: string | Buffer): string {
  return `W/"${sha256(content).toString('base64url')}"`
}

/** `If-None-Match` by weak comparison (RFC 9110 §8.8.3.2 and §13.1.2). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false
  const opaque = (value: string): string => value.trim().replace(/^W\//, '')
  return header
    .split(',')
    .some((candidate) => candidate.trim() === '*' || opaque(candidate) === opaque(etag))
}

function withBody(
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  coding: ContentCoding | null,
): ResponseSpec {
  return {
    status,
    headers: {
      ...headers,
      ...(coding ? { 'Content-Encoding': coding } : {}),
      'Content-Length': String(body.length),
    },
    body,
  }
}

/** One fixed asset, held in memory, with each coding of it made at most once. */
export interface PageAsset {
  readonly body: Buffer
  readonly headers: Readonly<Record<string, string>>
  readonly etag: string
  /** The `?v=` value that names exactly these bytes. */
  readonly version: string
  /** The Subresource Integrity value for exactly these bytes. */
  readonly integrity: string
  encoded(coding: ContentCoding): Promise<Buffer>
}

/** Already-compressed formats gain nothing from a second pass. */
const INCOMPRESSIBLE = /^(?:image\/png|font\/woff2?)\b/

export function pageAsset(body: Buffer, headers: Readonly<Record<string, string>>): PageAsset {
  const digest = sha256(body)
  const codings = new Map<ContentCoding, Promise<Buffer>>()
  const compressible =
    body.length >= MIN_COMPRESSED_BYTES && !INCOMPRESSIBLE.test(headers['Content-Type'] ?? '')
  return {
    body,
    headers,
    etag: `W/"${digest.toString('base64url')}"`,
    version: digest.toString('base64url'),
    integrity: `sha256-${digest.toString('base64')}`,
    encoded(coding): Promise<Buffer> {
      if (!compressible) return Promise.resolve(body)
      let pending = codings.get(coding)
      if (!pending) {
        // Made on first use rather than at startup: most launches never see a
        // phone, and no launch should spend its first second compressing.
        pending = encode(body, coding, 5)
        codings.set(coding, pending)
        // A failed coding is not kept; that request falls back to the plain bytes.
        void pending.catch(() => codings.delete(coding))
      }
      return pending
    },
  }
}

/**
 * Answer a request for a fixed asset. `version` is the request's `?v=` value:
 * when it names the bytes being served, the response may be kept for good.
 */
export async function assetResponse(
  asset: PageAsset,
  request: RequestPreferences & { version?: string | null },
): Promise<ResponseSpec> {
  const headers: Record<string, string> = {
    ...asset.headers,
    ETag: asset.etag,
    Vary: 'Accept-Encoding',
    ...(request.version === asset.version ? { 'Cache-Control': IMMUTABLE_CACHE_CONTROL } : {}),
  }
  if (etagMatches(request.ifNoneMatch, asset.etag)) return { status: 304, headers, body: null }
  const coding = acceptedCoding(request.acceptEncoding)
  if (coding) {
    const encoded = await asset.encoded(coding).catch(() => null)
    if (encoded && encoded !== asset.body) return withBody(200, headers, encoded, coding)
  }
  return withBody(200, headers, asset.body, null)
}

const SCRIPT_OR_STYLE = /^(?:text\/(?:javascript|css))\b/

/**
 * Let a page's own scripts and stylesheets be cached without trusting the cache.
 *
 * Each `href`/`src` in `html` that names one of `assets` gains `?v=<hash>` and
 * an `integrity` attribute. The asset is then served as immutable under that
 * URL, so a phone downloads each bundle once per Copse build instead of on
 * every visit. The document doing the pinning must itself stay uncached: it is
 * what tells the browser, on every load, which bytes it may run. A cached copy
 * that is not those bytes — however it got there — fails the integrity check
 * and is not executed.
 *
 * `route` is the document's own path, for resolving relative references.
 */
export function pinPageAssets(
  html: string,
  route: string,
  assets: ReadonlyMap<string, PageAsset>,
): string {
  return html.replace(
    /(\s)(href|src)="([^"?#]+)"/g,
    (original, space: string, attribute: string, reference: string) => {
      const base = `https://copse.invalid${route}`
      if (!URL.canParse(reference, base)) return original
      const target = new URL(reference, base)
      if (target.origin !== 'https://copse.invalid') return original
      const asset = assets.get(target.pathname)
      if (!asset || !SCRIPT_OR_STYLE.test(asset.headers['Content-Type'] ?? '')) return original
      return `${space}${attribute}="${reference}?v=${asset.version}" integrity="${asset.integrity}"`
    },
  )
}

/**
 * Answer with JSON. With `etag`, an unchanged answer is a bodiless 304: pass
 * `true` to derive the validator from the body, or a tag computed from the
 * stable part when the body also carries something that always changes.
 */
export async function jsonResponse(
  headers: Readonly<Record<string, string>>,
  status: number,
  value: unknown,
  request: RequestPreferences = {},
  etag?: string | true,
): Promise<ResponseSpec> {
  return textResponse(headers, status, JSON.stringify(value), request, etag)
}

/** {@link jsonResponse} for a body that is already serialized. */
export async function textResponse(
  headers: Readonly<Record<string, string>>,
  status: number,
  text: string,
  request: RequestPreferences = {},
  etag?: string | true,
): Promise<ResponseSpec> {
  const body = Buffer.from(text, 'utf8')
  const tag = etag === true ? entityTag(body) : etag
  const base: Record<string, string> = {
    ...headers,
    Vary: 'Accept-Encoding',
    ...(tag ? { ETag: tag } : {}),
  }
  if (tag && etagMatches(request.ifNoneMatch, tag))
    return { status: 304, headers: base, body: null }
  const coding = body.length >= MIN_COMPRESSED_BYTES ? acceptedCoding(request.acceptEncoding) : null
  if (coding) {
    const encoded = await encode(body, coding, 4).catch(() => null)
    if (encoded) return withBody(status, base, encoded, coding)
  }
  return withBody(status, base, body, null)
}
