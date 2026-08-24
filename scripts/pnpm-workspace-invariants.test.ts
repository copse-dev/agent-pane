import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Structural pins for pnpm-workspace.yaml. The file is hand-edited and has
 * no schema check in CI, so drift between its blocks only shows up days
 * later as a failed Dependabot job.
 */
describe('pnpm-workspace.yaml invariants', () => {
  const workspace = readFileSync(resolve('pnpm-workspace.yaml'), 'utf8')

  /** Top-level block body: the indented lines following `<key>:`. */
  function block(key: string): string {
    const match = workspace.match(new RegExp(`^${key}:\\n((?: {2}.*\\n|\\n)*)`, 'm'))
    const body = match?.[1]
    assert.ok(body !== undefined, `expected a top-level \`${key}:\` block in pnpm-workspace.yaml`)
    return body
  }

  /** Package names from an overrides map, with any `@range` selector stripped. */
  function overridePackages(): string[] {
    const names: string[] = []
    for (const line of block('overrides').split('\n')) {
      const key = line.match(/^ {2}'?((?:@[^/'@]+\/)?[^'@:\s]+)(?:@[^':]+)?'?:\s*(.*)$/)
      const [, name, spec] = key ?? []
      if (!name || spec === undefined) continue
      // Local `file:` overrides are never resolved from the registry.
      if (spec.startsWith('file:')) continue
      names.push(name)
    }
    assert.ok(names.length > 0, 'expected at least one registry override')
    return names
  }

  function releaseAgeExcludes(): string[] {
    return block('minimumReleaseAgeExclude')
      .split('\n')
      .map((line) => line.match(/^ {2}- '?([^']+?)'?$/)?.[1])
      .filter((name): name is string => Boolean(name))
  }

  it('exempts every registry override from the Dependabot cooldown age check', () => {
    // Dependabot's `cooldown.default-days` runs pnpm with
    // --config.minimumReleaseAge, which refuses to resolve any version newer
    // than the cooldown — including a freshly pinned security override — and
    // aborts every version-update job with ERR_PNPM_NO_MATURE_MATCHING_VERSION.
    const excluded = new Set(releaseAgeExcludes())
    const missing = [...new Set(overridePackages())].filter((name) => !excluded.has(name))
    assert.deepEqual(
      missing,
      [],
      `overrides not listed under minimumReleaseAgeExclude: ${missing.join(', ')}`,
    )
  })

  it('does not carry stale entries in minimumReleaseAgeExclude', () => {
    const overridden = new Set(overridePackages())
    const stale = releaseAgeExcludes().filter((name) => !overridden.has(name))
    assert.deepEqual(
      stale,
      [],
      `minimumReleaseAgeExclude entries with no override: ${stale.join(', ')}`,
    )
  })
})
