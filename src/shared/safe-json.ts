/** JSON.parse that returns null instead of throwing on invalid input. */
export function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
