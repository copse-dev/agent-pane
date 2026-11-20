/**
 * Redact known secrets from a byte stream without buffering it: a response
 * body can be a whole CI log, so it is scanned as it passes, holding back only
 * enough bytes to catch a secret split across two chunks. A match is replaced
 * with `*` of the same length, so a `Content-Length` computed upstream stays
 * true, and reported once per stream.
 */
import { Transform, type TransformCallback } from 'node:stream'

/** Replace every occurrence of `secret` in `buffer`, in place; returns how many. */
function redactInPlace(buffer: Buffer, secret: Buffer): number {
  let count = 0
  let at = buffer.indexOf(secret)
  while (at !== -1) {
    buffer.fill(0x2a, at, at + secret.length)
    count += 1
    at = buffer.indexOf(secret, at + secret.length)
  }
  return count
}

export class SecretScrubber extends Transform {
  private readonly secrets: Buffer[]
  private readonly holdBack: number
  private carry: Buffer = Buffer.alloc(0)
  private readonly onLeak: () => void
  private leaked = false

  constructor(secrets: readonly string[], onLeak: () => void) {
    super()
    this.secrets = secrets
      .filter((secret) => secret.length > 0)
      .map((secret) => Buffer.from(secret))
    this.holdBack = Math.max(0, ...this.secrets.map((secret) => secret.length - 1))
    this.onLeak = onLeak
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.secrets.length === 0) {
      done(null, chunk)
      return
    }
    // A fresh buffer: the redaction writes into it, never into the caller's chunk.
    const data = Buffer.concat([this.carry, chunk])
    this.redact(data)
    const cut = Math.max(0, data.length - this.holdBack)
    this.carry = data.subarray(cut)
    done(null, cut > 0 ? data.subarray(0, cut) : undefined)
  }

  override _flush(done: TransformCallback): void {
    const rest = this.carry
    this.carry = Buffer.alloc(0)
    done(null, rest.length > 0 ? rest : undefined)
  }

  private redact(data: Buffer): void {
    let found = 0
    for (const secret of this.secrets) found += redactInPlace(data, secret)
    if (found > 0 && !this.leaked) {
      this.leaked = true
      this.onLeak()
    }
  }
}

/** The same redaction for a string (a header value); reports whether anything matched. */
export function scrubString(
  value: string,
  secrets: readonly string[],
): { value: string; leaked: boolean } {
  let out = value
  let leaked = false
  for (const secret of secrets) {
    if (secret.length === 0 || !out.includes(secret)) continue
    leaked = true
    out = out.split(secret).join('*'.repeat(secret.length))
  }
  return { value: out, leaked }
}
