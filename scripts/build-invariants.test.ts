import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Structural pins for `scripts/build.mts`. Unit tests never run the build, and
 * the askpass helper is exec'd as a standalone script rather than required by
 * another bundle, so a malformed emit has no other place to surface.
 */
describe('build.mts bundle invariants', () => {
  const build = readFileSync(resolve('scripts/build.mts'), 'utf8')

  const askpassEntry = build.match(
    /await esbuild\.build\(\{[^}]*?askpass-helper\.ts[\s\S]*?\n {2}\}\)/,
  )?.[0]

  it('never adds a hashbang banner to a helper that already has one', () => {
    // esbuild preserves a source hashbang verbatim, so a `#!…` banner on top of
    // it lands a second one on line 2 — a syntax error, not a hashbang. That
    // killed every SSH password/passphrase/host-key prompt: the helper crashed
    // on startup and OpenSSH just moved on to the next auth attempt.
    const helper = readFileSync(
      resolve('src/main/services/ssh-workspace/askpass-helper.ts'),
      'utf8',
    )
    assert.ok(helper.startsWith('#!'), 'askpass-helper.ts should carry its own hashbang')
    assert.ok(askpassEntry, 'expected an esbuild.build call for askpass-helper.ts')
    assert.doesNotMatch(
      askpassEntry,
      /banner/,
      'askpass-helper.ts already has a hashbang; a banner would duplicate it onto line 2',
    )
  })

  it('syntax-checks the askpass helper bundle after emitting it', () => {
    assert.match(
      build,
      /assertParses\('dist\/main\/ssh-askpass-helper\.js'\)/,
      "the askpass bundle is only ever exec'd, so the build must verify it parses",
    )
  })
})
