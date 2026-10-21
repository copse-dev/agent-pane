import { readFileSync } from 'node:fs'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

/** Decode loose fixture metadata without asserting that untrusted JSON has an object shape. */
export function parseFixtureJsonObject(
  text: string,
  context = 'fixture JSON',
): Record<string, unknown> {
  const value = safeJsonParse(text)
  if (!isRecord(value)) throw new Error(`${context} must contain a JSON object`)
  return value
}

export function readFixtureJsonObject(path: string): Record<string, unknown> {
  return parseFixtureJsonObject(readFileSync(path, 'utf8'), path)
}
