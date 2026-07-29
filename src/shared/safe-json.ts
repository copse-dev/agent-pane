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
