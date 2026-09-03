export type JsonDecoder<T> = (value: unknown) => T | null

export function decodeWithSchema<T>(schema: {
  safeParse(value: unknown): { success: true; data: T } | { success: false }
}): JsonDecoder<T> {
  return (value) => {
    const result = schema.safeParse(value)
    return result.success ? result.data : null
  }
}

export function safeJsonParse<T>(text: string, decoder: JsonDecoder<T>): T | null {
  try {
    return decoder(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}
