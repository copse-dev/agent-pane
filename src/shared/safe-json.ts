/**
 * JSON.parse that returns null instead of throwing on invalid input.
 *
 * Callers that need a typed result must provide a decoder. Without one the
 * parsed value stays `unknown`, keeping the trust boundary explicit.
 */
export type JsonDecoder<T> = (value: unknown) => T | null

export function decodeWithSchema<T>(schema: {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}): JsonDecoder<T> {
  return (value) => {
    const result = schema.safeParse(value)
    return result.success ? result.data : null
  }
}

/**
 * `JSON.stringify` with its *real* return type. The lib declares it as returning
 * `string`, but it returns undefined for any value with no JSON representation
 * (`undefined`, a function, a symbol) — a lie that makes every caller's
 * undefined-handling look like dead code to the type checker. The guard here
 * makes the honest type provable instead of asserted.
 *
 * Still throws on a cycle or a BigInt, like `JSON.stringify` itself: those are
 * bugs at the call site, not values to paper over.
 */
export function safeJsonStringify(value: unknown, indent?: number): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }
  return JSON.stringify(value, null, indent)
}

export function safeJsonParse(text: string): unknown
export function safeJsonParse<T>(text: string, decoder: JsonDecoder<T>): T | null
export function safeJsonParse<T>(text: string, decoder?: JsonDecoder<T>): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return decoder ? decoder(value) : value
  } catch {
    return null
  }
}
