/**
 * The validators of the reads a paired browser polls.
 *
 * Every few seconds the page asks the Mac for the same few things, and most of
 * the time nothing has changed. Sending back the validator of the answer it
 * already holds lets the Mac say so in a bodiless 304, and lets the page skip
 * the work of applying an answer it has already applied.
 *
 * An unchanged read returns the SAME object as the read before it, so a caller
 * can tell "nothing changed" by identity. Treat a held answer as immutable.
 *
 * Answers are held in memory only, never in browser storage: the Mac marks
 * them `no-store`, and they contain transcripts.
 */
export class ConditionalReads {
  private readonly entries = new Map<string, { etag: string; value: unknown }>()
  private readonly limit: number

  constructor(limit = 4) {
    this.limit = limit
  }

  /** The validator to send with a read of `path`, when its last answer is still held. */
  validator(path: string): string | undefined {
    return this.entries.get(path)?.etag
  }

  /** The answer a 304 for `path` refers to; absent if it was dropped in the meantime. */
  held(path: string): { value: unknown } | undefined {
    const entry = this.entries.get(path)
    return entry ? { value: entry.value } : undefined
  }

  /** Keep the answer to `path`. An answer without a validator can never be confirmed, so it is not kept. */
  remember(path: string, etag: string | null, value: unknown): void {
    this.entries.delete(path)
    if (!etag) return
    this.entries.set(path, { etag, value })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** Forget everything, as when the pairing ends. */
  clear(): void {
    this.entries.clear()
  }
}

/**
 * GET `path` through `send`, which performs the request with the headers it is
 * given. Returns the response to read, or the held answer when the Mac
 * confirmed it is still current.
 */
export async function conditionalGet(
  reads: ConditionalReads,
  path: string,
  send: (headers: Record<string, string>) => Promise<Response>,
): Promise<{ response: Response } | { unchanged: unknown }> {
  const validator = reads.validator(path)
  const response = await send(validator ? { 'If-None-Match': validator } : {})
  if (response.status !== 304) return { response }
  const held = reads.held(path)
  if (held) return { unchanged: held.value }
  // The answer was dropped while this request was in flight: ask for it in full.
  return { response: await send({}) }
}
