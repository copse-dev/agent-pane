import { z } from 'zod'

// Schema + version validation for values persisted in the shared electron-store.
//
// electron-store hands back whatever JSON happens to be on disk: a value written
// by an older app version, hand-edited, or corrupted. Reading it back with
// `as Foo` (the old pattern) silently trusts garbage. These helpers validate the
// shape on read and fall back to a safe default when it does not match, so a
// corrupt record degrades gracefully instead of propagating a wrong-typed value.

/** A list of strings (used for grants and disabled-server names). */
export const stringListSchema: z.ZodType<string[]> = z.array(z.string())

/**
 * Parse a stored value against a schema, returning `fallback` when it does not
 * validate. Never throws — a malformed persisted value must not crash a read.
 */
export function parseStored<T>(schema: z.ZodType<T>, raw: unknown, fallback: T): T {
  const result = schema.safeParse(raw)
  return result.success ? result.data : fallback
}

/** Read a stored string list, dropping non-string / empty entries and dupes. */
export function parseStringList(raw: unknown): string[] {
  const list = parseStored(stringListSchema, raw, [])
  return [...new Set(list.filter((s) => typeof s === 'string' && s.length > 0))]
}
