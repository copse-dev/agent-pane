/**
 * JSON.parse that returns null instead of throwing on invalid input.
 *
 * The `T` type parameter is a caller-supplied cast for the parsed value and is
 * relied on by call sites; migration to boundary validation is tracked by the
 * suppression-removal work.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
