import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { it } from 'node:test'

it('loads the unbundled identity CLI before validating its command', () => {
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/screenshot-identity.mts'), 'invalid'],
    {
      encoding: 'utf8',
      timeout: 15_000,
    },
  )
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage: screenshot-identity\.mts <prepare\|record>/)
  assert.doesNotMatch(result.stderr, /SyntaxError|does not provide an export/)
})
