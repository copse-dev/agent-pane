/**
 * JSON.parse that returns null instead of throwing on invalid input.
 *
 * The `T` type parameter is a caller-supplied cast for the parsed value and is
 * relied on by ~15 call sites (e.g. `safeJsonParse<GhPrView>(raw)`); removing it
 * would change this exported signature and break those callers, so the
 * single-use type parameter is intentional here.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
