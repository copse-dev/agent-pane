/**
 * Cursor ACP sometimes streams a trailing transport failure into the assistant
 * bubble after useful turn output, e.g.:
 *
 *   Error: RetriableError: WritableIterable is closed
 *   Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)
 *
 * Those lines come from Cursor's write-iterable / HTTP2 teardown (`RetriableError`
 * kind), not from Copse's `classifyAgentError` path (`An error occurred: …`).
 * Split them off so the primary answer stays readable; callers may demote the
 * noise into a collapsed disclosure or drop it from next-turn history.
 *
 * Safety: only trailing lines match. A message that is *only* such an error is
 * left intact so a real failed turn is not erased.
 */

/** One trailing `Error: RetriableError: …` line, plus surrounding blank lines. */
const TRAILING_RETRIABLE_ERROR_RE = /(?:\r?\n)*Error:\s*RetriableError:\s*[^\r\n]+(?:\r?\n)*$/

export function splitCursorAcpTransportNoise(text: string): {
  body: string
  noise: string | null
} {
  let body = text
  const chunks: string[] = []
  for (;;) {
    const match = TRAILING_RETRIABLE_ERROR_RE.exec(body)
    if (!match) break
    const next = body.slice(0, match.index)
    if (!next.trim()) {
      // Would leave an empty primary answer — keep the error visible.
      return { body: text, noise: null }
    }
    chunks.unshift(match[0].trim())
    body = next
  }
  if (chunks.length === 0) return { body: text, noise: null }
  return { body: body.replace(/\s+$/u, ''), noise: chunks.join('\n') }
}

/** History / replay helper: drop demoted transport noise when a body remains. */
export function stripCursorAcpTransportNoise(text: string): string {
  return splitCursorAcpTransportNoise(text).body
}
