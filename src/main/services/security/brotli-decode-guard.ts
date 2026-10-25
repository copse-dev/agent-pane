import { syncBuiltinESMExports } from 'node:module'
import { Transform, type TransformCallback } from 'node:stream'
import zlib from 'node:zlib'
import { satisfies } from 'semver'

/**
 * CVE-2026-111497 ("Node2Shell", later "HTTP2Shell"): crafted Brotli input
 * makes the decoder bundled with Node write out of bounds, which can run code
 * in the decoding process. Node fixed it on 2026-10-21 in 22.23.4, 24.22.1 and
 * 26.12.1; 23, 25 and older lines are end-of-life and got no fix. Fixed
 * releases still report `process.versions.brotli` as 1.2.0, so the Node
 * version is the only signal.
 */
const BROTLI_FIXED_NODE_RANGE = '>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1'

/** What `fetch` asks HTTPS servers for by default (`br, gzip, deflate`), minus `br`. */
const ACCEPT_ENCODING_WITHOUT_BROTLI = 'gzip, deflate'

export function nodeHasBrotliDecoderFix(nodeVersion: string): boolean {
  return satisfies(nodeVersion, BROTLI_FIXED_NODE_RANGE)
}

function brotliDecodingDisabled(): Error {
  return new Error('Brotli decoding is disabled in this process (CVE-2026-111497)')
}

/**
 * Stands in for zlib's Brotli decoder: it fails on the first chunk, or at the
 * end of an empty body, without decoding anything. It fails on a later turn of
 * the event loop, as the real decoder's errors do, because undici's `fetch`
 * attaches its error handling only after it builds the decoder chain. A
 * decoder that fails synchronously leaves the response body pending forever,
 * and a factory that throws crashes Electron 44's main process with an
 * unhandled stream `'error'`.
 */
class DisabledBrotliDecompress extends Transform {
  override _transform(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    setImmediate(callback, brotliDecodingDisabled())
  }

  override _flush(callback: TransformCallback): void {
    setImmediate(callback, brotliDecodingDisabled())
  }
}

/** zlib's callback form takes the callback last, after an optional options object. */
function brotliDecompressDisabled(...args: unknown[]): void {
  const callback = args.at(-1)
  if (typeof callback !== 'function') throw brotliDecodingDisabled()
  process.nextTick(callback, brotliDecodingDisabled())
}

function brotliDecompressSyncDisabled(): never {
  throw brotliDecodingDisabled()
}

/**
 * Leaves the request alone when the caller chose its encodings, or sent
 * `Range`, which makes `fetch` ask for `identity` itself.
 */
function withoutBrotliAccepted(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): RequestInit | undefined {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  if (headers.has('accept-encoding') || headers.has('range')) return init
  headers.set('accept-encoding', ACCEPT_ENCODING_WITHOUT_BROTLI)
  return { ...init, headers }
}

/**
 * Stops this process decoding Brotli at all. Every decoder that goes through
 * `node:zlib` (`fetch`, `DecompressionStream`, HTTP libraries) gets one that
 * fails without touching the input, and `fetch` stops asking servers for `br`
 * so the servers that honour `Accept-Encoding` keep working. A server that
 * sends `br` unasked fails its request instead of reaching the decoder.
 *
 * Run it before anything else loads: a module that destructured zlib, or
 * captured `fetch`, before this ran keeps the originals.
 */
export function disableBrotliDecoding(): void {
  const replacements = {
    BrotliDecompress: DisabledBrotliDecompress,
    createBrotliDecompress: (): Transform => new DisabledBrotliDecompress(),
    brotliDecompress: brotliDecompressDisabled,
    brotliDecompressSync: brotliDecompressSyncDisabled,
  }
  for (const [name, value] of Object.entries(replacements)) {
    // Node defines the `create*` factories read-only, but every export is
    // configurable, so redefining keeps each one's other attributes.
    Object.defineProperty(zlib, name, { value })
  }
  // ESM importers of `node:zlib` only see changed CJS exports once synced.
  syncBuiltinESMExports()

  const fetchWithBrotli = globalThis.fetch
  globalThis.fetch = (input, init): Promise<Response> =>
    fetchWithBrotli(input, withoutBrotliAccepted(input, init))
}
