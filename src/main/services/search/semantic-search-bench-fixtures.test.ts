import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The semantic-search bench gate fails loudly on missing gold targets, but that
 * job only runs with gortex. Catch fixture drift in the unit suite whenever a
 * PR deletes or renames a gold file.
 */
describe('semantic-search-bench fixtures', () => {
  it('gold expectedPaths all exist in the repo', () => {
    const fixturesPath = join(process.cwd(), 'scripts/semantic-search-bench.fixtures.json')
    const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as {
      queries: Array<{ id: string; expectedPaths: string[] }>
    }

    const stale = fixtures.queries.flatMap((q) =>
      q.expectedPaths
        .filter((p) => !existsSync(join(process.cwd(), p)))
        .map((p) => `${q.id} -> ${p}`),
    )

    assert.deepEqual(
      stale,
      [],
      `stale gold target(s) — update scripts/semantic-search-bench.fixtures.json:\n  ${stale.join('\n  ')}`,
    )
  })
})
