/** Runtime helpers for turning untyped boundary values into honest TypeScript values. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function expectRecord(value: unknown, label = 'value'): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return value
}

export function expectArray(value: unknown, label = 'value'): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

export function recordArrayOrEmpty(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function expectString(value: unknown, label = 'value'): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

export function expectNumber(value: unknown, label = 'value'): number {
  if (typeof value !== 'number') throw new TypeError(`${label} must be a number`)
  return value
}

export function expectBoolean(value: unknown, label = 'value'): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

export function expectStringArray(value: unknown, label = 'value'): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new TypeError(`${label} must be an array of strings`)
  }
  return value
}

export function stringRecordOrEmpty(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

export function expectStringRecord(value: unknown, label = 'value'): Record<string, string> {
  const result = stringRecordOrEmpty(value)
  if (!isRecord(value) || Object.keys(result).length !== Object.keys(value).length) {
    throw new TypeError(`${label} must be an object with string values`)
  }
  return result
}

export function optionalString(value: unknown, label = 'value'): string | undefined {
  if (value === undefined || value === null) return undefined
  return expectString(value, label)
}

export function optionalBoolean(value: unknown, label = 'value'): boolean | undefined {
  if (value === undefined || value === null) return undefined
  return expectBoolean(value, label)
}

export function optionalNumber(value: unknown, label = 'value'): number | undefined {
  if (value === undefined || value === null) return undefined
  return expectNumber(value, label)
}

export function optionalStringArray(value: unknown, label = 'value'): string[] | undefined {
  if (value === undefined || value === null) return undefined
  return expectStringArray(value, label)
}

export function optionalRecord(
  value: unknown,
  label = 'value',
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  return expectRecord(value, label)
}

export function nullableRecord(value: unknown, label = 'value'): Record<string, unknown> | null {
  if (value === null) return null
  return expectRecord(value, label)
}

export function parseJsonUnknown(text: string): unknown {
  return JSON.parse(text) as unknown
}

/** Narrow an untyped stored value to the runtime shape represented by a fallback value. */
export function matchesFallbackType<T>(value: unknown, fallback: T): value is T {
  if (fallback === null) return value === null
  if (Array.isArray(fallback)) return Array.isArray(value)
  if (isRecord(fallback)) return isRecord(value)
  return typeof value === typeof fallback
}

/** Returns the first string that is present and non-empty, preserving `||` fallback semantics. */
export function firstNonEmptyString(
  ...values: readonly (string | null | undefined)[]
): string | undefined {
  return values.find(
    (value): value is string => value !== undefined && value !== null && value !== '',
  )
}

export function nonEmptyStringOr(value: string | null | undefined, fallback: string): string {
  return firstNonEmptyString(value, fallback) ?? fallback
}
