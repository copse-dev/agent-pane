import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { it } from 'node:test'
import { createFixtureDirectory } from '../tests/e2e/helpers/fixture-directory.ts'

it('keeps parallel workspace names stable and cleans up only its own fixture', () => {
  const first = createFixtureDirectory('parallel-workspace')
  const second = createFixtureDirectory('parallel-workspace')
  try {
    assert.equal(basename(first.root), 'parallel-workspace')
    assert.equal(basename(second.root), 'parallel-workspace')
    assert.notEqual(first.root, second.root)
    const retained = join(second.root, 'retained.txt')
    writeFileSync(retained, 'the other fixture remains')
    first.cleanup()
    assert.equal(existsSync(dirname(first.root)), false)
    assert.equal(existsSync(retained), true)
    first.cleanup()
  } finally {
    first.cleanup()
    second.cleanup()
  }
  assert.equal(existsSync(dirname(second.root)), false)
})
