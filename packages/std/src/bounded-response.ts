/**
 * Read a response body as UTF-8 text, or return `null` once it exceeds
 * `maxBytes`: a declared `Content-Length` over the limit is refused before
 * reading, and a streamed body is cancelled at the first byte past it. An
 * `abort` on `signal` cancels the body and rejects with the signal's reason,
 * so a stalled stream cannot outlive its caller's deadline.
 */
export async function readResponseTextWithin(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    return null
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  // A cancelled read ends like a finished one; never hand back a truncated body.
  signal?.throwIfAborted()
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
