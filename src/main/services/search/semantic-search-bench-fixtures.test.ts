import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * The semantic-search bench gate fails loudly on missing gold targets, but that
 * job only runs with gortex. Catch fixture drift in the unit suite whenever a
 * PR deletes or renames a gold file.
 */
describe('semantic-search-bench fixtures', () => {
  it('gold expectedPaths all exist in the repo', () => {
    const fixturesPath = join(process.cwd(), 'scripts/semantic-search-bench.fixtures.json')
    const parsed: unknown = JSON.parse(readFileSync(fixturesPath, 'utf8'))
    if (!isRecord(parsed)) assert.fail('fixtures root must be an object')
    const queries = parsed['queries']
    if (!Array.isArray(queries)) assert.fail('fixtures.queries must be an array')

    const stale = queries.flatMap((raw, index) => {
      if (!isRecord(raw)) {
        assert.fail(`fixtures.queries[${String(index)}] must be an object`)
      }
      const id = raw['id']
      const expectedPaths = raw['expectedPaths']
      if (typeof id !== 'string') {
        assert.fail(`fixtures.queries[${String(index)}].id must be a string`)
      }
      if (!isStringArray(expectedPaths)) {
        assert.fail(`fixtures.queries[${String(index)}].expectedPaths must be string[]`)
      }
      return expectedPaths
        .filter((p) => !existsSync(join(process.cwd(), p)))
        .map((p) => `${id} -> ${p}`)
    })

    assert.deepEqual(
      stale,
      [],
      `stale gold target(s) — update scripts/semantic-search-bench.fixtures.json:\n  ${stale.join('\n  ')}`,
    )
  })
})
